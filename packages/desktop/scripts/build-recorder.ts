#!/usr/bin/env bun
// Builds the native meeting recorder (Swift, ScreenCaptureKit) and places it in resources/, where
// electron-builder copies it into Contents/Resources and development runs pick it up.
import { $ } from "bun"
import { copyFile } from "node:fs/promises"
import path from "node:path"
import { getCurrentCli } from "./utils"

const cli = getCurrentCli()

if (cli.os !== "darwin") {
  console.log("Skipping secretary-recorder: it is macOS only")
  process.exit(0)
}

const packageDir = path.resolve(import.meta.dirname, "../native/secretary-recorder")
const arch = cli.cpu === "arm64" ? "arm64" : "x86_64"
await $`swift build -c release --arch ${arch} --package-path ${packageDir}`
const bin = (await $`swift build -c release --arch ${arch} --package-path ${packageDir} --show-bin-path`.text()).trim()
await copyFile(
  path.join(bin, "secretary-recorder"),
  path.resolve(import.meta.dirname, "../resources/secretary-recorder"),
)
