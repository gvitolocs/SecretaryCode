import { gzipSync } from "node:zlib"
import { SECRETARY_CLIENT } from "../secretary-client"
import type { Attachment } from "./collect"
import type { DiagnosticReport } from "./report"

/** Lucina's diagnostics intake: a multipart `report` part (the JSON) plus one file part per attachment. */
export const DIAGNOSTICS_PATH = "/v1/diagnostics/reports"

/** The server caps a report's attachments at 20 MB decompressed; attachments past it stay local. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** The server accepts at most this many attachments per report. */
const MAX_ATTACHMENTS = 16

const TIMEOUT_MS = 60_000

export type UploadEndpoint = {
  baseURL: string
  token: string
  signal?: AbortSignal
}

export type UploadErrorCode = "signInRequired" | "offline" | "rejected"

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "UploadError"
  }

  /** Worth another attempt later: a lost connection, a timeout or a server-side failure. */
  get retryable() {
    return this.code === "offline"
  }
}

/**
 * `POST /v1/diagnostics/reports`. Attachments are gzipped one by one; the `report` part stays plain
 * JSON so the server can classify a report without expanding anything.
 */
export async function sendReport(
  report: DiagnosticReport,
  attachments: readonly Attachment[],
  endpoint: UploadEndpoint,
): Promise<{ id: string }> {
  const form = new FormData()

  form.set("report", JSON.stringify(report))

  const fitting = attachments.reduce<{ bytes: number; files: Attachment[] }>(
    (state, attachment) =>
      state.files.length < MAX_ATTACHMENTS && state.bytes + attachment.data.byteLength <= MAX_UPLOAD_BYTES
        ? { bytes: state.bytes + attachment.data.byteLength, files: [...state.files, attachment] }
        : state,
    { bytes: 0, files: [] },
  )

  fitting.files.forEach((attachment, index) =>
    form.append(
      "attachments",
      new File([new Uint8Array(gzipSync(attachment.data))], `${index}-${safeName(attachment.name)}.gz`, {
        type: "application/gzip",
      }),
    ),
  )

  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(new URL(DIAGNOSTICS_PATH, endpoint.baseURL), {
    method: "POST",
    // A 3xx here means a broken endpoint, never a report to follow.
    redirect: "error",
    signal: endpoint.signal ? AbortSignal.any([endpoint.signal, timeout]) : timeout,
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      "X-Secretary-Client": SECRETARY_CLIENT,
      Accept: "application/json",
    },
    body: form,
  }).catch((error: unknown) => {
    if (endpoint.signal?.aborted) throw new UploadError("offline", "The report was cancelled")
    throw new UploadError("offline", error instanceof Error ? error.message : "Network error")
  })

  if (response.ok) {
    const body = await response.json().catch(() => undefined)
    const id = body && typeof body === "object" ? (body as Record<string, unknown>).id : undefined

    if (typeof id !== "string" || !id) throw new UploadError("rejected", "Lucina returned no report id")

    return { id }
  }

  await response.body?.cancel()

  if (response.status === 401 || response.status === 403)
    throw new UploadError("signInRequired", "Sign in to Lucina to send diagnostics")
  if (response.status === 408 || response.status === 429 || response.status >= 500)
    throw new UploadError("offline", `Lucina answered ${response.status}`)
  throw new UploadError("rejected", `Lucina answered ${response.status}`)
}

function safeName(name: string) {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120) || "attachment"
}
