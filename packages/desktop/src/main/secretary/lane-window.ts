import { app, BrowserWindow, WebContentsView, dialog, ipcMain, protocol } from "electron"
import { join } from "node:path"
import { isRendererUrl } from "../windows/scheme"
import { rustEngineDataPath } from "./engine-rs"
import { LaneChannel, cancelLane, handleLaneRequest } from "./lane-ipc"
import icon from "./icon-data"
import page from "../../renderer/secretary-lanes/index.html?raw"
import style from "../../renderer/secretary-lanes/style.css?raw"
import client from "../../renderer/secretary-lanes/client.mjs?raw"
import copy from "../../renderer/secretary-lanes/en.json"

const scheme = "secretary-coding"
const origin = `${scheme}://app/index.html`
let view: WebContentsView | undefined
let registered = false
let ready: Promise<void>

/** Call before app.ready; preload exposes codingLanesBridge under window.electron.codingLanes. */
export function setupCodingLanes() {
  if (registered) return
  registered = true
  process.env.SECRETARY_ENGINE_PATH ??= app.isPackaged
    ? join(process.resourcesPath, 'opencode-cli')
    : join(import.meta.dirname, '../../resources/opencode-cli')
  // The Rust preview lane ships beside the recorder; its data stays in the app's userData.
  process.env.SECRETARY_ENGINE_RS_DIR ??= app.isPackaged
    ? join(process.resourcesPath, 'engine-rs')
    : join(import.meta.dirname, '../../resources/engine-rs')
  process.env.SECRETARY_ENGINE_RS_DATA ??= rustEngineDataPath(app.getPath('userData'))
  // Scheme privileges are registered once with the other renderer schemes in windows/scheme.ts.
  ready = app.whenReady().then(() => {
    protocol.handle(scheme, request => {
      const url = new URL(request.url)
      if (url.hostname !== "app") return new Response(null, { status: 404 })
      if (url.pathname === "/icon.png") return new Response(Buffer.from(icon, "base64"), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } })
      const assets: Record<string, [string, string]> = { "/index.html": [page, "text/html"], "/style.css": [style, "text/css"], "/client.mjs": [client, "text/javascript"], "/en.json": [JSON.stringify(copy), "application/json"] }
      const asset = assets[url.pathname]
      if (!asset) return new Response(null, { status: 404 })
      return new Response(asset[0], { headers: { "Content-Type": asset[1], "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'", "X-Content-Type-Options": "nosniff" } })
    })
    // The docked coding-agents view and the top frame of an app window may drive lanes; embedded frames,
    // extensions and the Lucina companion may not.
    ipcMain.handle(LaneChannel, async (event, action: unknown, input: unknown) => {
      const frame = event.senderFrame
      const lanesView = !!view && event.sender === view.webContents && frame?.url === origin
      const appWindow = !!frame && !frame.parent && isRendererUrl(frame.url)
      if (!lanesView && !appWindow) return { ok: false, error: "Invalid window", code: "invalid_sender" }
      if (action !== "pick") return handleLaneRequest(action, input)
      // A docked view has no window of its own; fall back to the focused app window.
      const owner = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
      if (!owner) return { ok: false, error: "Invalid window", code: "invalid_sender" }
      const result = await dialog.showOpenDialog(owner, { title: "Choose a project", properties: ["openDirectory"] })
      return { ok: true, data: { path: result.canceled ? undefined : result.filePaths[0] } }
    })
  })
  app.on("before-quit", cancelLane)
}

/** The coding-agents panel's view, created on first use and kept warm while the companion panel is hidden. */
export function codingLanesView() {
  if (!registered) throw new Error("Call setupCodingLanes before app.ready")
  if (view && !view.webContents.isDestroyed()) return view
  const created = new WebContentsView({ webPreferences: {
    preload: join(import.meta.dirname, "../preload/index.cjs"), additionalArguments: ["--opencode-window=" + encodeURIComponent(JSON.stringify({ id: "secretary-coding", packaged: app.isPackaged }))], contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
  } })
  view = created
  created.setBackgroundColor("#00000000")
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  created.webContents.on("will-navigate", (event, url) => { if (url !== origin) event.preventDefault() })
  created.webContents.once("destroyed", () => { if (view !== created) return; cancelLane(); view = undefined })
  void ready.then(() => created.webContents.loadURL(origin))
  return created
}
