import { app, session, shell, WebContentsView, type Session, type WebContents } from "electron"
import log from "electron-log/main.js"
import { existsSync } from "node:fs"
import { readFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { nativeT } from "../native/translations"
import { localImagePolicy } from "./image-viewer/policy"
import { bundlePath, contentType, isLucinaUrl, LUCINA_ORIGIN, LUCINA_PAGE_CSP, LUCINA_PARTITION } from "./lucina-web-policy"
import { audioOnly } from "./prompter-overlay-core"
import { withShellFlag } from "./shell-command"
import { applyWebLanguage } from "./web-session"

// Lucina's web app in Secretary Code: the same app as getsecretary.tech and the iPhone, so the Mac gets the synced
// chat (its own per-device conversation, cached in IndexedDB), All chats, the gallery, films and every plugin.
// The UI ships with the app (resources/lucina-web, built by scripts/bundle-lucina-web.ts on each app build) and is
// served as https://getsecretary.tech itself in the persist:lucina-web partition, so it opens offline while cookies,
// CSRF, the timeline stream and the computer view's WebSocket stay same-origin. /v1 and anything the bundle lacks go
// to the server with the partition's cookies. The Computer and image-viewer views share the partition, the bundled
// UI and the web sign-in.

let configured: Session | undefined
let workersCleared: Promise<void> | undefined

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

/**
 * Settles once the partition's service workers and their caches are gone (once per start); her views load after it.
 * Her web app's worker answered page loads from its own cache: an older page shell, whose routes point at chunks this
 * build no longer has (the rail's Gallery and Films did nothing, 2026-10-29) and whose CSP is old. The bundle is the
 * cache here.
 */
export function lucinaWebReady(web: Pick<Session, "clearStorageData"> = lucinaWebSession()): Promise<void> {
  return (workersCleared ??= web.clearStorageData({ storages: ["serviceworkers", "cachestorage"] }).catch(() => {}))
}

/** The shared partition, serving the bundled UI when the app has one. Safe to call more than once. */
export function lucinaWebSession() {
  if (configured) return configured
  const web = session.fromPartition(LUCINA_PARTITION)
  configured = web
  void lucinaWebReady(web)
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

// Her views that may use the microphone (Voice memos, Lucina Prompter): audio only, in their top frame, on her origin.
const microphone = new WeakSet<WebContents>()

export function allowMicrophone(contents: WebContents) {
  microphone.add(contents)
}

// Her views that may read the clipboard (her chat: Instagram's Paste, 2026-11-01): their top frame, on her origin.
const clipboardReaders = new WeakSet<WebContents>()

export function allowClipboardRead(contents: WebContents) {
  clipboardReaders.add(contents)
}

/** Whether a clipboard-read of the partition is one of those views' top page on her origin. */
export function clipboardReadGranted(contents: unknown, url: string, mainFrame: boolean) {
  return mainFrame && isLucinaUrl(url) && clipboardReaders.has(contents as WebContents)
}

/** Whether a media permission of the partition is one of those views asking for the microphone alone. */
export function microphoneGranted(contents: unknown, mediaTypes: readonly unknown[] | undefined, url: string, mainFrame: boolean) {
  return mainFrame && isLucinaUrl(url) && microphone.has(contents as WebContents) && audioOnly(mediaTypes)
}

// Where each view's first page goes, until that load has started. A route asked for before then replaces the path.
// A view the shell frames (it has the shell preload) loads its pages with ?shell=1.
const firstLoad = new WeakMap<WebContents, { path: string; started: boolean; shell: boolean }>()

/**
 * A warm view of Lucina's web app at `path` (the chat at "/"). It loads once `beforeLoad` settles (the web sign-in,
 * ensureWebSession), so the first page already has its session; the page speaks the app's language
 * (applyWebLanguage). Links elsewhere open in the default browser.
 * `preload` is the sandboxed script that gives her page `window.secretaryShell`.
 */
/**
 * The Mac's own context menu (Cut, Copy, Paste, Copy Image, Save Image As) in one of her views. electron-context-menu
 * attaches itself to windows only (lifecycle/environment.ts), so her views had no menu at all. Her page's own menus
 * (pictures, the Gallery) cancel the contextmenu event, and Chromium then sends the shell none.
 */
export function attachContextMenu(contents: WebContents) {
  void import("electron-context-menu")
    .then(({ default: contextMenu }) => {
      if (contents.isDestroyed()) return
      const dispose = contextMenu({ window: contents, showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })
      contents.once("destroyed", dispose)
    })
    .catch(() => {})
}

export function lucinaWebView(path: string, beforeLoad?: () => Promise<unknown>, options: { preload?: string } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      session: lucinaWebSession(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      ...(options.preload ? { preload: options.preload } : {}),
    },
  })
  const first = { path, started: false, shell: !!options.preload }
  firstLoad.set(view.webContents, first)
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
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:14px system-ui;padding:24px}a{color:inherit}</style><p>${escapeHTML(nativeT("desktop.lucina.loadFailed"))}</p><a href="${escapeHTML(url)}">${escapeHTML(nativeT("desktop.computer.retry"))}</a>`
    void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {})
  })
  applyWebLanguage(view.webContents)
  attachContextMenu(view.webContents)
  void Promise.resolve()
    .then(beforeLoad)
    .catch(() => {})
    .then(() => lucinaWebReady())
    .then(() => {
      first.started = true

      const page = `${LUCINA_ORIGIN}${first.path}`

      return view.webContents.loadURL(first.shell ? withShellFlag(page) : page)
    })
    .catch(() => {})
  return view
}

/**
 * Routes a Lucina web view to `path` (already validated) without a reload. Her router is @solidjs/router, which follows
 * history changes, so pushState plus a popstate event is enough once her app is loaded. Before the first load, in an error
 * page or on another origin the view loads the URL instead; a view that has not started loading just changes where it starts.
 */
export async function navigateLucinaView(contents: WebContents, path: string) {
  if (contents.isDestroyed()) return
  const first = firstLoad.get(contents)

  if (first && !first.started) {
    first.path = path

    return
  }

  const target = `${LUCINA_ORIGIN}${path}`
  const reload = () => contents.loadURL(first?.shell ? withShellFlag(target) : target).catch(() => {})

  if (!isLucinaUrl(contents.getURL())) return reload()
  const script = `(() => {
    if (location.origin !== ${JSON.stringify(LUCINA_ORIGIN)}) throw new Error("not Lucina")
    const path = ${JSON.stringify(path)}
    if (location.pathname + location.search !== path) {
      history.pushState(null, "", path)
      dispatchEvent(new PopStateEvent("popstate"))
    }
    // The rail's Lucina item: her chat lands on the newest message, also when it was already open.
    if (path === "/") dispatchEvent(new CustomEvent("secretary:chat-latest"))
  })()`

  await contents.executeJavaScript(script).catch(reload)
  // Each rail navigation in main.log, with what her page shows a moment later: a route that never loads (its chunk
  // missing) still shows the previous page's heading.
  log.info("lucina navigate", { path })
  const check = setTimeout(() => {
    if (contents.isDestroyed()) return
    void contents
      .executeJavaScript(`({ path: location.pathname + location.search, heading: (document.querySelector("h1, h2")?.textContent ?? "").trim().slice(0, 60) })`)
      .then((shown: unknown) => log.info("lucina navigate: shown", { path, shown }))
      .catch(() => {})
  }, 1500)
  check.unref?.()
}

function openExternal(value: string) {
  if (URL.canParse(value) && new URL(value).protocol === "https:") void shell.openExternal(value)
}

function escapeHTML(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
}
