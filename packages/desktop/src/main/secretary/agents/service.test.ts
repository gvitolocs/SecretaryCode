import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { AgentsError } from "./client"
import { FakeAgentsTransport } from "./fake"
import { createdEvent, createEngine, createEvents, event, removeStores, store, storeFile, turn, until as wait } from "./fixture"
import { startMirrorService } from "./service"

beforeEach(() => jest.useFakeTimers())

const running: { stop: () => Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((service) => service.stop()))
  jest.clearAllTimers()
  jest.useRealTimers()
  await removeStores()
})

/** Waits for `condition`, running the timers already due, such as a batch posted on the next tick. */
const until = (condition: () => boolean, label?: string) => wait(condition, label, () => jest.advanceTimersByTime(0))

/** Moves the fake clock forward, letting the work each timer starts settle before the next. */
async function advance(ms: number) {
  const end = Date.now() + ms

  while (Date.now() < end) {
    jest.advanceTimersByTime(Math.min(100, end - Date.now()))
    for (let index = 0; index < 5; index++) await turn()
  }
}

async function harness(options: { transport?: FakeAgentsTransport; file?: string; engine?: ReturnType<typeof createEngine> } = {}) {
  const transport = options.transport ?? new FakeAgentsTransport()
  const engine = options.engine ?? createEngine()
  const events = createEvents()
  const agents = await store(options.file)
  const errors: unknown[] = []
  const service = startMirrorService({
    transport,
    store: agents,
    engine: engine.engine,
    events: events.subscribe,
    onError: (error) => errors.push(error),
  })

  running.push(service)
  await until(() => transport.connected === 1, "the stream connection")
  return { transport, engine, events, store: agents, service, errors }
}

/** A mirrored session, so the phone has an agent to send commands to. */
async function session(world: Awaited<ReturnType<typeof harness>>, sessionID = "ses_1") {
  world.events.push(createdEvent(sessionID))
  await until(() => world.store.agent(sessionID) !== undefined, "registration")
  return world.store.agent(sessionID) ?? ""
}

describe("commands", () => {
  test("applies send, steer, stop and permission answers to the session, then acknowledges them", async () => {
    const world = await harness()
    const agentId = await session(world)

    world.transport.command(agentId, { kind: "send", prompt: "Also add a test" }, { id: "cmd_send" })
    world.transport.command(agentId, { kind: "steer", prompt: "Use the existing helper" }, { id: "cmd_steer" })
    world.transport.command(agentId, { kind: "permission_response", requestId: "per_1", response: { behavior: "allow", selectedActionId: "always" } }, { id: "cmd_always" })
    world.transport.command(agentId, { kind: "permission_response", requestId: "per_2", response: { behavior: "allow" } }, { id: "cmd_once" })
    world.transport.command(agentId, { kind: "permission_response", requestId: "per_3", response: { behavior: "deny", message: "Not on main" } }, { id: "cmd_deny" })
    world.transport.command(agentId, { kind: "stop" }, { id: "cmd_stop" })
    await until(() => world.transport.acked.length === 6, "every acknowledgement")

    expect(world.engine.calls).toEqual([
      { kind: "prompt", sessionID: "ses_1", id: expect.stringMatching(/^msg_/), text: "Also add a test", delivery: "queue" },
      { kind: "prompt", sessionID: "ses_1", id: expect.stringMatching(/^msg_/), text: "Use the existing helper", delivery: "steer" },
      { kind: "permission", sessionID: "ses_1", requestID: "per_1", decision: "always" },
      { kind: "permission", sessionID: "ses_1", requestID: "per_2", decision: "once" },
      { kind: "permission", sessionID: "ses_1", requestID: "per_3", decision: "reject", message: "Not on main" },
      { kind: "interrupt", sessionID: "ses_1" },
    ])
    expect(world.transport.acked.map((item) => item.commandId)).toEqual(["cmd_send", "cmd_steer", "cmd_always", "cmd_once", "cmd_deny", "cmd_stop"])
    expect(world.store.commands()).toEqual([])
  })

  test("acknowledges unknown kinds and commands the engine refuses without applying them again", async () => {
    const world = await harness()
    const agentId = await session(world)

    world.transport.command(agentId, { kind: "rewind", to: "msg_1" } as { kind: string }, { id: "cmd_unknown" })
    world.transport.command(agentId, { kind: "send" }, { id: "cmd_malformed" })
    world.engine.failures.push("rejected")
    world.transport.command(agentId, { kind: "stop" }, { id: "cmd_refused" })
    world.transport.command("agent_elsewhere", { kind: "stop" }, { id: "cmd_not_ours" })
    await until(() => world.transport.acked.length === 4, "the acknowledgements")
    await advance(10_000)

    expect(world.engine.calls).toEqual([])
    expect(world.store.commands()).toEqual([])
  })

  test("drops expired commands without applying or acknowledging them", async () => {
    const world = await harness()
    const agentId = await session(world)

    world.transport.command(agentId, { kind: "send", prompt: "stale" }, { id: "cmd_old", createdAt: Date.now() - 24 * 60 * 60 * 1000 - 1 })
    world.transport.command(agentId, { kind: "send", prompt: "fresh" }, { id: "cmd_new" })
    await until(() => world.transport.acked.length === 1, "the fresh command")

    expect(world.engine.calls.map((call) => call.kind === "prompt" && call.text)).toEqual(["fresh"])
    expect(world.transport.acked.map((item) => item.commandId)).toEqual(["cmd_new"])
    expect(world.store.commands()).toEqual([])
  })

  test("retries a command while the engine is unreachable, with the same prompt id", async () => {
    const world = await harness()
    const agentId = await session(world)

    world.engine.failures.push("offline")
    world.transport.command(agentId, { kind: "send", prompt: "retry me" }, { id: "cmd_1" })
    await until(() => world.engine.failures.length === 0, "the failed attempt")
    await turn()
    expect(world.transport.acked).toEqual([])
    const pending = world.store.commands()[0]
    expect(pending?.commandId).toBe("cmd_1")

    await advance(5_000)
    await until(() => world.transport.acked.length === 1, "the retried command")

    expect(world.engine.calls).toEqual([{ kind: "prompt", sessionID: "ses_1", id: pending?.messageId ?? "", text: "retry me", delivery: "queue" }])
  })

  test("keeps a command across a restart, and only acknowledges one the engine already applied", async () => {
    const file = await storeFile()
    const transport = new FakeAgentsTransport()
    const engine = createEngine()
    const first = await harness({ transport, file, engine })
    const agentId = await session(first)

    // The engine applies the stop, but the acknowledgement does not reach Lucina before the Mac quits.
    transport.failures.push(new AgentsError("offline", "Lucina answered 502"))
    transport.command(agentId, { kind: "stop" }, { id: "cmd_1" })
    await until(() => transport.failures.length === 0, "the failed acknowledgement")
    await first.service.stop()
    running.splice(0)
    expect(engine.calls).toEqual([{ kind: "interrupt", sessionID: "ses_1" }])
    expect(transport.acked).toEqual([])

    const second = await harness({ transport, file, engine })
    await until(() => transport.acked.length === 1, "the acknowledgement after restart")

    expect(engine.calls).toEqual([{ kind: "interrupt", sessionID: "ses_1" }])
    expect(second.store.commands()).toEqual([])
  })
})

