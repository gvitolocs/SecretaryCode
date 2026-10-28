// The parts of the attention watcher (attention.ts) that need no Electron: reading the server's lists of what waits for
// the owner, which items are new, the notification texts, the badge and the small file that remembers what was shown.
import { APPROVAL_ID } from "./approver-core"
import type { ShellCommand } from "./shell-command"

export type AttentionKind = "approval" | "decision"

/** One thing that needs the owner, as a notification shows it. */
export type AttentionItem = { kind: AttentionKind; id: string; title: string; body: string }

export type AttentionCounts = { approvals: number; decisions: number }

export const DECISION_ID = /^[A-Za-z0-9_-]{1,80}$/

export const APPROVALS_ROUTE = "/v1/approvals?status=pending"
export const DECISIONS_ROUTE = "/v1/decisions?status=pending"

// Approvals are time-critical (a command waits for them); decisions are slower go-aheads.
export const APPROVALS_EVERY = 5_000
export const DECISIONS_EVERY = 20_000
export const BACKOFF_EVERY = 60_000
export const SIGNED_OUT_EVERY = 15_000

/** The wait before the next poll: the usual interval, one minute after a failed poll. */
export function pollDelay(base: number, failures: number) {
  return failures > 0 ? Math.max(base, BACKOFF_EVERY) : base
}

function text(value: unknown, max: number) {
  const flat = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""

  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/**
 * The pending approvals in an answer of GET /v1/approvals?status=pending, or undefined when the answer is not that
 * list (an error body, a proxy page): the caller then keeps what it knew. Entries without a valid id are skipped.
 */
export function parseApprovals(data: unknown): AttentionItem[] | undefined {
  const list = record(data)?.approvals

  if (!Array.isArray(list)) return

  return list.flatMap((entry): AttentionItem[] => {
    const item = record(entry)
    const id = item?.id

    if (!item || typeof id !== "string" || !APPROVAL_ID.test(id)) return []
    const requester = record(item.requester)
    const who = text(requester?.name, 60) || text(requester?.kind, 60) || "Lucina"

    return [
      {
        kind: "approval",
        id,
        title: `${who} needs your OK`,
        body: text(item.summary, 200) || "A request is waiting for your approval.",
      },
    ]
  })
}

/** The pending decisions in an answer of GET /v1/decisions?status=pending; undefined for anything else. */
export function parseDecisions(data: unknown): AttentionItem[] | undefined {
  const list = record(data)?.items

  if (!Array.isArray(list)) return

  return list.flatMap((entry): AttentionItem[] => {
    const item = record(entry)
    const id = item?.decision_id

    if (!item || typeof id !== "string" || !DECISION_ID.test(id)) return []

    return [
      {
        kind: "decision",
        id,
        title: "Lucina needs your decision",
        body: text(item.question, 200) || "A go-ahead is waiting for you.",
      },
    ]
  })
}

/**
 * What a poll changes. `fresh` are pending items not shown yet, `gone` are shown ids no longer pending, and `notified`
 * is the set to remember: the pending ids already shown plus the fresh ones, so it never outgrows the pending list.
 */
export function reconcile(pending: readonly AttentionItem[], notified: ReadonlySet<string>) {
  const ids = new Set(pending.map((item) => item.id))
  const fresh = pending.filter((item, index) => !notified.has(item.id) && pending.findIndex((other) => other.id === item.id) === index)

  return {
    fresh,
    gone: [...notified].filter((id) => !ids.has(id)),
    notified: new Set([...notified].filter((id) => ids.has(id)).concat(fresh.map((item) => item.id))),
  }
}

/** The command that shows the page for an item: approvals in Lucina's chat view, decisions in the Decisions view. */
export function openCommand(kind: AttentionKind, id: string): Extract<ShellCommand, { action: "open" }> {
  return kind === "approval"
    ? { action: "open", view: "lucina", path: `/approvals/${id}` }
    : { action: "open", view: "decisions", path: `/decisions/${id}` }
}

/** The dock badge: the total waiting, empty at zero. */
export function badgeText(counts: AttentionCounts) {
  const total = counts.approvals + counts.decisions

  return total > 0 ? String(total) : ""
}

export type Notified = { approvals: Set<string>; decisions: Set<string> }

const REMEMBERED = 500

/** The remembered ids from the file's text; anything unreadable or malformed means nothing is remembered. */
export function parseNotified(raw: string | undefined): Notified {
  const empty = { approvals: new Set<string>(), decisions: new Set<string>() }

  if (!raw) return empty
  let data: unknown

  try {
    data = JSON.parse(raw)
  } catch {
    return empty
  }
  const file = record(data)
  const ids = (value: unknown, valid: RegExp) =>
    new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && valid.test(id)).slice(0, REMEMBERED) : [])

  return { approvals: ids(file?.approvals, APPROVAL_ID), decisions: ids(file?.decisions, DECISION_ID) }
}

export function serializeNotified(notified: Notified) {
  return JSON.stringify({ approvals: [...notified.approvals], decisions: [...notified.decisions] })
}
