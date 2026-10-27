import { expect, test } from "bun:test"

test("secretary:navigate and secretary:shell obey the sender and validation rules", async () => {
  // Electron module mocks run in a child so they cannot leak into the shared package test registry.
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/../../../test-fixtures/lucina-shell.ts`], {
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
