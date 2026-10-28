import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { AgentsError } from "./client"
import { FakeAgentsTransport } from "./fake"
import { createdEvent, createEngine, event, removeStores, store, storeFile, turn, until } from "./fixture"
import { MAX_ITEM_BYTES, Mirror, batches } from "./mirror"
import type { StreamEvent, TimelineItem } from "./wire"

beforeEach(() => jest.useFakeTimers())

afterEach(async () => {
  jest.clearAllTimers()
  jest.useRealTimers()
  await removeStores()
})

const provider = "secretary-code"

async function harness(options: { file?: string; transport?: FakeAgentsTransport; sessions?: Parameters<typeof createEngine>[0] } = {}) {
  const transport = options.transport ?? new FakeAgentsTransport()
  const engine = createEngine(options.sessions)
  const agents = await store(options.file)
  const mirror = new Mirror({ transport, store: agents, engine: engine.engine })

  return { transport, engine, store: agents, mirror, sent: (agentId = "agent_1") => transport.events.get(agentId) ?? [] }
}

const timeline = (sent: StreamEvent[]) =>
  sent.flatMap((item) => (item.type === "timeline" ? [item.item] : []))

describe("event mapping", () => {
  test("maps a session's run to Lucina's stream events", async () => {
    const { mirror, sent, transport } = await harness()

    ;[
      createdEvent("ses_1", { title: "Fix login" }),
      event("session.execution.started", { sessionID: "ses_1" }),
      event("session.inbox.enqueued", {
        sessionID: "ses_1",
        inboxID: "msg_user",
        item: { type: "user", payload: { text: "Fix the login bug" }, delivery: "steer" },
      }),
      event("session.text.started", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0 }),
      event("session.text.delta", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: "Looking " }),
      event("session.text.delta", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: "at it." }),
      event("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, text: "Looking at it." }),
      event("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", name: "shell" }),
      event("session.tool.called", {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        id: "call_1",
        input: { command: "bun test", workdir: "/Users/owner/Projects/app" },
        executed: true,
      }),
      event("session.tool.success", {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        id: "call_1",
        content: [{ type: "text", text: "12 pass\n0 fail" }],
        executed: true,
      }),
      event("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_2", name: "edit" }),
      event("session.tool.called", {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        id: "call_2",
        input: { path: "src/login.ts", oldString: "a", newString: "b" },
        executed: true,
      }),
      event("session.tool.failed", {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        id: "call_2",
        error: { type: "tool", message: "oldString not found" },
        executed: true,
      }),
      event("permission.asked", {
        id: "per_1",
        sessionID: "ses_1",
        action: "shell",
        resources: ["git push"],
        message: "Run git push?",
        metadata: { diff: "secret diff body" },
      }),
      event("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "always" }),
      event("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_3", name: "todowrite" }),
      event("session.tool.called", {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        id: "call_3",
        input: {
          todos: [
            { content: "Reproduce", status: "completed" },
            { content: "Fix", status: "in_progress" },
            { content: "Old idea", status: "cancelled" },
          ],
        },
        executed: true,
      }),
      event("session.execution.succeeded", { sessionID: "ses_1" }),
      event("session.idle", { sessionID: "ses_1" }),
      // Not part of the agent's timeline.
      event("session.viewed", { sessionID: "ses_1" } as never),
    ].forEach((item) => mirror.handle(item))
    await mirror.flush()

    expect(transport.registrations).toEqual([
      {
        provider,
        external: true,
        host: "mac",
        title: "Fix login",
        cwd: "/Users/owner/Projects/app",
        idempotencyKey: "secretary-code:ses_1",
      },
    ])
    expect(sent()).toEqual([
      { type: "thread_started", sessionId: "ses_1", provider },
      { type: "turn_started", provider },
      { type: "timeline", provider, item: { type: "user_message", text: "Fix the login bug", messageId: "msg_user" } },
      { type: "timeline", provider, item: { type: "assistant_message", text: "Looking at it.", messageId: "msg_a:0" } },
      {
        type: "timeline",
        provider,
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          detail: { type: "shell", command: "bun test", cwd: "/Users/owner/Projects/app" },
          status: "running",
          error: null,
        },
      },
      {
        type: "timeline",
        provider,
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          detail: { type: "shell", command: "bun test", cwd: "/Users/owner/Projects/app" },
          status: "completed",
          error: null,
        },
      },
      {
        type: "timeline",
        provider,
        item: { type: "tool_call", callId: "call_2", name: "edit", detail: { type: "edit", filePath: "src/login.ts" }, status: "running", error: null },
      },
      {
        type: "timeline",
        provider,
        item: {
          type: "tool_call",
          callId: "call_2",
          name: "edit",
          detail: { type: "edit", filePath: "src/login.ts" },
          status: "failed",
          error: "oldString not found",
        },
      },
      {
        type: "permission_requested",
        provider,
        request: {
          id: "per_1",
          provider,
          name: "shell",
          kind: "tool",
          title: "Run git push?",
          description: "git push",
          actions: [
            { id: "once", label: "Allow once", behavior: "allow", variant: "primary" },
            { id: "always", label: "Always allow", behavior: "allow", variant: "secondary" },
            { id: "reject", label: "Deny", behavior: "deny", variant: "danger" },
          ],
        },
      },
      { type: "permission_resolved", provider, requestId: "per_1", resolution: { behavior: "allow", selectedActionId: "always" } },
      {
        type: "timeline",
        provider,
        item: {
          type: "todo",
          items: [
            { text: "Reproduce", completed: true, status: "completed" },
            { text: "Fix", completed: false, status: "in_progress" },
            { text: "Old idea", completed: false, status: null },
          ],
        },
      },
      // Succeeded and idle close the same turn once.
      { type: "turn_completed", provider },
    ])
  })

  test("maps failed and interrupted runs, and a denied permission", async () => {
    const { mirror, sent } = await harness()

    ;[
      createdEvent("ses_1"),
      event("session.execution.started", { sessionID: "ses_1" }),
      event("session.execution.failed", {
        sessionID: "ses_1",
        error: { type: "provider_auth", message: "Invalid key sk-ant-abcdefghijklmnopqrstuvwxyz" },
      }),
      event("session.idle", { sessionID: "ses_1" }),
      event("session.execution.started", { sessionID: "ses_1" }),
      event("permission.asked", { id: "per_2", sessionID: "ses_1", action: "edit", resources: ["src/a.ts"] }),
      event("permission.replied", { sessionID: "ses_1", requestID: "per_2", reply: "reject" }),
      event("session.execution.interrupted", { sessionID: "ses_1", reason: "user" }),
    ].forEach((item) => mirror.handle(item))
    await mirror.flush()

    expect(sent().filter((item) => item.type !== "permission_requested")).toEqual([
      { type: "thread_started", sessionId: "ses_1", provider },
      { type: "turn_started", provider },
      { type: "turn_failed", provider, error: "Invalid key [redacted]", code: "provider_auth" },
      { type: "turn_started", provider },
      { type: "permission_resolved", provider, requestId: "per_2", resolution: { behavior: "deny", selectedActionId: "reject" } },
      { type: "turn_canceled", provider, reason: "user" },
    ])
    expect(sent().find((item) => item.type === "permission_requested")).toMatchObject({
      request: { id: "per_2", title: "Allow edit?", description: "src/a.ts" },
    })
  })

  test("completes text that streamed no deltas from its end event", async () => {
    const { mirror, sent } = await harness()

    mirror.handle(createdEvent("ses_1"))
    mirror.handle(event("session.text.delta", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: "Done" }))
    await mirror.flush()
    mirror.handle(event("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, text: "Done, all green." }))
    mirror.handle(event("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_b", ordinal: 1, text: "Second part" }))
    await mirror.flush()

    // Lucina concatenates adjacent chunks of one message.
    expect(timeline(sent())).toEqual([
      { type: "assistant_message", text: "Done", messageId: "msg_a:0" },
      { type: "assistant_message", text: ", all green.", messageId: "msg_a:0" },
      { type: "assistant_message", text: "Second part", messageId: "msg_b:1" },
    ])
  })
})

