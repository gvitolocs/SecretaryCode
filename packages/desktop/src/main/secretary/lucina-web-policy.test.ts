import { expect, test } from "bun:test"
import { bundlePath, contentType, isLucinaUrl } from "./lucina-web-policy"

test("only Lucina's origin counts as a Lucina page", () => {
  expect(isLucinaUrl("https://getsecretary.tech/chats")).toBe(true)
  expect(isLucinaUrl("https://getsecretary.tech.evil.example/")).toBe(false)
  expect(isLucinaUrl("http://getsecretary.tech/")).toBe(false)
  expect(isLucinaUrl("not a url")).toBe(false)
})

test("the bundle answers page and asset GETs on Lucina's origin, never the API or a path outside it", () => {
  expect(bundlePath("https://getsecretary.tech/", "GET")).toBe("")
  expect(bundlePath("https://getsecretary.tech/chats/device%3Aabc", "GET")).toBe("chats/device:abc")
  expect(bundlePath("https://getsecretary.tech/assets/index-1.js?v=2", "HEAD")).toBe("assets/index-1.js")
  expect(bundlePath("https://getsecretary.tech/v1/timeline?scope=mine", "GET")).toBeUndefined()
  expect(bundlePath("https://getsecretary.tech/v1", "GET")).toBeUndefined()
  expect(bundlePath("https://getsecretary.tech/chats", "POST")).toBeUndefined()
  expect(bundlePath("https://example.com/", "GET")).toBeUndefined()
  // URL parsing folds dot segments (encoded too) at the root, so a path can never climb out of the bundle.
  expect(bundlePath("https://getsecretary.tech/assets/%2e%2e/%2e%2e/etc/passwd", "GET")).toBe("etc/passwd")
  expect(bundlePath("https://getsecretary.tech/a%5Cb", "GET")).toBeUndefined()
  expect(bundlePath("https://getsecretary.tech/%E0%A4%A", "GET")).toBeUndefined()
})

test("build output gets its content type", () => {
  expect(contentType("/x/index.html")).toBe("text/html; charset=utf-8")
  expect(contentType("/x/assets/a.JS")).toBe("text/javascript; charset=utf-8")
  expect(contentType("/x/image-core.wasm")).toBe("application/wasm")
  expect(contentType("/x/blob")).toBe("application/octet-stream")
})

test("the Lucina view serves the bundle same-origin, signs in first and keeps navigation on Lucina", async () => {
  // Electron module mocks run in a child so they cannot leak into the shared package test registry.
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/../../../test-fixtures/lucina-web.ts`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" })
})
