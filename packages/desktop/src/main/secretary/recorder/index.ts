import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  protocol,
  WebContentsView,
  type IpcMainInvokeEvent,
} from "electron"
import { join } from "node:path"
import page from "../../../renderer/secretary-recorder/index.html?raw"
import style from "../../../renderer/secretary-recorder/style.css?raw"
import client from "../../../renderer/secretary-recorder/client.mjs?raw"
import copy from "../../../renderer/secretary-recorder/en.json"
import { isRendererUrl } from "../../windows/scheme"
import { HelperError } from "./helper"
import { RecorderInputError } from "./input"
import { RecorderFailure, RecorderService } from "./service"
import { parseRequest, rejection } from "./state"
import { setupRecorderTray } from "./tray"
import { UploadError } from "./uploader"

const scheme = "secretary-recorder"

const origin = `${scheme}://app/index.html`

export const RECORDER_SHORTCUT = "Alt+CommandOrControl+R"

const STATE_CHANNEL = "secretary:recorder-state"

const assets: Record<string, [string, string]> = {
  "/index.html": [page, "text/html"],
  "/style.css": [style, "text/css"],
  "/client.mjs": [client, "text/javascript"],
  "/en.json": [JSON.stringify(copy), "application/json"],
}

const sheet: { host?: BrowserWindow; view?: WebContentsView; window?: BrowserWindow; visible: boolean } = {
  visible: false,
}

let service: RecorderService | undefined

let ready: Promise<void> | undefined

/**
 * Call before app.ready, like the other Secretary surfaces. The Record sheet is a transparent view
 * laid over the workspace window (or its own window when none is open); the recorder itself lives
 * in the main process so a recording survives closing every window.
 */
export function setupRecorder() {
  if (service) return
  const recorder = new RecorderService(() => void openRecorder(true))
  service = recorder
  ready = app.whenReady().then(async () => {
    protocol.handle(scheme, (request) => {
      const url = new URL(request.url)
      const asset = url.hostname === "app" ? assets[url.pathname] : undefined

      if (!asset) return new Response(null, { status: 404 })

      return new Response(asset[0], {
        headers: {
          "Content-Type": asset[1],
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
          "X-Content-Type-Options": "nosniff",
        },
      })
    })
    ipcMain.handle("secretary:recorder-open", (event) => {
      if (!event.senderFrame || event.senderFrame.parent || !isRendererUrl(event.senderFrame.url)) return false
      void openRecorder()

      return true
    })
    ipcMain.handle("secretary:recorder", async (event, action: unknown, input: unknown) => {
      if (!fromSheet(event)) return { ok: false, error: "invalidRequest" }

      try {
        const request = parseRequest(action, input)
        const refused = rejection(recorder.phase, request)

        if (refused) return { ok: false, error: refused }

        if (request.action === "close") {
          hideRecorder()

          return { ok: true, data: true }
        }

        return { ok: true, data: await recorder.perform(request) }
      } catch (error) {
        return { ok: false, error: errorCode(error) }
      }
    })
    recorder.subscribe(push)
    recorder.subscribe(broadcastStatus)
    setupRecorderTray(recorder, () => void openRecorder(true))

    if (process.platform === "darwin") globalShortcut.register(RECORDER_SHORTCUT, () => void openRecorder())
    app.on("will-quit", () => globalShortcut.unregister(RECORDER_SHORTCUT))
    await recorder.start()
  })
}

/** Toggles the Record sheet over the workspace window; `show` keeps it open instead. */
export async function openRecorder(show = false) {
  if (!ready) throw new Error("Call setupRecorder before app.ready")
  await ready
  const host = workspaceWindow()

  if (!host) return openStandalone()

  if (sheet.visible && sheet.host === host && !show) return hideRecorder()
  const view = sheetView(host)
  // Re-adding moves the view above everything else, including the Lucina dock.
  host.contentView.addChildView(view)
  sheet.visible = true
  resize()

  if (host.isMinimized()) host.restore()
  host.show()
  host.focus()
  view.webContents.focus()
  push()
}

