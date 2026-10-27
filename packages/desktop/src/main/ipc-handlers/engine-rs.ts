import { app } from "electron"
import { Effect } from "effect"
import path from "node:path"
import { RustEngineRpcs } from "../../shared/ipc-rpc"
import { createRustEnginePreview, engineConfigPaths, rustEngineDataPath } from "../secretary/engine-rs"

/**
 * The bundled Rust `oc-server` for the settings preview. It runs beside the TypeScript engine on its own
 * loopback port; nothing here replaces or reconfigures the TypeScript engine.
 */
export const engineRsHandlers = RustEngineRpcs.toLayer(
  Effect.gen(function* () {
    const userData = app.getPath("userData")
    const config = engineConfigPaths()
    const preview = createRustEnginePreview({
      serverExecutable: path.join(bundledDirectory(), "oc-server"),
      dataDir: rustEngineDataPath(userData),
      settingsFile: path.join(userData, "engine-rs", "preview.json"),
      configPath: config.config,
      authPath: config.auth,
      worktree: app.getPath("home"),
    })

    yield* Effect.sync(() => {
      app.on("before-quit", () => void preview.stop())
      // The toggle survives a restart: when it was left on, start the server once the app is ready.
      void app.whenReady().then(() => preview.load())
    })

    return RustEngineRpcs.of({
      RustEngineStatus: () => Effect.sync(() => preview.status()),
      RustEngineSetEnabled: ({ enabled }) => Effect.promise(() => preview.setEnabled(enabled)),
      RustEnginePing: ({ tsUrl }) => Effect.promise(() => preview.ping(tsUrl)),
    })
  }),
)

function bundledDirectory() {
  if (process.env.SECRETARY_ENGINE_RS_DIR) return process.env.SECRETARY_ENGINE_RS_DIR
  return app.isPackaged ? path.join(process.resourcesPath, "engine-rs") : path.join(app.getAppPath(), "resources/engine-rs")
}