describe("batching", () => {
  test("posts at most once per 500 ms per agent and coalesces text in between", async () => {
    const { mirror, transport, sent } = await harness()
    const delta = (text: string) =>
      event("session.text.delta", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, delta: text })

    mirror.handle(createdEvent("ses_1"))
    jest.advanceTimersByTime(0)
    await until(() => transport.posts.length === 1, "the first post")

    for (const word of ["one ", "two ", "three ", "four"]) {
      jest.advanceTimersByTime(100)
      await turn()
      mirror.handle(delta(word))
    }
    expect(transport.posts).toHaveLength(1)
    jest.advanceTimersByTime(99)
    await turn()
    expect(transport.posts).toHaveLength(1)
    jest.advanceTimersByTime(1)
    await until(() => transport.posts.length === 2, "the second post")

    expect(transport.posts[1].at - transport.posts[0].at).toBeGreaterThanOrEqual(500)
    expect(transport.posts[1].events).toEqual([
      { type: "timeline", provider, item: { type: "assistant_message", text: "one two three four", messageId: "msg_a:0" } },
    ])
    expect(sent()).toHaveLength(2)
  })

  test("batches each agent on its own schedule", async () => {
    const { mirror, transport } = await harness()

    mirror.handle(createdEvent("ses_1"))
    mirror.handle(createdEvent("ses_2"))
    jest.advanceTimersByTime(0)
    await until(() => transport.posts.length === 2, "one post per agent")

    expect(transport.posts.map((post) => post.agentId).toSorted()).toEqual(["agent_1", "agent_2"])
  })

  test("keeps events while Lucina is unreachable and sends them with the next post", async () => {
    const { mirror, transport, sent } = await harness()

    mirror.handle(createdEvent("ses_1"))
    jest.advanceTimersByTime(0)
    await until(() => transport.posts.length === 1, "registration")
    transport.failures.push(new AgentsError("offline", "Lucina answered 503"))
    mirror.handle(event("session.execution.started", { sessionID: "ses_1" }))
    jest.advanceTimersByTime(500)
    await until(() => transport.failures.length === 0, "the failed post")
    mirror.handle(event("session.idle", { sessionID: "ses_1" }))
    jest.advanceTimersByTime(1_000)
    await until(() => transport.posts.length === 2, "the retried post")

    expect(sent().map((item) => item.type)).toEqual(["thread_started", "turn_started", "turn_completed"])
  })

  /** A session with `count` user messages queued behind its `thread_started`, nothing posted yet. */
  function backlog(mirror: Mirror, count: number) {
    mirror.handle(createdEvent("ses_1"))
    Array.from({ length: count }, (_, index) =>
      mirror.handle(
        event("session.inbox.enqueued", {
          sessionID: "ses_1",
          inboxID: `msg_${index}`,
          item: { type: "user", payload: { text: `message ${index}` }, delivery: "steer" },
        }),
      ),
    )
  }

  test("splits a backlog into posts of at most 200 events, in order", async () => {
    const { mirror, transport, sent } = await harness()

    backlog(mirror, 449)
    await mirror.flush()

    expect(transport.posts.map((post) => post.events.length)).toEqual([200, 200, 50])
    expect(sent()[0].type).toBe("thread_started")
    expect(timeline(sent()).map((item) => item.type === "user_message" && item.messageId)).toEqual(
      Array.from({ length: 449 }, (_, index) => `msg_${index}`),
    )
  })

  test("a failed post keeps itself and the posts behind it for the retry", async () => {
    const { mirror, transport, sent } = await harness()
    const post = transport.postEvents.bind(transport)
    const calls = { count: 0 }

    // The first post lands; the second meets a 503.
    transport.postEvents = async (agentId, events) => {
      calls.count++
      if (calls.count === 2) throw new AgentsError("offline", "Lucina answered 503")
      return post(agentId, events)
    }
    backlog(mirror, 449)
    await mirror.flush()
    expect(transport.posts.map((item) => item.events.length)).toEqual([200])

    jest.advanceTimersByTime(1_000)
    await until(() => transport.posts.length === 3, "the retried posts")

    expect(transport.posts.map((item) => item.events.length)).toEqual([200, 200, 50])
    expect(timeline(sent()).map((item) => item.type === "user_message" && item.messageId)).toEqual(
      Array.from({ length: 449 }, (_, index) => `msg_${index}`),
    )
  })

  test("never posts attention_required, which the daemon derives itself", () => {
    const events: StreamEvent[] = [
      { type: "turn_started", provider, turnId: "t1" },
      { type: "attention_required", provider, reason: "finished", timestamp: "2026-10-28T00:00:00.000Z", shouldNotify: true },
      { type: "usage_updated", provider, usage: { inputTokens: 10 } },
      { type: "turn_completed", provider, turnId: "t1" },
    ]

    expect(batches(events)).toEqual([[events[0], events[2], events[3]]])
    expect(batches([])).toEqual([])
  })
})

