import { describe, expect, test } from "bun:test"
import { isPixivLoginUrl, mayNavigate, pixivCode } from "./pixiv-login-core"

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

describe("isPixivLoginUrl", () => {
  test("accepts pixiv's app login with a S256 challenge", () => {
    expect(
      isPixivLoginUrl(`https://app-api.pixiv.net/web/v1/login?code_challenge=${CHALLENGE}&code_challenge_method=S256&client=pixiv-android`),
    ).toBe(true)
  })

  test("refuses other hosts, paths, methods and tricks", () => {
    for (const url of [
      `http://app-api.pixiv.net/web/v1/login?code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      `https://app-api.pixiv.net.evil.test/web/v1/login?code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      `https://user:pw@app-api.pixiv.net/web/v1/login?code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      `https://app-api.pixiv.net/web/v1/login?code_challenge=${CHALLENGE}&code_challenge_method=plain`,
      `https://app-api.pixiv.net/web/v1/login?code_challenge=short&code_challenge_method=S256`,
      `https://app-api.pixiv.net/other?code_challenge=${CHALLENGE}&code_challenge_method=S256`,
      "javascript:alert(1)",
      "",
      42,
      undefined,
    ])
      expect(isPixivLoginUrl(url)).toBe(false)
  })
})

describe("pixivCode", () => {
  test("takes the code from the callback and from the app redirect", () => {
    expect(pixivCode("https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback?state=abc&code=Xy_z-9")).toBe("Xy_z-9")
    expect(pixivCode("pixiv://account/login?code=Xy_z-9&via=login")).toBe("Xy_z-9")
  })

  test("ignores other pages and odd codes", () => {
    expect(pixivCode("https://accounts.pixiv.net/login?code=Xy")).toBeUndefined()
    expect(pixivCode("https://evil.test/web/v1/users/auth/pixiv/callback?code=Xy")).toBeUndefined()
    expect(pixivCode("pixiv://account/login?via=login")).toBeUndefined()
    expect(pixivCode("pixiv://account/login?code=a%20b")).toBeUndefined()
    expect(pixivCode("pixiv://other/login?code=Xy")).toBeUndefined()
    expect(pixivCode("not a url")).toBeUndefined()
  })
})

describe("mayNavigate", () => {
  test("https only", () => {
    expect(mayNavigate("https://accounts.pixiv.net/login")).toBe(true)
    expect(mayNavigate("http://accounts.pixiv.net/login")).toBe(false)
    expect(mayNavigate("file:///etc/passwd")).toBe(false)
    expect(mayNavigate("pixiv://account/login?code=1")).toBe(false)
  })
})
