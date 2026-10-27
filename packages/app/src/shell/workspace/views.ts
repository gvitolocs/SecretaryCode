import type { CompanionPanel, ShellCommand, ShellView } from "@/runtime/platform/platform"
import type { LayoutRoute } from "@/shell/state/layout"

/** The rail's views in display order, Lucina first. */
export const SHELL_VIEWS = [
  "lucina",
  "code",
  "computer",
  "shopping",
  "training",
  "gallery",
  "films",
  "chats",
  "secrets",
  "health",
] as const satisfies readonly ShellView[]

export const DEFAULT_VIEW: ShellView = "lucina"

/**
 * The path Lucina's warm web view shows for each view it hosts ("/secrets" is the Add-secret sheet over her chat).
 * "code" and "computer" have no web route: Code is OpenCode, Computer has its own warm view.
 */
export const VIEW_ROUTES = {
  lucina: "/",
  shopping: "/shopping",
  training: "/training",
  gallery: "/media",
  films: "/films",
  chats: "/chats",
  secrets: "/secrets",
  health: "/server-health",
} as const satisfies Partial<Record<ShellView, string>>

/** Pages of Lucina's web app that her hidden top bar used to open: the account (with sign-out) and the notifications. */
export const ACCOUNT_ROUTE = "/account"
export const NOTIFICATIONS_ROUTE = "/notifications"

export function isShellView(value: unknown): value is ShellView {
  return typeof value === "string" && (SHELL_VIEWS as readonly string[]).includes(value)
}

/** The path to load in Lucina's web view for a view, or undefined when the view does not use it. */
export function viewRoute(view: ShellView): string | undefined {
  return (VIEW_ROUTES as Partial<Record<ShellView, string>>)[view]
}

/** The native view that fills the content card: Code uses none, Computer its own, every other view Lucina's. */
export function viewPanel(view: ShellView): CompanionPanel | undefined {
  if (view === "code") return undefined
  if (view === "computer") return "computer"

  return "lucina"
}

/** The view a command from Lucina's web app asks for. An unknown view leaves the current one alone. */
export function reduceView(current: ShellView, command: ShellCommand): ShellView {
  switch (command.action) {
    case "showCode":
      return "code"
    case "hideCode":
      return "lucina"
    case "show":
      return isShellView(command.view) ? command.view : current
    default:
      return current
  }
}

/** The project a showCode command names, when it names one. */
export function commandProject(command: ShellCommand): string | undefined {
  if (command.action !== "showCode") return undefined
  const path = command.projectPath?.trim()

  return path ? path : undefined
}

/** A stable identity for the screen a route shows. */
export function routeKey(route: LayoutRoute): string {
  switch (route.type) {
    case "draft":
      return `draft:${route.draftID}`
    case "session":
      return `session:${route.server}:${route.sessionId}`
    default:
      return route.type
  }
}

/**
 * Whether landing on `next` should bring Code forward. Something outside the rail (a notification, a tab shortcut)
 * moved OpenCode to another screen. Opening or closing settings returns to the screen that was already there, so it
 * does not count; `shown` is the key of the last screen that was not settings.
 */
export function revealsCode(shown: string, next: LayoutRoute): boolean {
  return next.type !== "settings" && routeKey(next) !== shown
}
