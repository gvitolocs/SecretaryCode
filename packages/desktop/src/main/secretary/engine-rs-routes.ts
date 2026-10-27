// Static route inventory for the Rust-engine preview panel. The v2 side is generated from the committed
// OpenAPI artifact of the fork's protocol (`packages/protocol/openapi.json`, produced by
// `bun run generate` in that package) and `engine-rs-routes.test.ts` compares the two exactly, so the panel
// can never claim a route the v2 surface does not declare. The ported side is transcribed from
// `oc-server`'s router, which `engine-rs/README.md` documents in its fidelity matrix.
//
// Paths are written with `{param}` names, the form both the OpenAPI artifact and axum use.

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface Route {
  method: RouteMethod
  path: string
  /** The v2 operation id from the OpenAPI artifact, or the ported handler's own name. */
  operation: string
}

/** The v2 session surface: every session-tagged operation in the protocol artifact, plus the event feed. */
export const V2_SESSION_ROUTES: readonly Route[] = [
  { method: "GET", path: "/api/session", operation: "session.list" },
  { method: "POST", path: "/api/session", operation: "session.create" },
  { method: "GET", path: "/api/experimental/session/stats", operation: "experimental.session.stats" },
  { method: "POST", path: "/api/experimental/session/import", operation: "experimental.session.import" },
  { method: "GET", path: "/api/experimental/session/{sessionID}/export", operation: "experimental.session.export" },
  { method: "GET", path: "/api/session/active", operation: "session.active" },
  { method: "GET", path: "/api/session/{sessionID}", operation: "session.get" },
  { method: "DELETE", path: "/api/session/{sessionID}", operation: "session.remove" },
  { method: "PATCH", path: "/api/session/{sessionID}", operation: "session.update" },
  { method: "POST", path: "/api/session/{sessionID}/fork", operation: "session.fork" },
  { method: "POST", path: "/api/session/{sessionID}/agent", operation: "session.switchAgent" },
  { method: "POST", path: "/api/session/{sessionID}/model", operation: "session.switchModel" },
  { method: "POST", path: "/api/session/{sessionID}/move", operation: "session.move" },
  { method: "POST", path: "/api/session/{sessionID}/prompt", operation: "session.prompt" },
  { method: "POST", path: "/api/session/{sessionID}/command", operation: "session.command" },
  { method: "POST", path: "/api/experimental/session/{sessionID}/skill", operation: "experimental.session.skill" },
  { method: "POST", path: "/api/session/{sessionID}/synthetic", operation: "session.synthetic" },
  { method: "POST", path: "/api/session/{sessionID}/shell", operation: "session.shell" },
  { method: "POST", path: "/api/session/{sessionID}/compact", operation: "session.compact" },
  { method: "POST", path: "/api/experimental/session/{sessionID}/wait", operation: "experimental.session.wait" },
  { method: "POST", path: "/api/session/{sessionID}/revert/stage", operation: "session.revert.stage" },
  { method: "DELETE", path: "/api/session/{sessionID}/revert", operation: "session.revert.clear" },
  { method: "POST", path: "/api/session/{sessionID}/revert/commit", operation: "session.revert.commit" },
  { method: "GET", path: "/api/session/{sessionID}/context", operation: "session.context" },
  { method: "GET", path: "/api/session/{sessionID}/diff", operation: "session.diff" },
  { method: "GET", path: "/api/session/{sessionID}/inbox", operation: "session.inbox.list" },
  { method: "DELETE", path: "/api/session/{sessionID}/inbox/{inboxID}", operation: "session.inbox.cancel" },
  { method: "PATCH", path: "/api/session/{sessionID}/inbox/{inboxID}", operation: "session.inbox.update" },
  {
    method: "GET",
    path: "/api/experimental/session/{sessionID}/instructions/entries",
    operation: "experimental.session.instructions.entry.list",
  },
  {
    method: "PUT",
    path: "/api/experimental/session/{sessionID}/instructions/entries/{key}",
    operation: "experimental.session.instructions.entry.put",
  },
  {
    method: "DELETE",
    path: "/api/experimental/session/{sessionID}/instructions/entries/{key}",
    operation: "experimental.session.instructions.entry.remove",
  },
  { method: "POST", path: "/api/session/{sessionID}/generate", operation: "session.generate" },
  { method: "GET", path: "/api/experimental/session/{sessionID}/log", operation: "session.log" },
  { method: "POST", path: "/api/session/{sessionID}/interrupt", operation: "session.interrupt" },
  { method: "POST", path: "/api/session/{sessionID}/background", operation: "session.background" },
  { method: "GET", path: "/api/session/{sessionID}/message/{messageID}", operation: "session.message.get" },
  { method: "GET", path: "/api/session/{sessionID}/message", operation: "session.message.list" },
  { method: "GET", path: "/api/session/{sessionID}/form", operation: "session.form.list" },
  { method: "POST", path: "/api/session/{sessionID}/form", operation: "session.form.create" },
  { method: "GET", path: "/api/session/{sessionID}/form/{formID}", operation: "session.form.get" },
  { method: "DELETE", path: "/api/session/{sessionID}/form/{formID}", operation: "session.form.cancel" },
  { method: "POST", path: "/api/session/{sessionID}/form/{formID}/reply", operation: "session.form.reply" },
  { method: "PUT", path: "/api/session/{sessionID}/environment", operation: "session.environment" },
  { method: "POST", path: "/api/session/{sessionID}/view", operation: "session.view" },
  { method: "GET", path: "/api/event", operation: "event.subscribe" },
]

