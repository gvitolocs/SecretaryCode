#!/usr/bin/env bun
// Builds the Touch ID approval helper (Swift, Secure Enclave) and places it in resources/, where electron-builder
// copies it into Contents/Resources and development runs pick it up.
import { $ } from "bun"
import { copyFile } from "node:fs/promises"
import path from "node:path"
import { getCurrentCli } from "./utils"

const cli = getCurrentCli()

if (cli.os !== "darwin") {
  console.log("Skipping secretary-approver: it is macOS only")
  process.exit(0)
}

const packageDir = path.resolve(import.meta.dirname, "../native/secretary-approver")
const arch = cli.cpu === "arm64" ? "arm64" : "x86_64"
await $`swift build -c release --arch ${arch} --package-path ${packageDir}`
const bin = (await $`swift build -c release --arch ${arch} --package-path ${packageDir} --show-bin-path`.text()).trim()
await copyFile(path.join(bin, "secretary-approver"), path.resolve(import.meta.dirname, "../resources/secretary-approver"))
