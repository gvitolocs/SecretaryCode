import { BrowserWindow, ipcMain, session } from "electron"
import { randomUUID } from "node:crypto"
import { fromLucina, shellWindow } from "./panel"
import { isPixivLoginUrl, mayNavigate, pixivCode, type PixivLoginResult } from "./pixiv-login-core"

// window.secretaryShell.pixivLogin (Settings → Plugins → Pixiv → Connect): pixiv's own login page in a window of the
// shell. The owner signs in there himself; the shell only watches the window's navigations for pixiv's callback and
// hands the authorization code back to her page. Each login gets a fresh in-memory session (no cookies kept), a
// sandboxed renderer without preload or Node, https pages only and no popups. URLs with a code are never logged.

const TIMEOUT_MS = 10 * 60_000

let active: { window: BrowserWindow; finish: (result: PixivLoginResult) => void } | undefined

function login(url: string): Promise<PixivLoginResult> {
  // One login window at a time: a second Connect replaces the first.
  active?.finish({ error: "cancelled" })

  return new Promise((resolve) => {
    const window = new BrowserWindow({
      width: 480,
      height: 760,
      parent: shellWindow(),
      title: "Sign in to pixiv",
      autoHideMenuBar: true,
      fullscreenable: false,
      show: false,
      webPreferences: {
        session: session.fromPartition(`pixiv-login-${randomUUID()}`),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
      },
    })
    let done = false
    const timer = setTimeout(() => finish({ error: "failed" }), TIMEOUT_MS)
    timer.unref()
    const finish = (result: PixivLoginResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (active?.window === window) active = undefined
      if (!window.isDestroyed()) window.destroy()
      resolve(result)
    }
    active = { window, finish }
    const contents = window.webContents
    // Every navigation, redirect included: take the code, or refuse anything that is not https.
    const watch = (event: { preventDefault(): void }, target: string) => {
      const code = pixivCode(target)
      if (code) {
        event.preventDefault()
        finish({ code })
      } else if (!mayNavigate(target)) {
        event.preventDefault()
      }
    }
    contents.on("will-navigate", (event) => watch(event, event.url))
    contents.on("will-redirect", (event) => watch(event, event.url))
    contents.on("will-frame-navigate", (event) => watch(event, event.url))
    contents.on("did-start-navigation", (event) => {
      const code = pixivCode(event.url)
      if (code) finish({ code })
    })
    contents.setWindowOpenHandler(() => ({ action: "deny" }))
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.once("ready-to-show", () => window.show())
    window.once("closed", () => finish({ error: "cancelled" }))
    contents.loadURL(url).catch(() => {
      // A navigation that ends in the pixiv:// redirect aborts the load; the watchers above have already finished.
      if (!done && contents.getURL() === "") finish({ error: "failed" })
    })
  })
}

/** Call once during startup. Only her web views (top frame, her origin) may ask. */
export function setupPixivLogin() {
  ipcMain.handle("secretary:pixiv-login", async (event, url: unknown): Promise<PixivLoginResult> => {
    if (!fromLucina(event)) return { error: "failed" }
    if (!isPixivLoginUrl(url)) return { error: "bad_url" }
    return login(url)
  })
}
