# opencode-rust — OpenCode v2 core, ported to Rust

Rust migration of **OpenCode** (the open-source coding agent), forked from
[anomalyco/opencode](https://github.com/anomalyco/opencode) at tag
**v2.1.4** and carried in **[gvitolocs/opencode](https://github.com/gvitolocs/opencode)**
(commit `68bc26b`, "release: v2.1.4"). The fork is the long-term
open-source base; this workspace ports its core surface to Rust.

**Source of truth:** the fork's TypeScript source at
`/home/nez/Projects/AI/opencode-fork` (Bun/TypeScript monorepo: `packages/core`
= 428 ts files, `packages/schema`, `packages/protocol`, `packages/server`).
Every type, field name, ID scheme and route below was read out of that
source — not invented. Where the port stops short, the fidelity matrix says
so.

## Status

- `cargo test --workspace`: **245 passed, 0 failed** (153 before oc-claude). The CLI's 8 run whole
  turns against in-process mock streams: tool calls split across deltas,
  reasoning kept out of the text, `edit` + `shell`, Ctrl+C killing a running
  command's process group, a stream cut short and retried, a refused request
  failing at once with its reason, compaction, and `chat` (session across
  turns, `y/N` before acting, `/new`, `/exit`).
- **Against real Qwen** (2026-11-02, nezopt, Qwen 3.8 27B through the gateway,
  thinking medium): `oc-cli ask` fixed two real bugs in a scratch crate in 21 s:
  read the code, one `edit`, `cargo test` (2 passed), 4 steps, 11,070 tokens in,
  615 out.
- Static aarch64 build:
  `cargo build -p oc-cli --no-default-features --profile juno-app
  --target aarch64-unknown-linux-musl` makes one stripped static file of 4.5 MB,
  with `oc-tunnel` inside and no `libsqlite3-sys` in its dependency tree.
- **On Juno** (LucinaOS on the Galaxy Book Go, real kernel, 2026-11-02): the
  forward to the gateway, and a scripted 7-step turn using `read`, `edit`, `shell`
  under BusyBox, `glob`, `grep` without `rg`, and `write`. With real Qwen on the
  laptop: `chat` ran a failing test, read the script, edited it and ran the test
  again (PASS), 4 steps in 25 s; Ctrl+C stopped a turn; `oc-cli chat` used 3.4 MB
  and the tunnel 3.1 MB (`VmRSS`). Reconnecting and compaction on the laptop are
  not proven yet.

## LucinaOS readiness (2026-11-04)

The active implementation includes the newer `baef556` work that was only in
an older detached checkout; `main` and `SecretaryCode/engine-rs` are older copies.
Use this branch's code and the pinned Juno package, not those older snapshots.

- Direct Mistral: with `MISTRAL_API_KEY` set, `oc-cli chat` selects Mistral's
  OpenAI-compatible endpoint and `mistral-small-latest`. Explicit `OC_PROVIDER`,
  `OC_BASE_URL`, `OC_MODEL`, or `OC_API_KEY_FILE` override defaults. No model
  server or SSH tunnel is needed for cloud Mistral. Credentials are not logged.
- `shell` accepts `background: true`; `job` supports status, output, list, and
  cancel. Output is bounded; ownership is session-scoped and process-local.
  Registry shutdown kills running jobs. Jobs do not survive restarting the CLI.
- The `task` child-agent tool is registered in embedded CLI and server. Children
  inherit permission rules, approval callback, cancellation, retries and
  compaction settings; delegation is limited to one level.
- Server reads stay responsive during model/tool execution; duplicate prompts
  for a running session return 409. `/event` carries `session.progress` for
  live text, reasoning, tools, retries and compaction. Final transcript events
  remain `message.updated`. Interactive server approvals and full desktop API
  compatibility are still absent.
- Static ARM64 binary deployed to Juno: 4.3 MiB. Direct Mistral read/edit/test
  succeeded on the live laptop with normal edit/shell approval prompts.

For measurements, methodology and limitations, see [bench/README.md](bench/README.md).

## Claude Code projects (oc-claude, 2026-11-07)

Embedded `oc-cli --local ask|chat` runs Claude Code projects as they are: the
CLAUDE.md hierarchy (rules, `@imports`, AGENTS.md fallback), `settings.json`
precedence with `env`, `model` and `permissions` (Claude Code's rule syntax,
deny → ask → allow, modes), hooks (PreToolUse, PostToolUse, UserPromptSubmit,
Stop, SubagentStop, SessionStart, SessionEnd, PreCompact, Notification),
skills and `.claude/commands` (the `skill` tool and `/name args`), subagents
in `.claude/agents` (through the `task` tool), MCP servers from `.mcp.json` and
`~/.claude.json`, and `--plugin-dir` plugins. It is a clean-room build from
Claude Code's public docs; [docs/claude-code-compat.md](docs/claude-code-compat.md)
is the fidelity matrix (behaviour, doc page, status, test).
`OC_CLAUDE_COMPAT=off` or `--no-claude` turns it off.

## What v0.2 ports (the agent runtime)

| Piece | Ported from (source of truth) |
| --- | --- |
| `oc-schema` messages | `packages/schema/src/session-message.ts` — full union (user / assistant with content parts / synthetic / system / agent-switched / model-switched / idle), `ToolState` running/completed/error, `Session.Error`, `LLM.FinishReason` |
| `oc-tools` | `packages/core/src/tool/plugin/*.ts` — `shell`, read, write, edit, glob, grep, todowrite, webfetch; names + descriptions adapted from the plugins (`shell` follows `tool/plugin/shell.ts` and `shell/select.ts`) |
| `oc-provider` | `packages/ai/src/protocols/openai-chat.ts` + `anthropic-messages.ts` — request/response both ways, SSE streaming, tool calls, required finish reasons, usage mapping, `OC_EXTRA_BODY` |
| `oc-agent` | `packages/core/src/session/runner/` — streamed step loop with text/reasoning/tool events, per-step assistant messages, tool settlement (running → completed/error, in place), permission ask/deny before execution, `MAX_STEPS_PROMPT` gate (verbatim) + `toolChoice: none`, transcript mapping per `to-llm-message.ts`, environment/date/AGENTS.md system prompt, subagent `task` tool |
| `oc-store` v0.2 | session surface + JSON-file persistence under `OC_DATA` (`session/sessions.json` + `session/message/<id>.json`, atomic tmp+rename) and optional SQLite document rows (`sqlite` feature, off for the CLI binary) |
| `oc-server` v0.2 | + `POST /api/session/:id/message` (full turn, returns transcript + outcome), `POST /api/session/:id/abort` |
| `oc-cli` v0.2 | server client (`new`/`list`/`get`/`ask`/`run`/`abort`/`synth`/`events`) plus embedded `--local` mode: `ask <text> [dir]` and a streaming `chat [dir]` REPL, with `OC_DATA`, permission prompts and SIGINT abort |

## Run

```bash
# server with persistence + tools + a real model
export OC_DATA=~/.local/share/oc-rust OC_WORKTREE=$PWD
export OC_PROVIDER=openai OC_BASE_URL=https://api.openai.com/v1 OC_API_KEY=sk-...
export OC_MODEL=openai/gpt-4o-mini OC_MAX_STEPS=32
cargo run -p oc-server             # v2 API subset on 127.0.0.1:18212

cargo run -p oc-cli new "title"    # create a session (server client)
cargo run -p oc-cli list           # list sessions (newest first)
cargo run -p oc-cli ask "create hello.py that prints hi"   # one-shot agent turn
cargo run -p oc-cli run <id> "now make it take a name argument"
cargo run -p oc-cli events         # SSE feed
cargo run -p oc-cli -- --local chat    # embedded REPL, no server process
# embedded ask: OC_BASE unset + OC_BASE_URL set, or pass --local
# env: OC_BIND, OC_BASE, OC_DATA, OC_PERMISSIONS, OC_SHOW_THINKING, OC_VERBOSE,
#      OC_API_KEY_FILE, OC_EXTRA_BODY, OC_CONTEXT_WINDOW, OC_COMPACT_BUFFER, OC_COMPACT_KEEP,
#      OC_REASONING_REPLAY (on unless off/0/false/no), OC_TRACE (timing log; off, or a file)
```

Embedded permissions follow upstream's fallback: anything no rule allows asks.
`chat` asks `y/N`; `ask` refuses, unless `OC_PERMISSIONS` allows it.

## The model on another machine

`oc-tunnel` (also `oc-cli tunnel`) is `ssh -NT -L` for a machine with no ssh
client: russh on ring, ed25519, the server's key always pinned. A session comes
up when a connection needs it and again after a drop; routes are tried in order.

```bash
oc-cli tunnel keygen ~/.config/oc/tunnel_key    # prints only the public line
# on the server, for that key:
#   restrict,port-forwarding,permitopen="127.0.0.1:11436",from="192.168.178.0/24",command="/usr/sbin/nologin" ssh-ed25519 AAAA...
oc-cli tunnel run --key ~/.config/oc/tunnel_key --known-host 'ssh-ed25519 AAAA...' --route user@server &
OC_BASE_URL=http://127.0.0.1:11436/v1 oc-cli chat
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
| `oc-tunnel` | no upstream: OpenSSH's `-L` behaviour (`ExitOnForwardFailure`, `ServerAliveInterval=30`, `ServerAliveCountMax=3`) on russh |
| `oc-cli` | the CLI/TUI's API calls as a thin reqwest client; embedded mode ports `cli/src/run/noninteractive.ts` plus the line REPL |

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

Hosted tools, patch/skill tools, the MCP bridge in the CLI/server (the crate is
tested standalone), pricing/cost (tokens accumulate, cost stays 0), the full-screen
TUI (`chat` is a line REPL), plugins, background summary precomputation and
native provider compaction. Shell background jobs and the one-level `task` tool
are registered. SQLite is behind `oc-store`'s `sqlite` feature (server on, CLI
off). Both CLI and server use the retry ladder and streaming runner.

### Reasoning and output-limit stops (as upstream)

- **Reasoning replay.** Earlier readable reasoning goes back on later requests
  as `reasoning_content` (`to-llm-message.ts` + `protocols/openai-chat.ts`), for
  any model, on by default. llama.cpp hands it to the chat template, so Qwen
  keeps its own analysis between tool steps instead of redoing it. A failed
  message gives its reasoning back as text. Compaction counts reasoning towards
  the window and leaves it out of the summary. Anthropic thinking blocks need
  signatures the port does not keep, so they are not replayed (delta).
- **`finish_reason: length` / `max_tokens` is not success** (`runner/llm.ts`
  `OutputLimit`). The turn continues: tool results go back as usual, or, with
  no tool call, upstream's "Break the remaining work into smaller pieces"
  nudge. Three truncated responses in a row fail the turn with "Response still
  truncated after two output token limit continuations".
- **Cut-off tool calls never run** (`publish-llm-event.ts` `INPUT_FAILURES`).
  The model gets upstream's "not executed" error instead. The port is stricter
  in one place: the last call of a truncated response never runs even when its
  arguments parse, because servers can close partial JSON when they stop.
  Arguments that are not a JSON object never run (before, they ran with `null`).

The prompt path is now the real one: user message → model → tool calls →
executed against the workspace → settled into the transcript → next step →
final text, with every message persisted and abortable.

## Benchmarks (2026-10-26, nezopt, same box/client)