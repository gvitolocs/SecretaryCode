import { contextBridge, ipcRenderer } from "electron"
import { LUCINA_ORIGIN } from "../main/secretary/lucina-web-policy"
import { isProjectPath, isShellView, parseShellCommand, type ShellCommand } from "../main/secretary/shell-command"

// The preload of her web views the shell frames (Lucina and Computer; the image viewer has none). It runs sandboxed, so
// it is a self-contained bundle (out/preload/lucina.cjs) that may import nothing but Electron.
// window.secretaryShell lets her web app ask the desktop shell to show Code or another view, or to enter focus mode.
// Each call sends one plain message; the main process checks the sender again before it forwards anything.

function send(command: ShellCommand) {
  ipcRenderer.send("secretary:shell", command)
}

/** A Lucina Prompter overlay request; the main process (main/secretary/prompter-overlay.ts) checks it and the sender. */
function overlay(request: Record<string, unknown>) {
  ipcRenderer.send("secretary:prompter-overlay", request)
}

/** One window.secretaryApprover call: the main process (main/secretary/approver.ts) does the work and the Touch ID. */
function approver(action: string, input?: unknown): Promise<Record<string, unknown>> {
  return ipcRenderer.invoke("secretary:approver", action, input) as Promise<Record<string, unknown>>
}

// Her per-device "Show adult plugins" switch (web/src/lib/adult.ts): "0" is off, anything else or nothing is on.
const ADULT_KEY = "secretary.showAdultPlugins"
let adult: boolean | undefined

function readAdult() {
  try {
    return localStorage.getItem(ADULT_KEY) !== "0"
  } catch {
    return true
  }
}

function tellAdult(on: boolean) {
  if (on === adult) return
  adult = on
  send({ action: "adult", on })
}

if (location.origin === LUCINA_ORIGIN && window.top === window) {
  // Owner approvals with Touch ID on this Mac. Her page names a request; the main process reads it from the server,
  // asks for Touch ID with the server's own summary, signs it in the Secure Enclave and sends the decision.
  contextBridge.exposeInMainWorld(
    "secretaryApprover",
    Object.freeze({
      version: 1,
      async status() {
        const r = await approver("status")
        return r.ok === true
          ? { available: r.available === true, hasKey: r.hasKey === true, ...(typeof r.keyId === "string" ? { keyId: r.keyId } : {}) }
          : { available: false, hasKey: false }
      },
      setup() {
        return approver("setup")
      },
      approve(approvalId: string) {
        if (typeof approvalId !== "string") throw new TypeError("approvalId must be a string")
        return approver("approve", approvalId)
      },
      revoke(deviceId: string) {
        if (typeof deviceId !== "string") throw new TypeError("deviceId must be a string")
        return approver("revoke", deviceId)
      },
      remove() {
        return approver("remove")
      },
    }),
  )
  // The rail follows her switch without help from her page: read on load and after each route change (the shell's own
  // navigation is a popstate). setAdultPlugins below tells it at once.
  tellAdult(readAdult())
  addEventListener("popstate", () => tellAdult(readAdult()))
  contextBridge.exposeInMainWorld(
    "secretaryShell",
    Object.freeze({
      version: 1,
      showCode(projectPath?: string) {
        if (projectPath !== undefined && !isProjectPath(projectPath)) throw new TypeError("projectPath must be an absolute path")
        send(projectPath === undefined ? { action: "showCode" } : { action: "showCode", projectPath })
      },
      hideCode() {
        send({ action: "hideCode" })
      },
      /**
       * Her web app is signing out: the Mac forgets its device token first, or it would sign her straight back in.
       * Settles once it has; her page then ends its own session.
       */
      async signOut(): Promise<void> {
        await ipcRenderer.invoke("secretary:sign-out")
      },
      show(view: string) {
        if (!isShellView(view)) throw new TypeError("unknown view")
        const command = parseShellCommand({ action: "show", view })
        if (command) send(command)
      },
      /** Focus mode: her page takes nearly the whole window; the shell's rail and Lucina step aside. */
      setFocusMode(on: boolean) {
        if (typeof on !== "boolean") throw new TypeError("on must be a boolean")
        send({ action: "focus", on })
      },
      /** Her "Show adult plugins" switch changed: the rail shows or hides the adult plugins (NClient). */
      setAdultPlugins(on: boolean) {
        if (typeof on !== "boolean") throw new TypeError("on must be a boolean")
        tellAdult(on)
      },
      /**
       * Lucina Prompter: `path` ("/prompter/<slug>?live=1&overlay=1") in a small frameless window above other apps, at
       * `opacity` (0.3-1). One overlay at a time; a second call reuses it.
       */
      openPrompterOverlay(path: string, opts?: { opacity?: number }) {
        if (typeof path !== "string") throw new TypeError("path must be a string")
        const opacity = opts?.opacity
        overlay(typeof opacity === "number" ? { action: "open", path, opacity } : { action: "open", path })
      },
      /** Inside the overlay: its window's opacity (0.3-1). */
      setOverlayOpacity(opacity: number) {
        if (typeof opacity !== "number") throw new TypeError("opacity must be a number")
        overlay({ action: "opacity", opacity })
      },
      /** Inside the overlay: the take ended, close the window. */
      closePrompterOverlay() {
        overlay({ action: "close" })
      },
      /**
       * Settings → Plugins → Pixiv → Connect: pixiv's own login page (the loginUrl from the Pixiv service) in a window of
       * the shell. Settles with the authorization code once the owner has signed in, or with an error.
       */
      pixivLogin(loginUrl: string): Promise<{ code: string } | { error: "cancelled" | "failed" | "bad_url" }> {
        if (typeof loginUrl !== "string") throw new TypeError("loginUrl must be a string")
        return ipcRenderer.invoke("secretary:pixiv-login", loginUrl)
      },
      /**
       * Copy image (her media menu): the picture, as a data: URL of a PNG, JPEG, WebP or GIF, or the address of one of
       * her pictures, on the Mac's clipboard. Settles with whether it is there.
       */
      copyImage(source: string): Promise<boolean> {
        if (typeof source !== "string") throw new TypeError("source must be a string")
        return ipcRenderer.invoke("secretary:copy-image", source) as Promise<boolean>
      },
      /** The shell's focus mode as it changes, including when the shell itself leaves it. Returns the unsubscribe. */
      onFocusModeChange(listener: (on: boolean) => void) {
        if (typeof listener !== "function") throw new TypeError("listener must be a function")
        const handler = (_event: unknown, on: unknown) => listener(on === true)
        ipcRenderer.on("secretary:focus-mode", handler)

        return () => {
          ipcRenderer.removeListener("secretary:focus-mode", handler)
        }
      },
    }),
  )
}
