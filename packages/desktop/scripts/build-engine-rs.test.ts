import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ENGINE_RS_BINARIES, engineRsBinaryPath, engineRsPaths } from "./build-engine-rs"

const root = "/repo"

describe("engine-rs build paths", () => {
  test("a macOS build targets the packaged arch and copies into resources/engine-rs", () => {
    const paths = engineRsPaths({ root, env: {}, target: "aarch64-apple-darwin" })
    expect(paths.manifest).toBe("/repo/engine-rs/Cargo.toml")
    expect(paths.targetDir).toBe("/repo/engine-rs/target")
    expect(paths.profile).toBe("/repo/engine-rs/target/aarch64-apple-darwin/release")
    expect(paths.resources).toBe("/repo/packages/desktop/resources/engine-rs")
    expect(paths.os).toBe("darwin")
    for (const binary of ENGINE_RS_BINARIES) {
      expect(engineRsBinaryPath(paths, binary)).toBe(`/repo/engine-rs/target/aarch64-apple-darwin/release/${binary}`)
    }
  })

  test("an Intel macOS build uses its own target directory", () => {
    const paths = engineRsPaths({ root, env: {}, target: "x86_64-apple-darwin" })
    expect(paths.target).toBe("x86_64-apple-darwin")
    expect(paths.profile).toBe("/repo/engine-rs/target/x86_64-apple-darwin/release")
  })

  test("CI builds elsewhere have no target triple and copy nothing", () => {
    const paths = engineRsPaths({ root, env: {}, target: "x86_64-unknown-linux-gnu" })
    expect(paths.os).toBe("linux")
    expect(paths.profile).toBe("/repo/engine-rs/target/release")
    expect(paths.resources).toBe("/repo/packages/desktop/resources/engine-rs")
  })

  test("CARGO_TARGET_DIR overrides the build directory, relative to the repository", () => {
    expect(engineRsPaths({ root, env: { CARGO_TARGET_DIR: "/cache/engine-rs" }, target: "aarch64-apple-darwin" }).profile).toBe(
      "/cache/engine-rs/aarch64-apple-darwin/release",
    )
    expect(engineRsPaths({ root, env: { CARGO_TARGET_DIR: ".cache/t" }, target: "aarch64-apple-darwin" }).targetDir).toBe(
      "/repo/.cache/t",
    )
  })

  test("the default root is this repository", () => {
    expect(engineRsPaths().manifest).toBe(path.resolve(import.meta.dirname, "../../../engine-rs/Cargo.toml"))
  })
})
