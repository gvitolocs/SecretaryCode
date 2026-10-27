import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { REMOTE_SUPERVISOR, engineOutput, redactLaneOutput, supervisedSSH } from "./lane-process"

test("engine output displays replies, tool results and errors while a partial JSON record waits", () => {
  const lines = [
    { type: 'step_start', sessionID: 'private-protocol-id' },
    { type: 'tool_use', part: { tool: 'read', state: { status: 'completed', title: 'read', output: 'contract contents' } } },
    { type: 'text', part: { text: 'The verification code is correct.' } },
    { type: 'error', error: { message: 'Provider unavailable' } },
  ].map(value => JSON.stringify(value)).join('\n')
  const expected = 'read\ncontract contents\nThe verification code is correct.\nProvider unavailable'
  expect(engineOutput(lines + '\n{"type":"text",')).toBe(expected)
  expect(engineOutput(lines + '\n{"type":"text","part":{"text":"More"}}')).toBe(expected + '\nMore')
})

test("redacts credentials from combined streaming output and keeps useful errors", () => {
  const value = 'Free usage limit reached\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\napi_key="a-very-private-key"\nsec_abcdefghijklmnop\nmcp_abcdefghijklmnop\nsk-proj-abcdefghijklmnop\neyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImFiYyJ9.abcdefghijklmnop'
  const safe = redactLaneOutput(value)
  expect(safe).toContain("Free usage limit reached")
  for (const secret of ["abcdefghijklmnopqrstuvwxyz", "a-very-private-key", "sec_abcdefghijklmnop", "mcp_abcdefghijklmnop", "sk-proj-abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9"]) expect(safe).not.toContain(secret)
})

test("SSH supervisor uses batch connection and one safely quoted Python command", () => {
  const plan = supervisedSSH("nezopt-remote")
  expect(plan.executable).toBe("/usr/bin/ssh")
  expect(plan.args.slice(-3, -1)).toEqual(["--", "nezopt-remote"])
  expect(plan.args).toContain("BatchMode=yes")
  expect(plan.args.at(-1)).toContain("'/usr/bin/python3' '-u' '-c'")
})

function supervise(command: string[]) {
  const child = spawn("/usr/bin/python3", ["-u", "-c", REMOTE_SUPERVISOR], { stdio: ["pipe", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", data => { output += data.toString() })
  child.stderr.on("data", data => { output += data.toString() })
  child.stdin.write(JSON.stringify({ cwd: "/tmp", command }) + "\n")
  return { child, output: () => output, closed: new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject) }) }
}

test("supervisor runs argv literally and cleans up on normal completion", async () => {
  const run = supervise(["/usr/bin/python3", "-c", "import sys; print(sys.argv[1])", "literal $(id); ' quoted"])
  expect(await run.closed).toBe(0)
  run.child.stdin.destroy()
  expect(run.output()).toContain("literal $(id); ' quoted")
})

test("disconnect cancels the real remote child process group", async () => {
  const run = supervise(["/usr/bin/python3", "-u", "-c", "import time; print('started',flush=True); time.sleep(30)"])
  const deadline = Date.now() + 5000
  while (!run.output().includes("started") && Date.now() < deadline) await Bun.sleep(20)
  expect(run.output()).toContain("started")
  run.child.stdin.end()
  expect(await run.closed).not.toBe(0)
}, 10000)
