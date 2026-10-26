const $ = id => document.getElementById(id)
const avatar = $("avatar")
const state = { signedIn: false, busy: false, loaded: false, started: false, muted: true, speaking: false, wardrobe: { outfits: [], hairstyles: [], colors: [] }, look: {}, seen: new Set(), sessionId: localStorage.getItem("secretary.sessionId") || `mac_${crypto.randomUUID()}` }
localStorage.setItem("secretary.sessionId", state.sessionId)
const stage = (method, ...args) => avatar.contentWindow?.postMessage({ source: "secretary", method, args }, location.origin)
let copy = {}
const t = key => copy[key] || copy.serverError || key
function notice(key) { $("notice").textContent = t(key); $("notice").hidden = false }
function clearNotice() { $("notice").hidden = true }
$("notice").addEventListener("click", clearNotice)
async function api(action, input) {
  const result = await window.electron.secretary.request(action, input)
  if (!result.ok) {
    if (result.error === "signInRequired") showSignedIn(false)
    throw new Error(result.error)
  }
  return result.data
}
function handleError(error) { notice(error?.message || "serverError") }
function showSignedIn(value) {
  state.signedIn = value
  $("login").hidden = value
  $("companion").hidden = !value
  $("signout").hidden = !value
  $("wardrobe").hidden = true
  if (!value) { stage("stop"); state.started = false }
}
function startStage() {
  if (!state.signedIn || !state.loaded || state.started) return
  state.started = true
  stage("start", { modelUrl: `${location.origin}/v1/assets/lucina.glb`, manifestUrl: `${location.origin}/v1/assets/manifest.json`, assetBase: `${location.origin}/v1/assets/`, framing: "bust", wardrobe: state.wardrobe, look: state.look, muted: state.muted, reducedMotion: matchMedia("(prefers-reduced-motion:reduce)").matches })
}
window.addEventListener("message", event => {
  if (event.origin !== location.origin || event.source !== avatar.contentWindow || event.data?.source !== "lucina-stage") return
  if (event.data.type === "loaded") { state.loaded = true; startStage() }
  if (event.data.type === "ready") { $("stage-status").hidden = true; stage("dress", state.wardrobe, state.look) }
  if (event.data.type === "error") { $("stage-status").textContent = t("stageError"); $("stage-status").hidden = false }
  if (event.data.type === "spoken") { state.speaking = false; if (!state.busy) stage("setState", "idle") }
})
avatar.addEventListener("load", () => stage("ping"))
copy = await (await fetch("en.json")).json()
for (const element of document.querySelectorAll("[data-copy]")) element.textContent = t(element.dataset.copy)
for (const element of document.querySelectorAll("[data-title]")) { element.title = t(element.dataset.title); element.setAttribute("aria-label", t(element.dataset.title)) }
for (const element of document.querySelectorAll("[data-placeholder]")) { element.placeholder = t(element.dataset.placeholder); element.setAttribute("aria-label", t(element.dataset.placeholder)) }
stage("ping")

