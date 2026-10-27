import type { Attachment } from "./collect"
import { sendReport, UploadError } from "./client"
import type { OutboxEntry, QueuedReport } from "./outbox"
import { createOutbox } from "./outbox"
import { createReport, fingerprint, type DiagnosticReport, type ReportKind } from "./report"
import { scrubReport } from "./scrub"

export type Outbox = ReturnType<typeof createOutbox>

/** How often a queued report is retried while the app stays open. */
const FLUSH_INTERVAL_MS = 60_000

/** A report Lucina refuses (a 4xx other than auth) is given up after this many attempts. */
const MAX_REJECTED_ATTEMPTS = 5

export type DiagnosticsOptions = {
  appVersion: string
  os: string
  device: string
  baseURL: string
  outbox: Outbox
  /** The signed-in Lucina device token, or undefined while signed out. */
  token: () => Promise<string | undefined>
  /** Exact values to redact everywhere, such as the engine's local service password. */
  secrets?: () => Promise<readonly string[]>
  /** Reads the log tails (and, for a crash, the newest minidump) for one report, scrubbed of `secrets`. */
  collect: (includeCrashDump: boolean, secrets: readonly string[]) => Promise<Attachment[]>
  /** Automatic reporting; the owner can turn it off and still send a report by hand. */
  automatic?: boolean
  send?: (report: DiagnosticReport, attachments: readonly Attachment[], endpoint: { baseURL: string; token: string }) => Promise<{ id: string }>
}

export type CaptureInput = {
  kind: ReportKind
  message: string
  stack?: string | null
  context?: Record<string, unknown>
  /** Crashes attach the newest Crashpad minidump. */
  includeCrashDump?: boolean
  /**
   * An explicit "Send to Lucina": sent as a `user_report` (the original kind goes in the context),
   * ignores the automatic-reporting setting and is never merged with an automatic report.
   */
  userInitiated?: boolean
}

export type CaptureResult = {
  /** The local report id, also used by the fatal screen to name the report. */
  id: string
  /** True when Lucina accepted it now; false means it waits in the outbox. */
  sent: boolean
  serverId: string | null
  duplicate: boolean
}

/**
 * Builds a report, keeps it on disk, and delivers it to Lucina with retry and backoff. One instance
 * lives in the main process; the outbox makes reports survive a crash or an offline launch.
 */
export class Diagnostics {
  automatic: boolean
  private readonly seen = new Map<string, string>()
  private readonly delivered = new Map<string, string>()
  private readonly sending = new Set<string>()
  private flushing: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  /** The last known secrets, for the crash path, which cannot wait to read them. */
  private secrets: readonly string[] = []

  constructor(private readonly options: DiagnosticsOptions) {
    this.automatic = options.automatic ?? true
  }

  /** Records a failure and tries to deliver it now; dedupes the same failure within this session. */
  async capture(input: CaptureInput): Promise<CaptureResult | undefined> {
    if (!this.automatic && !input.userInitiated) return undefined
    const secrets = await this.refreshSecrets()
    const report = this.report(input, secrets)
    const key = fingerprint(report)
    // An explicit send keeps its own report: the owner's note must reach Lucina even when the same
    // failure was already reported automatically.
    const previous = input.userInitiated ? undefined : this.seen.get(key)

    if (previous)
      return { id: previous, sent: this.delivered.has(previous), serverId: this.delivered.get(previous) ?? null, duplicate: true }

    const attachments = await this.options.collect(input.includeCrashDump === true, secrets).catch(() => [])
    const entry = await this.options.outbox.enqueue(report, attachments)
    if (!this.seen.has(key)) this.seen.set(key, entry.id)
    const serverId = await this.deliver(entry)

    return { id: entry.id, sent: serverId !== undefined, serverId: serverId ?? null, duplicate: false }
  }

  /**
   * The crash path: writes the report synchronously so nothing can be lost, then the caller enriches
   * and sends it while the process is still alive.
   */
  captureSync(input: CaptureInput) {
    if (!this.automatic && !input.userInitiated) return undefined
    const report = this.report(input, this.secrets)
    const key = fingerprint(report)

    if (this.seen.has(key)) return undefined
    const entry = this.options.outbox.enqueueSync(report, [])
    this.seen.set(key, entry.id)

    return entry
  }

  /** Adds the log tails to an already-written report, then sends it. */
  async enrich(id: string, includeCrashDump: boolean) {
    const entry = (await this.options.outbox.entries()).find((item) => item.id === id)

    if (!entry) return undefined
    const attachments = await this.options.collect(includeCrashDump, await this.refreshSecrets()).catch(() => [])
    const updated = await this.options.outbox.attach(entry, attachments)

    return this.deliver(updated)
  }

  /** Sends reports that are due. With automatic reporting off, only the owner's own reports go. */
  async flush() {
    if (this.flushing) return this.flushing

    this.flushing = (async () => {
      for (const entry of await this.options.outbox.due())
        if (this.automatic || entry.report.kind === "user_report") await this.deliver(entry)
    })().finally(() => {
      this.flushing = undefined
    })

    return this.flushing
  }

  start() {
    void this.refreshSecrets()
    void this.flush()
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Queued reports, for the settings screen and tests. */
  queued() {
    return this.options.outbox.entries()
  }

  private report(input: CaptureInput, secrets: readonly string[]): DiagnosticReport {
    const report = createReport({
      kind: input.userInitiated ? "user_report" : input.kind,
      message: input.message,
      stack: input.stack ?? null,
      context: input.userInitiated && input.kind !== "user_report" ? { ...input.context, kind: input.kind } : input.context,
      appVersion: this.options.appVersion,
      os: this.options.os,
      device: this.options.device,
    })

    return scrubReport(report, secrets)
  }

  private async refreshSecrets() {
    const secrets = await (this.options.secrets?.() ?? Promise.resolve(this.secrets)).catch(() => this.secrets)
    this.secrets = secrets

    return secrets
  }

  /** Sends one queued report; a failure keeps it queued and schedules the next attempt. */
  private async deliver(entry: OutboxEntry): Promise<string | undefined> {
    const already = this.delivered.get(entry.id)

    if (already) return already
    if (this.sending.has(entry.id)) return undefined
    this.sending.add(entry.id)

    try {
      const token = await this.options.token().catch(() => undefined)

      // Signed out: the report waits for the next launch rather than counting as a failed attempt.
      if (!token) return undefined
      const queued: QueuedReport = await this.options.outbox.load(entry)
      const send = this.options.send ?? sendReport
      const { id } = await send(queued.entry.report, queued.attachments, {
        baseURL: this.options.baseURL,
        token,
      })

      this.delivered.set(entry.id, id)
      await this.options.outbox.complete(entry.id)

      return id
    } catch (error) {
      const failed = await this.options.outbox.fail(
        entry.id,
        error instanceof UploadError ? `${error.code}: ${error.message}` : String(error),
      )

      // A report Lucina keeps refusing would otherwise be retried for every launch to come.
      if (error instanceof UploadError && error.code === "rejected" && (failed?.attempts ?? 0) >= MAX_REJECTED_ATTEMPTS)
        await this.options.outbox.complete(entry.id)

      return undefined
    } finally {
      this.sending.delete(entry.id)
    }
  }
}
