import { open } from "node:fs/promises"
import path from "node:path"
import { record } from "./input"
import { meetingRequest, type Manifest, type ManifestTrack } from "./manifest"

export const SECRETARY_ORIGIN = "https://getsecretary.tech"

export const CHUNK_BYTES = 8 * 1024 * 1024

/** Waits between attempts after a network or server failure; the last one repeats until it works. */
const RETRY_DELAYS = [0, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000]

export class UploadError extends Error {
  constructor(
    readonly code: "signInRequired" | "rejected" | "checksumMismatch" | "aborted",
    message: string,
  ) {
    super(message)
    this.name = "UploadError"
  }
}

/** A failure worth retrying: lost connection, timeout, 408/429/5xx, or a disputed offset. */
class TransientError extends Error {}

export type UploadContext = {
  baseURL: string
  token: () => Promise<string | undefined>
  signal: AbortSignal
  onProgress: (sent: number, total: number) => void
  save: (manifest: Manifest) => Promise<void>
}

export type MeetingStatus = {
  status: "uploading" | "processing" | "ready" | "failed"
  brief: string | null
  transcript: string | null
  transcript_url: string | null
  error: string | null
}

/**
 * Creates the meeting (once), uploads every unconfirmed track resumably and completes the meeting.
 * Progress is saved to meeting.json after each step, so a restart continues where it stopped.
 */
export async function uploadRecording(directory: string, manifest: Manifest, context: UploadContext) {
  let current = manifest

  const save = async (next: Manifest) => {
    current = next
    await context.save(next)
  }

  const meetingID =
    current.upload.meeting_id ??
    (await retrying(context, async () => {
      const response = await call(context, "/v1/meetings", {
        method: "POST",
        body: JSON.stringify(meetingRequest(current)),
        // The local id makes a retried create (after a lost response) return the same meeting.
        headers: { "Content-Type": "application/json", "Idempotency-Key": current.id },
      })

      const created = record(await response.json(), "meeting")

      if (typeof created.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(created.id))
        throw new UploadError("rejected", "The server returned no meeting id")

      return created.id
    }))

  if (!current.upload.meeting_id)
    await save({
      ...current,
      upload: {
        ...current.upload,
        meeting_id: meetingID,
        status: "uploading",
        error: null,
        updated_at: new Date().toISOString(),
      },
    })

  const total = current.tracks.reduce((sum, track) => sum + track.bytes, 0)

  for (const track of current.tracks) {
    if (track.confirmed_at) continue
    const before = current.tracks.reduce((sum, item) => sum + (item.confirmed_at ? item.bytes : 0), 0)
    const sha256 = await uploadTrack(context, meetingID, path.join(directory, track.name), track, (sent) =>
      context.onProgress(before + sent, total),
    )

    if (sha256 !== track.sha256)
      throw new UploadError("checksumMismatch", `The server stored a different ${track.name}`)
    const confirmed = new Date().toISOString()
    await save({
      ...current,
      tracks: current.tracks.map((item) => (item.name === track.name ? { ...item, confirmed_at: confirmed } : item)),
    })
  }

  context.onProgress(total, total)

  if (!current.upload.completed_at) {
    await retrying(context, () =>
      call(context, `/v1/meetings/${encodeURIComponent(meetingID)}/complete`, { method: "POST" }),
    )
    const completed = new Date().toISOString()
    await save({
      ...current,
      upload: { ...current.upload, status: "processing", completed_at: completed, error: null, updated_at: completed },
    })
  }

  return current
}

/** `GET /v1/meetings/{id}`: processing status, then the brief and the transcript. */
export async function fetchMeeting(
  context: Pick<UploadContext, "baseURL" | "token" | "signal">,
  meetingID: string,
): Promise<MeetingStatus> {
  const response = await call(context, `/v1/meetings/${encodeURIComponent(meetingID)}`, { method: "GET" })
  const value = record(await response.json(), "meeting")
  const status =
    (["uploading", "processing", "ready", "failed"] as const).find((item) => item === value.status) ?? "processing"
  const url =
    typeof value.transcript_url === "string" &&
    URL.canParse(value.transcript_url) &&
    new URL(value.transcript_url).protocol === "https:"
      ? value.transcript_url
      : null

  return {
    status,
    brief: typeof value.brief === "string" ? value.brief : null,
    transcript: typeof value.transcript === "string" ? value.transcript : null,
    transcript_url: url,
    error: typeof value.error === "string" ? value.error : null,
  }
}

