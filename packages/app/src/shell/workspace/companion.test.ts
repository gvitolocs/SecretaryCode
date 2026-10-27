import { afterEach, expect, test } from "bun:test"
import { covered } from "./companion"

const view = { left: 900, right: 1300, top: 80, bottom: 800 }

function portal(html: string, box: { left: number; top: number; width: number; height: number }) {
  const host = document.createElement("div")
  host.innerHTML = html
  document.body.append(host)
  for (const element of [host, ...host.querySelectorAll("*")])
    (element as HTMLElement).getBoundingClientRect = () =>
      ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top }) as DOMRect
  return host
}

afterEach(() => {
  document.body.innerHTML = ""
})

test("a tab tooltip over the view's top edge does not hide the view", () => {
  portal(`<div data-positioner><div><div role="tooltip">Lucina ⌥⌘B</div></div></div>`, { left: 950, top: 60, width: 120, height: 40 })
  expect(covered(view)).toBe(false)
})

test("a menu that overlaps the view hides it", () => {
  portal(`<div data-positioner><div role="menu">Copy</div></div>`, { left: 1000, top: 200, width: 200, height: 300 })
  expect(covered(view)).toBe(true)
})

test("a popover beside the view leaves it alone", () => {
  portal(`<div data-positioner><div role="dialog">Settings</div></div>`, { left: 100, top: 200, width: 300, height: 300 })
  expect(covered(view)).toBe(false)
})
