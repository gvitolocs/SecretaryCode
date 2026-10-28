import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { AgentCommand } from "./wire"

/** A received command and the engine message id chosen for it, so a retried prompt is the same inbox item. */
export type PendingCommand = AgentCommand & {
  messageId?: string
  /** The engine has it; only the acknowledgement is outstanding, so it is never applied twice. */
  applied?: boolean
}

type Data = {
  version: 1
  /** Engine Session ID → Lucina agent id. */
  agents: Record<string, string>
  lastEventId?: string
  commands: PendingCommand[]
  /** Commands acknowledged or dropped lately: a poll answered before the ack landed must not apply them again. */
  finished: string[]
}

const MAX_FINISHED = 500

export type AgentsStore = Awaited<ReturnType<typeof openStore>>

/**
 * The mirror's durable state in userData: the session → agent mapping (so each session registers once),
 * the stream position, and commands received but not yet acknowledged. Writes are atomic and coalesced:
 * a write that lands while another is in flight is folded into the next one.
 */
export async function openStore(file: string) {
  const data = await load(file)
  const writes = { running: undefined as Promise<void> | undefined, again: false }

  const write = async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 })
    await rename(`${file}.tmp`, file)
  }

  const persist = (): Promise<void> => {
    if (writes.running) {
      writes.again = true
      return writes.running
    }
    writes.running = write()
      .catch(() => undefined)
      .finally(() => {
        writes.running = undefined
        if (!writes.again) return
        writes.again = false
        void persist()
      })
    return writes.running
  }

  return {
    agent: (sessionID: string): string | undefined => data.agents[sessionID],
    session: (agentId: string) => Object.entries(data.agents).find((entry) => entry[1] === agentId)?.[0],
    sessions: () => Object.keys(data.agents),
    setAgent(sessionID: string, agentId: string) {
      data.agents[sessionID] = agentId
      return persist()
    },
    removeAgent(sessionID: string) {
      delete data.agents[sessionID]
      return persist()
    },
    lastEventId: () => data.lastEventId,
    setLastEventId(id: string) {
      data.lastEventId = id
      return persist()
    },
    commands: (): readonly PendingCommand[] => data.commands,
    /** False when the command is already stored or finished: a replayed frame or a late poll is not applied twice. */
    addCommand(command: PendingCommand) {
      if (data.finished.includes(command.commandId)) return false
      if (data.commands.some((item) => item.commandId === command.commandId)) return false
      data.commands.push(command)
      void persist()
      return true
    },
    updateCommand(commandId: string, change: Partial<PendingCommand>) {
      data.commands = data.commands.map((item) => (item.commandId === commandId ? { ...item, ...change } : item))
      return persist()
    },
    removeCommand(commandId: string) {
      data.commands = data.commands.filter((item) => item.commandId !== commandId)
      data.finished = [...data.finished.filter((id) => id !== commandId), commandId].slice(-MAX_FINISHED)
      return persist()
    },
    /** Resolves once everything changed so far is on disk. */
    async flush() {
      while (writes.running) await writes.running
    },
  }
}

async function load(file: string): Promise<Data> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  const value = ((): unknown => {
    if (!text) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()

  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1)
    return { version: 1, agents: {}, commands: [], finished: [] }
  const stored = value as Partial<Data>

  return {
    version: 1,
    agents: stored.agents && typeof stored.agents === "object" ? stored.agents : {},
    lastEventId: typeof stored.lastEventId === "string" ? stored.lastEventId : undefined,
    commands: Array.isArray(stored.commands) ? stored.commands : [],
    finished: Array.isArray(stored.finished) ? stored.finished : [],
  }
}
