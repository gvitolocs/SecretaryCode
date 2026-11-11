import { app, Notification, shell } from "electron"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import copy from "../../../renderer/secretary-recorder/en.json"
import { reportRecorderFailure } from "../diagnostics"
import { secretaryToken } from "../index"
import { SECRETARY_CLIENT } from "../secretary-client"
import { currentEvent, parseEvents, type CalendarEvent } from "./calendar"
import { HelperError, RecorderHelper } from "./helper"
import { RecorderInputError } from "./input"
import { RECORDINGS_FOLDER, readManifest, retentionExpired, writeManifest, type Manifest } from "./manifest"
import { isMeetingApp, isMeetingWindow, meetingRank, rankApps, rankWindows } from "./meetings"
import {
  TRACKS,
  parsePermissions,
  parseSourceList,
  type CaptureSource,
  type HelperEvent,
  type PermissionState,
  type SourceList,
  type StopSummary,
} from "./protocol"
import { beginRecording, captureRecording, finishRecording } from "./session"
import { DEFAULT_SETTINGS, parseSettings, type RecorderSettings } from "./settings"
import { IDLE, reduce, type ActiveRecording, type RecorderEvent, type RecorderRequest } from "./state"
import { SECRETARY_ORIGIN, UploadError, fetchMeeting, uploadRecording } from "./uploader"

/** An error the Record sheet shows through its copy key. */
export class RecorderFailure extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "RecorderFailure"
  }
}

export type RecordingView = {
  id: string
  title: string
  startedAt: string
  endedAt: string | null
  duration: number | null
  source: string | null
  status: Manifest["upload"]["status"]
  error: string | null
  progress: number | null
  brief: string | null
  hasTranscript: boolean
  localDeleted: boolean
  bytes: number
}

export type RecorderSnapshot = {
  available: boolean
  active: ActiveRecording
  settings: RecorderSettings
  permissions: PermissionState | null
  nativeMicrophone: boolean
  calendar: { id: string; title: string } | null
  preferredSource: CaptureSource | null
  recordings: RecordingView[]
}

const POLL_MS = 15_000

const SUGGEST_MS = 60_000

const SWEEP_MS = 6 * 3_600_000

const CALENDAR_TTL_MS = 5 * 60_000

/** A source list this fresh is shown as-is; the sheet's own refresh replaces it soon after. */
const SOURCES_TTL_MS = 5_000

/**
 * The recorder's main-process state: one active recording, the recordings on disk, their uploads,
 * and meeting suggestions. Everything the sheet and the tray show comes from `snapshot()`.
 */
export class RecorderService {
  private active: ActiveRecording = IDLE
  private settings: RecorderSettings = DEFAULT_SETTINGS
  private permissions: PermissionState | null = null
  private nativeMicrophone = false
  private recordings = new Map<string, { directory: string; manifest: Manifest }>()
  private progress = new Map<string, number>()
  private listeners = new Set<() => void>()
  private helper: RecorderHelper | undefined
  private queue: string[] = []
  private uploading = false
  private uploads = new AbortController()
  private calendar: { events: CalendarEvent[]; fetchedAt: number } | undefined
  private suggested = new Set<string>()
  private preferredSource: CaptureSource | null = null
  private helperRestarts = 0
  private quitting = false
  private emitTimer: ReturnType<typeof setTimeout> | undefined
  private sourceList: { list: Promise<SourceList>; fetchedAt: number } | undefined

  constructor(private readonly openSheet: () => void) {}

  readonly available = process.platform === "darwin" && existsSync(helperPath())

  async start() {
    this.settings = await readSettingsFile()
    await this.scan()
    void this.sweep()
    setInterval(() => void this.poll(), POLL_MS).unref()
    setInterval(() => void this.sweep(), SWEEP_MS).unref()
    setInterval(() => void this.suggest(), SUGGEST_MS).unref()

    if (this.available) this.launchHelper()
    app.on("before-quit", (event) => this.beforeQuit(event))
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  get phase() {
    return this.active.phase
  }

  get recording() {
    return this.active
  }

  get uploadsInFlight() {
    return this.progress.size
  }

  snapshot(): RecorderSnapshot {
    const event = this.calendar ? currentEvent(this.calendar.events) : undefined

    return {
      available: this.available,
      active: this.active,
      settings: this.settings,
      permissions: this.permissions,
      nativeMicrophone: this.nativeMicrophone,
      calendar: event ? { id: event.id, title: event.title } : null,
      preferredSource: this.preferredSource,
      recordings: [...this.recordings.entries()]
        .map(([id, entry]) => view(id, entry.manifest, this.progress.get(id)))
        .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 100),
    }
  }

