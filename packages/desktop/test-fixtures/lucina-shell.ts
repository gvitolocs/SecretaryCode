import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mock } from "bun:test"

// secretary:navigate and secretary:shell through the real panel module, with Electron and the views mocked.
const sent: [string, unknown][] = []
const makeWindow = (name: string) => ({
  name,
  destroyed: false,
  isDestroyed() {
    return this.destroyed
  },
  once() {},
  webContents: { send: (channel: string, payload: unknown) => sent.push([`${name}:${channel}`, payload]) },
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
mock.module("../src/main/secretary/computer-view", () => ({
  computerView: () => ({ webContents: computer, setBounds() {}, setBorderRadius() {} }),
  computerWebContents: () => computer,
  onComputerFocusRequest: () => {},
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
assert.deepEqual(sent, [
  ["host:secretary:shell-command", { action: "showCode", projectPath: "/Users/me/app" }],
  ["host:secretary:shell-command", { action: "hideCode" }],
  ["host:secretary:shell-command", { action: "focus", on: true }],
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
// The window leaving focus mode itself (Esc, Exit focus) stops the watch: a later reload sends nothing.
ipc.emit("secretary:place", renderer, "computer", area)
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
ipc.emit("secretary:focus-mode", renderer, false)
computer.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
assert.deepEqual(sent, [on])
assert.deepEqual(computer.sent.at(-1), ["secretary:focus-mode", false])
sent.length = 0
// The focused view going away ends it.
ipc.emit("secretary:shell", computerFrame, { action: "focus", on: true })
computer.emit("destroyed")
assert.deepEqual(sent, [on, off])
sent.length = 0

// A view that does not exist hears nothing.
lucinaExists = false
ipc.emit("secretary:shell", fromLucina, { action: "hideCode" })
assert.deepEqual(sent, [])
