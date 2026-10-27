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

- Mac verification (2026-10-27): `cargo test --workspace` — **92 passed, 0 failed**. This includes the previously hanging child-session test, concurrent session reads and duplicate prompt admission, permission rules, SQLite roundtrips, and byte-fragmented SSE parsing for both provider protocols.
- Native ARM64 release smoke on this Mac: CLI → server → local scripted provider → shell tool → persisted transcript → server restart passed. A second run with default permissions refused the shell command and preserved that error across restart. Assistant timestamps now serialize once, fixing history reopening.
- Fixed the imported snapshot's compilation failures in streaming parsers and server run options. Parent and child runs now hold the shared store lock only during individual store operations; model and tool work releases it. The server rejects simultaneous prompts for the same session with HTTP 409 and removes abort registrations when execution finishes.
- The installed **Secretary Code** app continues to use the complete Bun/TypeScript engine. This Rust subtree is experimental and is not yet a compatible replacement for the desktop service.

## What v0.2 ports (the agent runtime)

| Piece | Ported from (source of truth) |
| --- | --- |
| `oc-schema` messages | `packages/schema/src/session-message.ts` — full union (user / assistant with content parts / synthetic / system / agent-switched / model-switched / idle), `ToolState` running/completed/error, `Session.Error`, `LLM.FinishReason` |
| `oc-tools` | `packages/core/src/tool/plugin/*.ts` — bash, read, write, edit, glob, grep, todowrite, webfetch; names + descriptions verbatim from the plugins |
| `oc-provider` | `packages/ai/src/protocols/openai-chat.ts` + `anthropic-messages.ts` — non-streaming request/response both ways, tool calls, usage + finish-reason mapping; standalone SSE decoder for OpenAI and Anthropic (not yet connected to the HTTP client or agent loop) |
| `oc-agent` | `packages/core/src/session/runner/` — the step loop, per-step assistant messages, tool settlement (running → completed/error, in place), `MAX_STEPS_PROMPT` gate (verbatim) + `toolChoice: none`, transcript mapping per `to-llm-message.ts` (synthetic → user role, idle/agent-switched dropped, executed tool parts → tool results), AGENTS.md instruction loading |
| `oc-store` v0.2 | session surface + JSON-file persistence under `OC_DATA` (`session/sessions.json` + `session/message/<id>.json`, atomic tmp+rename). An optional `Store::open_sqlite` document backend is available in the library; the server still uses JSON files, unlike upstream Effect/drizzle |
| `oc-permission` | upstream JSON rule arrays, action/resource wildcards, last match wins; unmatched rules require approval. Headless runs refuse both `ask` and `deny`. |
| `oc-server` v0.2 | + `POST /api/session/:id/message` (full turn, returns transcript + outcome), `POST /api/session/:id/abort` |
| `oc-cli` v0.2 | + `ask` (one-shot session), `run`, `abort` |

## Permissions

The server accepts an explicit rules array through `OC_PERMISSIONS`. For example,
`OC_PERMISSIONS='[{"action":"read","resource":"*","effect":"allow"}]'`
permits reads while unmatched operations require approval. This experimental
headless server cannot present approval requests, so those tool calls return an
error to the model. Defaults do not implicitly approve tools. Rule names use the
tool's actual name, such as `shell`, `read`, or `write`.

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

HTTP streaming transport/client wiring (the standalone SSE decoder exists,
but the agent still uses non-streaming completions), provider retry ladder,
compaction, hosted tools, patch/skill/MCP tools, interactive permission approval,
pricing/cost (tokens accumulate, cost stays 0), TUI, plugins, upstream SQL
schema/migrations. The task tool is available as a library component with child
sessions and one-level delegation, but is not registered by the server. SQLite
storage is available as a document backend in the library; server wiring still
uses JSON files. Server events are published after the prompt finishes, not as
live token updates. The server also lacks the desktop service's authentication,
registration, project configuration and full API surface.

The prompt path is now the real one: user message → model → tool calls →
executed against the workspace → settled into the transcript → next step →
final text, with every message persisted and abortable.
