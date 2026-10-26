import { ipcRenderer } from "electron"

export const codingLanesBridge = Object.freeze({
  request: (action: string, input?: unknown) => ipcRenderer.invoke("secretary:lanes", action, input),
})
