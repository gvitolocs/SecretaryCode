import { afterEach, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { createManifest, fileDigest, mimeType, type Manifest } from "./manifest"
import { DEFAULT_SETTINGS } from "./settings"
import { CHUNK_BYTES, UploadError, fetchMeeting, uploadRecording } from "./uploader"

const TOKEN = "sec_test_device_token"

const cleanup: (() => Promise<unknown>)[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()))
})

/**
 * A server that implements the meetings contract from the PR description. `dropAfter` cuts the
 * connection once that many bytes of a track have arrived, keeping what it received, as a real
 * network loss would.
 */
async function meetingServer(options: { dropAfter?: Record<string, number>; wrongDigest?: string } = {}) {
  const stored = new Map<string, Buffer>()
  const done = new Set<string>()
  const log: string[] = []
  const created: unknown[] = []
  let completed = 0
  const drop = new Map(Object.entries(options.dropAfter ?? {}))

  const send = (response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) })
    response.end(body ? JSON.stringify(body) : undefined)
  }

  const progress = (name: string) => {
    const bytes = stored.get(name)?.length ?? 0

    return bytes ? { Range: `bytes=0-${bytes - 1}` } : {}
  }

  const finished = (name: string) => ({
    name,
    bytes: stored.get(name)!.length,
    sha256:
      name === options.wrongDigest ? "0".repeat(64) : createHash("sha256").update(stored.get(name)!).digest("hex"),
  })

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? ""
    log.push(`${request.method} ${url} ${request.headers["content-range"] ?? ""}`.trim())

    if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(response, 401, { error: "signInRequired" })

    if (request.method === "POST" && url === "/v1/meetings") {
      const chunks: Buffer[] = []

      for await (const chunk of request) chunks.push(chunk)
      created.push(JSON.parse(Buffer.concat(chunks).toString()))

      return send(response, 201, { id: "mtg_1" })
    }

    const track = /^\/v1\/meetings\/mtg_1\/tracks\/([a-z0-9.]+)$/.exec(url)?.[1]

    if (request.method === "PUT" && track) {
      const range = String(request.headers["content-range"])
      const query = /^bytes \*\/(\d+)$/.exec(range)

      if (query) {
        request.resume()

        return done.has(track) ? send(response, 200, finished(track)) : send(response, 308, undefined, progress(track))
      }

      const [, start, end, total] = (/^bytes (\d+)-(\d+)\/(\d+)$/.exec(range) ?? []).map(Number)

      if ((stored.get(track)?.length ?? 0) !== start) {
        request.resume()

        return send(response, 416, undefined, progress(track))
      }

      for await (const chunk of request) {
        stored.set(track, Buffer.concat([stored.get(track) ?? Buffer.alloc(0), chunk]))
        const limit = drop.get(track)

        if (limit !== undefined && stored.get(track)!.length >= limit) {
          drop.delete(track)
          stored.set(track, stored.get(track)!.subarray(0, limit))
          request.socket.destroy()

          return
        }
      }

      if (stored.get(track)!.length !== end + 1) return send(response, 400)

      if (end + 1 < total) return send(response, 308, undefined, progress(track))
      done.add(track)

      return send(response, 201, finished(track))
    }

    if (request.method === "POST" && url === "/v1/meetings/mtg_1/complete") {
      completed++

      return send(response, 202, { id: "mtg_1", status: "processing" })
    }

    if (request.method === "GET" && url === "/v1/meetings/mtg_1")
      return send(response, 200, {
        id: "mtg_1",
        status: "ready",
        brief: "Agreed to ship Friday.",
        transcript: "Professor: Welcome.",
        transcript_url: "https://getsecretary.tech/meetings/mtg_1",
      })
    send(response, 404)
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise((resolve) => server.close(resolve)))

  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    stored,
    log,
    created,
    completed: () => completed,
  }
}

async function recording(sizes: Partial<Record<"system.m4a" | "mic.m4a" | "video.mp4", number>>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "secretary-upload-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const files = new Map<string, Buffer>()

  const base = createManifest({
    id: "3f6c2a51-9a0e-4c7e-8d1f-6b9a2c4e7f10",
    title: "Lecture 4",
    startedAt: new Date("2026-10-26T09:00:00.000Z"),
    source: { kind: "app", bundleId: "us.zoom.xos", name: "zoom.us" },
    calendarEventId: null,
    settings: DEFAULT_SETTINGS,
  })

  const tracks = await Promise.all(
    Object.entries(sizes).map(async ([name, bytes]) => {
      const data = randomBytes(bytes)
      files.set(name, data)
      await writeFile(path.join(directory, name), data)
      const trackName = name as "system.m4a" | "mic.m4a" | "video.mp4"

      return {
        name: trackName,
        bytes,
        sha256: await fileDigest(path.join(directory, name)),
        mime: mimeType(trackName),
        start_offset_ms: 0,
        confirmed_at: null,
      }
    }),
  )

  const manifest: Manifest = {
    ...base,
    ended_at: "2026-10-26T10:30:00.000Z",
    tracks,
    upload: { ...base.upload, status: "pending" },
  }

  return { directory, files, manifest }
}

