import { expect, test } from "bun:test"
import { isLucinaUrl, withDeviceToken } from "./lucina-web-policy"

test("only Lucina's origin counts as a Lucina page", () => {
  expect(isLucinaUrl("https://getsecretary.tech/chats")).toBe(true)
  expect(isLucinaUrl("https://getsecretary.tech.evil.example/")).toBe(false)
  expect(isLucinaUrl("http://getsecretary.tech/")).toBe(false)
  expect(isLucinaUrl("not a url")).toBe(false)
})

test("the device token signs Lucina's requests only, and never replaces the page's own header", () => {
  const plain = { Accept: "application/json" }
  expect(withDeviceToken("https://getsecretary.tech/v1/timeline", plain, "sec_x")).toEqual({
    Accept: "application/json",
    Authorization: "Bearer sec_x",
  })
  expect(withDeviceToken("https://example.com/v1/timeline", plain, "sec_x")).toBe(plain)
  expect(withDeviceToken("https://getsecretary.tech/v1/timeline", plain, undefined)).toBe(plain)
  const own = { authorization: "Bearer page" }
  expect(withDeviceToken("https://getsecretary.tech/v1/session", own, "sec_x")).toBe(own)
})

test("the Lucina view uses the shared partition, waits for the token and keeps navigation on Lucina", async () => {
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
