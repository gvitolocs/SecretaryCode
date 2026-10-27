import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { Configuration } from "electron-builder"
import { getConfig } from "./electron-builder.config"

// Every file or folder the main process opens under `process.resourcesPath` must be in the package's
// extraResources; a miss only shows up in an installed app (2026-10-27: resources/lucina-web was kept out of the asar
// but never shipped, so the installed app loaded Lucina live). The names come from the source itself, so a new
// resource cannot be forgotten here.

/** Shipped by electron-builder's platform icon settings (linux.icon, win.icon), not by extraResources. */
const SHIPPED_ELSEWHERE = new Set(["icons"])

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) return sources(file)
      return Promise.resolve(/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : [])
    }),
  )
  return nested.flat()
}

async function resourceNames() {
  const names = new Set<string>()
  for (const file of await sources(path.join(import.meta.dir, "src", "main"))) {
    const text = await readFile(file, "utf8")
    for (const match of text.matchAll(/process\.resourcesPath\s*,\s*["'`]([^"'`$/]+)/g)) names.add(match[1]!)
  }
  return names
}

function shipped(config: Configuration, name: string) {
  const entries = Array.isArray(config.extraResources) ? config.extraResources : []
  return entries.some((entry) => {
    if (typeof entry === "string") return entry === name || entry === `resources/${name}`
    if (!entry || typeof entry !== "object") return false
    const { to, filter } = entry as { to?: string; filter?: string | string[] }
    if (to === name) return true
    if (to !== "" && to !== undefined) return false
    const patterns = filter === undefined ? [] : Array.isArray(filter) ? filter : [filter]
    return patterns.some((pattern) => pattern === name || pattern.startsWith(`${name}/`))
  })
}

test("every resource the main process opens is shipped in the package", async () => {
  const names = await resourceNames()
  // The scan must find the known resources, or it has stopped working.
  for (const known of ["lucina-web", "secretary-recorder", "engine-rs", "opencode-cli.version"]) expect(names).toContain(known)
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"
  try {
    const config = getConfig()
    const missing = [...names].filter((name) => !SHIPPED_ELSEWHERE.has(name) && !shipped(config, name))
    expect(missing).toEqual([])
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous
  }
})
