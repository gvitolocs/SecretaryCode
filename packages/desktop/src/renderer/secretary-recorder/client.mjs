const $ = (id) => document.getElementById(id)

const bridge = window.electron.recorder

const standalone = location.hash === "#window"

const view = {
  snapshot: null,
  sources: null,
  loadingSources: false,
  kind: "apps",
  query: "",
  selected: null,
  title: { value: "", edited: false, calendarId: null },
  tab: "record",
  lastError: null,
  preferredKey: null,
}

let copy = {}

const t = (key, values = {}) =>
  Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    copy[key] ?? copy.serverError ?? key,
  )

const element = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag)

  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue

    if (name === "class") node.className = value
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value)
    else node.setAttribute(name, value === true ? "" : value)
  }

  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false))

  return node
}

const clock = (seconds) => {
  const total = Math.max(0, Math.floor(seconds || 0))
  const pad = (value) => String(value).padStart(2, "0")
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)

  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`
}

const size = (bytes) =>
  new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: bytes >= 1e9 ? "gigabyte" : "megabyte",
    maximumFractionDigits: 1,
  }).format(bytes / (bytes >= 1e9 ? 1e9 : 1e6))

const date = (iso) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))

const icon = (base64) => (base64 ? `data:image/png;base64,${base64}` : null)

async function call(action, input) {
  const result = await bridge.request(action, input)

  if (!result.ok) throw new Error(result.error)

  return result.data
}

function notice(code) {
  $("notice").textContent = t(code)
  $("notice").hidden = !code
}

function run(action, input) {
  return call(action, input).catch((error) => {
    notice(error.message)

    return undefined
  })
}

function close() {
  if (standalone) window.close()
  else void call("close")
}

// ---- State from the main process -------------------------------------------------------------

function render(snapshot) {
  if (!snapshot) return
  view.snapshot = snapshot
  const active = snapshot.active
  const busy = active.phase !== "idle"

  const error = active.error ? JSON.stringify(active.error) : null

  if (error && error !== view.lastError) notice(active.error.code)
  view.lastError = error

  $("header-dot").hidden = !(active.phase === "recording" || active.phase === "starting")
  $("unavailable").hidden = snapshot.available
  const permissions = snapshot.permissions
  $("permission-screen").hidden = !snapshot.available || !permissions || permissions.screen === "granted"
  $("permission-mic").hidden =
    !snapshot.available || !permissions || !snapshot.settings.microphoneEnabled || permissions.microphone === "granted"
  $("mic-allow").hidden = permissions?.microphone !== "undetermined"

  preferSource(snapshot.preferredSource)
  prefillTitle(snapshot.calendar)

  $("setup").hidden = busy
  $("live").hidden = !busy

  if (busy) renderLive(active, snapshot)
  renderControls(active, snapshot)
  renderChips(snapshot)
  renderLatest(snapshot.recordings)
  renderRecordings(snapshot.recordings)
  renderSettings(snapshot)
}

function renderLive(active, snapshot) {
  const source = active.source
  const app = source && view.sources?.apps.find((item) => item.bundleId === (source.bundleId ?? null))
  $("live-icon").hidden = !app?.icon

  if (app?.icon) $("live-icon").src = icon(app.icon)
  $("live-state").textContent = active.phase === "paused" ? t("paused") : t("recording")
  $("live-state").classList.toggle("paused", active.phase === "paused")
  $("live-title").textContent = active.title
  $("live-name").textContent = source?.kind === "window" ? source.title || source.name || "" : source?.name || ""
  const meter = (db) => `${Math.max(0, Math.min(100, (((db ?? -80) + 60) / 60) * 100))}%`
  $("meter-system").style.width = meter(active.levels.system)
  $("meter-mic").style.width = meter(active.levels.mic)
  $("meter-mic-row").hidden = !snapshot.settings.microphoneEnabled
  $("files").replaceChildren(
    ...Object.entries(active.files).map(([name, bytes]) => element("span", {}, `${name} ${size(bytes)}`)),
  )
}

function renderControls(active, snapshot) {
  const recording = active.phase === "recording" || active.phase === "paused"
  const record = $("record")
  record.classList.toggle("stop", recording || active.phase === "stopping")
  const label =
    active.phase === "starting"
      ? t("starting")
      : active.phase === "stopping"
        ? t("stopping")
        : recording
          ? t("stop")
          : t("record")
  record.setAttribute("aria-label", label)
  record.title = label
  // A missing Screen Recording grant does not disable Record: starting is what shows the macOS prompt.
  record.disabled =
    !snapshot.available ||
    active.phase === "starting" ||
    active.phase === "stopping" ||
    (active.phase === "idle" && !view.selected)
  $("record-label").textContent = active.phase === "idle" && !view.selected ? t("chooseSource") : label
  $("pause").hidden = !recording
  $("pause").textContent = active.phase === "paused" ? t("resume") : t("pause")
  $("timer").textContent = clock(active.elapsed)
  $("timer").hidden = active.phase === "idle"
}

function renderChips(snapshot) {
  const settings = snapshot.settings
  const microphone = settings.microphoneEnabled
    ? (view.sources?.microphones.find((item) => item.id === settings.microphone)?.name ?? t("defaultMicrophone"))
    : t("microphoneOff")

  const chips = [
    settings.video
      ? `${settings.resolution === "native" ? t("resolutionNative") : settings.resolution} · ${settings.fps} fps · ${settings.codec === "hevc" ? "HEVC" : "H.264"}`
      : t("audioOnly"),
    settings.systemAudio === "system" ? t("allSystemAudio") : t("appAudio"),
    microphone,
    t("separateTracks"),
  ]

  $("chips").replaceChildren(
    ...chips.map((text) => element("span", { class: "chip" }, text)),
    element("button", { class: "chip", onclick: () => selectTab("settings") }, t("changeSettings")),
  )
}

function preferSource(source) {
  const key = source ? JSON.stringify(source) : null

  if (key === view.preferredKey) return
  view.preferredKey = key

  if (!source) return
  view.selected = source
  view.kind = source.kind === "display" ? "displays" : source.kind === "window" ? "windows" : "apps"
  selectTab("record")
  renderSources()
}

function prefillTitle(calendar) {
  if (view.title.edited) return
  const title = calendar?.title ?? ""
  view.title = { value: title, edited: false, calendarId: calendar?.id ?? null }

  if (document.activeElement !== $("title")) $("title").value = title
  $("title-hint").hidden = !calendar?.title
}

// ---- Sources ----------------------------------------------------------------------------------

async function loadSources() {
  if (!view.snapshot?.available || view.loadingSources) return
  view.loadingSources = true
  renderSources()
  const sources = await run("sources")
  view.loadingSources = false

  if (sources) {
    view.sources = sources

    // Meeting apps are listed first; preselect the first one so a meeting is one click away.
    if (!view.selected) {
      const meeting = sources.apps.find((item) => item.meeting)

      if (meeting) view.selected = { kind: "app", bundleId: meeting.bundleId, name: meeting.name }
    }

    renderMicrophones(sources.microphones)
  }

  renderSources()
  render(view.snapshot)
}

function sourceItems() {
  const sources = view.sources

  if (!sources) return []
  const iconFor = (bundleId) => sources.apps.find((item) => item.bundleId === bundleId)?.icon

  if (view.kind === "apps")
    return sources.apps.map((app) => ({
      source: { kind: "app", bundleId: app.bundleId, name: app.name },
      title: app.name,
      detail: app.bundleId,
      icon: app.icon,
      meeting: app.meeting,
    }))

  if (view.kind === "windows")
    return sources.windows.map((window) => ({
      source: {
        kind: "window",
        windowId: window.id,
        title: window.title || null,
        bundleId: window.bundleId,
        name: window.app,
      },
      title: window.title || t("untitledWindow"),
      detail: window.app ?? "",
      icon: iconFor(window.bundleId),
      meeting: window.meeting,
    }))

  return sources.displays.map((display) => ({
    source: { kind: "display", displayId: display.id, name: display.name },
    title: display.name || t("display"),
    detail: `${display.width} × ${display.height}${display.main ? ` · ${t("mainDisplay")}` : ""}`,
    icon: null,
    glyph: "▭",
    meeting: false,
  }))
}

function sameSource(a, b) {
  if (!a || !b || a.kind !== b.kind) return false

  if (a.kind === "app") return a.bundleId === b.bundleId

  if (a.kind === "window") return a.windowId === b.windowId

  return a.displayId === b.displayId
}

function renderSources() {
  for (const button of document.querySelectorAll("[data-kind]"))
    button.setAttribute("aria-selected", String(button.dataset.kind === view.kind))
  const list = $("sources")

  if (!view.sources) {
    list.replaceChildren(
      element(
        "li",
        { class: "empty" },
        view.loadingSources ? t("loadingSources") : view.snapshot?.available === false ? t("helperUnavailable") : "",
      ),
    )

    return
  }

  const query = view.query.trim().toLocaleLowerCase()
  const items = sourceItems().filter(
    (item) => !query || `${item.title} ${item.detail}`.toLocaleLowerCase().includes(query),
  )

  if (!items.length) {
    list.replaceChildren(element("li", { class: "empty" }, query ? t("noMatches") : t("noSources")))

    return
  }

  list.replaceChildren(
    ...items.map((item) =>
      element(
        "li",
        {},
        element(
          "button",
          {
            class: "source",
            "aria-pressed": String(sameSource(item.source, view.selected)),
            onclick: () => {
              view.selected = item.source
              renderSources()
              render(view.snapshot)
            },
            ondblclick: () => startRecording(),
          },
          item.icon
            ? element("img", { src: icon(item.icon), alt: "" })
            : element("span", { class: "glyph", "aria-hidden": "true" }, item.glyph ?? "▢"),
          element("span", { class: "label" }, element("strong", {}, item.title), element("small", {}, item.detail)),
          item.meeting ? element("span", { class: "badge" }, t("meetingBadge")) : null,
        ),
      ),
    ),
  )
}

function renderMicrophones(microphones) {
  const select = $("microphones")
  const selected = view.snapshot?.settings.microphone ?? ""
  select.replaceChildren(
    element("option", { value: "" }, t("defaultMicrophone")),
    ...microphones.map((microphone) => element("option", { value: microphone.id }, microphone.name)),
  )
  select.value = selected
}

// ---- Recordings -------------------------------------------------------------------------------

function card(recording, compact) {
  const status = recording.status

  const line =
    status === "uploading"
      ? `${t("statusUploading")} ${Math.round((recording.progress ?? 0) * 100)}%`
      : status === "pending"
        ? t("statusPending")
        : status === "processing"
          ? t("statusProcessing")
          : status === "ready"
            ? t("statusReady")
            : status === "failed"
              ? t(recording.error ?? "uploadFailed")
              : t("statusRecording")

  const actions = [
    recording.hasTranscript
      ? element("button", { class: "link", onclick: () => openTranscript(recording.id) }, t("openTranscript"))
      : null,
    recording.status === "failed"
      ? element("button", { class: "link", onclick: () => void run("retryUpload", recording.id) }, t("retry"))
      : null,
    element("button", { class: "link", onclick: () => void run("openFolder", recording.id) }, t("showInFinder")),
  ]

  return element(
    compact ? "li" : "div",
    { class: "card" },
    element(
      "div",
      { class: "card-head" },
      element("strong", {}, recording.title),
      element("small", {}, date(recording.startedAt)),
    ),
    element(
      "div",
      { class: "card-meta" },
      [
        recording.source,
        recording.duration ? clock(recording.duration) : null,
        recording.bytes ? size(recording.bytes) : null,
        recording.localDeleted ? t("localDeleted") : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    element(
      "div",
      { class: `card-status ${status}` },
      status === "processing" || status === "uploading"
        ? element("span", { class: "spinner", "aria-hidden": "true" })
        : null,
      line,
    ),
    status === "uploading" ? progressBar(recording.progress ?? 0) : null,
    recording.brief ? element("p", { class: "brief" }, recording.brief) : null,
    status === "recording" ? null : element("div", { class: "card-actions" }, ...actions),
  )
}

// The page's CSP forbids style attributes, so the width is set through the CSSOM.
function progressBar(fraction) {
  const fill = element("i")
  fill.style.width = `${Math.round(fraction * 100)}%`

  return element("div", { class: "progress" }, fill)
}

function renderLatest(recordings) {
  const latest = recordings.find((recording) => recording.status !== "recording")
  $("latest").hidden = !latest || view.snapshot.active.phase !== "idle"

  if (latest) $("latest-card").replaceChildren(card(latest, false))
}

function renderRecordings(recordings) {
  $("recordings-empty").hidden = recordings.length > 0
  $("recordings").replaceChildren(...recordings.map((recording) => card(recording, true)))
}

async function openTranscript(id) {
  const result = await run("openTranscript", id)

  if (!result || result.opened) return
  selectTab("recordings")
  $("transcript").textContent = result.text ?? ""
  $("transcript").hidden = !result.text
  $("transcript").focus()
}

// ---- Settings ---------------------------------------------------------------------------------

function renderSettings(snapshot) {
  const locked = snapshot.active.phase !== "idle"
  $("settings-locked").hidden = !locked

  for (const control of document.querySelectorAll("[data-setting]")) {
    control.disabled = locked

    if (document.activeElement === control) continue
    const value = snapshot.settings[control.dataset.setting]

    if (control.type === "checkbox") control.checked = value
    else control.value = value === null ? "" : String(value)
  }

  for (const row of document.querySelectorAll("[data-video-only]")) row.hidden = !snapshot.settings.video
}

async function saveSetting(control) {
  const name = control.dataset.setting
  const value =
    control.type === "checkbox"
      ? control.checked
      : "number" in control.dataset
        ? Number(control.value)
        : name === "microphone" && !control.value
          ? null
          : control.value
  const saved = await run("saveSettings", { [name]: value })

  if (!saved) render(view.snapshot)
}

// ---- Actions ----------------------------------------------------------------------------------

async function startRecording() {
  const active = view.snapshot?.active

  if (!active) return
  notice(null)

  if (active.phase === "recording" || active.phase === "paused") return void run("stop")

  if (active.phase !== "idle") return

  if (!view.selected) return notice("chooseSource")
  const title = $("title").value.trim()
  // Only file the recording under the calendar event when its title still names that event.
  const calendarEventId = view.title.calendarId && !view.title.edited ? view.title.calendarId : null
  const started = await run("start", { source: view.selected, title, calendarEventId })
  // The next recording starts from the calendar again.
  if (started) view.title.edited = false
}

function selectTab(tab) {
  view.tab = tab

  for (const button of document.querySelectorAll("[data-tab]"))
    button.setAttribute("aria-selected", String(button.dataset.tab === tab))
  $("view-record").hidden = tab !== "record"
  $("view-recordings").hidden = tab !== "recordings"
  $("view-settings").hidden = tab !== "settings"

  if (tab !== "recordings") $("transcript").hidden = true
}

// ---- Startup ----------------------------------------------------------------------------------

copy = await (await fetch("en.json")).json()

for (const node of document.querySelectorAll("[data-copy]")) node.textContent = t(node.dataset.copy)

for (const node of document.querySelectorAll("[data-title]")) {
  node.title = t(node.dataset.title)
  node.setAttribute("aria-label", t(node.dataset.title))
}

for (const node of document.querySelectorAll("[data-placeholder]")) {
  node.placeholder = t(node.dataset.placeholder)
  node.setAttribute("aria-label", t(node.dataset.placeholder))
}

for (const node of document.querySelectorAll("[data-label]")) node.setAttribute("aria-label", t(node.dataset.label))

document.body.classList.toggle("window", standalone)

$("close").addEventListener("click", close)

$("backdrop").addEventListener("click", close)

$("notice").addEventListener("click", () => notice(null))

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented) close()
})

for (const button of document.querySelectorAll("[data-tab]"))
  button.addEventListener("click", () => selectTab(button.dataset.tab))

for (const button of document.querySelectorAll("[data-kind]"))
  button.addEventListener("click", () => {
    view.kind = button.dataset.kind
    renderSources()
  })

for (const button of document.querySelectorAll("[data-permission-open]"))
  button.addEventListener("click", () => void run("openPrivacySettings", button.dataset.permissionOpen))

for (const button of document.querySelectorAll("[data-permission-request]"))
  button.addEventListener("click", async () => {
    render(await run("requestPermission", button.dataset.permissionRequest))
    void loadSources()
  })

for (const control of document.querySelectorAll("[data-setting]"))
  control.addEventListener("change", () => void saveSetting(control))

$("search").addEventListener("input", () => {
  view.query = $("search").value
  renderSources()
})

$("title").addEventListener("input", () => {
  view.title.edited = $("title").value.trim() !== (view.snapshot?.calendar?.title ?? "")
  $("title-hint").hidden = view.title.edited || !view.snapshot?.calendar?.title
})

$("title").addEventListener("keydown", (event) => {
  if (event.key === "Enter") void startRecording()
})

$("record").addEventListener("click", () => void startRecording())

$("pause").addEventListener("click", () => void run(view.snapshot?.active.phase === "paused" ? "resume" : "pause"))

$("open-folder").addEventListener("click", () => void run("openFolder"))

// Sources change while the sheet is open (a meeting app launches); refresh them when it regains focus.
window.addEventListener("focus", () => void loadSources())

bridge.onState(render)

selectTab("record")

render(await run("snapshot"))

renderSources()

void loadSources()
