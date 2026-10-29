import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mock } from "bun:test"
import type { Session, WebContents } from "electron"

const partition = {
  check: undefined as NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]> | undefined,
  request: undefined as NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]> | undefined,
  setPermissionCheckHandler(handler: NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>) {
    this.check = handler
  },
  setPermissionRequestHandler(handler: NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>) {
    this.request = handler
  },
  // Already signed in: the Computer tab must not trade the device token again.
  fetch: mock(async (_url: string) => Response.json({ authenticated: true })),
  cookies: { set: mock(async () => {}) },
}
const netFetch = mock(async () => new Response(null, { status: 500 }))
class Contents extends EventEmitter {
  destroyed = false
  urls: string[] = []
  commands: [string, unknown][] = []
  debugger = {
    attached: false,
    isAttached: () => this.debugger.attached,
    attach: () => {
      this.debugger.attached = true
    },
    // Like Electron before the view's first page: the command does not settle, so the load must not wait for it.
    sendCommand: (method: string, params: unknown) => {
      this.commands.push([method, params])
      return new Promise<never>(() => {})
    },
  }
  getUserAgent = () => "Secretary-Test"
  sent: [string, unknown][] = []
  send(channel: string, payload: unknown) {
    this.sent.push([channel, payload])
  }
  focus = mock(() => {})
  getZoomFactor = () => 1
  isDestroyed = () => this.destroyed
  loadURL = async (url: string) => {
    this.urls.push(url)
  }
  open: ((details: { url: string }) => { action: string }) | undefined
  setWindowOpenHandler(handler: NonNullable<Contents["open"]>) {
    this.open = handler
  }
  close() {
    this.destroyed = true
    this.emit("destroyed")
  }
}
class View {
  webContents = new Contents()
  setBounds = mock(() => {})
  setBorderRadius = mock(() => {})
  constructor(readonly options: unknown) {}
}
const window = Object.assign(new EventEmitter(), {
  isDestroyed: () => false,
  webContents: Object.assign(new EventEmitter(), {
    sent: [] as [string, unknown][],
    send(channel: string, payload: unknown) {
      this.sent.push([channel, payload])
    },
  }),
  contentView: {
    children: [] as View[],
    addChildView(view: View) {
      this.children.push(view)
    },
    removeChildView(view: View) {
      this.children = this.children.filter((item) => item !== view)
    },
  },
})
const ipc = Object.assign(new EventEmitter(), { handle: () => {} })
const external = mock(async (_url: string) => {})
const fromPartition = mock((_name: string) => partition)
mock.module("electron", () => ({
  WebContentsView: View,
  app: { getPreferredSystemLanguages: () => ["da-DK", "en-DK"] },
  BrowserWindow: { fromWebContents: () => window },
  ipcMain: ipc,
  net: { fetch: netFetch },
  protocol: {},
  session: { fromPartition },
  shell: { openExternal: external },
}))
mock.module("electron-log/main.js", () => ({ default: { info: () => {} } }))
mock.module("../src/main/secretary/index", () => ({
  lucinaView: () => new View({}),
  lucinaWebContents: () => undefined,
  openLucinaPath: () => {},
  forgetDevice: async () => {},
}))
mock.module("../src/main/secretary/lane-window", () => ({ codingLanesView: () => new View({}) }))
const { computerView } = await import("../src/main/secretary/computer-view")
const { setupCompanionPanels } = await import("../src/main/secretary/panel")
setupCompanionPanels()
const sender = new Contents()
const event = { sender, senderFrame: { url: "oc://renderer/index.html", parent: null } }
const rect = { x: 10, y: 20, width: 300, height: 400 }
ipc.emit("secretary:place", event, "computer", rect)
const view = window.contentView.children[0]!
assert.ok(view)
assert.equal(view, computerView())
assert.deepEqual(view.webContents.urls, [], "the page waits for the web session and the language")
for (let tick = 0; tick < 100 && !view.webContents.urls.length; tick++) await Bun.sleep(1)
assert.deepEqual(view.webContents.urls, ["https://getsecretary.tech/computer?shell=1"])
assert.equal(fromPartition.mock.calls[0]?.[0], "persist:lucina-web")
assert.equal(partition.fetch.mock.calls[0]?.[0], "https://getsecretary.tech/v1/session")
assert.equal(netFetch.mock.calls.length, 0, "a signed-in partition needs no token exchange")
assert.deepEqual(view.webContents.commands, [
  ["Emulation.setUserAgentOverride", { userAgent: "Secretary-Test", acceptLanguage: "en-US,en" }],
])
// The shell preload tells her page it is framed (no rail, stage dock or back link); the sandbox stays on.
const { preload, ...preferences } = (view.options as { webPreferences: { preload?: string } }).webPreferences
assert.deepEqual(preferences, { session: partition, contextIsolation: true, sandbox: true, nodeIntegration: false })
assert.match(preload ?? "", /\/preload\/lucina\.cjs$/)
assert.equal(view.webContents.focus.mock.calls.length, 1)
ipc.emit("secretary:place", event, "computer", rect)
assert.equal(view.webContents.focus.mock.calls.length, 1, "layout updates must not steal focus")
for (const panel of ["unknown", "constructor", "__proto__", 42, undefined]) {
  ipc.emit("secretary:place", event, panel, rect)
  assert.equal(window.contentView.children.length, 0)
}
ipc.emit("secretary:place", event, "computer", rect)
assert.equal(window.contentView.children[0], view)
assert.equal(view.webContents.focus.mock.calls.length, 2)
assert.equal(view.webContents.urls.length, 1, "reattaching keeps the viewer warm")

