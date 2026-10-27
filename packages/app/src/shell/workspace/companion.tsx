import { createEffect, onCleanup, onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useWorkspace } from "./workspace"
import { viewPanel, viewRoute } from "./views"

/**
 * The content card right of the rail. Its content is a native view owned by the desktop host; this component reserves
 * the rounded card, keeps the view on top of it, and hides the view while a popover or dialog would sit underneath it.
 * Every view but Code shows here: Computer has its own native view, the rest are pages of Lucina's web view.
 */
export function ContentCard(props: { hidden?: boolean }) {
  const workspace = useWorkspace()
  const language = useLanguage()
  const platform = usePlatform()
  let card: HTMLDivElement | undefined
  let frame: number | undefined

  const place = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      const rect = card?.getBoundingClientRect()

      if (props.hidden || !rect || rect.width < 1 || rect.height < 1 || covered(rect))
        return platform.companion?.place(undefined)
      platform.companion?.place(viewPanel(workspace.view.current()), {
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
  // Another window may have taken the native view; focusing this one brings it back.
  makeEventListener(window, "focus", place)
  createEffect(() => {
    workspace.view.current()
    props.hidden
    place()
  })
  // Lucina's pages share one warm web view: the view decides which page it shows.
  createEffect(() => {
    const route = workspace.view.page() ?? viewRoute(workspace.view.current())

    if (route) platform.companion?.navigate?.(route)
  })
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    platform.companion?.place(undefined)
  })

  return (
    <section
      data-slot="content-region"
      data-view={workspace.view.current()}
      aria-label={language.t(`shell.view.${workspace.view.current()}`)}
      class="relative flex h-full min-h-0 min-w-0 flex-1 flex-col ps-2 pe-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]"
      style={{ display: props.hidden ? "none" : undefined }}
    >
      <div
        ref={card}
        data-slot="content-card"
        class="min-h-0 flex-1 overflow-hidden rounded-[12px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      />
    </section>
  )
}

/** Whether a portalled overlay (menu, dialog, popover) overlaps the native companion view. Tooltips never count. */
export function covered(rect: Pick<DOMRect, "left" | "right" | "top" | "bottom">, body: HTMLElement = document.body) {
  return Array.from(body.children).some((child) => {
    if (child.id === "root" || !(child instanceof HTMLElement) || child.matches("script,style,template,svg"))
      return false

    if (child.querySelector("[data-sonner-toaster]")) return false

    return [child, ...child.children, ...Array.from(child.children).flatMap((item) => [...item.children])].some(
      (element) => {
        // Tooltip portals wrap the role in positioner layers, so look down the subtree as well as up.
        if (element.closest("[role=tooltip]") || element.querySelector("[role=tooltip]")) return false
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
