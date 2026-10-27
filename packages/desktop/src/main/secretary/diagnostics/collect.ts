import { open, readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { scrub } from "./scrub"

/** One multipart file of a diagnostics report. Text attachments arrive scrubbed by the caller. */
export type Attachment = { name: string; data: Uint8Array }

/** Where the app writes the logs and crash dumps a report attaches. */
export type LogSources = {
  /** `<userData>/logs`, one timestamped directory per launch. */
  logs: string
  /** Engine log candidates, most specific first (`engine/data/opencode/log/opencode.log`). */
  engineLogs: readonly string[]
  /** `<userData>/Crashpad`. */
  crashpad: string
}

export type CollectOptions = {
  /** Bytes read from the end of each log. */
  maxBytes: number
  /** Exact values to redact, such as the engine's service password. */
  secrets: readonly string[]
  /** Crash dumps are only worth 10–20 MB for an actual crash. */
  includeCrashDump: boolean
}

const LOG_FILES = ["main.log", "renderer.log"] as const

/** The last logs of this launch, the engine log and, for a crash, the newest minidump. */
export async function collectAttachments(sources: LogSources, options: CollectOptions) {
  const attachments: Attachment[] = []
  const run = await newestDirectory(sources.logs)

  if (run)
    for (const name of LOG_FILES) {
      const text = await readTail(path.join(run, name), options.maxBytes)

      if (text) attachments.push(textAttachment(name, text, options.secrets))
    }

  for (const candidate of sources.engineLogs) {
    const text = await readTail(candidate, options.maxBytes)

    if (!text) continue
    attachments.push(textAttachment("opencode.log", text, options.secrets))
    break
  }

  if (options.includeCrashDump) {
    const dump = await newestFile(sources.crashpad, ".dmp")

    if (dump) attachments.push({ name: `crashpad/${path.basename(dump)}`, data: new Uint8Array(await readFile(dump)) })
  }

  return attachments
}

/**
 * Exact credential values that belong to this installation: the `password` of every engine service
 * file (`service.json`, `service-<channel>.json`) in the given directories.
 */
export async function servicePasswords(directories: readonly string[]) {
  const files = (
    await Promise.all(
      directories.map(async (directory) =>
        (await readdir(directory).catch(() => []))
          .filter((name) => /^service.*\.json$/.test(name))
          .map((name) => path.join(directory, name)),
      ),
    )
  ).flat()
  const values = await Promise.all(
    files.map(async (file) => {
      const stored = await readFile(file, "utf8")
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => undefined)

      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return undefined
      const password = (stored as Record<string, unknown>).password

      return typeof password === "string" && password ? password : undefined
    }),
  )

  return [...new Set(values.filter((value) => value !== undefined))]
}

/** Bytes from the end of a file, starting at a line boundary so the first line is not cut mid-way. */
export async function readTail(file: string, maxBytes: number) {
  const handle = await open(file, "r").catch(() => undefined)

  if (!handle) return ""

  try {
    const size = Number((await handle.stat()).size)

    if (!size) return ""
    const start = Math.max(0, size - maxBytes)
    const buffer = new Uint8Array(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const text = new TextDecoder().decode(buffer)

    return start === 0 ? text : text.slice(Math.max(0, text.indexOf("\n") + 1))
  } finally {
    await handle.close()
  }
}

function textAttachment(name: string, text: string, secrets: readonly string[]): Attachment {
  return { name, data: new TextEncoder().encode(scrub(text, secrets)) }
}

/** Launch directories are named by their UTC start stamp (`20261027T090000`), so the newest sorts last. */
async function newestDirectory(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const name = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .at(-1)

  return name ? path.join(root, name) : undefined
}

async function newestFile(root: string, extension: string) {
  const files = await walk(root)

  return newest(root, files.filter((file) => file.endsWith(extension)))
}

async function walk(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => [])

  return (
    await Promise.all(
      entries.map(async (entry): Promise<string[]> => {
        const relative = prefix ? path.join(prefix, entry.name) : entry.name

        if (entry.isDirectory()) return walk(root, relative)

        return entry.isFile() ? [relative] : []
      }),
    )
  ).flat()
}

/** The most recently modified of `names` (paths relative to `root`), or undefined when none exists. */
async function newest(root: string, names: readonly string[]) {
  const stamped = await Promise.all(
    names.map(async (name) => {
      const info = await stat(path.join(root, name)).catch(() => undefined)

      return info ? { path: path.join(root, name), time: info.mtime?.getTime() ?? 0 } : undefined
    }),
  )

  return stamped
    .filter((item) => item !== undefined)
    .toSorted((a, b) => b.time - a.time)
    .at(0)?.path
}
