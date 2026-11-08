import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { stat } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { join } from "node:path"
import { readRustProvider, rustEngineDataDir, rustEngineExecutable, rustLanePlan } from "./engine-rs"
import { LANES, LaneError, ORCHESTRA_WORKERS, launchPlan, orchestraRequest, projectPath, sshHosts } from "./lanes"
import type { QwenSlot } from "./lanes"
import { engineOutput, reach, redactLaneOutput, supervisedSSH } from "./lane-process"

/** One channel for the coding-lanes window and the main app windows; lane-window validates the sender. */
export const LaneChannel = "secretary:lanes"

export type LaneResult = { ok: true; data: unknown } | { ok: false; error: string; code: string }

// One task at a time across every window, so a second window cannot start a parallel run.
let processState:
  | { child: ChildProcess; raw: string; stdout: string; stderr: string; status: string; exitCode?: number | null; cancel: boolean; interruptSignal: 'SIGINT' | 'SIGTERM'; outputFormat?: 'opencode-json' }
  | undefined
let starting = false
let startCancelled = false

/** Answers one raw `(action, input)` request; errors carry a stable `code` for callers to branch on. */
export async function handleLaneRequest(action: unknown, input: unknown): Promise<LaneResult> {
  try {
    return { ok: true, data: await perform(typeof action === "string" ? action : "", input) }
  } catch (error) {
    return {
      ok: false,
      error: redactLaneOutput(error instanceof Error ? error.message : "Task failed"),
      code: error instanceof LaneError ? error.code : "task_failed",
    }
  }
}

export function cancelLane() {
  if (starting) startCancelled = true
  if (!processState || processState.exitCode !== undefined || processState.cancel) return
  processState.cancel = true
  processState.status = "Cancelling — waiting for the worker to stop"
  // Remote supervisor observes EOF and terminates its process group; flash-do cancels its request.
  processState.child.stdin?.end()
  if (processState.child.spawnfile === "/usr/bin/ssh") return
  if (processState.child.pid) {
    try {
      process.kill(-processState.child.pid, processState.interruptSignal)
    } catch {
      processState.child.kill(processState.interruptSignal)
    }
  }
}

