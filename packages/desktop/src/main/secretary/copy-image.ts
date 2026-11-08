import { clipboard, ClipboardItem, ipcMain, nativeImage } from "electron"
import log from "electron-log/main.js"
import { copySource, MAX_PICTURE_BYTES, pictureResponse, type CopySource } from "./copy-image-core"
import { lucinaWebSession } from "./lucina-web"
import { fromLucina } from "./panel"

// window.secretaryShell.copyImage (the media menu's Copy image in her web app): her page puts a picture on the Mac's
// clipboard through the shell when the page's own clipboard refuses it, or when the page could not load the picture.
// Only her web views (top frame, her origin) may ask. A picture by address is loaded with her partition's session, so
// it carries her cookies and stays on her origin.

async function pictureBytes(source: CopySource): Promise<Buffer | undefined> {
  if (source.kind === "data") return source.bytes
  const response = await lucinaWebSession().fetch(source.url, { credentials: "include" })
  if (!pictureResponse(response)) return undefined
  const bytes = Buffer.from(await response.arrayBuffer())
  return bytes.length <= MAX_PICTURE_BYTES ? bytes : undefined
}

/** Call once during startup. */
export function setupCopyImage() {
  ipcMain.handle("secretary:copy-image", async (event, value: unknown): Promise<boolean> => {
    if (!fromLucina(event)) return false
    const source = copySource(value)
    if (!source) return false
    try {
      const bytes = await pictureBytes(source)
      const image = bytes ? nativeImage.createFromBuffer(bytes) : undefined
      if (!image || image.isEmpty()) return false
      // As a PNG whatever it came as: the type every Mac app pastes.
      await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })])
      return true
    } catch (error) {
      log.warn("copy image failed", error instanceof Error ? error.message : String(error))
      return false
    }
  })
}