  /** Runs a request the sheet sent, already validated and allowed for the current phase. */
  async perform(request: RecorderRequest): Promise<unknown> {
    switch (request.action) {
      case "snapshot":
        // The sheet just opened: wake ScreenCaptureKit now, so Record does not pay for it later.
        this.warm()
        void this.refreshCalendar()
        void this.helperRequest("permissions").then((value) => {
          if (value) this.permissions = parsePermissions(value)
          this.emit()
        })

        return this.snapshot()
      case "sources":
        return this.sources()
      case "start":
        return this.record(request.source, request.title, request.calendarEventId)
      case "pause":
      case "resume":
        await this.requireHelper().request(request.action)

        return this.snapshot()
      case "stop":
        return this.stop()
      case "saveSettings":
        this.settings = parseSettings(request.settings, this.settings)
        await writeSettingsFile(this.settings)
        this.emit()
        void this.sweep()

        return this.settings
      case "requestPermission":
        await this.requireHelper().request("request-permission", { permission: request.permission }, 120_000)

        return this.snapshot()
      case "openPrivacySettings":
        await shell.openExternal(
          `x-apple.systempreferences:com.apple.preference.security?${request.permission === "screen" ? "Privacy_ScreenCapture" : "Privacy_Microphone"}`,
        )

        return true
      case "openFolder": {
        const directory = request.id ? this.entry(request.id).directory : recordingsRoot()
        await mkdir(directory, { recursive: true })
        await shell.openPath(directory)

        return true
      }

      case "openTranscript": {
        const upload = this.entry(request.id).manifest.upload

        if (upload.transcript_url) {
          await shell.openExternal(upload.transcript_url)

          return { opened: true, text: null }
        }

        return { opened: false, text: upload.transcript }
      }

      case "retryUpload": {
        const entry = this.entry(request.id)

        if (entry.manifest.upload.status !== "failed") return this.snapshot()
        await this.save(request.id, {
          ...entry.manifest,
          upload: {
            ...entry.manifest.upload,
            status: entry.manifest.upload.completed_at ? "processing" : "pending",
            error: null,
          },
        })

        if (entry.manifest.upload.completed_at) void this.poll()
        else this.enqueue(request.id)

        return this.snapshot()
      }

      case "close":
        return true
    }
  }

  /** Opens the sheet with a source chosen elsewhere (a suggestion), never starting a recording. */
  prefer(source: CaptureSource) {
    this.preferredSource = source
    this.emit()
  }

  async stop() {
    this.transition({ type: "stop" })
    // The helper's `stopped` event, not this reply, finishes the recording.
    await this.requireHelper()
      .request("stop", {}, 120_000)
      .catch(() => {
        // A helper that cannot stop is ended; its exit finalizes whatever it wrote.
        if (this.active.phase === "stopping") this.helper?.close()
      })

    return this.snapshot()
  }

  async pauseOrResume() {
    if (this.active.phase === "recording") await this.perform({ action: "pause" })
    else if (this.active.phase === "paused") await this.perform({ action: "resume" })
  }

  /**
   * Keeps the helper running and ScreenCaptureKit attached while the sheet is open. The first
   * shareable-content query of a process takes seconds; paying it here keeps it out of Record.
   */
  private warm() {
    if (!this.available || !this.helper || this.active.phase !== "idle") return
    if (!this.helper.running) this.helper.start()
    void this.sourceListing().catch(() => undefined)
  }

  /** One `list-sources` at a time, reused for a few seconds: the sheet asks right after `snapshot`. */
  private sourceListing() {
    if (this.sourceList && Date.now() - this.sourceList.fetchedAt < SOURCES_TTL_MS) return this.sourceList.list
    const list = this.requireHelper()
      .request("list-sources", {}, 30_000)
      .then(parseSourceList)
    this.sourceList = { list, fetchedAt: Date.now() }
    list.catch(() => {
      if (this.sourceList?.list === list) this.sourceList = undefined
    })

    return list
  }

