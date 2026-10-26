import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { record } from "./input"
import { TRACKS, parseSource, type CaptureSource, type TrackName } from "./protocol"
import type { RecorderSettings } from "./settings"

export const RECORDINGS_FOLDER = "Secretary Recordings"

export const MANIFEST = "meeting.json"

export type UploadStatus = "recording" | "pending" | "uploading" | "processing" | "ready" | "failed"

export type ManifestTrack = {
  name: TrackName
  bytes: number
  sha256: string
  mime: string
  /** Milliseconds between the recording start and this track's first sample, for aligning tracks. */
  start_offset_ms: number | null
  /** When the server reported the same sha256 back. Only then may the local file be deleted. */
  confirmed_at: string | null
}

export type Manifest = {
  version: 1
  id: string
  title: string
  started_at: string
  ended_at: string | null
  duration_seconds: number | null
  source_app: { bundle_id: string | null; name: string | null }
  source: CaptureSource
  calendar_event_id: string | null
  settings: {
    video: boolean
    resolution: string
    fps: number
    codec: string
    bitrate_kbps: number
    system_audio: string
    microphone: boolean
  }
  tracks: ManifestTrack[]
  /** When retention removed the media files. meeting.json stays so the brief remains listed. */
  local_deleted_at: string | null
  upload: {
    status: UploadStatus
    meeting_id: string | null
    completed_at: string | null
    error: string | null
    brief: string | null
    transcript: string | null
    transcript_url: string | null
    updated_at: string
  }
}

