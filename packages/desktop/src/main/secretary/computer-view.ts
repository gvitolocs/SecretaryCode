import { session, shell, WebContentsView } from "electron"
import { join } from "node:path"
import { nativeT } from "../native/translations"
import { microphoneGranted } from "./lucina-web"
import { LUCINA_PARTITION } from "./lucina-web-policy"
import { withShellFlag } from "./shell-command"
import { applyWebLanguage, ensureWebSession } from "./web-session"

const origin = "https://getsecretary.tech"
// Framed by the shell: her page drops its own rail, tab bar and back link (?shell=1, and the preload below).
const page = withShellFlag(`${origin}/computer`)
const permissions = new Set(["pointerLock", "fullscreen", "clipboard-sanitized-write"])
let view: WebContentsView | undefined
// Who to ask when the view's refused fullscreen wants focus mode. Esc in the view is left to her page: while the
// owner drives Lucina's desktop it belongs to the remote apps (her page leaves focus mode on Esc only in Watch mode).
const focus = { request: (_on: boolean) => {} }

/** Where the Computer view's focus-mode requests go (its refused fullscreen). Set once by the panels. */
export function onComputerFocusRequest(request: (on: boolean) => void) {
  focus.request = request
}

/** The web login and desktop stream stay warm while another companion tab is selected. */
export function computerView() {
  if (view && !view.webContents.isDestroyed()) return view

  const partition = session.fromPartition(LUCINA_PARTITION)
  // The viewer's fullscreen (from her page or the stream frame) never takes the Mac window into macOS full screen
  // inside the shell: it is refused and becomes the shell's focus mode. The green button keeps macOS full screen.
  const viewerFullscreen = (contents: unknown, permission: string) =>
    permission === "fullscreen" && !!view && contents === view.webContents
  // Reading the clipboard (LucinaDesk's ⌘V) is the viewer's own top page alone: never a frame inside it (the stream,
  // the home-network host) nor another view of the partition. Electron does not say whether a user gesture asked, so
  // this is a deliberate grant to that page; Chromium still lets only a focused document read.
  // The microphone goes to the views that ask for it (lucina-web.ts allowMicrophone), audio alone.
  const granted = (contents: unknown, permission: string, url: string, mainFrame: boolean, mediaTypes?: readonly unknown[]) => {
    if (!allowedOrigin(url)) return false
    if (permission === "clipboard-read") return mainFrame && !!view && contents === view.webContents
    if (permission === "media") return microphoneGranted(contents, mediaTypes, url, mainFrame)

    return permissions.has(permission)
  }
  partition.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    viewerFullscreen(contents, permission)
      ? false
      : granted(contents, permission, requestingOrigin, details.isMainFrame, "mediaType" in details ? [details.mediaType] : undefined),
  )
  partition.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!viewerFullscreen(contents, permission))
      return callback(
        granted(contents, permission, details.requestingUrl, details.isMainFrame, "mediaTypes" in details ? details.mediaTypes : undefined),
      )
    callback(false)
    focus.request(true)
  })

  const created = new WebContentsView({
    webPreferences: {
      session: partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // window.secretaryShell, so her page knows the shell frames it: no rail, stage dock or back link of its own.
      preload: join(import.meta.dirname, "../preload/lucina.cjs"),
    },
  })
  view = created
  // Only the top page is pinned to Lucina's origin: the viewer frame may move to the home-network host the server offers.
  const navigate = (event: { url: string; isMainFrame?: boolean; preventDefault(): void }) => {
    if (event.isMainFrame === false || allowedOrigin(event.url)) return
    event.preventDefault()
    openExternal(event.url)
  }
  created.webContents.on("will-frame-navigate", navigate)
  created.webContents.on("will-redirect", navigate)
  created.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })
  created.webContents.on("did-fail-load", (_event, code, _description, url, mainFrame) => {
    // Aborted navigations include links deliberately handed to the system browser.
    if (!mainFrame || code === -3 || !allowedOrigin(url)) return
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:14px system-ui;padding:24px}a{color:inherit}</style><p>${escapeHTML(nativeT("desktop.computer.loadFailed"))}</p><a href="${page}">${escapeHTML(nativeT("desktop.computer.retry"))}</a>`
    void created.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {})
  })
  // did-fail-load owns the inline error page, including failures after the initial navigation.
  // The app's language and the device's web session come first, so the owner sees neither the Mac's locale nor a
  // second login form. ensureWebSession always settles.
  applyWebLanguage(created.webContents)
  void ensureWebSession()
    .then(() => created.webContents.loadURL(page))
    .catch(() => {})
  return created
}

/** The Computer view's webContents while it exists. Never creates the view. */
export function computerWebContents() {
  return view && !view.webContents.isDestroyed() ? view.webContents : undefined
}

/** Reloads the Computer tab if it exists, e.g. after the device signs in or out; never creates it. */
export function reloadComputerView() {
  if (view && !view.webContents.isDestroyed()) void view.webContents.loadURL(page).catch(() => {})
}

function allowedOrigin(value: string) {
  return URL.canParse(value) && new URL(value).origin === origin
}

function openExternal(value: string) {
  if (URL.canParse(value) && new URL(value).protocol === "https:") void shell.openExternal(value)
}

function escapeHTML(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
}
