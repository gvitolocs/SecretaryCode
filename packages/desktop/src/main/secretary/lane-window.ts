import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron"
import { join } from "node:path"
import { isRendererUrl } from "../windows/scheme"
import { LaneChannel, cancelLane, handleLaneRequest } from "./lane-ipc"
import page from "../../renderer/secretary-lanes/index.html?raw"
import style from "../../renderer/secretary-lanes/style.css?raw"
import client from "../../renderer/secretary-lanes/client.mjs?raw"

const scheme = "secretary-coding"
const origin = `${scheme}://app/index.html`
let window: BrowserWindow | undefined
let registered = false
let ready: Promise<void>

/** Call before app.ready; preload exposes codingLanesBridge under window.electron.codingLanes. */
export function setupCodingLanes() {
  if (registered) return
  registered = true
  // Scheme privileges are registered once with the other renderer schemes in windows/scheme.ts.
  ready = app.whenReady().then(() => {
    protocol.handle(scheme, request => {
      const url = new URL(request.url)
      if (url.hostname !== "app") return new Response(null, { status: 404 })
      const assets: Record<string, [string, string]> = { "/index.html": [page, "text/html"], "/style.css": [style, "text/css"], "/client.mjs": [client, "text/javascript"] }
      const asset = assets[url.pathname]
      if (!asset) return new Response(null, { status: 404 })
      return new Response(asset[0], { headers: { "Content-Type": asset[1], "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'", "X-Content-Type-Options": "nosniff" } })
    })
    // The coding-lanes window and the top frame of an app window may drive lanes; embedded frames,
    // extensions and the Lucina companion may not.
    ipcMain.handle(LaneChannel, async (event, action: unknown, input: unknown) => {
      const frame = event.senderFrame
      const lanesWindow = !!window && event.sender === window.webContents && frame?.url === origin
      const appWindow = !!frame && !frame.parent && isRendererUrl(frame.url)
      if (!lanesWindow && !appWindow) return { ok: false, error: "Invalid window", code: "invalid_sender" }
      if (action !== "pick") return handleLaneRequest(action, input)
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner) return { ok: false, error: "Invalid window", code: "invalid_sender" }
      const result = await dialog.showOpenDialog(owner, { title: "Choose a project", properties: ["openDirectory"] })
      return { ok: true, data: { path: result.canceled ? undefined : result.filePaths[0] } }
    })
  })
  app.on("before-quit", cancelLane)
}

export async function openCodingLanes() {
  if (!registered) throw new Error("Call setupCodingLanes before app.ready")
  await ready
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return window }
  window = new BrowserWindow({ width: 1040, height: 800, minWidth: 760, minHeight: 620, title: "Secretary Code · Coding agents", backgroundColor: "#101212", titleBarStyle: "hiddenInset", webPreferences: {
    preload: join(import.meta.dirname, "../preload/index.cjs"), additionalArguments: ["--opencode-window=" + encodeURIComponent(JSON.stringify({ id: "secretary-coding", packaged: app.isPackaged }))], contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
  } })
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, url) => { if (url !== origin) event.preventDefault() })
  window.on("closed", () => { cancelLane(); window = undefined })
  await window.loadURL(origin)
  return window
}
