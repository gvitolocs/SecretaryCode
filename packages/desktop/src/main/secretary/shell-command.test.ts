import { describe, expect, test } from "bun:test"
import { isNavigatePath, isProjectPath, parseShellCommand, SHELL_VIEWS, withShellFlag } from "./shell-command"

describe("parseShellCommand", () => {
  test("accepts the three commands and rebuilds them from known fields", () => {
    expect(parseShellCommand({ action: "hideCode" })).toEqual({ action: "hideCode" })
    expect(parseShellCommand({ action: "showCode" })).toEqual({ action: "showCode" })
    expect(parseShellCommand({ action: "showCode", projectPath: undefined })).toEqual({ action: "showCode" })
    expect(parseShellCommand({ action: "showCode", projectPath: "/Users/me/app", extra: 1 })).toEqual({
      action: "showCode",
      projectPath: "/Users/me/app",
    })
    for (const view of SHELL_VIEWS) expect(parseShellCommand({ action: "show", view })).toEqual({ action: "show", view })
    expect(parseShellCommand({ action: "hideCode", view: "code" })).toEqual({ action: "hideCode" })
  })

  test("refuses every other shape", () => {
    const invalid: unknown[] = [
      undefined,
      null,
      "hideCode",
      42,
      [],
      [{ action: "hideCode" }],
      {},
      { action: "" },
      { action: "quit" },
      { action: "SHOWCODE" },
      { action: ["hideCode"] },
      { action: "show" },
      { action: "show", view: "settings" },
      { action: "show", view: "Gallery" },
      { action: "show", view: 1 },
      { action: "show", view: "__proto__" },
      { action: "showCode", projectPath: null },
      { action: "showCode", projectPath: 7 },
      { action: "showCode", projectPath: "" },
      { action: "showCode", projectPath: "relative/path" },
      { action: "showCode", projectPath: "~/app" },
      { action: "showCode", projectPath: "/ok\0bad" },
      { action: "showCode", projectPath: "/" + "a".repeat(4096) },
    ]

    for (const value of invalid) expect(parseShellCommand(value)).toBeUndefined()
  })
})

test("isProjectPath takes absolute paths up to 4096 characters", () => {
  expect(isProjectPath("/")).toBe(true)
  expect(isProjectPath("/" + "a".repeat(4095))).toBe(true)
  expect(isProjectPath("/" + "a".repeat(4096))).toBe(false)
  expect(isProjectPath("a")).toBe(false)
  expect(isProjectPath("/a\0")).toBe(false)
  expect(isProjectPath(undefined)).toBe(false)
})

describe("isNavigatePath", () => {
  test("accepts paths of Lucina's web app", () => {
    for (const path of ["/", "/chats", "/gallery/photos", "/films?tab=new", "/a_b-c.d?x=1&y=a%20b", "/" + "a".repeat(511)])
      expect(isNavigatePath(path)).toBe(true)
  })

  test("refuses other origins, traversal, odd characters and bad types", () => {
    const invalid: unknown[] = [
      "",
      "chats",
      "https://evil.test/",
      "//evil.test",
      "/a//b",
      "/..",
      "/a/../b",
      "/a/..%2f",
      "/%2e%2e/x",
      "/%2E%2E/x",
      "/a/%2e%2e",
      "/%2f%2fevil",
      "/%zz",
      "/a b",
      "/a#frag",
      "/a;b",
      "/a\\b",
      "/a\nb",
      "/a\0",
      "/<script>",
      "/é",
      "/" + "a".repeat(512),
      undefined,
      null,
      42,
      ["/chats"],
      { toString: () => "/chats" },
    ]

    for (const path of invalid) expect(isNavigatePath(path)).toBe(false)
  })
})

test("sign-out is never a window command", () => {
  // It has its own invoke channel (secretary:sign-out), handled in the main process.
  expect(parseShellCommand({ action: "signOut" })).toBeUndefined()
})

test("withShellFlag marks a page as framed by the shell and keeps its route and query", () => {
  expect(withShellFlag("https://getsecretary.tech/")).toBe("https://getsecretary.tech/?shell=1")
  expect(withShellFlag("https://getsecretary.tech/chats?tab=all")).toBe("https://getsecretary.tech/chats?tab=all&shell=1")
  expect(withShellFlag("https://getsecretary.tech/computer?shell=1")).toBe("https://getsecretary.tech/computer?shell=1")
})
