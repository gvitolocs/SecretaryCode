import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Attachment } from "./collect"
import type { DiagnosticReport } from "./report"

/** Enough history for a week of offline launches, few enough to stay small on disk. */
export const MAX_ENTRIES = 25

/** Waits after each failed attempt; the last one repeats until the report is delivered. */
const RETRY_DELAYS = [0, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]

const REPORT_FILE = "report.json"

export type OutboxEntry = {
  id: string
  report: DiagnosticReport
  /** `file` is relative to the entry's directory; `name` is the multipart file name. */
  attachments: { name: string; file: string }[]
  attempts: number
  next_attempt_at: string
  last_error: string | null
  server_id: string | null
  created_at: string
}

export type QueuedReport = { entry: OutboxEntry; attachments: Attachment[] }

export function retryDelay(attempts: number) {
  return RETRY_DELAYS[Math.min(Math.max(attempts, 0), RETRY_DELAYS.length - 1)]
}

/**
 * Reports waiting to reach Lucina, one directory per report. A report is written before any network
 * call, so a crash or a lost connection leaves it on disk for the next launch; delivery deletes the
 * directory, and a failed attempt only moves `next_attempt_at` forward.
 */
export function createOutbox(root: string) {
  const directory = (id: string) => path.join(root, id)

  const read = async (id: string) =>
    parse(await readFile(path.join(directory(id), REPORT_FILE), "utf8").catch(() => undefined))

  const write = async (entry: OutboxEntry) => {
    const target = directory(entry.id)
    await mkdir(target, { recursive: true, mode: 0o700 })
    await writeFile(path.join(target, `${REPORT_FILE}.tmp`), JSON.stringify(entry, null, 2), { mode: 0o600 })
    await rename(path.join(target, `${REPORT_FILE}.tmp`), path.join(target, REPORT_FILE))
  }

  const entries = async () => {
    const names = await readdir(root, { withFileTypes: true }).catch(() => [])

    return (await Promise.all(names.filter((name) => name.isDirectory()).map((name) => read(name.name))))
      .filter((entry) => entry !== undefined)
      .toSorted((a, b) => a.created_at.localeCompare(b.created_at))
  }

  const prune = async () => {
    const stored = await entries()

    if (stored.length <= MAX_ENTRIES) return
    const stamped = await Promise.all(
      stored.map(async (entry) => ({
        entry,
        time: (await stat(path.join(directory(entry.id), REPORT_FILE)).catch(() => undefined))?.mtimeMs ?? 0,
      })),
    )
    const remove = stamped.toSorted((a, b) => a.time - b.time).slice(0, stored.length - MAX_ENTRIES)

    await Promise.all(remove.map((item) => rm(directory(item.entry.id), { recursive: true, force: true })))
  }

  return {
    /** Stores a report and its attachments; prunes the oldest reports past `MAX_ENTRIES`. */
    async enqueue(report: DiagnosticReport, attachments: readonly Attachment[]) {
      const entry = entryFor(report, attachments)
      const target = directory(entry.id)
      await mkdir(target, { recursive: true, mode: 0o700 })
      await Promise.all(
        entry.attachments.map((attachment, index) =>
          writeFile(path.join(target, attachment.file), attachments[index].data, { mode: 0o600 }),
        ),
      )
      await write(entry)
      await prune()

      return entry
    },

    /** The crash path: a process that is about to exit cannot await a write. */
    enqueueSync(report: DiagnosticReport, attachments: readonly Attachment[]) {
      const entry = entryFor(report, attachments)
      const target = directory(entry.id)
      mkdirSync(target, { recursive: true, mode: 0o700 })

      entry.attachments.forEach((attachment, index) =>
        writeFileSync(path.join(target, attachment.file), attachments[index].data, { mode: 0o600 }),
      )
      writeFileSync(path.join(target, `${REPORT_FILE}.tmp`), JSON.stringify(entry, null, 2), { mode: 0o600 })
      renameSync(path.join(target, `${REPORT_FILE}.tmp`), path.join(target, REPORT_FILE))

      return entry
    },

    /** Replaces the attachments of a report already on disk, keeping its id and attempt state. */
    async attach(entry: OutboxEntry, attachments: readonly Attachment[]) {
      const target = directory(entry.id)
      const next: OutboxEntry = {
        ...entry,
        attachments: attachments.map((attachment, index) => ({
          name: attachment.name,
          file: `${index + 1}-${safeName(attachment.name)}`,
        })),
      }

      await mkdir(target, { recursive: true, mode: 0o700 })
      await Promise.all(
        next.attachments.map((attachment, index) =>
          writeFile(path.join(target, attachment.file), attachments[index].data, { mode: 0o600 }),
        ),
      )
      await write(next)

      return next
    },

    entries,

    async due(at = new Date()) {
      return (await entries()).filter((entry) => Date.parse(entry.next_attempt_at) <= at.getTime())
    },

    has(id: string) {
      return read(id).then((entry) => entry !== undefined)
    },

    async load(entry: OutboxEntry): Promise<QueuedReport> {
      const attachments = await Promise.all(
        entry.attachments.map(async (attachment) => ({
          name: attachment.name,
          data: new Uint8Array(
            await readFile(path.join(directory(entry.id), attachment.file)).catch(() => new Uint8Array()),
          ),
        })),
      )

      return { entry, attachments }
    },

    /** Counts an attempt and schedules the next one; the report stays queued. */
    async fail(id: string, error: string, at = new Date()) {
      const entry = await read(id)

      if (!entry) return undefined
      const attempts = entry.attempts + 1
      const next: OutboxEntry = {
        ...entry,
        attempts,
        last_error: error,
        next_attempt_at: new Date(at.getTime() + retryDelay(attempts)).toISOString(),
      }

      await write(next)

      return next
    },

    /** Delivered: the local copy is no longer needed. */
    async complete(id: string) {
      await rm(directory(id), { recursive: true, force: true })
    },
  }
}

