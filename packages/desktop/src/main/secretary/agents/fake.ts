import { AgentsError, type AgentsTransport } from "./client"
import type {
  AgentCommand,
  AgentCommandBody,
  AgentListItem,
  AgentSnapshot,
  RegisterAgent,
  StreamEvent,
  StreamFrame,
  StreamMessage,
} from "./wire"

type Connection = { push: (message: StreamMessage | undefined) => void }

/**
 * An in-memory secretary-server for `/v1/agents/*`: the tests drive it, and `SECRETARY_AGENTS_FAKE=1` runs the
 * mirror against it without a server. It keeps the protocol's rules: idempotent registration, a bounded
 * replay log with `stream.reset` past it, and commands kept until acknowledged.
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
    const existing = [...this.agentsById.values()].find((agent) => agent.idempotencyKey === input.idempotencyKey)

    if (existing) return existing
    const at = new Date(Date.now()).toISOString()
    const agent = {
      id: `agent_${this.nextAgent++}`,
      provider: input.provider,
      cwd: input.cwd,
      title: input.title ?? null,
      status: "idle" as const,
      createdAt: at,
      updatedAt: at,
      idempotencyKey: input.idempotencyKey,
    }

    this.agentsById.set(agent.id, agent)
    this.publish({ type: "agent_state", agentId: agent.id, event: agent })
    return agent
  }

  async rename(agentId: string, title: string) {
    this.fail()
    const agent = this.agentsById.get(agentId)

    if (!agent) throw new AgentsError("notFound", "Lucina answered 404")
    agent.title = title
  }

  async postEvents(agentId: string, events: readonly StreamEvent[]) {
    this.fail()
    if (!this.agentsById.has(agentId)) throw new AgentsError("notFound", "Lucina answered 404")
    this.posts.push({ agentId, events: [...events], at: Date.now() })
    this.events.set(agentId, [...(this.events.get(agentId) ?? []), ...events])
    events.forEach((event) => this.publish({ type: "agent_stream", agentId, event }))
  }

  async ack(agentId: string, commandId: string) {
    this.fail()
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
    }))
  }

  async commands() {
    this.fail()
    this.calls.commands++
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
      // Replay what this client missed, or tell it to refetch when the log no longer reaches back that far.
      if (after !== undefined && oldest !== undefined && after < oldest - 1)
        connection.push({ id: String(this.nextEventId - 1), frame: { type: "stream.reset" } })
      else if (after !== undefined)
        this.log.filter((entry) => entry.id > after).forEach((entry) => connection.push({ id: String(entry.id), frame: entry.frame }))
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

  /** The owner's phone sends a command; it is stored until acknowledged and delivered on the stream. */
  command(agentId: string, command: AgentCommandBody | { kind: string }, options: { createdAt?: number; id?: string } = {}) {
    const frame: AgentCommand = {
      type: "agent_command",
      commandId: options.id ?? `cmd_${this.nextEventId}`,
      agentId,
      command,
      createdAt: new Date(options.createdAt ?? Date.now()).toISOString(),
    }

    this.pending.set(frame.commandId, frame)
    this.publish(frame)
    return frame
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
