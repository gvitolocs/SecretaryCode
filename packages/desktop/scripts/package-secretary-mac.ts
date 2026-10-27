#!/usr/bin/env bun
// Builds the installable Secretary Code.app for this Mac: the engine CLI on the release channel, the
// recorder helper, and the Electron app signed with a stable certificate.
//
// The engine must be built as channel "latest": a CLI built from a branch names its registration file
// service-<branch>.json, while the desktop client looks for service.json and keeps starting new
// services until it times out ("Timed out waiting for the background service to start").
// A stable signing identity keeps macOS privacy grants (Screen Recording, Microphone) across rebuilds.
import { $ } from "bun"
import path from "node:path"

const desktop = path.resolve(import.meta.dirname, "..")
const cli = path.resolve(desktop, "../cli")
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)
const version = process.env.OPENCODE_VERSION ?? `2.1.4-secretary.${stamp}`
const identity =
  process.env.SECRETARY_SIGN_IDENTITY ??
  (await $`security find-identity -v -p codesigning`.text())
    .split("\n")
    // This Mac has two development certificates; macOS ties privacy grants to the team, so always use the same one.
    .find((line) => line.includes("Apple Development: Giuseppe Vitolo"))
    ?.trim()
    .split(/\s+/)[1]

if (!identity) throw new Error("No Apple Development signing identity found; set SECRETARY_SIGN_IDENTITY")

const env = {
  ...process.env,
  OPENCODE_CHANNEL: "latest",
  OPENCODE_VERSION: version,
  OPENCODE_CLI_DIST: path.join(cli, "dist"),
  SECRETARY_SIGN_IDENTITY: identity,
}

await $`bun run build --single --skip-install`.cwd(cli).env(env)
// electron-builder names the app from OPENCODE_CHANNEL: "prod" is the Secretary Code identity.
const app = { ...env, OPENCODE_CHANNEL: "prod" }
await $`bun run build`.cwd(desktop).env(app)
await $`bun run package:mac -- --dir --arm64`.cwd(desktop).env(app)
console.log(`Built Secretary Code ${version}: ${path.join(desktop, "dist/mac-arm64/Secretary Code.app")}`)
