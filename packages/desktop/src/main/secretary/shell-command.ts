// What Lucina's web app may ask of the desktop shell, and where the shell may send her web view. Kept free of Electron
// so the main process, the web view's sandboxed preload and the tests all validate with the same rules.

export const SHELL_VIEWS = [
  "lucina",
  "keep",
  "code",
  "computer",
  "shopping",
  "training",
  "gallery",
  "films",
  "chats",
  "secrets",
  "health",
] as const

export type ShellView = (typeof SHELL_VIEWS)[number]

/** Mirrors the ShellCommand in the app's platform contract. */
export type ShellCommand =
  | { action: "showCode"; projectPath?: string }
  | { action: "hideCode" }
  | { action: "show"; view: ShellView }
  | { action: "focus"; on: boolean }

/** An absolute project path: starts with "/", at most 4096 characters, no NUL. */
export function isProjectPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && value.startsWith("/") && !value.includes("\0")
}

export function isShellView(value: unknown): value is ShellView {
  return typeof value === "string" && (SHELL_VIEWS as readonly string[]).includes(value)
}

/** The command in a `secretary:shell` message, rebuilt from validated fields only, or undefined for anything else. */
export function parseShellCommand(value: unknown): ShellCommand | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const message = value as Record<string, unknown>

  if (message.action === "hideCode") return { action: "hideCode" }

  if (message.action === "focus") return typeof message.on === "boolean" ? { action: "focus", on: message.on } : undefined

  if (message.action === "show") return isShellView(message.view) ? { action: "show", view: message.view } : undefined

  if (message.action === "showCode") {
    if (message.projectPath === undefined) return { action: "showCode" }

    return isProjectPath(message.projectPath) ? { action: "showCode", projectPath: message.projectPath } : undefined
  }
}

const NAVIGATE_PATH = /^\/[A-Za-z0-9/_\-.?=&%]*$/

/** A path of Lucina's web app (with an optional query): "/", "/chats", "/gallery?tab=photos". */
export function isNavigatePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || !NAVIGATE_PATH.test(value)) return false

  if (value.includes("//") || value.includes("..")) return false

  // Percent-encoding must not smuggle either of them back in.
  try {
    const decoded = decodeURIComponent(value)

    return !decoded.includes("//") && !decoded.includes("..")
  } catch {
    return false
  }
}

/**
 * A page of her web app marked as framed by the shell (?shell=1). Her app then hides its own rail, tab bar and plugin
 * back links even before the preload bridge is attached, and remembers it for the browser session.
 */
export function withShellFlag(url: string) {
  const next = new URL(url)
  next.searchParams.set("shell", "1")

  return next.toString()
}
