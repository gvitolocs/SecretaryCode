import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Attachment } from "./collect"
import { UploadError } from "./client"
import { createOutbox } from "./outbox"
import type { DiagnosticReport } from "./report"
import { Diagnostics } from "./service"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function harness(
  options: { automatic?: boolean; token?: string | null; fail?: string | Error; secrets?: string[] } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "diagnostics-service-"))
  roots.push(directory)
  const outbox = createOutbox(directory)
  const sent: { message: string; attachments: number }[] = []
  const reports: DiagnosticReport[] = []
  const collected: (readonly string[])[] = []
  let token = options.token === null ? undefined : (options.token ?? "sec_device_token")
  let failure: string | Error | undefined = options.fail

  const diagnostics = new Diagnostics({
    appVersion: "2.1.4",
    os: "darwin 15.1 arm64",
    device: "MacBook 1a2b3c4d",
    baseURL: "https://lucina.test",
    automatic: options.automatic ?? true,
    outbox,
    token: async () => token,
    secrets: async () => options.secrets ?? [],
    collect: async (includeCrashDump, secrets): Promise<Attachment[]> => {
      collected.push(secrets)

      return [{ name: "main.log", data: new TextEncoder().encode(`minidump=${includeCrashDump}`) }]
    },
    send: async (report, attachments) => {
      if (failure) throw typeof failure === "string" ? new Error(failure) : failure
      reports.push(report)
      sent.push({ message: report.message, attachments: attachments.length })

      return { id: `srv_${sent.length}` }
    },
  })

  return {
    diagnostics,
    outbox,
    sent,
    reports,
    collected,
    signIn(next: string | undefined) {
      token = next
    },
    fail(message: string | Error | undefined) {
      failure = message
    },
  }
}

/** Skips the backoff: every queued report becomes due now. */
async function due(outbox: ReturnType<typeof createOutbox>) {
  const past = new Date(Date.now() - 1_000).toISOString()

  for (const entry of await outbox.entries()) await outbox.attach({ ...entry, next_attempt_at: past }, [])
}

