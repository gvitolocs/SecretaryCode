import { execFile } from "node:child_process"
import { hostname } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { app, BrowserWindow, safeStorage, screen, session, shell } from "electron"
import { nativeT } from "../../native/translations"
import { deviceID } from "./device"
import { ImageFiles, folderImages } from "./files"
import { localImagePolicy } from "./policy"
import { imageType } from "./formats"
import { applyWebLanguage, ensureWebSession } from "../web-session"

const run = promisify(execFile)
const origin = "https://getsecretary.tech"
const partition = "persist:lucina-web"
const files = new ImageFiles()
const windows = new Map<BrowserWindow, string>()

export function previewFocusedImage() {
  const window = BrowserWindow.getFocusedWindow()
  const file = window && windows.get(window)
  if (file) void preview(file)
}

export function hasFocusedImage() {
  const window = BrowserWindow.getFocusedWindow()
  return !!window && windows.has(window)
}

/** Called once, after ready. The cookie partition is shared with sign-in in viewer windows. */
export function setupImageViewer() {
  const web = session.fromPartition(partition)
  // The hosted page currently limits images and fetches to self/blob/data. Grant only our image scheme.
  web.webRequest.onHeadersReceived({ urls: [`${origin}/viewer*`] }, (details, done) => {
    const headers = details.responseHeaders ?? {}
    Object.keys(headers)
      .filter((key) => key.toLowerCase() === "content-security-policy")
      .forEach((key) => {
        headers[key] = headers[key].map(localImagePolicy)
      })
    done({ responseHeaders: headers })
  })
  web.protocol.handle("secretary-file", (request) => files.handle(request))
  // Start lazily: a locked Keychain must never prevent local viewing.
  let identity: ReturnType<typeof device> | undefined
  return (paths: string[]) => {
    const images = paths.filter((file) => imageType(file))
    const raw = images.filter((file) => imageType(file)?.uti === "public.camera-raw-image")
    raw.forEach((file) => void preview(file))
    const clicked = images.find((file) => imageType(file)?.uti !== "public.camera-raw-image")
    if (!clicked) return
    identity ??= device()
    void openViewer(clicked, identity).catch((error) => console.error("Image viewer failed", error))
  }
}

async function device() {
  const id = await deviceID(app.getPath("userData"), safeStorage).catch((error) => {
    console.error("Image viewer device identity unavailable", error)
  })
  const name = await run("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2000 })
    .then((result) => result.stdout.trim())
    .catch(() => "")
  return id ? { id, name: name || hostname(), kind: "mac" } : undefined
}

async function preview(file: string) {
  // No shell expansion: Finder names are passed as one argument, including spaces and quotes.
  await run("/usr/bin/open", ["-a", "Preview", path.resolve(file)]).catch((error) =>
    console.error("Open with Preview failed", error),
  )
}

async function openViewer(clicked: string, identity: ReturnType<typeof device>) {
  const listing = await folderImages(path.resolve(clicked))
  const token = files.add(listing.folder, "")
  const local = `secretary-file://${token}/__viewer__/index.html`
  const close = `secretary-file://${token}/__close__`
  const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const window = new BrowserWindow({
    x: Math.round(work.x + work.width * 0.1),
    y: Math.round(work.y + work.height * 0.1),
    width: Math.round(work.width * 0.8),
    height: Math.round(work.height * 0.8),
    title: path.basename(clicked),
    backgroundColor: "#000000",
    webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  // The fallback contains no script or external assets. Only the selected local image and sign-in.
  files.setFallback(
    token,
    fallback(
      `secretary-file://${token}/__viewer__/display/${encodeURIComponent(path.basename(clicked))}`,
      path.basename(clicked),
    ),
  )
  windows.set(window, clicked)
  window.once("closed", () => {
    files.drop(token)
    windows.delete(window)
  })
  window.on("page-title-updated", (event) => {
    event.preventDefault()
    window.setTitle(path.basename(clicked))
  })
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.meta && input.shift && input.key.toLowerCase() === "p") {
      event.preventDefault()
      void preview(clicked)
    }
    if (input.type === "keyDown" && input.key === "Escape" && window.webContents.getURL() === local) window.close()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (URL.canParse(url) && new URL(url).protocol === "https:") void shell.openExternal(url)
    return { action: "deny" }
  })
  const guard = (event: Electron.Event, url: string) => {
    if (url === close) {
      event.preventDefault()
      window.close()
      return
    }
    if (!URL.canParse(url) || new URL(url).origin !== origin) event.preventDefault()
  }
  window.webContents.on("will-navigate", guard)
  window.webContents.on("will-redirect", guard)
  let localLoading = false
  const showLocal = () => {
    if (window.isDestroyed() || localLoading || window.webContents.getURL() === local) return
    localLoading = true
    void window.loadURL(local)
      .catch((error) => console.error("Local image failed", error))
      .finally(() => { localLoading = false })
  }
  const timer = setTimeout(showLocal, 10_000)
  window.once("closed", () => clearTimeout(timer))
  window.webContents.on("did-fail-load", (_event, _code, _description, url, mainFrame) => {
    if (mainFrame && url !== local) {
      clearTimeout(timer)
      showLocal()
    }
  })
  window.webContents.on("did-finish-load", () => {
    const url = window.webContents.getURL()
    if (url === local || !url.startsWith(`${origin}/viewer`)) return
    void identity
      .then(async (device) => {
        if (window.isDestroyed() || window.webContents.getURL() !== url) return
        const payload = listing.files.map((file) => ({ ...file, url: files.url(token, file.name) }))
        await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { window.removeEventListener('lucinaviewer:ready', ready); reject(new Error('Viewer unavailable')) }, 8000);
        async function ready() {
          if (!window.lucinaViewer) return;
          clearTimeout(timeout);
          window.removeEventListener('lucinaviewer:ready', ready);
          window.addEventListener('lucinaviewer:close', () => { location.href = ${JSON.stringify(close)} }, { once: true });
          try {
            const session = await fetch('/v1/session', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) }).then(response => response.json());
            if (session?.authenticated !== true) throw new Error('Lucina sign-in required');
            const device = ${JSON.stringify(device ?? null)};
            if (device) window.lucinaViewer.setDevice(device);
            if (window.lucinaViewer.open(${JSON.stringify(payload)}, ${listing.startIndex}, { device }) === false) throw new Error('Image unavailable');
            resolve(true);
          } catch (error) { reject(error) }
        }
        window.addEventListener('lucinaviewer:ready', ready);
        ready();
      })`)
        clearTimeout(timer)
      })
      .catch(() => {
        clearTimeout(timer)
        showLocal()
      })
  })
  // Same sign-in and language as the other Lucina views; ensureWebSession always settles, so the page still loads.
  applyWebLanguage(window.webContents)
  void ensureWebSession()
    .then(() => window.loadURL(`${origin}/viewer`))
    .catch(() => {
      clearTimeout(timer)
      showLocal()
    })
}

function fallback(url: string, name: string) {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(name)}</title><style>html,body{margin:0;background:#000;color:#ddd;font:14px system-ui;height:100%}body{display:flex;flex-direction:column}img{min-height:0;flex:1;object-fit:contain;width:100%}footer{padding:16px}a{color:#9cf;margin-left:16px}</style></head><body><img src="${escape(url)}" alt="${escape(name)}"><footer>${escape(nativeT("desktop.imageViewer.local"))}<a href="${origin}/">${escape(nativeT("desktop.imageViewer.signIn"))}</a></footer></body></html>`
}
