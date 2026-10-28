// The parts of the Lucina Prompter overlay (prompter-overlay.ts) that need no Electron: what her page may ask for and
// which values are accepted. The contract is SecretaryIOS web/src/lib/desktopShell.ts (openPrompterOverlay,
// setOverlayOpacity, closePrompterOverlay); see PROMPTER_OVERLAY.md next to this file.
import { isNavigatePath } from "./shell-command"

export const MIN_OPACITY = 0.3
export const MAX_OPACITY = 1
/** The overlay's opacity when her page names none. */
export const OPEN_OPACITY = 0.85

export type OverlayRequest =
  | { action: "open"; path: string; opacity: number }
  | { action: "opacity"; opacity: number }
  | { action: "close" }

/** A page of the prompter ("/prompter/<slug>", with an optional query): the only pages the overlay shows. */
export function isPrompterPath(value: unknown): value is string {
  return isNavigatePath(value) && /^\/prompter\/[^/?]+(\?.*)?$/.test(value)
}

/** The opacity as a number between 0.3 and 1; anything that is not a finite number is `fallback`. */
export function clampOpacity(value: unknown, fallback = MAX_OPACITY) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback

  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, value))
}

/** The request in a `secretary:prompter-overlay` message, rebuilt from validated fields only, or undefined. */
export function parseOverlayRequest(value: unknown): OverlayRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const message = value as Record<string, unknown>

  if (message.action === "close") return { action: "close" }

  if (message.action === "opacity")
    return typeof message.opacity === "number" && Number.isFinite(message.opacity)
      ? { action: "opacity", opacity: clampOpacity(message.opacity) }
      : undefined

  if (message.action === "open" && isPrompterPath(message.path))
    return { action: "open", path: message.path, opacity: clampOpacity(message.opacity, OPEN_OPACITY) }
}

/** Whether a media permission asks for the microphone alone (no camera, no screen). */
export function audioOnly(mediaTypes: readonly unknown[] | undefined) {
  return !!mediaTypes?.length && mediaTypes.every((type) => type === "audio")
}
