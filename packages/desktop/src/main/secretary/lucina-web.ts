import { session, shell, WebContentsView, type Session } from "electron"
import { nativeT } from "../native/translations"
import { isLucinaUrl, LUCINA_ORIGIN, LUCINA_PARTITION, withDeviceToken } from "./lucina-web-policy"
import { applyWebLanguage } from "./web-session"

// Lucina's web app in the companion panel: the same app as getsecretary.tech and the iPhone, so the Mac gets the
// synced chat (its own per-device conversation, cached in IndexedDB), All chats, the gallery, films and every plugin.
// Its service worker keeps the app shell, so the panel opens from cache, offline too. The Mac's Secretary device token
// signs Lucina's requests in this partition, so the Lucina, Computer and image-viewer views share one sign-in.

let configured: Session | undefined

/** The shared partition, with the device token attached to Lucina's requests. Safe to call more than once. */
export function lucinaWebSession(token: () => string | undefined) {
  if (configured) return configured
  const web = session.fromPartition(LUCINA_PARTITION)
  web.webRequest.onBeforeSendHeaders({ urls: [`${LUCINA_ORIGIN}/*`] }, (details, callback) => {
    callback({ requestHeaders: withDeviceToken(details.url, details.requestHeaders, token()) })
  })
  configured = web
  return web
}

/**
 * A warm view of Lucina's web app at `path` (the chat at "/"). It loads once `ready` settles (the stored device token
 * is read at startup), so the first request is already signed. Links elsewhere open in the default browser.
 */
export function lucinaWebView(path: string, token: () => string | undefined, ready?: Promise<unknown>) {
  const page = `${LUCINA_ORIGIN}${path}`
  const view = new WebContentsView({
    webPreferences: { session: lucinaWebSession(token), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  // Transparent until the page paints, so the panel shows the workspace's own surface instead of a black flash.
  view.setBackgroundColor("#00000000")
  const navigate = (event: { url: string; isMainFrame?: boolean; preventDefault(): void }) => {
    if (event.isMainFrame === false || isLucinaUrl(event.url)) return
    event.preventDefault()
    openExternal(event.url)
  }
  view.webContents.on("will-frame-navigate", navigate)
  view.webContents.on("will-redirect", navigate)
  view.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })
  view.webContents.on("did-fail-load", (_event, code, _description, url, mainFrame) => {
    // Aborted navigations include links deliberately handed to the system browser.
    if (!mainFrame || code === -3 || !isLucinaUrl(url)) return
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:14px system-ui;padding:24px}a{color:inherit}</style><p>${escapeHTML(nativeT("desktop.lucina.loadFailed"))}</p><a href="${page}">${escapeHTML(nativeT("desktop.computer.retry"))}</a>`
    void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {})
  })
  applyWebLanguage(view.webContents)
  void Promise.resolve(ready)
    .catch(() => {})
    .then(() => view.webContents.loadURL(page))
    .catch(() => {})
  return view
}

function openExternal(value: string) {
  if (URL.canParse(value) && new URL(value).protocol === "https:") void shell.openExternal(value)
}

function escapeHTML(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
}
