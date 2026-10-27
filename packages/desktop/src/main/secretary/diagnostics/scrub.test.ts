import { describe, expect, test } from "bun:test"
import { createReport } from "./report"
import { REDACTED, scrub, scrubReport } from "./scrub"

const identity = { appVersion: "2.1.4", os: "darwin", device: "Mac" }

describe("credentials in a report", () => {
  test.each([
    // Whole headers, in logs and in JSON payloads.
    ["Authorization: Bearer sec_abc123def456", `Authorization: ${REDACTED}`],
    ['{"authorization":"Bearer sec_abc123def456"}', `{"authorization":${REDACTED}}`],
    ["sent x-api-key: sk-live-0123456789abcdefABCDEF", "sent x-api-key: [redacted]"],
    ["request failed with Bearer abc123def456", `request failed with Bearer ${REDACTED}`],
    // Password-shaped fields, quoted and bare.
    ['{"password":"hunter2"}', `{"password":"${REDACTED}"}`],
    ["password: hunter2", `password: ${REDACTED}`],
    ["https://127.0.0.1:4096/?token=abc123", `https://127.0.0.1:4096/?token=${REDACTED}`],
    ["OPENCODE_PASSWORD=hunter2", `OPENCODE_PASSWORD=${REDACTED}`],
    ["LUCINA_MCP_TOKEN=abc123def", `LUCINA_MCP_TOKEN=${REDACTED}`],
    ['"client_secret": "s3cr3t"', `"client_secret": "${REDACTED}"`],
    // Key shapes without a field name.
    ["key sec_ABCDEFGH12345678 rejected", `key ${REDACTED} rejected`],
    ["key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", `key ${REDACTED}`],
    ["token ghp_0123456789abcdefghijKLMNOPQRSTUV", `token ${REDACTED}`],
    ["token github_pat_11ABCDEFG0123456789_abcdefghijklmnop", `token ${REDACTED}`],
    ["creds AKIAIOSFODNN7EXAMPLE used", `creds ${REDACTED} used`],
    ["slack xoxb-123456789012-abcdefghijkl", `slack ${REDACTED}`],
    ["google AIzaSyA1234567890abcdefghijklmnopqrstuv", `google ${REDACTED}`],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", `jwt ${REDACTED}`],
  ])("removes %p", (line, expected) => {
    expect(scrub(line)).toBe(expected)
  })

  test("removes the exact service password even where it has no field name or regex-safe form", () => {
    const password = "a.b*c[1]$(sh)"
    const text = `connecting to http://127.0.0.1:4096 with ${password} now`

    expect(scrub(text, [password])).toBe(`connecting to http://127.0.0.1:4096 with ${REDACTED} now`)
    expect(scrub(text)).toBe(text)
  })

  test("leaves ordinary log prose alone", () => {
    const line = "The password prompt did not appear, the token bucket refilled, and authorization was denied."

    expect(scrub(line)).toBe(line)
  })

  test("scrubs the message, the stack and nested context of a report", () => {
    const report = createReport({
      kind: "error",
      message: "connect failed for Bearer abc123def456",
      stack: "Error\n    at send (client.ts:1:1)\n    Authorization: Bearer abc123def456",
      context: { note: "OPENCODE_PASSWORD=hunter2", nested: { token: ["sec_ABCDEFGH12345678"] } },
      ...identity,
    })
    const scrubbed = scrubReport(report, ["hunter2"])

    expect(scrubbed.message).toBe(`connect failed for Bearer ${REDACTED}`)
    expect(scrubbed.stack).not.toContain("abc123def456")
    expect(scrubbed.context).toEqual({ note: `OPENCODE_PASSWORD=${REDACTED}`, nested: { token: [REDACTED] } })
    // The original report is unchanged: scrubbing happens on the copy that is uploaded.
    expect(report.message).toContain("abc123def456")
  })
})
