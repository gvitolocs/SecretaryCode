import type { RustEnginePreview } from "@opencode/app/desktop"
import type { ElectronAPI } from "../api-types"

/** window.electron → Rust engine preview RPCs. The main process owns the child server's lifecycle. */
export function createDesktopRustEngine(api: ElectronAPI): RustEnginePreview {
  return {
    status: () => api.rustEngineStatus(),
    setEnabled: (enabled) => api.rustEngineSetEnabled(enabled),
    ping: (tsUrl) => api.rustEnginePing(tsUrl),
  }
}
