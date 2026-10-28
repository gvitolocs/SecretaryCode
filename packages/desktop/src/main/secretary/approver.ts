import { app, ipcMain } from "electron"
import { spawn } from "node:child_process"
import path from "node:path"
import { secretaryToken } from "./index"
import { fromLucina } from "./panel"
import { APPROVAL_ID, approveReason, DEVICE_ID, errorFor, type ApproverError } from "./approver-core"

// Owner approvals with Touch ID on this Mac (SecretaryIOS crates/secretary-server/src/approvals.rs). Her web app asks
// through window.secretaryApprover (preload/lucina.ts) to approve request X; this process does the rest itself: it
// reads the request from the server with this Mac's device token, has `secretary-approver` (native/secretary-approver)
// ask for Touch ID with the server's own summary and sign, then sends the decision. The page never sees the key or a
// signature, and cannot choose what is signed.

const origins = ["https://getsecretary.tech", "https://secretary-p1.tail75dcfc.ts.net"]

type Failure = { ok: false; error: ApproverError; message?: string }

class ApproverFailure extends Error {
  constructor(
    readonly error: ApproverError,
    message = "",
  ) {
    super(message)
  }
}

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "secretary-approver")
    : path.join(app.getAppPath(), "resources", "secretary-approver")
}

function keyDir() {
  return path.join(app.getPath("userData"), "approver")
}

/** One run of the helper: argv only, the input on stdin, one JSON line back. Touch ID may take a while. */
function helper(command: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath(), [command], { stdio: ["pipe", "pipe", "pipe"], shell: false })
    let out = ""
    const timer = setTimeout(() => child.kill(), 120_000)
    child.stdout.on("data", (chunk) => (out += chunk))
    child.on("error", () => {
      clearTimeout(timer)
      reject(new ApproverFailure("unavailable", "the approval helper is missing"))
    })
    child.on("close", () => {
      clearTimeout(timer)
      let reply: Record<string, unknown>
      try {
        reply = JSON.parse(out.trim().split("\n").pop() ?? "")
      } catch {
        return reject(new ApproverFailure("unavailable", "the approval helper did not answer"))
      }
      if (reply.ok === true) return resolve(reply)
      const code = typeof reply.code === "string" ? reply.code : ""
      const known: ApproverError[] = ["cancelled", "unavailable", "needsSetup", "invalidRequest"]
      reject(new ApproverFailure(known.includes(code as ApproverError) ? (code as ApproverError) : "server", String(reply.message ?? "")))
    })
    child.stdin.end(JSON.stringify({ dir: keyDir(), ...input }))
  })
}

/** A call to Secretary as this Mac's device (Bearer token), trying each origin. */
async function api(route: string, method = "GET", body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const token = await secretaryToken()
  if (!token) throw new ApproverFailure("network", "this Mac is not signed in")
  for (const origin of origins) {
    const response = await fetch(origin + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined)
    if (!response) continue
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    return { status: response.status, data }
  }
  throw new ApproverFailure("network", "Secretary is unreachable")
}

function refused(r: { status: number; data: Record<string, unknown> }): never {
  const error = r.data.error as { code?: string; message?: string } | undefined
  throw new ApproverFailure(errorFor(r.status, error?.code), error?.message ?? "")
}

async function settings() {
  const r = await api("/v1/approvals/settings")
  if (r.status !== 200) refused(r)
  const me = typeof r.data.thisDeviceId === "string" ? r.data.thisDeviceId : ""
  const devices = Array.isArray(r.data.devices) ? (r.data.devices as Record<string, unknown>[]) : []
  return { me, devices, name: (id: string) => String(devices.find((d) => d.id === id)?.name ?? "this device") }
}

async function status() {
  const s = await helper("status", {})
  return { available: s.available === true, hasKey: s.hasKey === true, ...(typeof s.keyId === "string" ? { keyId: s.keyId } : {}) }
}

/** Makes this Mac's key (Touch ID) and registers it; a second approver device waits for the iPhone's Face ID. */
async function setup() {
  const s = await settings()
  if (!DEVICE_ID.test(s.me)) throw new ApproverFailure("server", "the server does not know this Mac")
  const made = await helper("create", { deviceId: s.me, reason: "set up approvals on this Mac" })
  const r = await api("/v1/approvals/keys", "POST", {
    publicKey: made.publicKey,
    label: `Touch ID on ${s.name(s.me)}`,
    proof: { signature: made.signature },
  })
  if (r.status !== 200) refused(r)
  await helper("set-key-id", { keyId: r.data.keyId })
  const pending = r.data.status === "pending_approval"
  return {
    status: pending ? "pending_approval" : "active",
    ...(typeof r.data.approvalId === "string" ? { approvalId: r.data.approvalId } : {}),
  }
}

async function approve(id: unknown) {
  if (typeof id !== "string" || !APPROVAL_ID.test(id)) throw new ApproverFailure("invalidRequest")
  const r = await api(`/v1/approvals/${id}`)
  if (r.status !== 200) refused(r)
  const item = r.data
  if (item.status === "approved" || item.status === "denied") throw new ApproverFailure("decided")
  if (item.status === "expired") throw new ApproverFailure("expired")
  if (item.status !== "pending" || typeof item.payloadHash !== "string") throw new ApproverFailure("notPending")
  const requester = item.requester as { name?: string; kind?: string } | undefined
  const signed = await helper("sign-approve", {
    id,
    payloadHash: item.payloadHash,
    reason: approveReason(String(item.summary ?? ""), requester?.name || requester?.kind || ""),
  })
  const d = await api(`/v1/approvals/${id}/decide`, "POST", {
    decision: "approve",
    payloadHash: item.payloadHash,
    proof: { keyId: signed.keyId, signature: signed.signature },
  })
  if (d.status !== 200) refused(d)
  return { status: "approved" }
}

async function revoke(deviceId: unknown) {
  if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) throw new ApproverFailure("invalidRequest")
  const s = await settings()
  const signed = await helper("sign-revoke", {
    callerId: s.me,
    targetId: deviceId,
    reason: `stop ${s.name(deviceId)} from approving requests`,
  })
  const r = await api(`/v1/approvals/keys/${deviceId}`, "DELETE", { proof: { signature: signed.signature } })
  if (r.status !== 200) refused(r)
  return { removed: r.data.removed === true }
}

async function remove() {
  const r = await api("/v1/approvals/keys", "DELETE")
  if (r.status !== 200) refused(r)
  await helper("remove", {})
  return {}
}

async function perform(action: unknown, input: unknown) {
  switch (action) {
    case "status":
      return status()
    case "setup":
      return setup()
    case "approve":
      return approve(input)
    case "revoke":
      return revoke(input)
    case "remove":
      return remove()
    default:
      throw new ApproverFailure("invalidRequest")
  }
}

/** Call once during startup. Only her web views (top frame, her origin) may ask, and only on macOS. */
export function setupApprover() {
  ipcMain.handle("secretary:approver", async (event, action: unknown, input: unknown): Promise<unknown> => {
    if (!fromLucina(event) || process.platform !== "darwin") return { ok: false, error: "unavailable" } satisfies Failure
    try {
      return { ok: true, ...(await perform(action, input)) }
    } catch (error) {
      if (error instanceof ApproverFailure) return { ok: false, error: error.error, ...(error.message ? { message: error.message } : {}) } satisfies Failure
      return { ok: false, error: "server" } satisfies Failure
    }
  })
}
