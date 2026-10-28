import { afterEach, describe, expect, test } from "bun:test"
import { AgentsError, createHttpTransport, logOnce } from "./client"
import type { StreamMessage } from "./wire"

type Seen = { method: string; path: string; authorization: string | null; lastEventId: string | null; body: unknown }

const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
})

/** secretary-server's `/v1/agents/*` on a loopback port, answering from `routes` and recording every request. */
function serve(routes: Record<string, (request: Request) => Response>) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "GET" ? "" : await request.text()

      seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        lastEventId: request.headers.get("last-event-id"),
        body: text ? JSON.parse(text) : undefined,
      })
      const route = routes[`${request.method} ${url.pathname}`]

      return route ? route(request) : new Response("missing", { status: 404 })
    },
  })

  servers.push(server)
  return { seen, baseURL: `http://127.0.0.1:${server.port}` }
}

const json = (value: unknown, status = 200) => Response.json(value, { status })

// JSON shapes from lucina-agentd's tests (`crates/lucina-agentd/tests/external.rs`, `lucina-agents/src/external.rs`).
const snapshot = {
  id: "agent_1",
  provider: "secretary-code",
  cwd: "/Users/giuseppe/Projects/x",
  title: "Mac session",
  status: "idle",
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
  pendingPermissions: [],
  external: true,
  ownerDeviceId: "dev_mac",
  host: "mac",
}
const command = {
  commandId: "cmd_1",
  agentId: "agent_1",
  command: { kind: "permission_response", requestId: "r1", response: { behavior: "deny", message: "no" } },
  createdAt: "2026-10-28T00:00:00.000Z",
  expiresAt: "2026-10-29T00:00:00.000Z",
}

