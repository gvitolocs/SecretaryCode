import path from "node:path"
import { imageType } from "./formats"

export function imageArguments(argv: string[], cwd: string) {
  return argv
    .filter((arg) => !arg.startsWith("-") && !arg.includes("://") && imageType(arg))
    .map((arg) => path.resolve(cwd, arg))
}

/** Finder emits one open-file event per selection. Coalesce that burst into one request. */
export class ImageOpenQueue {
  private pending: string[] = []
  private open?: (files: string[]) => void
  private timer?: ReturnType<typeof setTimeout>

  enqueue(files: string[]) {
    this.pending.push(...files)
    this.schedule()
  }

  ready(open: (files: string[]) => void) {
    this.open = open
    this.schedule()
  }

  private schedule() {
    if (!this.open || !this.pending.length) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const files = [...new Set(this.pending)]
      this.pending = []
      this.open?.(files)
    }, 75)
  }
}
