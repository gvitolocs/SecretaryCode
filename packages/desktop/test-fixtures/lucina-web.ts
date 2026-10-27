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
  loadURL = async (url: string) => {
    this.urls.push(url)
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
const { lucinaWebView } = await import("../src/main/secretary/lucina-web")

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
