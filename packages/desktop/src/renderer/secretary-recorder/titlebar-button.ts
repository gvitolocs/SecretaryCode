import copy from "./en.json"
import "./titlebar-button.css"

/**
 * The titlebar's Record button. It sits beside the titlebar's right slot when that exists and
 * floats in the corner otherwise; the titlebar re-renders on navigation, so it is re-attached.
 */
export function mountRecordButton() {
  const button = document.createElement("button")
  const dot = document.createElement("span")
  const label = document.createElement("span")
  button.type = "button"
  button.className = "secretary-record-button"
  button.title = `${copy.menuRecord} ⌥⌘R`
  button.setAttribute("aria-label", copy.menuRecord)
  dot.className = "secretary-record-dot"
  label.textContent = copy.titlebarRecord
  button.append(dot, label)
  button.addEventListener("click", () => void window.electron.recorder.open())

  window.electron.recorder.onStatus((value) => {
    const status = value && typeof value === "object" && "phase" in value && "elapsed" in value ? value : undefined
    const recording = !!status && status.phase !== "idle"
    button.classList.toggle("recording", recording)
    label.textContent = recording && typeof status.elapsed === "number" ? clock(status.elapsed) : copy.titlebarRecord
    button.setAttribute("aria-label", recording ? copy.titlebarRecording : copy.menuRecord)
  })

  const attach = () => {
    const slot = document.getElementById("opencode-titlebar-right")

    if (slot) {
      if (button.nextElementSibling === slot) return
      button.classList.remove("floating")
      slot.before(button)

      return
    }

    if (button.parentElement === document.body) return
    button.classList.add("floating")
    document.body.append(button)
  }

  attach()
  new MutationObserver(attach).observe(document.body, { childList: true, subtree: true })
}

function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const pad = (value: number) => String(value).padStart(2, "0")
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)

  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`
}
