import { describe, expect, test } from "bun:test"
import { createReport, errorDetails, fingerprint } from "./report"

const identity = { appVersion: "2.1.4", os: "darwin 15.1 arm64", device: "MacBook 1a2b3c4d" }

describe("diagnostics reports", () => {
  test("label the app, the failure and the moment it happened", () => {
    const report = createReport({
      kind: "error",
      message: "The engine failed to start",
      stack: "Error: timed out\n    at connect (service.ts:10:1)",
      context: { component: "engine" },
      occurredAt: new Date("2026-10-27T08:00:00.000Z"),
      ...identity,
    })

    expect(report).toEqual({
      app: "secretary-code",
      app_version: "2.1.4",
      os: "darwin 15.1 arm64",
      device: "MacBook 1a2b3c4d",
      kind: "error",
      message: "The engine failed to start",
      stack: "Error: timed out\n    at connect (service.ts:10:1)",
      context: { component: "engine" },
      occurred_at: "2026-10-27T08:00:00.000Z",
    })
  })

  test("bounds a runaway message, stack and context string", () => {
    const report = createReport({
      kind: "crash",
      message: "m".repeat(10_000),
      stack: "s".repeat(50_000),
      context: { note: "n".repeat(10_000) },
      ...identity,
    })

    expect(report.message.length).toBeLessThanOrEqual(2_001)
    expect(report.stack!.length).toBeLessThanOrEqual(20_001)
    expect(String(report.context.note).length).toBeLessThanOrEqual(1_001)
  })

  test("keeps the report JSON-safe when context holds values JSON cannot carry", () => {
    const circular: Record<string, unknown> = { name: "loop" }
    circular.self = circular

    const report = createReport({
      kind: "error",
      message: "boom",
      context: {
        nothing: undefined,
        callback: () => undefined,
        notANumber: Number.NaN,
        big: 12n,
        when: new Date("2026-10-27T08:00:00.000Z"),
        error: new Error("inner"),
        circular,
      },
      ...identity,
    })

    expect(() => JSON.stringify(report.context)).not.toThrow()
    expect(report.context).toMatchObject({
      notANumber: "NaN",
      big: "12",
      circular: { name: "loop", self: "[circular]" },
      error: { name: "Error", message: "inner" },
    })
    expect(report.context.callback).toBeUndefined()
    expect("nothing" in report.context).toBe(false)
  })

  test("the fingerprint identifies one failure across launches, not two kinds of failure", () => {
    const stack = "Error: boom\n    at connect (service.ts:10:1)\n    at other (x.ts:2:1)"
    const first = createReport({ kind: "error", message: "boom", stack, occurredAt: new Date(0), ...identity })
    const later = createReport({ kind: "error", message: "boom", stack, occurredAt: new Date(9e9), ...identity })
    const crash = createReport({ kind: "crash", message: "boom", stack, ...identity })
    const elsewhere = createReport({ kind: "error", message: "boom", stack: "Error: boom\n    at run (y.ts:3:1)", ...identity })

    expect(fingerprint(first)).toBe(fingerprint(later))
    expect(fingerprint(first)).not.toBe(fingerprint(crash))
    expect(fingerprint(first)).not.toBe(fingerprint(elsewhere))
  })

  test("reads a thrown Error, a bare string and a plain object", () => {
    const error = new Error("outer", { cause: new Error("inner") })

    expect(errorDetails(error)).toEqual({ message: "outer", stack: error.stack ?? null })
    expect(errorDetails("boom")).toEqual({ message: "boom", stack: null })
    expect(errorDetails({ code: "EACCES", path: "/tmp" })).toEqual({
      message: '{"code":"EACCES","path":"/tmp"}',
      stack: null,
    })
  })
})
