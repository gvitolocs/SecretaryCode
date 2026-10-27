import { expect, test } from "bun:test"
import type { ShellView } from "@/runtime/platform/platform"
import {
  commandProject,
  isShellView,
  reduceView,
  revealsCode,
  routeKey,
  SHELL_VIEWS,
  viewPanel,
  viewRoute,
  VIEW_ROUTES,
} from "./views"

test("the route map is the agreed one", () => {
  expect(VIEW_ROUTES).toEqual({
    lucina: "/",
    gallery: "/media",
    films: "/films",
    chats: "/plugins",
    secrets: "/plugins",
    health: "/server-health",
  })
})

test("Code and Computer have no Lucina route; every other view has one", () => {
  expect(viewRoute("code")).toBeUndefined()
  expect(viewRoute("computer")).toBeUndefined()
  for (const view of SHELL_VIEWS.filter((item) => item !== "code" && item !== "computer"))
    expect(viewRoute(view)).toStartWith("/")
})

test("only Code leaves the content card empty, and Computer has its own native view", () => {
  expect(viewPanel("code")).toBeUndefined()
  expect(viewPanel("computer")).toBe("computer")
  for (const view of ["lucina", "gallery", "films", "chats", "secrets", "health"] as const)
    expect(viewPanel(view)).toBe("lucina")
})

test("view names are checked", () => {
  expect(SHELL_VIEWS.every(isShellView)).toBe(true)
  expect(isShellView("agents")).toBe(false)
  expect(isShellView(undefined)).toBe(false)
})

test("showCode and hideCode switch between Code and Lucina", () => {
  expect(reduceView("lucina", { action: "showCode" })).toBe("code")
  expect(reduceView("gallery", { action: "showCode", projectPath: "/home/nez/Projects/x" })).toBe("code")
  expect(reduceView("code", { action: "hideCode" })).toBe("lucina")
  expect(reduceView("films", { action: "hideCode" })).toBe("lucina")
})

test("show switches to the requested view and ignores an unknown one", () => {
  expect(reduceView("lucina", { action: "show", view: "films" })).toBe("films")
  expect(reduceView("code", { action: "show", view: "computer" })).toBe("computer")
  expect(reduceView("code", { action: "show", view: "nope" as ShellView })).toBe("code")
})

test("an unknown action leaves the view alone", () => {
  expect(reduceView("films", { action: "explode" } as never)).toBe("films")
})

test("only showCode carries a project, and a blank path is none", () => {
  expect(commandProject({ action: "showCode", projectPath: " /srv/app " })).toBe("/srv/app")
  expect(commandProject({ action: "showCode", projectPath: "  " })).toBeUndefined()
  expect(commandProject({ action: "showCode" })).toBeUndefined()
  expect(commandProject({ action: "hideCode" })).toBeUndefined()
  expect(commandProject({ action: "show", view: "code" })).toBeUndefined()
})

test("routes have stable keys", () => {
  expect(routeKey({ type: "home" })).toBe("home")
  expect(routeKey({ type: "draft", draftID: "d1" })).toBe("draft:d1")
  expect(routeKey({ type: "session", sessionId: "s1", server: "local" as never })).toBe("session:local:s1")
})

test("settings never brings Code forward, a new screen does", () => {
  const shown = routeKey({ type: "session", sessionId: "s1", server: "local" as never })

  expect(revealsCode(shown, { type: "settings" })).toBe(false)
  // Closing settings returns to the screen that was already there.
  expect(revealsCode(shown, { type: "session", sessionId: "s1", server: "local" as never })).toBe(false)
  expect(revealsCode(shown, { type: "session", sessionId: "s2", server: "local" as never })).toBe(true)
  expect(revealsCode(shown, { type: "draft", draftID: "d1" })).toBe(true)
  expect(revealsCode(shown, { type: "home" })).toBe(true)
})
