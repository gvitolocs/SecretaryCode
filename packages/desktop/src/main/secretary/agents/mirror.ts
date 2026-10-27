import type { OpenCodeEvent } from "@opencode/client/promise"
import { scrub } from "../diagnostics/scrub"
import { AgentsError, type AgentsTransport } from "./client"
import type { Engine } from "./engine"
import type { AgentsStore } from "./store"
import { PROVIDER, type PermissionResponse, type StreamEvent, type TimelineItem, type TodoEntry, type ToolCallDetail } from "./wire"

/** The server's cap on one item's JSON: summaries only, never file contents or whole tool outputs. */
export const MAX_ITEM_BYTES = 2 * 1024

/** Longest single field before the item-level cap; a shell command or URL is a summary, not a payload. */
const MAX_FIELD_CHARS = 300

/** At most one `POST …/events` per agent in this window. */
const INTERVAL_MS = 500

/** Events kept for one session while Lucina is unreachable; the oldest go first. */
const MAX_QUEUED = 1_000

const RETRY_MS = { initial: 1_000, max: 60_000 }

type Entry = StreamEvent | { type: "text"; messageId: string; text: string }

type SessionState = {
  queue: Entry[]
  timer?: ReturnType<typeof setTimeout>
  flushing?: Promise<void>
  lastPost: number
  retryAt: number
  retryMs: number
  /** What `session.created` said, so registering a new session needs no lookup. */
  info?: { title?: string; directory: string; parentID?: string }
  /** A title to send before the next batch. */
  title?: string
  /** Subagent sessions are part of their parent's run and are not mirrored. */
  skip: boolean
  tools: Map<string, { name: string; detail: ToolCallDetail }>
  /** Characters of each text part already queued from deltas, keyed by `{message}:{ordinal}`. */
  text: Map<string, number>
  turn: "open" | "closed" | "unknown"
}

export type MirrorOptions = {
  transport: AgentsTransport
  store: AgentsStore
  engine: Engine
  onError?: (error: unknown) => void
}

/**
 * Mirrors the engine's sessions to Lucina as `secretary-code` agents. {@link handle} is fed every engine event;
 * each top-level session registers once, and its events are queued, coalesced and posted in batches.
 */
export class Mirror {
  private readonly sessions = new Map<string, SessionState>()
  private stopped = false

  constructor(private readonly options: MirrorOptions) {}

  handle(event: OpenCodeEvent) {
    if (this.stopped || !("data" in event) || !event.data || typeof event.data !== "object") return
    const sessionID = (event.data as { sessionID?: unknown }).sessionID

    if (typeof sessionID !== "string") return
    const state = this.state(sessionID)

    if (state.skip) return
    if (event.type === "session.created") {
      state.info = { title: event.data.title, directory: event.data.location.directory, parentID: event.data.parentID }
      if (event.data.parentID) {
        state.skip = true
        state.queue = []
        return
      }
    }
    if (event.type === "session.renamed") {
      // Before registration the title travels with the registration itself.
      if (state.info) state.info.title = event.data.title
      state.title = event.data.title
      this.schedule(sessionID, state)
      return
    }
    const entries = this.map(event, state)

    if (!entries.length) return
    entries.forEach((entry) => this.enqueue(state, entry))
    state.queue.splice(0, Math.max(0, state.queue.length - MAX_QUEUED))
    this.schedule(sessionID, state)
  }

  /** Posts everything queued now, ignoring the batching window; used on quit and by tests. */
  async flush() {
    await Promise.all(
      [...this.sessions.entries()].map(([sessionID, state]) => {
        clearTimeout(state.timer)
        state.timer = undefined
        return this.flushSession(sessionID, state, true)
      }),
    )
  }

  async stop() {
    await this.flush().catch(() => undefined)
    this.stopped = true
    this.sessions.forEach((state) => clearTimeout(state.timer))
  }

  /** Lucina no longer knows this agent (deleted, or lost in a `stream.reset`): the next event registers again. */
  async forget(agentId: string) {
    const sessionID = this.options.store.session(agentId)

    if (sessionID) await this.options.store.removeAgent(sessionID)
  }