function message(text, role = "lucina", id) {
  if (!text || (id && state.seen.has(String(id)))) return
  if (id) state.seen.add(String(id))
  $("messages").querySelector(".empty")?.remove()
  const item = document.createElement("div")
  item.className = `message ${role}`
  item.textContent = text
  $("messages").append(item)
  $("messages").scrollTop = $("messages").scrollHeight
  return item
}
async function refresh() {
  const timeline = await api("timeline")
  if (!Array.isArray(timeline?.items)) return
  for (const item of [...timeline.items].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))) {
    if (typeof item.text !== "string" || item.meta?.kind === "device_command") continue
    message(item.text, item.role === "user" ? "user" : "lucina", item.id)
  }
}
function fillOptions(id, values, selected, includeNatural = false) {
  const select = $(id)
  select.replaceChildren()
  if (includeNatural) { const option = document.createElement("option"); option.value = ""; option.textContent = t("natural"); select.append(option) }
  for (const item of values) {
    const option = document.createElement("option")
    option.value = item.id
    option.textContent = typeof item.name === "string" ? item.name : item.name?.en || item.names?.en || item.id
    select.append(option)
  }
  select.value = selected || ""
}
async function signedIn() {
  clearNotice()
  showSignedIn(true)
  const results = await Promise.allSettled([api("wardrobe"), api("avatar"), api("health"), refresh()])
  if (!state.signedIn) return
  if (results[0].status === "fulfilled") state.wardrobe = Array.isArray(results[0].value) ? { outfits: results[0].value } : results[0].value || state.wardrobe
  if (results[1].status === "fulfilled") {
    const settings = results[1].value || {}
    state.look = { outfit: settings.outfit || settings.rules?.default?.outfit || "uniform", hair: settings.hair || settings.rules?.default?.hair || "natural", hairColor: settings.hairColor || null }
  }
  if (results[2].status === "fulfilled") { $("connection").textContent = t("connected"); $("dot").classList.add("online") }
  if (results[2].status === "rejected") { $("connection").textContent = t("offline"); $("dot").classList.remove("online") }
  fillOptions("outfit", state.wardrobe.outfits || [], state.look.outfit)
  fillOptions("hair", state.wardrobe.hairstyles || [], state.look.hair)
  fillOptions("hairColor", state.wardrobe.colors || [], state.look.hairColor, true)
  startStage()
}
$("login-form").addEventListener("submit", async event => {
  event.preventDefault()
  $("login-submit").disabled = true
  clearNotice()
  try { await api("signIn", { email: $("email").value, password: $("password").value }); $("password").value = ""; await signedIn() }
  catch (error) { handleError(error) }
  finally { $("login-submit").disabled = false }
})
$("signout").addEventListener("click", async () => {
  try { await api("signOut"); showSignedIn(false); $("messages").replaceChildren(); state.seen.clear(); state.loaded = false; avatar.src = "stage.html" }
  catch (error) { handleError(error) }
})
$("refresh").addEventListener("click", () => refresh().catch(handleError))
$("wardrobe-toggle").addEventListener("click", () => { $("wardrobe").hidden = !$("wardrobe").hidden })
$("wardrobe-close").addEventListener("click", () => { $("wardrobe").hidden = true })
for (const id of ["outfit", "hair", "hairColor"]) $(id).addEventListener("change", async () => {
  const previous = state.look[id]
  state.look[id] = $(id).value || null
  stage("dress", state.wardrobe, state.look)
  try { await api("setAvatar", { [id]: state.look[id] }) }
  catch (error) { state.look[id] = previous; $(id).value = previous || ""; stage("dress", state.wardrobe, state.look); handleError(error) }
})
$("background").addEventListener("change", () => stage("setBackground", $("background").value))
for (const button of document.querySelectorAll("[data-camera]")) button.addEventListener("click", () => {
  document.querySelectorAll("[data-camera]").forEach(item => item.classList.toggle("selected", item === button))
  stage("cameraPreset", button.dataset.camera)
})
$("reset").addEventListener("click", () => stage("resetView"))
$("wave").addEventListener("click", () => stage("gesture", "greet"))
$("voice").addEventListener("click", () => { state.muted = !state.muted; $("voice").textContent = t(state.muted ? "muted" : "unmuted"); stage("setMuted", state.muted); if (state.muted) { state.speaking = false; stage("stop"); if (!state.busy) stage("setState", "idle") } })
async function speak(text) {
  if (state.muted || !text) return
  const bytes = await api("tts", text.slice(0, 1200))
  if (state.muted) return
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }))
  state.speaking = true
  stage("speak", url)
  setTimeout(() => URL.revokeObjectURL(url), 180000)
}
async function pollJob(job) {
  const started = Date.now()
  while (Date.now() - started < 180000 && state.signedIn) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const result = await api("job", String(job.id))
    if (result.status === "error") throw new Error("jobError")
    if (result.status === "done") {
      const text = typeof result.result === "string" ? result.result : result.result?.reply || result.result?.text || ""
      if (text) { message(text); await speak(text) }
      await refresh()
      return
    }
  }
  notice("jobTimeout")
}
$("composer").addEventListener("submit", async event => {
  event.preventDefault()
  const text = $("message").value.trim()
  if (!text || state.busy) return
  state.busy = true
  $("send").disabled = true
  clearNotice()
  $("message").value = ""
  $("message").style.height = "auto"
  const local = message(text, "user")
  const pending = message(t("thinking"), "pending")
  stage("setState", "thinking")
  try {
    const response = await api("chat", { message: text, sessionId: state.sessionId, clientMessageId: crypto.randomUUID() })
    if (local) local.dataset.delivered = "true"
    if (response.userItemId) state.seen.add(String(response.userItemId))
    pending?.remove()
    if (response.reply) { message(response.reply, "lucina", response.lucinaItemId); await speak(response.reply) }
    if (response.job?.id && !["done", "error"].includes(response.job.status)) {
      const progress = message(t("working"), "pending")
      try { await pollJob(response.job) } finally { progress?.remove() }
    }
  } catch (error) {
    if (!local?.dataset.delivered) { local?.remove(); $("message").value = text }
    handleError(error)
  } finally {
    pending?.remove()
    state.busy = false
    $("send").disabled = false
    if (!state.speaking) stage("setState", "idle")
    $("message").focus()
  }
})
$("message").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit() } })
$("message").addEventListener("input", () => { $("message").style.height = "auto"; $("message").style.height = `${Math.min(110, $("message").scrollHeight)}px` })
document.addEventListener("visibilitychange", () => { if (document.hidden) stage("stop"); else if (state.signedIn) refresh().catch(() => undefined) })
try { const status = await api("status"); if (status.authenticated) await signedIn(); else showSignedIn(false) }
catch (error) { showSignedIn(false); handleError(error) }
