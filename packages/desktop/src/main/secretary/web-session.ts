import { net, session, type Session, type WebContents } from "electron"
import { acceptLanguage, endWebSession as signOut, ensure, LUCINA_PARTITION, origin, shared, webLanguages } from "./web-session-core"

export { LUCINA_PARTITION, type WebSessionResult } from "./web-session-core"

/**
 * `POST /v1/session {token}` through the default session with credentials omitted, so the device token never enters
 * the web views' partition and the cookie is not stored anywhere but where `ensure` puts it.
 */
async function exchange(token: string) {
  const response = await net.fetch(`${origin}/v1/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Secretary-Client": "web" },
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

const configured = new WeakSet<Session>()

/** The shared partition, with `Accept-Language` for Lucina's origin following the app's language. */
export function lucinaWebPartition() {
  const partition = session.fromPartition(LUCINA_PARTITION)
  if (configured.has(partition)) return partition
  configured.add(partition)
  partition.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, "Accept-Language": acceptLanguage() } })
  })
  return partition
}

/**
 * Makes sure the embedded Lucina web views are signed in with the device, so the owner signs in once.
 * Every embed (Computer tab, image viewer, web app) awaits this before loading its first page.
 */
export const ensureWebSession = shared(() => ensure({ partition: lucinaWebPartition(), token: () => deviceToken(), exchange }))

/**
 * The web app reads `navigator.languages`, which Electron takes from the Mac locale for every page. A per-view
 * DevTools-protocol override sets them (and the header) from the app's language. Call it right before the first
 * `loadURL` and don't wait for it: the command only settles once the view has a page (checked on Electron 44, where it
 * still applies to that first page).
 */
export function applyWebLanguage(contents: WebContents) {
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
    void contents.debugger
      .sendCommand("Emulation.setUserAgentOverride", {
        userAgent: contents.getUserAgent(),
        acceptLanguage: webLanguages().join(","),
      })
      .catch(() => {})
  } catch {
    // Another debugger client owns the view: the page falls back to the web app's own language setting.
  }
}

/** Device sign-out also signs the web views out. */
export function endWebSession() {
  return signOut(lucinaWebPartition())
}
