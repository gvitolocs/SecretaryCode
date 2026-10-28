# Lucina Prompter overlay

Lucina Prompter (`/prompter` in her web app) shows the owner's talking points and crosses them out live while he
speaks. In Secretary Code a take can run in a small window that stays above other apps (a call, slides). This file is
the contract between her web app and the Mac app. The web side is SecretaryIOS `web/src/lib/desktopShell.ts`; callers
are `web/src/views/Prompter.tsx` and `PrompterLive.tsx`. The prompter session's request is
`~/Projects/Lucina/notes/prompter-overlay-for-secretary-code.md` on the Mac; the design doc is SecretaryIOS `docs/prompter.md`
(lucina-rs line), section "Secretary Code overlay".

## Bridge (`window.secretaryShell`, preload `src/preload/lucina.ts`)

All three methods are optional on the web side. Her page shows "Open as overlay" only when `openPrompterOverlay` exists,
and the opacity slider only inside the overlay when `setOverlayOpacity` exists.

| Method | Arguments | Returns | Who may call |
| --- | --- | --- | --- |
| `openPrompterOverlay(path, opts?)` | `path`: `/prompter/<slug>` with an optional query (the web sends `?live=1&overlay=1`); `opts.opacity`: number | `void` | her Lucina or Computer view, or the overlay itself |
| `setOverlayOpacity(opacity)` | number | `void` | the overlay's own page |
| `closePrompterOverlay()` | none | `void` | the overlay's own page |

- Each call sends one `secretary:prompter-overlay` IPC message: `{action: "open", path, opacity?}`, `{action: "opacity", opacity}`
  or `{action: "close"}`. The preload throws `TypeError` for a non-string path or a non-number opacity.
- The main process (`prompter-overlay.ts`) rebuilds the request from validated fields (`prompter-overlay-core.ts`,
  `parseOverlayRequest`) and checks the sender; anything else is dropped silently.
- Path: `isNavigatePath` (same rule as the shell's routing) and `/prompter/<one segment>`. Opacity is clamped to 0.3–1;
  a missing or non-finite one opens at 0.85.

## Window

- Frameless, opaque (`#05070a`), with a shadow, 440 × 560 (shorter on a small screen), placed at the top right of the
  primary display's work area, min 320 × 300, resizable, not minimizable or full-screenable.
- Always on top at the `screen-saver` level, on every Space and over full-screen apps (Keynote, Zoom, Photo Booth).
- Moved by her page's own drag region (`-webkit-app-region: drag` in `prompter.css`; buttons are `no-drag`).
- One overlay at a time: a second `openPrompterOverlay` routes the open one to the new path (no reload), applies the
  opacity and focuses it.
- Its last bounds are not remembered (the request lists that as optional).
- Shown once her page has loaded (or after 3 s), never as an empty frame.
- Closes with the main window, on `closePrompterOverlay()`, or when the owner quits.
- Content: her web app (`lucinaWebView`) in the shared `persist:lucina-web` partition, with the bundled UI, the web sign-in
  (`ensureWebSession`), `?shell=1` and the same preload. Links to other sites open in the default browser.

## Microphone

The overlay and her main Lucina view are registered with `allowMicrophone`. The partition's permission handler
(`computer-view.ts`) grants `media` only to those views, in their top frame, on her origin, and for audio alone (no camera,
no screen). macOS asks once for Secretary Code's microphone access (`NSMicrophoneUsageDescription`).

## Not implemented

- Click-through (`setIgnoreMouseEvents`): the web contract has no method for it, and the overlay's controls need clicks.
  Add `setOverlayClickThrough?(on)` on both sides if it is wanted.

## Check after a build

1. `/prompter` in the Mac app shows "Open as overlay" on a script.
2. It opens the overlay at the top right, above other apps and a full-screen window. The opacity slider changes the window.
3. A live take asks for the microphone once, then crosses points out as the owner speaks.
4. Stop closes the overlay. Closing the main window closes it too.
