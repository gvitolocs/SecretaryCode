import { describe, expect, test } from "bun:test"
import { audioOnly, clampOpacity, isPrompterPath, parseOverlayRequest } from "./prompter-overlay-core"

describe("isPrompterPath", () => {
  test("accepts prompter pages with or without a query", () => {
    expect(isPrompterPath("/prompter/talk-1")).toBe(true)
    expect(isPrompterPath("/prompter/talk-1?live=1&overlay=1")).toBe(true)
    expect(isPrompterPath("/prompter/a%20b?live=1")).toBe(true)
  })

  test("refuses other pages and tricks", () => {
    for (const path of ["/prompter", "/prompter/", "/chats", "/prompter/a/b", "//evil.example/prompter/x", "/prompter/../chats", "/prompter/%2e%2e", "https://getsecretary.tech/prompter/x", 1, undefined])
      expect(isPrompterPath(path)).toBe(false)
  })
})

describe("clampOpacity", () => {
  test("keeps it between 0.3 and 1", () => {
    expect(clampOpacity(0.5)).toBe(0.5)
    expect(clampOpacity(0)).toBe(0.3)
    expect(clampOpacity(7)).toBe(1)
  })

  test("falls back for anything that is not a finite number", () => {
    expect(clampOpacity(undefined)).toBe(1)
    expect(clampOpacity(Number.NaN, 0.8)).toBe(0.8)
    expect(clampOpacity("0.5")).toBe(1)
  })
})

describe("parseOverlayRequest", () => {
  test("rebuilds the three requests from known fields", () => {
    expect(parseOverlayRequest({ action: "open", path: "/prompter/x?live=1&overlay=1", opacity: 0.6, extra: 1 })).toEqual({
      action: "open",
      path: "/prompter/x?live=1&overlay=1",
      opacity: 0.6,
    })
    expect(parseOverlayRequest({ action: "open", path: "/prompter/x" })).toEqual({ action: "open", path: "/prompter/x", opacity: 0.85 })
    expect(parseOverlayRequest({ action: "opacity", opacity: 0.1 })).toEqual({ action: "opacity", opacity: 0.3 })
    expect(parseOverlayRequest({ action: "close", path: "/x" })).toEqual({ action: "close" })
  })

  test("refuses every other shape", () => {
    for (const value of [null, [], "close", { action: "open", path: "/chats" }, { action: "opacity" }, { action: "opacity", opacity: Number.NaN }, { action: "show" }])
      expect(parseOverlayRequest(value)).toBeUndefined()
  })
})

describe("audioOnly", () => {
  test("is the microphone alone", () => {
    expect(audioOnly(["audio"])).toBe(true)
    expect(audioOnly(["audio", "video"])).toBe(false)
    expect(audioOnly(["video"])).toBe(false)
    expect(audioOnly([])).toBe(false)
    expect(audioOnly(undefined)).toBe(false)
  })
})
