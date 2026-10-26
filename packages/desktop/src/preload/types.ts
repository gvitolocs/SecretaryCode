import type { StorageSnapshot, WindowSnapshot } from "../shared/ipc-transport"
import type { WindowBootstrap } from "../shared/window-bootstrap"

export type ElectronNative = {
  secretary: { open(): Promise<void>; request(action: string, input?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> }
  codingLanes: { request(action: string, input?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> }
  windowID: string
  bootstrap: WindowBootstrap
  storageSnapshot: Promise<StorageSnapshot>
  extensions: Promise<WindowSnapshot["extensions"]>
  getPathForFile(file: File): string
}
