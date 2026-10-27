import { createEffect, For, onCleanup, onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { Tooltip } from "@opencode/ui/tooltip"
import lucina from "../../../../ui/src/assets/images/secretary-lucina.png"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform, type CompanionPanel } from "@/runtime/platform/platform"
import { COMPANION_WIDTH, useWorkspace } from "./workspace"

/**
 * The right-hand companion region. The panel content is a native view owned by the desktop host; this component
 * reserves its rounded card, keeps the view on top of it, and hides the view while a popover or dialog would sit
 * underneath it.
 */
export function CompanionRegion() {
  const workspace = useWorkspace()
  const language = useLanguage()
  const command = useCommand()
  const platform = usePlatform()
  let card: HTMLDivElement | undefined
  let frame: number | undefined

  const tabs: { id: CompanionPanel; label: string; command: string }[] = [
    { id: "lucina", label: language.t("workspace.companion.lucina"), command: "secretary.lucina.toggle" },
    { id: "agents", label: language.t("workspace.companion.agents"), command: "secretary.agents.open" },
    { id: "computer", label: language.t("workspace.companion.computer"), command: "secretary.computer.open" },
  ]

  const place = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      const rect = card?.getBoundingClientRect()

      if (!rect || rect.width < 1 || rect.height < 1 || covered(rect)) return platform.companion?.place(undefined)
      platform.companion?.place(workspace.companion.panel(), {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })
    })
  }

  onMount(() => {
    if (!card) return
    createResizeObserver(card, place)
    // Popovers, menus and dialogs portal into the body; the native view would otherwise paint over them.
    const portals = new MutationObserver(place)
    portals.observe(document.body, { childList: true })
    onCleanup(() => portals.disconnect())
  })
  makeEventListener(window, "resize", place)
  // Another window may have taken the companion; focusing this one brings it back.
  makeEventListener(window, "focus", place)
  createEffect(() => {
    workspace.companion.panel()
    workspace.companion.width()
    place()
  })
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    platform.companion?.place(undefined)
  })

  return (
    <aside
      data-slot="companion-region"
      aria-label={language.t("workspace.companion.region")}
      class="relative flex h-full min-h-0 shrink-0 flex-col pe-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]"
      style={{ width: `${workspace.companion.width()}px` }}
    >
      <ResizeHandle
        class="-start-1"
        direction="horizontal"
        edge="start"
        size={workspace.companion.width()}
        min={COMPANION_WIDTH.min}
        max={COMPANION_WIDTH.max}
        onResize={workspace.companion.resize}
      />
      <div class="flex h-8 shrink-0 items-center gap-1 pb-1.5 ps-2" role="tablist">
        <For each={tabs}>
          {(tab) => (
            <Tooltip
              placement="bottom"
              value={
                <>
                  {tab.label}
                  <Keybind keys={command.keybindParts(tab.command)} variant="neutral" />
                </>
              }
            >
              <button
                type="button"
                role="tab"
                data-action={`companion-tab-${tab.id}`}
                aria-selected={workspace.companion.panel() === tab.id}
                class="flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[13px] leading-4 text-v2-text-text-faint hover:text-v2-text-text-base aria-selected:bg-v2-background-bg-layer-02 aria-selected:text-v2-text-text-base focus-visible:outline-none focus-visible:bg-v2-background-bg-layer-02 [app-region:no-drag]"
                onClick={() => workspace.companion.select(tab.id)}
              >
                {tab.id === "lucina" ? (
                  <img src={lucina} alt="" class="size-4 shrink-0 rounded-[4px]" draggable={false} />
                ) : (
                  <Icon name={tab.id === "computer" ? "monitor" : "terminal"} size="small" class="shrink-0" />
                )}
                {tab.label}
              </button>
            </Tooltip>
          )}
        </For>
        <div class="flex-1" />
        <Tooltip placement="bottom" value={language.t("workspace.companion.close")}>
          <IconButton
            type="button"
            variant="ghost-muted"
            icon={<Icon name="close-small" />}
            class="[app-region:no-drag]"
            onClick={workspace.companion.close}
            aria-label={language.t("workspace.companion.close")}
          />
        </Tooltip>
      </div>
      <div
        ref={card}
        data-slot="companion-card"
        class="min-h-0 flex-1 overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      />
    </aside>
  )
}

function covered(rect: DOMRect) {
  return Array.from(document.body.children).some((child) => {
    if (child.id === "root" || !(child instanceof HTMLElement) || child.matches("script,style,template,svg"))
      return false

    if (child.querySelector("[data-sonner-toaster]")) return false

    return [child, ...child.children, ...Array.from(child.children).flatMap((item) => [...item.children])].some(
      (element) => {
        if (element.getAttribute("role") === "tooltip" || element.closest("[role=tooltip]")) return false
        const box = element.getBoundingClientRect()

        return (
          box.width > 0 &&
          box.height > 0 &&
          box.left < rect.right &&
          box.right > rect.left &&
          box.top < rect.bottom &&
          box.bottom > rect.top
        )
      },
    )
  })
}
