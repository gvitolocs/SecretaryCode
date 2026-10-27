import { app, session, shell, WebContentsView, type Session } from "electron"
import { existsSync } from "node:fs"
import { readFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { nativeT } from "../native/translations"
import { localImagePolicy } from "./image-viewer/policy"
import { bundlePath, contentType, isLucinaUrl, LUCINA_ORIGIN, LUCINA_PAGE_CSP, LUCINA_PARTITION } from "./lucina-web-policy"
import { applyWebLanguage } from "./web-session"

// Lucina's web app in Secretary Code: the same app as getsecretary.tech and the iPhone, so the Mac gets the synced
// chat (its own per-device conversation, cached in IndexedDB), All chats, the gallery, films and every plugin.
// The UI ships with the app (resources/lucina-web, built by scripts/bundle-lucina-web.ts on each app build) and is
// served as https://getsecretary.tech itself in the persist:lucina-web partition, so it opens offline while cookies,
// CSRF, the timeline stream and the computer view's WebSocket stay same-origin. /v1 and anything the bundle lacks go
// to the server with the partition's cookies. The Computer and image-viewer views share the partition, the bundled
// UI and the web sign-in.

let configured: Session | undefined

function bundleDir() {
  return app.isPackaged ? join(process.resourcesPath, "lucina-web") : join(app.getAppPath(), "resources", "lucina-web")
}

async function isFile(file: string) {
  return stat(file).then((s) => s.isFile()).catch(() => false)
}

/** The page CSP the server sent when the bundle was built, else the known one. */
function pageCsp(dir: string) {
  try {
    const recorded = JSON.parse(readFileSync(join(dir, "headers.json"), "utf8")) as { contentSecurityPolicy?: unknown }
    if (typeof recorded.contentSecurityPolicy === "string" && recorded.contentSecurityPolicy) return recorded.contentSecurityPolicy
  } catch {
    // No recorded headers (an offline build): the known policy applies.
  }
  return LUCINA_PAGE_CSP
}

/** The bundled response for `request`, or undefined when the server must answer it. */
async function bundled(dir: string, csp: string, request: Request) {
  const relative = bundlePath(request.url, request.method)
  if (relative === undefined) return undefined
  const direct = relative ? join(dir, relative) : join(dir, "index.html")
  const folder = join(dir, relative, "index.html")
  // A file of the build, a static page's folder (/privacy/), or the app shell for any route without an extension.
  const file = (await isFile(direct))
    ? direct
    : (await isFile(folder))
      ? folder
      : /\.[A-Za-z0-9]+$/.test(relative)
        ? undefined
        : join(dir, "index.html")
  if (!file) return undefined
  const body = request.method === "HEAD" ? null : await readFile(file)
  const headers: Record<string, string> = {
    "Content-Type": contentType(file),
    // Hashed build output never changes; everything else follows the bundle.
    "Cache-Control": file.includes(`${join(dir, "assets")}`) ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  }
  if (file.endsWith(".html")) {
    // The server's page headers; the image viewer also reads the Mac's files through secretary-file:.
    headers["Content-Security-Policy"] = relative === "viewer" || relative.startsWith("viewer/") ? localImagePolicy(csp) : csp
    headers["Referrer-Policy"] = "no-referrer"
  }
  return new Response(body, { headers })
}

/** The shared partition, serving the bundled UI when the app has one. Safe to call more than once. */
export function lucinaWebSession() {
  if (configured) return configured
  const web = session.fromPartition(LUCINA_PARTITION)
  configured = web
  const dir = bundleDir()
  // Without a bundle (a build with SECRETARY_SKIP_LUCINA_WEB=1) the views load the web app live.
  if (existsSync(join(dir, "index.html")) && !web.protocol.isProtocolHandled("https")) {
    const csp = pageCsp(dir)
    web.protocol.handle("https", async (request) => {
      const local = await bundled(dir, csp, request).catch(() => undefined)
      if (local) return local
      // Lucina's API keeps the partition's cookies both ways: sent with the request, Set-Cookie stored (sign-in,
      // sign-out, refresh). Other hosts keep the page's own credentials mode.
      return web.fetch(request, {
        bypassCustomProtocolHandlers: true,
        ...(isLucinaUrl(request.url) ? { credentials: "include" as const } : {}),
      })
    })
  }
  return web
}

/**
 * A warm view of Lucina's web app at `path` (the chat at "/"). It loads once `beforeLoad` settles (the web sign-in,
 * ensureWebSession), so the first page already has its session; the page speaks the app's language
 * (applyWebLanguage). Links elsewhere open in the default browser.
 */
export function lucinaWebView(path: string, beforeLoad?: () => Promise<unknown>) {
  const page = `${LUCINA_ORIGIN}${path}`
  const view = new WebContentsView({
    webPreferences: { session: lucinaWebSession(), contextIsolation: true, sandbox: true, nodeIntegration: false },
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
  void Promise.resolve()
    .then(beforeLoad)
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
