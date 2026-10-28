import { AgentsError, type AgentsTransport } from "./client"
import {
  MAX_EVENTS_PER_POST,
  MAX_TITLE_CHARS,
  postable,
  type AgentCommand,
  type AgentCommandBody,
  type AgentListItem,
  type AgentSnapshot,
  type RegisterAgent,
  type StreamEvent,
  type StreamFrame,
  type StreamMessage,
} from "./wire"

type Connection = { push: (message: StreamMessage | undefined) => void }

/** The device id secretary-server derives from this Mac's token; the daemon makes it the agent's owner. */
export const FAKE_DEVICE_ID = "dev_mac"

const COMMAND_TTL_MS = 24 * 60 * 60 * 1000

/**
 * An in-memory secretary-server for `/v1/agents/*`: the tests drive it, and `SECRETARY_AGENTS_FAKE=1` runs the
 * mirror against it without a server. It keeps lucina-agentd's rules (`manager/external_agents.rs`, `api.rs`):
 * idempotent registration without a prompt, at most {@link MAX_EVENTS_PER_POST} postable events per post, one-line
 * titles, a bounded replay log with `stream.reset` past it, waiting commands re-sent to a stream opened without
 * `Last-Event-ID`, and commands kept until acknowledged or expired.
 */
export class FakeAgentsTransport implements AgentsTransport {
  readonly agentsById = new Map<string, AgentSnapshot & { idempotencyKey: string }>()
  readonly events = new Map<string, StreamEvent[]>()
  /** Every `postEvents` call, in order, with the time it arrived. */
  readonly posts: { agentId: string; events: StreamEvent[]; at: number }[] = []
  readonly registrations: RegisterAgent[] = []
  readonly acked: { agentId: string; commandId: string }[] = []
  /** The `Last-Event-ID` of every connection, in order. */
  readonly connections: (string | undefined)[] = []
  readonly calls = { agents: 0, commands: 0 }
  /** The next calls fail with this error, one per entry. */
  readonly failures: AgentsError[] = []

  private readonly log: { id: number; frame: StreamFrame }[] = []
  private readonly pending = new Map<string, AgentCommand>()
  private readonly expired = new Map<string, AgentCommand>()
  private readonly open = new Set<Connection>()
  private nextEventId = 1
  private nextAgent = 1

  constructor(
    private readonly options: {
      /** Replay window; a client further behind gets `stream.reset`. */
      retain?: number
    } = {},
  ) {}

  private fail() {
    const failure = this.failures.shift()

    if (failure) throw failure
  }

  async register(input: RegisterAgent) {
    this.fail()
    this.registrations.push(input)
    // `check_external`: the provider, external, the host, a one-line cwd, and no prompt.
    const body = input as RegisterAgent & { prompt?: string }
    if (body.provider !== "secretary-code" || body.external !== true || body.host !== "mac")
      throw new AgentsError("rejected", "Lucina answered 400 (INVALID_REQUEST)")
    if (!body.cwd.trim() || /[\u0000-\u001f]/.test(body.cwd) || body.prompt?.trim())
      throw new AgentsError("rejected", "Lucina answered 400 (INVALID_REQUEST)")
    const existing = [...this.agentsById.values()].find((agent) => agent.idempotencyKey === input.idempotencyKey)

    if (existing) return existing
    const at = new Date(Date.now()).toISOString()
    const agent = {
      id: `agent_${this.nextAgent++}`,
      provider: input.provider,
      cwd: input.cwd.trim(),
      title: input.title?.trim() || null,
      status: "idle" as const,
      createdAt: at,
      updatedAt: at,
      pendingPermissions: [],
      external: true,
      ownerDeviceId: FAKE_DEVICE_ID,
      host: "mac",
      idempotencyKey: input.idempotencyKey,
    }

    this.agentsById.set(agent.id, agent)
    this.publish({ type: "agent_state", agent })
    return agent
  }

  async rename(agentId: string, title: string) {
    this.fail()
    const agent = this.agentsById.get(agentId)

    if (!agent) throw new AgentsError("notFound", "Lucina answered 404 (AGENT_NOT_FOUND)")
    const trimmed = title.trim()
    if (!trimmed || Array.from(trimmed).length > MAX_TITLE_CHARS || /[\r\n]/.test(trimmed))
      throw new AgentsError("rejected", "Lucina answered 400 (INVALID_REQUEST)")
    agent.title = trimmed
    this.publish({ type: "agent_state", agent })
  }

  async postEvents(agentId: string, events: readonly StreamEvent[]) {
    this.fail()
    if (!this.agentsById.has(agentId)) throw new AgentsError("notFound", "Lucina answered 404 (AGENT_NOT_FOUND)")
    if (events.length > MAX_EVENTS_PER_POST || !events.every(postable))
      throw new AgentsError("rejected", "Lucina answered 400 (INVALID_REQUEST)")
    this.posts.push({ agentId, events: [...events], at: Date.now() })
    this.events.set(agentId, [...(this.events.get(agentId) ?? []), ...events])
    events.forEach((event) =>
      this.publish({ type: "agent_stream", agentId, event, epoch: "epoch_1", timestamp: new Date(Date.now()).toISOString() }),
    )
  }

