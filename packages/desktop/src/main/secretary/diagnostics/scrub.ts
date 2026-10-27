import type { DiagnosticReport } from "./report"

export const REDACTED = "[redacted]"

/** Values shorter than this are not treated as secrets: redacting "on" would mangle ordinary logs. */
const MIN_SECRET_LENGTH = 4

type Rule = { pattern: RegExp; replace: string }

/**
 * Credential shapes that must never leave the Mac in a log tail. Ordered: a whole header goes before
 * the bare scheme, and a `password: …` field goes before key-shaped tokens inside its value.
 */
const RULES: readonly Rule[] = [
  // `Authorization: Bearer …`, `authorization=Basic …`, including the JSON form.
  { pattern: /\b((?:proxy-)?authorization["']?\s*[:=]\s*)[^\r\n,}]+/gi, replace: `$1${REDACTED}` },
  // `Bearer abc123`, `Basic dXNlcjoxMjM=`: a scheme followed by a value that looks like a credential.
  { pattern: /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]*\d[A-Za-z0-9._~+/=-]*/gi, replace: `$1 ${REDACTED}` },
  // `OPENCODE_PASSWORD=…`, `LUCINA_MCP_TOKEN=…`: an environment variable name is its own field.
  {
    pattern: /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|KEY))\s*=\s*\S+/g,
    replace: `$1=${REDACTED}`,
  },
  // `password: …`, `"api_key":"…"`, `OPENCODE_PASSWORD=…`, `?access_token=…`.
  {
    pattern:
      /\b(password|passwd|pwd|passphrase|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|private[_-]?key|session[_-]?token|session[_-]?key|credential|credentials)\b(["']?\s*[:=]\s*)(["']?)[^\s"',;}]+/gi,
    replace: `$1$2$3${REDACTED}`,
  },
  // Provider and service key shapes, so a key quoted without a field name is still caught.
  { pattern: /\bsec_[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  { pattern: /\bsk-(?:ant-|proj-|or-|live-|test-)?[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replace: REDACTED },
  { pattern: /\bgsk_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { pattern: /\bhf_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { pattern: /\bnvapi-[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, replace: REDACTED },
]

/** Text with credentials removed. `secrets` are exact values, such as the engine's service password. */
export function scrub(text: string, secrets: readonly string[] = []) {
  const known = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH).toSorted((a, b) => b.length - a.length)
  const withoutKnown = known.reduce((next, secret) => next.split(secret).join(REDACTED), text)

  return RULES.reduce((next, rule) => next.replace(rule.pattern, rule.replace), withoutKnown)
}

/** Message, stack and context strings scrubbed; the rest of the report is structured data. */
export function scrubReport(report: DiagnosticReport, secrets: readonly string[] = []): DiagnosticReport {
  return {
    ...report,
    message: scrub(report.message, secrets),
    stack: report.stack ? scrub(report.stack, secrets) : null,
    context: scrubContext(report.context, secrets),
  }
}

/** Bytes to text for scrubbing, and back. Replacement characters keep a split code point readable. */
export function scrubBytes(data: Uint8Array, secrets: readonly string[] = []) {
  return new TextEncoder().encode(scrub(new TextDecoder().decode(data), secrets))
}

function scrubContext(value: unknown, secrets: readonly string[]): Record<string, unknown> {
  return mapStrings(value, (text) => scrub(text, secrets)) as Record<string, unknown>
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value)

  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map))

  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]))

  return value
}