describe("redaction and size caps", () => {
  test("sends tool summaries, never file contents or tool output", async () => {
    const { mirror, sent } = await harness()
    const secret = "const password = 'hunter2-file-body'"
    const tool = (id: string, name: string, input: Record<string, unknown>) => [
      event("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_a", id, name }),
      event("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_a", id, input, executed: true }),
      event("session.tool.success", {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        id,
        content: [{ type: "text", text: secret }],
        metadata: { output: secret },
        executed: true,
      }),
    ]

    ;[
      createdEvent("ses_1"),
      ...tool("call_w", "write", { path: "src/config.ts", content: secret }),
      ...tool("call_e", "edit", { path: "src/config.ts", oldString: secret, newString: secret }),
      ...tool("call_r", "read", { path: "src/config.ts", offset: 10, limit: 20 }),
      ...tool("call_p", "patch", { patchText: `*** Begin Patch\n*** Update File: src/a.ts\n+${secret}\n*** Add File: src/b.ts\n+${secret}\n*** End Patch` }),
      ...tool("call_s", "shell", { command: "curl -H 'Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwx' https://api.test" }),
      ...tool("call_g", "grep", { pattern: "TODO", path: "src" }),
      ...tool("call_f", "webfetch", { url: "https://example.com/docs", format: "markdown" }),
      ...tool("call_a", "subagent", { agent: "explore", description: "Find the auth code", prompt: secret }),
      ...tool("call_m", "mcp_notes_save", { title: "Plan", body: secret, pinned: true }),
    ].forEach((item) => mirror.handle(item))
    await mirror.flush()

    const wire = JSON.stringify(sent())
    expect(wire).not.toContain("hunter2")
    expect(wire).not.toContain("sk-proj-")
    const details = Object.fromEntries(
      timeline(sent()).flatMap((item) => (item.type === "tool_call" && item.status === "completed" ? [[item.name, item.detail]] : [])),
    )
    expect(details).toEqual({
      write: { type: "write", filePath: "src/config.ts" },
      edit: { type: "edit", filePath: "src/config.ts" },
      read: { type: "read", filePath: "src/config.ts", offset: 10, limit: 20 },
      patch: { type: "plain_text", label: "patch", text: "update src/a.ts\nadd src/b.ts" },
      shell: { type: "shell", command: "curl -H 'Authorization: [redacted]" },
      grep: { type: "search", query: "TODO in src", toolName: "grep" },
      webfetch: { type: "fetch", url: "https://example.com/docs" },
      subagent: { type: "sub_agent", subAgentType: "explore", description: "Find the auth code", log: "" },
      mcp_notes_save: { type: "plain_text", label: "mcp_notes_save", text: "title: Plan\npinned: true" },
    })
  })

  test("keeps every item within 2 KB and splits long text into chunks Lucina joins", async () => {
    const { mirror, sent } = await harness()
    const long = "é".repeat(3_000) + "🙂".repeat(1_000) + "x".repeat(4_000)

    ;[
      createdEvent("ses_1"),
      event("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0, text: long }),
      event("session.inbox.enqueued", {
        sessionID: "ses_1",
        inboxID: "msg_user",
        item: { type: "user", payload: { text: "pasted ".repeat(2_000) }, delivery: "steer" },
      }),
      event("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", name: "shell" }),
      event("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", input: { command: "echo " + "a".repeat(10_000) }, executed: true }),
      event("permission.asked", { id: "per_1", sessionID: "ses_1", action: "read", resources: Array.from({ length: 50 }, (_, index) => `/very/long/path/${"d".repeat(200)}/${index}`) }),
      event("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_2", name: "todowrite" }),
      event("session.tool.called", {
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        id: "call_2",
        input: { todos: Array.from({ length: 40 }, () => ({ content: "t".repeat(500), status: "pending" })) },
        executed: true,
      }),
    ].forEach((item) => mirror.handle(item))
    await mirror.flush()

    const items: unknown[] = sent().flatMap((item) =>
      item.type === "timeline" ? [item.item] : item.type === "permission_requested" ? [item.request] : [],
    )
    items.forEach((item) => expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(MAX_ITEM_BYTES))
    const chunks = timeline(sent()).filter((item): item is Extract<TimelineItem, { type: "assistant_message" }> => item.type === "assistant_message")
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(long)
    const user = timeline(sent()).find((item) => item.type === "user_message")
    expect(user?.type === "user_message" && user.text.endsWith("…")).toBe(true)
  })

  test("does not mirror subagent sessions", async () => {
    const { mirror, transport } = await harness({ sessions: { ses_child: { directory: "/p", parentID: "ses_1" } } })

    mirror.handle(createdEvent("ses_sub", { parentID: "ses_1" }))
    mirror.handle(event("session.execution.started", { sessionID: "ses_sub" }))
    // A child whose creation the mirror did not see is looked up before it is registered.
    mirror.handle(event("session.execution.started", { sessionID: "ses_child" }))
    await mirror.flush()

    expect(transport.registrations).toEqual([])
    expect(transport.posts).toEqual([])
  })
})

