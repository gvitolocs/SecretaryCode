import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mock, setSystemTime } from "bun:test"

// secretary:navigate and secretary:shell through the real panel module, with Electron and the views mocked.
const sent: [string, unknown][] = []
const makeWindow = (name: string) => ({
  name,
  destroyed: false,
  isDestroyed() {
    return this.destroyed
  },
  once() {},
  webContents: Object.assign(new EventEmitter(), {
    send: (channel: string, payload: unknown) => sent.push([`${name}:${channel}`, payload]),
  }),
  contentView: { children: [] as unknown[], addChildView() {}, removeChildView() {} },
})
const host = makeWindow("host")
const focused = makeWindow("focused")
class Contents extends EventEmitter {
  getZoomFactor = () => 1
  focus() {}
  isDestroyed = () => false
  sent: [string, unknown][] = []
  send(channel: string, payload: unknown) {
    this.sent.push([channel, payload])
  }
}
const lucina = new Contents()
let lucinaExists = true
const opened: string[] = []
let signedOut = 0
const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
const ipc = Object.assign(new EventEmitter(), {
  handle: (channel: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(channel, handler),
})
mock.module("electron", () => ({
  BrowserWindow: { fromWebContents: () => host, getFocusedWindow: () => focused },
  ipcMain: ipc,
  protocol: {},
}))
// Focus mode logs each enter and exit at info level, so it can be checked without the screen.
const logged: [string, unknown][] = []
mock.module("electron-log/main.js", () => ({ default: { info: (message: string, data: unknown) => logged.push([message, data]) } }))
mock.module("../src/main/secretary/index", () => ({
  lucinaView: () => ({ webContents: lucina, setBounds() {}, setBorderRadius() {} }),
  lucinaWebContents: () => (lucinaExists ? lucina : undefined),
  openLucinaPath: (path: string) => opened.push(path),
  forgetDevice: async () => {
    signedOut++
  },
}))
mock.module("../src/main/secretary/lane-window", () => ({ codingLanesView: () => ({}) }))
const computer = new Contents()
const fullscreen = { request: (_on: boolean) => {} }
const computerFocus = (on: boolean) => fullscreen.request(on)
mock.module("../src/main/secretary/computer-view", () => ({
  computerView: () => ({ webContents: computer, setBounds() {}, setBorderRadius() {} }),
  computerWebContents: () => computer,
  onComputerFocusRequest: (request: (on: boolean) => void) => {
    fullscreen.request = request
  },
}))
const { setupCompanionPanels } = await import("../src/main/secretary/panel")
setupCompanionPanels()

const renderer = { sender: new Contents(), senderFrame: { url: "oc://renderer/index.html", parent: null } }

// secretary:navigate obeys the same sender rules as secretary:place and validates the path.
ipc.emit("secretary:navigate", renderer, "/gallery")
ipc.emit("secretary:navigate", renderer, "/chats?tab=all&q=a%20b")
assert.deepEqual(opened, ["/gallery", "/chats?tab=all&q=a%20b"])
opened.length = 0
for (const path of ["gallery", "//evil.test", "/a/../b", "/a b", "/a#x", "https://evil.test/", "/\u0000", 42, undefined, {}, "/" + "a".repeat(512)])
  ipc.emit("secretary:navigate", renderer, path)
ipc.emit("secretary:navigate", { sender: new Contents(), senderFrame: { url: "https://getsecretary.tech/", parent: null } }, "/x")
ipc.emit("secretary:navigate", { sender: new Contents(), senderFrame: { url: "oc://renderer/index.html", parent: {} } }, "/x")
ipc.emit("secretary:navigate", { sender: new Contents(), senderFrame: null }, "/x")
assert.deepEqual(opened, [])

// secretary:shell: only Lucina's own top frame on her origin, and only a valid command, reaches a window.
const fromLucina = { sender: lucina, senderFrame: { url: "https://getsecretary.tech/chats", parent: null } }
ipc.emit("secretary:shell", fromLucina, { action: "show", view: "gallery", extra: "dropped" })
assert.deepEqual(sent, [["focused:secretary:shell-command", { action: "show", view: "gallery" }]], "no host yet: focused window")
sent.length = 0

// The window that hosts the companion views takes the command from then on.
ipc.emit("secretary:place", renderer, "lucina", { x: 0, y: 0, width: 100, height: 100 })
ipc.emit("secretary:shell", fromLucina, { action: "showCode", projectPath: "/Users/me/app" })
ipc.emit("secretary:shell", fromLucina, { action: "hideCode" })
ipc.emit("secretary:shell", fromLucina, { action: "focus", on: true })
ipc.emit("secretary:shell", fromLucina, { action: "adult", on: false })
assert.deepEqual(sent, [
  ["host:secretary:shell-command", { action: "showCode", projectPath: "/Users/me/app" }],
  ["host:secretary:shell-command", { action: "hideCode" }],
  ["host:secretary:shell-command", { action: "focus", on: true }],
  ["host:secretary:shell-command", { action: "adult", on: false }],
])
sent.length = 0

const rejected = [
  { sender: new Contents(), senderFrame: fromLucina.senderFrame }, // another view (the image viewer)
  { sender: computer, senderFrame: { url: "https://getsecretary.tech/computer", parent: {} } }, // the viewer frame
  { sender: renderer.sender, senderFrame: renderer.senderFrame }, // the app renderer itself
  { sender: lucina, senderFrame: { url: "https://getsecretary.tech/", parent: {} } }, // a subframe
  { sender: lucina, senderFrame: { url: "https://evil.test/", parent: null } },
  { sender: lucina, senderFrame: { url: "https://getsecretary.tech.evil.test/", parent: null } },
  { sender: lucina, senderFrame: { url: "http://getsecretary.tech/", parent: null } },
  { sender: lucina, senderFrame: null },
]
for (const event of rejected) ipc.emit("secretary:shell", event, { action: "hideCode" })
for (const event of rejected) await handlers.get("secretary:sign-out")!(event)
ipc.emit("secretary:shell", fromLucina, { action: "signOut" })
assert.equal(signedOut, 0, "only Lucina's own top frame may sign the Mac out, and only through its invoke channel")
for (const message of [undefined, null, "hideCode", [], {}, { action: "nope" }, { action: "show" }, { action: "show", view: "x" }, { action: "showCode", projectPath: "rel" }, { action: "focus" }, { action: "focus", on: "yes" }])
  ipc.emit("secretary:shell", fromLucina, message)
assert.deepEqual(sent, [])

// Her web app awaits the sign-out: the Mac has forgotten its device once it settles, and no window hears about it.
await handlers.get("secretary:sign-out")!(fromLucina)
assert.equal(signedOut, 1)
assert.deepEqual(sent, [])

// The Computer view's own top frame is heard too: its page has the shell preload.
ipc.emit("secretary:shell", { sender: computer, senderFrame: { url: "https://getsecretary.tech/computer", parent: null } }, {
  action: "show",
  view: "lucina",
})
assert.deepEqual(sent, [["host:secretary:shell-command", { action: "show", view: "lucina" }]])
sent.length = 0

// Focus mode: only the view the window shows may switch it, and it ends when that view leaves, reloads or goes away.
// Lucina is placed and turned focus mode on above.
const computerFrame = { sender: computer, senderFrame: { url: "https://getsecretary.tech/computer", parent: null } }
const area = { x: 0, y: 0, width: 100, height: 100 }
const on = ["host:secretary:shell-command", { action: "focus", on: true }]
const off = ["host:secretary:shell-command", { action: "focus", on: false }]
// The Computer view in the background (reloading after a sign-in, say) is ignored, both ways.
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: false })
assert.deepEqual(sent, [], "a view in the background never switches focus mode")
// Her own history changes and subframes keep it; a main-frame load ends it, once.
lucina.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true })
lucina.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false })
assert.deepEqual(sent, [])
lucina.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
lucina.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
assert.deepEqual(sent, [off], "a reload ends focus mode")
sent.length = 0
// Another view taking the window ends it.
ipc.emit("secretary:shell", fromLucina, { action: "focus", on: true })
ipc.emit("secretary:place", renderer, "computer", area)
assert.deepEqual(sent, [on, off], "the focused view left the window")
sent.length = 0
// The card hidden (settings over it) ends it too.
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
ipc.emit("secretary:place", renderer, undefined, undefined)
assert.deepEqual(sent, [on, off])
sent.length = 0
// Her web views hear every change, so a page can hide its own header.
ipc.emit("secretary:place", renderer, "computer", area)
assert.deepEqual(computer.sent.at(-1), ["secretary:focus-mode", false])
// The Computer view and the viewer each hold a token: one leaving keeps focus mode on, and one exit clears both.
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
computerFocus(true)
assert.deepEqual(sent, [on], "asking again is not a toggle")
assert.deepEqual(computer.sent.at(-1), ["secretary:focus-mode", true])
computerFocus(false)
assert.deepEqual(sent, [on], "the viewer's fullscreen holds its own token")
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: false })
assert.deepEqual(sent, [on, off], "her page leaving releases both of the view's tokens")
sent.length = 0
// The titlebar's Exit focus, from the app renderer alone, clears both tokens at once; a later reload sends nothing.
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
computerFocus(true)
ipc.emit("secretary:focus-exit", { sender: computer, senderFrame: computerFrame.senderFrame })
assert.deepEqual(sent, [on], "only the app renderer has the titlebar")
ipc.emit("secretary:focus-exit", renderer)
computer.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
assert.deepEqual(sent, [on, off])
assert.deepEqual(computer.sent.at(-1), ["secretary:focus-mode", false])
sent.length = 0
// Her page answering the "off" by asking again does not flip it straight back on, nor does it minutes later (the desk
// page asks each time the window is shown): the page is told it is off. The owner's click in the view does.
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
assert.deepEqual(sent, [])
const later = () => setSystemTime(new Date(Date.now() + 2_000))
setSystemTime(new Date(Date.now() + 5 * 60_000))
computer.sent.length = 0
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
assert.deepEqual(sent, [], "the window shown again does not bring focus mode back")
assert.deepEqual(computer.sent.at(-1), ["secretary:focus-mode", false])
const click = () => computer.emit("input-event", {}, { type: "mouseDown" })
// Esc reaches the main process before any page: the remote desktop canvas cannot swallow it, nor the shell's own page.
for (const contents of [computer, host.webContents]) {
  click()
  ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
  let prevented = 0
  contents.emit("before-input-event", { preventDefault: () => prevented++ }, { type: "keyDown", key: "Escape" })
  assert.equal(prevented, 1)
  // Out of focus mode, Esc is the page's (the remote apps') again.
  contents.emit("before-input-event", { preventDefault: () => prevented++ }, { type: "keyDown", key: "Escape" })
  assert.equal(prevented, 1)
  later()
}
// ⌥⌘F, View → Exit Focus, works the same way (⌃⌘F stays the full-screen toggle's).
click()
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
computer.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", key: "ƒ", code: "KeyF", alt: true, meta: true })
later()
assert.deepEqual(sent, [on, off, on, off, on, off])
sent.length = 0
// Another of her pages or plugins, a reload of the window and a crash each reset it.
click()
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
ipc.emit("secretary:navigate", renderer, "/gallery")
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
host.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
host.webContents.emit("render-process-gone", {}, { reason: "crashed" })
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
computer.emit("render-process-gone", {}, { reason: "oom" })
assert.deepEqual(sent, [on, off, on, off, on, off, on, off])
sent.length = 0
assert.deepEqual(
  logged.filter(([message]) => message === "focus mode: exit").map(([, data]) => (data as { source: string }).source),
  ["navigation", "view-change", "view-change", "button", "escape", "escape", "menu", "navigation", "reload", "crash", "crash"],
)
assert.deepEqual(logged.find(([message]) => message === "focus mode: enter"), ["focus mode: enter", { source: "viewer", token: "viewer-1" }])
// The focused view going away ends it.
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
computer.emit("destroyed")
assert.deepEqual(sent, [on, off])
sent.length = 0
setSystemTime()

// A view that does not exist hears nothing.
lucinaExists = false
ipc.emit("secretary:shell", fromLucina, { action: "hideCode" })
assert.deepEqual(sent, [])
