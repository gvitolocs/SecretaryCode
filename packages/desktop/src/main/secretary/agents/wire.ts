// Lucina agents wire types: the subset Secretary Code sends and receives on secretary-server `/v1/agents/*`.
// Mirrored field for field from SecretaryIOS `crates/lucina-agents` at lucina-rs (`types.rs`, `timeline.rs`,
// `events.rs`, `permission.rs`, `external.rs`), which match Paseo 0.13.2's camelCase JSON, and the daemon's
// routes in `crates/lucina-agentd/src/api.rs`. Optional Rust fields are optional keys here; the server omits
// them rather than sending null.

export const PROVIDER = "secretary-code"

/** `external.rs` MAX_EVENTS_PER_POST: the daemon refuses a larger `POST …/events` with 400. */
export const MAX_EVENTS_PER_POST = 200

/** `title.rs` MAX_EXPLICIT_TITLE_CHARS: a title is one line of 1 to 200 characters, or the daemon answers 400. */
export const MAX_TITLE_CHARS = 200

export type AgentStatus = "initializing" | "idle" | "running" | "error" | "closed"

export type AttentionReason = "finished" | "error" | "permission"

/** `types.rs` AgentSnapshot, narrowed to the fields the mirror reads. */
export type AgentSnapshot = {
  id: string
  provider: string
  cwd: string
  status: AgentStatus
  createdAt: string
  updatedAt: string
  title: string | null
  archivedAt?: string
  pendingPermissions: PermissionRequest[]
  external?: boolean
  /** The device that registered it; set by the daemon from the caller's device token, never from the body. */
  ownerDeviceId?: string
  host?: string
}

/** `types.rs` AgentListItem (`GET /v1/agents/items`), narrowed to the fields the mirror reads. */
export type AgentListItem = {
  id: string
  shortId: string
  provider: string
  status: AgentStatus
  cwd: string
  title: string | null
  archivedAt?: string
  external?: boolean
  ownerDeviceId?: string
}

export type ToolCallStatus = "running" | "completed" | "failed" | "canceled"

/** `timeline.rs` ToolCallDetail: only the variants whose fields carry no file contents or tool output. */
export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string }
  | { type: "write"; filePath: string }
  | {
      type: "search"
      query: string
      toolName?: "search" | "grep" | "glob" | "web_search" | null
    }
  | { type: "fetch"; url: string }
  | { type: "sub_agent"; subAgentType?: string; description?: string; childSessionId?: string; log: string }
  | { type: "plain_text"; label?: string; text?: string; icon?: string }
  | { type: "plan"; text: string }
  | { type: "unknown"; input: unknown; output: unknown }

export type ToolCall = {
  type: "tool_call"
  callId: string
  name: string
  detail: ToolCallDetail
  status: ToolCallStatus
  /** `null` unless the status is `failed`. */
  error: unknown
  metadata?: Record<string, unknown>
}

export type TodoEntry = {
  text: string
  completed: boolean
  id?: string | null
  status?: "pending" | "in_progress" | "completed" | null
}

/** `timeline.rs` TimelineItem. */
export type TimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCall
  | { type: "todo"; items: TodoEntry[] }
  | { type: "error"; message: string }
  | { type: "notification"; level: "info" | "warning" | "error"; message: string }

/** `timeline.rs` TimelineRow and Cursor. */
export type TimelineRow = { seq: number; timestamp: string; item: TimelineItem; turnId?: string }

export type Cursor = { epoch: string; seq: number }

export type PermissionKind = "tool" | "plan" | "question" | "mode" | "other"

export type PermissionAction = {
  id: string
  label: string
  behavior: "allow" | "deny"
  variant?: "primary" | "secondary" | "danger"
  intent?: "implement" | "implement_resume" | "dismiss"
}

/** `permission.rs` PermissionRequest. */
export type PermissionRequest = {
  id: string
  provider: string
  name: string
  kind: PermissionKind
  title?: string
  description?: string
  input?: Record<string, unknown>
  detail?: ToolCallDetail
  actions?: PermissionAction[]
  metadata?: Record<string, unknown>
}

