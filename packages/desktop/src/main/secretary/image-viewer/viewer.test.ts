import { afterEach, expect, jest, test } from "bun:test"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deviceID } from "./device"
import { folderImages, ImageFiles } from "./files"
import { imageArguments, ImageOpenQueue } from "./queue"

const directories: string[] = []
afterEach(async () => {
  jest.useRealTimers()
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "secretary-images-"))
  directories.push(dir)
  return realpath(dir)
}

test("folder listing includes only direct images in natural case-insensitive order with stable metadata", async () => {
  const dir = await directory()
  await Promise.all(
    ["Photo10.JPG", "photo2.png", "photo1.heic", "notes.txt", "raw.CR3", 'quote" <&.gif'].map((name) =>
      writeFile(path.join(dir, name), name),
    ),
  )
  await mkdir(path.join(dir, "folder.png"))
  await symlink(path.join(await directory(), "escape.jpg"), path.join(dir, "escape.jpg"))
  const listing = await folderImages(path.join(dir, "photo2.png"))
  expect(listing.files.map((file) => file.name)).toEqual(["photo1.heic", "photo2.png", "Photo10.JPG", 'quote" <&.gif'])
  expect(listing.startIndex).toBe(1)
  expect(listing.files[1]).toEqual({
    name: "photo2.png",
    mime: "image/png",
    takenAt: (await stat(path.join(dir, "photo2.png"))).birthtime.toISOString(),
    assetId: createHash("sha256").update(path.join(dir, "photo2.png")).digest("hex"),
  })
  await expect(folderImages(path.join(dir, "notes.txt"))).rejects.toThrow()
})

test("folder cap keeps the clicked file and fills both ends of a large folder", async () => {
  const dir = await directory()
  await Promise.all(Array.from({ length: 2010 }, (_, index) => writeFile(path.join(dir, `${index}.png`), "x")))
  for (const index of [0, 1005, 2009]) {
    const listing = await folderImages(path.join(dir, `${index}.png`))
    expect(listing.files).toHaveLength(2000)
    expect(listing.files[listing.startIndex]?.name).toBe(`${index}.png`)
    expect(listing.files[0]?.name).toBe(index === 0 ? "0.png" : index === 1005 ? "5.png" : "10.png")
  }
})

test("protocol grants only read-only images in a live token's canonical folder", async () => {
  const dir = await directory()
  const outside = await directory()
  await Promise.all([
    writeFile(path.join(dir, "a #%.PNG"), "image"),
    writeFile(path.join(dir, "private.txt"), "secret"),
    writeFile(path.join(outside, "escape.jpg"), "secret"),
  ])
  await symlink(path.join(outside, "escape.jpg"), path.join(dir, "escape.jpg"))
  await symlink(path.join(dir, "a #%.PNG"), path.join(dir, "inside.png"))
  await symlink(path.join(dir, "private.txt"), path.join(dir, "private.jpg"))
  const files = new ImageFiles()
  const token = files.add(dir, "<html>fallback</html>")
  const good = await files.handle(new Request(files.url(token, "a #%.PNG")))
  expect(await good.text()).toBe("image")
  expect(good.headers.get("Content-Type")).toBe("image/png")
  expect(good.headers.get("Cache-Control")).toBe("no-store")
  expect(good.headers.get("Access-Control-Allow-Origin")).toBe("https://getsecretary.tech")
  expect((await files.handle(new Request(files.url(token, "inside.png")))).status).toBe(200)
  const cases = [
    ["unknown token", "secretary-file://unknown/a.png", "GET", 404],
    ["encoded traversal", `secretary-file://${token}/..%2Fescape.jpg`, "GET", 403],
    ["subfolder", `secretary-file://${token}/folder/a.png`, "GET", 403],
    ["backslash", `secretary-file://${token}/..%5Cescape.jpg`, "GET", 403],
    ["null", `secretary-file://${token}/a%00.png`, "GET", 403],
    ["non-image", files.url(token, "private.txt"), "GET", 403],
    ["non-image symlink", files.url(token, "private.jpg"), "GET", 403],
    ["symlink escape", files.url(token, "escape.jpg"), "GET", 403],
    ["missing", files.url(token, "missing.jpg"), "GET", 404],
    ["write", files.url(token, "a #%.PNG"), "POST", 405],
    ["malformed encoding", `secretary-file://${token}/%zz.png`, "GET", 404],
  ] as const
  for (const [name, url, method, status] of cases)
    expect((await files.handle(new Request(url, { method }))).status, name).toBe(status)
  const head = await files.handle(new Request(files.url(token, "a #%.PNG"), { method: "HEAD" }))
  expect(head.status).toBe(200)
  expect(await head.text()).toBe("")
  expect(await (await files.handle(new Request(`secretary-file://${token}/__viewer__/index.html`))).text()).toBe(
    "<html>fallback</html>",
  )
  files.drop(token)
  expect((await files.handle(new Request(files.url(token, "a #%.PNG")))).status).toBe(404)
  expect((await files.handle(new Request(`secretary-file://${token}/__viewer__/index.html`))).status).toBe(404)
})

