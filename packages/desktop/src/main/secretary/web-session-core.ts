// The Electron-free half of web-session.ts (sign-in flow, cookie parsing, languages), so it runs under `bun test`.
import type { CookiesSetDetails, Session } from "electron"
import { DESKTOP_NATIVE_LOCALE_TAGS } from "@opencode/app/i18n/desktop-native"
import { nativeLocale } from "../native/translations"

/** The partition every embedded Lucina web view shares: the Computer tab, the image viewer and the web app. */
export const LUCINA_PARTITION = "persist:lucina-web"
export const origin = "https://getsecretary.tech"

export type WebSessionResult = "ok" | "no-device" | "failed"

/** One `Set-Cookie` header as `cookies.set` takes it, keeping the server's attributes. */
export type WebCookie = Omit<CookiesSetDetails, "url"> & { name: string; value: string }

const sameSites = new Map<string, WebCookie["sameSite"]>([
  ["none", "no_restriction"],
  ["lax", "lax"],
  ["strict", "strict"],
])

/** Parses `Set-Cookie` header values; RFC 6265: Max-Age wins over Expires, neither means a session cookie. */
export function parseSetCookie(headers: readonly string[], now = Date.now()): WebCookie[] {
  return headers.flatMap((header) => {
    const [pair = "", ...attributes] = header.split(";").map((part) => part.trim())
    const separator = pair.indexOf("=")
    if (separator < 1) return []

    const cookie: WebCookie = { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim() }
    let maxAge: number | undefined
    let expires: number | undefined
    for (const attribute of attributes) {
      const equals = attribute.indexOf("=")
      const key = (equals < 0 ? attribute : attribute.slice(0, equals)).trim().toLowerCase()
      const value = equals < 0 ? "" : attribute.slice(equals + 1).trim()
      if (key === "path") cookie.path = value
      else if (key === "domain" && value) cookie.domain = value
      else if (key === "secure") cookie.secure = true
      else if (key === "httponly") cookie.httpOnly = true
      else if (key === "samesite" && sameSites.has(value.toLowerCase())) cookie.sameSite = sameSites.get(value.toLowerCase())
      else if (key === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value)
      else if (key === "expires" && !Number.isNaN(Date.parse(value))) expires = Date.parse(value) / 1000
    }
    const expirationDate = maxAge === undefined ? expires : now / 1000 + maxAge
    if (expirationDate !== undefined) cookie.expirationDate = expirationDate
    return [cookie]
  })
}

/** The app's language first, then English: the embedded pages follow Secretary Code, not the Mac locale. */
export function webLanguages() {
  const tag = DESKTOP_NATIVE_LOCALE_TAGS[nativeLocale()] ?? "en"
  return tag === "en" ? ["en-US", "en"] : [tag, "en"]
}

export function acceptLanguage() {
  return webLanguages()
    .map((tag, index) => (index ? `${tag};q=0.8` : tag))
    .join(",")
}

type Partition = {
  fetch(url: string, init?: RequestInit): Promise<Response>
  cookies: { set(details: CookiesSetDetails): Promise<void> }
  flushStore?(): Promise<void>
}

export type WebSessionContext = {
  /** The web views' partition: its fetch checks the session (with its cookies), its cookie store receives the new one. */
  partition: Partition
  /** The Secretary device token, if the app is signed in. */
  token: () => Promise<string | undefined>
  /** Trades the token for a web session from the main process; returns the status and the raw `Set-Cookie` values. */
  exchange: (token: string) => Promise<{ status: number; setCookies: string[] }>
}

async function signedIn(partition: Partition) {
  const response = await partition.fetch(`${origin}/v1/session`, { credentials: "include", cache: "no-store" })
  if (!response.ok) return false
  const body: unknown = await response.json()
  return typeof body === "object" && body !== null && (body as { authenticated?: unknown }).authenticated === true
}

/** Signs the partition in with the device token unless it already has a session. Never throws and never logs. */
export async function ensure(context: WebSessionContext): Promise<WebSessionResult> {
  try {
    if (await signedIn(context.partition)) return "ok"
    const token = await context.token()
    if (!token) return "no-device"
    // One attempt: a 401 means the device itself was revoked, so retrying cannot help.
    const { status, setCookies } = await context.exchange(token)
    const cookies = status === 200 ? parseSetCookie(setCookies) : []
    if (!cookies.length) return "failed"
    for (const cookie of cookies) await context.partition.cookies.set({ url: origin, ...cookie })
    await context.partition.flushStore?.()
    return "ok"
  } catch {
    // Offline or an unexpected answer: the page still loads and offers the web login.
    return "failed"
  }
}

/** Concurrent callers share the attempt in flight. */
export function shared(run: () => Promise<WebSessionResult>) {
  let current: Promise<WebSessionResult> | undefined
  return () =>
    (current ??= run().finally(() => {
      current = undefined
    }))
}

/** Device sign-out also signs the web views out: ends the server session, then drops the partition's cookies. */
export async function endWebSession(partition: Pick<Session, "fetch" | "clearStorageData">) {
  await partition
    .fetch(`${origin}/v1/session`, { method: "DELETE", headers: { "X-Secretary-CSRF": "1" }, credentials: "include" })
    .then((response) => response.body?.cancel())
    .catch(() => undefined)
  await partition.clearStorageData({ origin, storages: ["cookies"] }).catch(() => undefined)
}
