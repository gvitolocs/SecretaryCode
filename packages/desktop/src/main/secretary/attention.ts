import { app, BrowserWindow, ipcMain, Notification } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isRendererUrl } from "../windows/scheme"
import { secretaryToken, openLucinaPath } from "./index"
import { revealShell } from "./panel"
import {
  APPROVALS_EVERY,
  APPROVALS_ROUTE,
  badgeText,
  DECISIONS_EVERY,
  DECISIONS_ROUTE,
  openCommand,
  parseApprovals,
  parseDecisions,
  parseNotified,
  pollDelay,
  reconcile,
  serializeNotified,
  SIGNED_OUT_EVERY,
  type AttentionCounts,
  type AttentionItem,
  type AttentionKind,
} from "./attention-core"

// What needs the owner, told to him natively. Web Push does not work in Electron, so this process polls the same lists
// her web app reads (pending approvals every few seconds, pending decisions a little slower) with this Mac's device
// token, shows a notification for each new item, closes it once the item is answered elsewhere, and publishes the
// counts: the dock badge here, the rail's Decisions badge in the window. Clicking a notification opens the item's page.

const origins = ["https://getsecretary.tech", "https://secretary-p1.tail75dcfc.ts.net"]

// A first start (or a long absence) can find many items waiting; the badge counts them, so only this many pop up at once.
const MOST_AT_ONCE = 5

type Watch = {
  kind: AttentionKind
  route: string
  every: number
  parse: (data: unknown) => AttentionItem[] | undefined
  failures: number
  pending: AttentionItem[]
  notified: Set<string>
  shown: Map<string, Notification>
}

function watch(kind: AttentionKind, route: string, every: number, parse: Watch["parse"]): Watch {
  return { kind, route, every, parse, failures: 0, pending: [], notified: new Set(), shown: new Map() }
}

const watches = { approval: watch("approval", APPROVALS_ROUTE, APPROVALS_EVERY, parseApprovals), decision: watch("decision", DECISIONS_ROUTE, DECISIONS_EVERY, parseDecisions) }
let published: AttentionCounts = { approvals: 0, decisions: 0 }

function counts(): AttentionCounts {
  return { approvals: watches.approval.pending.length, decisions: watches.decision.pending.length }
}

function memoryFile() {
  return join(app.getPath("userData"), "attention.json")
}

/** The ids already shown, kept across restarts so a restart does not tell the owner again. */
async function remember() {
  await mkdir(app.getPath("userData"), { recursive: true })
  await writeFile(
    memoryFile(),
    serializeNotified({ approvals: watches.approval.notified, decisions: watches.decision.notified }),
    { mode: 0o600 },
  ).catch(() => {})
}

/** A call to the server as this Mac's device, trying each origin. Undefined for any failure. */
async function fetchJson(route: string, token: string): Promise<unknown> {
  for (const origin of origins) {
    const response = await fetch(origin + route, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)

    if (!response) continue

    return response.ok ? response.json().catch(() => undefined) : undefined
  }
}

function open(item: AttentionItem) {
  const command = openCommand(item.kind, item.id)

  // Without a window the Lucina view still starts at the item's page when a window comes back.
  if (!revealShell(command)) {
    openLucinaPath(command.path)
    app.focus({ steal: true })
  }
}

function notify(w: Watch, item: AttentionItem) {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title: item.title, body: item.body })
  // The map keeps the notification alive (it would otherwise be collected, taking its click handler along).
  notification.on("click", () => open(item))
  notification.on("close", () => {
    if (w.shown.get(item.id) === notification) w.shown.delete(item.id)
  })
  w.shown.set(item.id, notification)
  notification.show()
}

function closeShown(w: Watch, ids: Iterable<string>) {
  for (const id of ids) {
    w.shown.get(id)?.close()
    w.shown.delete(id)
  }
}

/** Tells the dock and every app window when the counts changed. */
function publish() {
  const next = counts()

  if (next.approvals === published.approvals && next.decisions === published.decisions) return
  published = next
  if (process.platform === "darwin") app.dock?.setBadge(badgeText(next))

  for (const window of BrowserWindow.getAllWindows())
    if (!window.isDestroyed() && isRendererUrl(window.webContents.getURL())) window.webContents.send("secretary:attention", next)
}

/** One poll. Resolves to how it went: signed out (nothing asked), answered, or failed (the last list stays). */
async function poll(w: Watch): Promise<"signedOut" | "ok" | "failed"> {
  const token = await secretaryToken()

  if (!token) {
    closeShown(w, [...w.shown.keys()])
    w.pending = []
    publish()

    return "signedOut"
  }
  const items = w.parse(await fetchJson(w.route, token))

  if (!items) return "failed"
  const change = reconcile(items, w.notified)
  w.pending = items
  w.notified = change.notified
  closeShown(w, change.gone)
  change.fresh.slice(0, MOST_AT_ONCE).forEach((item) => notify(w, item))
  publish()
  if (change.fresh.length || change.gone.length) await remember()

  return "ok"
}

function run(w: Watch) {
  const next = (result: Awaited<ReturnType<typeof poll>>) => {
    w.failures = result === "failed" ? w.failures + 1 : 0

    return result === "signedOut" ? SIGNED_OUT_EVERY : pollDelay(w.every, w.failures)
  }
  const tick = () =>
    poll(w)
      .catch(() => "failed" as const)
      .then((result) => setTimeout(tick, next(result)).unref())

  void tick()
}

/** Call once during startup, after setupSecretary. Polls only while this Mac is signed in. */
export function setupAttention() {
  ipcMain.handle("secretary:attention-counts", (event) => {
    if (!event.senderFrame || event.senderFrame.parent || !isRendererUrl(event.senderFrame.url)) return { approvals: 0, decisions: 0 }

    return counts()
  })

  void app.whenReady().then(async () => {
    const remembered = parseNotified(await readFile(memoryFile(), "utf8").catch(() => undefined))
    watches.approval.notified = remembered.approvals
    watches.decision.notified = remembered.decisions
    run(watches.approval)
    run(watches.decision)
  })
}
