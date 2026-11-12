/** The `X-Secretary-Client` value the server reads for this app; getsecretary.tech's own web app sends `web`. */
export const SECRETARY_CLIENT = "mac"

/** Stamps the Mac onto a request the main process forwards, replacing the value the bundled web app sent for itself. */
export function markMacClient(headers: Headers) {
  headers.set("X-Secretary-Client", SECRETARY_CLIENT)
}
