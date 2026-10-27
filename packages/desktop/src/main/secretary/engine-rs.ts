// Glue for the owner's Rust port of the OpenCode core (`engine-rs/`). Two independent uses share this module:
// the "OpenCode Rust (preview)" coding lane, which runs one agent turn through `oc-cli ask`, and the
// "Rust engine (preview)" settings toggle, which keeps a bundled `oc-server` running beside the TypeScript
// engine on its own loopback port. The TypeScript engine is never replaced or reconfigured here.
//
// `oc-cli` is an HTTP client for `oc-server`, so a lane run starts a private server for that project first
// (OC_WORKTREE/OC_DATA/provider env), waits for its health route, then runs the CLI against it. The API key
// travels only in the server's environment: never in argv, never in the CLI's environment, never logged.
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { RustEngineLatency, RustEngineStatus } from "../../shared/ipc-rpc/engine-rs"
import { routeCoverage } from "./engine-rs-routes"
import { LaneError } from "./lanes"
import { redactLaneOutput } from "./lane-process"

export type RustProtocol = "openai" | "anthropic"

/** The selected TypeScript-engine provider, in the shape `oc-server` reads from its environment. */
export interface RustProvider {
  providerID: string
  protocol: RustProtocol
  /** `provider/model` as `OC_MODEL` expects it. */
  model: string
  baseURL?: string
  apiKey?: string
}

export interface RustEnginePlan {
  server: { executable: string; args: string[]; env: Record<string, string> }
  cli: { executable: string; args: string[]; env: Record<string, string> }
  url: string
}

// Providers whose wire protocol is not one of the two `oc-provider` implements. Everything else is treated
// as OpenAI-compatible, which is what nearly every provider actually ships, including local servers.
const UNSUPPORTED_PROVIDERS = /\b(?:google|gemini|vertex|cohere|azure|bedrock|databricks|sap|snowflake|poe)\b/u

/** The engine's own config and credential files, from the roots `secretary-environment.ts` sets. */
export function engineConfigPaths(env: NodeJS.ProcessEnv = process.env) {
  const fallback = join(homedir(), "Library", "Application Support", "app.secretary.code", "engine")
  const configRoot = env.XDG_CONFIG_HOME ?? join(fallback, "config")
  const dataRoot = env.XDG_DATA_HOME ?? join(fallback, "data")
  return {
    config: join(configRoot, "opencode", "opencode.json"),
    auth: join(dataRoot, "opencode", "auth.json"),
  }
}

/** `OC_DATA` for the preview server and lane runs: the app's userData, not the TypeScript engine's data. */
export function rustEngineDataPath(userData: string) {
  return join(userData, "engine-rs", "data")
}

/** The same directory when only the app's environment is available (lane runs), which lane-window fills in. */
export function rustEngineDataDir(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.SECRETARY_ENGINE_RS_DATA
  if (configured) return configured
  return rustEngineDataPath(join(homedir(), "Library", "Application Support", "app.secretary.code"))
}

/** The bundled binary, from `resources/engine-rs` in development and Contents/Resources when packaged. */
export function rustEngineExecutable(name: "oc-server" | "oc-cli", env: NodeJS.ProcessEnv = process.env) {
  const directory = env.SECRETARY_ENGINE_RS_DIR
  if (!directory) throw new LaneError("engine_unavailable", "The bundled Rust engine is unavailable. Rebuild the app or set SECRETARY_ENGINE_RS_DIR to its directory.")
  if (!directory.startsWith("/")) throw new LaneError("invalid_path", "SECRETARY_ENGINE_RS_DIR must be absolute")
  return join(directory, name)
}

/**
 * Reads the model the TypeScript engine would use and classifies its provider. Never includes the key in an
 * error message, and never returns it to a caller that puts it in argv.
 */
export function resolveRustProvider(config: unknown, auth: unknown): RustProvider {
  const settings = object(config)
  const selection = modelSelection(settings?.model)
  if (!selection) throw new LaneError("unsupported_provider", "Select a model in Secretary Code before using the Rust engine: its provider and base URL come from the engine config.")
  const providerConfig = object(object(settings?.provider)?.[selection.providerID])
  const protocol = protocolFor(selection.providerID, providerConfig)
  if (!protocol)
    throw new LaneError("unsupported_provider", `The Rust engine speaks the OpenAI-compatible and Anthropic protocols; ${selection.providerID} is neither.`)
  const baseURL = baseURLFor(providerConfig)
  const apiKey = apiKeyFor(auth, selection.providerID)
  return {
    providerID: selection.providerID,
    protocol,
    model: selection.model,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
  }
}

function protocolFor(providerID: string, config: Record<string, unknown> | undefined): RustProtocol | undefined {
  const hints = [providerID, config?.package, config?.npm].filter((value): value is string => typeof value === "string").join(" ").toLowerCase()
  if (/anthropic|claude/u.test(hints)) return "anthropic"
  if (UNSUPPORTED_PROVIDERS.test(hints)) return undefined
  return "openai"
}

