import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

// Set roots before the service/client modules evaluate. The fork owns its database and
// service registration, so it cannot replace the owner's existing OpenCode service.
if (!process.env.OPENCODE_DESKTOP_TEST_ROOT && process.env.OPENCODE_TEST_ONBOARDING !== "1") {
  const root = path.join(homedir(), "Library", "Application Support", "app.secretary.code", "engine")
  for (const name of ["data", "config", "cache", "state"]) {
    const directory = path.join(root, name)
    mkdirSync(path.join(directory, "opencode"), { recursive: true, mode: 0o700 })
    process.env[`XDG_${name.toUpperCase()}_HOME`] = directory
  }
  const config = path.join(root, "config", "opencode", "opencode.json")
  const source = path.join(homedir(), ".config", "opencode", "opencode.json")
  if (!existsSync(config)) {
    let imported: Record<string, unknown> = {}
    if (existsSync(source)) {
      try {
        const previous = JSON.parse(readFileSync(source, "utf8"))
        // Import provider settings only. Old executable plugins need an explicit v2
        // migration; loading them blindly prevents the entire engine from starting.
        for (const key of ["model", "provider", "providers", "disabled_providers", "enabled_providers", "mcp"])
          if (previous[key] !== undefined) imported[key] = previous[key]
      } catch (error) {
        console.error("Secretary Code could not import provider settings", error instanceof SyntaxError ? "Invalid JSON" : "Read failed")
      }
    }
    writeFileSync(config, JSON.stringify({ ...imported, update: "disable", share: "disabled" }, null, 2), { mode: 0o600 })
    const credentials = path.join(homedir(), ".local", "share", "opencode", "auth.json")
    const destination = path.join(root, "data", "opencode", "auth.json")
    if (existsSync(credentials) && !existsSync(destination)) copyFileSync(credentials, destination)
  }
  // GUI-launched programs do not inherit the login shell's development tool PATH.
  process.env.PATH = [path.join(homedir(), ".local", "bin"), path.join(homedir(), ".bun", "bin"), "/opt/homebrew/bin", process.env.PATH].join(":")
}
