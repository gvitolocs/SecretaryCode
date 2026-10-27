import { app, powerMonitor } from "electron"
import { randomUUID } from "node:crypto"
import { homedir, hostname, release } from "node:os"
import path from "node:path"
import { VERSION } from "../../constants"
import { secretaryToken } from "../index"
import { getStore } from "../../storage/store"
import { safeWebContentsURL } from "../../windows/state"
import { collectAttachments, servicePasswords, type LogSources } from "./collect"
import { HangMonitor, installCrashHooks, type CrashReport } from "./hooks"
import { createOutbox } from "./outbox"
import { errorDetails } from "./report"
import { Diagnostics, type CaptureInput, type CaptureResult } from "./service"

/** Lucina's diagnostics intake, authenticated with the same device token as the companion. */
const ORIGIN = "https://getsecretary.tech"

const AUTOMATIC_KEY = "diagnosticsAutomatic"

const DEVICE_KEY = "diagnosticsDevice"

/** Per log file: enough context to explain a failure, small enough to send on every report. */
const MAX_LOG_BYTES = 256 * 1024

/** A crashing process cannot wait for the network; everything else happens after this. */
const CRASH_EXIT_GRACE_MS = 2_000

export type FatalRendererErrorReport = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
  /** The owner's own words from the fatal screen. */
  note?: string
  /** True when the owner pressed "Send to Lucina" rather than automatic reporting. */
  userInitiated?: boolean
}

let diagnostics: Diagnostics | undefined
let automatic = true
let crashing = false
let device = ""

/**
 * Call from the entry module before `app.ready`: main-process crashes are captured from then on,
 * and the outbox of the previous launch starts draining in the background.
 */
export function setupDiagnostics() {
  if (diagnostics) return
  const store = getStore()
  const stored = store.get(AUTOMATIC_KEY)
  const deviceID = deviceIdentifier(store)
  const sources = logSources()

  automatic = typeof stored === "boolean" ? stored : true
  device = `${hostname()} ${deviceID.slice(0, 8)}`
  diagnostics = new Diagnostics({
    appVersion: VERSION,
    os: osName(),
    device,
    baseURL: ORIGIN,
    automatic,
    outbox: createOutbox(path.join(app.getPath("userData"), "diagnostics")),
    token: secretaryToken,
    secrets: () => servicePasswords(serviceDirectories()),
    collect: (includeCrashDump, secrets) =>
      collectAttachments(sources, { maxBytes: MAX_LOG_BYTES, secrets, includeCrashDump }),
  })

  const instance = diagnostics

  installCrashHooks({
    process,
    app,
    exit: (code) => process.exit(code),
    contentsURL: (contents) => safeWebContentsURL(contents as Parameters<typeof safeWebContentsURL>[0]),
    report: (report) => captureCrash(instance, report),
  })

  const hangs = new HangMonitor({
    report: (blockedMs) =>
      void instance.capture({
        kind: "hang",
        message: "The main process was unresponsive",
        context: { blockedMs, seconds: Math.round(blockedMs / 1_000) },
      }),
  })
  hangs.start()
  instance.start()

  // powerMonitor exists only once the app is ready; until then a hang cannot be mistaken for sleep.
  void app.whenReady().then(() => {
    powerMonitor.on("suspend", () => hangs.stop())
    powerMonitor.on("resume", () => hangs.start())
  })
}

/** A report from anywhere in the main process; never throws, never blocks the caller. */
export function reportDiagnostic(input: CaptureInput) {
  void diagnostics?.capture(input).catch(() => undefined)
}

/** The engine could not start: no local service, a version clash, or the startup timeout. */
export function reportEngineFailure(error: unknown, context: Record<string, unknown> = {}) {
  const details = errorDetails(error)

  reportDiagnostic({
    kind: "error",
    message: `The engine failed to start: ${details.message}`,
    stack: details.stack,
    context: { component: "engine", ...context },
  })
}

/** The native recorder helper failed, stopped unexpectedly, or could not start. */
export function reportRecorderFailure(code: string, message: string, context: Record<string, unknown> = {}) {
  reportDiagnostic({
    kind: "error",
    message: `The recorder failed: ${message || code}`,
    context: { component: "recorder", code, ...context },
  })
}

/** The fatal screen's report: automatic on mount, or explicit with the owner's note. */
export async function captureFatalRendererError(input: FatalRendererErrorReport): Promise<CaptureResult | undefined> {
  if (!diagnostics) return undefined
  const [first, ...rest] = input.error.split("\n")

  return diagnostics.capture({
    kind: "fatal_error",
    message: first?.trim() || "The application could not start",
    stack: rest.join("\n").trim() || null,
    userInitiated: input.userInitiated === true,
    context: {
      url: input.url,
      version: input.version,
      platform: input.platform,
      os: input.os,
      renderer: true,
      note: input.note?.trim() || undefined,
    },
  })
}

export function diagnosticSettings() {
  return { automatic }
}

export function setDiagnosticAutomatic(value: boolean) {
  automatic = value
  getStore().set(AUTOMATIC_KEY, value)

  if (diagnostics) {
    diagnostics.automatic = value
    if (value) void diagnostics.flush()
  }

  return { automatic }
}

export function flushDiagnostics() {
  return diagnostics?.flush()
}

/**
 * A crash is written to disk synchronously (the process may die at any moment), then enriched with
 * the log tails and sent while the process is still alive.
 */
function captureCrash(instance: Diagnostics, report: CrashReport) {
  if (crashing) return undefined
  const entry = instance.captureSync(report)

  if (!entry) return undefined
  crashing = true

  return Promise.race([
    instance.enrich(entry.id, report.includeCrashDump === true).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, CRASH_EXIT_GRACE_MS)),
  ])
}

function deviceIdentifier(store: ReturnType<typeof getStore>) {
  const stored = store.get(DEVICE_KEY)

  if (typeof stored === "string" && stored) return stored
  const created = randomUUID()
  store.set(DEVICE_KEY, created)

  return created
}

function osName() {
  const version = typeof process.getSystemVersion === "function" ? process.getSystemVersion() : release()

  return `${process.platform} ${version} ${process.arch}`
}

function logSources(): LogSources {
  const userData = app.getPath("userData")
  const data = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")

  return {
    logs: path.join(userData, "logs"),
    engineLogs: unique([
      // Secretary Code points XDG_DATA_HOME at its own engine root before any of this loads.
      path.join(data, "opencode", "log", "opencode.log"),
      path.join(userData, "opencode", "log", "opencode.log"),
      path.join(homedir(), ".local", "share", "opencode", "log", "opencode.log"),
    ]),
    crashpad: path.join(userData, "Crashpad"),
  }
}

/** The engine's service files (config and registration) carry the password its client must send. */
function serviceDirectories() {
  const config = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
  const state = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state")

  return unique([path.join(config, "opencode"), path.join(state, "opencode")])
}

function unique(paths: readonly string[]) {
  return [...new Set(paths)]
}