/**
 * What the bundled `oc-server` serves, per its router. `v2` names the equivalent v2 operation when one
 * exists; the port's prompt, abort, health and event paths have no v2 counterpart at their path.
 */
export const PORTED_ROUTES: ReadonlyArray<Route & { v2?: string }> = [
  { method: "GET", path: "/health", operation: "health" },
  { method: "GET", path: "/api/session", operation: "session_list", v2: "session.list" },
  { method: "POST", path: "/api/session", operation: "session_create", v2: "session.create" },
  { method: "GET", path: "/api/session/active", operation: "session_active", v2: "session.active" },
  { method: "GET", path: "/api/session/{sessionID}", operation: "session_get", v2: "session.get" },
  { method: "PATCH", path: "/api/session/{sessionID}", operation: "session_update", v2: "session.update" },
  { method: "DELETE", path: "/api/session/{sessionID}", operation: "session_remove", v2: "session.remove" },
  {
    method: "GET",
    path: "/api/session/{sessionID}/message",
    operation: "session_messages",
    v2: "session.message.list",
  },
  // v2 names the prompt `POST /api/session/:sessionID/prompt`; the port predates that split.
  { method: "POST", path: "/api/session/{sessionID}/message", operation: "session_prompt" },
  // v2 names this `POST /api/session/:sessionID/interrupt`.
  { method: "POST", path: "/api/session/{sessionID}/abort", operation: "session_abort" },
  {
    method: "POST",
    path: "/api/session/{sessionID}/synthetic",
    operation: "session_synthetic",
    v2: "session.synthetic",
  },
  // v2 serves the SSE feed at `/api/event`.
  { method: "GET", path: "/event", operation: "event_feed" },
]

export interface RouteCoverage {
  /** Routes the Rust server serves. */
  portedTotal: number
  /** Ported routes whose method and path exist in the v2 session surface. */
  portedMatched: number
  /** Routes in the v2 session surface. */
  v2Total: number
  /** Ported routes with no v2 counterpart at that path: aliases, extras and paths v2 names differently. */
  beyondV2: readonly string[]
}

export function routeCoverage(): RouteCoverage {
  const v2 = new Set(V2_SESSION_ROUTES.map((route) => `${route.method} ${route.path}`))
  const matched = PORTED_ROUTES.filter((route) => v2.has(`${route.method} ${route.path}`))

  return {
    portedTotal: PORTED_ROUTES.length,
    portedMatched: matched.length,
    v2Total: V2_SESSION_ROUTES.length,
    beyondV2: PORTED_ROUTES.filter((route) => !v2.has(`${route.method} ${route.path}`)).map(
      (route) => `${route.method} ${route.path}`,
    ),
  }
}
