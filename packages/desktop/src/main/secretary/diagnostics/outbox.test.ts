import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAX_ENTRIES, createOutbox, retryDelay } from "./outbox"
import { createReport } from "./report"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root() {
  const directory = await mkdtemp(path.join(tmpdir(), "diagnostics-outbox-"))
  roots.push(directory)

  return directory
}

function report(message = "The engine failed to start") {
  return createReport({ kind: "error", message, appVersion: "2.1.4", os: "darwin", device: "Mac 1234abcd" })
}

const attachment = { name: "main.log", data: new TextEncoder().encode("[info] app starting\n[error] boom\n") }

describe("diagnostics outbox", () => {
  test("a report written before the network call survives a restart and is due at once", async () => {
    const directory = await root()
    const queued = await createOutbox(directory).enqueue(report(), [attachment])
    const reopened = createOutbox(directory)
    const [due] = await reopened.due()

    expect(due.id).toBe(queued.id)
    expect(due.report.message).toBe("The engine failed to start")
    expect(await reopened.load(due)).toEqual({
      entry: due,
      attachments: [{ name: "main.log", data: attachment.data }],
    })
  })

  test("a failed attempt backs off instead of retrying on the next tick", async () => {
    const directory = await root()
    const outbox = createOutbox(directory)
    const queued = await outbox.enqueue(report(), [])
    const at = new Date("2026-10-27T08:00:00.000Z")
    const failed = await outbox.fail(queued.id, "offline: connection refused", at)

    expect(failed).toMatchObject({ attempts: 1, last_error: "offline: connection refused" })
    expect(failed?.next_attempt_at).toBe(new Date(at.getTime() + retryDelay(1)).toISOString())
    expect(await outbox.due(at)).toHaveLength(0)
    expect(await outbox.due(new Date(at.getTime() + retryDelay(1)))).toHaveLength(1)
    // The delay grows with each failure and stops at the cap instead of overflowing.
    expect(retryDelay(2)).toBeGreaterThan(retryDelay(1))
    expect(retryDelay(99)).toBe(retryDelay(5))
  })

  test("a delivered report leaves no local copy", async () => {
    const directory = await root()
    const outbox = createOutbox(directory)
    const queued = await outbox.enqueue(report(), [attachment])

    await outbox.complete(queued.id)

    expect(await outbox.has(queued.id)).toBe(false)
    expect(await outbox.entries()).toHaveLength(0)
  })

  test("the outbox keeps a bounded number of reports", async () => {
    const directory = await root()
    const outbox = createOutbox(directory)

    for (let index = 0; index < MAX_ENTRIES + 3; index++) await outbox.enqueue(report(`failure ${index}`), [])

    const entries = await outbox.entries()
    expect(entries).toHaveLength(MAX_ENTRIES)
    expect(entries.some((entry) => entry.report.message === `failure ${MAX_ENTRIES + 2}`)).toBe(true)
  })

  test("a report written by a crashing process is readable by the next launch", async () => {
    const directory = await root()
    const queued = createOutbox(directory).enqueueSync(report("Renderer process gone: crashed"), [attachment])
    const [due] = await createOutbox(directory).due()

    expect(due.id).toBe(queued.id)
    expect(due.report.message).toBe("Renderer process gone: crashed")
    expect((await createOutbox(directory).load(due)).attachments[0]).toEqual(attachment)
  })
})