  private state(sessionID: string) {
    const existing = this.sessions.get(sessionID)

    if (existing) return existing
    const created: SessionState = {
      queue: [],
      lastPost: Number.NEGATIVE_INFINITY,
      retryAt: 0,
      retryMs: 0,
      skip: false,
      tools: new Map(),
      text: new Map(),
      turn: "unknown",
    }

    this.sessions.set(sessionID, created)
    return created
  }

  private enqueue(state: SessionState, entry: Entry) {
    const last = state.queue.at(-1)

    // Deltas of one text part between two posts become one chunk.
    if (entry.type === "text" && last?.type === "text" && last.messageId === entry.messageId) {
      last.text += entry.text
      return
    }
    state.queue.push(entry)
  }

  private map(event: OpenCodeEvent, state: SessionState): Entry[] {
    const timeline = (item: TimelineItem): Entry[] => [{ type: "timeline", provider: PROVIDER, item }]

    switch (event.type) {
      case "session.created":
        return [{ type: "thread_started", sessionId: event.data.sessionID, provider: PROVIDER }]
      case "session.inbox.enqueued": {
        if (event.data.item.type !== "user") return []
        return timeline({ type: "user_message", text: event.data.item.payload.text, messageId: event.data.inboxID })
      }
      case "session.text.delta": {
        const key = `${event.data.assistantMessageID}:${event.data.ordinal}`

        state.text.set(key, (state.text.get(key) ?? 0) + event.data.delta.length)
        return [{ type: "text", messageId: key, text: event.data.delta }]
      }
      case "session.text.ended": {
        // Deltas are volatile: a part that streamed nothing, or only some of its text, is completed from the end event.
        const key = `${event.data.assistantMessageID}:${event.data.ordinal}`
        const rest = event.data.text.slice(state.text.get(key) ?? 0)

        state.text.delete(key)
        return rest ? [{ type: "text", messageId: key, text: rest }] : []
      }
      case "session.tool.input.started":
        state.tools.set(event.data.id, { name: event.data.name, detail: { type: "unknown", input: null, output: null } })
        return []
      case "session.tool.called": {
        const name = state.tools.get(event.data.id)?.name ?? "tool"

        if (name === "todowrite") {
          state.tools.delete(event.data.id)
          return timeline({ type: "todo", items: todos(event.data.input) })
        }
        const detail = summarize(name, event.data.input)

        state.tools.set(event.data.id, { name, detail })
        return timeline({ type: "tool_call", callId: event.data.id, name, detail, status: "running", error: null })
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const tool = state.tools.get(event.data.id)

        if (!tool) return []
        state.tools.delete(event.data.id)
        return timeline({
          type: "tool_call",
          callId: event.data.id,
          name: tool.name,
          detail: tool.detail,
          status: event.type === "session.tool.success" ? "completed" : "failed",
          error: event.type === "session.tool.failed" ? clip(scrub(event.data.error.message)) : null,
        })
      }
      case "permission.asked":
        return [
          {
            type: "permission_requested",
            provider: PROVIDER,
            request: {
              id: event.data.id,
              provider: PROVIDER,
              name: event.data.action,
              kind: "tool",
              title: clip(scrub(event.data.message ?? `Allow ${event.data.action}?`)),
              // Resources are paths and patterns; the request's metadata can hold a whole diff and stays local.
              description: clip(scrub(event.data.resources.slice(0, 10).join("\n"))),
              actions: [
                { id: "once", label: "Allow once", behavior: "allow", variant: "primary" },
                { id: "always", label: "Always allow", behavior: "allow", variant: "secondary" },
                { id: "reject", label: "Deny", behavior: "deny", variant: "danger" },
              ],
            },
          },
        ]
      case "permission.replied":
        return [
          {
            type: "permission_resolved",
            provider: PROVIDER,
            requestId: event.data.requestID,
            resolution: resolution(event.data.reply),
          },
        ]
      case "session.execution.started":
        state.turn = "open"
        return [{ type: "turn_started", provider: PROVIDER }]
      case "session.execution.succeeded":
      case "session.idle": {
        if (state.turn === "closed") return []
        state.turn = "closed"
        return [{ type: "turn_completed", provider: PROVIDER }]
      }
      case "session.execution.failed":
        state.turn = "closed"
        return [
          {
            type: "turn_failed",
            provider: PROVIDER,
            error: clip(scrub(event.data.error.message)),
            code: clip(event.data.error.type),
          },
        ]
      case "session.execution.interrupted":
        state.turn = "closed"
        return [{ type: "turn_canceled", provider: PROVIDER, reason: event.data.reason }]
      default:
        return []
    }
  }

