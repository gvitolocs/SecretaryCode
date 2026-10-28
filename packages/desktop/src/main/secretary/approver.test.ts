import { expect, test } from "bun:test"
import { APPROVAL_ID, approveReason, DEVICE_ID, errorFor } from "./approver-core"

test("server refusals map to what the page shows", () => {
  expect(errorFor(409, "approval_decided")).toBe("decided")
  expect(errorFor(410, "approval_expired")).toBe("expired")
  expect(errorFor(404, "approval_not_found")).toBe("notPending")
  expect(errorFor(409, "payload_mismatch")).toBe("changed")
  expect(errorFor(403, "not_main_device")).toBe("notMain")
  expect(errorFor(403, "biometric_required")).toBe("needsSetup")
  expect(errorFor(500, undefined)).toBe("server")
})

test("only well-formed ids reach the helper", () => {
  expect(APPROVAL_ID.test("apr_jTmxQ_AMEHotXvQgJcwLwg")).toBe(true)
  expect(APPROVAL_ID.test("apr_x/../decide")).toBe(false)
  expect(APPROVAL_ID.test("apr_x\nsecretary-approval-v1")).toBe(false)
  expect(DEVICE_ID.test("dev_6uJCAexoApw")).toBe(true)
  expect(DEVICE_ID.test("dev_a b")).toBe(false)
})

test("the Touch ID prompt quotes the server's summary, on one line, clipped", () => {
  expect(approveReason("Run 1 command as root on nezopt: test", "Lucina")).toBe(
    'approve "Run 1 command as root on nezopt: test" for Lucina',
  )
  expect(approveReason("a\n\nb", "")).toBe('approve "a b" for Lucina')
  expect(approveReason("x".repeat(400), "Lucina").length).toBeLessThan(260)
})
