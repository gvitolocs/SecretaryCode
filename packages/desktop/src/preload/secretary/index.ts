import { ipcRenderer } from "electron"
import type { ShellCommand } from "../../main/secretary/shell-command"

/** Place this object at window.electron.secretary in the existing contextBridge. */
export const secretaryBridge = Object.freeze({
  /** Position the companion panel's native view over this rectangle (CSS pixels), or hide it. */
  place: (
    panel: "lucina" | "agents" | "computer" | undefined,
    rect?: { x: number; y: number; width: number; height: number },
  ) => ipcRenderer.send("secretary:place", panel, rect),
  /** Route Lucina's warm web view to a path of her web app without a reload. */
  navigate: (path: string) => ipcRenderer.send("secretary:navigate", path),
  /** Commands from window.secretaryShell in Lucina's web view. Returns the unsubscribe function. */
  onCommand: (listener: (command: ShellCommand) => void) => {
    // Only the command object reaches the page, never the IPC event.
    const handler = (_event: unknown, command: ShellCommand) => listener(command)
    ipcRenderer.on("secretary:shell-command", handler)

    return () => {
      ipcRenderer.removeListener("secretary:shell-command", handler)
    }
  },
  /** Tells her web views whether the shell is in focus mode. */
  setFocusMode: (on: boolean) => ipcRenderer.send("secretary:focus-mode", on === true),
  request: (action: string, input?: unknown) => ipcRenderer.invoke("secretary:request", action, input),
})
