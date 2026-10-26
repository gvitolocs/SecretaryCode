import { ipcRenderer, type IpcRendererEvent } from "electron"

function listen(channel: string, callback: (value: unknown) => void) {
  const listener = (_event: IpcRendererEvent, value: unknown) => callback(value)
  ipcRenderer.on(channel, listener)

  return () => {
    ipcRenderer.off(channel, listener)
  }
}

/** Placed at window.electron.recorder. The main process checks which page may use each channel. */
export const recorderBridge = Object.freeze({
  open: () => ipcRenderer.invoke("secretary:recorder-open"),
  request: (action: string, input?: unknown) => ipcRenderer.invoke("secretary:recorder", action, input),
  onState: (callback: (snapshot: unknown) => void) => listen("secretary:recorder-state", callback),
  onStatus: (callback: (status: unknown) => void) => listen("secretary:recorder-status", callback),
})