function baseURLFor(config: Record<string, unknown> | undefined) {
  for (const candidate of [object(config?.settings)?.baseURL, object(config?.options)?.baseURL]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      throw new LaneError("invalid_provider", "The selected provider's base URL is not a valid URL")
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new LaneError("invalid_provider", "The selected provider's base URL must be http or https")
    return candidate.replace(/\/+$/u, "")
  }
  return undefined
}

function apiKeyFor(auth: unknown, providerID: string) {
  const entry = object(object(auth)?.[providerID])
  if (!entry) return undefined
  // Legacy `auth.json` entries: API keys, well-known tokens, and OAuth access tokens (which expire).
  const key = entry.type === "oauth" ? entry.access : entry.type === "wellknown" ? entry.token : entry.key
  return typeof key === "string" && key.trim() ? key : undefined
}

function modelSelection(model: unknown): { providerID: string; model: string } | undefined {
  const explicit = object(model)
  const value =
    typeof model === "string"
      ? model
      : typeof explicit?.providerID === "string" && typeof explicit.model === "string"
        ? `${explicit.providerID}/${explicit.model}`
        : undefined
  if (!value) return undefined
  // A v2 model reference may carry a variant (`provider/model#variant`); OC_MODEL has no variant axis.
  const [ref] = value.split("#", 1)
  const slash = ref?.indexOf("/") ?? -1
  if (!ref || slash <= 0 || slash === ref.length - 1) return undefined
  return { providerID: ref.slice(0, slash), model: ref }
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Reads the engine's config and credential files; a missing or unreadable file reads as empty. */
export async function readRustProvider(paths = engineConfigPaths()) {
  const read = async (file: string) => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as unknown
    } catch {
      return undefined
    }
  }
  const [config, auth] = await Promise.all([read(paths.config), read(paths.auth)])
  return resolveRustProvider(config, auth)
}

function providerEnvironment(provider: RustProvider) {
  return {
    OC_PROVIDER: provider.protocol,
    OC_MODEL: provider.model,
    ...(provider.baseURL ? { OC_BASE_URL: provider.baseURL } : {}),
    ...(provider.apiKey ? { OC_API_KEY: provider.apiKey } : {}),
  }
}

/**
 * The two processes a lane run needs. The server gets the project, the data directory and the provider (its
 * key included); the CLI gets only the endpoint, because the server is what calls the provider.
 */
export function rustLanePlan(input: {
  server: string
  cli: string
  project: string
  prompt: string
  data: string
  port: number
  provider?: RustProvider
}): RustEnginePlan {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new LaneError("invalid_port", "The Rust engine needs a valid loopback port")
  const url = `http://127.0.0.1:${input.port}`
  return {
    server: {
      executable: input.server,
      args: [],
      env: {
        OC_BIND: `127.0.0.1:${input.port}`,
        OC_DATA: input.data,
        OC_WORKTREE: input.project,
        ...(input.provider ? providerEnvironment(input.provider) : {}),
      },
    },
    cli: {
      executable: input.cli,
      args: ["ask", input.prompt, input.project],
      env: { OC_BASE: url, OC_DATA: input.data, OC_WORKTREE: input.project },
    },
    url,
  }
}

/** An ephemeral loopback port, used for the lane's private server and the preview server. */
export async function freeLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (!address || typeof address === "string") throw new LaneError("invalid_port", "Could not allocate a loopback port for the Rust engine")
  return address.port
}

/** Polls `/health` until the server answers or ten seconds pass. */
export async function waitForHealth(port: number): Promise<{ version?: string }> {
  const deadline = performance.now() + 10_000
  let lastError: unknown
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) {
        const body = object(await response.json().catch(() => undefined))
        return { version: typeof body?.version === "string" ? body.version : undefined }
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error
    }
    await sleep(50)
  }
  throw new LaneError("engine_rs_unhealthy", `The Rust engine did not become healthy on 127.0.0.1:${port}${lastError instanceof Error ? `: ${lastError.message}` : ""}`)
}

export interface RustEnginePreviewPaths {
  serverExecutable: string
  dataDir: string
  settingsFile: string
  configPath: string
  authPath: string
  /** The directory a turn on the preview server would run in; it serves status, not work. */
  worktree: string
}

export interface RustEnginePreview {
  /** Reads the persisted toggle and starts the server when it was left on. */
  load(): Promise<void>
  status(): RustEngineStatus
  setEnabled(enabled: boolean): Promise<RustEngineStatus>
  ping(tsUrl?: string): Promise<RustEngineLatency>
  stop(): Promise<void>
}

/**
 * Owns the preview `oc-server`. It runs beside the TypeScript engine on its own loopback port and is stopped
 * on quit; nothing here touches the TypeScript engine's process, port or data.
 */
