import log from "electron-log/main.js"
import { createFocusMode } from "./focus-mode-core"

/** The window's focus mode (focus-mode-core), logged to main.log. The panels drive it; View → Exit Focus follows it. */
export const focusMode = createFocusMode({ log: (message, data) => log.info(message, data) })
