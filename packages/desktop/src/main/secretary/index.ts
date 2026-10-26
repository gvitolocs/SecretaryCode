import { app, BrowserWindow, ipcMain, protocol, safeStorage } from "electron"
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import page from "../../renderer/secretary/index.html?raw"
import style from "../../renderer/secretary/style.css?raw"
import client from "../../renderer/secretary/client.mjs?raw"
import stagePage from "../../renderer/secretary/stage.html?raw"
import stageHost from "../../renderer/secretary/stage-host.mjs?raw"
import stageBundle from "../../renderer/secretary/lucina-stage.standalone.js?raw"
import copy from "../../renderer/secretary/en.json"

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
const state: { window?: BrowserWindow; token?: string; registered: boolean; ready?: Promise<void> } = { registered: false }

function credentialFile() { return join(app.getPath("userData"), "secretary-device.enc") }

async function request(path: string, method = "GET", body?: unknown, authenticated = true) {
  for (const origin of origins) {
    const response = await fetch(origin + path, {
      method,
      headers: { ...(authenticated && state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), "X-Secretary-Client": "macos" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(path === "/v1/chat" ? 180000 : 60000),
    }).catch(() => undefined)
    if (!response) continue
    if (!response.ok) {
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
    return { authenticated: true }
  }
  if (action === "signOut") {
    state.token = undefined
    await unlink(credentialFile()).catch(() => undefined)
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

/** Call once before app.ready to register the private, token-free renderer origin. */
export function setupSecretary() {
  if (state.registered) return
  state.registered = true
  protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
  state.ready = app.whenReady().then(async () => {
    const encrypted = await readFile(credentialFile()).catch(() => undefined)
    if (encrypted && safeStorage.isEncryptionAvailable()) {
      try { state.token = safeStorage.decryptString(encrypted) } catch { /* A restored credential may belong to another Keychain. */ }
    }
    protocol.handle(scheme, async incoming => {
      const url = new URL(incoming.url)
      if (url.hostname !== "app") return new Response(null, { status: 404 })
      const file = files.get(url.pathname)
      const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
      if (file) return new Response(file.data, { headers: { "Content-Type": file.type, "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff" } })
      if (url.pathname.startsWith("/v1/assets/")) {
        const name = url.pathname.slice("/v1/assets/".length)
        if (!state.token || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name) || name.includes("..")) return new Response(null, { status: 404 })
        try {
          const response = await request(`/v1/assets/${name}`)
          return new Response(await response.arrayBuffer(), { headers: { "Content-Type": response.headers.get("content-type") || "application/octet-stream", "Cache-Control": "private, max-age=3600" } })
        } catch { return new Response(null, { status: 502 }) }
      }
      return new Response(null, { status: 404 })
    })
    ipcMain.handle("secretary:request", async (event, action: unknown, input: unknown) => {
      if (!state.window || event.sender !== state.window.webContents || event.senderFrame?.url !== `${scheme}://app/index.html`) return { ok: false, error: "invalidRequest" }
      try { return { ok: true, data: await perform(typeof action === "string" ? action : "", input) } }
      catch (error) { return { ok: false, error: error instanceof Error && Object.hasOwn(copy, error.message) ? error.message : "serverError" } }
    })
  })
}

/** The main coding window stays intact; Lucina opens beside it with its own isolated renderer. */
export async function openSecretaryWindow() {
  if (!state.registered) throw new Error("Call setupSecretary before app.ready")
  await state.ready
  if (state.window && !state.window.isDestroyed()) { state.window.show(); state.window.focus(); return state.window }
  const window = new BrowserWindow({
    width: 480, height: 860, minWidth: 390, minHeight: 640, title: "Secretary Code · Lucina", titleBarStyle: "hiddenInset", backgroundColor: "#000000", show: false,
    webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  })
  state.window = window
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, url) => { if (url !== `${scheme}://app/index.html`) event.preventDefault() })
  window.once("ready-to-show", () => window.show())
  window.on("closed", () => { state.window = undefined })
  await window.loadURL(`${scheme}://app/index.html`)
  return window
}