export function createRustEnginePreview(paths: RustEnginePreviewPaths): RustEnginePreview {
  const state: {
    enabled: boolean
    child?: ChildProcess
    port?: number
    version?: string
    error?: string
    diagnostics: string
  } = { enabled: false, diagnostics: "" }

  const running = () => state.child !== undefined && state.child.exitCode === null && state.child.signalCode === null

  const status = (): RustEngineStatus => ({
    enabled: state.enabled,
    running: running(),
    ...(state.port !== undefined ? { port: state.port } : {}),
    ...(state.version !== undefined ? { version: state.version } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
    routes: routeCoverage(),
  })

  async function start() {
    if (running()) return
    state.error = undefined
    state.diagnostics = ""
    const port = await freeLoopbackPort()
    state.port = port
    await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
    const provider = await readRustProvider({ config: paths.configPath, auth: paths.authPath }).catch(() => undefined)
    const child = spawn(paths.serverExecutable, [], {
      cwd: paths.worktree,
      env: {
        ...process.env,
        ...(provider ? providerEnvironment(provider) : {}),
        OC_BIND: `127.0.0.1:${port}`,
        OC_DATA: paths.dataDir,
        OC_WORKTREE: paths.worktree,
      },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    state.child = child
    // A spawn failure or an immediate exit should surface at once instead of after the health deadline.
    let failStartup: (error: LaneError) => void = () => {}
    const startupFailed = new Promise<never>((_, reject) => {
      failStartup = reject
    })
    startupFailed.catch(() => undefined)
    const collect = (chunk: unknown) => {
      state.diagnostics = (state.diagnostics + String(chunk)).slice(-4_000)
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    child.on("error", (error) => {
      state.error = `The bundled Rust engine could not start: ${error.message}`
      state.child = undefined
      failStartup(new LaneError("engine_rs_unavailable", state.error))
    })
    child.on("exit", (code) => {
      if (state.child !== child) return
      state.child = undefined
      state.version = undefined
      if (state.enabled && !state.error) {
        state.error = `The bundled Rust engine stopped (exit ${code ?? "signal"}).${state.diagnostics ? ` ${redactLaneOutput(state.diagnostics.trim())}` : ""}`
        failStartup(new LaneError("engine_rs_unavailable", state.error))
      }
    })
    try {
      const health = await Promise.race([waitForHealth(port), startupFailed])
      state.version = health.version
    } catch (error) {
      await stop()
      state.error = error instanceof LaneError ? error.message : "The bundled Rust engine did not become healthy"
      throw error
    }
  }

  async function stop() {
    const child = state.child
    state.child = undefined
    state.version = undefined
    state.port = undefined
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const giveUp = setTimeout(() => resolve(), 2_000)
      let force: NodeJS.Timeout | undefined
      child.once("exit", () => {
        clearTimeout(giveUp)
        if (force) clearTimeout(force)
        resolve()
      })
      const signal = (name: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, name)
          else child.kill(name)
        } catch {
          // Already gone.
        }
      }
      signal("SIGTERM")
      force = setTimeout(() => signal("SIGKILL"), 1_000)
    })
  }

  async function readSettings() {
    try {
      return JSON.parse(await readFile(paths.settingsFile, "utf8")) as unknown
    } catch {
      return undefined
    }
  }

  async function persist() {
    await mkdir(dirname(paths.settingsFile), { recursive: true })
    await writeFile(paths.settingsFile, JSON.stringify({ enabled: state.enabled }, null, 2), { mode: 0o600 })
  }

  async function measure(url: string): Promise<{ ms: number; ok: boolean }> {
    const started = performance.now()
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      // A 401 from the TypeScript engine still proves the server answered; only 5xx and transport errors fail.
      return { ms: Math.round(performance.now() - started), ok: response.status < 500 }
    } catch {
      return { ms: Math.round(performance.now() - started), ok: false }
    }
  }

  return {
    async load() {
      const stored = await readSettings()
      state.enabled = object(stored)?.enabled === true
      if (!state.enabled) return
      await start().catch(() => {
        // `start` records the failure for the panel; a stale toggle must not break app startup.
      })
    },
    status,
    async setEnabled(enabled) {
      // Persist first: the toggle is the owner's choice, and a failed start must not silently reset it.
      state.enabled = enabled
      await persist()
      if (!enabled) {
        await stop()
        state.error = undefined
      } else {
        await start()
      }
      return status()
    },
    async ping(tsUrl) {
      const answer: { rust?: { ms: number; ok: boolean }; ts?: { ms: number; ok: boolean } } = {}
      if (running() && state.port !== undefined) answer.rust = await measure(`http://127.0.0.1:${state.port}/health`)
      if (tsUrl) {
        let url: URL | undefined
        try {
          url = new URL(tsUrl)
        } catch {
          url = undefined
        }
        if (url && (url.protocol === "http:" || url.protocol === "https:"))
          answer.ts = await measure(`${tsUrl.replace(/\/+$/u, "")}/api/session`)
      }
      return answer
    },
    async stop() {
      await stop()
    },
  }
}