test("open-file bursts survive pre-ready startup and become one ordered selection", () => {
  jest.useFakeTimers()
  const received: string[][] = []
  const queue = new ImageOpenQueue()
  queue.enqueue(["/photos/first.png"])
  queue.enqueue(["/photos/second.jpg"])
  jest.runAllTimers()
  expect(received).toEqual([])
  queue.ready((files) => received.push(files))
  queue.enqueue(["/photos/first.png", "/photos/third.heic"])
  jest.runAllTimers()
  expect(received).toEqual([["/photos/first.png", "/photos/second.jpg", "/photos/third.heic"]])
  queue.enqueue(["/photos/later.png"])
  jest.runAllTimers()
  expect(received[1]).toEqual(["/photos/later.png"])
  expect(
    imageArguments(["--inspect", "secretary-code://photo.jpg", "notes.txt", "photo.PNG", "/other/a.cr3"], "/photos"),
  ).toEqual(["/photos/photo.PNG", "/other/a.cr3"])
})

test("device identity survives restart encrypted at rest", async () => {
  const dir = await directory()
  const key = randomBytes(32)
  // Exercise the storage boundary with real encryption; Electron's Keychain lives on the Mac.
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => {
      const iv = randomBytes(16)
      const cipher = createCipheriv("aes-256-cbc", key, iv)
      return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final()])
    },
    decryptString: (value: Buffer) => {
      const cipher = createDecipheriv("aes-256-cbc", key, value.subarray(0, 16))
      return Buffer.concat([cipher.update(value.subarray(16)), cipher.final()]).toString("utf8")
    },
  }
  const first = await deviceID(dir, storage)
  expect(first).toMatch(/^mac-[\da-f-]{36}$/)
  expect(await deviceID(dir, storage)).toBe(first)
  expect((await readFile(path.join(dir, "lucina-device"))).includes(Buffer.from(first))).toBe(false)
  expect(await deviceID(await directory(), storage)).not.toBe(first)
  await expect(deviceID(await directory(), { ...storage, isEncryptionAvailable: () => false })).rejects.toThrow(
    "unavailable",
  )
})

test("hosted CSP grants only local image and fetch access while preserving script and other limits", async () => {
  const { localImagePolicy } = await import("./policy")
  expect(
    localImagePolicy("default-src 'self'; script-src 'self'; img-src 'self' blob: data:; connect-src 'self'"),
  ).toBe(
    "default-src 'self'; script-src 'self'; img-src 'self' blob: data: secretary-file:; connect-src 'self' secretary-file:",
  )
  expect(localImagePolicy("default-src 'none'")).toBe(
    "default-src 'none'; img-src 'none' secretary-file:; connect-src 'none' secretary-file:",
  )
})
