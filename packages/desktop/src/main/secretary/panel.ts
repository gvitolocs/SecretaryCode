import { BrowserWindow, ipcMain, type WebContents, type WebContentsView } from "electron"
import { isRendererUrl } from "../windows/scheme"
import { forgetDevice, lucinaView, lucinaWebContents, openLucinaPath } from "./index"
import { isLucinaUrl } from "./lucina-web-policy"
import { isNavigatePath, parseShellCommand, type ShellCommand } from "./shell-command"
import { codingLanesView } from "./lane-window"
import { computerView, computerWebContents, onComputerFocusRequest, setComputerFocusMode } from "./computer-view"

export type CompanionPanel = "lucina" | "agents" | "computer"

type Rect = { x: number; y: number; width: number; height: number }

// Each panel keeps one warm view. The renderer owns the layout, reports where the active panel sits, and the view
// follows that rectangle; hiding a panel detaches its view without reloading it.
const views: Record<CompanionPanel, () => WebContentsView> = {
  lucina: lucinaView,
  agents: codingLanesView,
  computer: computerView,
}

const state = {
  host: undefined as BrowserWindow | undefined,
  created: new Set<WebContentsView>(),
  // The view the window shows now; only it may switch focus mode.
  placed: undefined as WebContents | undefined,
  // The view that turned focus mode on, and how to stop watching it.
  focused: undefined as { contents: WebContents; unwatch: () => void } | undefined,
}

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

  // Routes Lucina's warm view to a path of her web app (the rail's Gallery, Films, All chats ...) without a reload.
  ipcMain.on("secretary:navigate", (event, path: unknown) => {
    if (!event.senderFrame || event.senderFrame.parent || !isRendererUrl(event.senderFrame.url)) return

    if (isNavigatePath(path)) openLucinaPath(path)
  })

  // window.secretaryShell in her web views (Lucina, Computer). Only their own top frames are heard; the window hosting
  // the companion (or else the focused one) gets the validated command.
  ipcMain.on("secretary:shell", (event, message: unknown) => {
    if (!fromLucina(event)) return
    const command = parseShellCommand(message)

    if (command?.action === "focus") requestFocus(event.sender, command.on)
    else if (command) toHost(command)
  })

  // The viewer's refused fullscreen and Esc ask the window for focus mode like her page's setFocusMode does.
  onComputerFocusRequest((on) => {
    const contents = computerWebContents()

    if (contents) requestFocus(contents, on)
  })

  // The window's focus mode, relayed to her web views so a page can hide its own header (onFocusModeChange).
  ipcMain.on("secretary:focus-mode", (event, on: unknown) => {
    if (!event.senderFrame || event.senderFrame.parent || !isRendererUrl(event.senderFrame.url)) return
    const value = on === true
    // The window left focus mode (Esc, Exit focus, another view): nothing to watch any more.
    if (!value) unwatchFocus()
    setComputerFocusMode(value)
    for (const contents of [lucinaWebContents(), computerWebContents()])
      if (contents && !contents.isDestroyed()) contents.send("secretary:focus-mode", value)
  })

  // window.secretaryShell.signOut(): her web app awaits this before it ends its own session and clears its data, so
  // the Mac forgets its device token first and cannot sign her straight back in. Her page does the rest itself.
  ipcMain.handle("secretary:sign-out", async (event) => {
    if (!fromLucina(event)) return
    await forgetDevice().catch(() => {})
  })
}

/**
 * Focus mode asked for by one of her views. Only the view the window shows now may switch it: a view in the background
 * (the Computer page reloading after a sign-in while the Chat is open) is ignored. The view that turns it on is
 * watched, so focus mode ends when that view leaves the window, loads another page or goes away; the rail can never
 * stay hidden behind it.
 */
function requestFocus(contents: WebContents, on: boolean) {
  if (contents !== state.placed) return

  if (on) watchFocus(contents)
  else unwatchFocus()
  toHost({ action: "focus", on })
}

function watchFocus(contents: WebContents) {
  if (state.focused?.contents === contents) return
  unwatchFocus()
  // A reload or another page in the main frame ends it; her own history changes (same document) do not.
  const navigated = (
    details: { isMainFrame?: boolean; isSameDocument?: boolean },
    _url?: string,
    isInPlace?: boolean,
    isMainFrame?: boolean,
  ) => {
    if ((details?.isMainFrame ?? isMainFrame) && !(details?.isSameDocument ?? isInPlace)) endFocus(contents)
  }
  const destroyed = () => endFocus(contents)
  contents.on("did-start-navigation", navigated as never)
  contents.once("destroyed", destroyed)
  state.focused = {
    contents,
    unwatch: () => {
      contents.removeListener("did-start-navigation", navigated as never)
      contents.removeListener("destroyed", destroyed)
    },
  }
}

function unwatchFocus() {
  state.focused?.unwatch()
  state.focused = undefined
}

/** Ends focus mode when the view that turned it on is no longer the one on screen. */
function endFocus(contents: WebContents) {
  if (state.focused?.contents !== contents) return
  unwatchFocus()
  toHost({ action: "focus", on: false })
}

/** A validated command for the window hosting the companion views, or else the focused one. */
function toHost(command: ShellCommand) {
  const host = state.host && !state.host.isDestroyed() ? state.host : BrowserWindow.getFocusedWindow()

  if (host && !host.isDestroyed()) host.webContents.send("secretary:shell-command", command)
}

/** Whether an IPC message comes from one of her views (Lucina or Computer), in its top frame, on her origin. */
function fromLucina(event: { sender: unknown; senderFrame?: { url: string; parent: unknown } | null }) {
  const views = [lucinaWebContents(), computerWebContents()].filter((contents) => !!contents)
  const frame = event.senderFrame

  return views.includes(event.sender as never) && !!frame && !frame.parent && isLucinaUrl(frame.url)
}

function place(window: BrowserWindow, panel: CompanionPanel | undefined, rect: Rect | undefined, zoom: number) {
  if (state.host !== window) adopt(window)
  const target = panel && rect ? views[panel]() : undefined
  state.created.forEach((view) => {
    if (view !== target && window.contentView.children.includes(view)) window.contentView.removeChildView(view)
  })
  state.placed = target?.webContents
  // The view in focus mode left the window (another view, settings over it, the card hidden).
  if (state.focused && state.focused.contents !== state.placed) endFocus(state.focused.contents)

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
