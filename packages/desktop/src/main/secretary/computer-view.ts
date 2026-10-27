import { session, shell, WebContentsView } from "electron"
import { join } from "node:path"
import { nativeT } from "../native/translations"
import { LUCINA_PARTITION } from "./lucina-web-policy"
import { withShellFlag } from "./shell-command"
import { applyWebLanguage, ensureWebSession } from "./web-session"

const origin = "https://getsecretary.tech"
// Framed by the shell: her page drops its own rail, tab bar and back link (?shell=1, and the preload below).
const page = withShellFlag(`${origin}/computer`)
const permissions = new Set(["pointerLock", "fullscreen", "clipboard-sanitized-write"])
let view: WebContentsView | undefined
// The shell's focus mode as the main process last relayed it, and who to ask when the view wants it on or off.
const focus = { on: false, request: (_on: boolean) => {} }

/** Where the Computer view's focus-mode requests go (its refused fullscreen, Esc). Set once by the panels. */
export function onComputerFocusRequest(request: (on: boolean) => void) {
  focus.request = request
}

/** The shell's focus mode, as relayed to the web views. */
export function setComputerFocusMode(on: boolean) {
  focus.on = on
}

/** The web login and desktop stream stay warm while another companion tab is selected. */
export function computerView() {
  if (view && !view.webContents.isDestroyed()) return view

  const partition = session.fromPartition(LUCINA_PARTITION)
  // The viewer's fullscreen (from her page or the stream frame) never takes the Mac window into macOS full screen
  // inside the shell: it is refused and becomes the shell's focus mode. The green button keeps macOS full screen.
  const viewerFullscreen = (contents: unknown, permission: string) =>
    permission === "fullscreen" && !!view && contents === view.webContents
  partition.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    viewerFullscreen(contents, permission) ? false : allowedOrigin(requestingOrigin) && permissions.has(permission),
  )
  partition.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!viewerFullscreen(contents, permission)) return callback(allowedOrigin(details.requestingUrl) && permissions.has(permission))
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
  // Esc leaves focus mode, wherever the view's focus is (her page or the stream frame). The key still reaches the page.
  created.webContents.on("before-input-event", (_event, input) => {
    if (focus.on && input.type === "keyDown" && input.key === "Escape") focus.request(false)
  })
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
