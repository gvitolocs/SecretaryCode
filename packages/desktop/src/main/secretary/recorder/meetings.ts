import type { SourceApp, SourceWindow } from "./protocol"

/** Apps whose only job is meetings. Opening one during a calendar event prompts a suggestion. */
const MEETING_APPS = new Set([
  "com.microsoft.teams2",
  "com.microsoft.teams",
  "us.zoom.xos",
  "com.hnc.Discord",
  "com.tinyspeck.slackmacgap",
  "com.apple.FaceTime",
  "Cisco-Systems.Spark",
  "com.cisco.webexmeetingsapp",
  "com.webex.meetingmanager",
  "com.skype.skype",
])

/** Browsers host Google Meet and web clients of the apps above. */
const BROWSERS = new Set([
  "com.google.Chrome",
  "com.google.Chrome.canary",
  "com.apple.Safari",
  "company.thebrowser.Browser",
  "com.microsoft.edgemac",
  "com.brave.Browser",
  "org.mozilla.firefox",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
])

const MEETING_TITLE = /\b(meet|zoom|teams|huddle|webex|whereby|jitsi|facetime)\b/i

export function isMeetingApp(bundleId: string) {
  return MEETING_APPS.has(bundleId)
}

/** 0: a meeting app, 1: a browser, 2: anything else. Lower sorts first in the picker. */
export function meetingRank(bundleId: string | null) {
  if (!bundleId) return 2

  if (MEETING_APPS.has(bundleId)) return 0

  return BROWSERS.has(bundleId) ? 1 : 2
}

/** A window that looks like a call: a Meet tab, a Zoom or Teams meeting, a Slack huddle. */
export function isMeetingWindow(window: Pick<SourceWindow, "bundleId" | "title">) {
  return meetingRank(window.bundleId) < 2 && MEETING_TITLE.test(window.title)
}

export function rankApps(apps: SourceApp[]) {
  return apps.toSorted((a, b) => meetingRank(a.bundleId) - meetingRank(b.bundleId) || a.name.localeCompare(b.name))
}

export function rankWindows(windows: SourceWindow[]) {
  const score = (window: SourceWindow) => (isMeetingWindow(window) ? 0 : 1) + meetingRank(window.bundleId)

  return windows.toSorted(
    (a, b) => score(a) - score(b) || (a.app ?? "").localeCompare(b.app ?? "") || a.title.localeCompare(b.title),
  )
}
