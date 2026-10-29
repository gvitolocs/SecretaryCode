import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { Schema } from "effect"
import { createSimpleContext } from "@opencode/ui/context"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform, type AttentionCounts, type ShellCommand, type ShellView } from "@/runtime/platform/platform"
import { useSettings } from "@/settings/model"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useLayout } from "@/shell/state/layout"
import { addProjects } from "@/home/projects/add"
import { commandPage, commandProject, DEFAULT_VIEW, nextFocus, railBadge, reduceView, revealsCode, routeKey, SHELL_VIEWS, viewAllowed, type FocusEvent } from "./views"

export const SIDEBAR_WIDTH = { min: 220, default: 264, max: 420 }

/** The pill rail plus its outer gap, which the session column makes room for. */
export const RAIL_WIDTH = 100

// The session column keeps at least this much room; the sidebar yields first.
const CENTER_MIN_WIDTH = 440

const WorkspaceState = Persistence.struct({
  sidebar: Persistence.struct({ opened: Schema.Boolean, width: Schema.Finite }),
  view: Schema.Literals(SHELL_VIEWS),
})

const AdultState = Persistence.struct({ on: Schema.Boolean })

/**
 * The desktop shell around the routed screen. On desktop a rail on the left picks the view: Lucina and her pages in a
 * native content card, Computer in another, or Code, which is OpenCode's own projects, sessions and routed screen.
 * The sidebar and the view are remembered. Without a native host (web, phone) the shell is OpenCode alone.
 */