  private async sources() {
    const list = await this.sourceListing()
    this.permissions = list.permissions
    this.emit()

    return {
      ...list,
      apps: rankApps(list.apps).map((item) => ({ ...item, meeting: meetingRank(item.bundleId) === 0 })),
      windows: rankWindows(list.windows).map((item) => ({ ...item, meeting: isMeetingWindow(item) })),
    }
  }

  private async record(source: CaptureSource, requestedTitle: string, calendarEventId: string | null) {
    const helper = this.requireHelper()
    const title = requestedTitle || this.calendarTitle(calendarEventId) || source.name || copy.untitled
    const draft = await beginRecording({ root: recordingsRoot(), title, source, calendarEventId, settings: this.settings })
    this.recordings.set(draft.id, { directory: draft.directory, manifest: draft.manifest })
    this.preferredSource = null
    this.transition({ type: "start", id: draft.id, directory: draft.directory, title, source })

    try {
      // `started_at` becomes the moment the helper began capturing, not the click.
      const manifest = await captureRecording({ ...draft, helper, source, settings: this.settings })
      this.recordings.set(draft.id, { directory: draft.directory, manifest })
      this.emit()
    } catch (error) {
      const code = error instanceof HelperError ? error.code : "capture-failed"
      const message = error instanceof Error ? error.message : code
      this.recordings.delete(draft.id)
      reportRecorderFailure(code, message, { phase: "starting", source: source.kind })
      this.transition({ type: "start-failed", code, message })
    }

    return this.snapshot()
  }

  private launchHelper() {
    const helper = new RecorderHelper(
      helperPath(),
      (event) => this.helperEvent(event),
      () => this.helperExited(),
    )

    this.helper = helper
    helper.start()
  }

  private helperEvent(event: HelperEvent) {
    switch (event.event) {
      case "ready":
        this.nativeMicrophone = event.nativeMicrophone
        this.helperRestarts = 0
        break
      case "permissions":
        this.permissions = event.permissions
        break
      case "stopped": {
        const directory = this.active.directory

        if (directory) void this.finalize(directory, event.summary)
        break
      }

      case "app-launched":
        if (isMeetingApp(event.bundleId)) void this.suggest({ bundleId: event.bundleId, name: event.name })

        return
      case "app-terminated":
        return
    }

    this.transition({ type: "helper", event })
  }

  private helperExited() {
    const directory = this.active.directory
    const recording = this.active.phase !== "idle"
    const phase = this.active.phase
    this.transition({ type: "helper-exited" })

    if (recording) {
      reportRecorderFailure("helper-exited", "The recorder stopped unexpectedly", {
        phase,
        restarts: this.helperRestarts,
      })
    }
    if (recording && directory) void this.finalize(directory)

    if (this.quitting || this.helperRestarts >= 3) return
    // Keep the helper around for meeting suggestions; back off if it keeps failing.
    this.helperRestarts++
    setTimeout(() => {
      if (!this.quitting && !this.helper?.running) this.helper?.start()
    }, 5_000 * this.helperRestarts).unref()
  }

  private transition(event: RecorderEvent) {
    this.active = reduce(this.active, event)

    // Status lines arrive twice a second; everything else is worth showing at once.
    if (event.type === "helper" && event.event.event === "status") this.emitSoon()
    else this.emit()
  }

  /** Writes the final manifest: the tracks that exist on disk with their sha256, then queues the upload. */
  private async finalize(directory: string, summary?: StopSummary) {
    const found = [...this.recordings.entries()].find(([, entry]) => entry.directory === directory)
    const manifest = found?.[1].manifest ?? (await readManifest(directory).catch(() => undefined))

    if (!manifest) return

    const finished = await finishRecording({ directory, manifest, summary })
    await this.save(manifest.id, finished, directory)

    if (finished.tracks.length) this.enqueue(manifest.id)
  }

  private enqueue(id: string) {
    if (!this.queue.includes(id)) this.queue.push(id)
    void this.drain()
  }

  private async drain() {
    if (this.uploading) return
    this.uploading = true

    for (let id = this.queue.shift(); id; id = this.queue.shift()) await this.upload(id)
    this.uploading = false
  }

