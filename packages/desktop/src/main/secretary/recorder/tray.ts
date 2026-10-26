import { Menu, Tray, nativeImage } from "electron"
import copy from "../../../renderer/secretary-recorder/en.json"
import type { RecorderService } from "./service"

// 32×32 PNGs drawn at 2× for a 16-point menu-bar icon: a red recording dot, and a template ring
// (macOS tints it for light and dark menu bars) shown while an upload is still running.
const RED_DOT =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAm0lEQVR42u2WzQnAIAxGHchD7707VPZwKgfJGDYFhVKohZiSWHJ4F1G+539C3begSXABF1hVIBFA5Aa0ts8FziAk6gPY+ogLRKIMgu+UNkZEIL7MerQaUUKgMMKvKzElABPhHZgRQAEB5AokgfBO4giAoABwBLKgQF5SQH0L1A+h+jU08RCpP8UmPiP179hEQWKmJPOq2AX+J3AARObIX6trSYYAAAAASUVORK5CYII="

const UPLOAD_RING =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA5ElEQVR42u2WsRHDIAxF3WYNl0yRTRiAGSioWIHLEG4zBct4gUSFCh0niLHJScmhu9eAsHToC2tZpk07Z3fAAQFxuPZVM0ACduBVYUcfMzp4aAStEUYF35iPPwEPWMTjWum3jQ7+ANaG/4o+Q5Ior912nLVXy2EuBK8l0SXMVFz7WaPlSD0HaatxNb8BEchIxDVOE7RFDz8yVO1c8MwoPleSoN1x6LFy5IBn9mOj9yPj78m+61U/J77cSCB/EGP4iQTESyAuQvE2VPEQiT/F4j8jFb9jFQOJipFMxVCqYiyf9p/2Bnyi42VfpnhPAAAAAElFTkSuQmCC"

/**
 * A menu-bar item that exists only while something is happening: a red dot with the elapsed time
 * while recording, a ring while uploads finish. It works with every window closed.
 */
export function setupRecorderTray(service: RecorderService, open: () => void) {
  let tray: Tray | undefined
  let menuKey = ""
  const recordingIcon = nativeImage.createFromBuffer(Buffer.from(RED_DOT, "base64"), { scaleFactor: 2 })
  const uploadIcon = nativeImage.createFromBuffer(Buffer.from(UPLOAD_RING, "base64"), { scaleFactor: 2 })
  uploadIcon.setTemplateImage(true)

  const update = () => {
    const active = service.recording
    const recording = active.phase !== "idle"

    if (!recording && service.uploadsInFlight === 0) {
      tray?.destroy()
      tray = undefined
      menuKey = ""

      return
    }

    if (!tray) {
      tray = new Tray(recordingIcon)
      tray.setToolTip(copy.trayTooltip)
    }

    tray.setImage(recording ? recordingIcon : uploadIcon)
    tray.setTitle(recording ? ` ${clock(active.elapsed)}` : "", { fontType: "monospacedDigit" })

    // Rebuilding an open menu closes it, so only rebuild when its items change.
    const key = `${active.phase}`

    if (key === menuKey) return
    menuKey = key
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(active.phase === "recording" ? [{ label: copy.trayPause, click: () => void service.pauseOrResume() }] : []),
        ...(active.phase === "paused" ? [{ label: copy.trayResume, click: () => void service.pauseOrResume() }] : []),
        ...(active.phase === "recording" || active.phase === "paused"
          ? [{ label: copy.trayStop, click: () => void service.stop() }]
          : []),
        ...(recording ? [] : [{ label: copy.trayUploading, enabled: false }]),
        { type: "separator" },
        { label: copy.trayOpen, click: open },
      ]),
    )
  }

  service.subscribe(update)
}

/** 4:05 or 1:02:09. */
export function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const pad = (value: number) => String(value).padStart(2, "0")
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)

  return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`
}
