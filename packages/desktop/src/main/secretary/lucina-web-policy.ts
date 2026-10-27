// Rules for Lucina's web partition (`persist:lucina-web`), kept free of Electron so they can be tested directly.
// The Lucina, Computer and image-viewer views all load Lucina's web app from this one origin and partition.

export const LUCINA_ORIGIN = "https://getsecretary.tech"
export const LUCINA_PARTITION = "persist:lucina-web"

/** Whether `value` is a page on Lucina's origin (the only top-level pages the views may show). */
export function isLucinaUrl(value: string) {
  return URL.canParse(value) && new URL(value).origin === LUCINA_ORIGIN
}

/**
 * The bundled file a request may be answered from: the path relative to the bundle ("" for the root), or undefined
 * when the request must go to the server. Only GET and HEAD on Lucina's origin qualify, never the API (`/v1`),
 * and never a path that would leave the bundle.
 */
export function bundlePath(url: string, method: string) {
  if ((method !== "GET" && method !== "HEAD") || !isLucinaUrl(url)) return undefined
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(url).pathname)
  } catch {
    return undefined
  }
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return undefined
  const parts = pathname.split("/").filter(Boolean)
  if (parts.some((part) => part === ".." || part === "." || part.includes("\\") || part.includes("\0"))) return undefined
  return parts.join("/")
}

/**
 * getsecretary.tech's own Content-Security-Policy for its pages (deploy/Caddyfile.p1 in SecretaryIOS), for a bundle
 * built offline; scripts/bundle-lucina-web.ts records the live header next to the bundle when it can.
 */
export const LUCINA_PAGE_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; connect-src 'self' blob: data:; media-src 'self' blob:; worker-src 'self' blob:; manifest-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"

/** Content types for the files a Vite build emits. */
export function contentType(file: string) {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase()
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json",
    webmanifest: "application/manifest+json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    ico: "image/x-icon",
    wasm: "application/wasm",
    woff2: "font/woff2",
    woff: "font/woff",
    ttf: "font/ttf",
    glb: "model/gltf-binary",
    task: "application/octet-stream",
    mp3: "audio/mpeg",
    txt: "text/plain; charset=utf-8",
  }
  return types[ext] ?? "application/octet-stream"
}
