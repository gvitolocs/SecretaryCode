import { For, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { ResizeHandle } from "@opencode/ui/resize-handle"
import { ScrollView } from "@opencode/ui/scroll-view"
import { Spinner } from "@opencode/ui/spinner"
import { Tooltip } from "@opencode/ui/tooltip"
import { createHomeController } from "@/home/model"
import { createHomeProjectsController } from "@/home/projects/controller"
import { HomeProjects } from "@/home/projects/region"
import { HomeUtilityNav } from "@/home/projects/view"
import { createHomeSessionsController } from "@/home/sessions/controller"
import { HomeSessionLeadingController } from "@/home/sessions/view"
import { sessionLabel } from "@/session/title"
import { useLayout } from "@/shell/state/layout"
import { getRelativeTime } from "@/shell/time"
import { SIDEBAR_WIDTH, useWorkspace } from "./workspace"

/** Projects and their recent sessions, from the same controllers as Home, kept beside every screen. */
export function WorkspaceSidebar() {
  const workspace = useWorkspace()
  const layout = useLayout()
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const language = projects.copy.language

  const activeSession = () => {
    const route = layout.route()

    return route.type === "session" ? route.sessionId : undefined
  }

  return (
    <aside
      data-slot="workspace-sidebar"
      aria-label={language.t("workspace.sidebar")}
      class="relative flex h-full min-h-0 shrink-0 flex-col gap-3 ps-[var(--shell-inline-inset,8px)] pb-[var(--shell-bottom-inset,8px)] pt-[var(--shell-top-inset,8px)]"
      style={{ width: `${workspace.sidebar.width()}px` }}
    >
      <ResizeHandle
        class="-end-1"
        direction="horizontal"
        size={workspace.sidebar.width()}
        min={SIDEBAR_WIDTH.min}
        max={SIDEBAR_WIDTH.max}
        onResize={workspace.sidebar.resize}
      />
      <button
        type="button"
        data-action="workspace-new-session"
        class="flex h-8 w-full shrink-0 items-center gap-2 rounded-[6px] px-2 text-[13px] leading-4 text-v2-text-text-base [font-weight:530] hover:bg-v2-background-bg-layer-02 focus-visible:outline-none focus-visible:bg-v2-background-bg-layer-02 disabled:opacity-60"
        disabled={!sessions.session.canCreate()}
        onClick={sessions.session.create}
      >
        <Icon name="new-session" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        {language.t("command.session.new")}
      </button>
      <div class="flex max-h-[42%] min-h-0 shrink-0 flex-col pe-2">
        <HomeProjects projects={projects} sidebar />
      </div>
      <section class="flex min-h-0 flex-1 flex-col" aria-label={language.t("sidebar.project.recentSessions")}>
        <div class="flex h-7 min-w-0 shrink-0 items-center justify-between pl-1.5 pr-2">
          <span class="truncate text-v2-text-text-muted [font-weight:530]">
            {home.project.selected()?.name || language.t("home.sessions.search.sessions")}
          </span>
          <Tooltip placement="bottom" value={language.t("command.session.new")}>
            <IconButton
              type="button"
              variant="ghost-muted"
              icon={<Icon name="plus-small" />}
              disabled={!sessions.session.canCreate()}
              onClick={sessions.session.create}
              aria-label={language.t("command.session.new")}
            />
          </Tooltip>
        </div>
        <ScrollView class="min-h-0 flex-1 pe-2">
          <Show
            when={!sessions.data.loading()}
            fallback={
              <div class="flex h-10 items-center justify-center text-v2-text-text-faint">
                <Spinner class="size-4" />
              </div>
            }
          >
            <Show
              when={sessions.data.groups().length > 0}
              fallback={
                <p class="px-1.5 py-2 text-[13px] leading-5 text-v2-text-text-faint">
                  {language.t("home.sessions.empty.description")}
                </p>
              }
            >
              <Show when={sessions.session.server()}>
                {(server) => (
                  <For each={sessions.data.groups()}>
                    {(group) => (
                      <div class="flex flex-col gap-px pb-3">
                        <div class="px-1.5 pb-1 pt-1 text-[12px] leading-4 text-v2-text-text-faint [font-weight:530]">
                          {group.title}
                        </div>
                        <Key each={group.sessions} by={(record) => record.session.id}>
                          {(record) => (
                            <button
                              type="button"
                              data-action="workspace-open-session"
                              data-session-id={record().session.id}
                              aria-current={activeSession() === record().session.id ? "page" : undefined}
                              class="group/session flex h-8 w-full min-w-0 items-center gap-2 rounded-[6px] ps-1.5 pe-2 text-start text-[13px] leading-4 text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base aria-[current=page]:bg-v2-background-bg-layer-02 aria-[current=page]:text-v2-text-text-base focus-visible:outline-none focus-visible:bg-v2-overlay-simple-overlay-hover"
                              onClick={() => sessions.session.open(record().session)}
                            >
                              <HomeSessionLeadingController
                                server={server()}
                                isOpenTab={sessions.tab.isOpen}
                                record={record()}
                              />
                              <span dir="auto" class="min-w-0 flex-1 truncate [font-weight:530]">
                                {sessionLabel(record().session)}
                              </span>
                              <span class="shrink-0 text-[12px] text-v2-text-text-faint">
                                {getRelativeTime(
                                  new Date(
                                    record().session.time.updated ?? record().session.time.created,
                                  ).toISOString(),
                                  language.t,
                                )}
                              </span>
                            </button>
                          )}
                        </Key>
                      </div>
                    )}
                  </For>
                )}
              </Show>
            </Show>
          </Show>
        </ScrollView>
      </section>
      <HomeUtilityNav
        class="flex shrink-0 pe-2"
        onOpenSettings={projects.utility.settings}
        language={language}
      />
    </aside>
  )
}
