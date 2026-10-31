import { describe, expect, test } from "bun:test"
import { copySource, MAX_PICTURE_BYTES, pictureResponse } from "./copy-image-core"

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe("copySource", () => {
  test("takes a picture as a data: URL", () => {
    for (const type of ["png", "jpeg", "webp", "gif"]) {
      const source = copySource(`data:image/${type};base64,${png.toString("base64")}`)
      expect(source?.kind).toBe("data")
      expect(source?.kind === "data" && source.bytes.equals(png)).toBe(true)
    }
  })

  test("takes the address of one of her pictures", () => {
    expect(copySource("https://getsecretary.tech/v1/pixiv/s/1/11/p0")).toEqual({ kind: "url", url: "https://getsecretary.tech/v1/pixiv/s/1/11/p0" })
  })

  test("refuses other origins, other types, credentials, empty and oversized pictures, and non-strings", () => {
    for (const value of [
      "https://evil.test/picture.png",
      "http://getsecretary.tech/v1/media/items/1/original",
      "https://user:pw@getsecretary.tech/v1/media/items/1/original",
      "file:///etc/passwd",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:text/html;base64,PGh0bWw+",
      "data:image/png;base64,",
      "data:image/png;base64,***",
      `data:image/png;base64,${Buffer.alloc(MAX_PICTURE_BYTES + 3).toString("base64")}`,
      "",
      42,
      undefined,
      null,
    ])
      expect(copySource(value)).toBeUndefined()
  })
})

describe("pictureResponse", () => {
  const response = (ok: boolean, headers: Record<string, string>) => ({ ok, headers: { get: (name: string) => headers[name] ?? null } })

  test("reads a picture that loaded", () => {
    expect(pictureResponse(response(true, { "content-type": "image/jpeg", "content-length": "1200" }))).toBe(true)
    expect(pictureResponse(response(true, { "content-type": "image/webp" }))).toBe(true)
  })

  test("refuses errors, pages and pictures over the limit", () => {
    expect(pictureResponse(response(false, { "content-type": "image/jpeg" }))).toBe(false)
    expect(pictureResponse(response(true, { "content-type": "text/html" }))).toBe(false)
    expect(pictureResponse(response(true, {}))).toBe(false)
    expect(pictureResponse(response(true, { "content-type": "image/png", "content-length": String(MAX_PICTURE_BYTES + 1) }))).toBe(false)
  })
})
