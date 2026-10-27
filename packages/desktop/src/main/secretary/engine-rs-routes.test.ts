import { expect, test } from "bun:test"
import path from "node:path"
import { PORTED_ROUTES, V2_SESSION_ROUTES, routeCoverage } from "./engine-rs-routes"

// The v2 list is a static copy of the protocol artifact. That artifact is the contract the preview claims to
// satisfy, so comparing against it fails the moment the fork adds or renames a session route.
const artifact = path.resolve(import.meta.dirname, "../../../../protocol/openapi.json")

test("the v2 inventory matches the protocol artifact exactly", async () => {
  const openapi = (await Bun.file(artifact).json()) as {
    paths: Record<string, Record<string, { tags?: string[] }>>
  }
  const session = Object.entries(openapi.paths).flatMap(([route, operations]) =>
    Object.entries(operations)
      .filter(([, operation]) => operation.tags?.includes("session"))
      .map(([method]) => `${method.toUpperCase()} ${route}`),
  )
  const event = Object.entries(openapi.paths).flatMap(([route, operations]) =>
    Object.entries(operations)
      .filter(([, operation]) => operation.tags?.includes("event"))
      .map(([method]) => `${method.toUpperCase()} ${route}`),
  )
  expect(V2_SESSION_ROUTES.map((route) => `${route.method} ${route.path}`).toSorted()).toEqual(
    [...session, ...event].toSorted(),
  )
})

test("ported routes name only operations the v2 inventory declares", () => {
  const operations = new Set(V2_SESSION_ROUTES.map((route) => route.operation))
  for (const route of PORTED_ROUTES) {
    if (!route.v2) continue
    expect(operations.has(route.v2)).toBe(true)
  }
})

test("coverage separates the routes v2 does not serve at the same path", () => {
  expect(routeCoverage()).toEqual({
    portedTotal: 12,
    portedMatched: 8,
    v2Total: 45,
    beyondV2: [
      "GET /health",
      "POST /api/session/{sessionID}/message",
      "POST /api/session/{sessionID}/abort",
      "GET /event",
    ],
  })
})