  private schedule(sessionID: string, state: SessionState) {
    if (this.stopped || state.timer || state.flushing) return
    const now = Date.now()
    const delay = Math.max(0, state.lastPost + INTERVAL_MS - now, state.retryAt - now)

    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.flushSession(sessionID, state, false)
    }, delay)
  }

  private flushSession(sessionID: string, state: SessionState, force: boolean): Promise<void> {
    if (state.flushing) return force ? state.flushing.then(() => this.flushSession(sessionID, state, true)) : state.flushing
    state.flushing = this.post(sessionID, state)
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        state.flushing = undefined
        if (state.queue.length || state.title !== undefined) this.schedule(sessionID, state)
      })
    return state.flushing
  }

  private async post(sessionID: string, state: SessionState) {
    if (!state.queue.length && state.title === undefined) return
    const agentId = await this.agent(sessionID, state).catch((error: unknown) => this.failed(state, error))

    if (!agentId) {
      if (state.skip) state.queue = []
      return
    }
    if (state.title !== undefined) {
      const title = state.title

      state.title = undefined
      const renamed = await this.options.transport.rename(agentId, clip(title)).then(
        () => true,
        (error: unknown) => {
          if (error instanceof AgentsError && error.retryable) state.title ??= title
          return this.failed(state, error)
        },
      )

      if (!renamed) return
    }
    const entries = state.queue.splice(0)

    if (!entries.length) return
    state.lastPost = Date.now()
    await this.options.transport.postEvents(agentId, entries.flatMap(materialize)).then(
      () => {
        state.retryMs = 0
        state.retryAt = 0
      },
      async (error: unknown) => {
        // A rejected batch is dropped: sending it again would be rejected again and hold back the rest.
        if (error instanceof AgentsError && (error.retryable || error.code === "notFound")) state.queue.unshift(...entries)
        if (error instanceof AgentsError && error.code === "notFound") await this.options.store.removeAgent(sessionID)
        this.failed(state, error)
      },
    )
  }

  /** The session's agent id, registering the session on first use. Undefined for a session that is not mirrored. */
  private async agent(sessionID: string, state: SessionState) {
    const known = this.options.store.agent(sessionID)

    if (known) return known
    const info = state.info ?? (await this.options.engine.session(sessionID))

    if (!info || info.parentID) {
      state.skip = true
      return undefined
    }
    state.info = info
    const snapshot = await this.options.transport.register({
      provider: PROVIDER,
      external: true,
      host: "mac",
      ...(info.title ? { title: clip(info.title) } : {}),
      cwd: info.directory,
      idempotencyKey: `${PROVIDER}:${sessionID}`,
    })

    // The registration carried the current title.
    if (state.title === info.title) state.title = undefined
    await this.options.store.setAgent(sessionID, snapshot.id)
    return snapshot.id
  }

  private failed(state: SessionState, error: unknown) {
    state.retryMs = Math.min(RETRY_MS.max, Math.max(RETRY_MS.initial, state.retryMs * 2))
    state.retryAt = Date.now() + state.retryMs
    this.options.onError?.(error)
    return undefined
  }
}

/** Queue entries to wire events; a long text part becomes consecutive chunks that Lucina concatenates. */
function materialize(entry: Entry): StreamEvent[] {
  if (entry.type === "text") {
    return chunks(entry.text, entry.messageId).map((text) => ({
      type: "timeline",
      provider: PROVIDER,
      item: { type: "assistant_message", text, messageId: entry.messageId },
    }))
  }
  if (entry.type === "timeline") return [{ ...entry, item: fit(entry.item) }]
  if (entry.type === "permission_requested") return [{ ...entry, request: fit(entry.request) }]

  return [entry]
}

/** Splits text on code points so every chunk's whole item stays within {@link MAX_ITEM_BYTES}. */
function chunks(text: string, messageId: string) {
  const budget = MAX_ITEM_BYTES - bytes({ type: "assistant_message", text: "", messageId })
  const result: string[] = []
  const current = { text: "", size: 0 }

  for (const char of text) {
    const size = bytes(char) - 2
    if (current.size + size > budget && current.text) {
      result.push(current.text)
      current.text = ""
      current.size = 0
    }
    current.text += char
    current.size += size
  }
  if (current.text) result.push(current.text)
  return result
}

