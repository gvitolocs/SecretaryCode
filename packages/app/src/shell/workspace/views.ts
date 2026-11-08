import type { AttentionCounts, CompanionPanel, ShellCommand, ShellView } from "@/runtime/platform/platform"
import type { LayoutRoute } from "@/shell/state/layout"

/** The rail's views in display order, Lucina first. */
export const SHELL_VIEWS = [
  "lucina",
  "calendar",
  "keep",
  "code",
  "agents",
  "computer",
  "shopping",
  "training",
  "gallery",
  "films",
  "instagram",
  "pixiv",
  "nclient",
  "chats",
  "decisions",
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
  calendar: "/calendar",
  keep: "/keep",
  agents: "/agents",
  shopping: "/shopping",
  training: "/training",
  gallery: "/gallery",
  films: "/films",
  instagram: "/instagram",
  pixiv: "/pixiv",
  nclient: "/nclient",
  chats: "/chats",
  decisions: "/decisions",
  secrets: "/secrets",
  health: "/server-health",
} as const satisfies Partial<Record<ShellView, string>>

/** Pages of Lucina's web app that her hidden top bar used to open: the account (with sign-out) and the notifications. */
export const ACCOUNT_ROUTE = "/account"
export const NOTIFICATIONS_ROUTE = "/notifications"

/** Plugins the rail shows only while her "Show adult plugins" switch is on. */
export const ADULT_VIEWS: readonly ShellView[] = ["nclient"]

/** Whether the rail offers a view: every view, except the adult ones while the switch is off. */
export function viewAllowed(view: ShellView, adult: boolean): boolean {
  return adult || !ADULT_VIEWS.includes(view)
}

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
    case "open":
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

/** The page a clicked notification asks for inside its view ("/decisions/dec_1"), when the command names one. */
export function commandPage(command: ShellCommand): string | undefined {
  return command.action === "open" && command.path.startsWith("/") ? command.path : undefined
}

/** A count as the rail's badge shows it: nothing at zero, "99+" above 99. */
export function badgeLabel(count: number): string | undefined {
  if (!Number.isFinite(count) || count < 1) return undefined

  return count > 99 ? "99+" : String(Math.floor(count))
}

/** The badge on a rail item: the Decisions item counts the decisions waiting for the owner. */
export function railBadge(view: ShellView, counts: AttentionCounts): string | undefined {
  return view === "decisions" ? badgeLabel(counts.decisions) : undefined
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

/**
 * What moves the shell's focus mode. The main process owns it and sends "page-on" and "page-off" as it changes; the
 * shell's own ways out (its titlebar's Exit focus, Esc, another view) leave it at once, whatever the page does or never
 * does, while the main process is told and confirms.
 */
export type FocusEvent = "page-on" | "page-off" | "exit" | "escape" | "view-change"

export function nextFocus(_current: boolean, event: FocusEvent): boolean {
  return event === "page-on"
}