/** `permission.rs` PermissionResponse. */
export type PermissionResponse =
  | {
      behavior: "allow"
      selectedActionId?: string
      updatedInput?: Record<string, unknown>
      updatedPermissions?: Record<string, unknown>[]
    }
  | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean }

export type Usage = {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  totalCostUsd?: number
  contextWindowMaxTokens?: number
  contextWindowUsedTokens?: number
}

/** `events.rs` StreamEvent. */
export type StreamEvent =
  | { type: "thread_started"; sessionId: string; provider: string }
  | { type: "turn_started"; provider: string; turnId?: string }
  | { type: "turn_completed"; provider: string; turnId?: string; usage?: Usage }
  | { type: "turn_failed"; provider: string; turnId?: string; error: string; code?: string; diagnostic?: string }
  | { type: "turn_canceled"; provider: string; turnId?: string; reason: string }
  | { type: "timeline"; provider: string; item: TimelineItem; turnId?: string }
  | { type: "permission_requested"; provider: string; request: PermissionRequest }
  | { type: "permission_resolved"; provider: string; requestId: string; resolution: PermissionResponse }
  | { type: "usage_updated"; provider: string; turnId?: string; usage: Usage }
  | {
      type: "attention_required"
      provider: string
      reason: AttentionReason
      timestamp: string
      shouldNotify: boolean
    }

/** `external.rs` postable(): `attention_required` is the daemon's own (derived from the lifecycle); a post with one is refused. */
export function postable(event: StreamEvent) {
  return event.type !== "attention_required"
}

/**
 * `POST /v1/agents` (`manager.rs` CreateRequest) for an agent this device runs itself. No `prompt`: the daemon refuses
 * one for an external agent. The owner is the calling device, never a body field.
 */
export type RegisterAgent = {
  provider: typeof PROVIDER
  external: true
  host: "mac"
  title?: string
  /** One line, up to 4096 bytes. */
  cwd: string
  /** The server answers a repeated key with the agent it already created. */
  idempotencyKey: string
}

/** What the owner's other devices ask the device running the agent to do. */
export type AgentCommandBody =
  | { kind: "send"; prompt: string }
  | { kind: "steer"; prompt: string }
  | { kind: "stop" }
  | { kind: "permission_response"; requestId: string; response: PermissionResponse }

/** `external.rs` AgentCommand, as `GET /v1/agents/commands` lists it (`{commands: [...]}`). */
export type AgentCommand = {
  commandId: string
  agentId: string
  /** The kind is checked when the command is applied: an unknown one is acknowledged and dropped. */
  command: AgentCommandBody | { kind: string }
  /** ISO 8601. */
  createdAt: string
  /** ISO 8601. Unacknowledged commands expire after 24 h; an expired permission answer counts as denied. */
  expiresAt: string
}

/**
 * One frame of `GET /v1/agents/stream` (`manager.rs` BusEvent), narrowed to those the mirror acts on. The daemon
 * also sends `permission` and `workspace` frames; their ids still count for `Last-Event-ID`.
 */
export type StreamFrame =
  | { type: "agent_stream"; agentId: string; event: unknown; seq?: number; epoch: string; timestamp: string }
  | { type: "agent_state"; agent: AgentSnapshot }
  | { type: "agent_deleted"; agentId: string }
  | (AgentCommand & { type: "agent_command" })
  | { type: "stream.reset" }
  /** Not on the wire: the transport's mark that a connection was accepted, so the caller can poll what a replay may miss. */
  | { type: "stream.open" }

/**
 * A frame with its SSE `id:`, the value a reconnect sends as `Last-Event-ID`. A frame the mirror does not read
 * arrives without `frame`, so its id is still committed. A waiting command re-sent on connect has no id.
 */
export type StreamMessage = { id?: string; frame?: StreamFrame }
