// Lucina agents wire types: the subset Secretary Code sends and receives on secretary-server `/v1/agents/*`.
// Mirrored field for field from SecretaryIOS `crates/lucina-agents` at agents-p2 386c9c6 (`types.rs`,
// `timeline.rs`, `events.rs`, `permission.rs`), which match Paseo 0.13.2's camelCase JSON. Optional Rust
// fields are optional keys here; the server omits them rather than sending null.

export const PROVIDER = "secretary-code"

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
  title?: string | null
  archivedAt?: string | null
  pendingPermissions?: PermissionRequest[]
}

/** `types.rs` AgentListItem, narrowed to the fields the mirror reads. */
export type AgentListItem = {
  id: string
  shortId: string
  provider: string
  status: AgentStatus
  cwd: string
  title?: string | null
  archivedAt?: string | null
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

/** `events.rs` StreamEvent, without the provider-internal `usage_updated` and server-derived `attention_required`. */
export type StreamEvent =
  | { type: "thread_started"; sessionId: string; provider: string }
  | { type: "turn_started"; provider: string; turnId?: string }
  | { type: "turn_completed"; provider: string; turnId?: string; usage?: Usage }
  | { type: "turn_failed"; provider: string; turnId?: string; error: string; code?: string; diagnostic?: string }
  | { type: "turn_canceled"; provider: string; turnId?: string; reason: string }
  | { type: "timeline"; provider: string; item: TimelineItem; turnId?: string }
  | { type: "permission_requested"; provider: string; request: PermissionRequest }
  | { type: "permission_resolved"; provider: string; requestId: string; resolution: PermissionResponse }

/** `POST /v1/agents` for an agent this device runs itself. */
export type RegisterAgent = {
  provider: typeof PROVIDER
  external: true
  host: "mac"
  title?: string
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

export type AgentCommand = {
  type: "agent_command"
  commandId: string
  agentId: string
  /** The kind is checked when the command is applied: an unknown one is acknowledged and dropped. */
  command: AgentCommandBody | { kind: string }
  /** ISO 8601. A command older than {@link COMMAND_TTL_MS} has expired. */
  createdAt: string
  expiresAt?: string
}

/** Commands not acknowledged within 24 h expire on the server; an expired permission answer counts as denied. */
export const COMMAND_TTL_MS = 24 * 60 * 60 * 1000

/** One frame of `GET /v1/agents/stream`. */
export type StreamFrame =
  | {
      type: "agent_stream" | "agent_state" | "agent_deleted"
      agentId: string
      event?: unknown
      seq?: number
      epoch?: string
      timestamp?: string
    }
  | AgentCommand
  | { type: "stream.reset" }

/** A frame with its SSE `id:`, the value a reconnect sends as `Last-Event-ID`. */
export type StreamMessage = { id?: string; frame: StreamFrame }
