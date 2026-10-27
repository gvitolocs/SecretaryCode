import { Identifier } from "@opencode/schema/identifier"
import { AgentsError, type AgentsTransport } from "./client"
import { EngineRejected, type Engine } from "./engine"
import type { AgentsStore, PendingCommand } from "./store"
import { COMMAND_TTL_MS, type AgentCommand, type PermissionResponse } from "./wire"

const RETRY_MS = 5_000

export type CommandsOptions = {
  transport: AgentsTransport
  store: AgentsStore
  engine: Engine
  onError?: (error: unknown) => void
}

/**
 * Applies the owner's commands to the engine. Each command is stored before it is applied and removed once
 * Lucina has its acknowledgement, so a Mac that quits or sleeps in between finishes it on the next start.
 * Commands run one at a time, in arrival order.
 */
export class Commands {
  private chain: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(private readonly options: CommandsOptions) {}

  /** A command from the stream (or a refetch). A command already stored is not applied a second time. */
  receive(command: AgentCommand) {
    // The engine message id is fixed now: if the prompt is retried, the engine sees the same inbox item.
    const added = this.options.store.addCommand({ ...command, messageId: `msg_${Identifier.ascending()}` })

    return added ? this.drain() : this.chain
  }

  /** Applies every stored command that is still pending: on start, after a reset, and on retry. */
  drain() {
    this.chain = this.chain.then(() => this.run()).catch((error: unknown) => this.options.onError?.(error))
    return this.chain
  }

  /** After a `stream.reset`, the commands Lucina still holds for this Mac are fetched rather than replayed. */
  async refetch() {
    const commands = await this.options.transport.commands()

    commands.forEach((command) =>
      this.options.store.addCommand({ ...command, messageId: `msg_${Identifier.ascending()}` }),
    )
    return this.drain()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
  }

  private async run() {
    const results = []

    for (const command of [...this.options.store.commands()]) {
      if (this.stopped) return
      results.push(await this.handle(command))
    }
    if (results.includes("retry")) this.retry()
  }

  private retry() {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, RETRY_MS)
  }

  private async handle(command: PendingCommand): Promise<"done" | "retry"> {
    if (expired(command, Date.now())) {
      // Lucina has expired it too, and treats an unanswered permission as denied; there is nothing to acknowledge.
      await this.options.store.removeCommand(command.commandId)
      return "done"
    }
    if (!command.applied) {
      const outcome = await this.apply(command)

      if (outcome === "retry") return "retry"
      await this.options.store.updateCommand(command.commandId, { applied: true })
    }
    return this.options.transport.ack(command.agentId, command.commandId).then(
      async () => {
        await this.options.store.removeCommand(command.commandId)
        return "done" as const
      },
      async (error: unknown) => {
        if (error instanceof AgentsError && error.retryable) {
          this.options.onError?.(error)
          return "retry" as const
        }
        // Lucina no longer has the command (or rejects the ack): it is finished as far as this Mac can tell.
        await this.options.store.removeCommand(command.commandId)
        return "done" as const
      },
    )
  }

  /** "retry" when the engine could not be reached; anything the engine refused is finished and acknowledged. */
  private async apply(command: PendingCommand): Promise<"done" | "retry"> {
    const sessionID = this.options.store.session(command.agentId)

    // Not a session this Mac mirrors (or one it has since forgotten): acknowledge so it is not redelivered.
    if (!sessionID) return "done"
    const body = command.command
    const engine = this.options.engine
    const action = ((): (() => Promise<void>) | undefined => {
      if ((body.kind === "send" || body.kind === "steer") && "prompt" in body && typeof body.prompt === "string" && body.prompt.trim())
        return () =>
          engine.prompt(sessionID, {
            id: command.messageId ?? `msg_${Identifier.ascending()}`,
            text: body.prompt,
            delivery: body.kind === "steer" ? "steer" : "queue",
          })
      if (body.kind === "stop") return () => engine.interrupt(sessionID)
      if (body.kind === "permission_response" && "requestId" in body && typeof body.requestId === "string" && "response" in body) {
        const reply = decision(body.response)

        if (!reply) return undefined
        return () => engine.replyPermission(sessionID, body.requestId, reply.decision, reply.message)
      }
      // An unknown kind (or a malformed known one) from a newer server is acknowledged and ignored.
      return undefined
    })()

    if (!action) return "done"
    return action().then(
      () => "done" as const,
      (error: unknown) => {
        this.options.onError?.(error)
        return error instanceof EngineRejected ? ("done" as const) : ("retry" as const)
      },
    )
  }
}

function expired(command: AgentCommand, now: number) {
  const expiresAt = command.expiresAt ? Date.parse(command.expiresAt) : Date.parse(command.createdAt) + COMMAND_TTL_MS

  return Number.isFinite(expiresAt) && now >= expiresAt
}

/** Lucina's permission answer as the engine's: "always" only when that action was chosen. */
function decision(response: unknown): { decision: "once" | "always" | "reject"; message?: string } | undefined {
  if (!response || typeof response !== "object") return undefined
  const value = response as PermissionResponse

  if (value.behavior === "allow") return { decision: value.selectedActionId === "always" ? "always" : "once" }
  if (value.behavior === "deny") return { decision: "reject", ...(value.message ? { message: value.message } : {}) }
  return undefined
}
