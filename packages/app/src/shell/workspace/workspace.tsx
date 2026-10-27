import { createMemo, createSignal } from "solid-js"
import { Schema } from "effect"
import { createSimpleContext } from "@opencode/ui/context"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform, type CompanionPanel } from "@/runtime/platform/platform"
import { useSettings } from "@/settings/model"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"

export const SIDEBAR_WIDTH = { min: 220, default: 264, max: 420 }

export const COMPANION_WIDTH = { min: 300, default: 360, max: 640 }

// The session column keeps at least this much room; the companion yields first, then the sidebar.
const CENTER_MIN_WIDTH = 440

const WorkspaceState = Persistence.struct({
  sidebar: Persistence.struct({ opened: Schema.Boolean, width: Schema.Finite }),
  companion: Persistence.struct({
    opened: Schema.Boolean,
    width: Schema.Finite,
    panel: Schema.Literals(["lucina", "agents", "computer"]),
  }),
})

/**
 * The desktop workspace around the routed screen: projects and sessions on the left, Secretary's companion panels on
 * the right. Both remember whether they are open and how wide they are.
 */
export const { use: useWorkspace, provider: WorkspaceProvider } = createSimpleContext({
  name: "Workspace",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const command = useCommand()
    const language = useLanguage()
    const preferences = useSettings()
    const mobile = createMediaQuery("(max-width: 767px)")
    const [viewport, setViewport] = createSignal(window.innerWidth)
    makeEventListener(window, "resize", () => setViewport(window.innerWidth))

    const [store, setStore] = persisted(Persist.global("secretary.workspace"), WorkspaceState, {
      sidebar: { opened: true, width: SIDEBAR_WIDTH.default },
      companion: { opened: true, width: COMPANION_WIDTH.default, panel: "lucina" },
    })

    const companionAvailable = () => !!platform.companion && !mobile()
    // Vertical tabs bring OpenCode's own left sidebar, which on macOS also replaces the titlebar.
    const sidebarAvailable = () => !mobile() && preferences.appearance.tabLayout() !== "vertical"
    const sidebarVisible = () => store.sidebar.opened && sidebarAvailable()
    const companionVisible = () => store.companion.opened && companionAvailable()

    const sidebarWidth = createMemo(() => {
      if (!sidebarVisible()) return 0
      const room = viewport() - CENTER_MIN_WIDTH - (companionVisible() ? COMPANION_WIDTH.min : 0)

      return clamp(Math.min(store.sidebar.width, room), SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max)
    })

    const companionWidth = createMemo(() => {
      if (!companionVisible()) return 0
      const room = viewport() - CENTER_MIN_WIDTH - sidebarWidth()

      return clamp(Math.min(store.companion.width, room), COMPANION_WIDTH.min, COMPANION_WIDTH.max)
    })

    const show = (panel: CompanionPanel) => {
      if (companionVisible() && store.companion.panel === panel) return setStore("companion", "opened", false)
      setStore("companion", { opened: true, panel })
    }

    command.register("workspace", () => [
      {
        id: "sidebar.toggle",
        title: language.t("workspace.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+shift+b",
        disabled: !sidebarAvailable(),
        onSelect: () => setStore("sidebar", "opened", (opened) => !opened),
      },
      ...(companionAvailable()
        ? [
            {
              id: "secretary.lucina.toggle",
              title: language.t("workspace.companion.toggle"),
              category: language.t("command.category.view"),
              keybind: "mod+alt+b",
              onSelect: () => show("lucina"),
            },
            {
              id: "secretary.agents.open",
              title: language.t("workspace.companion.agents.toggle"),
              category: language.t("command.category.view"),
              keybind: "mod+alt+a",
              onSelect: () => show("agents"),
            },
            {
              id: "secretary.computer.open",
              title: language.t("workspace.companion.computer.toggle"),
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
      companion: {
        available: companionAvailable,
        visible: companionVisible,
        width: companionWidth,
        panel: () => store.companion.panel,
        resize: (width: number) =>
          setStore("companion", "width", clamp(width, COMPANION_WIDTH.min, COMPANION_WIDTH.max)),
        select: (panel: CompanionPanel) => setStore("companion", { opened: true, panel }),
        close: () => setStore("companion", "opened", false),
        toggle: () => setStore("companion", "opened", (opened) => !opened),
      },
    }
  },
})

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
