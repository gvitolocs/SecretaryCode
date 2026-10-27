# opencode-rust — OpenCode v2 core, ported to Rust

Rust migration of **OpenCode** (the open-source coding agent), forked from
[anomalyco/opencode](https://github.com/anomalyco/opencode) at tag
**v2.1.4** and carried in **[gvitolocs/opencode](https://github.com/gvitolocs/opencode)**
(commit `68bc26b`, "release: v2.1.4"). The fork is the long-term
open-source base; this workspace ports its core surface to Rust.

**Source of truth:** the fork's TypeScript source at
`/home/nez/Projects/opencode-fork` (Bun/TypeScript monorepo: `packages/core`
= 428 ts files, `packages/schema`, `packages/protocol`, `packages/server`).
Every type, field name, ID scheme and route below was read out of that
source — not invented. Where the port stops short, the fidelity matrix says
so.

## Status

- `cargo test --workspace`: **81 passed, 0 failed** (schema 10, store 13 incl.
  persistence roundtrip, bus 4, provider 30, tools 13, agent 6 incl. the
  MAX_STEPS gate + abort + provider-failure paths, server 5)
- Live smoke (2026-10-27, on-box): `oc-cli ask` against a scripted
  OpenAI-compatible endpoint ran a real 2-step turn — the shell tool executed
  (`printf ... > smoke.txt` in the session worktree), the transcript recorded
  the tool part `completed` with its exact input, the session landed
  `succeeded` with tokens accumulated, and the JSON persistence files exist.
  See `bench/mock_llm.py`.

## What v0.2 ports (the agent runtime)

| Piece | Ported from (source of truth) |
| --- | --- |
| `oc-schema` messages | `packages/schema/src/session-message.ts` — full union (user / assistant with content parts / synthetic / system / agent-switched / model-switched / idle), `ToolState` running/completed/error, `Session.Error`, `LLM.FinishReason` |
| `oc-tools` | `packages/core/src/tool/plugin/*.ts` — bash, read, write, edit, glob, grep, todowrite, webfetch; names + descriptions verbatim from the plugins |
| `oc-provider` | `packages/ai/src/protocols/openai-chat.ts` + `anthropic-messages.ts` — non-streaming request/response both ways, tool calls, usage + finish-reason mapping |
| `oc-agent` | `packages/core/src/session/runner/` — the step loop, per-step assistant messages, tool settlement (running → completed/error, in place), `MAX_STEPS_PROMPT` gate (verbatim) + `toolChoice: none`, transcript mapping per `to-llm-message.ts` (synthetic → user role, idle/agent-switched dropped, executed tool parts → tool results), AGENTS.md instruction loading |
| `oc-store` v0.2 | session surface + JSON-file persistence under `OC_DATA` (`session/sessions.json` + `session/message/<id>.json`, atomic tmp+rename). Upstream persists through Effect/drizzle into SQLite — documented delta |
| `oc-server` v0.2 | + `POST /api/session/:id/message` (full turn, returns transcript + outcome), `POST /api/session/:id/abort` |
| `oc-cli` v0.2 | + `ask` (one-shot session), `run`, `abort` |

## Run

```bash
# server with persistence + tools + a real model
export OC_DATA=~/.local/share/oc-rust OC_WORKTREE=$PWD
export OC_PROVIDER=openai OC_BASE_URL=https://api.openai.com/v1 OC_API_KEY=sk-...
export OC_MODEL=openai/gpt-4o-mini OC_MAX_STEPS=32
cargo run -p oc-server             # v2 API subset on 127.0.0.1:18212

cargo run -p oc-cli new "title"    # create a session
cargo run -p oc-cli list           # list sessions (newest first)
cargo run -p oc-cli ask "create hello.py that prints hi"   # one-shot agent turn
cargo run -p oc-cli run <id> "now make it take a name argument"
cargo run -p oc-cli events         # SSE feed
# env: OC_BIND, OC_BASE, plus the provider config above
```

Works with any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio,
llama.cpp): `OC_BASE_URL=http://127.0.0.1:11434/v1 OC_MODEL=... `.

## Crates → upstream mapping

| Crate | Ported from (source of truth) |
| --- | --- |
| `oc-schema` | `packages/schema/src/`: `identifier.ts` (26-char IDs, 12-hex sortable prefix, ascending/descending bands), `session-id.ts`/`session-message.ts` (`ses_`/`msg_` + tags), `session.ts` `Info` (full field set incl. `tokens`, `outcome`, `time.{created,updated,idle,viewed,archived}`), `token-usage.ts` (+`total()`), `model.ts` `Ref.parse("provider/model[@variant]")`, `location.ts` `Ref`, `session.list` filter fields |
| `oc-bus` | `packages/core/src/bus.ts` — fan-out event bus; v2 envelope `{"type","properties"}` over a tokio broadcast channel (lag = SSE backpressure) |
| `oc-store` | `packages/core/src/session/` session surface: create/list/get/patch/remove/active/messages + outcome/idle bookkeeping; in-memory where upstream is SQL |
| `oc-server` | `packages/protocol/src/groups/session.ts` route paths, verbatim: `GET/POST /api/session`, `GET/PATCH/DELETE /api/session/:id`, `GET /api/session/active`, `POST /api/session/:id/synthetic`, message listing, SSE `/event` |
| `oc-cli` | the CLI/TUI's API calls, as a thin reqwest client |

## Fidelity notes (verified in source)

- **ID scheme**: 26 chars = 12 hex (48-bit `ms*0x1000+counter`, bitwise
  inverted for `ses_`/descending) + 14 random base62. Because the key is
  inverted, **plain ascending string sort of `ses_` IDs is newest-first** —
  the port relies on the same trick upstream's list order does, and the
  live smoke confirmed it on real IDs.
- **Wire shapes**: camelCase keys (`projectID`, `parentID`, `providerID`),
  message `"type"` tags (`user`, `assistant`, `synthetic`,
  `agent-switched`, `model-switched`) carried inside each message object,
  matching upstream `Schema.tag`.
- **List filters**: `order` (`asc`=oldest first), `search` (title
  substring), `parentID` (exact match; literal `null` = roots only),
  `archived` (`true` → archived only).

## Benchmarks (2026-10-26, nezopt, same box/client)

Mixed session round (POST create → GET → GET list → POST synthetic;
`bench/http-bench.ts`, zero errors) vs the original v2 server
(`bun run src/index.ts serve`, Basic auth):

| Server | conc=1 rounds/s | p50/round | RSS |
| --- | --- | --- | --- |
| Original (TypeScript/Bun, Effect + persistence) | 16.1 | 52.2 ms | 591 MB |
| oc-server debug (axum, in-memory) | 35.1 | 26.0 ms | 25 MB |
| **oc-server release** | **139.2** | **6.8 ms** | — |

- Higher concurrency on *both* servers is bounded by the benchmark client
  and the growing `/api/session` list payload, not server compute
  (original 15–25 rounds/s at conc 4–16; oc-server release 52–65).
- Identifier generation, upstream algorithm vs port (`bench/id-bench.ts`,
  `oc-schema/examples/bench_ids.rs`, 1M ids):
  TS/Bun **1.06 M ids/s** vs Rust **4.99 M ids/s** (4.7×).
- Fairness note: the original runs its full production stack (project
  resolution, SQL persistence, auth middleware); oc-server is the minimal
  ported surface with in-memory storage. The comparison says the ported
  path is fast, not that the Rust port replaces upstream's features.

## Not ported (v0.2 boundary)

Streaming (SSE) provider transport (non-streaming complete calls only),
provider retry ladder, compaction, hosted tools, subagent/task tool,
patch/skill/MCP tools, permission gating (tools run with an implicit allow),
pricing/cost (tokens accumulate, cost stays 0), TUI, plugins, the SQL
persistence layer (JSON files instead — see oc-store header).

The prompt path is now the real one: user message → model → tool calls →
executed against the workspace → settled into the transcript → next step →
final text, with every message persisted and abortable.

## Benchmarks (2026-10-26, nezopt, same box/client)