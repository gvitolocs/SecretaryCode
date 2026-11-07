# Claude Code compatibility (oc-claude)

`oc-cli` in embedded mode (`--local ask|chat`) runs Claude Code projects as they
are: it reads Claude Code's documented configuration and acts on it the way the
documentation says Claude Code does. The code is in `crates/oc-claude` (loading
and semantics), `crates/oc-permission/src/claude*.rs` (rule engine and shell
analysis), `crates/oc-agent/src/hooks.rs` (the runner's hook seam) and
`crates/oc-cli/src/claude.rs` (flags and per-turn steps).

## Clean room

- Every behaviour below comes from Claude Code's public documentation on
  code.claude.com (fetched 2026-11-07, Claude Code v2.1.3xx era). The doc
  pages are cited per row.
- Claude Code's CLI is proprietary ("© Anthropic PBC. All rights reserved").
  No Claude Code program code was opened, decompiled, copied or translated
  (no `cli.js`, no npm package). The public `anthropics/claude-code` repo was
  not needed: the plugin layout comes from the plugins reference page.
- Where the docs say nothing, the behaviour is ours and the matrix says so
  ("ours").

## Turning it on and off

On by default in embedded mode. `OC_CLAUDE_COMPAT=off` or `--no-claude` turns it
off. Flags, with Claude Code's names: `--settings <file-or-json>`,
`--plugin-dir <dir>` (repeatable; also `OC_CLAUDE_PLUGIN_DIRS`),
`--permission-mode <mode>`, `--allowedTools <rules>`, `--disallowedTools <rules>`.
`CLAUDE_CONFIG_DIR` moves `~/.claude` (and `.claude.json`) as in Claude Code;
`OC_CLAUDE_MANAGED_DIR` moves (or, empty, disables) the managed-policy folder.

The model keeps calling OpenCode's tools. Rules, hook matchers and hook JSON
use Claude Code's names and fields, translated at the boundary
(`toolmap.rs`): `shell`↔`Bash`, `read`↔`Read`, `write`↔`Write`, `edit`↔`Edit`,
`glob`↔`Glob`, `grep`↔`Grep`, `webfetch`↔`WebFetch`, `todowrite`↔`TodoWrite`,
`task`↔`Agent`, `skill`↔`Skill`, `job`↔`TaskOutput`; inputs `path`↔`file_path`
(absolute), `oldString`↔`old_string`, `background`↔`run_in_background`, ….

Status: **yes** = implemented as documented; **partial** = implemented with the
stated gap; **no** = not implemented.

## 1. Memory

Doc: <https://code.claude.com/docs/en/memory>

| Behaviour | Status | Test |
| --- | --- | --- |
| Load order: managed `CLAUDE.md`, `~/.claude/CLAUDE.md`, `~/.claude/rules/`, then root→cwd: `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`, `CLAUDE.local.md` last per directory | yes | `memory::tests::load_order_root_to_cwd_local_last` |
| Managed paths `/etc/claude-code/CLAUDE.md`, `/Library/Application Support/ClaudeCode/CLAUDE.md` | yes | (paths) |
| `@path` imports: relative to the importing file, `~/`, absolute; `\ ` for spaces; quoted paths and code spans/fences are not imports; four hops max | yes | `imports_expand_relative_with_depth_limit`, `escaped_spaces_and_external_imports`, `import_parser_edge_cases` |
| External imports of project files need approval; user-scope files import freely | partial: no dialog in a headless run; `OC_CLAUDE_EXTERNAL_IMPORTS=1` approves; skipped imports are listed as warnings | `escaped_spaces_and_external_imports` |
| Block-level HTML comments stripped outside code blocks | yes | `comments_stripped_outside_code` |
| Subdirectory `CLAUDE.md`/`CLAUDE.local.md` and nested `.claude/rules` load when a tool touches a file there | yes (file tools; Bash `cat` reads are not traced) | `path_scoped_rules_and_nested_claude_md_load_on_demand` |
| Path-scoped rules (`paths:` frontmatter, list or comma string, braces, bare patterns at any depth, `/` anchors) load on matching file access | yes | same |
| `claudeMdExcludes` (globs on absolute paths, never the managed file, arrays merge) | yes | `excludes_skip_files_but_not_managed` |
| `AGENTS.md` / `.claude/AGENTS.md` when no project `CLAUDE.md`/`.claude/CLAUDE.md`/`CLAUDE.local.md` exists; `~/.claude/CLAUDE.md` doesn't count | yes | `agents_md_when_no_claude_md` |
| "Project instructions" setting `claude-md-or-agents-md` / `claude-md-and-agents-md` / `claude-md` / `managed-only` via `pluginConfigs["cc-plugin-agents-md@builtin"]` (user, cli, managed only) | yes | `agents_md_when_no_claude_md` |
| Text wrapper the model sees around each file | ours ("Contents of <path> (<scope>):") — the docs don't specify it | |
| Auto memory, `/memory`, `InstructionsLoaded` hook, `--add-dir` memory | no | |

## 2. Settings

Doc: <https://code.claude.com/docs/en/settings>, <https://code.claude.com/docs/en/settings-reference>

| Behaviour | Status | Test |
| --- | --- | --- |
| Files: `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, `--settings` (file or JSON), `managed-settings.json` | yes | `settings::tests::loads_files_from_disk_with_precedence` |
| Precedence managed > command line > local > project > user; scalars override, lists merge, objects merge per key | yes | `higher_layers_win_and_lists_merge` |
| `env`: applied to the session and its subprocesses; overrides the shell | yes | `memory_settings_and_catalog_load` (runtime) |
| `model` (with aliases `opus`/`sonnet`/`haiku`/`fable`/`best`, `[1m]`) | partial: applied only with an Anthropic endpoint and no `OC_MODEL` (an alias means nothing to Qwen/Mistral); `OC_MODEL` plays `ANTHROPIC_MODEL`'s role | `model_aliases` |
| `permissions.allow/ask/deny`, `defaultMode`, `additionalDirectories`, `disableBypassPermissionsMode` | yes | see §3 |
| `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`, `disableAllHooks` (managed hooks survive non-managed `true`) | yes | `managed_only_rules`, `disable_all_hooks_spares_managed` |
| `disabledMcpjsonServers`, `disableSkillShellExecution`, `claudeMdExcludes` | yes | |
| Invalid files are reported, not fatal | yes | `loads_files_from_disk_with_precedence` |
| Other keys (UI, telemetry, sandbox, statusLine, …) | no (ignored) | |

## 3. Permissions

Doc: <https://code.claude.com/docs/en/permissions>, <https://code.claude.com/docs/en/permission-modes>

| Behaviour | Status | Test |
| --- | --- | --- |
| Rule syntax `Tool` / `Tool(specifier)`, literal parentheses, `Tool(*)` = `Tool` | yes | `claude::tests::parses_rule_shapes` |
| Order deny → ask → allow, first match decides, specificity doesn't | yes | `deny_beats_ask_beats_allow` |
| Bare-name (and tool-glob) deny removes the tool from the model's list | yes | `bare_deny_removes_the_tool`, runtime `permission_rules_and_modes` |
| Bash wildcards: `*` spans spaces, trailing ` *` matches bare command, `:*` suffix, exact match without `*` | yes | `claude_bash::tests::pattern_table` |
| Compound commands (`&&` `||` `;` `|` `|&` `&` newline): every part must be allowed; deny/ask match any part incl. `$()`, backticks, subshells, loops; dangling operator = unparseable | yes | `splitting`, `compound_commands_need_every_part_allowed` |
| Wrappers stripped (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`, `noglob`, bare `xargs`); deny/ask see past any assignment, allow only past safe ones | yes; the safe-variable list is ours (docs name only examples) | `wrappers`, `deny_matches_past_assignments_and_wrappers` |
| Built-in read-only commands run without asking | partial: the documented set (`ls cat echo pwd head tail grep find wc which diff stat du cd`, read-only `git`) with redirect/`find -exec`/glob limits; not every edge (`ps e`, docker daemons) | `read_only_set` |
| Read/Edit path rules: gitignore semantics, anchors `//` `~/` `/` (per settings source) and relative; bare names any depth; `dir/**` any depth for deny/ask, anchored for allow; `*` within a segment; `!` negation within one source | yes | `read_deny_paths_follow_gitignore_depth`, `allow_single_segment_is_anchored`, `path_anchors`, `star_stays_in_one_segment`, `negation_carves_out_within_one_source` |
| Read deny covers Glob/Grep and blocks Edit/Write; `Write(path)`/`Glob(path)`/`Grep(path)` never match | yes | `write_glob_grep_path_rules_never_match` |
| `WebFetch(domain:…)` with `*.` subdomains, label-only `*`, `domain:*` | yes | `webfetch_domains` |
| MCP rules `mcp__server`, `mcp__server__*`, full names; allow globs only after `mcp__<server>__` | yes | `mcp_rules` |
| `Agent(name)`, `Agent(param:value)`, `Skill(name)` | yes | `agent_and_skill_rules` |
| Bash redirect targets checked against Edit/Read rules; symlink resolution; `Cd` rules | no | |
| Modes: `default` (reads only), `acceptEdits` (edits + `mkdir touch rm rmdir mv cp sed` in scope), `plan` (non-read denied), `dontAsk` (would-prompt denied), `bypassPermissions` (all, deny still wins) | partial: `auto` runs as `default` (no classifier); protected paths not modelled | runtime `permission_rules_and_modes` |
| Where rules sit over OpenCode's ruleset | ours: a Claude verdict decides; with no match the OpenCode ruleset (`OC_PERMISSIONS`, else ask) does. `ask` in `oc-cli ask` is refused (as `claude -p` in Manual mode); `chat` prompts y/N | |

