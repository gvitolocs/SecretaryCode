// Provider and MCP settings carry over from the owner's OpenCode config. Old executable plugins need an
// explicit v2 migration; loading them blindly prevents the entire engine from starting.
const imported = ["model", "provider", "providers", "disabled_providers", "enabled_providers", "mcp"]

/**
 * The first-run engine config. Lucina itself is not written here: the engine's built-in Lucina plugin adds
 * the `lucina` MCP server and agent, reading its token from LUCINA_MCP_TOKEN or the engine credential store.
 * An imported `lucina` server is kept as the owner wrote it and replaces that default.
 */
export function engineConfig(previous: unknown) {
  const source = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([key, value]) => imported.includes(key) && value !== undefined),
    ),
    update: "disable",
    share: "disabled",
  }
}
