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
