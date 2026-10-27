import { Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { Titlebar } from "@/shell/titlebar/titlebar"
import { usePlatform } from "@/runtime/platform/platform"
import { ToastRegion } from "@/shell/notifications/toast"
import { UploadToastHost } from "@/composer/attachments/uploads"
import { TitlebarRightProvider } from "@/shell/titlebar/right-slot"
import { useSettingsSurface } from "@/settings/surface"
import { useSettings } from "@/settings/model"
import { ExtensionServerCover } from "@/runtime/extension/server-shell"
import { ExtensionSlot } from "@/runtime/extension/render"
import { useWorkspace, WorkspaceProvider } from "@/shell/workspace/workspace"
import { WorkspaceSidebar } from "@/shell/workspace/sidebar"
import { ContentCard } from "@/shell/workspace/companion"
import { ShellRail } from "@/shell/rail/rail"

export default function Layout(props: ParentProps) {
  return (
    <WorkspaceProvider>
      <Workspace>{props.children}</Workspace>
    </WorkspaceProvider>
  )
}

function Workspace(props: ParentProps) {
  const platform = usePlatform()
  const workspace = useWorkspace()
  const settings = useSettingsSurface()
  const preferences = useSettings()
  const mobile = createMediaQuery("(max-width: 767px)")

  const [state, setState] = createStore<{ tabsWidth: number; tabsMount: HTMLElement | undefined }>({
    tabsWidth: 260,
    tabsMount: undefined,
  })

  const verticalTabs = () => workspace.view.verticalTabs()
  // OpenCode's own screen shows in Code and under settings; every other view keeps it mounted but hidden.
  const showMain = () => workspace.view.code() || settings.active()
  // The card exists in every view but Code; the card itself steps aside while settings is open.
  const showCard = () => workspace.rail.available() && !workspace.view.code()
  const bottomTitlebar = () => mobile() && preferences.general.mobileTitlebarPosition() === "bottom"

  return (
    <TitlebarRightProvider>
      <div
        class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
        style={{
          // Mobile panels only need clearance for their outer border.
          "--shell-inline-inset": mobile() ? "1px" : "8px",
          // A bottom mobile titlebar leaves main's top edge to the safe area. Native Windows chrome supplies the gap;
          // retain outer-outline clearance.
          "--shell-top-inset": bottomTitlebar()
            ? "0px"
            : platform.platform === "desktop" && platform.os === "windows"
              ? "1px"
              : "8px",
          "--shell-bottom-inset": bottomTitlebar()
            ? "8px"
            : "max(0px, calc(8px - var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))))",
        }}
      >
        <Titlebar verticalTabs={verticalTabs() ? { mount: state.tabsMount } : undefined} />
        <div class="flex flex-1 min-h-0 min-w-0 flex-row">
          <Show when={workspace.rail.available()}>
            <ShellRail />
          </Show>
          <Show when={workspace.sidebar.visible()}>
            <WorkspaceSidebar />
          </Show>
          <Show when={verticalTabs() && showMain()}>
            <aside
              ref={(element) => setState("tabsMount", element)}
              data-slot="vertical-tabs-sidebar"
              class="relative flex h-full min-h-0 shrink-0 flex-col bg-v2-background-bg-deep pe-0.5 ps-2.5 pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]"
              style={{
                width: `${state.tabsWidth}px`,
                "padding-bottom": "max(10px, var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
              }}
            >
              <ResizeHandle
                class="-end-2"
                direction="horizontal"
                size={state.tabsWidth}
                min={140}
                max={520}
                onResize={(width) => setState("tabsWidth", width)}
              />
            </aside>
          </Show>
          {/* Size containment collapses percentage-height descendants in WebKit. */}
          <main
            class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-content"
            style={{
              display: showMain() ? undefined : "none",
              "padding-top": bottomTitlebar() ? "env(safe-area-inset-top, 0px)" : "0px",
              "padding-bottom":
                bottomTitlebar() || settings.active()
                  ? "0px"
                  : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
              "--settings-bottom-inset": bottomTitlebar()
                ? "40px"
                : "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
            }}
          >
            <ExtensionServerCover>
              <Suspense>{props.children}</Suspense>
            </ExtensionServerCover>
          </main>
          <Show when={showCard()}>
            <ContentCard hidden={settings.active()} />
          </Show>
        </div>
        <ExtensionSlot at="window.bottom" input={{}} />
        <ToastRegion />
        <UploadToastHost />
      </div>
    </TitlebarRightProvider>
  )
}
