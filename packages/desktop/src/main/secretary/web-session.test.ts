import { describe, expect, mock, test } from "bun:test"
import type { CookiesSetDetails } from "electron"
import { endWebSession, ensure, parseSetCookie, shared, throttled, webLanguages, type WebSessionContext } from "./web-session-core"

const TOKEN = "sec_test_web_session_token_1234567890"
const SESSION_COOKIE = "sec_session=abc123; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000"

function partition(authenticated: boolean | "offline") {
  const cookies: CookiesSetDetails[] = []
  const value = {
    fetch: mock(async (_url: string, _init?: RequestInit) => {
      if (authenticated === "offline") throw new Error("net::ERR_INTERNET_DISCONNECTED")
      // GET /v1/session answers 200 either way; only the body says whether the cookie is signed in.
      return Response.json({ authenticated, deviceId: null, deviceName: null })
    }),
    cookies: {
      set: mock(async (details: CookiesSetDetails) => {
        cookies.push(details)
      }),
    },
    flushStore: mock(async () => {}),
  }
  return { partition: value, cookies }
}

function context(
  authenticated: boolean | "offline",
  token: string | undefined,
  answer: { status: number; setCookies: string[] } | Error = { status: 200, setCookies: [SESSION_COOKIE] },
) {
  const env = partition(authenticated)
  const exchange = mock(async (_token: string) => {
    if (answer instanceof Error) throw answer
    return answer
  })
  const ctx: WebSessionContext = { partition: env.partition, token: async () => token, exchange }
  return { ...env, exchange, ctx }
}

describe("parseSetCookie", () => {
  test("keeps the server's session cookie attributes", () => {
    const now = 1_000_000_000_000
    expect(parseSetCookie([SESSION_COOKIE], now)).toEqual([
      {
        name: "sec_session",
        value: "abc123",
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
        expirationDate: now / 1000 + 2592000,
      },
    ])
  })

  test("reads several Set-Cookie headers separately", () => {
    expect(parseSetCookie(["a=1; Path=/", "b=x=y; Domain=getsecretary.tech"])).toEqual([
      { name: "a", value: "1", path: "/" },
      { name: "b", value: "x=y", domain: "getsecretary.tech" },
    ])
  })

  test("maps SameSite values and ignores unknown ones", () => {
    const sameSite = (value: string) => parseSetCookie([`s=1; SameSite=${value}`])[0]?.sameSite
    expect(sameSite("Lax")).toBe("lax")
    expect(sameSite("strict")).toBe("strict")
    expect(sameSite("None")).toBe("no_restriction")
    expect(sameSite("constructor")).toBeUndefined()
    expect(parseSetCookie(["s=1"])[0]?.sameSite).toBeUndefined()
  })

  test("Max-Age wins over Expires in either order; Expires alone counts; neither is a session cookie", () => {
    const now = 1_000_000_000_000
    const expires = "Expires=Wed, 01 Jan 2099 00:00:00 GMT"
    expect(parseSetCookie([`t=1; ${expires}; Max-Age=60`], now)[0]?.expirationDate).toBe(now / 1000 + 60)
    expect(parseSetCookie([`t=1; Max-Age=60; ${expires}`], now)[0]?.expirationDate).toBe(now / 1000 + 60)
    expect(parseSetCookie([`t=1; ${expires}`])[0]?.expirationDate).toBe(Date.parse("Wed, 01 Jan 2099 00:00:00 GMT") / 1000)
    expect(parseSetCookie(["t=1; Max-Age=soon"])[0]).toEqual({ name: "t", value: "1" })
    expect(parseSetCookie(["t=1"])[0]?.expirationDate).toBeUndefined()
  })

  test("skips headers without a name", () => {
    expect(parseSetCookie(["", "noequals", "=value", ";Path=/"])).toEqual([])
  })
})

