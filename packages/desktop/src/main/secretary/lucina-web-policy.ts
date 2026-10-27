// Rules for Lucina's web partition (`persist:lucina-web`), kept free of Electron so they can be tested directly.
// The Lucina, Computer and image-viewer views all load Lucina's web app from this one origin and partition.

export const LUCINA_ORIGIN = "https://getsecretary.tech"
export const LUCINA_PARTITION = "persist:lucina-web"

/** Whether `value` is a page on Lucina's origin (the only top-level pages the views may show). */
export function isLucinaUrl(value: string) {
  return URL.canParse(value) && new URL(value).origin === LUCINA_ORIGIN
}

/**
 * Request headers with the Mac's Secretary device token added, for requests to Lucina's origin only. A header the page
 * set itself is kept; without a token the web app's own cookie sign-in applies.
 */
export function withDeviceToken(url: string, headers: Record<string, string>, token: string | undefined) {
  if (!token || !isLucinaUrl(url)) return headers
  if (Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) return headers
  return { ...headers, Authorization: `Bearer ${token}` }
}
