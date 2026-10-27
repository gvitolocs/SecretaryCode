import type {
  AgentCommand,
  AgentListItem,
  AgentSnapshot,
  RegisterAgent,
  StreamEvent,
  StreamFrame,
  StreamMessage,
} from "./wire"

/** Everything the mirror needs from secretary-server `/v1/agents/*`; the HTTP client and the fake both implement it. */
export interface AgentsTransport {
  register(input: RegisterAgent): Promise<AgentSnapshot>
  rename(agentId: string, title: string): Promise<void>
  postEvents(agentId: string, events: readonly StreamEvent[]): Promise<void>
  ack(agentId: string, commandId: string): Promise<void>
  /** The agents this device can see; after a `stream.reset` the mirror checks its own against it. */
  agents(): Promise<AgentListItem[]>
  /** Commands queued for this device and not yet acknowledged. */
  commands(): Promise<AgentCommand[]>
  /** One stream connection. It ends (or throws) when the connection drops; {@link runStream} reconnects. */
  connect(lastEventId: string | undefined, signal: AbortSignal): AsyncIterable<StreamMessage>
}

export type AgentsErrorCode = "signInRequired" | "offline" | "notFound" | "rejected"

export class AgentsError extends Error {
  constructor(
    readonly code: AgentsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "AgentsError"
  }

  /** Worth another attempt later: a lost connection, a timeout, a server-side failure or a missing sign-in. */
  get retryable() {
    return this.code === "offline" || this.code === "signInRequired"
  }
}

const TIMEOUT_MS = 30_000

/** A stream with no frame or keepalive for this long is treated as dropped. */
const STREAM_IDLE_MS = 90_000

/** Bounds one SSE event so a broken server cannot grow the buffer without limit. */
const MAX_SSE_EVENT_BYTES = 1024 * 1024

export type HttpAgentsOptions = {
  baseURL: string
  /** The Secretary device token, read from the main process on every request; undefined while signed out. */
  token: () => Promise<string | undefined>
  fetch?: typeof globalThis.fetch
}