describe("HTTP transport", () => {
  test("calls the daemon's routes with the device token and reads its answers", async () => {
    const server = serve({
      "POST /v1/agents": () => json(snapshot),
      "POST /v1/agents/agent_1/events": () => json({ agentId: "agent_1", applied: 1 }),
      "POST /v1/agents/agent_1/commands/cmd_1/ack": () => json({ agentId: "agent_1", commandId: "cmd_1", acked: true }),
      "PATCH /v1/agents/agent_1": () => json({ ...snapshot, title: "Login fix" }),
      "GET /v1/agents/items": () => json({ agents: [{ ...snapshot, shortId: "agent_1", bucket: "active" }] }),
      "GET /v1/agents/commands": () => json({ commands: [command] }),
    })
    const transport = createHttpTransport({ baseURL: server.baseURL, token: async () => "sec_device" })

    const agent = await transport.register({
      provider: "secretary-code",
      external: true,
      host: "mac",
      cwd: "/Users/giuseppe/Projects/x",
      title: "Mac session",
      idempotencyKey: "secretary-code:ses_1",
    })
    await transport.postEvents("agent_1", [{ type: "turn_started", provider: "secretary-code", turnId: "t1" }])
    await transport.ack("agent_1", "cmd_1")
    await transport.rename("agent_1", "Login fix")

    expect(agent).toEqual(snapshot)
    expect((await transport.agents()).map((item) => item.id)).toEqual(["agent_1"])
    expect(await transport.commands()).toEqual([command])
    expect(server.seen.map((item) => `${item.method} ${item.path}`)).toEqual([
      "POST /v1/agents",
      "POST /v1/agents/agent_1/events",
      "POST /v1/agents/agent_1/commands/cmd_1/ack",
      "PATCH /v1/agents/agent_1",
      "GET /v1/agents/items",
      "GET /v1/agents/commands",
    ])
    expect(server.seen.every((item) => item.authorization === "Bearer sec_device")).toBe(true)
    // The owner is the calling device and an external agent takes no prompt: neither is in the body.
    expect(server.seen[0].body).toEqual({
      provider: "secretary-code",
      external: true,
      host: "mac",
      cwd: "/Users/giuseppe/Projects/x",
      title: "Mac session",
      idempotencyKey: "secretary-code:ses_1",
    })
    expect(server.seen[1].body).toEqual({ events: [{ type: "turn_started", provider: "secretary-code", turnId: "t1" }] })
    expect(server.seen[2].body).toBeUndefined()
    expect(server.seen[3].body).toEqual({ title: "Login fix" })
  })

  test("maps answers to retryable and final errors, and sends nothing while signed out", async () => {
    const error = (status: number, code: string) => () => json({ error: { code, message: code } }, status)
    const server = serve({
      "POST /v1/agents/a401/events": () => new Response(null, { status: 401 }),
      "POST /v1/agents/a403/events": error(403, "NOT_OWNER"),
      "POST /v1/agents/a503/events": () => new Response(null, { status: 503 }),
      "POST /v1/agents/a400/events": error(400, "INVALID_REQUEST"),
      "POST /v1/agents/a410/events": error(410, "COMMAND_EXPIRED"),
      "POST /v1/agents/a429/events": error(429, "rate_limited"),
    })
    const transport = createHttpTransport({ baseURL: server.baseURL, token: async () => "sec_device" })
    const code = (agentId: string) =>
      transport.postEvents(agentId, []).then(
        () => "ok",
        (error: unknown) => (error instanceof AgentsError ? `${error.code}:${error.retryable}:${error.message}` : "other"),
      )

    expect(await Promise.all(["a401", "a403", "a503", "a400", "a410", "a429", "a404"].map(code))).toEqual([
      "signInRequired:true:Lucina answered 401",
      // The daemon refusing this device is not fixed by signing in again.
      "rejected:false:Lucina answered 403 (NOT_OWNER)",
      "offline:true:Lucina answered 503",
      "rejected:false:Lucina answered 400 (INVALID_REQUEST)",
      "notFound:false:Lucina answered 410 (COMMAND_EXPIRED)",
      "offline:true:Lucina answered 429 (rate_limited)",
      "notFound:false:Lucina answered 404",
    ])
    const signedOut = createHttpTransport({ baseURL: server.baseURL, token: async () => undefined })
    const before = server.seen.length
    await expect(signedOut.ack("a", "c")).rejects.toMatchObject({ code: "signInRequired" })
    expect(server.seen.length).toBe(before)
  })

  test("reads the stream from Last-Event-ID: frames, ids, resets and keepalives", async () => {
    const body = [
      ": keepalive\r\n\r\n",
      // A waiting command re-sent on connect carries no id.
      `data: ${JSON.stringify({ type: "agent_command", ...command })}\n\n`,
      'id: 41\r\ndata: {"type":"agent_stream","agentId":"agent_1","event":{"type":"turn_started","provider":"secretary-code"},"seq":3,"epoch":"e1","timestamp":"t"}\r\n\r\n',
      `id: 42\ndata: ${JSON.stringify({ type: "agent_state", agent: snapshot })}\n\n`,
      'id: 43\ndata: {"type":"permission","permission":{"id":"ext_1"}}\n\n',
      "id: 44\ndata: not json\n\n",
      `id: 45\ndata: ${JSON.stringify({ type: "agent_command", ...command, commandId: "cmd_2" })}\n\n`,
      // Without expiresAt it is not a command the daemon sends.
      'id: 46\ndata: {"type":"agent_command","commandId":"cmd_3","agentId":"agent_1","command":{"kind":"stop"},"createdAt":"t"}\n\n',
      'id: 47\nevent: stream.reset\ndata: {"type":"stream.reset"}\n\n',
      'id: 48\ndata: {"type":"agent_deleted","agentId":"agent_2"}\n\n',
    ]
    const server = serve({
      "GET /v1/agents/stream": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // Split mid-frame, as the network does.
              const text = body.join("")
              controller.enqueue(new TextEncoder().encode(text.slice(0, 50)))
              controller.enqueue(new TextEncoder().encode(text.slice(50)))
              controller.close()
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    })
    const transport = createHttpTransport({ baseURL: server.baseURL, token: async () => "sec_device" })
    const messages: StreamMessage[] = []

    for await (const message of transport.connect("40", new AbortController().signal)) messages.push(message)

    expect(server.seen[0]).toMatchObject({ path: "/v1/agents/stream", lastEventId: "40", authorization: "Bearer sec_device" })
    expect(messages).toEqual([
      { frame: { type: "stream.open" } },
      { id: undefined, frame: { type: "agent_command", ...command } },
      {
        id: "41",
        frame: {
          type: "agent_stream",
          agentId: "agent_1",
          event: { type: "turn_started", provider: "secretary-code" },
          seq: 3,
          epoch: "e1",
          timestamp: "t",
        },
      },
      { id: "42", frame: { type: "agent_state", agent: snapshot } },
      // Frames the mirror does not read still move the stream position.
      { id: "43" },
      { id: "44" },
      { id: "45", frame: { type: "agent_command", ...command, commandId: "cmd_2" } },
      { id: "46" },
      { id: "47", frame: { type: "stream.reset" } },
      { id: "48", frame: { type: "agent_deleted", agentId: "agent_2" } },
    ])
  })

  test("logs each distinct failure once", () => {
    const lines: string[] = []
    const log = logOnce((message) => lines.push(message))

    ;[503, 503, 503, 400, 503].forEach((status) => log(new AgentsError("offline", `Lucina answered ${status}`)))

    expect(lines).toEqual(["Lucina answered 503", "Lucina answered 400"])
  })
})
