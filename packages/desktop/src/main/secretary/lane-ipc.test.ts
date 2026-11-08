import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleLaneRequest } from "./lane-ipc"

const configured = [
  "SECRETARY_SSH_HOST",
  "SECRETARY_SSH_FALLBACK_HOST",
  "SECRETARY_CLAUDE_PATH",
  "SECRETARY_ENGINE_PATH",
  "SECRETARY_ENGINE_RS_DIR",
  "SECRETARY_ENGINE_RS_DATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const
const RUST_SECRET = "sk-proj-rustlanefixture1234"
const saved = Object.fromEntries(configured.map((key) => [key, process.env[key]]))
const root = { path: "" }

beforeAll(async () => {
  root.path = await realpath(await mkdtemp(join(tmpdir(), "secretary-lanes-")))
  // Stands in for the Claude CLI: echoes its argv, then the prompt it reads from stdin.
  await writeFile(join(root.path, "claude"), '#!/bin/sh\necho "argv:$*"\ncat\n')
  await writeFile(join(root.path, "slow"), "#!/bin/sh\nexec sleep 30\n")
  await writeFile(join(root.path, "engine"), '#!/usr/bin/env python3\nimport json,os,signal,sys,time\ndef reply(text):\n print(json.dumps({"type":"text","part":{"text":text}}),flush=True)\ndef stop(*args):\n reply("interrupted");sys.exit(130)\nsignal.signal(signal.SIGINT,stop)\nprompt=sys.stdin.read()\nreply("ready:"+os.getcwd()+":"+os.environ.get("PWD","")+":"+prompt)\nwhile True: time.sleep(1)\n')
  await chmod(join(root.path, "claude"), 0o755)
  await chmod(join(root.path, "slow"), 0o755)
  await chmod(join(root.path, "engine"), 0o755)
  await writeFile(join(root.path, "fragmented-engine"), String.raw`#!/usr/bin/env python3
import os,time
os.write(1,b'{"type":"text","part":{"text":"Caf\xc3')
time.sleep(.1)
os.write(2,b'engine diagnostic\n')
time.sleep(.1)
os.write(1,b'\xa9"}}\n')
`)
  await chmod(join(root.path, "fragmented-engine"), 0o755)

  // The Rust preview lane: a stand-in oc-cli that reports what it was actually given. The real one runs the
  // turn itself in embedded mode (`--local`), so there is no server process beside it.
  const binaries = join(root.path, "engine-rs")
  await mkdir(binaries, { recursive: true })
  await writeFile(
    join(binaries, "oc-cli"),
    '#!/bin/sh\nfor a in "$@"; do echo "arg:[$a]"; done\necho "base:${OC_BASE-unset}"\necho "cwd:$OC_CWD"\necho "data:$OC_DATA"\n' +
      'echo "provider:$OC_PROVIDER $OC_MODEL"\necho "permissions:$OC_PERMISSIONS"\n' +
      'if [ "$OC_API_KEY" = "' + RUST_SECRET + '" ]; then echo "key:passed"; else echo "key:missing"; fi\n',
  )
  await chmod(join(binaries, "oc-cli"), 0o755)
  await mkdir(join(root.path, "config", "opencode"), { recursive: true })
  await mkdir(join(root.path, "data", "opencode"), { recursive: true })
  await writeFile(join(root.path, "data", "opencode", "auth.json"), JSON.stringify({ openai: { type: "api", key: RUST_SECRET } }))
})
afterEach(async () => {
  await handleLaneRequest("cancel", undefined)
  await until(async () => !(await status()).running)
  for (const key of configured) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
afterAll(() => rm(root.path, { recursive: true, force: true }))

async function status() {
  const result = await handleLaneRequest("status", undefined)
  if (!result.ok) throw new Error(result.error)
  return result.data as { running: boolean; status: string; output: string; exitCode?: number | null }
}

async function until(check: () => Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the lane")
    await Bun.sleep(20)
  }
}


async function setRustEnvironment(config: unknown) {
  await writeFile(join(root.path, "config", "opencode", "opencode.json"), JSON.stringify(config))
  process.env.XDG_CONFIG_HOME = join(root.path, "config")
  process.env.XDG_DATA_HOME = join(root.path, "data")
  process.env.SECRETARY_ENGINE_RS_DIR = join(root.path, "engine-rs")
  process.env.SECRETARY_ENGINE_RS_DATA = join(root.path, "engine-rs-data")
}

const openaiRustConfig = {
  model: "openai/gpt-4o-mini",
  provider: { openai: { settings: { baseURL: "https://api.example.test/v1" } } },
}

describe("lane IPC", () => {
  test("keeps UTF-8 replies intact when engine diagnostics arrive between stdout fragments", async () => {
    process.env.SECRETARY_ENGINE_PATH = join(root.path, 'fragmented-engine')
    expect(await handleLaneRequest('launch', { lane: 'secretary', project: root.path, prompt: 'Read' })).toMatchObject({ ok: true })
    await until(async () => !(await status()).running)
    expect(await status()).toMatchObject({ status: 'Completed', exitCode: 0 })
    const output = (await status()).output
    expect(output).toContain('Café')
    expect(output).toContain('engine diagnostic')
    expect(output).not.toContain('\uFFFD')
  })
  test("the built-in lane uses the project directory and interrupts the engine with SIGINT", async () => {
    process.env.SECRETARY_ENGINE_PATH = join(root.path, 'engine')
    expect(await handleLaneRequest('launch', { lane: 'secretary', project: root.path, prompt: '--auto', model: 'deepseek/deepseek-flash' })).toMatchObject({ ok: true })
    await until(async () => (await status()).output.includes('ready:'))
    expect((await status()).output).toContain(`ready:${root.path}:${root.path}:--auto`)
    await handleLaneRequest('cancel', undefined)
    await until(async () => !(await status()).running)
    expect(await status()).toMatchObject({ status: 'Cancelled', exitCode: 130 })
    expect((await status()).output).toContain('interrupted')
  })
  test("lists lanes, workers and the configured SSH hosts", async () => {
    delete process.env.SECRETARY_SSH_HOST
    delete process.env.SECRETARY_SSH_FALLBACK_HOST
    const result = await handleLaneRequest("list", undefined)
    expect(result.ok).toBe(true)
    const data = result.ok ? (result.data as { lanes: { id: string }[]; workers: object; hosts: string[] }) : undefined
    expect(data?.lanes.map((lane) => lane.id)).toEqual(["secretary", "rust", "claude", "zcode", "qwen", "orchestra"])
    expect(Object.keys(data?.workers ?? {})).toContain("zen-glm-flash")
    expect(data?.hosts).toEqual(["nezopt", "nezopt-remote"])
    expect(await status()).toMatchObject({ running: false })
  })

  test("rejects malformed requests before any process or SSH connection starts", async () => {
    const project = root.path
    const cases: Array<[string, unknown, unknown, string]> = [
      ["unknown action", "delete", undefined, "unknown_action"],
      ["non-string action", 42, undefined, "unknown_action"],
      ["array input", "launch", [], "invalid_input"],
      ["relative project", "launch", { lane: "claude", project: "src", prompt: "Review" }, "invalid_path"],
      ["traversal", "launch", { lane: "claude", project: `${project}/../x`, prompt: "Review" }, "path_traversal"],
      [
        "missing project",
        "launch",
        { lane: "claude", project: `${project}/missing`, prompt: "Review" },
        "invalid_path",
      ],
      ["blank prompt", "launch", { lane: "claude", project, prompt: "  " }, "invalid_input"],
      ["control characters in a Rust prompt", "launch", { lane: "rust", project, prompt: "Review\u0000" }, "invalid_input"],
      ["unknown lane", "launch", { lane: "codex", project, prompt: "Review" }, "unknown_lane"],
      ["unmounted remote project", "launch", { lane: "qwen", project, prompt: "Review" }, "remote_path_required"],
      [
        "unknown worker",
        "launch",
        { lane: "orchestra", project, prompt: "Review", worker: "big-pickle" },
        "unknown_worker",
      ],
      ["probe without a slot", "probe", { lane: "zcode" }, "unknown_lane"],
    ]
    for (const [name, action, input, code] of cases) {
      const result = await handleLaneRequest(action, input)
      expect({ name, code: result.ok ? undefined : result.code }).toEqual({ name, code })
    }
    process.env.SECRETARY_SSH_HOST = "-oProxyCommand=id"
    expect(await handleLaneRequest("list", undefined)).toMatchObject({ ok: false, code: "invalid_host" })
    expect(await status()).toMatchObject({ running: false })
  })

  test("runs the local lane in the project with the prompt on stdin and redacted output", async () => {
    process.env.SECRETARY_CLAUDE_PATH = join(root.path, "claude")
    const prompt = "--dangerously-skip-permissions\nuse sk-proj-abcdefghijklmnop"
    expect(await handleLaneRequest("launch", { lane: "claude", project: root.path, prompt })).toEqual({
      ok: true,
      data: { started: true },
    })
    await until(async () => (await status()).exitCode !== undefined)

    const done = await status()
    expect(done).toMatchObject({ running: false, status: "Completed", exitCode: 0 })
    expect(done.output).toContain("argv:-p\n--dangerously-skip-permissions\nuse [redacted]")
    expect(done.output).not.toContain("abcdefghijklmnop")
  })

  test("allows one task at a time and cancels the running process group", async () => {
    process.env.SECRETARY_CLAUDE_PATH = join(root.path, "slow")
    expect(await handleLaneRequest("launch", { lane: "claude", project: root.path, prompt: "Wait" })).toMatchObject({
      ok: true,
    })
    expect(await handleLaneRequest("launch", { lane: "claude", project: root.path, prompt: "Again" })).toMatchObject({
      ok: false,
      code: "task_running",
    })
    expect(await handleLaneRequest("cancel", undefined)).toEqual({ ok: true, data: { requested: true } })
    await until(async () => (await status()).exitCode !== undefined)
    expect(await status()).toMatchObject({ running: false, status: "Cancelled" })
  })


  test("the Rust preview lane reports unsupported_provider before anything starts", async () => {
    await setRustEnvironment({ model: "google/gemini-3-pro" })
    expect(await handleLaneRequest("launch", { lane: "rust", project: root.path, prompt: "Review" })).toMatchObject({
      ok: false,
      code: "unsupported_provider",
    })
    expect((await status()).running).toBe(false)
  })

  test("the Rust preview lane reports a missing bundled binary before spawning anything", async () => {
    await setRustEnvironment(openaiRustConfig)
    process.env.SECRETARY_ENGINE_RS_DIR = join(root.path, "missing-binaries")
    expect(await handleLaneRequest("launch", { lane: "rust", project: root.path, prompt: "Review" })).toMatchObject({
      ok: false,
      code: "engine_unavailable",
    })
    expect((await status()).running).toBe(false)
  })

  test("the Rust preview lane runs oc-cli --local ask itself, with the key in its environment and not in argv", async () => {
    await setRustEnvironment(openaiRustConfig)
    expect(await handleLaneRequest("launch", { lane: "rust", project: root.path, prompt: "--review the diff" })).toMatchObject({
      ok: true,
    })
    await until(async () => (await status()).exitCode !== undefined)

    const done = await status()
    expect(done).toMatchObject({ running: false, status: "Completed", exitCode: 0 })
    // A dash-led prompt gets one leading space, so oc-cli can never read it as a flag.
    expect(done.output).toContain(`arg:[--local]\narg:[ask]\narg:[ --review the diff]\narg:[${root.path}]\n`)
    expect(done.output).toContain("base:unset")
    expect(done.output).toContain(`cwd:${root.path}`)
    expect(done.output).toContain(`data:${join(root.path, "engine-rs-data", "lane")}`)
    expect(done.output).toContain("provider:openai openai/gpt-4o-mini")
    expect(done.output).toContain('permissions:[{"action":"*","resource":"*","effect":"allow"}]')
    // Embedded mode calls the provider itself, so the CLI gets the key, never through argv or the lane log.
    expect(done.output).toContain("key:passed")
    expect(done.output).not.toContain(RUST_SECRET)
  })

  test.each([
    { lane: 'claude', setting: 'SECRETARY_CLAUDE_PATH' },
    { lane: 'secretary', setting: 'SECRETARY_ENGINE_PATH' },
  ])("reports a missing $lane CLI as a start failure", async ({ lane, setting }) => {
    process.env[setting] = join(root.path, "not-installed")
    expect(await handleLaneRequest("launch", { lane, project: root.path, prompt: "Review" })).toMatchObject({
      ok: true,
    })
    await until(async () => (await status()).exitCode !== undefined)
    // The close event that follows a spawn error must not replace the failure with a negative errno exit.
    await Bun.sleep(50)
    expect(await status()).toMatchObject({ running: false, status: "Failed to start", exitCode: -1 })
    expect((await status()).output).toContain('not-installed')
  })
})
