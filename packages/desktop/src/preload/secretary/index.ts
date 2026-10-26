import { ipcRenderer } from "electron"

/** Place this object at window.electron.secretary in the existing contextBridge. */
export const secretaryBridge = Object.freeze({
  /** Position the companion panel's native view over this rectangle (CSS pixels), or hide it. */
  place: (panel: "lucina" | "agents" | undefined, rect?: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send("secretary:place", panel, rect),
  request: (action: string, input?: unknown) => ipcRenderer.invoke("secretary:request", action, input),
})
