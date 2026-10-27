import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { HangMonitor, installCrashHooks, type CrashReport, type HookEmitter } from "./hooks"

class Emitter implements HookEmitter {
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  count(event: string) {
    return this.listeners.get(event)?.length ?? 0
  }
}

afterEach(() => setSystemTime())

function harness() {
  const processEmitter = new Emitter()
  const appEmitter = new Emitter()
  const reports: CrashReport[] = []
  const exits: number[] = []
  const uninstall = installCrashHooks({
    process: processEmitter,
    app: appEmitter,
    report: (report) => {
      reports.push(report)
    },
    exit: (code) => exits.push(code),
    contentsURL: () => "app://index.html",
  })

  return { processEmitter, appEmitter, reports, exits, uninstall }
}

describe("crash hooks", () => {
  test("a main-process exception is reported as a crash and then ends the process", async () => {
    const run = harness()
    const error = new Error("connect ECONNREFUSED")

    run.processEmitter.emit("uncaughtException", error)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(run.reports).toHaveLength(1)
    expect(run.reports[0]).toMatchObject({
      kind: "crash",
      message: "connect ECONNREFUSED",
      stack: error.stack!,
      includeCrashDump: true,
    })
    expect(run.exits).toEqual([1])
  })

  test("an unhandled rejection is an error, not a crash, and the app keeps running", async () => {
    const run = harness()

    run.processEmitter.emit("unhandledRejection", new Error("fetch failed"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(run.reports).toEqual([
      { kind: "error", message: "fetch failed", stack: expect.stringContaining("fetch failed"), context: { unhandledRejection: true } },
    ])
    expect(run.exits).toEqual([])
  })

  test("a dead renderer process carries its reason, exit code and URL", async () => {
    const run = harness()

    run.appEmitter.emit("render-process-gone", {}, {}, { reason: "crashed", exitCode: 133, processType: "renderer" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(run.reports[0]).toMatchObject({
      kind: "crash",
      message: "Renderer process gone: crashed",
      includeCrashDump: true,
      context: { reason: "crashed", exitCode: 133, processType: "renderer", url: "app://index.html" },
    })
    expect(run.exits).toEqual([])
  })

  test("a clean renderer exit is recorded without asking for a minidump", async () => {
    const run = harness()

    run.appEmitter.emit("render-process-gone", {}, {}, { reason: "clean-exit", exitCode: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(run.reports[0]).toMatchObject({ includeCrashDump: false })
  })

  test("a dead utility process names the service that died", async () => {
    const run = harness()

    run.appEmitter.emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: 139, name: "Network Service" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(run.reports[0]).toMatchObject({
      kind: "crash",
      message: "Child process gone: Utility crashed",
      context: { type: "Utility", reason: "crashed", exitCode: 139, name: "Network Service" },
    })
  })

  test("uninstalling detaches every hook", () => {
    const run = harness()

    run.uninstall()

    expect(run.processEmitter.count("uncaughtException")).toBe(0)
    expect(run.processEmitter.count("unhandledRejection")).toBe(0)
    expect(run.appEmitter.count("render-process-gone")).toBe(0)
    expect(run.appEmitter.count("child-process-gone")).toBe(0)
  })
})

describe("main-thread hang monitor", () => {
  test("a blocked heartbeat is reported with how long it was blocked", () => {
    const blocked: number[] = []
    const monitor = new HangMonitor({ thresholdMs: 5_000, report: (ms) => blocked.push(ms) })

    monitor.tick()
    // A 7 s gap between one-second beats is 6 s the main thread could not run.
    setSystemTime(new Date(Date.now() + 7_000))
    monitor.tick()

    expect(blocked).toEqual([6_000])
    // The next beat is normal again, so one hang is not reported twice.
    setSystemTime(new Date(Date.now() + 1_000))
    monitor.tick()
    expect(blocked).toEqual([6_000])
  })

  test("a slow but acceptable beat is not a hang", () => {
    const blocked: number[] = []
    const monitor = new HangMonitor({ thresholdMs: 5_000, report: (ms) => blocked.push(ms) })

    monitor.tick()
    setSystemTime(new Date(Date.now() + 2_000))
    monitor.tick()

    expect(blocked).toEqual([])
  })
})
