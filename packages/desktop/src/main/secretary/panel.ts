import { BrowserWindow, ipcMain, type WebContentsView } from "electron"
import { isRendererUrl } from "../windows/scheme"
import { lucinaView } from "./index"
import { codingLanesView } from "./lane-window"
import { computerView } from "./computer-view"

export type CompanionPanel = "lucina" | "agents" | "computer"

type Rect = { x: number; y: number; width: number; height: number }

// Each panel keeps one warm view. The renderer owns the layout, reports where the active panel sits, and the view
// follows that rectangle; hiding a panel detaches its view without reloading it.
const views: Record<CompanionPanel, () => WebContentsView> = {
  lucina: lucinaView,
  agents: codingLanesView,
  computer: computerView,
}

const state = { host: undefined as BrowserWindow | undefined, created: new Set<WebContentsView>() }

/** Call once during startup; the main renderer places the companion panels through `secretary:place`. */
export function setupCompanionPanels() {
  ipcMain.on("secretary:place", (event, panel: unknown, rect: unknown) => {
    if (!event.senderFrame || event.senderFrame.parent || !isRendererUrl(event.senderFrame.url)) return
    const window = BrowserWindow.fromWebContents(event.sender)

    if (!window || window.isDestroyed()) return
    const zoom = event.sender.getZoomFactor()
    place(
      window,
      panel === "lucina" || panel === "agents" || panel === "computer" ? panel : undefined,
      readRect(rect, zoom),
      zoom,
    )
  })
}

function place(window: BrowserWindow, panel: CompanionPanel | undefined, rect: Rect | undefined, zoom: number) {
  if (state.host !== window) adopt(window)
  const target = panel && rect ? views[panel]() : undefined
  state.created.forEach((view) => {
    if (view !== target && window.contentView.children.includes(view)) window.contentView.removeChildView(view)
  })

  if (!target || !rect) return

  if (!state.created.has(target)) {
    state.created.add(target)
    target.webContents.once("destroyed", () => state.created.delete(target))
  }

  if (!window.contentView.children.includes(target)) {
    window.contentView.addChildView(target)
    target.webContents.focus()
  }
  target.setBounds(rect)
  // Matches the workspace card's 10px corner radius, which the native view would otherwise square off.
  target.setBorderRadius(Math.round(10 * zoom))
}

// One window shows the companion at a time: the latest window to place a panel takes the views from the previous one.
function adopt(window: BrowserWindow) {
  const previous = state.host

  if (previous && !previous.isDestroyed())
    state.created.forEach((view) => {
      if (previous.contentView.children.includes(view)) previous.contentView.removeChildView(view)
    })
  state.host = window
  window.once("closed", () => {
    if (state.host !== window) return
    state.host = undefined
    state.created.forEach((view) => view.webContents.close())
    state.created.clear()
  })
}

function readRect(value: unknown, zoom: number): Rect | undefined {
  if (!value || typeof value !== "object") return
  const rect = value as Record<string, unknown>
  const [x, y, width, height] = [rect.x, rect.y, rect.width, rect.height].map((part) =>
    typeof part === "number" && Number.isFinite(part) && part >= 0 && part < 100_000 ? Math.round(part * zoom) : NaN,
  )

  if ([x, y, width, height].some(Number.isNaN) || width < 1 || height < 1) return

  return { x, y, width, height }
}
