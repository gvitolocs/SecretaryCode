import { afterEach, describe, expect, test } from "bun:test"
import { AgentsError, createHttpTransport } from "./client"
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

describe("HTTP transport", () => {
  test("authenticates every request with the device token", async () => {
    const server = serve({
      "POST /v1/agents": () => json({ id: "agent_1", provider: "secretary-code", cwd: "/p", status: "idle", createdAt: "", updatedAt: "" }),
      "POST /v1/agents/agent_1/events": () => new Response(null, { status: 204 }),
      "POST /v1/agents/agent_1/commands/cmd_1/ack": () => new Response(null, { status: 204 }),
      "PATCH /v1/agents/agent_1": () => json({}),
      "GET /v1/agents": () => json({ agents: [{ id: "agent_1" }] }),
      "GET /v1/agents/commands": () => json([{ type: "agent_command", commandId: "cmd_1" }]),
    })
    const transport = createHttpTransport({ baseURL: server.baseURL, token: async () => "sec_device" })

    const agent = await transport.register({ provider: "secretary-code", external: true, host: "mac", cwd: "/p", idempotencyKey: "secretary-code:ses_1" })
    await transport.postEvents("agent_1", [{ type: "turn_started", provider: "secretary-code" }])
    await transport.ack("agent_1", "cmd_1")
    await transport.rename("agent_1", "Login fix")

    expect(agent.id).toBe("agent_1")
    expect((await transport.agents()).map((item) => item.id)).toEqual(["agent_1"])
    expect((await transport.commands()).map((item) => item.commandId)).toEqual(["cmd_1"])
    expect(server.seen.map((item) => `${item.method} ${item.path}`)).toEqual([
      "POST /v1/agents",
      "POST /v1/agents/agent_1/events",
      "POST /v1/agents/agent_1/commands/cmd_1/ack",
      "PATCH /v1/agents/agent_1",
      "GET /v1/agents",
      "GET /v1/agents/commands",
    ])
    expect(server.seen.every((item) => item.authorization === "Bearer sec_device")).toBe(true)
    expect(server.seen[0].body).toEqual({ provider: "secretary-code", external: true, host: "mac", cwd: "/p", idempotencyKey: "secretary-code:ses_1" })
    expect(server.seen[1].body).toEqual({ events: [{ type: "turn_started", provider: "secretary-code" }] })
  })

  test("maps answers to retryable and final errors, and sends nothing while signed out", async () => {
    const server = serve({
      "POST /v1/agents/a401/events": () => new Response(null, { status: 401 }),
      "POST /v1/agents/a503/events": () => new Response(null, { status: 503 }),
      "POST /v1/agents/a400/events": () => new Response(null, { status: 400 }),
    })
    const transport = createHttpTransport({ baseURL: server.baseURL, token: async () => "sec_device" })
    const code = (agentId: string) =>
      transport.postEvents(agentId, []).then(
        () => "ok",
        (error: unknown) => (error instanceof AgentsError ? `${error.code}:${error.retryable}` : "other"),
      )

    expect(await Promise.all(["a401", "a503", "a400", "a404"].map(code))).toEqual([
      "signInRequired:true",
      "offline:true",
      "rejected:false",
      "notFound:false",
    ])
    const signedOut = createHttpTransport({ baseURL: server.baseURL, token: async () => undefined })
    const before = server.seen.length
    await expect(signedOut.ack("a", "c")).rejects.toMatchObject({ code: "signInRequired" })
    expect(server.seen.length).toBe(before)
  })

  test("reads the stream from Last-Event-ID: frames, ids, resets and keepalives", async () => {
    const body = [
      ": keepalive\r\n\r\n",
      'id: 41\r\ndata: {"type":"agent_stream","agentId":"agent_1","event":{"type":"turn_started"},"seq":3,"epoch":"e1","timestamp":"t"}\r\n\r\n',
      "id: 42\ndata: not json\n\n",
      'id: 43\ndata: {"type":"agent_command","commandId":"cmd_1","agentId":"agent_1","command":{"kind":"stop"},"createdAt":"2026-10-27T10:00:00.000Z"}\n\n',
      'id: 44\ndata: {"type":"agent_command","commandId":"cmd_2"}\n\n',
      "id: 45\nevent: stream.reset\ndata: {}\n\n",
      'id: 46\ndata: {"type":"agent_deleted","agentId":"agent_2"}\n\n',
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
      {
        id: "41",
        frame: { type: "agent_stream", agentId: "agent_1", event: { type: "turn_started" }, seq: 3, epoch: "e1", timestamp: "t" },
      },
      {
        id: "43",
        frame: { type: "agent_command", commandId: "cmd_1", agentId: "agent_1", command: { kind: "stop" }, createdAt: "2026-10-27T10:00:00.000Z" },
      },
      { id: "45", frame: { type: "stream.reset" } },
      { id: "46", frame: { type: "agent_deleted", agentId: "agent_2" } },
    ])
  })
})
