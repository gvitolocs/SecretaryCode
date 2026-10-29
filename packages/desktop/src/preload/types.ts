import type { StorageSnapshot, WindowSnapshot } from "../shared/ipc-transport"
import type { WindowBootstrap } from "../shared/window-bootstrap"
import type { AttentionCounts } from "../main/secretary/attention-core"
import type { ShellCommand } from "../main/secretary/shell-command"

export type ElectronNative = {
  secretary: {
    place(
      panel: "lucina" | "agents" | "computer" | undefined,
      rect?: { x: number; y: number; width: number; height: number },
    ): void
    navigate(path: string): void
    onCommand(listener: (command: ShellCommand) => void): () => void
    exitFocusMode(): void
    attention(): Promise<AttentionCounts>
    onAttention(listener: (counts: AttentionCounts) => void): () => void
    request(action: string, input?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }>
  }
  codingLanes: CodingLanes
  recorder: {
    open(): Promise<boolean>
    request(action: string, input?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }>
    onState(callback: (snapshot: unknown) => void): () => void
    onStatus(callback: (status: unknown) => void): () => void
  }
  windowID: string
  bootstrap: WindowBootstrap
  storageSnapshot: Promise<StorageSnapshot>
  extensions: Promise<WindowSnapshot["extensions"]>
  getPathForFile(file: File): string
}

/** Every lane call resolves; failures carry a stable `code` (for example `qwen_busy`) and an English `error`. */
export type LaneResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string }

export type CodingLane = {
  id: "secretary" | "rust" | "claude" | "zcode" | "qwen" | "orchestra"
  name: string
  /** "mac" runs locally; "nezopt" runs over SSH on the first reachable configured host. */
  location: "mac" | "nezopt"
  model: string
}

export type CodingLaneStatus = {
  lanes: readonly CodingLane[]
  workers: Readonly<Record<string, string>>
  running: boolean
  status: string
  /** Redacted, bounded combined stdout and stderr of the current or last task. */
  output: string
  exitCode?: number | null
}

/** window.electron.codingLanes: one task runs at a time across the lanes window and every app window. */
export type CodingLanes = {
  /** Raw form used by the coding-lanes window: request("status"), request("launch", input), ... */
  request(action: string, input?: unknown): Promise<LaneResult<unknown>>
  list(): Promise<LaneResult<{ lanes: readonly CodingLane[]; workers: Readonly<Record<string, string>>; hosts: string[] }>>
  status(): Promise<LaneResult<CodingLaneStatus>>
  /** Checks the shared Qwen slot over SSH without starting anything. */
  probe(lane: "qwen"): Promise<LaneResult<{ slot: "free" | "busy" | "unknown"; host?: string }>>
  /** Starts a headless task in `project` (absolute path). Qwen reports `qwen_busy` instead of starting twice. */
  launch(input: {
    lane: CodingLane["id"]
    project: string
    prompt: string
    /** Built-in engine only; omitted to use the workspace model. */
    model?: string
    /** Remote lanes only: a path under /home/nez/Projects when `project` is not under the nezopt mount. */
    remoteProject?: string
    /** Orchestra only: a key of `workers`; defaults to zen-glm-flash. */
    worker?: string
  }): Promise<LaneResult<{ started: true }>>
  cancel(): Promise<LaneResult<{ requested: true }>>
  /** Opens a directory picker attached to the calling window. */
  pick(): Promise<LaneResult<{ path?: string }>>
}
