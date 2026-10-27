import { app, WebContentsView, ipcMain, protocol, safeStorage } from "electron"
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import icon from "./icon-data"
import { reloadComputerView } from "./computer-view"
import { endWebSession, ensureWebSession, setWebSessionToken } from "./web-session"
import page from "../../renderer/secretary/index.html?raw"
import style from "../../renderer/secretary/style.css?raw"
import client from "../../renderer/secretary/client.mjs?raw"
import stagePage from "../../renderer/secretary/stage.html?raw"
import stageHost from "../../renderer/secretary/stage-host.mjs?raw"
import stageBundle from "../../renderer/secretary/lucina-stage.standalone.js?raw"
import copy from "../../renderer/secretary/en.json"
import { lucinaWebView, navigateLucinaView } from "./lucina-web"

const scheme = "secretary-companion"
const origins = ["https://getsecretary.tech", "https://secretary-p1.tail75dcfc.ts.net"]
const files = new Map([
  ["/index.html", { data: page, type: "text/html" }],
  ["/style.css", { data: style, type: "text/css" }],
  ["/client.mjs", { data: client, type: "text/javascript" }],
  ["/en.json", { data: JSON.stringify(copy), type: "application/json" }],
  ["/stage.html", { data: stagePage, type: "text/html" }],
  ["/stage-host.mjs", { data: stageHost, type: "text/javascript" }],
  ["/lucina-stage.standalone.js", { data: stageBundle, type: "text/javascript" }],
])
const state: { view?: WebContentsView; token?: string; registered: boolean; ready?: Promise<void>; path?: string } = { registered: false }

function credentialFile() { return join(app.getPath("userData"), "secretary-device.enc") }

async function request(path: string, method = "GET", body?: unknown, authenticated = true, extraHeaders: Record<string, string> = {}) {
  for (const origin of origins) {
    const response = await fetch(origin + path, {
      method,
      headers: { ...(authenticated && state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), "X-Secretary-Client": "web", ...extraHeaders },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(path === "/v1/chat" || path.startsWith("/v1/assets/") ? 180000 : 60000),
    }).catch(() => undefined)
    if (!response) continue
    if (!response.ok && response.status !== 304) {
      if (response.status === 401) throw new Error("signInRequired")
      if (response.status === 429) throw new Error("rateLimited")
      throw new Error("serverError")
    }
    return response
  }
  throw new Error("connectionError")
}

async function json(path: string, method = "GET", body?: unknown, authenticated = true): Promise<unknown> {
  return (await request(path, method, body, authenticated)).json()
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalidRequest")
  return value as Record<string, unknown>
}

async function perform(action: string, input: unknown): Promise<unknown> {
  if (action === "status") {
    if (!state.token) return { authenticated: false }
    return json("/v1/session")
  }
  if (action === "health") return json("/v1/health", "GET", undefined, false)
  if (action === "signIn") {
    const data = object(input)
    if (typeof data.email !== "string" || typeof data.password !== "string" || data.email.length > 254 || data.password.length > 4096) throw new Error("invalidRequest")
    if (!safeStorage.isEncryptionAvailable()) throw new Error("keychainUnavailable")
    const result = object(await json("/v1/auth/device", "POST", { email: data.email.trim(), password: data.password, deviceName: "Secretary Code · Mac" }, false))
    if (typeof result.token !== "string" || !result.token.startsWith("sec_")) throw new Error("serverError")
    await mkdir(app.getPath("userData"), { recursive: true })
    // One credential is encrypted by the macOS Keychain-backed Electron safeStorage, separate from application data.
    await writeFile(credentialFile(), safeStorage.encryptString(result.token), { mode: 0o600 })
    state.token = result.token
    // The embedded Lucina pages share this sign-in.
    void ensureWebSession().then((signedIn) => {
      if (signedIn !== "ok") return
      reloadComputerView()
      if (state.view && !state.view.webContents.isDestroyed()) state.view.webContents.reload()
    })
    return { authenticated: true }
  }
  if (action === "signOut") {
    state.token = undefined
    await unlink(credentialFile()).catch(() => undefined)
    // Signing the device out signs the embedded Lucina pages out too.
    await endWebSession()
    reloadComputerView()
    if (state.view && !state.view.webContents.isDestroyed()) state.view.webContents.reload()
    return { authenticated: false }
  }
  if (!state.token) throw new Error("signInRequired")
  if (action === "chat") {
    const data = object(input)
    if (typeof data.message !== "string" || !data.message.trim() || data.message.length > 16000 || typeof data.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.sessionId) || typeof data.clientMessageId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.clientMessageId)) throw new Error("invalidRequest")
    return json("/v1/chat", "POST", data)
  }
  if (action === "timeline") return json("/v1/timeline?limit=40")
  if (action === "wardrobe") return json("/v1/avatar/wardrobe")
  if (action === "avatar") return json("/v1/avatar")
  if (action === "job") {
    if (typeof input !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input)) throw new Error("invalidRequest")
    return json(`/v1/jobs/${input}`)
  }
  if (action === "tts") {
    if (typeof input !== "string" || input.length < 1 || input.length > 1200) throw new Error("invalidRequest")
    return Array.from(new Uint8Array(await (await request("/v1/tts", "POST", { text: input })).arrayBuffer()))
  }
  if (action === "setAvatar") {
    const data = object(input)
    const allowed = ["outfit", "hair", "hairColor", "pinned"]
    if (Object.keys(data).some(key => !allowed.includes(key)) || Object.values(data).some(value => value !== null && typeof value !== "boolean" && (typeof value !== "string" || !/^[a-z0-9_-]{1,40}$/.test(value)))) throw new Error("invalidRequest")
    return json("/v1/avatar", "PUT", data)
  }
  throw new Error("invalidRequest")
}

