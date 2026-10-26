import { ipcRenderer } from "electron"

/** Place this object at window.electron.secretary in the existing contextBridge. */
export const secretaryBridge = Object.freeze({
  close: () => ipcRenderer.invoke("secretary:close"),
  open: () => ipcRenderer.invoke("secretary:open"),
  request: (action: string, input?: unknown) => ipcRenderer.invoke("secretary:request", action, input),
})