async function perform(action: string, input: unknown) {
  if (action === "list") return { lanes: LANES, workers: ORCHESTRA_WORKERS, hosts: sshHosts() }
  if (action === "status")
    return {
      lanes: LANES,
      workers: ORCHESTRA_WORKERS,
      running: starting || (!!processState && processState.exitCode === undefined),
      status: starting ? "Checking project and worker availability" : (processState?.status ?? "Ready"),
      output: redactLaneOutput(processState?.outputFormat === 'opencode-json'
        ? [engineOutput(processState.stdout), processState.stderr].filter(Boolean).join('\n')
        : processState?.raw ?? ""),
      exitCode: processState?.exitCode,
    }
  if (action === "probe") {
    if (object(input).lane !== "qwen")
      throw new LaneError("unknown_lane", "Only the Qwen lane has a shared slot to probe")
    return qwenSlot()
  }
  if (action === "cancel") {
    cancelLane()
    return { requested: true }
  }
  if (action !== "launch") throw new LaneError("unknown_action", "Unknown action")
  if (starting || (processState && processState.exitCode === undefined))
    throw new LaneError("task_running", "A coding task is already running")
  starting = true
  startCancelled = false
  try {
    const data = object(input)
    const project = projectPath(data.project)
    if (!(await stat(project).catch(() => undefined))?.isDirectory())
      throw new LaneError("invalid_path", "Select an existing project directory")
    const lane = typeof data.lane === "string" ? data.lane : ""
    const prompt = typeof data.prompt === "string" ? data.prompt : ""
    if (!prompt.trim() || prompt.length > 100_000)
      throw new LaneError("invalid_input", "Enter a task of up to 100,000 characters")
    const remote = typeof data.remoteProject === "string" && data.remoteProject ? data.remoteProject : undefined
    const model = typeof data.model === "string" ? data.model : undefined
    if (startCancelled) throw new LaneError("cancelled", "Task launch cancelled")
    if (lane === "orchestra") {
      const request = orchestraRequest({
        project,
        remoteProject: remote,
        prompt,
        requestID: `secretary-${Date.now()}`,
        worker: typeof data.worker === "string" ? data.worker : undefined,
      })
      const ssh = supervisedSSH(await reachableHost())
      if (startCancelled) throw new LaneError("cancelled", "Task launch cancelled")
      const run = collect(
        spawn(ssh.executable, ssh.args, { cwd: project, shell: false, stdio: ["pipe", "pipe", "pipe"] }),
      )
      run.child.stdin?.write(
        JSON.stringify({
          cwd: request.arguments.workspace,
          command: [],
          orchestra: true,
          prompt,
          worker: request.arguments.preferred_worker,
        }) + "\n",
      )
      return { started: true }
    }
    if (lane === "rust") return await startRustLane(project, prompt)
    // Validate the lane and paths before any SSH round trip; the host is filled in once one answers.
    const validated = launchPlan(lane, { project, remoteProject: remote, prompt, model, interactive: false, qwenSlot: "free" })
    const slot = lane === "qwen" ? await qwenSlot() : undefined
    const host = slot?.host ?? (validated.remote ? await reachableHost() : undefined)
    const plan = launchPlan(lane, {
      project,
      remoteProject: remote,
      prompt,
      model,
      interactive: false,
      qwenSlot: slot?.slot,
      host,
    })
    if (startCancelled) throw new LaneError("cancelled", "Task launch cancelled")
    if (plan.remote) {
      const ssh = supervisedSSH(plan.remote.host)
      const run = collect(
        spawn(ssh.executable, ssh.args, { cwd: project, shell: false, stdio: ["pipe", "pipe", "pipe"] }),
      )
      run.child.stdin?.write(
        JSON.stringify({
          cwd: plan.remote.project,
          command: [plan.remote.executable, ...plan.remote.args],
          input: plan.stdin,
        }) + "\n",
      )
      return { started: true }
    }
    const run = collect(
      spawn(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: { ...process.env, PWD: plan.cwd },
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
      plan.interruptSignal,
      plan.outputFormat,
    )
    run.child.stdin?.end(plan.stdin)
    return { started: true }
  } finally {
    starting = false
  }
}

/**
 * One turn in `oc-cli --local ask`: the embedded runner calls the provider itself and runs the project as Claude
 * Code would (CLAUDE.md, settings, hooks, skills, commands, subagents, MCP). Cancel sends SIGTERM to its process
 * group, which the CLI turns into an interrupted turn (SessionEnd hooks still run).
 */
async function startRustLane(project: string, prompt: string) {
  // The prompt becomes one argv entry for oc-cli, so apply the same control-character rule as the other lanes.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(prompt))
    throw new LaneError("invalid_input", "Prompt must not contain unsupported control characters")
  // The preview reuses the TypeScript engine's selected model; the lane offers no model override.
  const provider = await readRustProvider()
  const cliPath = rustEngineExecutable("oc-cli")
  if (!(await stat(cliPath).catch(() => undefined))?.isFile())
    throw new LaneError("engine_unavailable", `The bundled Rust engine binary is missing: ${cliPath}. Rebuild the app or set SECRETARY_ENGINE_RS_DIR.`)
  // Lane transcripts get their own store, so a running preview server never rewrites them under the CLI.
  const plan = rustLanePlan({ cli: cliPath, project, prompt, data: join(rustEngineDataDir(), "lane"), provider })
  if (startCancelled) throw new LaneError("cancelled", "Task launch cancelled")
  collect(
    spawn(plan.cli.executable, plan.cli.args, {
      cwd: project,
      env: { ...process.env, PWD: project, ...plan.cli.env },
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  )
  return { started: true }
}

function collect(child: ChildProcess, interruptSignal: 'SIGINT' | 'SIGTERM' = 'SIGTERM', outputFormat?: 'opencode-json') {
  const run = { child, raw: "", stdout: "", stderr: "", status: "Running", cancel: false, exitCode: undefined as number | null | undefined, interruptSignal, outputFormat }
  processState = run
  const append = (text: string, stream: 'stdout' | 'stderr') => {
    if (outputFormat === 'opencode-json') {
      // Diagnostics must not become bytes inside a partially received JSON record.
      run[stream] = (run[stream] + text).slice(stream === 'stdout' ? -256_000 : -32_000)
      return
    }
    run.raw = (run.raw + text).slice(-256_000)
  }
  const stdout = new StringDecoder('utf8')
  const stderr = new StringDecoder('utf8')
  child.stdout?.on("data", chunk => append(stdout.write(chunk), 'stdout'))
  child.stdout?.on("end", () => append(stdout.end(), 'stdout'))
  child.stderr?.on("data", chunk => append(stderr.write(chunk), 'stderr'))
  child.stderr?.on("end", () => append(stderr.end(), 'stderr'))
  child.stdin?.on("error", (error) => {
    if (!run.cancel) append(`\nInput stream closed: ${error.message}`, 'stderr')
  })
  child.on("error", (error) => {
    append(`\n${error.message}`, 'stderr')
    run.status = "Failed to start"
    run.exitCode = -1
  })
  child.on("close", (code) => {
    child.stdin?.destroy()
    // A spawn failure also closes the pipes; keep the start failure instead of reporting a negative errno exit.
    if (run.status === "Failed to start") return
    run.exitCode = code
    run.status = run.cancel ? "Cancelled" : code === 0 ? "Completed" : `Failed (exit ${code ?? "signal"})`
  })
  return run
}

// flock exits 1 only when another process holds the lock that qcode-run serializes on.
async function qwenSlot(): Promise<{ slot: QwenSlot; host?: string }> {
  const answer = await reach(sshHosts(), "flock -n /home/nez/.cache/qcode/lock true")
  if (!answer) return { slot: "unknown" }
  return { slot: answer.code === 0 ? "free" : answer.code === 1 ? "busy" : "unknown", host: answer.host }
}

async function reachableHost() {
  const hosts = sshHosts()
  const answer = await reach(hosts, "true")
  if (answer?.code !== 0) throw new LaneError("ssh_unreachable", `Could not reach ${hosts.join(" or ")} over SSH`)
  return answer.host
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LaneError("invalid_input", "Invalid request")
  return value as Record<string, unknown>
}
