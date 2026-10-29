/**
 * The window's focus mode, owned by the main process: a page of hers takes nearly the whole window while the rail
 * steps aside. Each requester holds its own token: "computer" for the Computer viewer's refused fullscreen, "viewer"
 * for her pages' secretaryShell.setFocusMode (the photo viewer's Full screen). Focus mode is on while any token is
 * held. Entering is explicit and never toggles. A requester may release its own token, while an exit (Exit focus, Esc,
 * View → Exit Focus, another page, a reload, a crash) clears every token at once.
 */
export type FocusSource = "computer" | "viewer"

export type FocusExit = "button" | "escape" | "menu" | "navigation" | "view-change" | "reload" | "crash"

// The owner's own exits broadcast "off" to her pages; a page that answers by asking again (its viewer still thinks it
// is full screen, the stream reconnecting re-requests fullscreen) must not flip focus mode straight back on.
export const REENTRY_GRACE_MS = 1000

const OWNER_EXITS = new Set<FocusExit>(["button", "escape", "menu"])

export function createFocusMode(options: {
  log(message: string, data: Record<string, unknown>): void
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const tokens = new Map<FocusSource, string>()
  const listeners = new Set<(on: boolean) => void>()
  const state = { counter: 0, exitedAt: -Infinity }
  const emit = () => listeners.forEach((listener) => listener(tokens.size > 0))

  return {
    active: () => tokens.size > 0,
    tokens: () => [...tokens.values()],
    /** Turns focus mode on for `source`; a source already holding a token keeps it. Undefined when refused. */
    enter(source: FocusSource) {
      const held = tokens.get(source)

      if (held) return held
      if (now() - state.exitedAt < REENTRY_GRACE_MS) {
        options.log("focus mode: enter ignored right after an exit", { source })
        return
      }
      const token = `${source}-${++state.counter}`
      tokens.set(source, token)
      options.log("focus mode: enter", { source, token })
      if (tokens.size === 1) emit()

      return token
    },
    /** Requesters asked to leave: only their own tokens go, so another requester keeps focus mode on. */
    release(...sources: FocusSource[]) {
      const released = sources.flatMap((source) => {
        const token = tokens.get(source)

        if (!token) return []
        tokens.delete(source)
        options.log("focus mode: release", { source, token })
        return [token]
      })

      if (released.length && tokens.size === 0) emit()
    },
    /** Leaves focus mode whoever asked for it. */
    exit(reason: FocusExit) {
      if (OWNER_EXITS.has(reason)) state.exitedAt = now()

      if (tokens.size === 0) return
      options.log("focus mode: exit", { source: reason, tokens: [...tokens.values()] })
      tokens.clear()
      emit()
    },
    /** Called with the new state whenever focus mode turns on or off. Returns the unsubscribe. */
    subscribe(listener: (on: boolean) => void) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Whether a key press is one of focus mode's ways out: Esc, or ⌃⌘F (View → Exit Focus). */
export function focusExitKey(input: {
  type: string
  key: string
  control?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
}): "escape" | "menu" | undefined {
  if (input.type !== "keyDown" || input.alt || input.shift) return
  if (input.key === "Escape" && !input.control && !input.meta) return "escape"
  if (input.key.toLowerCase() === "f" && input.control && input.meta) return "menu"
}
