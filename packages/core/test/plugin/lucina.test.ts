import { describe, expect } from "bun:test"
import { Document, Info } from "@opencode/schema/config"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import type { Mcp as McpSchema } from "@opencode/schema/mcp"
import { Effect, Layer, type Types } from "effect"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { ConfigMcpPlugin } from "@opencode/core/config/plugin/mcp"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Mcp } from "@opencode/core/mcp/index"
import { Plugin } from "@opencode/core/plugin"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { PluginHost } from "@opencode/core/plugin/host"
import { LucinaPlugin } from "@opencode/core/plugin/lucina"
import { Bus } from "@opencode/core/bus"
import { withEnv } from "../fixture/env"
import { emptyMcp } from "../fixture/mcp"
import { drain } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

// Applies the registered MCP transforms in order, like the MCP service does on reload.
function recorder() {
  const transforms: Array<(editor: Mcp.Editor) => void> = []
  const state = { reloads: 0 }
  const servers = () => {
    const configured = new Map<string, Types.DeepMutable<McpSchema.ServerConfig>>()
    transforms.forEach((transform) =>
      transform({
        list: () => Array.from(configured, ([name, config]) => [Mcp.ServerName.make(name), config] as const),
        get: (name) => configured.get(name),
        set: (name, config) =>
          configured.set(name, structuredClone(config) as Types.DeepMutable<McpSchema.ServerConfig>),
        update: (name, update) => {
          const config = configured.get(name)
          if (config) update(config)
        },
        remove: (name) => configured.delete(name),
      }),
    )
    return Object.fromEntries(configured)
  }
  const layer = Layer.succeed(
    Mcp.Service,
    Mcp.Service.of({
      ...emptyMcp,
      transform: (transform) =>
        Effect.sync(() => {
          transforms.push(transform)
          return { dispose: Effect.void }
        }),
      reload: () =>
        Effect.sync(() => {
          state.reloads++
        }),
    }),
  )
  return { servers, state, layer }
}

// Mirrors plugin activation order: config servers first, then the Lucina defaults.
const activate = Effect.fn(function* () {
  const bus = yield* Bus.Service
  const host = yield* PluginHost.make(yield* Plugin.Service)
  yield* ConfigMcpPlugin.register(bus.subscribe())
  yield* AgentPlugin.Plugin.effect(host)
  yield* LucinaPlugin.Plugin.effect(host)
})

describe("Lucina defaults", () => {
  it.effect("keeps the default server disabled with an add-token integration when no token exists", () =>
    withEnv({ LUCINA_MCP_TOKEN: undefined }, () =>
      Effect.gen(function* () {
        const mcp = recorder()
        yield* activate().pipe(Effect.provide(mcp.layer))

        expect(mcp.servers()).toEqual({
          lucina: { type: "remote", url: "https://getsecretary.tech/mcp", oauth: false, disabled: true },
        })
        const integration = yield* (yield* Integration.Service).get(LucinaPlugin.integrationID)
        expect(integration?.name).toBe("Lucina")
        expect(integration?.methods).toEqual([
          { type: "key", label: "Lucina MCP token" },
          { type: "env", names: ["LUCINA_MCP_TOKEN"] },
        ])
        expect(integration?.connections).toEqual([])
      }),
    ),
  )

  it.effect("sends LUCINA_MCP_TOKEN as the bearer header", () =>
    withEnv({ LUCINA_MCP_TOKEN: "env-token" }, () =>
      Effect.gen(function* () {
        const mcp = recorder()
        yield* activate().pipe(Effect.provide(mcp.layer))

        expect(mcp.servers()).toEqual({
          lucina: {
            type: "remote",
            url: "https://getsecretary.tech/mcp",
            oauth: false,
            headers: { Authorization: "Bearer env-token" },
          },
        })
      }),
    ),
  )

  it.effect("enables the server once a token is saved in the credential store", () =>
    withEnv({ LUCINA_MCP_TOKEN: undefined }, () =>
      Effect.gen(function* () {
        const mcp = recorder()
        yield* activate().pipe(Effect.provide(mcp.layer))
        expect(mcp.servers().lucina?.disabled).toBe(true)

        yield* (yield* Integration.Service).connection.key({ integrationID: LucinaPlugin.integrationID, key: "stored" })
        yield* drain

        expect(mcp.state.reloads).toBe(1)
        expect(mcp.servers().lucina).toEqual({
          type: "remote",
          url: "https://getsecretary.tech/mcp",
          oauth: false,
          headers: { Authorization: "Bearer stored" },
        })

        // Unrelated credential changes resolve the same token and do not reconnect the server.
        yield* (yield* Credential.Service).create({
          integrationID: Integration.ID.make("other"),
          value: Credential.Key.make({ type: "key", key: "other" }),
        })
        yield* drain
        expect(mcp.state.reloads).toBe(1)
      }),
    ),
  )

  it.effect("leaves a user-configured lucina server untouched", () =>
    withEnv({ LUCINA_MCP_TOKEN: "env-token" }, () =>
      Effect.gen(function* () {
        const user = new ConfigMCP.Remote({
          type: "remote",
          url: "https://lucina.example/mcp",
          headers: { Authorization: "Bearer user" },
        })
        yield* (yield* Config.Test).setEntries([
          new Document({
            type: "document",
            info: new Info({ mcp: new ConfigMCP.Info({ servers: { lucina: user } }) }),
          }),
        ])
        const mcp = recorder()
        yield* activate().pipe(Effect.provide(mcp.layer))

        expect(mcp.servers()).toEqual({
          lucina: {
            type: "remote",
            url: "https://lucina.example/mcp",
            headers: { Authorization: "Bearer user" },
            timeout: {},
          },
        })
      }),
    ),
  )

  it.effect("registers Lucina as a primary agent beside build without pinning a model", () =>
    Effect.gen(function* () {
      const mcp = recorder()
      yield* activate().pipe(Effect.provide(mcp.layer))
      const agents = yield* Agent.Service
      const lucina = yield* agents.get(LucinaPlugin.agentID)

      expect((yield* agents.list()).map((item) => String(item.id))).toContain("build")
      expect(lucina?.name).toBe(Agent.Name.make("Lucina"))
      expect(lucina?.mode).toBe("primary")
      expect(lucina?.hidden).toBe(false)
      expect(lucina?.model).toBeUndefined()
      expect(lucina?.system).toContain("lucina MCP tools")
      expect((yield* agents.select(undefined)).id).toBe(Agent.defaultID)
    }),
  )
})
