//! Claude Code projects in embedded mode: `oc-claude` loaded for the
//! session directory, its flags, and the per-turn steps (slash commands,
//! UserPromptSubmit, SessionStart/SessionEnd).
//!
//! Flags (Claude Code's names): `--settings <file-or-json>`,
//! `--plugin-dir <dir>` (repeatable), `--permission-mode <mode>`,
//! `--allowedTools <rules>`, `--disallowedTools <rules>`, `--no-claude`.
//! `OC_CLAUDE_COMPAT=off` also turns the layer off.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use oc_agent::RunOptions;
use oc_claude::{ClaudeEnv, ClaudeRuntime, LoadOptions};
use oc_store::Store;
use oc_tools::Registry;

#[derive(Debug, Default)]
pub struct Flags {
    pub options: LoadOptions,
    pub disabled: bool,
}

/// Remove the Claude Code flags from `args`.
pub fn take_flags(args: &mut Vec<String>) -> Flags {
    let mut flags = Flags::default();
    let mut rest = Vec::with_capacity(args.len());
    let mut it = std::mem::take(args).into_iter();
    let list = |v: String| -> Vec<String> {
        // Rules are separated by commas or spaces outside parentheses.
        let mut out = Vec::new();
        let mut cur = String::new();
        let mut depth = 0i32;
        for c in v.chars() {
            match c {
                '(' => {
                    depth += 1;
                    cur.push(c)
                }
                ')' => {
                    depth -= 1;
                    cur.push(c)
                }
                ',' | ' ' if depth <= 0 => {
                    if !cur.trim().is_empty() {
                        out.push(cur.trim().to_string());
                    }
                    cur.clear();
                }
                _ => cur.push(c),
            }
        }
        if !cur.trim().is_empty() {
            out.push(cur.trim().to_string());
        }
        out
    };
    while let Some(arg) = it.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |inline: Option<String>| inline.or_else(|| it.next()).unwrap_or_default();
        match name.as_str() {
            "--settings" => flags.options.settings_arg = Some(value(inline)),
            "--plugin-dir" => flags.options.plugin_dirs.push(PathBuf::from(value(inline))),
            "--permission-mode" => flags.options.permission_mode = Some(value(inline)),
            "--allowedTools" | "--allowed-tools" => flags.options.allowed_tools.extend(list(value(inline))),
            "--disallowedTools" | "--disallowed-tools" => flags.options.disallowed_tools.extend(list(value(inline))),
            "--no-claude" => flags.disabled = true,
            _ => rest.push(arg),
        }
    }
    flags.options.external_imports = std::env::var("OC_CLAUDE_EXTERNAL_IMPORTS").is_ok_and(|v| v == "1" || v == "allow");
    *args = rest;
    flags
}

/// Load the project for `dir`, print what did not load, apply its `env`
/// and `model` settings. None when the layer is off.
pub fn load(dir: &Path, flags: &Flags) -> Option<Arc<ClaudeRuntime>> {
    if flags.disabled || !oc_claude::enabled() {
        return None;
    }
    let rt = ClaudeRuntime::load(ClaudeEnv::from_env(dir), &flags.options);
    for w in &rt.warnings {
        eprintln!("claude: {w}");
    }
    rt.apply_env();
    if std::env::var("OC_MODEL").map(|v| v.trim().is_empty()).unwrap_or(true) {
        let provider = std::env::var("OC_PROVIDER").unwrap_or_default().to_lowercase();
        if let Some(model) = rt.model_for(&provider) {
            std::env::set_var("OC_MODEL", model);
        }
    }
    Some(Arc::new(rt))
}