function entryFor(report: DiagnosticReport, attachments: readonly Attachment[]): OutboxEntry {
  const now = new Date().toISOString()

  return {
    id: randomUUID(),
    report,
    // Indexed so two attachments with the same basename cannot overwrite each other.
    attachments: attachments.map((attachment, index) => ({
      name: attachment.name,
      file: `${index + 1}-${safeName(attachment.name)}`,
    })),
    attempts: 0,
    next_attempt_at: now,
    last_error: null,
    server_id: null,
    created_at: now,
  }
}

function safeName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120) || "attachment"
}

function parse(text: string | undefined): OutboxEntry | undefined {
  if (!text) return undefined

  try {
    const value = JSON.parse(text) as unknown

    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const entry = value as Record<string, unknown>

    if (typeof entry.id !== "string" || !entry.report || typeof entry.report !== "object") return undefined
    const report = entry.report as Record<string, unknown>

    if (typeof report.message !== "string" || typeof report.kind !== "string") return undefined

    return {
      id: entry.id,
      report: report as DiagnosticReport,
      attachments: (Array.isArray(entry.attachments) ? entry.attachments : []).flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const attachment = item as Record<string, unknown>

        return typeof attachment.name === "string" && typeof attachment.file === "string"
          ? [{ name: attachment.name, file: attachment.file }]
          : []
      }),
      attempts: typeof entry.attempts === "number" ? entry.attempts : 0,
      next_attempt_at: typeof entry.next_attempt_at === "string" ? entry.next_attempt_at : new Date().toISOString(),
      last_error: typeof entry.last_error === "string" ? entry.last_error : null,
      server_id: typeof entry.server_id === "string" ? entry.server_id : null,
      created_at: typeof entry.created_at === "string" ? entry.created_at : new Date().toISOString(),
    }
  } catch {
    return undefined
  }
}