/** Halves the longest string until the value's JSON fits {@link MAX_ITEM_BYTES}. */
function fit<T>(value: T): T {
  const next = structuredClone(value)

  while (bytes(next) > MAX_ITEM_BYTES) {
    const longest = strings(next).toSorted((a, b) => b.value.length - a.value.length)[0]

    // Only structure is left; a server-side rejection is the right outcome for something this odd.
    if (!longest || longest.value.length < 8) break
    longest.set(clip(longest.value, Math.floor(longest.value.length / 2)))
  }
  return next
}

function strings(value: unknown): { value: string; set: (text: string) => void }[] {
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>

  return Object.keys(record).flatMap((key) => {
    const item = record[key]

    if (typeof item === "string") return [{ value: item, set: (text: string) => void (record[key] = text) }]
    return strings(item)
  })
}

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value))
}

function clip(text: string, max = MAX_FIELD_CHARS) {
  const characters = Array.from(text)

  return characters.length <= max ? text : characters.slice(0, max - 1).join("") + "…"
}

/** A tool's input as a short, contents-free detail: paths, commands, queries and URLs, never bodies. */
function summarize(name: string, input: Record<string, unknown>): ToolCallDetail {
  const text = (key: string) => (typeof input[key] === "string" ? clip(scrub(input[key])) : "")

  switch (name) {
    case "shell":
    case "bash":
      return { type: "shell", command: text("command"), ...(text("workdir") ? { cwd: text("workdir") } : {}) }
    case "read":
      return {
        type: "read",
        filePath: text("path") || text("filePath"),
        ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
        ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      }
    case "edit":
      return { type: "edit", filePath: text("path") || text("filePath") }
    case "write":
      return { type: "write", filePath: text("path") || text("filePath") }
    case "patch":
    case "apply_patch": {
      const files = typeof input.patchText === "string" ? patchFiles(input.patchText) : []

      return { type: "plain_text", label: "patch", text: clip(files.join("\n")) }
    }
    case "grep":
    case "glob": {
      const where = text("path")

      return { type: "search", query: where ? `${text("pattern")} in ${where}` : text("pattern"), toolName: name }
    }
    case "websearch":
      return { type: "search", query: text("query"), toolName: "web_search" }
    case "webfetch":
      return { type: "fetch", url: text("url") }
    case "subagent":
    case "task":
      return { type: "sub_agent", subAgentType: text("agent"), description: text("description"), log: "" }
    default:
      return { type: "plain_text", label: clip(name, 80), text: scalars(input) }
  }
}

/** Fields that carry bodies rather than identify what a tool works on. */
const BODY_KEYS = /^(content|contents|text|body|data|patch|patchtext|diff|newstring|oldstring|prompt|input|output|value|file|files)$/i

/** `key: value` for an unknown tool's short scalar fields; long strings and nested values are left out. */
function scalars(input: Record<string, unknown>) {
  return clip(
    Object.entries(input)
      .filter((entry) => !BODY_KEYS.test(entry[0]))
      .flatMap(([key, value]) => {
        if (typeof value === "number" || typeof value === "boolean") return [`${key}: ${value}`]
        if (typeof value === "string" && value.length <= 120 && !value.includes("\n")) return [`${key}: ${scrub(value)}`]
        return []
      })
      .join("\n"),
  )
}

function patchFiles(patch: string) {
  return patch.split("\n").flatMap((line) => {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)

    return match ? [`${match[1].toLowerCase()} ${match[2].trim()}`] : []
  })
}

function todos(input: Record<string, unknown>): TodoEntry[] {
  if (!Array.isArray(input.todos)) return []
  return input.todos.slice(0, 30).flatMap((todo: unknown) => {
    if (!todo || typeof todo !== "object") return []
    const entry = todo as { content?: unknown; status?: unknown }

    if (typeof entry.content !== "string") return []
    const status = entry.status === "pending" || entry.status === "in_progress" || entry.status === "completed" ? entry.status : null

    return [{ text: clip(entry.content, 120), completed: entry.status === "completed", status }]
  })
}

function resolution(reply: "once" | "always" | "reject"): PermissionResponse {
  if (reply === "reject") return { behavior: "deny", selectedActionId: "reject" }
  return { behavior: "allow", selectedActionId: reply }
}