function context(baseURL: string, saved: Manifest[], token: string | undefined = TOKEN) {
  const progress: number[] = []

  return {
    progress,
    value: {
      baseURL,
      token: async () => token,
      signal: new AbortController().signal,
      onProgress: (sent: number) => progress.push(sent),
      save: async (manifest: Manifest) => {
        saved.push(manifest)
      },
    },
  }
}

test("an interrupted upload resumes from the offset the server reports", async () => {
  // 3 MiB + 17 bytes lands mid-chunk, so resuming from a chunk boundary or from 0 would be caught.
  const cut = 3 * 1024 * 1024 + 17
  const server = await meetingServer({ dropAfter: { "mic.m4a": cut } })
  const local = await recording({ "system.m4a": 64 * 1024, "mic.m4a": CHUNK_BYTES + 1024 * 1024 })
  const saved: Manifest[] = []
  const run = context(server.baseURL, saved)

  const result = await uploadRecording(local.directory, local.manifest, run.value)

  for (const [name, data] of local.files) expect(server.stored.get(name)?.equals(data)).toBe(true)
  const total = CHUNK_BYTES + 1024 * 1024
  const micRanges = server.log
    .filter((line) => line.startsWith("PUT /v1/meetings/mtg_1/tracks/mic.m4a"))
    .map((line) => line.split(" bytes ")[1])
  // The fetch implementation may replay the dropped request by itself; the server's 416 answers it.
  expect(new Set(micRanges)).toEqual(
    new Set([`*/${total}`, `0-${CHUNK_BYTES - 1}/${total}`, `${cut}-${total - 1}/${total}`]),
  )
  expect(micRanges.slice(-2)).toEqual([`*/${total}`, `${cut}-${total - 1}/${total}`])
  expect(server.created).toHaveLength(1)
  expect(server.completed()).toBe(1)
  expect(result.upload).toMatchObject({ meeting_id: "mtg_1", status: "processing" })
  expect(result.upload.completed_at).not.toBeNull()
  expect(result.tracks.every((track) => track.confirmed_at)).toBe(true)
  expect(saved.at(-1)).toEqual(result)
  expect(run.progress.at(-1)).toBe(64 * 1024 + CHUNK_BYTES + 1024 * 1024)
})

test("a restarted upload reuses the meeting and skips confirmed tracks", async () => {
  const server = await meetingServer()
  const local = await recording({ "system.m4a": 2048, "mic.m4a": 4096 })

  const manifest = {
    ...local.manifest,
    tracks: local.manifest.tracks.map((track) =>
      track.name === "system.m4a" ? { ...track, confirmed_at: "2026-10-26T10:31:00.000Z" } : track,
    ),
    upload: { ...local.manifest.upload, meeting_id: "mtg_1", status: "uploading" as const },
  }

  const result = await uploadRecording(local.directory, manifest, context(server.baseURL, []).value)

  expect(server.created).toHaveLength(0)
  expect(server.log.some((line) => line.includes("system.m4a"))).toBe(false)
  expect(server.stored.get("mic.m4a")?.equals(local.files.get("mic.m4a")!)).toBe(true)
  expect(result.upload.status).toBe("processing")
})

test("a digest the server disagrees with is never confirmed", async () => {
  const server = await meetingServer({ wrongDigest: "mic.m4a" })
  const local = await recording({ "system.m4a": 1024, "mic.m4a": 1024 })
  const saved: Manifest[] = []

  const error = await uploadRecording(local.directory, local.manifest, context(server.baseURL, saved).value).catch(
    (caught: unknown) => caught,
  )

  expect(error).toBeInstanceOf(UploadError)
  expect((error as UploadError).code).toBe("checksumMismatch")
  expect(saved.at(-1)?.tracks.find((track) => track.name === "mic.m4a")?.confirmed_at).toBeNull()
  expect(server.completed()).toBe(0)
})

test("an expired device token asks the owner to sign in instead of retrying", async () => {
  const server = await meetingServer()
  const local = await recording({ "mic.m4a": 1024 })

  const error = await uploadRecording(
    local.directory,
    local.manifest,
    context(server.baseURL, [], "sec_revoked").value,
  ).catch((caught: unknown) => caught)

  expect((error as UploadError).code).toBe("signInRequired")
  expect(server.log).toEqual(["POST /v1/meetings"])
})

test("meeting status carries the brief and an https transcript link", async () => {
  const server = await meetingServer()
  expect(await fetchMeeting(context(server.baseURL, []).value, "mtg_1")).toEqual({
    status: "ready",
    brief: "Agreed to ship Friday.",
    transcript: "Professor: Welcome.",
    transcript_url: "https://getsecretary.tech/meetings/mtg_1",
    error: null,
  })
})