describe("ensure", () => {
  test("a signed-in partition needs no exchange", async () => {
    const { ctx, exchange, cookies } = context(true, TOKEN)
    expect(await ensure(ctx)).toBe("ok")
    expect(exchange).not.toHaveBeenCalled()
    expect(cookies).toEqual([])
  })

  test("checks the session with the partition's own cookies", async () => {
    const { ctx, partition } = context(true, TOKEN)
    await ensure(ctx)
    expect(partition.fetch.mock.calls[0]).toEqual([
      "https://getsecretary.tech/v1/session",
      { credentials: "include", cache: "no-store" },
    ])
  })

  test("no session and a token: the server's cookies land in the partition", async () => {
    const { ctx, exchange, cookies, partition } = context(false, TOKEN, {
      status: 200,
      setCookies: [SESSION_COOKIE, "other=1; Path=/v1"],
    })
    expect(await ensure(ctx)).toBe("ok")
    expect(exchange.mock.calls).toEqual([[TOKEN]])
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toMatchObject({ url: "https://getsecretary.tech", name: "sec_session", value: "abc123", httpOnly: true, secure: true, sameSite: "strict", path: "/" })
    expect(cookies[1]).toMatchObject({ url: "https://getsecretary.tech", name: "other", path: "/v1" })
    expect(partition.flushStore).toHaveBeenCalledTimes(1)
  })

  test("a rejected token is one failed attempt, no cookies", async () => {
    const { ctx, exchange, cookies } = context(false, TOKEN, { status: 401, setCookies: [] })
    expect(await ensure(ctx)).toBe("failed")
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(cookies).toEqual([])
  })

  test("a 200 without a cookie is a failure, not a session", async () => {
    const { ctx } = context(false, TOKEN, { status: 200, setCookies: [] })
    expect(await ensure(ctx)).toBe("failed")
  })

  test("no device token: no-device, no request", async () => {
    const { ctx, exchange } = context(false, undefined)
    expect(await ensure(ctx)).toBe("no-device")
    expect(exchange).not.toHaveBeenCalled()
  })

  test("network errors settle as failed instead of throwing", async () => {
    expect(await ensure(context("offline", TOKEN, new Error("offline")).ctx)).toBe("failed")
    expect(await ensure(context(false, TOKEN, new Error("offline")).ctx)).toBe("failed")
  })

  test("concurrent callers share one exchange", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const env = context(false, TOKEN)
    const exchange = mock(async (_token: string) => {
      await gate
      return { status: 200, setCookies: [SESSION_COOKIE] }
    })
    const run = shared(() => ensure({ ...env.ctx, exchange }))
    const first = run()
    const second = run()
    expect(second).toBe(first)
    release()
    expect(await Promise.all([first, second])).toEqual(["ok", "ok"])
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(env.cookies).toHaveLength(1)
    // A finished attempt is not cached: the next call checks again.
    await run()
    expect(env.partition.fetch).toHaveBeenCalledTimes(2)
  })

  test("never logs, and the token only reaches the exchange", async () => {
    const lines: unknown[][] = []
    const methods = ["log", "info", "warn", "error", "debug"] as const
    const originals = methods.map((name) => console[name])
    for (const name of methods) console[name] = (...args: unknown[]) => void lines.push(args)
    const env = context(false, TOKEN)
    try {
      await ensure(env.ctx)
      await ensure(context(false, TOKEN, { status: 401, setCookies: [] }).ctx)
      await ensure(context(false, TOKEN, new Error(`boom ${TOKEN}`)).ctx)
    } finally {
      methods.forEach((name, index) => (console[name] = originals[index]!))
    }
    expect(lines).toEqual([])
    expect(JSON.stringify(env.partition.fetch.mock.calls)).not.toContain(TOKEN)
    expect(JSON.stringify(env.cookies)).not.toContain(TOKEN)
  })
})

test("onUnauthorized-style throttling: one sign-in attempt per interval", async () => {
  let clock = 0
  const run = mock(async () => "failed" as const)
  const retry = throttled(run, 30_000, () => clock)
  expect(await retry()).toBe("failed")
  clock = 29_999
  await retry()
  expect(run).toHaveBeenCalledTimes(1)
  clock = 30_000
  await retry()
  expect(run).toHaveBeenCalledTimes(2)
})

describe("endWebSession", () => {
  test("ends the server session with the CSRF header, then drops the cookies", async () => {
    const calls: string[] = []
    const fetch = mock(async (_url: string, _init?: RequestInit) => {
      calls.push("fetch")
      return Response.json({ authenticated: false })
    })
    const clearStorageData = mock(async (_options: unknown) => {
      calls.push("clear")
    })
    await endWebSession({ fetch, clearStorageData } as never)
    expect(fetch.mock.calls[0]).toEqual([
      "https://getsecretary.tech/v1/session",
      { method: "DELETE", headers: { "X-Secretary-CSRF": "1" }, credentials: "include" },
    ])
    expect(clearStorageData.mock.calls).toEqual([[{ origin: "https://getsecretary.tech", storages: ["cookies"] }]])
    expect(calls).toEqual(["fetch", "clear"])
  })

  test("still drops the cookies when offline", async () => {
    const clearStorageData = mock(async (_options: unknown) => {})
    await endWebSession({ fetch: async () => Promise.reject(new Error("offline")), clearStorageData } as never)
    expect(clearStorageData).toHaveBeenCalledTimes(1)
  })
})

test("the embedded pages default to English", () => {
  expect(webLanguages()).toEqual(["en-US", "en"])
})
