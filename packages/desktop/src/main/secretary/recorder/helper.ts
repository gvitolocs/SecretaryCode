import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { parseHelperLine, type HelperEvent } from "./protocol"

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "HelperError"
  }
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The native `secretary-recorder` process, spoken to in JSON lines. It is started with argv only (no
 * shell) and stopped by closing its stdin, which makes it finish any recording before it exits.
 */
export class RecorderHelper {
  private child: ChildProcessWithoutNullStreams | undefined
  private pending = new Map<string, Pending>()
  private sequence = 0
  private stderr = ""

  constructor(
    private readonly executable: string,
    private readonly onEvent: (event: HelperEvent) => void,
    private readonly onExit: (code: number | null, stderr: string) => void,
  ) {}

  get running() {
    return !!this.child
  }

  start() {
    if (this.child) return
    const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"], shell: false })
    this.child = child
    this.stderr = ""
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = parseHelperLine(line)

      if (!message) return

      if (message.type === "event") return this.onEvent(message.value)
      const pending = this.pending.get(message.id)

      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)

      if (message.ok) pending.resolve(message.result)
      else pending.reject(new HelperError(message.code, message.message))
    })
    child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000)
    })
    // A write after the helper died must surface through `exit`, not as an uncaught EPIPE.
    child.stdin.on("error", () => undefined)

    const exited = (code: number | null) => {
      if (this.child !== child) return
      this.child = undefined

      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new HelperError("helper-exited", "The recorder stopped unexpectedly"))
      }

      this.pending.clear()
      this.onExit(code, this.stderr)
    }

    child.on("error", () => exited(null))
    child.on("exit", exited)
  }

  /** Sends one command and resolves with its `result`, or rejects with the helper's error code. */
  request(command: string, fields: Record<string, unknown> = {}, timeoutMs = 30_000) {
    this.start()
    const child = this.child

    if (!child) return Promise.reject(new HelperError("helper-unavailable", "The recorder could not start"))
    const id = String(++this.sequence)

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HelperError("helper-timeout", `The recorder did not answer ${command}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ ...fields, id, cmd: command }) + "\n")
    })
  }

  /** Closes stdin; the helper finalizes any recording and exits on its own. */
  close() {
    this.child?.stdin.end()
  }
}
