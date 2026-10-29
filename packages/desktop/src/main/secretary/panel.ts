import { BrowserWindow, ipcMain, type WebContents, type WebContentsView } from "electron"
import { isRendererUrl } from "../windows/scheme"
import { forgetDevice, lucinaView, lucinaWebContents, openLucinaPath } from "./index"
import { isLucinaUrl } from "./lucina-web-policy"
import { isNavigatePath, parseShellCommand, type ShellCommand } from "./shell-command"
import { codingLanesView } from "./lane-window"
import { computerView, computerWebContents, onComputerFocusRequest } from "./computer-view"
import { focusExitKey, type FocusExit, type FocusSource } from "./focus-mode-core"
import { focusMode } from "./focus-mode"

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
  // The view the window shows now; only it may turn focus mode on, so it is the only one that can hold a token.
  placed: undefined as WebContents | undefined,
}

const watched = new WeakSet<WebContents>()

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

    if (!isNavigatePath(path)) return
    // Another of her pages or plugins (the rail's Gallery, Films ...) is never shown in focus mode.
    focusMode.exit("navigation")
    openLucinaPath(path)
  })

  // window.secretaryShell in her web views (Lucina, Computer). Only their own top frames are heard; the window hosting
  // the companion (or else the focused one) gets the validated command.
  ipcMain.on("secretary:shell", (event, message: unknown) => {
    if (!fromLucina(event)) return
    const command = parseShellCommand(message)

    if (command?.action === "focus") requestFocus(event.sender, "viewer", command.on)
    else if (command) toHost(command)
  })

  // The viewer's refused fullscreen asks the window for focus mode like her page's setFocusMode does.
  onComputerFocusRequest((on) => {
    const contents = computerWebContents()

    if (contents) requestFocus(contents, "computer", on)
  })

  // The titlebar's Exit focus.
  ipcMain.on("secretary:focus-exit", (event) => {
    if (!event.senderFrame || event.senderFrame.parent || !isRendererUrl(event.senderFrame.url)) return
    focusMode.exit("button")
  })

  // The main process owns focus mode: the window's shell shows it (rail, titlebar) and her web views hear it, so a
  // page can hide its own header (onFocusModeChange).
  focusMode.subscribe((on) => {
    toHost({ action: "focus", on })
    for (const contents of [lucinaWebContents(), computerWebContents()])
      if (contents && !contents.isDestroyed()) contents.send("secretary:focus-mode", on)
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
 * (the Computer page reloading after a sign-in while the Chat is open) is ignored.
 */
function requestFocus(contents: WebContents, source: FocusSource, on: boolean) {
  if (contents !== state.placed) return

  if (on) return void focusMode.enter(source)
  // Her page leaving takes the viewer's refused fullscreen with it: its Exit pill and Esc in Watch mode ask this way,
  // and the page never sees the fullscreen it was refused.
  focusMode.release(source, ...(contents === computerWebContents() ? (["computer"] as const) : []))
}

/**
 * Focus mode's ways out that no page can swallow, on the window's own renderer and on each companion view: Esc and
 * ⌃⌘F reach the main process before the page (a remote desktop canvas capturing keys), and a reload, another page or a
 * crash of the window or of the view on screen ends it. `screen` says whether `contents` is what the window shows.
 */
function watchFocusExits(contents: WebContents, screen: () => boolean, reload: FocusExit) {
  // A window adopted again (the companion moved back to it) is already watched.
  if (watched.has(contents)) return
  watched.add(contents)
  contents.on("before-input-event", (event, input) => {
    const key = focusMode.active() && screen() ? focusExitKey(input) : undefined

    if (!key) return
    event.preventDefault()
    focusMode.exit(key)
  })
  // Her own history changes (same document) and subframes keep it.
  contents.on("did-start-navigation", ((details: { isMainFrame?: boolean; isSameDocument?: boolean }, _url?: string, isInPlace?: boolean, isMainFrame?: boolean) => {
    if (screen() && (details?.isMainFrame ?? isMainFrame) && !(details?.isSameDocument ?? isInPlace)) focusMode.exit(reload)
  }) as never)
  contents.on("render-process-gone", () => {
    if (screen()) focusMode.exit("crash")
  })
  contents.once("destroyed", () => {
    if (screen()) focusMode.exit("view-change")
  })
}

/** A validated command for the window hosting the companion views, or else the focused one. */
function toHost(command: ShellCommand) {
  const host = state.host && !state.host.isDestroyed() ? state.host : BrowserWindow.getFocusedWindow()

  if (host && !host.isDestroyed()) host.webContents.send("secretary:shell-command", command)
}

/**
 * Brings the window hosting the companion (else any app window) forward and hands it a command; false when there is none.
 * A clicked notification uses it to land on the item's page.
 */
export function revealShell(command: ShellCommand) {
  const host = shellWindow()

  if (!host) return false
  if (host.isMinimized()) host.restore()
  host.show()
  host.focus()
  host.webContents.send("secretary:shell-command", command)

  return true
}

/** The window hosting the companion views, else any app window; undefined when none is open. */
export function shellWindow() {
  return state.host && !state.host.isDestroyed()
    ? state.host
    : BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && isRendererUrl(window.webContents.getURL()))
}

/** Whether an IPC message comes from one of her views (Lucina or Computer), in its top frame, on her origin. */
export function fromLucina(event: { sender: unknown; senderFrame?: { url: string; parent: unknown } | null }) {
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
  // Another view, settings over it, the card hidden: the view in focus mode left the window.
  if (state.placed !== target?.webContents) focusMode.exit("view-change")
  state.placed = target?.webContents

  if (!target || !rect) return

  if (!state.created.has(target)) {
    state.created.add(target)
    target.webContents.once("destroyed", () => state.created.delete(target))
    const contents = target.webContents
    watchFocusExits(contents, () => state.placed === contents, "navigation")
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
  watchFocusExits(window.webContents, () => state.host === window, "reload")
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