/**
 * Asks the server how much of the track it has (an empty PUT whose Content-Range uses `*` as the
 * range), then sends the rest in chunks. Every retry asks again, so an upload resumes from the server's offset, never
 * from what this side believes it sent.
 */
async function uploadTrack(
  context: UploadContext,
  meetingID: string,
  file: string,
  track: ManifestTrack,
  progress: (sent: number) => void,
) {
  const url = `/v1/meetings/${encodeURIComponent(meetingID)}/tracks/${encodeURIComponent(track.name)}`
  const handle = await open(file, "r")

  try {
    return await retrying(context, async () => {
      let state = await put(context, url, track, `bytes */${track.bytes}`)

      while (state.kind === "partial") {
        progress(state.offset)

        if (state.offset >= track.bytes)
          throw new UploadError("rejected", `The server has all of ${track.name} but did not finish it`)
        const end = Math.min(state.offset + CHUNK_BYTES, track.bytes)
        const chunk = new Uint8Array(end - state.offset)
        const read = await handle.read(chunk, 0, chunk.length, state.offset)

        if (read.bytesRead !== chunk.length) throw new UploadError("rejected", `${track.name} changed on disk`)
        state = await put(context, url, track, `bytes ${state.offset}-${end - 1}/${track.bytes}`, chunk)
      }

      progress(track.bytes)

      return state.sha256
    })
  } finally {
    await handle.close()
  }
}

async function put(
  context: UploadContext,
  url: string,
  track: ManifestTrack,
  range: string,
  body?: Uint8Array<ArrayBuffer>,
) {
  const response = await call(
    context,
    url,
    { method: "PUT", body, headers: { "Content-Type": track.mime, "Content-Range": range } },
    [308, 409, 416],
  )

  if (response.status === 308) return { kind: "partial" as const, offset: storedBytes(response.headers.get("Range")) }

  // The server's offset differs from the one we sent: ask it again.
  if (response.status === 409 || response.status === 416) throw new TransientError("Upload offset changed")
  const result = record(await response.json(), "track")

  if (typeof result.sha256 !== "string") throw new UploadError("rejected", `The server did not confirm ${track.name}`)

  return { kind: "complete" as const, sha256: result.sha256.toLowerCase() }
}

/** `Range: bytes=0-1023` means 1024 bytes are stored; no header means none. */
function storedBytes(header: string | null) {
  if (!header) return 0
  const match = /^bytes=0-(\d+)$/.exec(header.trim())

  if (!match) throw new UploadError("rejected", `Unexpected Range header: ${header}`)

  return Number(match[1]) + 1
}

async function call(
  context: Pick<UploadContext, "baseURL" | "token" | "signal">,
  url: string,
  init: RequestInit,
  accepted: number[] = [],
) {
  const token = await context.token()

  if (!token) throw new UploadError("signInRequired", "Sign in to Secretary to upload recordings")

  const response = await fetch(context.baseURL + url, {
    ...init,
    // 308 means "resume incomplete" here, never a redirect to follow.
    redirect: "manual",
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]),
    headers: { ...init.headers, Authorization: `Bearer ${token}`, "X-Secretary-Client": "web" },
  }).catch((error: unknown) => {
    if (context.signal.aborted) throw new UploadError("aborted", "Upload stopped")
    throw new TransientError(error instanceof Error ? error.message : "Network error")
  })

  if (response.ok || accepted.includes(response.status)) return response
  await response.body?.cancel()

  if (response.status === 401) throw new UploadError("signInRequired", "Sign in to Secretary to upload recordings")

  if (response.status === 408 || response.status === 429 || response.status >= 500)
    throw new TransientError(`Server answered ${response.status}`)
  throw new UploadError("rejected", `Server answered ${response.status}`)
}

async function retrying<T>(context: Pick<UploadContext, "signal">, run: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (!(error instanceof TransientError)) throw error

      if (context.signal.aborted) throw new UploadError("aborted", "Upload stopped")
      await sleep(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)], context.signal)
    }
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new UploadError("aborted", "Upload stopped"))

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop)
      resolve()
    }, ms)

    const stop = () => {
      clearTimeout(timer)
      reject(new UploadError("aborted", "Upload stopped"))
    }

    signal.addEventListener("abort", stop, { once: true })
  })
}
