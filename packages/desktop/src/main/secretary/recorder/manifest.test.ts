import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createManifest,
  createRecordingDirectory,
  fileDigest,
  folderName,
  meetingRequest,
  readManifest,
  retentionExpired,
  sanitizeTitle,
  writeManifest,
  type Manifest,
} from "./manifest"
import { DEFAULT_SETTINGS } from "./settings"

const temporary: string[] = []

afterEach(async () => {
  setSystemTime()
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function scratch() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "secretary-recorder-"))
  temporary.push(directory)

  return directory
}

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    ...createManifest({
      id: "8d0b8f5e-7c55-4f0e-9d7b-2a8d8d2f5d11",
      title: "Weekly sync",
      startedAt: new Date("2026-10-26T13:30:00.000Z"),
      source: { kind: "app", bundleId: "com.microsoft.teams2", name: "Microsoft Teams" },
      calendarEventId: "evt_123",
      settings: DEFAULT_SETTINGS,
    }),
    ...overrides,
  }
}

describe("recording folder", () => {
  test.each([
    ["Weekly sync", "2026-10-26 1430 Weekly sync"],
    ["Q3 review: budget/plan", "2026-10-26 1430 Q3 review- budget-plan"],
    ["  ..hidden\ttitle\n ", "2026-10-26 1430 hidden title"],
    ["", "2026-10-26 1430 Recording"],
    ["/", "2026-10-26 1430 -"],
    ["Città 会議 🎓", "2026-10-26 1430 Città 会議 🎓"],
    ["x".repeat(200), `2026-10-26 1430 ${"x".repeat(80)}`],
  ])("%j becomes %j", (title, expected) => {
    expect(folderName(new Date(2026, 9, 26, 14, 30), title)).toBe(expected)
  })

  test("sanitized titles are one path component", () => {
    for (const title of ["../../etc", "a/b\\c:d", "\u0000\u001f", "..."])
      expect(sanitizeTitle(title)).not.toMatch(/[/\\:\u0000-\u001f]|^\./)
  })

  test("a second recording in the same minute gets its own folder", async () => {
    const root = path.join(await scratch(), "Secretary Recordings")
    const first = await createRecordingDirectory(root, "2026-10-26 1430 Standup")
    const second = await createRecordingDirectory(root, "2026-10-26 1430 Standup")
    expect(path.basename(first)).toBe("2026-10-26 1430 Standup")
    expect(path.basename(second)).toBe("2026-10-26 1430 Standup 2")
  })
})

describe("meeting.json", () => {
  test("round-trips through disk and leaves no temporary file", async () => {
    const directory = await scratch()

    const value = manifest({
      ended_at: "2026-10-26T14:31:00.000Z",
      tracks: [
        {
          name: "mic.m4a",
          bytes: 3,
          sha256: "a".repeat(64),
          mime: "audio/mp4",
          start_offset_ms: 12,
          confirmed_at: null,
        },
      ],
    })

    await writeManifest(directory, value)
    expect(await readManifest(directory)).toEqual(value)
    expect(await readdir(directory)).toEqual(["meeting.json"])
  })

  test.each([
    ["an unknown version", (value: Manifest) => ({ ...value, version: 2 })],
    [
      "a track outside the contract",
      (value: Manifest) => ({ ...value, tracks: [{ ...trackOf("mic.m4a"), name: "notes.txt" }] }),
    ],
    ["a malformed sha256", (value: Manifest) => ({ ...value, tracks: [{ ...trackOf("mic.m4a"), sha256: "xyz" }] })],
    ["an unknown upload status", (value: Manifest) => ({ ...value, upload: { ...value.upload, status: "done" } })],
  ])("rejects %s", async (_name, mutate) => {
    const directory = await scratch()
    await writeFile(path.join(directory, "meeting.json"), JSON.stringify(mutate(manifest())))
    await expect(readManifest(directory)).rejects.toThrow()
  })

  test("the create request carries exactly the contract fields", () => {
    const value = manifest({
      ended_at: "2026-10-26T14:31:00.000Z",
      tracks: [trackOf("system.m4a"), trackOf("mic.m4a")],
    })
    expect(meetingRequest(value)).toEqual({
      title: "Weekly sync",
      started_at: "2026-10-26T13:30:00.000Z",
      ended_at: "2026-10-26T14:31:00.000Z",
      source_app: { bundle_id: "com.microsoft.teams2", name: "Microsoft Teams" },
      calendar_event_id: "evt_123",
      tracks: [
        { name: "system.m4a", bytes: 10, sha256: "b".repeat(64), mime: "audio/mp4", start_offset_ms: 0 },
        { name: "mic.m4a", bytes: 10, sha256: "b".repeat(64), mime: "audio/mp4", start_offset_ms: 0 },
      ],
    })
  })

  test("digests files as lowercase sha256", async () => {
    const file = path.join(await scratch(), "mic.m4a")
    await writeFile(file, "abc")
    expect(await fileDigest(file)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
})

describe("retention", () => {
  const confirmed = manifest({
    ended_at: "2026-10-01T10:00:00.000Z",
    tracks: [
      { ...trackOf("mic.m4a"), confirmed_at: "2026-10-01T10:05:00.000Z" },
      { ...trackOf("system.m4a"), confirmed_at: "2026-10-01T10:05:00.000Z" },
    ],
    upload: { ...manifest().upload, status: "ready", completed_at: "2026-10-01T10:06:00.000Z" },
  })

  test.each([
    ["confirmed and past the retention period", confirmed, 14, "2026-10-15T10:00:00.000Z", true],
    ["confirmed but inside the retention period", confirmed, 14, "2026-10-15T09:59:59.000Z", false],
    ["confirmed with keep 0 days", confirmed, 0, "2026-10-01T10:00:00.000Z", true],
    [
      "one track not confirmed",
      { ...confirmed, tracks: [confirmed.tracks[0], { ...confirmed.tracks[1], confirmed_at: null }] },
      0,
      "2027-01-01T00:00:00.000Z",
      false,
    ],
    [
      "meeting never completed",
      { ...confirmed, upload: { ...confirmed.upload, completed_at: null } },
      0,
      "2027-01-01T00:00:00.000Z",
      false,
    ],
    ["still recording", { ...confirmed, ended_at: null }, 0, "2027-01-01T00:00:00.000Z", false],
    ["no tracks", { ...confirmed, tracks: [] }, 0, "2027-01-01T00:00:00.000Z", false],
    [
      "already deleted",
      { ...confirmed, local_deleted_at: "2026-10-20T00:00:00.000Z" },
      0,
      "2027-01-01T00:00:00.000Z",
      false,
    ],
  ] as const)("%s", (_name, value, keepDays, now, expected) => {
    setSystemTime(new Date(now))
    expect(retentionExpired(value, keepDays)).toBe(expected)
  })
})

function trackOf(name: "mic.m4a" | "system.m4a") {
  return { name, bytes: 10, sha256: "b".repeat(64), mime: "audio/mp4", start_offset_ms: 0, confirmed_at: null }
}
