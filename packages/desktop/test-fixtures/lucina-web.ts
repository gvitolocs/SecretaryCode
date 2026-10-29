import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { mock } from "bun:test"

// A development app path whose resources/lucina-web holds a tiny build, with the server's page CSP recorded.
const appPath = await mkdtemp(path.join(tmpdir(), "lucina-web-app-"))
const dist = path.join(appPath, "resources", "lucina-web")
await mkdir(path.join(dist, "assets"), { recursive: true })
await mkdir(path.join(dist, "privacy"), { recursive: true })
await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Lucina</title>")
await writeFile(path.join(dist, "assets", "index-1.js"), "console.log(1)")
await writeFile(path.join(dist, "privacy", "index.html"), "privacy")
await writeFile(path.join(dist, "headers.json"), JSON.stringify({ contentSecurityPolicy: "default-src 'none'" }))

type Handler = (request: Request) => Promise<Response>
const passed: Array<{ url: string; options: unknown }> = []
const partition = {
  handler: undefined as Handler | undefined,
  protocol: {
    isProtocolHandled: () => partition.handler !== undefined,
    handle(scheme: string, handler: Handler) {
      assert.equal(scheme, "https")
      partition.handler = handler
    },
  },
  fetch: async (request: Request, options: unknown) => {
    passed.push({ url: request.url, options })
    return new Response("server")
  },
  cleared: [] as unknown[],
  clearStorageData: async (options: unknown) => {
    partition.cleared.push(options)
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
  // A Danish Mac, with Secretary Code on Automatic (so its language is Danish too, below).
  app: { isPackaged: false, getAppPath: () => appPath, getPreferredSystemLanguages: () => ["da-DK", "en-DK", "it-DK"] },
  net: {},
  session: { fromPartition },
  shell: { openExternal: external },
}))
mock.module("../src/main/native/translations", () => ({ nativeT: (key: string) => key, nativeLocale: () => "da" }))
const { lucinaWebView, navigateLucinaView } = await import("../src/main/secretary/lucina-web")

let release!: () => void
const signedIn = new Promise<void>((resolve) => (release = resolve))
const view = lucinaWebView("/", () => signedIn) as unknown as View
assert.equal(fromPartition.mock.calls[0]?.[0], "persist:lucina-web")
// Nothing loads before the web sign-in settled.
await Promise.resolve()
assert.deepEqual(view.webContents.urls, [])
release()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.deepEqual(view.webContents.urls, ["https://getsecretary.tech/"])
// An old service worker would answer that load with its cached page shell (routes to chunks this build lacks, an old
// CSP): every start drops the workers and their caches first.
assert.deepEqual(partition.cleared, [{ storages: ["serviceworkers", "cachestorage"] }])
// Automatic follows the Mac, so the page stays English from its first request instead of turning Danish.
assert.deepEqual(view.webContents.commands, [
  ["Emulation.setUserAgentOverride", { userAgent: "Secretary-Test", acceptLanguage: "en-US,en" }],
])

// The bundle answers the app's pages and files as getsecretary.tech; the API and unknown files reach the server.
const serve = (url: string, init?: RequestInit) => partition.handler!(new Request(url, init))
const route = await serve("https://getsecretary.tech/chats/device%3Aabc")
assert.equal(await route.text(), "<!doctype html><title>Lucina</title>")
assert.equal(route.headers.get("content-type"), "text/html; charset=utf-8")
const asset = await serve("https://getsecretary.tech/assets/index-1.js")
assert.equal(await asset.text(), "console.log(1)")
assert.match(asset.headers.get("cache-control") ?? "", /immutable/)
assert.equal(await (await serve("https://getsecretary.tech/privacy/")).text(), "privacy")
for (const url of [
  "https://getsecretary.tech/v1/timeline?scope=mine",
  "https://getsecretary.tech/assets/missing-2.js",
  "https://getsecretary.tech/assets/%2e%2e/%2e%2e/secret.txt",
  "https://maps.example.com/tile.png",
]) {
  assert.equal(await (await serve(url)).text(), "server", url)
}
assert.equal(await (await serve("https://getsecretary.tech/v1/chat", { method: "POST", body: "{}" })).text(), "server")
assert.equal(passed.length, 5)
// Lucina's API sends and stores the partition's cookies; another host keeps its own credentials mode.
assert.deepEqual(passed[0]?.options, { bypassCustomProtocolHandlers: true, credentials: "include" })
assert.deepEqual(passed[3]?.options, { bypassCustomProtocolHandlers: true })

// Bundled pages carry the server's CSP; the image viewer's adds the local file transport.
assert.equal(route.headers.get("content-security-policy"), "default-src 'none'")
assert.equal(route.headers.get("referrer-policy"), "no-referrer")
const viewer = await serve("https://getsecretary.tech/viewer")
assert.equal(viewer.headers.get("content-security-policy"), "default-src 'none'; img-src 'none' secretary-file:; connect-src 'none' secretary-file:")
assert.equal(asset.headers.get("content-security-policy"), null)

// A second view shares the configured partition instead of registering the handler again.
lucinaWebView("/chats")
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
const routed = lucinaWebView("/", () => pending, { preload: "/app/out/preload/lucina.cjs" }) as unknown as View
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
assert.deepEqual(routed.webContents.urls, ["https://getsecretary.tech/gallery?shell=1"])
assert.equal(routed.webContents.scripts.length, 0)

// A loaded Lucina page is routed with pushState and popstate, without a reload.
await navigateLucinaView(routed.webContents as never, "/chats?tab=all")
assert.deepEqual(routed.webContents.urls, ["https://getsecretary.tech/gallery?shell=1"])
assert.equal(routed.webContents.scripts.length, 1)
const script = routed.webContents.scripts[0]!
assert.ok(script.includes('history.pushState(null, "", path)'))
assert.ok(script.includes('const path = "/chats?tab=all"'))
assert.ok(script.includes('dispatchEvent(new PopStateEvent("popstate"))'))
assert.ok(script.includes('location.origin !== "https://getsecretary.tech"'))
// Routing to the open page is not skipped outright: her chat still hears the rail's Lucina item.
assert.ok(!script.includes("=== path) return"))
assert.ok(script.includes('if (path === "/") dispatchEvent(new CustomEvent("secretary:chat-latest"))'))

// No page yet, an error page or another origin: load the URL.
for (const current of ["", "about:blank", "data:text/html;charset=utf-8,x", "https://example.com/gallery"]) {
  routed.webContents.current = current
  const before = routed.webContents.urls.length
  const scripts = routed.webContents.scripts.length
  await navigateLucinaView(routed.webContents as never, "/films")
  assert.equal(routed.webContents.urls.length, before + 1, current)
  assert.equal(routed.webContents.urls.at(-1), "https://getsecretary.tech/films?shell=1")
  assert.equal(routed.webContents.scripts.length, scripts, current)
}

// A page that refuses the script (still loading, wrong origin) falls back to a load.
routed.webContents.current = "https://getsecretary.tech/"
routed.webContents.failScript = true
await navigateLucinaView(routed.webContents as never, "/health")
assert.equal(routed.webContents.urls.at(-1), "https://getsecretary.tech/health?shell=1")
