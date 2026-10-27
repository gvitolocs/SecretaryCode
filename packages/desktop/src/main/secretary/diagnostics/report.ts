/** What Lucina should do with a report: crash dumps need different handling from a soft error. */
export type ReportKind = "crash" | "fatal_error" | "error" | "user_report" | "hang"

/** The JSON body of `POST /v1/diagnostics/reports`. */
export type DiagnosticReport = {
  app: "secretary-code"
  app_version: string
  os: string
  device: string
  kind: ReportKind
  message: string
  stack: string | null
  context: Record<string, unknown>
  occurred_at: string
}

const MAX_MESSAGE = 2_000

const MAX_STACK = 20_000

const MAX_CONTEXT_STRING = 1_000

const MAX_CONTEXT_KEYS = 60

const MAX_CONTEXT_DEPTH = 4

export function createReport(input: {
  kind: ReportKind
  message: string
  stack?: string | null
  context?: Record<string, unknown>
  appVersion: string
  os: string
  device: string
  occurredAt?: Date
}): DiagnosticReport {
  return {
    app: "secretary-code",
    app_version: input.appVersion,
    os: input.os,
    device: input.device,
    kind: input.kind,
    message: truncate(input.message, MAX_MESSAGE),
    stack: input.stack ? truncate(input.stack, MAX_STACK) : null,
    context: sanitize(input.context),
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
  }
}

/** The same failure twice in one session must not fill the outbox: kind, message and stack frame. */
export function fingerprint(report: Pick<DiagnosticReport, "kind" | "message" | "stack">) {
  const frame = report.stack?.split("\n").find((line) => line.trim().startsWith("at "))?.trim() ?? ""

  return `${report.kind}\n${report.message}\n${frame}`
}

/** A thrown value as the message and stack a report carries. */
export function errorDetails(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) return { message: error.message || error.name, stack: error.stack ?? null }

  if (typeof error === "string") return { message: error, stack: null }

  try {
    const json = JSON.stringify(error)

    return { message: json === undefined ? String(error) : json, stack: null }
  } catch {
    return { message: String(error), stack: null }
  }
}

/** A deep copy of report context that is JSON-serialisable and bounded. */
export function sanitize(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {}

  const seen = new WeakSet<object>()

  return contextValue(context, 0, seen) as Record<string, unknown>
}

function contextValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") return value

  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)

  if (typeof value === "bigint") return value.toString()

  if (typeof value === "string") return truncate(value, MAX_CONTEXT_STRING)

  if (typeof value !== "object" || depth >= MAX_CONTEXT_DEPTH) return undefined

  if (seen.has(value)) return "[circular]"
  seen.add(value)

  if (value instanceof Error) return { name: value.name, message: truncate(value.message, MAX_CONTEXT_STRING), stack: value.stack ? truncate(value.stack, MAX_STACK) : null }

  if (Array.isArray(value))
    return value
      .slice(0, MAX_CONTEXT_KEYS)
      .map((item) => contextValue(item, depth + 1, seen))
      .filter((item) => item !== undefined)

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_CONTEXT_KEYS)
      .flatMap(([key, item]) => {
        const next = contextValue(item, depth + 1, seen)

        return next === undefined ? [] : [[key, next]]
      }),
  )
}

function truncate(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}