/** The signed-in Secretary device token, shared with the meeting recorder's uploads. */
export async function secretaryToken() {
  await state.ready
  return state.token
}

/** Compose once during startup; windows/scheme centrally registers privileged schemes before ready. */
export function setupSecretary() {
  if (state.registered) return
  state.registered = true
  setWebSessionToken(secretaryToken)
  state.ready = app.whenReady().then(async () => {
    const encrypted = await readFile(credentialFile()).catch(() => undefined)
    if (encrypted && safeStorage.isEncryptionAvailable()) {
      try { state.token = safeStorage.decryptString(encrypted) } catch { /* A restored credential may belong to another Keychain. */ }
    }
    protocol.handle(scheme, async incoming => {
      const url = new URL(incoming.url)
      if (url.hostname !== "app") return new Response(null, { status: 404 })
      if (url.pathname === "/icon.png") return new Response(Buffer.from(icon, "base64"), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } })
      const file = files.get(url.pathname)
      const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
      if (file) return new Response(file.data, { headers: { "Content-Type": file.type, "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff" } })
      if (url.pathname.startsWith("/v1/assets/")) {
        const name = url.pathname.slice("/v1/assets/".length)
        if (!state.token || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name) || name.includes("..")) return new Response(null, { status: 404 })
        const directory = join(app.getPath("userData"), "secretary-assets")
        const cached = await readFile(join(directory, name)).catch(() => undefined)
        const etag = cached ? await readFile(join(directory, name + ".etag"), "utf8").catch(() => undefined) : undefined
        const type = name.endsWith(".json") ? "application/json" : name.endsWith(".glb") ? "model/gltf-binary" : name.endsWith(".png") ? "image/png" : "application/octet-stream"
        try {
          const response = await request(`/v1/assets/${name}`, "GET", undefined, true, etag ? { "If-None-Match": etag } : {})
          const data = response.status === 304 && cached ? cached : Buffer.from(await response.arrayBuffer())
          if (response.status !== 304) {
            await mkdir(directory, { recursive: true, mode: 0o700 })
            await writeFile(join(directory, name), data, { mode: 0o600 })
            const tag = response.headers.get("etag")
            if (tag) await writeFile(join(directory, name + ".etag"), tag, { mode: 0o600 })
          }
          return new Response(data, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" } })
        } catch (error) {
          if (cached && error instanceof Error && error.message === "connectionError") return new Response(cached, { headers: { "Content-Type": type } })
          return new Response(null, { status: 502 })
        }
      }
      return new Response(null, { status: 404 })
    })
    ipcMain.handle("secretary:request", async (event, action: unknown, input: unknown) => {
      if (!state.view || event.sender !== state.view.webContents || event.senderFrame?.url !== `${scheme}://app/index.html`) return { ok: false, error: "invalidRequest" }
      try { return { ok: true, data: await perform(typeof action === "string" ? action : "", input) } }
      catch (error) { return { ok: false, error: error instanceof Error && Object.hasOwn(copy, error.message) ? error.message : "serverError" } }
    })
  })
}

/** The Lucina panel's view: Lucina's web app (chat, All chats, gallery, films, plugins), created on first use and kept
 * warm while the companion panel is hidden. */
export function lucinaView() {
  if (!state.registered) throw new Error("Call setupSecretary before app.ready")
  if (state.view && !state.view.webContents.isDestroyed()) return state.view
  // The stored token is read at startup; then the partition gets its cookie session before the first load.
  // A path asked for before the view existed (see openLucinaPath) is where it starts.
  const view = lucinaWebView(
    "/",
    async () => {
      await state.ready
      await ensureWebSession()
    },
    { preload: join(import.meta.dirname, "../preload/lucina.cjs") },
  )
  if (state.path) void navigateLucinaView(view.webContents, state.path)
  state.path = undefined
  state.view = view
  view.webContents.once("destroyed", () => { if (state.view === view) state.view = undefined })
  return view
}

/** The Lucina view's webContents while it exists. Never creates the view. */
export function lucinaWebContents() {
  return state.view && !state.view.webContents.isDestroyed() ? state.view.webContents : undefined
}

/** Routes Lucina's warm view to `path` without a reload; without a view yet, the first load goes there. */
export function openLucinaPath(path: string) {
  const contents = lucinaWebContents()

  if (contents) void navigateLucinaView(contents, path)
  else state.path = path
}