for (const [url, allowed, opens] of [
  ["https://getsecretary.tech/computer", true, false],
  ["https://getsecretary.tech/v1/computer/view/id/viewer/", true, false],
  ["https://getsecretary.tech/login?next=/computer", true, false],
  ["https://example.com", false, true],
  ["https://getsecretary.tech.evil.test", false, true],
  ["https://getsecretary.tech:444/computer", false, true],
  ["http://getsecretary.tech/computer", false, false],
  ["javascript:alert(1)", false, false],
  ["file:///tmp/a", false, false],
  ["data:text/html,hello", false, false],
  ["invalid", false, false],
] as const) {
  for (const name of ["will-frame-navigate", "will-redirect"]) {
    const preventDefault = mock(() => {})
    external.mockClear()
    view.webContents.emit(name, { url, preventDefault })
    assert.equal(preventDefault.mock.calls.length, allowed ? 0 : 1, `${name}: ${url}`)
    assert.equal(external.mock.calls.length, opens ? 1 : 0, url)
  }
  external.mockClear()
  assert.deepEqual(view.webContents.open?.({ url }), { action: "deny" })
  assert.equal(external.mock.calls.length, url.startsWith("https:") ? 1 : 0, `window.open: ${url}`)
}

for (const [url, trusted] of [
  ["https://getsecretary.tech", true],
  ["https://getsecretary.tech/v1/computer/view/id/viewer/", true],
  ["https://evil.test", false],
  ["https://getsecretary.tech.evil.test", false],
  ["https://getsecretary.tech:444", false],
  ["http://getsecretary.tech", false],
  ["null", false],
  ["", false],
] as const) {
  // The first refused fullscreen turns focus mode on; asking again keeps the viewer's token and says nothing new.
  window.webContents.sent.length = 0
  for (const permission of [
    "pointerLock",
    "fullscreen",
    "clipboard-sanitized-write",
    "clipboard-read",
    "media",
    "display-capture",
    "notifications",
    "keyboardLock",
    "unknown",
  ] as const) {
    const allowed = trusted && ["pointerLock", "fullscreen", "clipboard-sanitized-write"].includes(permission)
    // Other views of the partition (Films' player) keep the HTML fullscreen.
    assert.equal(partition.check?.(null, permission, url, { isMainFrame: false }), allowed, `${url}: ${permission}`)
    // The viewer's own fullscreen is refused from any frame: the shell's focus mode replaces it.
    const viewer = permission === "fullscreen" ? false : allowed
    const contents = view.webContents as unknown as WebContents
    assert.equal(partition.check?.(contents, permission, url, { isMainFrame: false }), viewer, `${url}: ${permission}`)
    const callback = mock((_allowed: boolean) => {})
    partition.request?.(contents, permission, callback, { requestingUrl: url, isMainFrame: false })
    assert.deepEqual(callback.mock.calls, [[viewer]], `${url}: ${permission}`)
  }
  assert.deepEqual(window.webContents.sent, [["secretary:shell-command", { action: "focus", on: true }]], `${url} asks the window for focus mode`)
  // Exit focus, so the next origin asks again.
  ipc.emit("secretary:place", event, undefined, undefined)
  ipc.emit("secretary:place", event, "computer", rect)
}

