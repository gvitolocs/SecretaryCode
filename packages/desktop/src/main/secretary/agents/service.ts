import type { OpenCodeEvent } from "@opencode/client/promise"
import { runStream, type AgentsTransport } from "./client"
import { Commands } from "./commands"
import type { Engine } from "./engine"
import { Mirror } from "./mirror"
import type { AgentsStore } from "./store"

/** The engine's stream ends when the service restarts; it is usually back within a second or two. */
const ENGINE_RETRY_MS = 2_000

export type MirrorServiceOptions = {
  transport: AgentsTransport
  store: AgentsStore
  engine: Engine
  /** The engine's event stream, opened again whenever it ends; events missed in between are not replayed. */
  events: (signal: AbortSignal) => AsyncIterable<OpenCodeEvent>
  onError?: (error: unknown) => void
}

/**
 * One running mirror: engine events flow to Lucina, and Lucina's commands for this Mac flow to the engine.
 * Commands stored by an earlier run are applied first.
 */
export function startMirrorService(options: MirrorServiceOptions) {
  const controller = new AbortController()
  const mirror = new Mirror({ ...options })
  const commands = new Commands({ ...options })
  const reset = async () => {
    // Agents deleted while this Mac was too far behind register again on their sessions' next events.
    const known = new Set((await options.transport.agents()).map((agent) => agent.id))
    const lost = options.store.sessions().flatMap((sessionID) => {
      const agentId = options.store.agent(sessionID)

      return agentId && !known.has(agentId) ? [agentId] : []
    })

    await Promise.all(lost.map((agentId) => mirror.forget(agentId)))
    await commands.refetch()
  }

  void commands.drain()
  const engine = pumpEngine(options, mirror, controller.signal)
  const stream = runStream({
    transport: options.transport,
    signal: controller.signal,
    lastEventId: options.store.lastEventId,
    onEventId: (id) => void options.store.setLastEventId(id),
    onReset: reset,
    // A resumed stream replays only what the daemon's journal still keeps, and waiting commands are re-sent only to a
    // stream opened without Last-Event-ID; the list closes both gaps. Commands already stored or finished are skipped.
    onOpen: () => void commands.refetch().catch((error: unknown) => options.onError?.(error)),
    onError: options.onError,
    onFrame: (frame) => {
      if (frame.type === "agent_command") return void commands.receive(frame)
      if (frame.type === "agent_deleted") return mirror.forget(frame.agentId)
    },
  })

  return {
    mirror,
    commands,
    async stop() {
      controller.abort()
      commands.stop()
      await Promise.all([engine, stream])
      await mirror.stop()
      await options.store.flush()
    },
  }
}

async function pumpEngine(options: MirrorServiceOptions, mirror: Mirror, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      for await (const event of options.events(signal)) mirror.handle(event)
    } catch (error) {
      if (!signal.aborted) options.onError?.(error)
    }
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ENGINE_RETRY_MS)

      signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
    })
  }
}
