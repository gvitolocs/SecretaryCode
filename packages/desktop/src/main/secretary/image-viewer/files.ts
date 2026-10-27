import { execFile } from "node:child_process"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises"
import path from "node:path"
import { imageType } from "./formats"

const run = promisify(execFile)

const order = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

export async function folderImages(clicked: string) {
  const folder = await realpath(path.dirname(clicked))
  const entries = await Promise.all(
    (await readdir(folder))
      .filter((name) => imageType(name)?.uti !== "public.camera-raw-image" && imageType(name))
      .map(async (name) => {
        const file = path.join(folder, name)
        const resolved = await realpath(file).catch(() => undefined)
        if (!resolved || path.dirname(resolved) !== folder || !imageType(resolved) || imageType(resolved)?.uti === "public.camera-raw-image") return
        const info = await stat(resolved).catch(() => undefined)
        if (!info?.isFile()) return
        return {
          name,
          mime: imageType(name)!.mime,
          takenAt: info.birthtime.toISOString(),
          assetId: createHash("sha256").update(file).digest("hex"),
        }
      }),
  )
  const images = entries
    .filter((entry) => entry !== undefined)
    .sort((a, b) => order.compare(a.name, b.name) || a.name.localeCompare(b.name))
  const index = images.findIndex((file) => file.name === path.basename(clicked))
  if (index < 0) throw new Error("Image is unavailable or outside its folder")
  const offset = Math.max(0, Math.min(index - 1000, images.length - 2000))
  return { folder, files: images.slice(offset, offset + 2000), startIndex: index - offset }
}

/** Tokens grant read access only to direct image children of one canonical folder. */
export class ImageFiles {
  private folders = new Map<string, { folder: string; fallback: string }>()

  add(folder: string, fallback: string) {
    const token = randomBytes(24).toString("hex")
    this.folders.set(token, { folder, fallback })
    return token
  }

  setFallback(token: string, fallback: string) {
    const entry = this.folders.get(token)
    if (entry) entry.fallback = fallback
  }

  drop(token: string) {
    this.folders.delete(token)
  }

  url(token: string, name: string) {
    return `secretary-file://${token}/${encodeURIComponent(name)}`
  }

  async handle(request: Request) {
    const headers = {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "https://getsecretary.tech",
      "X-Content-Type-Options": "nosniff",
      // SVGs must never execute script, even if loaded as a top-level document.
      "Content-Security-Policy":
        "default-src 'none'; img-src secretary-file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox",
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers })
    try {
      const url = new URL(request.url)
      const entry = this.folders.get(url.hostname)
      if (url.protocol !== "secretary-file:" || !entry || url.username || url.password || url.port || url.search)
        return new Response(null, { status: 404, headers })
      if (url.pathname === "/__viewer__/index.html")
        return new Response(request.method === "HEAD" ? null : entry.fallback, {
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        })
      const display = url.pathname.startsWith("/__viewer__/display/")
      const name = decodeURIComponent(url.pathname.slice(display ? "/__viewer__/display/".length : 1))
      const type = imageType(name)
      if (
        !name ||
        name === "." ||
        name === ".." ||
        /[/\\\0]/.test(name) ||
        !type ||
        type.uti === "public.camera-raw-image"
      )
        return new Response(null, { status: 403, headers })
      const file = await realpath(path.join(entry.folder, name))
      if (path.dirname(file) !== entry.folder || !imageType(file) || imageType(file)?.uti === "public.camera-raw-image" || !(await stat(file)).isFile())
        return new Response(null, { status: 403, headers })
      if (display && ["public.heic", "public.heif", "public.tiff", "com.microsoft.bmp"].includes(type.uti)) {
        const temporary = await mkdtemp(path.join(tmpdir(), "secretary-image-"))
        try {
          await run("/usr/bin/sips", ["-s", "format", "png", file, "--out", path.join(temporary, "image.png")], {
            timeout: 15_000,
          })
          return new Response(request.method === "HEAD" ? null : await readFile(path.join(temporary, "image.png")), {
            headers: { ...headers, "Content-Type": "image/png" },
          })
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
      }
      return new Response(request.method === "HEAD" ? null : await readFile(file), {
        headers: {
          ...headers,
          "Content-Type": type.mime,
          ...(name.toLowerCase().endsWith(".svgz") ? { "Content-Encoding": "gzip" } : {}),
        },
      })
    } catch {
      return new Response(null, { status: 404, headers })
    }
  }
}
