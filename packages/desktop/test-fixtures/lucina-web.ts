import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mock } from "bun:test"

type HeadersListener = (
  details: { url: string; requestHeaders: Record<string, string> },
  callback: (response: { requestHeaders: Record<string, string> }) => void,
) => void
const partition = {
  filter: undefined as { urls: string[] } | undefined,
  listener: undefined as HeadersListener | undefined,
  webRequest: {
    onBeforeSendHeaders(filter: { urls: string[] }, listener: HeadersListener) {
      partition.filter = filter
      partition.listener = listener
    },
  },
}
class Contents extends EventEmitter {
  urls: string[] = []
  commands: [string, unknown][] = []
  // Like Electron before the view's first page: the command does not settle, so the load must not wait for it.
  debugger = {
    attached: false,
    isAttached: () => this.debugger.attached,
    attach: () => {
      this.debugger.attached = true
    },
    sendCommand: (method: string, params: unknown) => {
      this.commands.push([method, params])
      return new Promise<never>(() => {})
    },
  }
  getUserAgent = () => "Secretary-Test"
  current = ""
  scripts: string[] = []
  failScript = false
  isDestroyed = () => false
  getURL = () => this.current
  executeJavaScript = async (script: string) => {
    this.scripts.push(script)
    if (this.failScript) throw new Error("no page")
  }
  loadURL = async (url: string) => {
    this.urls.push(url)
    this.current = url
  }
  open: ((details: { url: string }) => { action: string }) | undefined
  setWindowOpenHandler(handler: NonNullable<Contents["open"]>) {
    this.open = handler
  }
}
class View {
  webContents = new Contents()
  setBackgroundColor = mock(() => {})
  constructor(readonly options: unknown) {}
}
const external = mock(async (_url: string) => {})
const fromPartition = mock((_name: string) => partition)
mock.module("electron", () => ({
  WebContentsView: View,
  net: {},
  session: { fromPartition },
  shell: { openExternal: external },
}))
mock.module("../src/main/native/translations", () => ({ nativeT: (key: string) => key, nativeLocale: () => "da" }))
const { lucinaWebView, navigateLucinaView } = await import("../src/main/secretary/lucina-web")

let token: string | undefined
let release!: () => void
const ready = new Promise<void>((resolve) => (release = resolve))
const view = lucinaWebView("/", () => token, ready) as unknown as View
assert.equal(fromPartition.mock.calls[0]?.[0], "persist:lucina-web")
assert.deepEqual(partition.filter, { urls: ["https://getsecretary.tech/*"] })
// Nothing loads before the stored token was read.
await Promise.resolve()
assert.deepEqual(view.webContents.urls, [])
token = "sec_mac"
release()
await ready
await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(view.webContents.urls, ["https://getsecretary.tech/"])
// The page follows the app's language (Danish here), not the Mac locale, from its first request.
assert.deepEqual(view.webContents.commands, [
  ["Emulation.setUserAgentOverride", { userAgent: "Secretary-Test", acceptLanguage: "da,en" }],
])

// The token is read per request, so a later sign-in applies without a reload.
let headers: Record<string, string> | undefined
partition.listener!({ url: "https://getsecretary.tech/v1/timeline?scope=mine", requestHeaders: {} }, (r) => (headers = r.requestHeaders))
assert.deepEqual(headers, { Authorization: "Bearer sec_mac" })

// A second view shares the configured partition instead of adding another listener.
lucinaWebView("/chats", () => token)
assert.equal(fromPartition.mock.calls.length, 1)

// Top-level navigation stays on Lucina; anything else opens in the browser (https only).
const blocked = { url: "https://example.com/", isMainFrame: true, prevented: false, preventDefault() { this.prevented = true } }
view.webContents.emit("will-frame-navigate", blocked)
assert.equal(blocked.prevented, true)
assert.equal(external.mock.calls[0]?.[0], "https://example.com/")
const allowed = { url: "https://getsecretary.tech/chats", isMainFrame: true, prevented: false, preventDefault() { this.prevented = true } }
view.webContents.emit("will-frame-navigate", allowed)
assert.equal(allowed.prevented, false)
assert.deepEqual(view.webContents.open!({ url: "javascript:alert(1)" }), { action: "deny" })
assert.equal(external.mock.calls.length, 1)

// Routing: a view that has not started loading just starts at the new path, with the shell preload attached.
let gate!: () => void
const pending = new Promise<void>((resolve) => (gate = resolve))
const routed = lucinaWebView("/", () => token, pending, { preload: "/app/out/preload/lucina.cjs" }) as unknown as View
assert.deepEqual(routed.options, {
  webPreferences: {
    session: partition,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    preload: "/app/out/preload/lucina.cjs",
  },
})
await navigateLucinaView(routed.webContents as never, "/gallery")
assert.deepEqual(routed.webContents.urls, [])
gate()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(routed.webContents.urls, ["https://getsecretary.tech/gallery"])
assert.equal(routed.webContents.scripts.length, 0)

// A loaded Lucina page is routed with pushState and popstate, without a reload.
await navigateLucinaView(routed.webContents as never, "/chats?tab=all")
assert.deepEqual(routed.webContents.urls, ["https://getsecretary.tech/gallery"])
assert.equal(routed.webContents.scripts.length, 1)
const script = routed.webContents.scripts[0]!
assert.ok(script.includes('history.pushState(null, "", path)'))
assert.ok(script.includes('const path = "/chats?tab=all"'))
assert.ok(script.includes('dispatchEvent(new PopStateEvent("popstate"))'))
assert.ok(script.includes('location.origin !== "https://getsecretary.tech"'))

// No page yet, an error page or another origin: load the URL.
for (const current of ["", "about:blank", "data:text/html;charset=utf-8,x", "https://example.com/gallery"]) {
  routed.webContents.current = current
  const before = routed.webContents.urls.length
  const scripts = routed.webContents.scripts.length
  await navigateLucinaView(routed.webContents as never, "/films")
  assert.equal(routed.webContents.urls.length, before + 1, current)
  assert.equal(routed.webContents.urls.at(-1), "https://getsecretary.tech/films")
  assert.equal(routed.webContents.scripts.length, scripts, current)
}

// A page that refuses the script (still loading, wrong origin) falls back to a load.
routed.webContents.current = "https://getsecretary.tech/"
routed.webContents.failScript = true
await navigateLucinaView(routed.webContents as never, "/health")
assert.equal(routed.webContents.urls.at(-1), "https://getsecretary.tech/health")