describe("registration", () => {
  test("registers each session once and keeps the mapping across restarts", async () => {
    const file = await storeFile()
    const transport = new FakeAgentsTransport()
    const first = await harness({ file, transport })

    first.mirror.handle(createdEvent("ses_1", { title: "First" }))
    first.mirror.handle(event("session.execution.started", { sessionID: "ses_1" }))
    // Two posts racing for the same new session still register it once.
    await Promise.all([first.mirror.flush(), first.mirror.flush()])
    await first.mirror.stop()
    expect(transport.registrations).toHaveLength(1)
    expect(first.store.agent("ses_1")).toBe("agent_1")

    const second = await harness({ file, transport })
    second.mirror.handle(event("session.idle", { sessionID: "ses_1" }))
    await second.mirror.flush()

    expect(transport.registrations).toHaveLength(1)
    expect(second.engine.lookups).toEqual([])
    expect(second.sent().map((item) => item.type)).toEqual(["thread_started", "turn_started", "turn_completed"])
  })

  test("a lost mapping registers again and gets the same agent from Lucina", async () => {
    const transport = new FakeAgentsTransport()
    const first = await harness({ transport })

    first.mirror.handle(createdEvent("ses_1"))
    await first.mirror.flush()

    const second = await harness({ transport, sessions: { ses_1: { title: "Recovered", directory: "/Users/owner/Projects/app" } } })
    second.mirror.handle(event("session.idle", { sessionID: "ses_1" }))
    await second.mirror.flush()

    expect(transport.registrations.map((item) => item.idempotencyKey)).toEqual(["secretary-code:ses_1", "secretary-code:ses_1"])
    expect(transport.registrations[1]).toMatchObject({ title: "Recovered", cwd: "/Users/owner/Projects/app" })
    expect(second.store.agent("ses_1")).toBe("agent_1")
    expect(transport.agentsById.size).toBe(1)
  })

  test("registers as an external Mac agent with the session's folder and title, and no prompt", async () => {
    const { mirror, transport } = await harness()

    mirror.handle(createdEvent("ses_1", { title: "Fix the\nlogin   bug" }))
    mirror.handle(
      event("session.inbox.enqueued", {
        sessionID: "ses_1",
        inboxID: "msg_user",
        item: { type: "user", payload: { text: "Fix the login bug" }, delivery: "steer" },
      }),
    )
    await mirror.flush()

    expect(transport.registrations).toEqual([
      {
        provider: "secretary-code",
        external: true,
        host: "mac",
        title: "Fix the login bug",
        cwd: "/Users/owner/Projects/app",
        idempotencyKey: "secretary-code:ses_1",
      },
    ])
    expect(transport.agentsById.get("agent_1")).toMatchObject({ external: true, ownerDeviceId: "dev_mac", host: "mac" })
    // The first prompt arrives as an event, after registration.
    expect(timeline(transport.events.get("agent_1") ?? [])).toEqual([{ type: "user_message", text: "Fix the login bug", messageId: "msg_user" }])
  })

  test("renames the agent when the session is renamed, as one line of at most 200 characters", async () => {
    const { mirror, transport } = await harness()

    mirror.handle(createdEvent("ses_1"))
    await mirror.flush()
    mirror.handle(event("session.renamed", { sessionID: "ses_1", title: "Login fix" }))
    await mirror.flush()
    expect(transport.agentsById.get("agent_1")?.title).toBe("Login fix")

    mirror.handle(event("session.renamed", { sessionID: "ses_1", title: `Login\r\nfix ${"x".repeat(300)}` }))
    await mirror.flush()
    const title = transport.agentsById.get("agent_1")?.title ?? ""
    expect(Array.from(title)).toHaveLength(200)
    expect(title.startsWith("Login fix xxx")).toBe(true)

    // The daemon refuses an empty title; the agent keeps its last one.
    mirror.handle(event("session.renamed", { sessionID: "ses_1", title: " \n " }))
    await mirror.flush()
    expect(transport.agentsById.get("agent_1")?.title).toBe(title)
  })

  test("registers again when Lucina no longer knows the agent", async () => {
    const { mirror, transport, store: agents } = await harness()

    mirror.handle(createdEvent("ses_1"))
    await mirror.flush()
    transport.agentsById.clear()
    mirror.handle(event("session.idle", { sessionID: "ses_1" }))
    await mirror.flush()
    expect(agents.agent("ses_1")).toBeUndefined()
    jest.advanceTimersByTime(1_000)
    await until(() => agents.agent("ses_1") === "agent_2", "the new registration")
    await until(() => (transport.events.get("agent_2")?.length ?? 0) > 0, "the requeued events")

    expect(transport.events.get("agent_2")).toEqual([{ type: "turn_completed", provider }])
  })
})
