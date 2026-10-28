// The parts of the Touch ID approvals (approver.ts) that need no Electron: what the page is told, which ids are
// accepted, and the Touch ID prompt's text.

export type ApproverError =
  | "cancelled"
  | "unavailable"
  | "needsSetup"
  | "decided"
  | "expired"
  | "notPending"
  | "changed"
  | "notMain"
  | "server"
  | "network"
  | "invalidRequest"

export const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{1,64}$/
export const DEVICE_ID = /^dev_[A-Za-z0-9_-]{1,64}$/

/** The server's error code (or the HTTP status) for a refused decision or key change, as the page knows it. */
export function errorFor(status: number, code: string | undefined): ApproverError {
  if (code === "approval_decided") return "decided"
  if (code === "approval_expired" || status === 410) return "expired"
  if (code === "approval_not_found" || status === 404) return "notPending"
  if (code === "payload_mismatch") return "changed"
  if (code === "not_main_device") return "notMain"
  if (code === "biometric_required" || code === "proof_invalid") return "needsSetup"
  return "server"
}

/** The Touch ID prompt's text ("Secretary Code is trying to approve …"), from the server's copy of the request. */
export function approveReason(summary: string, requester: string) {
  const text = summary.replace(/\s+/g, " ").trim() || "a request"
  return `approve "${text.length > 220 ? text.slice(0, 219) + "…" : text}" for ${requester || "Lucina"}`
}