## 4. Hooks

Doc: <https://code.claude.com/docs/en/hooks>

| Behaviour | Status | Test |
| --- | --- | --- |
| Sources: user/project/local/managed settings, plugin `hooks/hooks.json` + manifest, skill frontmatter (from invocation on, `once`), subagent frontmatter (while it runs; `Stop` → `SubagentStop`) | yes | `hooks::tests::parse_and_dedupe`, runtime tests |
| Matchers: `*`/empty/none, exact lists with `|` or `,`, otherwise unanchored regex; `FileChanged`/`StopFailure` narrower set; events without matcher support ignore it | yes | `matchers` |
| `if` field (permission-rule syntax, tool events only; Bash: any subcommand, unparseable or `$()` runs it) | yes | `if_filter_runs_only_matching_calls`, `hook_if_conditions`, runtime `post_tool_if_filter_and_updated_output` |
| Command hooks: shell form (`bash -c`), exec form (`args`, no shell), `${CLAUDE_PROJECT_DIR}`/`${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` substituted and exported, own session (no tty), cwd fallback | yes | `command_gets_stdin_env_and_exit_code`, `exec_form_and_timeout` |
| HTTP hooks (POST body, 2xx JSON/empty, `allowedEnvVars` header interpolation) | yes (no `allowedHttpHookUrls`) | |
| `mcp_tool`, `prompt`, `agent` hooks | no (parsed, reported as unsupported, never block) | |
| Same handler in several settings files runs once; plugin/skill copies stay separate; handlers of an event run in parallel | yes | `parse_and_dedupe` |
| Exit 0 + JSON fields; exit 0 + text; exit 2 blocks with stderr; other codes non-blocking unless the JSON is valid; the stdout-is-JSON rule | yes | `interpretation_table` |
| `onFailure: "block"` (start failure, timeout, bad exit, invalid JSON) | yes | `interpretation_table` |
| Timeouts: 600 s default, 30 s on UserPromptSubmit, SessionEnd 1.5 s budget raised by per-hook timeouts (≤60 s) or `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`; process group killed | yes | `exec_form_and_timeout` |
| `async` hooks run in the background and decide nothing | yes; `asyncRewake` treated as `async` (no rewake) | |
| Common input: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `agent_id`/`agent_type` in subagents | partial: `transcript_path` is the OC_DATA session message folder, not a JSONL file; no `prompt_id`, `effort`, `scratchpad_dir` | |
| **PreToolUse**: `tool_name`/`tool_input` (Claude shape, absolute paths)/`tool_use_id`, `mcp_server`; `permissionDecision` allow/deny/ask/defer with deny>defer>ask>allow, deprecated `approve`/`block`, `permissionDecisionReason`, `updatedInput` (mapped back), `additionalContext`; exit 2 → deny with `PreToolUse:<Tool> hook error: [<cmd>]: <stderr>`; deny/ask rules still apply over a hook allow; a hook block beats allow rules | yes | runtime `pre_tool_hook_blocks_with_stderr_and_adds_context`, `whole_turn_hooks_rules_and_stop_hook` |
| **PostToolUse** / **PostToolUseFailure**: `tool_response` (Bash shape for `shell`, `{output}` otherwise), `duration_ms`, `error`; `decision: block` + `reason`, `additionalContext`, `updatedToolOutput`/`updatedMCPToolOutput`, exit 2 stderr to the model | yes; tool_response shapes for non-Bash tools are ours | `post_tool_if_filter_and_updated_output` |
| **UserPromptSubmit**: `prompt` (typed line, before `/command` expansion); block by exit 2, `decision: block`, `continue: false`; plain stdout and `additionalContext` added as context; block message ends with "Original prompt:" | yes (no `sessionTitle`, `suppressOriginalPrompt`) | `prompt_session_stop_and_compact_hooks` |
| **Stop** / **SubagentStop**: `stop_hook_active`, `last_assistant_message`, `background_tasks: []`, `session_crons: []`; `decision: block` + reason, exit 2, `additionalContext` continue the turn; `continue: false` wins; 8-continuation cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`), reset by tool calls; missing-script exit 2 is non-blocking | yes | `prompt_session_stop_and_compact_hooks`, `whole_turn_hooks_rules_and_stop_hook` |
| **SessionStart** (`startup` in `ask`/`chat`, `clear` on `/new`/`/clear`): stdout and `additionalContext` become context; only command hooks | yes (`resume`/`compact` sources never fire: no resume in oc-cli) | `prompt_session_stop_and_compact_hooks` |
| **SessionEnd** (`other`, `prompt_input_exit` on `/exit`, `clear`) | yes | |
| **PreCompact** (`auto`; `custom_instructions: null`): block skips compaction; stdout becomes summary instructions | yes (no manual `/compact`) | `prompt_session_stop_and_compact_hooks` |
| **Notification** `permission_prompt` | partial: fires when the prompt is shown, not after ~6 s; no `idle_prompt` and other types | |
| `continue: false` / `stopReason` on tool events ends processing; `systemMessage` shown to the user | yes | |
| Other events (PermissionRequest, PermissionDenied, PostToolBatch, SubagentStart, Setup, ConfigChange, FileChanged, Worktree*, Elicitation*, …) | no | |

## 5. Skills and slash commands

Doc: <https://code.claude.com/docs/en/skills>

| Behaviour | Status | Test |
| --- | --- | --- |
| `SKILL.md` folders in managed, `~/.claude/skills`, `.claude/skills` from cwd up to the repo root, plugins; commands in `.claude/commands/**` (`dir:name`) and `~/.claude/commands` | yes | `skills::tests::discovery_names_and_precedence` |
| Names: frontmatter `name` or folder name (both invoke), managed > personal > project, skill beats command, plugin `plugin:name` plus the bare name while free; refused characters | yes | same |
| Frontmatter: `description` (fallback first line, `when_to_use` appended, 1,536-char cap, `<>` escaped), `disable-model-invocation`, `user-invocable`, `allowed-tools`, `arguments`, `argument-hint`, `hooks`, `model`, `context`, `agent` | partial: `model`, `effort`, `context: fork`/`agent`, `paths` are read but not applied (runs inline) | |
| Descriptions listed to the model (the `skill` tool's description); body loads only on use; `disable-model-invocation` refused to the model with the documented advice | yes | runtime `slash_commands_and_skills` |
| `/name args` typed by the user expands the skill or command | yes | `slash_commands_and_skills` |
| Substitutions `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, named `$arg`, `\$` escape, literal argument values, `ARGUMENTS:` append, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT/DATA}` | yes (`${CLAUDE_EFFORT}` is always `medium`) | `substitutions`, `arg_splitting` |
| `` !`cmd` `` and ` ```! ` injection: permission check must allow (rules + the skill's own `allowed-tools` + read-only), any other verdict or a failing command aborts; exit 1 fine for searches; `disableSkillShellExecution` | yes | `injected_command_parsing`, `slash_commands_and_skills` |
| `allowed-tools` grants for the turn, cleared by the next user message | yes | `slash_commands_and_skills` |
| `disallowed-tools`, stacking several skills, synced claude.ai skills, live reload | no | |

## 6. Subagents

Doc: <https://code.claude.com/docs/en/sub-agents>

| Behaviour | Status | Test |
| --- | --- | --- |
| Files in `.claude/agents/**` (walking up; closest wins), `~/.claude/agents/**`, plugin `agents/` (`plugin:name`); priority project > user > plugin; `name` + `description` required, no `:` in names | yes | `agents::tests::priority_and_fields` |
| Body = the subagent's system prompt (plus environment and CLAUDE.md); `tools` allowlist and `disallowedTools` (applied first; a specifier removes the whole tool; `mcp__server`, `mcp__server__*`, `mcp__*`); zero tools refuses to launch | yes | `tool_resolution`, runtime `subagent_profiles` |
| `model` (aliases on an Anthropic endpoint, `provider/model` anywhere, `inherit`), `maxTurns`, `skills` preloaded, `omitClaudeMd`, frontmatter `hooks` | yes | `subagent_profiles` |
| Run through oc-agent's `task` tool (accepts `agent` or `subagent_type`); hooks fire inside with `agent_id`/`agent_type`; `SubagentStop` | yes | |
| `permissionMode`, `memory`, `background`, `isolation: worktree`, `effort`, `mcpServers`, `--agents` JSON, nested subagents | no | |

## 7. MCP

Doc: <https://code.claude.com/docs/en/mcp>

| Behaviour | Status | Test |
| --- | --- | --- |
| Scopes: local (`~/.claude.json` `projects[<dir>].mcpServers`), project (`.mcp.json`), user (`~/.claude.json` `mcpServers`), plugin; precedence local > project > user by name, whole entry; plugins deduplicated by endpoint | yes | `mcp::tests::*` (Mistral) |
| `${VAR}` / `${VAR:-default}` in command/args/env/url/headers; unset without default stays literal with a warning; empty counts as set; credential variables read empty in remote url/headers | yes | `mcp::tests::*` |
| Tool names `mcp__<server>__<tool>`, `.`/space → `_`, plugin servers `plugin_<plugin>_<server>`; `CLAUDE_PROJECT_DIR` (and plugin vars) in the server's env | yes | `mcp::tests::*` |
| `disabledMcpjsonServers` | yes | |
| stdio transport | yes (via oc-mcp); servers start concurrently, `MCP_TIMEOUT` bounds each start | |
| http / sse / ws transports, OAuth, `headersHelper`, approvals dialog, claude.ai connectors | no (listed as a warning, skipped) | |

## 8. Plugins

Doc: <https://code.claude.com/docs/en/plugins-reference>, <https://code.claude.com/docs/en/plugins>

| Behaviour | Status | Test |
| --- | --- | --- |
| Load from `--plugin-dir` / `OC_CLAUDE_PLUGIN_DIRS` | yes | `plugins::tests::*` |
| Optional `.claude-plugin/plugin.json`; name from manifest or folder | yes | `no_manifest_uses_directory_name_and_root_skill` |
| Standard layout `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `bin/` (on PATH), root `SKILL.md` | yes | `standard_layout_and_manifest` |
| Manifest component paths: `skills`, `commands` (path/list/object map with `source`/`content`), `agents`, `hooks` (path/inline/array; files need the `"hooks"` wrapper), `mcpServers` (path/inline/array; later names win) | yes | `standard_layout_and_manifest`, `hooks_file_without_wrapper_is_rejected` |
| `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>`) in hooks, MCP, skills | yes | |
| Marketplaces, install/enable (`enabledPlugins`), `userConfig`, `.mcpb` bundles, LSP, monitors, output styles, themes, plugin `settings.json` | no | |

## Who did what

- Design, the runner seam, rule engine, shell analysis, memory, settings,
  hooks, skills, subagents, plugins, runtime, CLI wiring, tests and this
  matrix: Claude (this session).
- `crates/oc-claude/src/mcp.rs` and its tests: Mistral (`mistral-large`, lane
  run `cc-mcp2`), from a written spec; reviewed and diffgate-checked.
- Two Codestral (`mistral-code`) attempts at the frontmatter parser and one at
  the MCP loader failed to compile and were discarded.
