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
mock.module("../src/main/secretary/computer-view", () => ({ computerView: () => ({}) }))
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
assert.deepEqual(sent, [
  ["host:secretary:shell-command", { action: "showCode", projectPath: "/Users/me/app" }],
  ["host:secretary:shell-command", { action: "hideCode" }],
])
sent.length = 0

const rejected = [
  { sender: new Contents(), senderFrame: fromLucina.senderFrame }, // another view (Computer, image viewer)
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
for (const message of [undefined, null, "hideCode", [], {}, { action: "nope" }, { action: "show" }, { action: "show", view: "x" }, { action: "showCode", projectPath: "rel" }])
  ipc.emit("secretary:shell", fromLucina, message)
assert.deepEqual(sent, [])

// Her web app awaits the sign-out: the Mac has forgotten its device once it settles, and no window hears about it.
await handlers.get("secretary:sign-out")!(fromLucina)
assert.equal(signedOut, 1)
assert.deepEqual(sent, [])

// A view that does not exist hears nothing.
lucinaExists = false
ipc.emit("secretary:shell", fromLucina, { action: "hideCode" })
assert.deepEqual(sent, [])
