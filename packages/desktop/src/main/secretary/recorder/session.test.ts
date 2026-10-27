import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readManifest } from "./manifest"
import type { CaptureSource, StopSummary, TrackName } from "./protocol"
import { beginRecording, captureRecording, finishRecording, type RecordingHelper } from "./session"
import { DEFAULT_SETTINGS } from "./settings"

const temporary: string[] = []

afterEach(async () => {
  setSystemTime()
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function scratch() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "secretary-session-"))
  temporary.push(directory)

  return directory
}

const source: CaptureSource = { kind: "app", bundleId: "us.zoom.xos", name: "zoom.us" }

/** Moves the fake clock forward, as the real helper's work takes wall-clock time. */
function advance(ms: number) {
  setSystemTime(new Date(Date.now() + ms))
}

/**
 * A stand-in for `secretary-recorder`: its first `start` spends `attachMs` attaching to
 * ScreenCaptureKit before any sample is written, like the real helper on a cold launch. Each track
 * starts `offsets[name]` seconds after capture began and runs until `stop`.
 */
function fakeHelper(options: { attachMs: number; offsets: Partial<Record<TrackName, number>> }) {
  const state: { startedAt?: number; directory?: string } = {}

  const helper: RecordingHelper = {
    async request(command, fields) {
      if (command !== "start") throw new Error(`unexpected ${command}`)
      advance(options.attachMs)
      state.startedAt = Date.now()
      state.directory = ((fields?.settings ?? {}) as { outputDirectory: string }).outputDirectory

      return { startedAt: new Date(state.startedAt).toISOString(), tracks: Object.keys(options.offsets) }
    },
  }

  return {
    helper,
    /** Stops after `recordMs` of capture and returns the helper's summary and each track's real length. */
    async stop(recordMs: number) {
      advance(recordMs)
      const endedAt = Date.now()
      const startedAt = state.startedAt!
      const names = Object.keys(options.offsets) as TrackName[]
      await Promise.all(names.map((name) => writeFile(path.join(state.directory!, name), `samples of ${name}`)))
      const summary: StopSummary = {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        duration: (endedAt - startedAt) / 1000,
        tracks: names.map((name) => ({ name, bytes: 10, status: "complete", startOffset: options.offsets[name] ?? 0 })),
      }
      const lengths = Object.fromEntries(
        names.map((name) => [name, (endedAt - startedAt) / 1000 - (options.offsets[name] ?? 0)]),
      )

      return { summary, lengths }
    },
  }
}

describe("recording session timestamps", () => {
  test("a slow helper start does not stretch the manifest beyond the tracks it wrote", async () => {
    setSystemTime(new Date("2026-10-27T09:00:00.000Z"))
    const root = await scratch()
    const clickedAt = Date.now()
    const fake = fakeHelper({ attachMs: 3_500, offsets: { "video.mp4": 0.05, "system.m4a": 0.02, "mic.m4a": 0.03 } })

    const draft = await beginRecording({
      root,
      title: "Weekly sync",
      source,
      calendarEventId: null,
      settings: DEFAULT_SETTINGS,
    })
    // The provisional manifest exists before capture, so a crash during start is recoverable.
    expect((await readManifest(draft.directory)).started_at).toBe(new Date(clickedAt).toISOString())

    const capturing = await captureRecording({ ...draft, helper: fake.helper, source, settings: DEFAULT_SETTINGS })
    expect(Date.parse(capturing.started_at) - clickedAt).toBe(3_500)
    expect((await readManifest(draft.directory)).started_at).toBe(capturing.started_at)

    const { summary, lengths } = await fake.stop(6_000)
    const finished = await finishRecording({ directory: draft.directory, manifest: capturing, summary })
    const span = (Date.parse(finished.ended_at!) - Date.parse(finished.started_at)) / 1000

    expect(finished.duration_seconds).toBe(6)
    expect(Math.abs(span - finished.duration_seconds!)).toBeLessThan(0.1)
    expect(finished.tracks.map((track) => track.name).toSorted()).toEqual(["mic.m4a", "system.m4a", "video.mp4"])

    for (const track of finished.tracks) {
      // The manifest's span, less the track's own start offset, is the length of the file on disk.
      const expected = span - track.start_offset_ms! / 1000
      expect(Math.abs(expected - lengths[track.name])).toBeLessThan(0.1)
    }
  })

  test("a failed start removes the provisional recording", async () => {
    const root = await scratch()
    const draft = await beginRecording({ root, title: "Standup", source, calendarEventId: null, settings: DEFAULT_SETTINGS })
    const helper: RecordingHelper = { request: () => Promise.reject(new Error("screen-permission")) }

    await expect(captureRecording({ ...draft, helper, source, settings: DEFAULT_SETTINGS })).rejects.toThrow(
      "screen-permission",
    )
    expect(await readdir(root)).toEqual([])
  })

  test("without a helper summary the duration comes from the manifest's own timestamps", async () => {
    setSystemTime(new Date("2026-10-27T09:00:00.000Z"))
    const root = await scratch()
    const fake = fakeHelper({ attachMs: 200, offsets: { "mic.m4a": 0 } })
    const draft = await beginRecording({ root, title: "Call", source, calendarEventId: null, settings: DEFAULT_SETTINGS })
    const capturing = await captureRecording({ ...draft, helper: fake.helper, source, settings: DEFAULT_SETTINGS })

    // The helper died: its files remain, but no `stopped` summary arrives.
    const { lengths } = await fake.stop(4_000)
    const finished = await finishRecording({ directory: draft.directory, manifest: capturing })

    expect(Math.abs(finished.duration_seconds! - lengths["mic.m4a"])).toBeLessThan(0.1)
  })
})
