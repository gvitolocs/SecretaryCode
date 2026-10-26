import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { LANES, ORCHESTRA_WORKERS, launchPlan, orchestraRequest, projectPath, remoteProject } from "./lanes"
import { redactLaneOutput, supervisedSSH } from "./lane-process"
import page from "../../renderer/secretary-lanes/index.html?raw"
import style from "../../renderer/secretary-lanes/style.css?raw"
import client from "../../renderer/secretary-lanes/client.mjs?raw"

const scheme = "secretary-coding"
const origin = `${scheme}://app/index.html`
let window: BrowserWindow | undefined
let registered = false
let ready: Promise<void>
let processState: { child: ChildProcess; raw: string; status: string; exitCode?: number | null; cancel: boolean } | undefined
let starting = false
let startCancelled = false

function collect(child: ChildProcess) {
  const run = { child, raw: "", status: "Running", cancel: false, exitCode: undefined as number | null | undefined }
  processState = run
  const append = (data: Buffer) => { run.raw = (run.raw + data.toString()).slice(-256_000) }
  child.stdout?.on("data", append)
  child.stderr?.on("data", append)
  child.stdin?.on("error", error => { if (!run.cancel) run.raw += `\nInput stream closed: ${error.message}` })
  child.on("error", error => { run.raw += `\n${error.message}`; run.status = "Failed to start"; run.exitCode = -1 })
  child.on("close", code => { run.exitCode = code; run.status = run.cancel ? "Cancelled" : code === 0 ? "Completed" : `Failed (exit ${code ?? "signal"})`; child.stdin?.destroy() })
  return run
}

function cancel() {
  if (starting) startCancelled = true
  if (!processState || processState.exitCode !== undefined || processState.cancel) return
  processState.cancel = true
  processState.status = "Cancelling — waiting for the worker to stop"
  // Remote supervisor observes EOF and terminates its process group; flash-do cancels its request.
  processState.child.stdin?.end()
  if (processState.child.spawnfile === "/usr/bin/ssh") return
  if (processState.child.pid) {
    try { process.kill(-processState.child.pid, "SIGTERM") } catch { processState.child.kill("SIGTERM") }
  }
}

async function qwenSlot() {
  return new Promise<"free" | "busy" | "unknown">(resolve => {
    const child = spawn("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "--", "nezopt", "flock -n /home/nez/.cache/qcode/lock true"], { stdio: "ignore", shell: false })
    const timer = setTimeout(() => { child.kill(); resolve("unknown") }, 12_000)
    child.on("error", () => { clearTimeout(timer); resolve("unknown") })
    child.on("close", code => { clearTimeout(timer); resolve(code === 0 ? "free" : code === 1 ? "busy" : "unknown") })
  })
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request")
  return value as Record<string, unknown>
}

async function perform(action: string, input: unknown) {
  if (action === "status") return {
    lanes: LANES, workers: ORCHESTRA_WORKERS, running: starting || !!processState && processState.exitCode === undefined,
    status: starting ? "Checking project and worker availability" : processState?.status ?? "Ready",
    output: redactLaneOutput(processState?.raw ?? ""), exitCode: processState?.exitCode,
  }
  if (action === "pick") {
    const result = await dialog.showOpenDialog(window!, { title: "Choose a project", properties: ["openDirectory"] })
    return { path: result.canceled ? undefined : result.filePaths[0] }
  }
  if (action === "cancel") { cancel(); return { requested: true } }
  if (action !== "launch") throw new Error("Unknown action")
  if (starting || processState && processState.exitCode === undefined) throw new Error("A coding task is already running in this window")
  starting = true
  startCancelled = false
  try {
    const data = object(input)
    const project = projectPath(data.project)
    if (!(await stat(project)).isDirectory()) throw new Error("Select an existing project directory")
    const lane = typeof data.lane === "string" ? data.lane : ""
    const prompt = typeof data.prompt === "string" ? data.prompt : ""
    if (!prompt.trim() || prompt.length > 100_000) throw new Error("Enter a task of up to 100,000 characters")
    const remote = typeof data.remoteProject === "string" && data.remoteProject ? data.remoteProject : undefined
    if (startCancelled) throw new Error("Task launch cancelled")
    if (lane === "orchestra") {
      const request = orchestraRequest({ project, remoteProject: remote, prompt, requestID: `secretary-${Date.now()}`, worker: typeof data.worker === "string" ? data.worker : undefined })
      const remotePath = request.arguments.workspace
      const ssh = supervisedSSH()
      const run = collect(spawn(ssh.executable, ssh.args, { cwd: project, shell: false, stdio: ["pipe", "pipe", "pipe"] }))
      run.child.stdin?.write(JSON.stringify({ cwd: remotePath, command: [], orchestra: true, prompt, worker: request.arguments.preferred_worker }) + "\n")
      return { started: true }
    }
    const plan = launchPlan(lane, { project, remoteProject: remote, prompt, interactive: false, qwenSlot: lane === "qwen" ? await qwenSlot() : undefined })
    if (startCancelled) throw new Error("Task launch cancelled")
    if (plan.remote) {
      const ssh = supervisedSSH()
      const run = collect(spawn(ssh.executable, ssh.args, { cwd: project, shell: false, stdio: ["pipe", "pipe", "pipe"] }))
      run.child.stdin?.write(JSON.stringify({ cwd: remoteProject(project, remote), command: [plan.remote.executable, ...plan.remote.args], input: plan.stdin }) + "\n")
      return { started: true }
    }
    const run = collect(spawn(plan.executable, plan.args, { cwd: plan.cwd, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] }))
    run.child.stdin?.end(plan.stdin)
    return { started: true }
  } finally { starting = false }
}

/** Call before app.ready; preload must expose codingLanesBridge under window.electron.codingLanes. */
export function setupCodingLanes() {
  if (registered) return
  registered = true
  // Scheme privileges are registered once with the other renderer schemes in windows/scheme.ts.
  ready = app.whenReady().then(() => {
    protocol.handle(scheme, request => {
      const url = new URL(request.url)
      if (url.hostname !== "app") return new Response(null, { status: 404 })
      const assets: Record<string, [string, string]> = { "/index.html": [page, "text/html"], "/style.css": [style, "text/css"], "/client.mjs": [client, "text/javascript"] }
      const asset = assets[url.pathname]
      if (!asset) return new Response(null, { status: 404 })
      return new Response(asset[0], { headers: { "Content-Type": asset[1], "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'", "X-Content-Type-Options": "nosniff" } })
    })
    ipcMain.handle("secretary:lanes", async (event, action: unknown, input: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame?.url !== origin) return { ok: false, error: "Invalid window" }
      try { return { ok: true, data: await perform(typeof action === "string" ? action : "", input) } }
      catch (error) { return { ok: false, error: redactLaneOutput(error instanceof Error ? error.message : "Task failed") } }
    })
  })
  app.on("before-quit", cancel)
}

export async function openCodingLanes() {
  if (!registered) throw new Error("Call setupCodingLanes before app.ready")
  await ready
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return window }
  window = new BrowserWindow({ width: 1040, height: 800, minWidth: 760, minHeight: 620, title: "Secretary Code · Coding agents", backgroundColor: "#101212", titleBarStyle: "hiddenInset", webPreferences: {
    preload: join(import.meta.dirname, "../preload/index.cjs"), additionalArguments: ["--opencode-window=" + encodeURIComponent(JSON.stringify({ id: "secretary-coding", packaged: app.isPackaged }))], contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
  } })
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, url) => { if (url !== origin) event.preventDefault() })
  window.on("closed", () => { cancel(); window = undefined })
  await window.loadURL(origin)
  return window
}