function hideRecorder() {
  if (sheet.window && !sheet.window.isDestroyed()) sheet.window.close()

  if (!sheet.visible || !sheet.view || !sheet.host || sheet.host.isDestroyed()) return
  sheet.visible = false
  sheet.host.contentView.removeChildView(sheet.view)
  sheet.host.webContents.focus()
}

function sheetView(host: BrowserWindow) {
  if (sheet.view && !sheet.view.webContents.isDestroyed() && sheet.host === host) return sheet.view

  if (sheet.view && sheet.host && !sheet.host.isDestroyed()) {
    sheet.host.contentView.removeChildView(sheet.view)
    sheet.view.webContents.close()
  }

  const view = new WebContentsView({ webPreferences: preferences() })
  view.setBackgroundColor("#00000000")
  guard(view.webContents)
  void view.webContents.loadURL(origin)
  sheet.host = host
  sheet.view = view
  sheet.visible = false
  host.on("resize", resize)
  host.once("closed", () => {
    if (sheet.host !== host) return

    if (!view.webContents.isDestroyed()) view.webContents.close()
    sheet.host = undefined
    sheet.view = undefined
    sheet.visible = false
  })

  return view
}

/** With every workspace window closed (the tray's "Open Recorder"), the sheet gets its own window. */
function openStandalone() {
  if (sheet.window && !sheet.window.isDestroyed()) {
    sheet.window.show()
    sheet.window.focus()

    return
  }

  const window = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 440,
    minHeight: 560,
    title: copy.sheetTitle,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1c1c1e",
    webPreferences: preferences(),
  })

  guard(window.webContents)
  sheet.window = window
  window.on("closed", () => {
    if (sheet.window === window) sheet.window = undefined
  })
  void window.loadURL(`${origin}#window`)
}

function preferences(): Electron.WebPreferences {
  return {
    preload: join(import.meta.dirname, "../preload/index.cjs"),
    additionalArguments: [
      "--opencode-window=" + encodeURIComponent(JSON.stringify({ id: "secretary-recorder", packaged: app.isPackaged })),
    ],
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  }
}

function guard(contents: Electron.WebContents) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
  contents.on("will-navigate", (event, url) => {
    if (!isSheetUrl(url)) event.preventDefault()
  })
  contents.on("did-finish-load", push)
}

function resize() {
  const host = sheet.host
  const view = sheet.view

  if (!sheet.visible || !host || host.isDestroyed() || !view) return
  const bounds = host.getContentBounds()
  view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
}

function push() {
  if (!service) return
  const snapshot = service.snapshot()

  for (const contents of [sheet.visible ? sheet.view?.webContents : undefined, sheet.window?.webContents])
    if (contents && !contents.isDestroyed()) contents.send(STATE_CHANNEL, snapshot)
}

let lastStatus = ""

/** Workspace windows show the recording state in their titlebar button; whole seconds are enough. */
function broadcastStatus() {
  if (!service) return
  const status = { phase: service.recording.phase, elapsed: Math.floor(service.recording.elapsed) }
  const key = JSON.stringify(status)

  if (key === lastStatus) return
  lastStatus = key

  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed() && isRendererUrl(window.webContents.getURL()))
      window.webContents.send("secretary:recorder-status", status)
}

/** The focused workspace window, or any workspace window; never the sheet's own or another tool window. */
function workspaceWindow() {
  const windows = [BrowserWindow.getFocusedWindow(), ...BrowserWindow.getAllWindows()]

  return (
    windows.find(
      (window) =>
        window && !window.isDestroyed() && window !== sheet.window && isRendererUrl(window.webContents.getURL()),
    ) ?? undefined
  )
}

function fromSheet(event: IpcMainInvokeEvent) {
  const contents = [sheet.view?.webContents, sheet.window?.webContents]

  return contents.includes(event.sender) && !event.senderFrame?.parent && isSheetUrl(event.senderFrame?.url)
}

function isSheetUrl(url: string | undefined) {
  return url === origin || url === `${origin}#window`
}

function errorCode(error: unknown) {
  if (error instanceof RecorderInputError) return "invalidRequest"

  if (error instanceof RecorderFailure || error instanceof HelperError || error instanceof UploadError)
    return Object.hasOwn(copy, error.code) ? error.code : "serverError"

  return "serverError"
}