  async ack(agentId: string, commandId: string) {
    this.fail()
    if (this.expired.has(commandId)) throw new AgentsError("notFound", "Lucina answered 410 (COMMAND_EXPIRED)")
    const command = this.pending.get(commandId)
    // Acknowledging twice is fine; an id the daemon never issued for this agent is not.
    const known = command ? command.agentId === agentId : this.acked.some((item) => item.commandId === commandId)

    if (!known) throw new AgentsError("notFound", "Lucina answered 404 (COMMAND_NOT_FOUND)")
    this.acked.push({ agentId, commandId })
    this.pending.delete(commandId)
  }

  async agents(): Promise<AgentListItem[]> {
    this.fail()
    this.calls.agents++
    return [...this.agentsById.values()].map((agent) => ({
      id: agent.id,
      shortId: agent.id.slice(0, 7),
      provider: agent.provider,
      status: agent.status,
      cwd: agent.cwd,
      title: agent.title,
      external: agent.external,
      ownerDeviceId: agent.ownerDeviceId,
    }))
  }

  async commands(): Promise<AgentCommand[]> {
    this.fail()
    this.calls.commands++
    this.expire()
    return [...this.pending.values()]
  }

  connect(lastEventId: string | undefined, signal: AbortSignal): AsyncIterable<StreamMessage> {
    this.connections.push(lastEventId)
    const queue: (StreamMessage | undefined)[] = []
    const waiting: ((message: StreamMessage | undefined) => void)[] = []
    const connection: Connection = {
      push: (message) => {
        const next = waiting.shift()

        if (next) next(message)
        else queue.push(message)
      },
    }
    const failure = this.failures.shift()
    const after = lastEventId === undefined ? undefined : Number(lastEventId)
    const oldest = this.log[0]?.id

    if (!failure) {
      connection.push({ frame: { type: "stream.open" } })
      // Replay what this client missed, or tell it to refetch when the log no longer reaches back that far. A client
      // with no position gets the commands waiting for it, without ids.
      this.expire()
      if (after !== undefined && oldest !== undefined && after < oldest - 1)
        connection.push({ id: String(this.nextEventId - 1), frame: { type: "stream.reset" } })
      else if (after !== undefined)
        this.log.filter((entry) => entry.id > after).forEach((entry) => connection.push({ id: String(entry.id), frame: entry.frame }))
      else this.pending.forEach((command) => connection.push({ frame: { type: "agent_command", ...command } }))
      this.open.add(connection)
    }
    signal.addEventListener("abort", () => connection.push(undefined), { once: true })

    const open = this.open
    return {
      async *[Symbol.asyncIterator]() {
        if (failure) throw failure
        try {
          while (!signal.aborted) {
            const message = queue.length ? queue.shift() : await new Promise<StreamMessage | undefined>((resolve) => waiting.push(resolve))

            if (!message) return
            yield message
          }
        } finally {
          open.delete(connection)
        }
      },
    }
  }

  /** The owner's phone sends a command; it is stored until acknowledged or expired and delivered on the stream. */
  command(agentId: string, command: AgentCommandBody | { kind: string }, options: { createdAt?: number; id?: string } = {}) {
    const createdAt = options.createdAt ?? Date.now()
    const queued: AgentCommand = {
      commandId: options.id ?? `cmd_${this.nextEventId}`,
      agentId,
      command,
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(createdAt + COMMAND_TTL_MS).toISOString(),
    }

    this.pending.set(queued.commandId, queued)
    this.publish({ type: "agent_command", ...queued })
    return queued
  }

  /** A command the phone sent while nothing was listening: queued, but never published on the stream. */
  queue(command: AgentCommand) {
    this.pending.set(command.commandId, command)
  }

  /** `expire_commands`: overdue commands are no longer offered, and their ack answers 410. */
  private expire() {
    this.pending.forEach((command, id) => {
      if (Date.parse(command.expiresAt) > Date.now()) return
      this.pending.delete(id)
      this.expired.set(id, command)
    })
  }

  /** Every open stream connection drops, as when the network goes away. */
  drop() {
    this.open.forEach((connection) => connection.push(undefined))
    this.open.clear()
  }

  /** Frames published while no client is connected; the replay log keeps them for the next `Last-Event-ID`. */
  get lastEventId() {
    return String(this.nextEventId - 1)
  }

  get connected() {
    return this.open.size
  }

  private publish(frame: StreamFrame) {
    const entry = { id: this.nextEventId++, frame }

    this.log.push(entry)
    this.log.splice(0, Math.max(0, this.log.length - (this.options.retain ?? 10_000)))
    this.open.forEach((connection) => connection.push({ id: String(entry.id), frame }))
  }
}