/** secretary-server `/v1/agents/*`, authenticated as this Mac with its device token. */
export function createHttpTransport(options: HttpAgentsOptions): AgentsTransport {
  const send = options.fetch ?? globalThis.fetch

  const request = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}) => {
    const token = await options.token()

    if (!token) throw new AgentsError("signInRequired", "Sign in to Lucina to mirror coding sessions")
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const response = await send(new URL(path, options.baseURL), {
      method: init.method ?? "GET",
      redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Secretary-Client": "web",
        Accept: "application/json",
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }).catch((error: unknown) => {
      throw new AgentsError("offline", error instanceof Error ? error.message : "Network error")
    })

    if (response.ok) return response
    await response.body?.cancel().catch(() => undefined)
    throw statusError(response.status)
  }

  const json = async (path: string, init?: Parameters<typeof request>[1]) => (await request(path, init)).json() as Promise<unknown>

  return {
    register: async (input) => (await json("/v1/agents", { method: "POST", body: input })) as AgentSnapshot,
    rename: async (agentId, title) => {
      await request(`/v1/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: { title } })
    },
    postEvents: async (agentId, events) => {
      await request(`/v1/agents/${encodeURIComponent(agentId)}/events`, { method: "POST", body: { events } })
    },
    ack: async (agentId, commandId) => {
      await request(`/v1/agents/${encodeURIComponent(agentId)}/commands/${encodeURIComponent(commandId)}/ack`, {
        method: "POST",
      })
    },
    agents: async () => list(await json("/v1/agents")) as AgentListItem[],
    commands: async () => list(await json("/v1/agents/commands")) as AgentCommand[],
    connect: (lastEventId, signal) => ({
      async *[Symbol.asyncIterator]() {
        const token = await options.token()

        if (!token) throw new AgentsError("signInRequired", "Sign in to Lucina to mirror coding sessions")
        const response = await send(new URL("/v1/agents/stream", options.baseURL), {
          redirect: "error",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Secretary-Client": "web",
            Accept: "text/event-stream",
            ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          },
        }).catch((error: unknown) => {
          throw new AgentsError("offline", error instanceof Error ? error.message : "Network error")
        })

        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined)
          throw statusError(response.status)
        }
        yield* parseSse(response.body, signal)
      },
    }),
  }
}

/** Server-Sent Events into stream messages: `id:` and `data:` lines, with `event: stream.reset` as a reset. */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<StreamMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const idle = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const touch = () => {
    clearTimeout(idle.timer)
    idle.timer = setTimeout(() => void reader.cancel().catch(() => undefined), STREAM_IDLE_MS)
  }
  const buffer = { text: "" }

  try {
    touch()
    while (!signal.aborted) {
      const next = await reader.read()

      if (next.done) return
      touch()
      buffer.text = (buffer.text + decoder.decode(next.value, { stream: true })).replaceAll("\r\n", "\n")
      const blocks = buffer.text.split("\n\n")
      buffer.text = blocks.pop() ?? ""
      if (buffer.text.length > MAX_SSE_EVENT_BYTES) throw new AgentsError("rejected", "An agents stream event is too large")
      for (const message of blocks.flatMap(sseMessage)) yield message
    }
  } finally {
    clearTimeout(idle.timer)
    await reader.cancel().catch(() => undefined)
  }
}

function sseMessage(block: string): StreamMessage[] {
  const fields = block.split("\n").flatMap((line) => {
    if (!line || line.startsWith(":")) return []
    const colon = line.indexOf(":")

    if (colon === -1) return [{ name: line, value: "" }]
    return [{ name: line.slice(0, colon), value: line.slice(colon + 1).replace(/^ /, "") }]
  })
  const id = fields.findLast((field) => field.name === "id")?.value || undefined
  const event = fields.findLast((field) => field.name === "event")?.value
  const data = fields.filter((field) => field.name === "data").map((field) => field.value).join("\n")

  if (event === "stream.reset") return [{ id, frame: { type: "stream.reset" } }]
  if (!data) return []
  const frame = parseFrame(data)

  return frame ? [{ id, frame }] : []
}

/** One frame from the wire. A frame without a known `type` is skipped rather than failing the stream. */
function parseFrame(data: string): StreamFrame | undefined {
  const value = ((): unknown => {
    try {
      return JSON.parse(data)
    } catch {
      return undefined
    }
  })()

  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const type = (value as { type?: unknown }).type

  if (type === "stream.reset") return { type }
  if (type === "agent_command") {
    const command = value as Partial<AgentCommand>

    if (typeof command.commandId !== "string" || typeof command.agentId !== "string") return undefined
    if (!command.command || typeof command.command !== "object" || typeof command.command.kind !== "string") return undefined
    if (typeof command.createdAt !== "string") return undefined
    return value as AgentCommand
  }
  if (type === "agent_stream" || type === "agent_state" || type === "agent_deleted") {
    if (typeof (value as { agentId?: unknown }).agentId !== "string") return undefined
    return value as StreamFrame
  }

  return undefined
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  // Paseo-style list endpoints wrap their rows; either shape is accepted.
  const wrapped = value && typeof value === "object" ? Object.values(value).find(Array.isArray) : undefined

  return wrapped ?? []
}

function statusError(status: number) {
  if (status === 401 || status === 403) return new AgentsError("signInRequired", `Lucina answered ${status}`)
  if (status === 404 || status === 410) return new AgentsError("notFound", `Lucina answered ${status}`)
  if (status === 408 || status === 429 || status >= 500) return new AgentsError("offline", `Lucina answered ${status}`)

  return new AgentsError("rejected", `Lucina answered ${status}`)
}

const BACKOFF_MS = { initial: 1_000, max: 60_000 }

export type StreamOptions = {
  transport: AgentsTransport
  signal: AbortSignal
  /** The last `id:` seen, kept by the caller so it survives a restart. */
  lastEventId: () => string | undefined
  onEventId: (id: string) => void
  onFrame: (frame: Exclude<StreamFrame, { type: "stream.reset" }>) => Promise<void> | void
  /** The server could not replay what was missed; the caller refetches the state it keeps. */
  onReset: () => Promise<void>
  onError?: (error: unknown) => void
}

/**
 * Keeps one stream open until `signal` aborts: reconnects with exponential backoff, resumes from the last
 * event id, and hands `stream.reset` to {@link StreamOptions.onReset} before continuing.
 */
export async function runStream(options: StreamOptions) {
  const state = { attempt: 0 }

  while (!options.signal.aborted) {
    try {
      for await (const message of options.transport.connect(options.lastEventId(), options.signal)) {
        if (options.signal.aborted) return
        state.attempt = 0
        if (message.frame.type === "stream.reset") await options.onReset()
        else await options.onFrame(message.frame)
        // The id is committed only after the frame is handled, so a crash replays it rather than losing it.
        if (message.id) options.onEventId(message.id)
      }
    } catch (error) {
      if (options.signal.aborted) return
      options.onError?.(error)
      // A missing sign-in will not fix itself within seconds.
      if (error instanceof AgentsError && error.code === "signInRequired") state.attempt = Math.max(state.attempt, 8)
    }
    if (options.signal.aborted) return
    const delay = Math.min(BACKOFF_MS.max, BACKOFF_MS.initial * 2 ** state.attempt)

    state.attempt++
    // Jitter keeps a fleet of sleeping Macs from reconnecting in lockstep after an outage.
    await sleep(delay / 2 + Math.random() * (delay / 2), options.signal)
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)

    signal.addEventListener("abort", done, { once: true })
  })
}
