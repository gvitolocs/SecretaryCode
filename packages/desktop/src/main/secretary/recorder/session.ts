import { randomUUID } from "node:crypto"
import { rm, stat } from "node:fs/promises"
import path from "node:path"
import {
  createManifest,
  createRecordingDirectory,
  fileDigest,
  folderName,
  mimeType,
  writeManifest,
  type Manifest,
  type ManifestTrack,
} from "./manifest"
import { TRACKS, helperStartSettings, type CaptureSource, type StopSummary } from "./protocol"
import type { RecorderSettings } from "./settings"

/** The one helper command a recording needs; a stand-in drives the tests. */
export type RecordingHelper = {
  request(command: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

const START_TIMEOUT_MS = 60_000

export type RecordingDraft = { id: string; directory: string; manifest: Manifest }

/**
 * Creates the recording folder and its provisional `meeting.json` before capture starts, so a crash
 * during start still leaves a recoverable record. The manifest is rewritten with the helper's own
 * start time once capture actually begins.
 */
export async function beginRecording(input: {
  root: string
  title: string
  source: CaptureSource
  calendarEventId: string | null
  settings: RecorderSettings
}): Promise<RecordingDraft> {
  const requestedAt = new Date()
  const directory = await createRecordingDirectory(input.root, folderName(requestedAt, input.title))
  const id = randomUUID()
  const manifest = createManifest({
    id,
    title: input.title,
    startedAt: requestedAt,
    source: input.source,
    calendarEventId: input.calendarEventId,
    settings: input.settings,
  })

  await writeManifest(directory, manifest)

  return { id, directory, manifest }
}

/**
 * Asks the helper to start capturing and adopts the start time it reports. ScreenCaptureKit can take
 * seconds to attach, so the click time is not when the recording begins: the tracks do.
 */
export async function captureRecording(input: RecordingDraft & { helper: RecordingHelper; source: CaptureSource; settings: RecorderSettings }) {
  let startedAt: string

  try {
    const result = await input.helper.request(
      "start",
      { settings: helperStartSettings(input.settings, input.source, input.directory) },
      START_TIMEOUT_MS,
    )
    startedAt = reportedStart(result) ?? new Date().toISOString()
  } catch (error) {
    await rm(input.directory, { recursive: true, force: true })
    throw error
  }

  const manifest: Manifest = {
    ...input.manifest,
    started_at: startedAt,
    upload: { ...input.manifest.upload, updated_at: startedAt },
  }

  await writeManifest(input.directory, manifest)

  return manifest
}

/**
 * The final manifest: the helper's own start and end times, the duration it measured across every
 * track, and the files that exist on disk.
 */
export async function finishRecording(input: {
  directory: string
  manifest: Manifest
  summary?: StopSummary
}): Promise<Manifest> {
  const tracks = (
    await Promise.all(
      TRACKS.map(async (name): Promise<ManifestTrack | undefined> => {
        const file = path.join(input.directory, name)
        const size = await stat(file).then(
          (info) => info.size,
          () => 0,
        )

        if (!size) return undefined
        const offset = input.summary?.tracks.find((track) => track.name === name)?.startOffset

        return {
          name,
          bytes: size,
          sha256: await fileDigest(file),
          mime: mimeType(name),
          start_offset_ms: offset === null || offset === undefined ? null : Math.round(offset * 1000),
          confirmed_at: null,
        }
      }),
    )
  ).filter((track) => track !== undefined)

  const endedAt = input.summary?.endedAt || new Date().toISOString()
  const duration = input.summary?.duration ?? (Date.parse(endedAt) - Date.parse(input.manifest.started_at)) / 1000

  return {
    ...input.manifest,
    ended_at: endedAt,
    duration_seconds: Math.round(duration * 10) / 10,
    tracks,
    upload: {
      ...input.manifest.upload,
      status: tracks.length ? "pending" : "failed",
      error: tracks.length ? null : "emptyRecording",
      updated_at: endedAt,
    },
  }
}

/** `startedAt` from the helper's start reply, when it is a usable timestamp. */
function reportedStart(result: unknown) {
  if (!result || typeof result !== "object") return undefined
  const startedAt = (result as Record<string, unknown>).startedAt

  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) return undefined

  return new Date(startedAt).toISOString()
}
