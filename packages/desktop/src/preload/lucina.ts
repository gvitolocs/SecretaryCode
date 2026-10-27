import { contextBridge, ipcRenderer } from "electron"
import { LUCINA_ORIGIN } from "../main/secretary/lucina-web-policy"
import { isProjectPath, isShellView, parseShellCommand, type ShellCommand } from "../main/secretary/shell-command"

// The preload of Lucina's own web view (the Lucina panel only; the Computer and image-viewer views have none). It runs
// sandboxed, so it is a self-contained bundle (out/preload/lucina.cjs) that may import nothing but Electron.
// window.secretaryShell lets her web app ask the desktop shell to show Code or another view. Each call sends one plain
// message; the main process checks the sender again before it forwards anything.

function send(command: ShellCommand) {
  ipcRenderer.send("secretary:shell", command)
}

if (location.origin === LUCINA_ORIGIN && window.top === window) {
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
      /** Her web app signed out: the Mac forgets its device token too, or it would sign her straight back in. */
      signOut() {
        ipcRenderer.send("secretary:shell", { action: "signOut" })
      },
      show(view: string) {
        if (!isShellView(view)) throw new TypeError("unknown view")
        const command = parseShellCommand({ action: "show", view })
        if (command) send(command)
      },
    }),
  )
}