// Reading the clipboard (LucinaDesk's ⌘V): the viewer's own top page on her origin, nothing else.
const viewerContents = view.webContents as unknown as WebContents
const otherView = new Contents() as unknown as WebContents // her chat, the image viewer: same partition
for (const [contents, url, isMainFrame, allowed, label] of [
  [viewerContents, "https://getsecretary.tech/computer", true, true, "the viewer's top page"],
  [viewerContents, "https://getsecretary.tech/v1/computer/view/id/viewer/", false, false, "a frame inside the viewer"],
  [viewerContents, "http://192.168.1.20:8006/viewer/", false, false, "the home-network viewer frame"],
  [viewerContents, "https://evil.test/computer", true, false, "another origin"],
  [viewerContents, "https://getsecretary.tech.evil.test/", true, false, "a lookalike origin"],
  [otherView, "https://getsecretary.tech/", true, false, "another view of the partition"],
  [null, "https://getsecretary.tech/", true, false, "no view"],
] as const) {
  assert.equal(partition.check?.(contents, "clipboard-read", url, { isMainFrame }), allowed, `check: ${label}`)
  const callback = mock((_allowed: boolean) => {})
  partition.request?.(contents as WebContents, "clipboard-read", callback, { requestingUrl: url, isMainFrame })
  assert.deepEqual(callback.mock.calls, [[allowed]], `request: ${label}`)
}
// The top page gets nothing else beyond what every view of her origin has.
for (const permission of ["media", "display-capture", "notifications", "keyboardLock", "unknown"] as const)
  assert.equal(partition.check?.(viewerContents, permission, "https://getsecretary.tech/computer", { isMainFrame: true }), false, permission)

// While the shell is in focus mode, Esc in the viewer leaves it before the remote desktop canvas can take it; out of
// focus mode Esc is the remote apps' again. The window relays its focus mode to the viewer, whose page follows it.
window.webContents.sent.length = 0
partition.request?.(viewerContents, "fullscreen", () => {}, { requestingUrl: "https://getsecretary.tech/computer", isMainFrame: true })
assert.deepEqual(view.webContents.sent.at(-1), ["secretary:focus-mode", true])
const escape = mock(() => {})
view.webContents.emit("before-input-event", { preventDefault: escape }, { type: "keyDown", key: "Escape" })
assert.equal(escape.mock.calls.length, 1, "the page never sees the Esc that left focus mode")
assert.deepEqual(window.webContents.sent, [
  ["secretary:shell-command", { action: "focus", on: true }],
  ["secretary:shell-command", { action: "focus", on: false }],
])
assert.deepEqual(view.webContents.sent.at(-1), ["secretary:focus-mode", false])
view.webContents.emit("before-input-event", { preventDefault: escape }, { type: "keyDown", key: "Escape" })
assert.equal(escape.mock.calls.length, 1, "out of focus mode, Esc reaches the remote desktop")
for (const [code, mainFrame] of [
  [-3, true],
  [-105, false],
] as const) {
  view.webContents.emit("did-fail-load", {}, code, "failure", "https://getsecretary.tech/computer", mainFrame)
  assert.equal(view.webContents.urls.length, 1)
}
view.webContents.emit("did-fail-load", {}, -105, "failure", "https://getsecretary.tech/computer", true)
const retry = decodeURIComponent(view.webContents.urls.at(-1)!)
assert.ok(retry.startsWith("data:text/html"))
assert.ok(retry.includes('href="https://getsecretary.tech/computer?shell=1"'))
assert.ok(retry.includes("Try again"))
view.webContents.close()
assert.notEqual(computerView(), view, "a destroyed view is recreated")
