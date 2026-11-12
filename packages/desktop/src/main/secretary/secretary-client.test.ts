import { expect, test } from "bun:test"
import { markMacClient } from "./secretary-client"

test("the Mac rewrites the client header of a forwarded request to mac", () => {
  const headers = new Headers({ Authorization: "Bearer sec_device_token", "X-Secretary-Client": "web" })

  markMacClient(headers)

  expect(headers.get("X-Secretary-Client")).toBe("mac")
  expect(headers.get("Authorization")).toBe("Bearer sec_device_token")
})
