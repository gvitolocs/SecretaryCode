import { For, type JSX } from "solid-js"
import lucina from "../../../../ui/src/assets/images/secretary-lucina.png"
import { useLanguage } from "@/runtime/i18n/language"
import type { ShellView } from "@/runtime/platform/platform"
import { useSettingsSurface } from "@/settings/surface"
import { useWorkspace } from "@/shell/workspace/workspace"
import { ACCOUNT_ROUTE } from "@/shell/workspace/views"
import "./rail.css"

type RailIcon =
  | "bulb"
  | "code"
  | "computer"
  | "list"
  | "dumbbell"
  | "gallery"
  | "film"
  | "inbox"
  | "key"
  | "pulse"
  | "gear"
  | "person"

// Stroke icons on a 24px grid, the same artwork as the approved mock.
const ICONS: Record<RailIcon, () => JSX.Element> = {
  code: () => <path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5M13.5 4.5l-3 15" />,
  computer: () => (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8.5 20h7M12 16v4" />
    </>
  ),
  // Shopping and Training: the web app's own tab icons.
  list: () => (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2" />
    </>
  ),
  dumbbell: () => <path d="M3.5 10v4M6 8v8M18 8v8M20.5 10v4M6 12h12" />,
  gallery: () => (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="9.5" r="1.8" />
      <path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4" />
    </>
  ),
  bulb: () => (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z" />
    </>
  ),
  film: () => (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M10 9.2v5.6l4.6-2.8z" />
    </>
  ),
  inbox: () => (
    <>
      <path d="M4 13.5 6.3 5.6A1.5 1.5 0 0 1 7.7 4.5h8.6a1.5 1.5 0 0 1 1.4 1.1L20 13.5v4A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z" />
      <path d="M4 13.5h4.5l1.2 2h4.6l1.2-2H20" />
    </>
  ),
  key: () => (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2" />
    </>
  ),
  pulse: () => <path d="M3 12h4l2-5 4 10 2-5h6" />,
  person: () => (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </>
  ),
  gear: () => (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
}

/** The views below Lucina, in rail order. */
const VIEW_ICONS: { view: ShellView; icon: RailIcon }[] = [
  { view: "keep", icon: "bulb" },
  { view: "code", icon: "code" },
  { view: "computer", icon: "computer" },
  { view: "shopping", icon: "list" },
  { view: "training", icon: "dumbbell" },
  { view: "gallery", icon: "gallery" },
  { view: "films", icon: "film" },
  { view: "chats", icon: "inbox" },
  { view: "secrets", icon: "key" },
  { view: "health", icon: "pulse" },
]

function Glyph(props: { icon: RailIcon }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {ICONS[props.icon]()}
    </svg>
  )
}

/** The slim pill rail on the far left: Lucina first, her plugins below, Settings at the bottom. */
export function ShellRail() {
  const workspace = useWorkspace()
  const language = useLanguage()
  const settings = useSettingsSurface()

  // Settings covers the view while it is open, so the ring moves to it and returns when it closes.
  const current = (view: ShellView) => !settings.active() && workspace.view.current() === view

  const item = (view: ShellView, icon: JSX.Element) => (
    <button
      type="button"
      data-slot="rail-item"
      data-action={`rail-${view}`}
      aria-current={current(view) ? "page" : undefined}
      onClick={() => workspace.view.show(view)}
    >
      <span data-slot="rail-well">{icon}</span>
      <span data-slot="rail-label">{language.t(`shell.view.${view}`)}</span>
    </button>
  )

  return (
    <div data-slot="shell-rail-region">
      <nav data-slot="shell-rail" aria-label={language.t("shell.rail")}>
        <div data-slot="rail-group">
          {item("lucina", <img src={lucina} alt="" draggable={false} />)}
          <div data-slot="rail-sep" />
          <For each={VIEW_ICONS}>{(entry) => item(entry.view, <Glyph icon={entry.icon} />)}</For>
        </div>
        <div data-slot="rail-spacer" />
        <div data-slot="rail-group">
          <button
            type="button"
            data-slot="rail-item"
            data-action="rail-settings"
            aria-current={settings.active() ? "page" : undefined}
            onClick={() => settings.open()}
          >
            <span data-slot="rail-well">
              <Glyph icon="gear" />
            </span>
            <span data-slot="rail-label">{language.t("sidebar.settings")}</span>
          </button>
          {/* The owner's account in Lucina's web app, where signing out also signs this Mac out. */}
          <button
            type="button"
            data-slot="rail-owner"
            data-action="rail-account"
            aria-label={language.t("shell.account")}
            title={language.t("shell.account")}
            onClick={() => workspace.view.open("lucina", ACCOUNT_ROUTE)}
          >
            <Glyph icon="person" />
          </button>
        </div>
      </nav>
    </div>
  )
}
