export * as LucinaPlugin from "./lucina.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Agent } from "@opencode/schema/agent"
import { Effect, Stream } from "effect"
import { Bus } from "../bus.js"
import { Credential } from "../credential.js"
import { Integration } from "../integration.js"

export const server = "lucina"
export const url = "https://getsecretary.tech/mcp"
export const integrationID = Integration.ID.make("lucina")
export const tokenEnv = "LUCINA_MCP_TOKEN"
export const agentID = Agent.ID.make("lucina")

const PROMPT_LUCINA = `You are Lucina, the owner's personal assistant inside Secretary Code.

Voice:
- Be concise and warm. Answer in the user's language. Prefer a short, direct reply over a long one.
- Speak as yourself, in the first person. Do not describe yourself as a language model or name the model you run on.

Memory and personal organization:
- Use the lucina MCP tools for anything about the owner's life and work outside the code in front of you: memory and preferences, notes, reminders, tasks, shopping lists and the calendar.
- Before answering a question about something the owner told you earlier, look it up with those tools instead of guessing.
- When the owner asks you to remember, note, remind, schedule, buy or track something, save it with the matching tool, then confirm briefly what you saved.
- If the lucina tools are not available, say so plainly: the Lucina connection needs a token, which the owner can add by setting ${tokenEnv} or saving a token for the Lucina integration. Then help as far as you can without them.

Everything else:
- You can read the open project and use the other tools you are given, but ask before changing files or running commands that change state.
- Never reveal tokens, passwords or other secrets you come across.`

/**
 * Secretary Code defaults: the Lucina MCP server and the Lucina agent.
 *
 * The server's token comes from the `lucina` integration, which resolves a stored key credential or
 * `LUCINA_MCP_TOKEN`. Without one the server stays disabled instead of failing its connection, and the
 * integration lists the methods that add a token. A `lucina` server in user config replaces this default.
 */
export const Plugin = define({
  id: "opencode.lucina",
  effect: Effect.fn(function* (ctx) {
    const bus = yield* Bus.Service
    const state = { token: undefined as string | undefined }

    yield* ctx.integration.transform((editor) => {
      editor.update(integrationID, (integration) => {
        integration.name = "Lucina"
      })
      editor.method.update({ integrationID, method: { type: "key", label: "Lucina MCP token" } })
      editor.method.update({ integrationID, method: { type: "env", names: [tokenEnv] } })
    })

    const resolve = Effect.fnUntraced(function* () {
      const connection = yield* ctx.integration.connection.active(integrationID)
      if (!connection) return undefined
      const credential = yield* ctx.integration.connection
        .resolve(connection)
        .pipe(Effect.orElseSucceed(() => undefined))
      return credential?.type === "key" && credential.key.trim() ? credential.key.trim() : undefined
    })

    state.token = yield* resolve()
    yield* ctx.mcp.transform((editor) => {
      // A server the user configured under the same name wins, including one imported from OpenCode.
      if (editor.get(server)) return
      editor.set(
        server,
        state.token
          ? { type: "remote", url, oauth: false, headers: { Authorization: `Bearer ${state.token}` } }
          : { type: "remote", url, oauth: false, disabled: true },
      )
    })

    // Adding, switching or removing the token reconnects the default server without a restart.
    // Updates carry no integration and activation only publishes a switch, so watch both and compare
    // the resolved token before reloading.
    yield* bus.subscribe([Credential.Event.Updated, Credential.Event.Switched]).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const token = yield* resolve()
          if (token === state.token) return
          state.token = token
          yield* ctx.mcp.reload()
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.agent.transform((editor) => {
      editor.update(agentID, (item) => {
        item.name = Agent.Name.make("Lucina")
        item.description =
          "The owner's assistant Lucina. Keeps memory, notes, reminders, tasks, shopping and calendar through the Lucina MCP server."
        item.mode = "primary"
        item.system = PROMPT_LUCINA
        // No model is pinned: Lucina runs on whichever provider and model the user selected.
        item.permissions.push(
          { action: "question", resource: "*", effect: "allow" },
          { action: "edit", resource: "*", effect: "ask" },
          { action: "shell", resource: "*", effect: "ask" },
        )
      })
    })
  }),
})
