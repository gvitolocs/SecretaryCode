import { expect, test } from "bun:test"
import { engineConfig } from "./engine-config"

const defaults = { update: "disable", share: "disabled" }
const lucina = {
  type: "remote",
  url: "https://lucina.example/mcp",
  headers: { Authorization: "Bearer {env:MY_TOKEN}" },
}

test("first-run engine config imports provider and MCP settings only, keeping a user lucina server", () => {
  const cases: Array<[string, unknown, Record<string, unknown>]> = [
    ["no previous config", undefined, defaults],
    ["not an object", ["model"], defaults],
    [
      "providers and plugins",
      { model: "anthropic/claude", provider: { anthropic: {} }, plugin: ["old-plugin"], theme: "dark", share: "auto" },
      { model: "anthropic/claude", provider: { anthropic: {} }, ...defaults },
    ],
    ["v2 lucina server", { mcp: { servers: { lucina } } }, { mcp: { servers: { lucina } }, ...defaults }],
    [
      "v1 lucina server",
      { mcp: { lucina: { ...lucina, enabled: true } } },
      { mcp: { lucina: { ...lucina, enabled: true } }, ...defaults },
    ],
  ]
  for (const [name, previous, expected] of cases)
    expect({ name, config: engineConfig(previous) }).toEqual({ name, config: expected })
})