/// Built-in tools, MCP servers (Claude Code layout and `OC_MCP_SERVERS`)
/// and the `skill` tool.
pub async fn registry(dir: &Path, rt: Option<&Arc<ClaudeRuntime>>) -> Registry {
    let mut servers = oc_mcp::servers_from_env();
    let mut extra: Vec<Arc<dyn oc_tools::Tool>> = Vec::new();
    if let Some(rt) = rt {
        let (claude_servers, warnings) = rt.mcp_servers();
        for w in warnings {
            eprintln!("claude: {w}");
        }
        servers.extend(claude_servers);
        extra.extend(rt.skill_tool());
    }
    if !servers.is_empty() {
        // Start every server at once; one slow server must not hold the
        // others up. `MCP_TIMEOUT` (ms) bounds each startup, as in Claude Code.
        let limit = std::env::var("MCP_TIMEOUT")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(30));
        let starts = servers.into_iter().map(|server| async move {
            let name = server.name.clone();
            match tokio::time::timeout(limit, oc_mcp::registry_tools(vec![server])).await {
                Ok(tools) => tools,
                Err(_) => {
                    eprintln!("claude: MCP server {name} did not start within {} ms; skipped", limit.as_millis());
                    Vec::new()
                }
            }
        });
        for tools in futures_util::future::join_all(starts).await {
            extra.extend(tools);
        }
    }
    Registry::builtin(dir).with_tools(extra)
}

/// The turn's registry with the task tool and the project's subagents.
pub fn with_task(
    registry: &Registry,
    rt: Option<&Arc<ClaudeRuntime>>,
    store: Arc<Store>,
    client: Arc<oc_provider::Client>,
    model: oc_schema::ModelRef,
    opts: &RunOptions,
) -> Registry {
    match rt {
        Some(rt) if !rt.agents.is_empty() => {
            let profiles = rt.agent_profiles(&registry.names(), &model.provider_id);
            oc_agent::with_task_tool_profiles(registry, store, client, model, opts, profiles)
        }
        _ => oc_agent::with_task_tool(registry, store, client, model, opts),
    }
}

/// Hooks and instructions on the turn's options.
pub fn apply(opts: &mut RunOptions, rt: Option<&Arc<ClaudeRuntime>>) {
    if let Some(rt) = rt {
        opts.hooks = Some(rt.clone() as Arc<dyn oc_agent::hooks::TurnHooks>);
        opts.instructions = Some(Arc::new(rt.instructions()));
    }
}

/// A typed line before it reaches the model: a `/command` expands, then
/// UserPromptSubmit hooks may block it or add context. Err is the message
/// for the user.
pub async fn prepare_prompt(rt: Option<&Arc<ClaudeRuntime>>, session: &str, line: &str) -> Result<String, String> {
    let Some(rt) = rt else {
        return Ok(line.to_string());
    };
    let notes = rt.user_prompt_submit(session, line).await?;
    let mut text = match rt.expand_slash(session, line).await? {
        Some(expanded) => expanded,
        None => line.to_string(),
    };
    for n in notes {
        text.push_str("\n\n");
        text.push_str(&oc_agent::hooks::system_reminder(&n));
    }
    Ok(text)
}

pub async fn session_start(rt: Option<&Arc<ClaudeRuntime>>, session: &str, source: &str) {
    if let Some(rt) = rt {
        let model = std::env::var("OC_MODEL").ok();
        rt.set_transcript_path(transcript_path(session));
        rt.session_start(session, source, model.as_deref()).await;
    }
}

pub async fn session_end(rt: Option<&Arc<ClaudeRuntime>>, session: &str, reason: &str) {
    if let Some(rt) = rt {
        rt.session_end(session, reason).await;
    }
}

/// The session's message folder in the OC_DATA store, when there is one.
fn transcript_path(session: &str) -> Option<PathBuf> {
    let data = std::env::var("OC_DATA").ok().filter(|d| !d.trim().is_empty())?;
    Some(Path::new(&data).join("session/message").join(session))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_are_taken_out() {
        let mut args: Vec<String> = [
            "ask",
            "--permission-mode",
            "acceptEdits",
            "--allowedTools",
            "Bash(git log *),Read",
            "--settings={\"model\":\"x\"}",
            "--plugin-dir",
            "/p",
            "hi",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let f = take_flags(&mut args);
        assert_eq!(args, vec!["ask", "hi"]);
        assert_eq!(f.options.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(f.options.allowed_tools, vec!["Bash(git log *)", "Read"]);
        assert_eq!(f.options.settings_arg.as_deref(), Some("{\"model\":\"x\"}"));
        assert_eq!(f.options.plugin_dirs, vec![PathBuf::from("/p")]);
    }
}
