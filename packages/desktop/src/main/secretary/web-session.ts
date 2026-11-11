import { app, net, session, type WebContents } from "electron"
import { LUCINA_ORIGIN, LUCINA_PARTITION } from "./lucina-web-policy"
import { SECRETARY_CLIENT } from "./secretary-client"
import { endWebSession as signOut, ensure, shared, throttled, webLanguages, type WebSessionResult } from "./web-session-core"

export type { WebSessionResult } from "./web-session-core"

/**
 * `POST /v1/session {token}` through the default session with credentials omitted, so the device token never enters
 * the web views' partition and the cookie is not stored anywhere but where `ensure` puts it.
 */
async function exchange(token: string) {
  const response = await net.fetch(`${LUCINA_ORIGIN}/v1/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Secretary-Client": SECRETARY_CLIENT },
    body: JSON.stringify({ token }),
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  await response.body?.cancel().catch(() => undefined)
  return { status: response.status, setCookies: response.headers.getSetCookie() }
}

let deviceToken: () => Promise<string | undefined> = async () => undefined

/** `index.ts` hands over the Keychain-backed token source during setup. */
export function setWebSessionToken(source: () => Promise<string | undefined>) {
  deviceToken = source
}

/**
 * Makes sure Lucina's web partition has a cookie session for this Mac's device, so the owner signs in once. Every
 * embed (Lucina panel, Computer tab, image viewer) awaits this before loading its first page. Never throws.
 */
export const ensureWebSession: () => Promise<WebSessionResult> = shared(() =>
  ensure({ partition: session.fromPartition(LUCINA_PARTITION), token: () => deviceToken(), exchange }),
)

/** For a page that got a 401: signs the partition in again, at most once every 30 s (the login limit is 5/min). */
export const onUnauthorized: () => Promise<WebSessionResult> = throttled(() => ensureWebSession(), 30_000)

/**
 * The web app reads `navigator.languages`, which Electron takes from the Mac locale for every page. A per-view
 * DevTools-protocol override sets them, and the page's `Accept-Language`, to English or the language picked for the app (no webRequest hook:
 * a session keeps only one `onBeforeSendHeaders` listener, and `lucina-web.ts` owns it). Call it right before the first
 * `loadURL` and don't wait for it: the command only settles once the view has a page (checked on Electron 44, where it
 * still applies to that first page).
 */
export function applyWebLanguage(contents: WebContents) {
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
    void contents.debugger
      .sendCommand("Emulation.setUserAgentOverride", {
        userAgent: contents.getUserAgent(),
        acceptLanguage: webLanguages(app.getPreferredSystemLanguages()).join(","),
      })
      .catch(() => {})
  } catch {
    // Another debugger client owns the view: the page falls back to the web app's own language setting.
  }
}

/** Device sign-out also signs the web views out. */
export function endWebSession() {
  return signOut(session.fromPartition(LUCINA_PARTITION))
}