describe("stream", () => {
  test("reconnects with backoff and Last-Event-ID, and receives what it missed", async () => {
    const world = await harness()
    const agentId = await session(world)
    await until(() => world.store.lastEventId() === world.transport.lastEventId, "the stream position")
    const seen = world.transport.lastEventId

    world.transport.drop()
    await turn()
    world.transport.command(agentId, { kind: "send", prompt: "sent while offline" }, { id: "cmd_offline" })
    expect(world.engine.calls).toEqual([])
    await advance(1_000)
    await until(() => world.transport.acked.length === 1, "the replayed command")

    expect(world.transport.connections).toEqual([undefined, seen])
    expect(world.engine.calls.map((call) => call.kind === "prompt" && call.text)).toEqual(["sent while offline"])
  })

  test("resumes from the stored position after a restart", async () => {
    const file = await storeFile()
    const transport = new FakeAgentsTransport()
    const first = await harness({ transport, file })
    const agentId = await session(first)
    await until(() => transport.events.get(agentId)?.length === 1, "the first post")
    await until(() => first.store.lastEventId() === transport.lastEventId, "the stream position")
    const position = transport.lastEventId
    await first.service.stop()
    running.splice(0)

    await harness({ transport, file })

    expect(transport.connections).toEqual([undefined, position])
  })

  test("refetches agents and pending commands on stream.reset", async () => {
    const transport = new FakeAgentsTransport({ retain: 2 })
    const world = await harness({ transport })
    const agentId = await session(world, "ses_1")
    const lostId = await session(world, "ses_2")
    await until(() => world.store.lastEventId() === transport.lastEventId, "the stream position")

    world.transport.drop()
    await turn()
    // Lucina deleted one agent and queued a command; then enough happened that the replay log no longer reaches back.
    transport.agentsById.delete(lostId)
    transport.command(agentId, { kind: "send", prompt: "after the gap" }, { id: "cmd_gap" })
    transport.command("agent_other", { kind: "stop" }, { id: "cmd_a" })
    transport.command("agent_other", { kind: "stop" }, { id: "cmd_b" })
    await advance(1_000)
    await until(() => transport.acked.some((item) => item.commandId === "cmd_gap"), "the refetched command")

    expect(transport.calls).toEqual({ agents: 1, commands: 1 })
    expect(world.engine.calls).toEqual([{ kind: "prompt", sessionID: "ses_1", id: expect.stringMatching(/^msg_/), text: "after the gap", delivery: "queue" }])
    expect(world.store.agent("ses_2")).toBeUndefined()
    expect(world.store.agent("ses_1")).toBe(agentId)

    // The forgotten session registers again on its next event.
    world.events.push(event("session.idle", { sessionID: "ses_2" }))
    await advance(500)
    await until(() => world.store.agent("ses_2") !== undefined, "the new registration")
    expect(world.store.agent("ses_2")).not.toBe(lostId)
  })
})
