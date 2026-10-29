// The checks behind window.secretaryShell.pixivLogin (pixiv-login.ts), kept free of Electron so they are testable.
// Contract: SecretaryIOS web/src/lib/desktopShell.ts (pixivLogin) and docs/pixiv.md ("Pixiv account").
// Her page asks the Pixiv service for pixiv's login URL (OAuth with PKCE), the shell shows it in its own window, the
// owner signs in on pixiv's page, and pixiv sends the window to its callback and then to pixiv://account/login?code=…
// The shell takes the code from either URL and hands it back; her page gives it to the service at once.

export type PixivLoginResult = { code: string } | { error: "cancelled" | "failed" | "bad_url" }

const LOGIN_ORIGIN = "https://app-api.pixiv.net"
const LOGIN_PATH = "/web/v1/login"
const CALLBACK_PATH = "/web/v1/users/auth/pixiv/callback"
const CODE_RE = /^[A-Za-z0-9._~-]{1,512}$/

/** Only pixiv's own app-login page, with a PKCE challenge. */
export function isPixivLoginUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.origin === LOGIN_ORIGIN &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === LOGIN_PATH &&
    url.searchParams.get("code_challenge_method") === "S256" &&
    /^[A-Za-z0-9_-]{43,128}$/.test(url.searchParams.get("code_challenge") ?? "")
  )
}

/** The authorization code, when `value` is pixiv's callback or its pixiv:// redirect; otherwise undefined. */
export function pixivCode(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const isCallback = url.origin === LOGIN_ORIGIN && url.pathname === CALLBACK_PATH
  const isApp = url.protocol === "pixiv:" && url.host === "account" && url.pathname === "/login"
  if (!isCallback && !isApp) return undefined
  const code = url.searchParams.get("code") ?? ""
  return CODE_RE.test(code) ? code : undefined
}

/** Where the login window may go: https pages (pixiv's login uses its own and its captcha providers' hosts). */
export function mayNavigate(value: string): boolean {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}
