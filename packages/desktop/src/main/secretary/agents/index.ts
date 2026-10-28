import { app } from "electron"
import path from "node:path"
import { SidecarCredentials } from "../../service/sidecar-credentials"
import { getStore } from "../../storage/store"
import { secretaryToken } from "../index"
import { logOnce, type AgentsTransport } from "./client"

/** secretary-server, authenticated with this Mac's Secretary device token. */
const ORIGIN = "https://getsecretary.tech"

const ENABLED_KEY = "agentsMirror"

type Running = { sidecar: SidecarCredentials.Data; stop: () => Promise<void> }

// Starts and stops run one at a time: the engine's first endpoint and the window's ready event can arrive together.
const state: { enabled: boolean; running?: Running; queue: Promise<void> } = { enabled: false, queue: Promise.resolve() }

/**
 * "Mirror coding sessions to Lucina": on unless the user turned it off. Failures back off and are logged once each;
 * the coding session never waits on Lucina. In development,
 * `SECRETARY_AGENTS_FAKE=1` turns it on against the in-memory server and logs what would be sent;
 * `SECRETARY_AGENTS_URL` points it at another server. Starts once the engine is ready, follows reconnects,
 * and stops on quit.
 */
export function setupAgentsMirror() {
  const stored = getStore().get(ENABLED_KEY)

  state.enabled = fake() || stored !== false
  SidecarCredentials.subscribe((sidecar) => void restart(sidecar))
  void app.whenReady().then(() => {
    const sidecar = SidecarCredentials.get()

    if (sidecar) void restart(sidecar)
  })
  app.on("before-quit", () => void stop())
}

export function agentsMirrorSettings() {
  return { enabled: state.enabled }
}

export function setAgentsMirrorEnabled(enabled: boolean) {
  state.enabled = enabled
  getStore().set(ENABLED_KEY, enabled)
  const sidecar = SidecarCredentials.get()

  if (enabled && sidecar) void restart(sidecar)
  if (!enabled) void stop()
  return { enabled }
}

function restart(sidecar: SidecarCredentials.Data) {
  return run(async () => {
    const current = state.running

    // The same engine endpoint is already mirrored.
    if (state.enabled && current?.sidecar.url === sidecar.url && current.sidecar.password === sidecar.password) return
    state.running = undefined
    await current?.stop()
    if (state.enabled) state.running = await start(sidecar)
  })
}

function stop() {
  return run(async () => {
    const current = state.running

    state.running = undefined
    await current?.stop()
  })
}

function run(task: () => Promise<void>) {
  state.queue = state.queue.then(task).catch((error: unknown) => console.error("agents mirror", error))
  return state.queue
}

async function start(sidecar: SidecarCredentials.Data): Promise<Running> {
  const [{ OpenCode }, { createHttpTransport }, { FakeAgentsTransport }, { createEngine }, { startMirrorService }, { openStore }] =
    await Promise.all([
      import("@opencode/client/promise"),
      import("./client"),
      import("./fake"),
      import("./engine"),
      import("./service"),
      import("./store"),
    ])
  const authorization = SidecarCredentials.authorization(sidecar, sidecar.url)
  const client = OpenCode.make({ baseUrl: sidecar.url, headers: authorization ? { Authorization: authorization } : undefined })
  const transport = fake()
    ? logged(new FakeAgentsTransport())
    : createHttpTransport({ baseURL: (!app.isPackaged && process.env.SECRETARY_AGENTS_URL) || ORIGIN, token: secretaryToken })
  const service = startMirrorService({
    transport,
    // The fake keeps its own agents, so it must not reuse (or overwrite) the real server's mapping.
    store: await openStore(path.join(app.getPath("userData"), fake() ? "secretary-agents.fake.json" : "secretary-agents.json")),
    engine: createEngine(client),
    events: (signal) => client.event.subscribe({ signal }),
    onError: logOnce((message) => console.warn("agents mirror", message)),
  })

  return { sidecar, stop: service.stop }
}

function fake() {
  return !app.isPackaged && process.env.SECRETARY_AGENTS_FAKE === "1"
}

/** The fake server's traffic in the main-process log, so a development run shows what Lucina would receive. */
function logged(transport: AgentsTransport) {
  const post = transport.postEvents.bind(transport)

  transport.postEvents = (agentId, events) => {
    console.info("agents mirror →", agentId, events.map((event) => event.type).join(", "))
    return post(agentId, events)
  }
  return transport
}
