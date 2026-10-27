import { session, shell, WebContentsView } from "electron"
import { nativeT } from "../native/translations"

const origin = "https://getsecretary.tech"
const page = `${origin}/computer`
const permissions = new Set(["pointerLock", "fullscreen", "clipboard-sanitized-write"])
let view: WebContentsView | undefined

/** The web login and desktop stream stay warm while another companion tab is selected. */
export function computerView() {
  if (view && !view.webContents.isDestroyed()) return view

  const partition = session.fromPartition("persist:lucina-web")
  partition.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) => allowedOrigin(requestingOrigin) && permissions.has(permission),
  )
  partition.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(allowedOrigin(details.requestingUrl) && permissions.has(permission)),
  )

  const created = new WebContentsView({
    webPreferences: {
      session: partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
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
  void created.webContents.loadURL(page).catch(() => {})
  return created
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
