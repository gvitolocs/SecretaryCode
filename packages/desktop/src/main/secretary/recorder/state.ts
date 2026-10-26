import { RecorderInputError, optionalText, record, text } from "./input"
import { parseSource, type CaptureSource, type HelperEvent, type Levels, type TrackName } from "./protocol"

export type Phase = "idle" | "starting" | "recording" | "paused" | "stopping"

/** The one recording this Mac may run at a time. */
export type ActiveRecording = {
  phase: Phase
  id: string | null
  directory: string | null
  title: string
  source: CaptureSource | null
  startedAt: string | null
  elapsed: number
  levels: Levels
  files: Partial<Record<TrackName, number>>
  error: { code: string; message: string } | null
}

export const IDLE: ActiveRecording = {
  phase: "idle",
  id: null,
  directory: null,
  title: "",
  source: null,
  startedAt: null,
  elapsed: 0,
  levels: {},
  files: {},
  error: null,
}

export type Permission = "screen" | "microphone"

/** Every request the Record sheet may send over `secretary:recorder`, validated at that boundary. */
export type RecorderRequest =
  | { action: "snapshot" }
  | { action: "sources" }
  | { action: "start"; source: CaptureSource; title: string; calendarEventId: string | null }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "stop" }
  | { action: "saveSettings"; settings: unknown }
  | { action: "requestPermission"; permission: Permission }
  | { action: "openPrivacySettings"; permission: Permission }
  | { action: "openFolder"; id: string | null }
  | { action: "openTranscript"; id: string }
  | { action: "retryUpload"; id: string }
  | { action: "close" }

export type RecorderEvent =
  | { type: "start"; id: string; directory: string; title: string; source: CaptureSource }
  | { type: "start-failed"; code: string; message: string }
  | { type: "stop" }
  | { type: "helper"; event: HelperEvent }
  | { type: "helper-exited" }

export function parseRequest(action: unknown, input: unknown): RecorderRequest {
  switch (action) {
    case "snapshot":
    case "sources":
    case "pause":
    case "resume":
    case "stop":
    case "close":
      return { action }
    case "start": {
      const value = record(input, "start")
      const title = text(value.title, "title", 200).trim()

      return {
        action,
        source: parseSource(value.source),
        title,
        calendarEventId: optionalText(value.calendarEventId, "calendarEventId", 300),
      }
    }

    case "saveSettings":
      return { action, settings: input }
    case "requestPermission":
    case "openPrivacySettings":
      if (input !== "screen" && input !== "microphone")
        throw new RecorderInputError("permission must be screen or microphone")

      return { action, permission: input }
    case "openFolder":
      return { action, id: input === undefined || input === null ? null : recordingID(input) }
    case "openTranscript":
    case "retryUpload":
      return { action, id: recordingID(input) }
    default:
      throw new RecorderInputError("Unknown recorder action")
  }
}

function recordingID(input: unknown) {
  if (typeof input !== "string" || !/^[a-f0-9-]{36}$/.test(input)) throw new RecorderInputError("Unknown recording")

  return input
}

/** Why the current phase refuses a request, or null when it may run. */
export function rejection(phase: Phase, request: RecorderRequest) {
  switch (request.action) {
    case "start":
      return phase === "idle" ? null : "alreadyRecording"
    case "pause":
      return phase === "recording" ? null : "notRecording"
    case "resume":
      return phase === "paused" ? null : "notPaused"
    case "stop":
      return phase === "recording" || phase === "paused" ? null : "notRecording"
    case "saveSettings":
      // Capture settings are fixed once a recording starts; changing them mid-way would only mislead.
      return phase === "idle" ? null : "settingsLocked"
    default:
      return null
  }
}

export function reduce(state: ActiveRecording, event: RecorderEvent): ActiveRecording {
  switch (event.type) {
    case "start":
      if (state.phase !== "idle") return state

      return {
        ...IDLE,
        phase: "starting",
        id: event.id,
        directory: event.directory,
        title: event.title,
        source: event.source,
      }
    case "start-failed":
      if (state.phase !== "starting") return state

      return { ...IDLE, error: { code: event.code, message: event.message } }
    case "stop":
      if (state.phase !== "recording" && state.phase !== "paused") return state

      return { ...state, phase: "stopping" }
    case "helper-exited":
      if (state.phase === "idle") return state

      return { ...IDLE, error: { code: "helper-exited", message: "The recorder stopped unexpectedly" } }
    case "helper":
      return helper(state, event.event)
  }
}

function helper(state: ActiveRecording, event: HelperEvent): ActiveRecording {
  switch (event.event) {
    case "started":
      if (state.phase !== "starting") return state

      return { ...state, phase: "recording", startedAt: event.startedAt }
    case "status":
      if (state.phase !== "recording" && state.phase !== "paused") return state

      return { ...state, phase: event.state, elapsed: event.elapsed, levels: event.levels, files: event.files }
    case "error":
      if (!event.fatal || state.phase === "idle") return state

      return { ...state, error: { code: event.code, message: event.message } }
    case "stopped":
      if (state.phase === "idle") return state

      return { ...IDLE, error: state.error }
    default:
      return state
  }
}