describe("diagnostics service", () => {
  test("sends a capture at once and names the report Lucina created", async () => {
    const run = await harness()

    const result = await run.diagnostics.capture({ kind: "error", message: "The engine failed to start" })

    expect(result).toMatchObject({ sent: true, serverId: "srv_1", duplicate: false })
    expect(run.sent).toEqual([{ message: "The engine failed to start", attachments: 1 }])
    expect(await run.outbox.entries()).toHaveLength(0)
  })

  test("keeps a report on disk while signed out and sends it after the next sign-in", async () => {
    const run = await harness({ token: null })

    const result = await run.diagnostics.capture({ kind: "error", message: "Renderer process gone: crashed" })

    expect(result).toMatchObject({ sent: false, serverId: null })
    expect(await run.outbox.entries()).toHaveLength(1)
    expect(run.sent).toHaveLength(0)

    run.signIn("sec_device_token")
    await run.diagnostics.flush()

    expect(run.sent).toHaveLength(1)
    expect(await run.outbox.entries()).toHaveLength(0)
  })

  test("the same failure twice in one session is one report", async () => {
    const run = await harness()
    const input = { kind: "hang" as const, message: "The main process was unresponsive", context: { blockedMs: 6000 } }

    const first = await run.diagnostics.capture(input)
    const second = await run.diagnostics.capture(input)

    expect(second).toMatchObject({ id: first!.id, duplicate: true, sent: true })
    expect(run.sent).toHaveLength(1)
  })

  test("automatic reporting can be off while an explicit send still works", async () => {
    const run = await harness({ automatic: false })

    expect(await run.diagnostics.capture({ kind: "error", message: "quiet failure" })).toBeUndefined()
    await run.diagnostics.flush()
    expect(await run.outbox.entries()).toHaveLength(0)

    const result = await run.diagnostics.capture({ kind: "user_report", message: "I pressed the button", userInitiated: true })

    expect(result).toMatchObject({ sent: true })
    expect(run.sent).toHaveLength(1)
  })

  test("a failed send stays queued with backoff instead of retrying on every tick", async () => {
    const run = await harness({ fail: "offline: connection refused" })

    const result = await run.diagnostics.capture({ kind: "crash", message: "boom" })
    const [queued] = await run.outbox.entries()

    expect(result).toMatchObject({ sent: false })
    expect(queued.attempts).toBe(1)
    expect(Date.parse(queued.next_attempt_at)).toBeGreaterThan(Date.now())
    expect(queued.last_error).toContain("offline")

    await run.diagnostics.flush()
    expect(await run.outbox.entries()).toHaveLength(1)
    expect(run.sent).toHaveLength(0)
  })

  test("a crash report is written before the logs exist and enriched before it is sent", async () => {
    const run = await harness()

    const entry = run.diagnostics.captureSync({ kind: "crash", message: "Renderer process gone: crashed", includeCrashDump: true })

    expect(entry).toBeDefined()
    const [queued] = await run.outbox.entries()
    expect(queued.attachments).toHaveLength(0)

    await run.diagnostics.enrich(entry!.id, true)

    expect(run.sent).toEqual([{ message: "Renderer process gone: crashed", attachments: 1 }])
    expect(await run.outbox.entries()).toHaveLength(0)
  })

  test("scrubs the report itself and hands the service password to the log collector", async () => {
    const run = await harness({ secrets: ["local-service-pass"] })

    await run.diagnostics.capture({
      kind: "error",
      message: "connect failed with Authorization: Bearer sec_abcdefgh12345678",
      stack: "Error: password=local-service-pass\n    at connect (engine.ts:1:1)",
      context: { url: "http://opencode:local-service-pass@127.0.0.1:4096", headers: { authorization: "Basic dXNlcjpwYXNz1" } },
    })

    const [report] = run.reports
    const body = JSON.stringify(report)

    expect(body).not.toContain("local-service-pass")
    expect(body).not.toContain("sec_abcdefgh12345678")
    expect(body).not.toContain("dXNlcjpwYXNz1")
    expect(report.message).toContain("[redacted]")
    expect(run.collected).toEqual([["local-service-pass"]])
  })

  test("Send to Lucina is a user report that keeps the original kind and the owner's note", async () => {
    const run = await harness()
    const input = { kind: "fatal_error" as const, message: "Timed out waiting for the background service to start" }

    const automatic = await run.diagnostics.capture(input)
    const explicit = await run.diagnostics.capture({ ...input, userInitiated: true, context: { note: "after update" } })

    expect(explicit).toMatchObject({ duplicate: false, sent: true })
    expect(explicit!.id).not.toBe(automatic!.id)
    expect(run.reports.map((report) => report.kind)).toEqual(["fatal_error", "user_report"])
    expect(run.reports[1].context).toEqual({ note: "after update", kind: "fatal_error" })
  })

  test("with automatic reporting off, the owner's own report is still retried", async () => {
    const run = await harness({ automatic: false, fail: new UploadError("offline", "no network") })

    const result = await run.diagnostics.capture({ kind: "fatal_error", message: "boom", userInitiated: true })
    expect(result).toMatchObject({ sent: false })

    await due(run.outbox)
    run.fail(undefined)
    await run.diagnostics.flush()

    expect(run.sent).toHaveLength(1)
    expect(await run.outbox.entries()).toHaveLength(0)
  })

  test("a report Lucina keeps rejecting is dropped after a few attempts", async () => {
    const run = await harness({ fail: new UploadError("rejected", "Lucina answered 422") })

    await run.diagnostics.capture({ kind: "error", message: "malformed" })
    for (let attempt = 1; attempt < 5; attempt++) {
      const [queued] = await run.outbox.entries()
      expect(queued.attempts).toBe(attempt)
      await due(run.outbox)
      await run.diagnostics.flush()
    }

    expect(await run.outbox.entries()).toHaveLength(0)
  })
})
