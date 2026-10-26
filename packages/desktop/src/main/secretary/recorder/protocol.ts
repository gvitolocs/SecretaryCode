import { RecorderInputError, finite, optionalText, record, text } from "./input"
import type { RecorderSettings } from "./settings"

/** File names are part of the upload contract: the server treats `mic.m4a` as the owner's voice. */
export const TRACKS = ["video.mp4", "system.m4a", "mic.m4a"] as const

export type TrackName = (typeof TRACKS)[number]

export type CaptureSource =
  | { kind: "app"; bundleId: string; name: string | null }
  | { kind: "window"; windowId: number; title: string | null; bundleId: string | null; name: string | null }
  | { kind: "display"; displayId: number; name: string | null }

export type PermissionState = { screen: "granted" | "missing"; microphone: "granted" | "denied" | "undetermined" }

export type Levels = { system?: number; mic?: number }

export type HelperTrack = { name: TrackName; bytes: number; status: string; startOffset: number | null }

export type StopSummary = { startedAt: string; endedAt: string; duration: number; tracks: HelperTrack[] }

export type HelperEvent =
  | { event: "ready"; nativeMicrophone: boolean }
  | { event: "permissions"; permissions: PermissionState }
  | { event: "started"; startedAt: string }
  | {
      event: "status"
      state: "recording" | "paused"
      elapsed: number
      levels: Levels
      files: Partial<Record<TrackName, number>>
    }
  | { event: "stopped"; summary: StopSummary }
  | { event: "error"; code: string; message: string; fatal: boolean }
  | { event: "app-launched" | "app-terminated"; bundleId: string; name: string | null }

export type HelperMessage =
  | { type: "reply"; id: string; ok: true; result: unknown }
  | { type: "reply"; id: string; ok: false; code: string; message: string }
  | { type: "event"; value: HelperEvent }

export type SourceApp = { bundleId: string; name: string; icon: string | null; windows: number }

export type SourceWindow = {
  id: number
  title: string
  bundleId: string | null
  app: string | null
  width: number
  height: number
}

export type SourceDisplay = { id: number; name: string | null; width: number; height: number; main: boolean }

export type Microphone = { id: string; name: string; default: boolean }

export type SourceList = {
  apps: SourceApp[]
  windows: SourceWindow[]
  displays: SourceDisplay[]
  microphones: Microphone[]
  permissions: PermissionState
}

/** The renderer's choice in the source picker. */
export function parseSource(input: unknown): CaptureSource {
  const value = record(input, "source")

  if (value.kind === "app")
    return { kind: "app", bundleId: bundleID(value.bundleId), name: optionalText(value.name, "source.name", 200) }

  if (value.kind === "window")
    return {
      kind: "window",
      windowId: identifier(value.windowId, "source.windowId"),
      title: optionalText(value.title, "source.title", 500),
      bundleId: value.bundleId === null || value.bundleId === undefined ? null : bundleID(value.bundleId),
      name: optionalText(value.name, "source.name", 200),
    }

  if (value.kind === "display")
    return {
      kind: "display",
      displayId: identifier(value.displayId, "source.displayId"),
      name: optionalText(value.name, "source.name", 200),
    }
  throw new RecorderInputError("source.kind must be app, window or display")
}

/** The `settings` object of the helper's `start` command (validated again in RecorderCore). */
export function helperStartSettings(settings: RecorderSettings, source: CaptureSource, directory: string) {
  return {
    outputDirectory: directory,
    source:
      source.kind === "app"
        ? { kind: "app", bundleId: source.bundleId }
        : source.kind === "window"
          ? { kind: "window", windowId: source.windowId }
          : { kind: "display", displayId: source.displayId },
    video: {
      enabled: settings.video,
      resolution: settings.resolution,
      fps: settings.fps,
      codec: settings.codec,
      bitrateKbps: settings.bitrateKbps,
    },
    systemAudio: settings.systemAudio,
    microphone: { enabled: settings.microphoneEnabled, deviceId: settings.microphone },
  }
}

/** One stdout line from the helper, or undefined for anything that is not a known message. */
export function parseHelperLine(line: string): HelperMessage | undefined {
  const value = json(line)

  if (!value) return undefined

  if (typeof value.id === "string") {
    if (value.ok === true) return { type: "reply", id: value.id, ok: true, result: value.result }
    const error = value.error && typeof value.error === "object" ? record(value.error, "error") : {}

    return {
      type: "reply",
      id: value.id,
      ok: false,
      code: String(error.code ?? "helper-error"),
      message: String(error.message ?? ""),
    }
  }

  const event = helperEvent(value)

  return event ? { type: "event", value: event } : undefined
}

