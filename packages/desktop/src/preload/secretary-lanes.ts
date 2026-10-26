import { ipcRenderer } from "electron"
import type { CodingLanes } from "./types"

// Keep in sync with LaneChannel in main/secretary/lane-ipc.ts; preload cannot import main-process modules.
const channel = "secretary:lanes"

export const codingLanesBridge: CodingLanes = Object.freeze({
  request: (action: string, input?: unknown) => ipcRenderer.invoke(channel, action, input),
  list: () => ipcRenderer.invoke(channel, "list"),
  status: () => ipcRenderer.invoke(channel, "status"),
  probe: (lane: "qwen") => ipcRenderer.invoke(channel, "probe", { lane }),
  launch: (input: Parameters<CodingLanes["launch"]>[0]) => ipcRenderer.invoke(channel, "launch", input),
  cancel: () => ipcRenderer.invoke(channel, "cancel"),
  pick: () => ipcRenderer.invoke(channel, "pick"),
})
