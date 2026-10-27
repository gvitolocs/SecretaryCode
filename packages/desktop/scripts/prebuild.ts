#!/usr/bin/env bun
import { $ } from "bun"

import { copyBuiltCliToResources, downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()

if (channel === "prod" && !Bun.env.OPENCODE_CLI_DIST) {
  throw new Error("OPENCODE_CLI_DIST is required for production desktop builds")
}

await $`bun ./scripts/copy-icons.ts ${channel}`

await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`bun ./scripts/build-recorder.ts`

// The Rust port ships as an opt-in preview; SECRETARY_SKIP_ENGINE_RS keeps a build from paying for cargo.
if (Bun.env.SECRETARY_SKIP_ENGINE_RS === "1") console.log("Skipping engine-rs (SECRETARY_SKIP_ENGINE_RS=1)")
else await $`bun ./scripts/build-engine-rs.ts`

// Lucina's web app ships inside the app (resources/lucina-web); SECRETARY_SKIP_LUCINA_WEB=1 loads it live instead.
await $`bun ./scripts/bundle-lucina-web.ts`

if (channel === "dev") await downloadCliToResources()

if ((channel === "beta" || channel === "prod") && Bun.env.OPENCODE_CLI_DIST) {
  await copyBuiltCliToResources(Bun.env.OPENCODE_CLI_DIST)
}

if (channel === "beta" && !Bun.env.OPENCODE_CLI_DIST) await downloadCliToResources("beta")