  private async upload(id: string) {
    const entry = this.recordings.get(id)

    if (!entry) return
    this.progress.set(id, 0)
    await this.save(id, { ...entry.manifest, upload: { ...entry.manifest.upload, status: "uploading", error: null } })

    try {
      await uploadRecording(entry.directory, this.entry(id).manifest, {
        baseURL: SECRETARY_ORIGIN,
        token: secretaryToken,
        signal: this.uploads.signal,
        onProgress: (sent, total) => {
          this.progress.set(id, total ? sent / total : 1)
          this.emitSoon()
        },
        save: (manifest) => this.save(id, manifest),
      })
      this.progress.delete(id)
      this.emit()
      void this.poll()
    } catch (error) {
      this.progress.delete(id)

      if (error instanceof UploadError && error.code === "aborted") return
      const manifest = this.entry(id).manifest
      await this.save(id, {
        ...manifest,
        upload: {
          ...manifest.upload,
          status: "failed",
          error: error instanceof UploadError ? error.code : "uploadFailed",
        },
      })
    }
  }

  /** Asks the server about recordings Lucina is processing and stores the brief once it is ready. */
  private async poll() {
    for (const [id, entry] of this.recordings) {
      const upload = entry.manifest.upload

      if (upload.status !== "processing" || !upload.meeting_id) continue
      const status = await fetchMeeting(
        { baseURL: SECRETARY_ORIGIN, token: secretaryToken, signal: this.uploads.signal },
        upload.meeting_id,
      ).catch(() => undefined)

      if (!status || status.status === "uploading" || status.status === "processing") continue
      const current = this.entry(id).manifest
      await this.save(id, {
        ...current,
        upload: {
          ...current.upload,
          status: status.status,
          brief: status.brief,
          transcript: status.transcript,
          transcript_url: status.transcript_url,
          error: status.status === "failed" ? "processingFailed" : null,
          updated_at: new Date().toISOString(),
        },
      })

      if (status.status === "ready" && Notification.isSupported()) {
        const notification = new Notification({ title: copy.briefReadyTitle, body: current.title })
        notification.on("click", () => this.openSheet())
        notification.show()
      }
    }

    await this.sweep()
  }

  /** Removes media files once the server confirmed them and the owner's retention period passed. */
  private async sweep() {
    for (const [id, entry] of this.recordings) {
      if (!retentionExpired(entry.manifest, this.settings.keepDays)) continue
      await Promise.all(TRACKS.map((name) => rm(path.join(entry.directory, name), { force: true })))
      await this.save(id, { ...entry.manifest, local_deleted_at: new Date().toISOString() })
    }
  }

  /** Loads recordings from disk, recovers ones interrupted by a crash and resumes their uploads. */
  private async scan() {
    const root = recordingsRoot()
    const names = await readdir(root).catch(() => [])

    for (const name of names) {
      const directory = path.join(root, name)
      const manifest = await readManifest(directory).catch(() => undefined)

      if (!manifest) continue
      this.recordings.set(manifest.id, { directory, manifest })

      if (manifest.upload.status === "recording") void this.finalize(directory)

      if (manifest.upload.status === "pending" || manifest.upload.status === "uploading") this.enqueue(manifest.id)
    }

    void this.poll()
  }

  /** Suggests (never starts) a recording when a meeting app is open during a calendar event. */
  private async suggest(launched?: { bundleId: string; name: string | null }) {
    if (!this.available || !this.settings.suggest || this.active.phase !== "idle") return
    const event = await this.refreshCalendar()

    if (!event || this.suggested.has(event.id)) return
    const running = launched ? [launched] : await this.runningMeetingApps()
    const meeting = running[0]

    if (!meeting || !Notification.isSupported()) return
    this.suggested.add(event.id)
    const appName = meeting.name ?? meeting.bundleId

    const notification = new Notification({
      title: copy.suggestTitle,
      body: copy.suggestBody.replace("{title}", event.title || copy.untitled).replace("{app}", appName),
      actions: [{ type: "button", text: copy.suggestAction }],
    })

    const open = () => {
      this.prefer({ kind: "app", bundleId: meeting.bundleId, name: appName })
      this.openSheet()
    }

    notification.on("click", open)
    notification.on("action", open)
    notification.show()
  }