export const { use: useWorkspace, provider: WorkspaceProvider } = createSimpleContext({
  name: "Workspace",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const command = useCommand()
    const language = useLanguage()
    const preferences = useSettings()
    const global = useGlobal()
    const servers = useServers()
    const layout = useLayout()
    const mobile = createMediaQuery("(max-width: 767px)")
    const [viewport, setViewport] = createSignal(window.innerWidth)
    makeEventListener(window, "resize", () => setViewport(window.innerWidth))

    const [store, setStore] = persisted(Persist.global("secretary.workspace"), WorkspaceState, {
      sidebar: { opened: true, width: SIDEBAR_WIDTH.default },
      view: DEFAULT_VIEW,
    })

    // Her "Show adult plugins" switch as her web view last reported it (default on, like hers), kept for the next start.
    const [adultStore, setAdultStore] = persisted(Persist.global("secretary.adultPlugins"), AdultState, { on: true })
    const adult = () => adultStore.on
    const allowed = (next: ShellView) => viewAllowed(next, adult())

    const railAvailable = () => !!platform.companion && !mobile()
    // Without the rail the shell is OpenCode alone, whatever view was remembered. A view the switch hides falls back.
    const view = (): ShellView => (railAvailable() ? (allowed(store.view) ? store.view : DEFAULT_VIEW) : "code")
    const codeVisible = () => view() === "code"
    // OpenCode's vertical tabs hide the titlebar, which now carries the view title and New chat.
    const verticalTabs = () => preferences.appearance.tabLayout() === "vertical" && !mobile() && !railAvailable()
    const sidebarAvailable = () => !mobile() && !verticalTabs() && codeVisible()
    const sidebarVisible = () => store.sidebar.opened && sidebarAvailable()

    const sidebarWidth = createMemo(() => {
      if (!sidebarVisible()) return 0
      const room = viewport() - CENTER_MIN_WIDTH - (railAvailable() ? RAIL_WIDTH : 0)

      return clamp(Math.min(store.sidebar.width, room), SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)
    })

    // A page of Lucina's web app asked for beyond the view's own (her account, the notifications); every click counts.
    const [page, setPage] = createSignal<string | undefined>(undefined, { equals: false })
    const show = (next: ShellView) => {
      if (!allowed(next)) return
      setPage(undefined)
      setStore("view", next)
    }
    const open = (next: ShellView, path: string) => {
      if (!allowed(next)) return
      setStore("view", next)
      setPage(path)
    }

    // Selects the project in OpenCode's sidebar, adding it first when OpenCode does not know it yet.
    const openProject = (directory: string) => {
      const conn =
        servers.visible.find((item) => ServerConnection.key(item) === layout.home.selection().server) ??
        servers.visible[0]

      if (!conn) return
      const added = addProjects(global.ensureServerCtx(conn), [directory])

      if (added) layout.home.setSelection({ server: ServerConnection.key(conn), directory: added })
    }

    // Focus mode: a plugin's page takes nearly the whole window while the rail steps aside (the viewer's fullscreen
    // inside the shell). Code has no web page to focus. The main process owns it and sends every change as a `focus`
    // command; its ways out (Exit focus, Esc, View → Exit Focus, another view, a reload) work whatever the page does.
    // The rules are nextFocus: the shell's own exits apply at once, before the main process confirms.
    const [focus, setFocus] = createSignal(false)
    const focused = () => focus() && railAvailable() && !codeVisible()
    const move = (event: FocusEvent) => setFocus((current) => nextFocus(current, event))
    createEffect(on(view, () => move("view-change"), { defer: true }))

    const run = (next: ShellCommand) => {
      if (next.action === "focus") return void move(next.on ? "page-on" : "page-off")
      if (next.action === "adult") return void setAdultStore("on", next.on)
      const page = commandPage(next)

      if (page) return void open(reduceView(untrack(view), next), page)
      show(reduceView(untrack(view), next))
      const project = commandProject(next)

      if (project) openProject(project)
    }

    // Lucina's web app drives the shell through window.secretaryShell; the host forwards it here.
    createEffect(() => {
      if (!railAvailable()) return
      const off = platform.companion?.onCommand?.(run)

      if (off) onCleanup(off)
    })

    // What waits for the owner, as the main process counts it: the rail's Decisions badge.
    const [attention, setAttention] = createSignal<AttentionCounts>({ approvals: 0, decisions: 0 })
    createEffect(() => {
      const bridge = railAvailable() ? platform.companion?.attention : undefined

      if (!bridge) return
      let changed = false
      const off = bridge.onChange((counts) => {
        changed = true
        setAttention(counts)
      })
      // A change that arrives before the first answer is the newer one.
      void bridge
        .counts()
        .then((counts) => {
          if (!changed) setAttention(counts)
        })
        .catch(() => {})
      onCleanup(off)
    })

    // Something outside the rail (a notification, a shortcut) moved OpenCode to another screen: bring Code forward.
    let shown = routeKey(layout.route())
    createEffect(
      on(
        layout.route,
        (route) => {
          if (!railAvailable()) return
          if (revealsCode(shown, route)) show("code")
          if (route.type !== "settings") shown = routeKey(route)
        },
        { defer: true },
      ),
    )

    command.register("workspace", () => [
      {
        id: "sidebar.toggle",
        title: language.t("workspace.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+shift+b",
        disabled: !sidebarAvailable(),
        onSelect: () => setStore("sidebar", "opened", (opened) => !opened),
      },
      ...(railAvailable()
        ? [
            {
              id: "secretary.lucina.toggle",
              title: language.t("shell.command.lucina"),
              category: language.t("command.category.view"),
              keybind: "mod+alt+b",
              onSelect: () => show("lucina"),
            },
            {
              id: "secretary.code.open",
              title: language.t("shell.command.code"),
              category: language.t("command.category.view"),
              keybind: "mod+alt+a",
              onSelect: () => show("code"),
            },
            {
              id: "secretary.computer.open",
              title: language.t("shell.command.computer"),
              category: language.t("command.category.view"),
              keybind: "mod+alt+c",
              onSelect: () => show("computer"),
            },
          ]
        : []),
    ])

    return {
      sidebar: {
        available: sidebarAvailable,
        visible: sidebarVisible,
        width: sidebarWidth,
        resize: (width: number) => setStore("sidebar", "width", clamp(width, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)),
        toggle: () => setStore("sidebar", "opened", (opened) => !opened),
      },
      rail: {
        available: railAvailable,
        badge: (next: ShellView) => railBadge(next, attention()),
      },
      focus: {
        on: focused,
        // The titlebar's Exit focus.
        exit: () => {
          move("exit")
          platform.companion?.exitFocusMode?.()
        },
      },
      view: {
        current: view,
        code: codeVisible,
        show,
        open,
        page,
        allowed,
        verticalTabs,
      },
    }
  },
})

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
