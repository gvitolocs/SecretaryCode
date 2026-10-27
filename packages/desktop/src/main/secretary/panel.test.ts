import { expect, test } from "bun:test"

test("companion IPC, Computer navigation, permissions and retry obey the desktop boundary", async () => {
  // Electron module mocks run in a child so they cannot leak into the shared package test registry.
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/../../../test-fixtures/computer-panels.ts`], {
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
