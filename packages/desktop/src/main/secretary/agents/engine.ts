import type { OpenCodeClient } from "@opencode/client/promise"

/** What the mirror and the command handler need from the TypeScript engine, behind the SDK client. */
export interface Engine {
  /** Undefined when the session no longer exists. */
  session(sessionID: string): Promise<{ title?: string; directory: string; parentID?: string } | undefined>
  prompt(sessionID: string, input: { id: string; text: string; delivery: "steer" | "queue" }): Promise<void>
  interrupt(sessionID: string): Promise<void>
  replyPermission(sessionID: string, requestID: string, decision: "once" | "always" | "reject", message?: string): Promise<void>
}

/** The engine refused the request (unknown session, bad input): retrying it cannot succeed. */
export class EngineRejected extends Error {
  override readonly name = "EngineRejected"
}

/** Declared errors the engine may stop returning once it is reachable and signed in again. */
const TRANSIENT = new Set(["UnauthorizedError", "ServiceUnavailableError"])

/** The engine through the same SDK client the app uses, with its declared errors marked as final. */
export function createEngine(client: OpenCodeClient): Engine {
  return {
    session: (sessionID) =>
      client.session.get({ sessionID }).then(
        (session) => ({ title: session.title, directory: session.location.directory, parentID: session.parentID }),
        (error: unknown) => {
          if (tag(error) === "SessionNotFoundError") return undefined
          throw classify(error)
        },
      ),
    prompt: (sessionID, input) =>
      client.session.prompt({ sessionID, id: input.id, text: input.text, delivery: input.delivery }).then(
        () => undefined,
        (error: unknown) => {
          throw classify(error)
        },
      ),
    interrupt: (sessionID) =>
      client.session.interrupt({ sessionID }).then(
        () => undefined,
        (error: unknown) => {
          throw classify(error)
        },
      ),
    replyPermission: (sessionID, requestID, decision, message) =>
      client.permission.reply({ sessionID, requestID, decision, ...(message ? { message } : {}) }).catch((error: unknown) => {
        throw classify(error)
      }),
  }
}

function tag(error: unknown) {
  return error instanceof Error && "_tag" in error && typeof error._tag === "string" ? error._tag : undefined
}

function classify(error: unknown) {
  const name = tag(error)

  if (name && !TRANSIENT.has(name)) return new EngineRejected(error instanceof Error ? error.message : name)
  return error
}
