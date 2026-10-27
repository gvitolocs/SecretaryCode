// Shared by the agents tests: an engine that records what it was asked, engine events by type, and event-loop helpers.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { OpenCodeEvent } from "@opencode/client/promise"
import { EngineRejected, type Engine } from "./engine"
import { openStore } from "./store"

type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: T }>

/** An engine event with the envelope fields the mirror ignores filled in. */
export function event<T extends OpenCodeEvent["type"]>(type: T, data: EventOf<T>["data"]) {
  return { id: `evt_${type}`, created: 0, type, data } as unknown as OpenCodeEvent
}

export function createdEvent(sessionID: string, extra: { title?: string; parentID?: string } = {}) {
  return event("session.created", {
    sessionID,
    projectID: "prj_1",
    location: { directory: "/Users/owner/Projects/app" },
    slug: "app",
    version: "2",
    ...extra,
  } as EventOf<"session.created">["data"])
}

export type EngineCall =
  | { kind: "prompt"; sessionID: string; id: string; text: string; delivery: "steer" | "queue" }
  | { kind: "interrupt"; sessionID: string }
  | { kind: "permission"; sessionID: string; requestID: string; decision: string; message?: string }

/** The engine side of the tests. `failures` makes the next calls throw: "offline" retries, "rejected" is final. */
export function createEngine(sessions: Record<string, { title?: string; directory: string; parentID?: string }> = {}) {
  const calls: EngineCall[] = []
  const lookups: string[] = []
  const failures: ("offline" | "rejected")[] = []
  const fail = () => {
    const failure = failures.shift()

    if (failure === "offline") throw new Error("connect ECONNREFUSED 127.0.0.1:4096")
    if (failure === "rejected") throw new EngineRejected("Session not found")
  }
  const engine: Engine = {
    async session(sessionID) {
      lookups.push(sessionID)
      return sessions[sessionID]
    },
    async prompt(sessionID, input) {
      fail()
      calls.push({ kind: "prompt", sessionID, ...input })
    },
    async interrupt(sessionID) {
      fail()
      calls.push({ kind: "interrupt", sessionID })
    },
    async replyPermission(sessionID, requestID, decision, message) {
      fail()
      calls.push({ kind: "permission", sessionID, requestID, decision, ...(message ? { message } : {}) })
    },
  }

  return { engine, calls, lookups, failures }
}

/** An engine event stream the test pushes into, as `client.event.subscribe` would deliver it. */
export function createEvents() {
  const listeners = new Set<(event: OpenCodeEvent) => void>()

  return {
    push: (event: OpenCodeEvent) => listeners.forEach((listener) => listener(event)),
    subscribe: (signal: AbortSignal): AsyncIterable<OpenCodeEvent> => ({
      async *[Symbol.asyncIterator]() {
        const queue: OpenCodeEvent[] = []
        const wake = { resolve: undefined as (() => void) | undefined }
        const listener = (event: OpenCodeEvent) => {
          queue.push(event)
          wake.resolve?.()
        }

        listeners.add(listener)
        signal.addEventListener("abort", () => wake.resolve?.(), { once: true })
        try {
          while (!signal.aborted) {
            const next = queue.shift()

            if (next) yield next
            else await new Promise<void>((resolve) => (wake.resolve = resolve))
          }
        } finally {
          listeners.delete(listener)
        }
      },
    }),
  }
}

const roots: string[] = []

export async function storeFile() {
  const directory = await mkdtemp(path.join(tmpdir(), "agents-mirror-"))

  roots.push(directory)
  return path.join(directory, "secretary-agents.json")
}

export async function removeStores() {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

export const store = async (file?: string) => openStore(file ?? (await storeFile()))

// Fake timers leave setImmediate real: one turn drains pending microtasks and lets finished file I/O resolve.
export const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Turns of the real event loop until `condition` holds; a real-time deadline, since Date is faked. `tick` runs
 * before each turn, for the fake timers that are already due.
 */
export async function until(condition: () => boolean, label = "condition", tick?: () => void) {
  const deadline = process.hrtime.bigint() + 5_000_000_000n

  while (!condition()) {
    if (process.hrtime.bigint() > deadline) throw new Error(`Timed out waiting for ${label}`)
    tick?.()
    await turn()
  }
}