export function parseSourceList(input: unknown): SourceList {
  const value = record(input, "sources")

  return {
    apps: list(value.apps).flatMap((item) => {
      const app = record(item, "app")

      if (typeof app.bundleId !== "string" || typeof app.name !== "string") return []

      return [
        {
          bundleId: app.bundleId,
          name: app.name,
          icon: typeof app.icon === "string" ? app.icon : null,
          windows: typeof app.windows === "number" ? app.windows : 0,
        },
      ]
    }),
    windows: list(value.windows).flatMap((item) => {
      const window = record(item, "window")

      if (typeof window.id !== "number") return []

      return [
        {
          id: window.id,
          title: typeof window.title === "string" ? window.title : "",
          bundleId: typeof window.bundleId === "string" ? window.bundleId : null,
          app: typeof window.app === "string" ? window.app : null,
          width: Number(window.width) || 0,
          height: Number(window.height) || 0,
        },
      ]
    }),
    displays: list(value.displays).flatMap((item) => {
      const display = record(item, "display")

      if (typeof display.id !== "number") return []

      return [
        {
          id: display.id,
          name: typeof display.name === "string" ? display.name : null,
          width: Number(display.width) || 0,
          height: Number(display.height) || 0,
          main: display.main === true,
        },
      ]
    }),
    microphones: list(value.microphones).flatMap((item) => {
      const microphone = record(item, "microphone")

      if (typeof microphone.id !== "string" || typeof microphone.name !== "string") return []

      return [{ id: microphone.id, name: microphone.name, default: microphone.default === true }]
    }),
    permissions: parsePermissions(value.permissions),
  }
}

function helperEvent(value: Record<string, unknown>): HelperEvent | undefined {
  switch (value.event) {
    case "ready":
      return { event: "ready", nativeMicrophone: value.nativeMicrophone === true }
    case "permissions":
      return { event: "permissions", permissions: parsePermissions(value) }
    case "started":
      return { event: "started", startedAt: String(value.startedAt ?? new Date().toISOString()) }
    case "status": {
      const levels = value.levels && typeof value.levels === "object" ? record(value.levels, "levels") : {}
      const files = value.files && typeof value.files === "object" ? record(value.files, "files") : {}

      return {
        event: "status",
        state: value.state === "paused" ? "paused" : "recording",
        elapsed: typeof value.elapsed === "number" ? value.elapsed : 0,
        levels: { system: number(levels.system), mic: number(levels.mic) },
        files: Object.fromEntries(
          TRACKS.flatMap((name) => (typeof files[name] === "number" ? [[name, files[name]]] : [])),
        ),
      }
    }

    case "stopped":
      return {
        event: "stopped",
        summary: {
          startedAt: String(value.startedAt ?? ""),
          endedAt: String(value.endedAt ?? new Date().toISOString()),
          duration: typeof value.duration === "number" ? value.duration : 0,
          tracks: list(value.tracks).flatMap((item) => {
            const track = record(item, "track")
            const name = TRACKS.find((candidate) => candidate === track.name)

            if (!name) return []

            return [
              {
                name,
                bytes: Number(track.bytes) || 0,
                status: String(track.status ?? ""),
                startOffset: number(track.startOffset) ?? null,
              },
            ]
          }),
        },
      }
    case "error":
      return {
        event: "error",
        code: String(value.code ?? "helper-error"),
        message: String(value.message ?? ""),
        fatal: value.fatal === true,
      }
    case "app-launched":
    case "app-terminated":
      if (typeof value.bundleId !== "string") return undefined

      return { event: value.event, bundleId: value.bundleId, name: typeof value.name === "string" ? value.name : null }
    default:
      return undefined
  }
}

export function parsePermissions(value: unknown): PermissionState {
  const state = value && typeof value === "object" ? record(value, "permissions") : {}

  return {
    screen: state.screen === "granted" ? "granted" : "missing",
    microphone:
      state.microphone === "granted" ? "granted" : state.microphone === "undetermined" ? "undetermined" : "denied",
  }
}

function json(line: string) {
  try {
    const value: unknown = JSON.parse(line)

    return value && typeof value === "object" && !Array.isArray(value) ? record(value, "line") : undefined
  } catch {
    return undefined
  }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function bundleID(value: unknown) {
  const bundle = text(value, "source.bundleId", 255)

  if (!/^[A-Za-z0-9._-]+$/.test(bundle)) throw new RecorderInputError("source.bundleId must be a bundle identifier")

  return bundle
}

function identifier(value: unknown, name: string) {
  const id = finite(value, name)

  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) throw new RecorderInputError(`${name} must be a whole number`)

  return id
}