/** `2026-10-26 1430 Weekly sync`, in local time so it reads like the owner's calendar. */
export function folderName(date: Date, title: string) {
  const pad = (value: number) => String(value).padStart(2, "0")

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())} ${sanitizeTitle(title)}`
}

/** A title that is safe as one path component on macOS and still recognisable. */
export function sanitizeTitle(title: string) {
  const clean = title
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[/\\:]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim()

  const limited = Array.from(clean).slice(0, 80).join("").trim()

  return limited || "Recording"
}

/** Creates `<root>/<name>`, adding ` 2`, ` 3`… when a recording already uses that name. */
export async function createRecordingDirectory(root: string, name: string) {
  await mkdir(root, { recursive: true })

  for (let attempt = 1; attempt < 1000; attempt++) {
    const directory = path.join(root, attempt === 1 ? name : `${name} ${attempt}`)

    const created = await mkdir(directory).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false
        throw error
      },
    )

    if (created) return directory
  }

  throw new Error("Could not create a recording folder")
}

export function createManifest(input: {
  id: string
  title: string
  startedAt: Date
  source: CaptureSource
  calendarEventId: string | null
  settings: RecorderSettings
}): Manifest {
  return {
    version: 1,
    id: input.id,
    title: input.title,
    started_at: input.startedAt.toISOString(),
    ended_at: null,
    duration_seconds: null,
    source_app: sourceApp(input.source),
    source: input.source,
    calendar_event_id: input.calendarEventId,
    settings: {
      video: input.settings.video,
      resolution: input.settings.resolution,
      fps: input.settings.fps,
      codec: input.settings.codec,
      bitrate_kbps: input.settings.bitrateKbps,
      system_audio: input.settings.systemAudio,
      microphone: input.settings.microphoneEnabled,
    },
    tracks: [],
    local_deleted_at: null,
    upload: {
      status: "recording",
      meeting_id: null,
      completed_at: null,
      error: null,
      brief: null,
      transcript: null,
      transcript_url: null,
      updated_at: input.startedAt.toISOString(),
    },
  }
}

export function mimeType(name: TrackName) {
  return name === "video.mp4" ? "video/mp4" : "audio/mp4"
}

/** Body of `POST /v1/meetings`. */
export function meetingRequest(manifest: Manifest) {
  return {
    title: manifest.title,
    started_at: manifest.started_at,
    ended_at: manifest.ended_at,
    source_app: manifest.source_app,
    calendar_event_id: manifest.calendar_event_id,
    tracks: manifest.tracks.map((track) => ({
      name: track.name,
      bytes: track.bytes,
      sha256: track.sha256,
      mime: track.mime,
      start_offset_ms: track.start_offset_ms,
    })),
  }
}

/**
 * Local files may go only once every track's sha256 was confirmed by the server, the meeting was
 * completed, and the owner's retention period has passed since the recording ended.
 */
export function retentionExpired(manifest: Manifest, keepDays: number) {
  if (!manifest.ended_at || !manifest.upload.completed_at || manifest.local_deleted_at || manifest.tracks.length === 0)
    return false

  if (manifest.tracks.some((track) => !track.confirmed_at)) return false

  return Date.parse(manifest.ended_at) + keepDays * 86_400_000 <= Date.now()
}

export async function readManifest(directory: string) {
  return parseManifest(JSON.parse(await readFile(path.join(directory, MANIFEST), "utf8")))
}

/** Written to a temporary file and renamed, so a crash never leaves a half-written manifest. */
export async function writeManifest(directory: string, manifest: Manifest) {
  const file = path.join(directory, MANIFEST)
  await writeFile(`${file}.tmp`, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}

export async function fileDigest(file: string) {
  const hash = createHash("sha256")

  for await (const chunk of createReadStream(file)) hash.update(chunk)

  return hash.digest("hex")
}

export function parseManifest(input: unknown): Manifest {
  const value = record(input, "manifest")
  const upload = record(value.upload, "manifest.upload")
  const settings = record(value.settings, "manifest.settings")
  const app = record(value.source_app, "manifest.source_app")

  if (
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.started_at !== "string"
  )
    throw new Error("Unsupported meeting.json")
  const status = (["recording", "pending", "uploading", "processing", "ready", "failed"] as const).find(
    (item) => item === upload.status,
  )

  if (!status) throw new Error("Unsupported meeting.json upload status")

  return {
    version: 1,
    id: value.id,
    title: value.title,
    started_at: value.started_at,
    ended_at: nullableString(value.ended_at),
    duration_seconds: typeof value.duration_seconds === "number" ? value.duration_seconds : null,
    source_app: { bundle_id: nullableString(app.bundle_id), name: nullableString(app.name) },
    source: parseSource(value.source),
    calendar_event_id: nullableString(value.calendar_event_id),
    settings: {
      video: settings.video === true,
      resolution: String(settings.resolution ?? ""),
      fps: Number(settings.fps) || 0,
      codec: String(settings.codec ?? ""),
      bitrate_kbps: Number(settings.bitrate_kbps) || 0,
      system_audio: String(settings.system_audio ?? ""),
      microphone: settings.microphone === true,
    },
    tracks: (Array.isArray(value.tracks) ? value.tracks : []).map((item) => {
      const track = record(item, "manifest.track")
      const name = TRACKS.find((candidate) => candidate === track.name)

      if (
        !name ||
        typeof track.bytes !== "number" ||
        typeof track.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(track.sha256)
      )
        throw new Error("Invalid track in meeting.json")

      return {
        name,
        bytes: track.bytes,
        sha256: track.sha256,
        mime: typeof track.mime === "string" ? track.mime : mimeType(name),
        start_offset_ms: typeof track.start_offset_ms === "number" ? track.start_offset_ms : null,
        confirmed_at: nullableString(track.confirmed_at),
      }
    }),
    local_deleted_at: nullableString(value.local_deleted_at),
    upload: {
      status,
      meeting_id: nullableString(upload.meeting_id),
      completed_at: nullableString(upload.completed_at),
      error: nullableString(upload.error),
      brief: nullableString(upload.brief),
      transcript: nullableString(upload.transcript),
      transcript_url: nullableString(upload.transcript_url),
      updated_at: typeof upload.updated_at === "string" ? upload.updated_at : value.started_at,
    },
  }
}

function sourceApp(source: CaptureSource) {
  if (source.kind === "display") return { bundle_id: null, name: source.name }

  return { bundle_id: source.bundleId, name: source.name }
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null
}
