import { Component, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Switch } from "@opencode/ui/switch"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform, type RustEngineLatency, type RustEngineStatus } from "@/runtime/platform/platform"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"

const STATUS_POLL_MS = 2_000
const PING_POLL_MS = 5_000

/**
 * Settings → Rust engine (preview). The toggle starts the bundled `oc-server` beside the TypeScript engine on
 * its own loopback port; the panel reports the port, version, route coverage and a health ping for both.
 */
export const SettingsRustEngine: Component<{ serverUrl?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const preview = () => platform.rustEngine
  const [state, setState] = createStore<{
    status?: RustEngineStatus
    latency?: RustEngineLatency
    pending: boolean
    failed: boolean
  }>({ pending: false, failed: false })

  const refresh = async () => {
    const engine = preview()
    if (!engine) return
    setState("status", await engine.status().catch(() => undefined))
  }

  const ping = async () => {
    const engine = preview()
    if (!engine) return
    setState("latency", await engine.ping(props.serverUrl).catch(() => undefined))
  }

  onMount(() => {
    void refresh()
    void ping()
    const statusTimer = setInterval(() => void refresh(), STATUS_POLL_MS)
    const pingTimer = setInterval(() => void ping(), PING_POLL_MS)
    onCleanup(() => {
      clearInterval(statusTimer)
      clearInterval(pingTimer)
    })
  })

  const toggle = async (enabled: boolean) => {
    const engine = preview()
    if (!engine) return
    setState("pending", true)
    setState("failed", false)
    try {
      setState("status", await engine.setEnabled(enabled))
      await ping()
    } catch {
      setState("failed", true)
      await refresh()
    } finally {
      setState("pending", false)
    }
  }

  const statusLine = () => {
    if (!state.status) return language.t("settings.rustEngine.status.loading")
    if (!state.status.running) return language.t("settings.rustEngine.status.stopped")
    return language.t("settings.rustEngine.status.running", {
      port: state.status.port ?? "",
      version: state.status.version ?? "?",
    })
  }

  const latency = (value: { ms: number; ok: boolean } | undefined) =>
    value ? language.t("settings.rustEngine.latency.value", { ms: value.ms }) : language.t("settings.rustEngine.latency.unavailable")

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.rustEngine")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.rustEngine.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <div class="settings-section">
          <h3 class="settings-section-title">{language.t("settings.rustEngine.section")}</h3>
          <SettingsList>
            <SettingsRow
              title={language.t("settings.rustEngine.toggle.title")}
              description={language.t("settings.rustEngine.toggle.description")}
            >
              <div data-action="settings-rust-engine">
                <Switch checked={state.status?.enabled ?? false} disabled={state.pending} onChange={toggle} />
              </div>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.rustEngine.status.title")}
              description={state.status?.error ?? statusLine()}
            >
              <span class="text-11-regular text-v2-text-text-muted" data-slot="rust-engine-status">
                {statusLine()}
              </span>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.rustEngine.routes.title")}
              description={
                state.status
                  ? language.t("settings.rustEngine.routes.summary", {
                      ported: state.status.routes.portedMatched,
                      total: state.status.routes.portedTotal,
                      v2: state.status.routes.v2Total,
                    })
                  : language.t("settings.rustEngine.status.loading")
              }
            >
              <span class="text-11-regular text-v2-text-text-muted" data-slot="rust-engine-routes">
                <Show
                  when={state.status && state.status.routes.beyondV2.length > 0}
                  fallback={language.t("settings.rustEngine.routes.all")}
                >
                  {language.t("settings.rustEngine.routes.beyond", {
                    routes: state.status?.routes.beyondV2.join(", ") ?? "",
                  })}
                </Show>
              </span>
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.rustEngine.latency.title")}
              description={language.t("settings.rustEngine.latency.description")}
            >
              <span class="text-11-regular text-v2-text-text-muted" data-slot="rust-engine-latency">
                {language.t("settings.rustEngine.latency.rust", { ms: latency(state.latency?.rust) })} ·{" "}
                {language.t("settings.rustEngine.latency.ts", { ms: latency(state.latency?.ts) })}
              </span>
            </SettingsRow>
          </SettingsList>
          <Show when={state.failed}>
            <p class="text-11-regular text-v2-text-text-muted">{language.t("settings.rustEngine.toggle.failed")}</p>
          </Show>
        </div>
      </div>
    </>
  )
}
