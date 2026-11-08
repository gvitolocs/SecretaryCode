import { isLucinaUrl } from "./lucina-web-policy"

// window.secretaryShell.copyImage(source): what her page may hand the Mac's clipboard, kept free of Electron so it can
// be tested directly. The source is either the picture itself (a data: URL of a PNG, JPEG, WebP or GIF) or the address
// of one of her pictures (her origin only), which the main process loads with her partition's cookies.

/** The largest picture the clipboard takes from her page (a 30 MB original becomes about 40 MB of base64). */
export const MAX_PICTURE_BYTES = 48 * 1024 * 1024

export type CopySource = { kind: "data"; bytes: Buffer } | { kind: "url"; url: string }

const DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/

/** The picture `value` names, or undefined for anything else (another origin, another type, too large, not a string). */
export function copySource(value: unknown): CopySource | undefined {
  if (typeof value !== "string" || value.length > Math.ceil((MAX_PICTURE_BYTES * 4) / 3) + 64) return undefined
  const data = DATA_URL.exec(value)
  if (data) {
    const bytes = Buffer.from(data[1]!, "base64")
    return bytes.length > 0 && bytes.length <= MAX_PICTURE_BYTES ? { kind: "data", bytes } : undefined
  }
  if (!isLucinaUrl(value)) return undefined
  const url = new URL(value)
  return url.username || url.password ? undefined : { kind: "url", url: url.href }
}

/** Whether a response may be read as a picture: it succeeded, says it is an image, and is not larger than the limit. */
export function pictureResponse(response: { ok: boolean; headers: { get(name: string): string | null } }) {
  const type = response.headers.get("content-type") ?? ""
  const length = Number(response.headers.get("content-length") ?? 0)
  return response.ok && /^image\//i.test(type) && !(length > MAX_PICTURE_BYTES)
}
