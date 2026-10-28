import { expect, test } from "bun:test"
import {
  badgeText,
  openCommand,
  parseApprovals,
  parseDecisions,
  parseNotified,
  pollDelay,
  reconcile,
  serializeNotified,
  type AttentionItem,
} from "./attention-core"

const approval = (id: string): AttentionItem => ({ kind: "approval", id, title: "t", body: "b" })

test("approvals: title from the requester, summary as the body", () => {
  const items = parseApprovals({
    approvals: [
      { id: "apr_1", summary: "  sudo systemctl\n restart nginx ", requester: { name: "Codex", kind: "agent" }, sensitive: true },
      { id: "apr_2", summary: "x", requester: { kind: "agent" } },
      { id: "apr_3", summary: "" },
    ],
  })

  expect(items).toEqual([
    { kind: "approval", id: "apr_1", title: "Codex needs your OK", body: "sudo systemctl restart nginx" },
    { kind: "approval", id: "apr_2", title: "agent needs your OK", body: "x" },
    { kind: "approval", id: "apr_3", title: "Lucina needs your OK", body: "A request is waiting for your approval." },
  ])
})

test("approvals: long summaries are clipped, bad ids skipped", () => {
  const items = parseApprovals({ approvals: [{ id: "apr_1", summary: "a".repeat(500) }, { id: "../x" }, { id: 4 }, null, "apr_9"] })

  expect(items).toHaveLength(1)
  expect(items?.[0]?.body).toHaveLength(200)
  expect(items?.[0]?.body.endsWith("…")).toBe(true)
})

test("decisions: a fixed title, the question as the body", () => {
  expect(
    parseDecisions({ items: [{ decision_id: "dec_a1", question: "Deploy p1 now?", options: ["yes", "no"], recommendation: "yes" }, { question: "no id" }] }),
  ).toEqual([{ kind: "decision", id: "dec_a1", title: "Lucina needs your decision", body: "Deploy p1 now?" }])
})

test("malformed answers are not a list, so the caller keeps what it knew", () => {
  for (const bad of [undefined, null, "oops", 3, [], {}, { approvals: "x" }, { error: { code: "x" } }, { items: {} }]) {
    expect(parseApprovals(bad)).toBeUndefined()
    expect(parseDecisions(bad)).toBeUndefined()
  }
  expect(parseApprovals({ approvals: [] })).toEqual([])
  expect(parseDecisions({ items: [] })).toEqual([])
})

test("reconcile: new ids are fresh, shown ids are not, vanished ids are gone", () => {
  const first = reconcile([approval("apr_1"), approval("apr_2")], new Set())
  expect(first.fresh.map((item) => item.id)).toEqual(["apr_1", "apr_2"])
  expect(first.gone).toEqual([])

  const second = reconcile([approval("apr_2"), approval("apr_3")], first.notified)
  expect(second.fresh.map((item) => item.id)).toEqual(["apr_3"])
  expect(second.gone).toEqual(["apr_1"])
  expect([...second.notified].sort()).toEqual(["apr_2", "apr_3"])

  const third = reconcile([], second.notified)
  expect(third.fresh).toEqual([])
  expect(third.gone.sort()).toEqual(["apr_2", "apr_3"])
  expect(third.notified.size).toBe(0)
})

test("reconcile: a duplicate id in one answer is shown once", () => {
  expect(reconcile([approval("apr_1"), approval("apr_1")], new Set()).fresh).toHaveLength(1)
})

test("the open command targets the right view and page", () => {
  expect(openCommand("approval", "apr_1")).toEqual({ action: "open", view: "lucina", path: "/approvals/apr_1" })
  expect(openCommand("decision", "dec_1")).toEqual({ action: "open", view: "decisions", path: "/decisions/dec_1" })
})

test("the dock badge is the total, empty at zero", () => {
  expect(badgeText({ approvals: 0, decisions: 0 })).toBe("")
  expect(badgeText({ approvals: 1, decisions: 2 })).toBe("3")
})

test("polling slows to a minute after a failure, never speeds up", () => {
  expect(pollDelay(5_000, 0)).toBe(5_000)
  expect(pollDelay(5_000, 1)).toBe(60_000)
  expect(pollDelay(20_000, 3)).toBe(60_000)
  expect(pollDelay(90_000, 1)).toBe(90_000)
})

test("the remembered ids survive a round trip; a damaged file remembers nothing", () => {
  const saved = serializeNotified({ approvals: new Set(["apr_1"]), decisions: new Set(["dec_1"]) })
  const back = parseNotified(saved)
  expect([...back.approvals]).toEqual(["apr_1"])
  expect([...back.decisions]).toEqual(["dec_1"])

  for (const bad of [undefined, "", "{", "[]", "null", '{"approvals":"x"}']) {
    const empty = parseNotified(bad)
    expect(empty.approvals.size + empty.decisions.size).toBe(0)
  }
  // Ids that could not be real are dropped, not trusted.
  expect(parseNotified('{"approvals":["apr_1","../x",4],"decisions":["a b"]}').approvals.size).toBe(1)
  expect(parseNotified('{"decisions":["a b"]}').decisions.size).toBe(0)
})
