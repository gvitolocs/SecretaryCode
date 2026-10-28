import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type WebContents } from "electron"
import { join } from "node:path"
import { allowMicrophone, lucinaWebView, navigateLucinaView } from "./lucina-web"
import { isLucinaUrl } from "./lucina-web-policy"
import { fromLucina, shellWindow } from "./panel"
import { parseOverlayRequest } from "./prompter-overlay-core"
import { ensureWebSession } from "./web-session"

// Lucina Prompter's overlay (PROMPTER_OVERLAY.md): her talking points in a small frameless window that stays above
// other apps (a call, slides) while she crosses them out live. Her page asks through window.secretaryShell; the
// overlay is her web app itself in the shared partition, with the same preload and the microphone (audio only).

const WIDTH = 440
const HEIGHT = 640
const MARGIN = 24

let overlay: BrowserWindow | undefined
// The page each overlay window shows (the window's own webContents is an empty host).
const views = new WeakMap<BrowserWindow, WebContents>()

function current() {
  return overlay && !overlay.isDestroyed() ? overlay : undefined
}

/** One overlay at a time: a second call shows `path` in the open one. */
function open(path: string, opacity: number) {
  const existing = current()

  if (existing) {
    existing.setOpacity(opacity)
    const page = views.get(existing)
    if (page && !page.isDestroyed()) void navigateLucinaView(page, path)
    existing.show()

    return
  }
  const { workArea } = screen.getPrimaryDisplay()
  const height = Math.min(HEIGHT, workArea.height - 2 * MARGIN)
  const window = new BrowserWindow({
    width: WIDTH,
    height,
    x: workArea.x + workArea.width - WIDTH - MARGIN,
    y: workArea.y + MARGIN,
    minWidth: 320,
    minHeight: 240,
    frame: false,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    title: "Lucina Prompter",
    backgroundColor: "#0b1020",
    opacity,
  })
  // Above other apps' windows, on every Space, and over a full-screen call or presentation.
  window.setAlwaysOnTop(true, "floating")
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const page = lucinaWebView(path, ensureWebSession, { preload: join(import.meta.dirname, "../preload/lucina.cjs") })
  allowMicrophone(page.webContents)
  window.contentView.addChildView(page)
  const fit = () => {
    const [width, height] = window.getContentSize()
    page.setBounds({ x: 0, y: 0, width: width ?? WIDTH, height: height ?? HEIGHT })
  }
  fit()
  window.on("resize", fit)
  // Shown once her page has painted (or after a moment), never as an empty frame.
  const show = () => {
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  }
  page.webContents.once("did-finish-load", show)
  setTimeout(show, 3_000).unref()
  views.set(window, page.webContents)
  // The overlay goes with the main window.
  const host = shellWindow()
  const closeWithHost = () => {
    if (!window.isDestroyed()) window.close()
  }
  host?.once("closed", closeWithHost)
  window.once("closed", () => {
    host?.removeListener("closed", closeWithHost)
    if (overlay === window) overlay = undefined
    if (!page.webContents.isDestroyed()) page.webContents.close()
  })
  overlay = window
}

/** Whether a message comes from the overlay's own page, in its top frame, on her origin. */
function fromOverlay(event: IpcMainEvent) {
  const window = current()
  const frame = event.senderFrame

  return !!window && event.sender === views.get(window) && !!frame && !frame.parent && isLucinaUrl(frame.url)
}

/** Call once during startup. Her views open the overlay; only the overlay's own page changes or closes it. */
export function setupPrompterOverlay() {
  ipcMain.on("secretary:prompter-overlay", (event, message: unknown) => {
    const request = parseOverlayRequest(message)

    if (!request) return

    if (request.action === "open") {
      if (fromLucina(event) || fromOverlay(event)) open(request.path, request.opacity)

      return
    }

    if (!fromOverlay(event)) return
    const window = current()

    if (request.action === "opacity") window?.setOpacity(request.opacity)
    else window?.close()
  })
}
