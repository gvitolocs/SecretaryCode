import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectAttachments, readTail, servicePasswords, type LogSources } from "./collect"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "diagnostics-collect-"))
  roots.push(root)

  return root
}

async function file(target: string, contents: string, seconds = 0) {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents)
  await utimes(target, new Date(seconds * 1000), new Date(seconds * 1000))
}

async function sources(root: string): Promise<LogSources> {
  const logs = path.join(root, "logs")

  await file(path.join(logs, "20261027-080000", "main.log"), "[old] previous launch\n", 10)
  await file(path.join(logs, "20261027-090000", "main.log"), "[error] app starting\nAuthorization: Bearer abc123def456\n", 20)
  await file(path.join(logs, "20261027-090000", "renderer.log"), "[error] fatal renderer error\n", 20)
  await file(path.join(root, "engine", "opencode", "log", "opencode.log"), "[error] engine exited 1\n", 20)
  await file(path.join(root, "Crashpad", "pending", "1111.dmp"), "old minidump", 10)
  await file(path.join(root, "Crashpad", "completed", "2222.dmp"), "new minidump", 30)

  return {
    logs,
    engineLogs: [
      path.join(root, "missing", "opencode.log"),
      path.join(root, "engine", "opencode", "log", "opencode.log"),
    ],
    crashpad: path.join(root, "Crashpad"),
  }
}

function text(attachments: Awaited<ReturnType<typeof collectAttachments>>, name: string) {
  return new TextDecoder().decode(attachments.find((attachment) => attachment.name === name)?.data ?? new Uint8Array())
}

describe("log collection", () => {
  test("attaches this launch's logs, the engine log and the newest minidump, scrubbed", async () => {
    const root = await workspace()
    const collected = await collectAttachments(await sources(root), {
      maxBytes: 64 * 1024,
      secrets: [],
      includeCrashDump: true,
    })

    expect(collected.map((attachment) => attachment.name)).toEqual([
      "main.log",
      "renderer.log",
      "opencode.log",
      "crashpad/2222.dmp",
    ])
    // The newest run wins, and the header never leaves the Mac in clear text.
    expect(text(collected, "main.log")).toContain("[error] app starting")
    expect(text(collected, "main.log")).not.toContain("abc123def456")
    expect(text(collected, "main.log")).not.toContain("previous launch")
    expect(text(collected, "opencode.log")).toContain("engine exited 1")
    expect(new TextDecoder().decode(collected.at(-1)!.data)).toBe("new minidump")
  })

  test("an ordinary error does not ship a minidump", async () => {
    const root = await workspace()
    const collected = await collectAttachments(await sources(root), {
      maxBytes: 64 * 1024,
      secrets: [],
      includeCrashDump: false,
    })

    expect(collected.some((attachment) => attachment.name.startsWith("crashpad/"))).toBe(false)
  })

  test("removes an exact service password from the logs it attaches", async () => {
    const root = await workspace()
    const logs = path.join(root, "logs")
    await file(path.join(logs, "20261027-090000", "main.log"), "connect password=hunter2.example\n")

    const collected = await collectAttachments(
      { logs, engineLogs: [], crashpad: path.join(root, "Crashpad") },
      { maxBytes: 1024, secrets: ["hunter2.example"], includeCrashDump: false },
    )

    expect(text(collected, "main.log")).toBe("connect password=[redacted]\n")
  })

  test("a missing log directory is not an error", async () => {
    const root = await workspace()
    const collected = await collectAttachments(
      { logs: path.join(root, "none"), engineLogs: [], crashpad: path.join(root, "none") },
      { maxBytes: 1024, secrets: [], includeCrashDump: true },
    )

    expect(collected).toEqual([])
  })
})

describe("log tails", () => {
  test("reads from the end and starts at a line boundary", async () => {
    const root = await workspace()
    const target = path.join(root, "big.log")
    await writeFile(target, ["first line", "second line", "third line", "fourth line"].join("\n"))

    const tail = await readTail(target, 24)

    expect(tail).toBe("third line\nfourth line")
  })

  test("a file that does not exist reads as empty", async () => {
    expect(await readTail(path.join(tmpdir(), "diagnostics-does-not-exist.log"), 1024)).toBe("")
  })
})

describe("service passwords", () => {
  test("reads the password of every engine service file in the config and state directories", async () => {
    const root = await workspace()
    const config = path.join(root, "engine", "config", "opencode")
    const state = path.join(root, "engine", "state", "opencode")
    await file(path.join(config, "service.json"), JSON.stringify({ port: 49374, password: "first-secret" }))
    await file(path.join(state, "service-local.json"), JSON.stringify({ url: "http://127.0.0.1:4097", password: "second-secret" }))
    await file(path.join(state, "service-broken.json"), "{not json")
    await file(path.join(state, "opencode.json"), JSON.stringify({ password: "not-a-service-file" }))

    expect((await servicePasswords([config, state, path.join(root, "missing")])).toSorted()).toEqual([
      "first-secret",
      "second-secret",
    ])
  })
})
