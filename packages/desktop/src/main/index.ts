// Imported first so its evaluation stamps the moment Electron handed control to this module.
import "./secretary-environment"
import { marks } from "./lifecycle/marks"
import { app } from "electron"
import { acquireApplicationLock, configureApplication } from "./lifecycle/configure"
import { startSidecarProbe } from "./service/sidecar-probe"
import { registerStorageSnapshotHandler } from "./storage/snapshot"
import { createEarlyWindow } from "./windows/early"
import { rendererAssetsServed } from "./windows/protocol"
import { registerRendererScheme } from "./windows/scheme"
import { setupSecretary } from "./secretary"
import { setupAgentsMirror } from "./secretary/agents"
import { setupDiagnostics } from "./secretary/diagnostics"
import { setupCodingLanes } from "./secretary/lane-window"
import { setupCompanionPanels } from "./secretary/panel"
import { setupRecorder } from "./secretary/recorder"

import { ImageOpenQueue, imageArguments } from "./secretary/image-viewer/queue"

// Finder can deliver these while Chromium is still starting, before the desktop bundle loads.
const images = new ImageOpenQueue()
app.on("open-file", (event, file) => {
  event.preventDefault()
  images.enqueue([file])
})
app.on("second-instance", (_event, argv, cwd) => images.enqueue(imageArguments(argv, cwd)))
images.enqueue(imageArguments(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd()))

// This module stays small on purpose. Electron holds the ready event until the entry module has
// finished, and the first window should be on screen before the rest of the main process — a few
// hundred milliseconds of module evaluation and layers — loads. Configuration and the scheme must
// precede ready; the window is created the moment ready fires; everything else is imported after.
configureApplication()
// Crash reporting hooks attach before ready so an early main-process failure is captured too.
setupDiagnostics()
setupSecretary()
setupCodingLanes()
setupCompanionPanels()
setupRecorder()
setupAgentsMirror()

if (acquireApplicationLock()) {
  registerRendererScheme()
  // Window first, then the bundle: starting the import before ready delays ready itself, because the
  // module graph evaluates on the same thread Chromium needs to finish initialising.
  void app.whenReady().then(async () => {
    marks.ready = Date.now()
    void import("./secretary/image-viewer").then(({ setupImageViewer }) => {
      images.ready(setupImageViewer())
    })
    registerStorageSnapshotHandler()
    createEarlyWindow()
    marks.window = Date.now()
    startSidecarProbe()

    // The window's renderer is already loading. Its HTML and preloaded chunks are served from this
    // thread, so the bundle waits for that burst to be answered (or a cap) before it evaluates.
    if (!process.env.ELECTRON_RENDERER_URL) await rendererAssetsServed({ quietMs: 40, capMs: 400 })
    marks.served = Date.now()

    return import("./desktop")
  })
}
