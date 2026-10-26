import { RecorderInputError, field, record } from "./input"

export const RESOLUTIONS = ["native", "1080p", "720p"] as const

export const FRAME_RATES = [15, 30, 60] as const

export const CODECS = ["hevc", "h264"] as const

export const SYSTEM_AUDIO = ["app", "system"] as const

export type RecorderSettings = {
  video: boolean
  resolution: (typeof RESOLUTIONS)[number]
  fps: (typeof FRAME_RATES)[number]
  codec: (typeof CODECS)[number]
  bitrateKbps: number
  microphoneEnabled: boolean
  /** An AVCaptureDevice unique ID; null follows the macOS default input. */
  microphone: string | null
  systemAudio: (typeof SYSTEM_AUDIO)[number]
  /** Days a server-confirmed recording stays on this Mac. 0 deletes it as soon as the server confirms it. */
  keepDays: number
  /** Offer (never start) a recording when a meeting app opens during a calendar event. */
  suggest: boolean
}

export const DEFAULT_SETTINGS: RecorderSettings = {
  video: true,
  resolution: "1080p",
  fps: 30,
  codec: "hevc",
  bitrateKbps: 6000,
  microphoneEnabled: true,
  microphone: null,
  systemAudio: "app",
  keepDays: 14,
  suggest: true,
}

/** Applies a partial update from the settings page (or a stored file) on top of `base`. */
export function parseSettings(input: unknown, base = DEFAULT_SETTINGS): RecorderSettings {
  const value = record(input, "settings")
  const next = { ...base }

  if (field(value, "video")) next.video = boolean(value.video, "video")

  if (field(value, "resolution")) next.resolution = oneOf(value.resolution, RESOLUTIONS, "resolution")

  if (field(value, "fps")) next.fps = oneOf(value.fps, FRAME_RATES, "fps")

  if (field(value, "codec")) next.codec = oneOf(value.codec, CODECS, "codec")

  if (field(value, "bitrateKbps")) next.bitrateKbps = integer(value.bitrateKbps, "bitrateKbps", 500, 100_000)

  if (field(value, "microphoneEnabled")) next.microphoneEnabled = boolean(value.microphoneEnabled, "microphoneEnabled")

  if (field(value, "microphone")) next.microphone = deviceID(value.microphone)

  if (field(value, "systemAudio")) next.systemAudio = oneOf(value.systemAudio, SYSTEM_AUDIO, "systemAudio")

  if (field(value, "keepDays")) next.keepDays = integer(value.keepDays, "keepDays", 0, 3650)

  if (field(value, "suggest")) next.suggest = boolean(value.suggest, "suggest")

  return next
}

function boolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new RecorderInputError(`${name} must be true or false`)

  return value
}

function integer(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new RecorderInputError(`${name} must be a whole number from ${min} to ${max}`)

  return value
}

function oneOf<const T extends readonly (string | number)[]>(value: unknown, options: T, name: string): T[number] {
  const match = options.find((option) => option === value)

  if (match === undefined) throw new RecorderInputError(`${name} must be one of ${options.join(", ")}`)

  return match
}

function deviceID(value: unknown) {
  if (value === null) return null

  if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f]/.test(value))
    throw new RecorderInputError("microphone must be a device id or null")

  return value
}
