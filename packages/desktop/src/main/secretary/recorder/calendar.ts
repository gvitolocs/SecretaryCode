import { record } from "./input"

export type CalendarEvent = { id: string; title: string; startMs: number; endMs: number; calendar: string | null }

/** Joining a few minutes early still counts as "this meeting". */
const EARLY_JOIN_MS = 10 * 60_000

/** `GET /v1/calendar/events` answers `{ events: [{ id, title, startMs, endMs, allDay, … }] }`. All-day events are not meetings. */
export function parseEvents(input: unknown): CalendarEvent[] {
  const value = record(input, "calendar")

  return (Array.isArray(value.events) ? value.events : []).flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const event = record(item, "event")

    if (event.allDay === true || typeof event.id !== "string" || !event.id) return []
    const startMs = typeof event.startMs === "number" ? event.startMs : Date.parse(String(event.start ?? ""))
    const endMs = typeof event.endMs === "number" ? event.endMs : Date.parse(String(event.end ?? ""))

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return []

    return [
      {
        id: event.id,
        title: typeof event.title === "string" ? event.title.trim() : "",
        startMs,
        endMs,
        calendar: typeof event.calendar === "string" ? event.calendar : null,
      },
    ]
  })
}

/** The meeting happening now (or about to): the most recently started of the overlapping events. */
export function currentEvent(events: CalendarEvent[]) {
  const now = Date.now()

  return events
    .filter((event) => event.startMs - EARLY_JOIN_MS <= now && now < event.endMs)
    .toSorted((a, b) => b.startMs - a.startMs)[0]
}
