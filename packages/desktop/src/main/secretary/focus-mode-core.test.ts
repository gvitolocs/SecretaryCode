import { expect, test } from "bun:test"
import { createFocusMode, focusExitKey, REENTRY_GRACE_MS } from "./focus-mode-core"

function focus() {
  const clock = { now: 10_000 }
  const logged: [string, Record<string, unknown>][] = []
  const changes: boolean[] = []
  const mode = createFocusMode({ log: (message, data) => logged.push([message, data]), now: () => clock.now })
  mode.subscribe((on) => changes.push(on))

  return { mode, clock, logged, changes }
}

test("the viewer enters focus mode and Esc leaves it", () => {
  const { mode, logged, changes } = focus()
  const token = mode.enter("viewer")

  expect(token).toBe("viewer-1")
  expect(mode.active()).toBe(true)
  // Asking again is not a toggle: the viewer keeps its token and focus mode stays on.
  expect(mode.enter("viewer")).toBe(token)
  expect(mode.active()).toBe(true)
  mode.exit(focusExitKey({ type: "keyDown", key: "Escape" })!)
  expect(mode.active()).toBe(false)
  expect(changes).toEqual([true, false])
  expect(logged).toEqual([
    ["focus mode: enter", { source: "viewer", token: "viewer-1" }],
    ["focus mode: exit", { source: "escape", tokens: ["viewer-1"] }],
  ])
})

test("one exit clears the Computer view's and the viewer's tokens together", () => {
  const { mode, clock, changes } = focus()
  mode.enter("computer")
  mode.enter("viewer")
  expect(mode.tokens()).toEqual(["computer-1", "viewer-2"])
  mode.exit("button")
  expect(mode.tokens()).toEqual([])
  expect(mode.active()).toBe(false)
  expect(changes).toEqual([true, false])
  // The page answering the "off" by asking again does not flip it back on.
  expect(mode.enter("computer")).toBeUndefined()
  expect(mode.active()).toBe(false)
  // A later, deliberate request does.
  clock.now += REENTRY_GRACE_MS
  expect(mode.enter("computer")).toBe("computer-3")
})

test("a requester leaving releases only its own token", () => {
  const { mode, changes } = focus()
  mode.enter("computer")
  mode.enter("viewer")
  mode.release("viewer")
  expect(mode.active()).toBe(true)
  mode.release("viewer")
  mode.release("computer")
  expect(mode.active()).toBe(false)
  mode.enter("computer")
  mode.enter("viewer")
  mode.release("computer", "viewer")
  expect(mode.active()).toBe(false)
  expect(changes).toEqual([true, false, true, false])
})

test("another page or plugin resets focus mode", () => {
  const { mode, changes } = focus()
  mode.enter("viewer")
  mode.exit("navigation")
  expect(mode.active()).toBe(false)
  // Not the owner's own exit: her page may ask again straight away.
  expect(mode.enter("viewer")).toBe("viewer-2")
  mode.exit("view-change")
  expect(changes).toEqual([true, false, true, false])
})

test("a reload or a crash resets focus mode", () => {
  const { mode, logged } = focus()
  mode.enter("computer")
  mode.enter("viewer")
  mode.exit("reload")
  expect(mode.active()).toBe(false)
  mode.enter("computer")
  mode.exit("crash")
  expect(mode.active()).toBe(false)
  // Leaving when it is already off says nothing.
  mode.exit("reload")
  expect(logged.filter(([message]) => message === "focus mode: exit")).toEqual([
    ["focus mode: exit", { source: "reload", tokens: ["computer-1", "viewer-2"] }],
    ["focus mode: exit", { source: "crash", tokens: ["computer-3"] }],
  ])
})

test("Esc and ⌃⌘F are focus mode's keys, nothing else", () => {
  expect(focusExitKey({ type: "keyDown", key: "Escape" })).toBe("escape")
  expect(focusExitKey({ type: "keyDown", key: "f", control: true, meta: true })).toBe("menu")
  expect(focusExitKey({ type: "keyDown", key: "F", control: true, meta: true })).toBe("menu")
  expect(focusExitKey({ type: "keyUp", key: "Escape" })).toBeUndefined()
  expect(focusExitKey({ type: "keyDown", key: "Escape", meta: true })).toBeUndefined()
  expect(focusExitKey({ type: "keyDown", key: "f", meta: true })).toBeUndefined()
  expect(focusExitKey({ type: "keyDown", key: "f", control: true, meta: true, shift: true })).toBeUndefined()
})