  private async runningMeetingApps() {
    const result = await this.helperRequest("running-apps")
    const apps =
      result && typeof result === "object" && "apps" in result ? parseSourceList({ apps: result.apps }).apps : []

    return apps
      .filter((item) => isMeetingApp(item.bundleId))
      .map((item) => ({ bundleId: item.bundleId, name: item.name }))
  }

  /** `GET /v1/calendar/events` for today, cached for five minutes. */
  private async refreshCalendar() {
    if (this.calendar && Date.now() - this.calendar.fetchedAt < CALENDAR_TTL_MS)
      return currentEvent(this.calendar.events)
    const token = await secretaryToken()

    if (!token) return undefined
    const query = new URLSearchParams({
      from: new Date(Date.now() - 12 * 3_600_000).toISOString(),
      to: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    })

    const response = await fetch(`${SECRETARY_ORIGIN}/v1/calendar/events?${query}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Secretary-Client": SECRETARY_CLIENT },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)

    const events = response?.ok ? await response.json().then(parseEvents, () => undefined) : undefined
    // On failure keep the last answer and try again in a minute.
    this.calendar = events
      ? { events, fetchedAt: Date.now() }
      : { events: this.calendar?.events ?? [], fetchedAt: Date.now() - CALENDAR_TTL_MS + 60_000 }
    this.emit()

    return currentEvent(this.calendar.events)
  }

  private calendarTitle(id: string | null) {
    return id ? this.calendar?.events.find((event) => event.id === id)?.title : undefined
  }

  private beforeQuit(event: Electron.Event) {
    if (this.quitting) return
    this.quitting = true
    this.uploads.abort()

    if (this.active.phase === "idle") return
    // Finish the files before quitting; the upload resumes on the next launch.
    event.preventDefault()
    const done = () => app.quit()
    const timer = setTimeout(done, 20_000)

    const unsubscribe = this.subscribe(() => {
      if (this.active.phase !== "idle") return
      clearTimeout(timer)
      unsubscribe()
      // Give finalize a moment to write meeting.json; a crash-recovery scan covers anything later.
      setTimeout(done, 500)
    })

    if (this.active.phase === "recording" || this.active.phase === "paused") void this.stop()
  }

  private requireHelper() {
    if (!this.available || !this.helper) throw new RecorderFailure("helperUnavailable")

    return this.helper
  }

  private helperRequest(command: string) {
    if (!this.available || !this.helper) return Promise.resolve(undefined)

    return this.helper.request(command).catch(() => undefined)
  }

  private entry(id: string) {
    const entry = this.recordings.get(id)

    if (!entry) throw new RecorderInputError("Unknown recording")

    return entry
  }

  private async save(id: string, manifest: Manifest, directory = this.recordings.get(id)?.directory) {
    if (!directory) return
    this.recordings.set(id, { directory, manifest })
    await writeManifest(directory, manifest)
    this.emit()
  }

  private emitSoon() {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined
      this.emit()
    }, 250)
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }
}

function view(id: string, manifest: Manifest, progress: number | undefined): RecordingView {
  return {
    id,
    title: manifest.title,
    startedAt: manifest.started_at,
    endedAt: manifest.ended_at,
    duration: manifest.duration_seconds,
    source: manifest.source_app.name,
    status: manifest.upload.status,
    error: manifest.upload.error,
    progress: progress ?? null,
    brief: manifest.upload.brief,
    hasTranscript: !!(manifest.upload.transcript || manifest.upload.transcript_url),
    localDeleted: !!manifest.local_deleted_at,
    bytes: manifest.tracks.reduce((sum, track) => sum + track.bytes, 0),
  }
}

export function recordingsRoot() {
  return path.join(app.getPath("videos"), RECORDINGS_FOLDER)
}

/** Packaged: Contents/Resources/secretary-recorder. Development: copied there by scripts/build-recorder.ts. */
function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "secretary-recorder")
    : path.join(app.getAppPath(), "resources", "secretary-recorder")
}

function settingsFile() {
  return path.join(app.getPath("userData"), "secretary-recorder.json")
}

async function readSettingsFile() {
  const stored = await readFile(settingsFile(), "utf8").catch(() => undefined)

  if (!stored) return DEFAULT_SETTINGS

  try {
    return parseSettings(JSON.parse(stored))
  } catch {
    return DEFAULT_SETTINGS
  }
}

async function writeSettingsFile(settings: RecorderSettings) {
  await mkdir(app.getPath("userData"), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 })
}
