#!/usr/bin/env bun
// Builds the owner's Rust port (`engine-rs/`) and, on macOS, places the two binaries the desktop ships in
// resources/engine-rs, where electron-builder copies them into Contents/Resources. On other platforms it only
// builds, so CI still compiles the crates but never puts a foreign binary in a package. CARGO_TARGET_DIR
// overrides the build directory.
import { chmod, copyFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { getCurrentCli } from "./utils"

/** The binaries `engine-rs/` ships for the desktop. */
export const ENGINE_RS_BINARIES = ["oc-server", "oc-cli"] as const

export type EngineRsBinary = (typeof ENGINE_RS_BINARIES)[number]

export function engineRsRoot() {
  return path.resolve(import.meta.dirname, "../../..")
}

// The desktop packages one arch at a time: `getCurrentCli()` is the host arch unless OPENCODE_CLI_TARGET
// cross-packages, and the Rust binaries must match the Electron arch electron-builder verifies in afterPack.
export function engineRsPaths(options: { root?: string; env?: NodeJS.ProcessEnv; target?: string } = {}) {
  const root = options.root ?? engineRsRoot()
  const env = options.env ?? process.env
  const cli = getCurrentCli(options.target)
  const targetDir = env.CARGO_TARGET_DIR ? path.resolve(root, env.CARGO_TARGET_DIR) : path.join(root, "engine-rs", "target")
  return {
    root,
    manifest: path.join(root, "engine-rs", "Cargo.toml"),
    targetDir,
    // A macOS build targets the host arch explicitly, so the artifact lands in a `<target>/release` subdirectory.
    profile: path.join(targetDir, ...(cli.os === "darwin" ? [cli.target] : []), "release"),
    resources: path.join(root, "packages", "desktop", "resources", "engine-rs"),
    os: cli.os,
    target: cli.target,
  }
}

export function engineRsBinaryPath(paths: ReturnType<typeof engineRsPaths>, binary: EngineRsBinary) {
  return path.join(paths.profile, binary)
}

export async function buildEngineRs(paths: ReturnType<typeof engineRsPaths>) {
  const args = ["build", "--release", "--manifest-path", paths.manifest, "-p", "oc-server", "-p", "oc-cli"]
  if (paths.os === "darwin") args.push("--target", paths.target)
  const child = Bun.spawn(["cargo", ...args], {
    cwd: paths.root,
    env: { ...process.env, CARGO_TARGET_DIR: paths.targetDir },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`cargo build failed for engine-rs with exit code ${code}`)
}

/** Copies the built binaries into resources/ and ad-hoc signs them, as the bundled CLI is signed. */
export async function copyEngineRs(paths: ReturnType<typeof engineRsPaths>) {
  await mkdir(paths.resources, { recursive: true })
  for (const binary of ENGINE_RS_BINARIES) {
    const destination = path.join(paths.resources, binary)
    await copyFile(engineRsBinaryPath(paths, binary), destination)
    await chmod(destination, 0o755)
    if (paths.os !== "darwin") continue
    const codesign = Bun.spawn(["codesign", "--force", "--sign", "-", destination], {
      stdout: "inherit",
      stderr: "inherit",
    })
    if ((await codesign.exited) !== 0) throw new Error(`codesign failed for ${destination}`)
  }
}

if (import.meta.main) {
  const paths = engineRsPaths()
  await buildEngineRs(paths)
  if (paths.os !== "darwin") {
    console.log("Built oc-server and oc-cli; engine-rs resources are copied only in macOS builds")
    process.exit(0)
  }
  await copyEngineRs(paths)
  console.log(`Copied oc-server and oc-cli to ${path.relative(paths.root, paths.resources)}`)
}
