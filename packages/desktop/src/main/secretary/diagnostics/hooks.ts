import { errorDetails, type ReportKind } from "./report"

/** The part of `Electron.RenderProcessGoneDetails` a report needs. */
export type RenderProcessGoneDetails = { reason: string; exitCode: number; processType?: string }

/** The part of `Electron.Details` (a dead child process) a report needs. */
export type ChildProcessGoneDetails = {
  type: string
  reason: string
  exitCode?: number
  name?: string
  serviceName?: string
}

export type CrashReport = {
  kind: ReportKind
  message: string
  stack?: string | null
  context?: Record<string, unknown>
  includeCrashDump?: boolean
}

/** One Electron or Node emitter, narrowed to `on`/`off` for the events the hooks use. */
export type HookEmitter = {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off?(event: string, listener: (...args: unknown[]) => void): unknown
}

export type CrashHooksOptions = {
  process: HookEmitter
  app: HookEmitter
  /** Persists a report. A crash may return a promise; the hook exits once it settles. */
  report: (report: CrashReport) => unknown
  /** Ends the process after a fatal main-process error, matching Node's default behaviour. */
  exit: (code: number) => void
  /** The renderer URL for a dead WebContents, when it can still be read. */
  contentsURL?: (contents: unknown) => string | undefined
}

/**
 * Captures main-process exceptions, unhandled rejections and dead renderer/utility processes. An
 * uncaught main-process exception is reported and then ends the process.
 */
export function installCrashHooks(options: CrashHooksOptions) {
  const uncaught = (...args: unknown[]) => {
    const details = errorDetails(args[0])
    // This listener replaces Electron's error dialog, so the log is the only local trace left.
    console.error("uncaught exception in the main process", args[0])

    void Promise.resolve(
      options.report({ kind: "crash", message: details.message, stack: details.stack, includeCrashDump: true }),
    ).finally(() => options.exit(1))
  }

  const rejection = (...args: unknown[]) => {
    const details = errorDetails(args[0])

    void options.report({
      kind: "error",
      message: details.message,
      stack: details.stack,
      context: { unhandledRejection: true },
    })
  }

  const rendererGone = (...args: unknown[]) => {
    const details = args[2] as RenderProcessGoneDetails | undefined

    if (!details) return
    void options.report({
      kind: "crash",
      message: `Renderer process gone: ${details.reason}`,
      includeCrashDump: details.reason !== "clean-exit",
      context: {
        reason: details.reason,
        exitCode: details.exitCode,
        processType: details.processType,
        url: options.contentsURL?.(args[1]),
      },
    })
  }

  const childGone = (...args: unknown[]) => {
    const details = args[1] as ChildProcessGoneDetails | undefined

    if (!details) return
    void options.report({
      kind: "crash",
      message: `Child process gone: ${details.type} ${details.reason}`,
      includeCrashDump: false,
      context: {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        name: details.name,
        serviceName: details.serviceName,
      },
    })
  }

  options.process.on("uncaughtException", uncaught)
  options.process.on("unhandledRejection", rejection)
  options.app.on("render-process-gone", rendererGone)
  options.app.on("child-process-gone", childGone)

  return () => {
    options.process.off?.("uncaughtException", uncaught)
    options.process.off?.("unhandledRejection", rejection)
    options.app.off?.("render-process-gone", rendererGone)
    options.app.off?.("child-process-gone", childGone)
  }
}

/**
 * The heartbeat a blocked main thread misses. Stop it across system sleep (`powerMonitor` suspend and
 * resume): a sleeping Mac also skips beats, and that is not a hang.
 */
export class HangMonitor {
  private last = Date.now()
  private intervalMs = 1_000
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly options: {
      /** How long the event loop may stay blocked before it counts as a hang. */
      thresholdMs?: number
      report: (blockedMs: number) => void
    },
  ) {}

  start(intervalMs = 1_000) {
    this.stop()
    this.intervalMs = intervalMs
    this.last = Date.now()
    this.timer = setInterval(() => this.tick(), intervalMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One heartbeat: the gap beyond the expected interval is time the main thread could not run. */
  tick() {
    const now = Date.now()
    const blocked = now - this.last - this.intervalMs
    this.last = now

    if (blocked < (this.options.thresholdMs ?? 5_000)) return
    this.options.report(blocked)
  }
}
