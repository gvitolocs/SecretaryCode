//! MCP server configuration in Claude Code layout (`.mcp.json`,
//! `~/.claude.json`, plugins). See docs/claude-code-compat.md.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Credential variables that always read as empty inside a remote server's
/// `url` and `headers`, whatever the environment says.
const CREDENTIAL_VARS: [&str; 4] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

/// Where a server definition came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    Local,
    Project,
    User,
    Plugin(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transport {
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
    /// `http`, `sse` or `ws`; oc-mcp only speaks stdio, so these are listed but not started.
    Remote {
        kind: String,
        url: String,
        headers: Vec<(String, String)>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerEntry {
    /// The key in the `mcpServers` map.
    pub name: String,
    /// The server segment of its tool names: `sanitize_server_name(name)`, or for a plugin server
    /// `plugin_<plugin>_<sanitized name>`. Tools are then `mcp__<tool_server>__<tool>`.
    pub tool_server: String,
    pub scope: Scope,
    pub transport: Transport,
    /// Missing variables and other non-fatal problems, human-readable.
    pub warnings: Vec<String>,
}

/// One plugin's server map, already read from its `.mcp.json` / manifest.
pub struct PluginServers {
    pub plugin: String,
    pub root: PathBuf,
    pub data_dir: PathBuf,
    /// The `mcpServers` map itself: `{ "<name>": { ...server config... } }`.
    pub servers: Value,
}

/// Where to look and what to skip.
pub struct LoadOptions<'a> {
    /// The project directory (session start directory). `.mcp.json` is read from here.
    pub project_dir: &'a Path,
    /// Path of `~/.claude.json` (None: skip user and local scopes).
    pub claude_json: Option<&'a Path>,
    /// Names from the `disabledMcpjsonServers` setting: project (`.mcp.json`) servers to skip.
    pub disabled_project_servers: &'a [String],
    pub plugins: &'a [PluginServers],
    /// Environment lookup (tests pass a closure; production passes std::env::var).
    pub env: &'a dyn Fn(&str) -> Option<String>,
}

/// Every char outside [A-Za-z0-9_-] becomes `_` ("my.server" -> "my_server", "a b" -> "a_b").
pub fn sanitize_server_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Expand `${VAR}` and `${VAR:-default}`. A set variable (even set to "") expands to its value; an
/// unset one with a default expands to the default; an unset one without a default stays as the
/// literal `${VAR}` text and its name is pushed to `missing` (once per name). `$VAR` without
/// braces is left alone. `extra` is consulted before `env`.
pub fn expand_vars(
    s: &str,
    extra: &[(&str, &str)],
    env: &dyn Fn(&str) -> Option<String>,
    missing: &mut Vec<String>,
) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find("${") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 2..];
        let Some(close) = after.find('}') else {
            out.push_str(&rest[pos..]);
            return out;
        };
        let inner = &after[..close];
        let (name, default) = match inner.find(":-") {
            Some(i) => (&inner[..i], Some(&inner[i + 2..])),
            None => (inner, None),
        };
        if name.is_empty() {
            out.push_str("${");
            out.push_str(inner);
            out.push('}');
        } else {
            let value = extra
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_string())
                .or_else(|| env(name))
                .or_else(|| default.map(str::to_string));
            match value {
                Some(v) => out.push_str(&v),
                None => {
                    out.push_str("${");
                    out.push_str(inner);
                    out.push('}');
                    if !missing.iter().any(|m| m == name) {
                        missing.push(name.to_string());
                    }
                }
            }
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

/// Parse one `mcpServers` map in a given scope (no precedence, no filtering). Entries that are
/// not objects, or have neither `command` nor `url`, are skipped.
pub fn parse_servers(
    map: &Value,
    scope: Scope,
    project_dir: &Path,
    plugin: Option<&PluginServers>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Vec<ServerEntry> {
    let mut out = Vec::new();
    let Some(obj) = map.as_object() else {
        return out;
    };

    let project_dir_str = project_dir.to_string_lossy().into_owned();
    let mut extra: Vec<(&str, &str)> = vec![("CLAUDE_PROJECT_DIR", project_dir_str.as_str())];
    let plugin_extra: Vec<(&str, String)> = match plugin {
        Some(p) => vec![
            ("CLAUDE_PLUGIN_ROOT", p.root.to_string_lossy().into_owned()),
            (
                "CLAUDE_PLUGIN_DATA",
                p.data_dir.to_string_lossy().into_owned(),
            ),
        ],
        None => Vec::new(),
    };
    for (k, v) in &plugin_extra {
        extra.push((k, v.as_str()));
    }

    for (name, cfg) in obj {
        let Some(cfg) = cfg.as_object() else {
            continue;
        };
        let command = cfg.get("command").and_then(Value::as_str);
        let url = cfg.get("url").and_then(Value::as_str);
        if command.is_none() && url.is_none() {
            continue;
        }
        let ty = cfg.get("type").and_then(Value::as_str);
        let remote_kind = match ty {
            Some(k) if matches!(k, "http" | "sse" | "ws") => Some(k),
            _ => None,
        };
        let mut missing: Vec<String> = Vec::new();
        let transport = if let Some(kind) = remote_kind {
            match url {
                Some(u) => parse_remote(cfg, kind, u, &extra, env, &mut missing),
                None => continue,
            }
        } else if let Some(c) = command {
            parse_stdio(cfg, c, &extra, env, &mut missing)
        } else if let Some(u) = url {
            parse_remote(cfg, "http", u, &extra, env, &mut missing)
        } else {
            continue;
        };
        let tool_server = match plugin {
            Some(p) => format!("plugin_{}_{}", p.plugin, sanitize_server_name(name)),
            None => sanitize_server_name(name),
        };
        let warnings = missing
            .iter()
            .map(|m| format!("missing environment variable {m}"))
            .collect();
        out.push(ServerEntry {
            name: name.clone(),
            tool_server,
            scope: scope.clone(),
            transport,
            warnings,
        });
    }
    out
}

/// Load every scope and apply precedence: local > project > user (whole entry, no field merging),
/// then plugin servers. Result order: local, project, user, then plugins, each in map key order.
pub fn load(opts: &LoadOptions) -> Vec<ServerEntry> {
    let env = opts.env;
    let project_dir = opts.project_dir;

    let mut local_entries: Vec<ServerEntry> = Vec::new();
    let mut user_entries: Vec<ServerEntry> = Vec::new();
    if let Some(claude_json) = opts.claude_json {
        if let Some(v) = read_json(claude_json) {
            if let Some(m) = v.get("mcpServers") {
                user_entries = parse_servers(m, Scope::User, project_dir, None, env);
            }
            if let Some(projects) = v.get("projects").and_then(Value::as_object) {
                let key = project_dir.to_string_lossy();
                if let Some(m) = projects.get(&*key).and_then(|p| p.get("mcpServers")) {
                    local_entries = parse_servers(m, Scope::Local, project_dir, None, env);
                }
            }
        }
    }

    let mut project_entries: Vec<ServerEntry> = Vec::new();
    if let Some(v) = read_json(&project_dir.join(".mcp.json")) {
        if let Some(m) = v.get("mcpServers") {
            project_entries = parse_servers(m, Scope::Project, project_dir, None, env);
        }
    }
    project_entries.retain(|e| !opts.disabled_project_servers.iter().any(|d| d == &e.name));

    let mut kept: Vec<ServerEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for e in local_entries
        .into_iter()
        .chain(project_entries)
        .chain(user_entries)
    {
        if seen.insert(e.name.clone()) {
            kept.push(e);
        }
    }

    // Plugin servers never clash by name, but one whose endpoint duplicates a
    // server already kept from local/project/user is dropped.
    let endpoints: HashSet<String> = kept.iter().map(endpoint_key).collect();
    for p in opts.plugins {
        for e in parse_servers(
            &p.servers,
            Scope::Plugin(p.plugin.clone()),
            project_dir,
            Some(p),
            env,
        ) {
            if !endpoints.contains(&endpoint_key(&e)) {
                kept.push(e);
            }
        }
    }
    kept
}

/// The stdio servers as oc-mcp configs, named by `tool_server`. Remote servers are left out.
pub fn to_oc_configs(entries: &[ServerEntry]) -> Vec<oc_mcp::McpServerConfig> {
    entries
        .iter()
        .filter_map(|e| match &e.transport {
            Transport::Stdio { command, args, env } => Some(oc_mcp::McpServerConfig {
                name: e.tool_server.clone(),
                command: command.clone(),
                args: args.clone(),
                env: env.clone(),
            }),
            Transport::Remote { .. } => None,
        })
        .collect()
}

fn parse_stdio(
    cfg: &serde_json::Map<String, Value>,
    command_raw: &str,
    extra: &[(&str, &str)],
    env: &dyn Fn(&str) -> Option<String>,
    missing: &mut Vec<String>,
) -> Transport {
    let command = expand_vars(command_raw, extra, env, missing);
    let mut args = Vec::new();
    if let Some(list) = cfg.get("args").and_then(Value::as_array) {
        for item in list {
            if let Some(s) = item.as_str() {
                args.push(expand_vars(s, extra, env, missing));
            }
        }
    }
    let mut env_pairs: Vec<(String, String)> = Vec::new();
    if let Some(e) = cfg.get("env").and_then(Value::as_object) {
        for (k, v) in e {
            if let Some(s) = v.as_str() {
                env_pairs.push((k.clone(), expand_vars(s, extra, env, missing)));
            }
        }
    }
    for &(k, v) in extra {
        if !env_pairs.iter().any(|(ek, _)| ek.as_str() == k) {
            env_pairs.push((k.to_string(), v.to_string()));
        }
    }
    Transport::Stdio {
        command,
        args,
        env: env_pairs,
    }
}

fn parse_remote(
    cfg: &serde_json::Map<String, Value>,
    kind: &str,
    url_raw: &str,
    extra: &[(&str, &str)],
    env: &dyn Fn(&str) -> Option<String>,
    missing: &mut Vec<String>,
) -> Transport {
    // Credential variables always read as empty in a remote url / headers.
    let masked = |name: &str| -> Option<String> {
        if CREDENTIAL_VARS.contains(&name) {
            Some(String::new())
        } else {
            env(name)
        }
    };
    let url = expand_vars(url_raw, extra, &masked, missing);
    let mut headers = Vec::new();
    if let Some(h) = cfg.get("headers").and_then(Value::as_object) {
        for (k, v) in h {
            if let Some(s) = v.as_str() {
                headers.push((k.clone(), expand_vars(s, extra, &masked, missing)));
            }
        }
    }
    Transport::Remote {
        kind: kind.to_string(),
        url,
        headers,
    }
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// Endpoint identity for duplicate detection: stdio is command plus expanded args; remote is the
/// normalized url.
fn endpoint_key(e: &ServerEntry) -> String {
    match &e.transport {
        Transport::Stdio { command, args, .. } => {
            let mut key = String::from("stdio\x00");
            key.push_str(command);
            for a in args {
                key.push('\x00');
                key.push_str(a);
            }
            key
        }
        Transport::Remote { url, .. } => format!("remote\x00{}", normalize_url(url)),
    }
}

/// Compare urls case-insensitively on scheme and host, ignoring a trailing `/` and an explicit
/// default port (`:443` for https, `:80` for http).
fn normalize_url(url: &str) -> String {
    let Some(sep) = url.find("://") else {
        return url.trim_end_matches('/').to_lowercase();
    };
    let scheme = url[..sep].to_lowercase();
    let rest = &url[sep + 3..];
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let hostport = match authority.rfind('@') {
        Some(i) => &authority[i + 1..],
        None => authority,
    };
    let (host, port) = match hostport.rfind(':') {
        Some(i) => (&hostport[..i], Some(&hostport[i + 1..])),
        None => (hostport, None),
    };
    let default_port = match scheme.as_str() {
        "https" => "443",
        "http" => "80",
        _ => "",
    };
    let authority = match port {
        Some(p) if !default_port.is_empty() && p == default_port => host.to_lowercase(),
        Some(p) => format!("{}:{}", host.to_lowercase(), p),
        None => host.to_lowercase(),
    };
    format!("{}://{}{}", scheme, authority, path.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_json(p: &Path, v: Value) {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, serde_json::to_string(&v).unwrap()).unwrap();
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn opts<'a>(
        project_dir: &'a Path,
        claude_json: Option<&'a Path>,
        disabled: &'a [String],
        plugins: &'a [PluginServers],
        env: &'a dyn Fn(&str) -> Option<String>,
    ) -> LoadOptions<'a> {
        LoadOptions {
            project_dir,
            claude_json,
            disabled_project_servers: disabled,
            plugins,
            env,
        }
    }

    fn claude_json_with(user_servers: Value, project_key: &str, local_servers: Value) -> Value {
        let mut projects = serde_json::Map::new();
        projects.insert(
            project_key.to_string(),
            serde_json::json!({ "mcpServers": local_servers }),
        );
        serde_json::json!({
            "mcpServers": user_servers,
            "projects": Value::Object(projects),
        })
    }

    #[test]
    fn project_stdio_expansion_and_env() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        write_json(
            &project.join(".mcp.json"),
            serde_json::json!({
                "mcpServers": {
                    "srv": {"command": "node", "args": ["${ROOT:-/opt}/s.js"], "env": {"K": "${KEY}"}}
                }
            }),
        );
        let env = |k: &str| match k {
            "KEY" => Some("v".to_string()),
            _ => None,
        };
        let entries = load(&opts(&project, None, &[], &[], &env));
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.name, "srv");
        assert_eq!(e.tool_server, "srv");
        assert_eq!(e.scope, Scope::Project);
        assert!(e.warnings.is_empty(), "{:?}", e.warnings);
        match &e.transport {
            Transport::Stdio { command, args, env } => {
                assert_eq!(command, "node");
                assert_eq!(args, &vec!["/opt/s.js".to_string()]);
                assert!(env.contains(&("K".to_string(), "v".to_string())));
                assert!(env.contains(&(
                    "CLAUDE_PROJECT_DIR".to_string(),
                    project.to_string_lossy().into_owned()
                )));
            }
            other => panic!("expected stdio, got {other:?}"),
        }
        let cfgs = to_oc_configs(&entries);
        assert_eq!(cfgs.len(), 1);
        assert_eq!(cfgs[0].name, "srv");
        assert_eq!(cfgs[0].command, "node");
        assert_eq!(cfgs[0].args, vec!["/opt/s.js".to_string()]);
    }

    #[test]
    fn missing_var_stays_literal_with_warning() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        write_json(
            &project.join(".mcp.json"),
            serde_json::json!({
                "mcpServers": {"s": {"command": "run", "args": ["${NOPE}"]}}
            }),
        );
        let entries = load(&opts(&project, None, &[], &[], &no_env));
        assert_eq!(entries.len(), 1);
        match &entries[0].transport {
            Transport::Stdio { args, .. } => assert_eq!(args, &vec!["${NOPE}".to_string()]),
            other => panic!("expected stdio, got {other:?}"),
        }
        assert_eq!(
            entries[0].warnings,
            vec!["missing environment variable NOPE".to_string()]
        );
    }

    #[test]
    fn empty_value_beats_default() {
        let mut missing = Vec::new();
        let env = |k: &str| {
            if k == "E" {
                Some(String::new())
            } else {
                None
            }
        };
        assert_eq!(expand_vars("${E:-fallback}", &[], &env, &mut missing), "");
        assert!(missing.is_empty());
    }

    #[test]
    fn expand_vars_rules() {
        let mut missing = Vec::new();
        let env = |k: &str| match k {
            "SET" => Some("v".to_string()),
            _ => None,
        };
        assert_eq!(expand_vars("${SET}", &[], &env, &mut missing), "v");
        assert_eq!(expand_vars("${UNSET:-d}", &[], &env, &mut missing), "d");
        assert_eq!(expand_vars("${UNSET}", &[], &env, &mut missing), "${UNSET}");
        assert_eq!(
            expand_vars("${UNSET} and ${UNSET}", &[], &env, &mut missing),
            "${UNSET} and ${UNSET}"
        );
        assert_eq!(expand_vars("$SET", &[], &env, &mut missing), "$SET");
        assert_eq!(expand_vars("plain", &[], &env, &mut missing), "plain");
        assert_eq!(
            expand_vars("${EXTRA}", &[("EXTRA", "x")], &env, &mut missing),
            "x"
        );
        assert_eq!(
            expand_vars("${SET}", &[("SET", "extra-wins")], &env, &mut missing),
            "extra-wins"
        );
        assert_eq!(missing, vec!["UNSET".to_string()]);
    }

    #[test]
    fn local_beats_project_beats_user() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        write_json(
            &project.join(".mcp.json"),
            serde_json::json!({
                "mcpServers": {"s": {"command": "project-cmd"}, "p": {"command": "project-only"}}
            }),
        );
        let claude_json = dir.path().join("claude.json");
        write_json(
            &claude_json,
            claude_json_with(
                serde_json::json!({"s": {"command": "user-cmd"}, "u": {"command": "user-only"}}),
                &project.to_string_lossy(),
                serde_json::json!({"s": {"command": "local-cmd"}}),
            ),
        );
        let entries = load(&opts(&project, Some(&claude_json), &[], &[], &no_env));
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "s");
        assert_eq!(entries[0].scope, Scope::Local);
        match &entries[0].transport {
            Transport::Stdio { command, .. } => assert_eq!(command, "local-cmd"),
            other => panic!("expected stdio, got {other:?}"),
        }
        assert_eq!(entries[1].name, "p");
        assert_eq!(entries[1].scope, Scope::Project);
        assert_eq!(entries[2].name, "u");
        assert_eq!(entries[2].scope, Scope::User);
    }

    #[test]
    fn disabled_project_server_falls_back_to_user() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        write_json(
            &project.join(".mcp.json"),
            serde_json::json!({"mcpServers": {"s": {"command": "project-cmd"}}}),
        );
        let claude_json = dir.path().join("claude.json");
        write_json(
            &claude_json,
            serde_json::json!({"mcpServers": {"s": {"command": "user-cmd"}}}),
        );
        let disabled = vec!["s".to_string()];
        let entries = load(&opts(&project, Some(&claude_json), &disabled, &[], &no_env));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].scope, Scope::User);
        match &entries[0].transport {
            Transport::Stdio { command, .. } => assert_eq!(command, "user-cmd"),
            other => panic!("expected stdio, got {other:?}"),
        }
    }

    #[test]
    fn remote_credentials_masked_and_not_started() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        write_json(
            &project.join(".mcp.json"),
            serde_json::json!({
                "mcpServers": {
                    "api": {
                        "type": "http",
                        "url": "https://x.example.com/mcp",
                        "headers": {"Authorization": "Bearer ${ANTHROPIC_API_KEY}"}
                    }
                }
            }),
        );
        let env = |k: &str| {
            if k == "ANTHROPIC_API_KEY" {
                Some("secret".to_string())
            } else {
                None
            }
        };
        let entries = load(&opts(&project, None, &[], &[], &env));
        assert_eq!(entries.len(), 1);
        assert!(entries[0].warnings.is_empty(), "{:?}", entries[0].warnings);
        match &entries[0].transport {
            Transport::Remote { kind, url, headers } => {
                assert_eq!(kind, "http");
                assert_eq!(url, "https://x.example.com/mcp");
                assert_eq!(
                    headers,
                    &vec![("Authorization".to_string(), "Bearer ".to_string())]
                );
            }
            other => panic!("expected remote, got {other:?}"),
        }
        assert!(to_oc_configs(&entries).is_empty());
    }

    #[test]
    fn plugin_servers_scoped_and_deduped_by_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let claude_json = dir.path().join("claude.json");
        write_json(
            &claude_json,
            serde_json::json!({"mcpServers": {"db": {"command": "db-server", "args": ["--x"]}}}),
        );
        let plugin_root = dir.path().join("plugins/my-plugin");
        let plugin_data = dir.path().join("data/my-plugin");
        let plugin = PluginServers {
            plugin: "my-plugin".to_string(),
            root: plugin_root.clone(),
            data_dir: plugin_data.clone(),
            servers: serde_json::json!({
                "db": {"command": "${CLAUDE_PLUGIN_ROOT}/bin/db", "args": ["serve"]},
                "dup": {"command": "db-server", "args": ["--x"]}
            }),
        };
        let entries = load(&opts(
            &project,
            Some(&claude_json),
            &[],
            std::slice::from_ref(&plugin),
            &no_env,
        ));
        assert_eq!(
            entries.len(),
            2,
            "{:?}",
            entries.iter().map(|e| &e.name).collect::<Vec<_>>()
        );
        assert_eq!(entries[0].name, "db");
        assert_eq!(entries[0].scope, Scope::User);
        assert_eq!(entries[0].tool_server, "db");
        let plugin_db = entries
            .iter()
            .find(|e| e.scope == Scope::Plugin("my-plugin".to_string()))
            .expect("plugin db entry");
        assert_eq!(plugin_db.name, "db");
        assert_eq!(plugin_db.tool_server, "plugin_my-plugin_db");
        match &plugin_db.transport {
            Transport::Stdio { command, args, env } => {
                assert_eq!(
                    command,
                    &format!("{}/bin/db", plugin_root.to_string_lossy())
                );
                assert_eq!(args, &vec!["serve".to_string()]);
                assert!(env.contains(&(
                    "CLAUDE_PLUGIN_ROOT".to_string(),
                    plugin_root.to_string_lossy().into_owned()
                )));
                assert!(env.contains(&(
                    "CLAUDE_PLUGIN_DATA".to_string(),
                    plugin_data.to_string_lossy().into_owned()
                )));
                assert!(env.contains(&(
                    "CLAUDE_PROJECT_DIR".to_string(),
                    project.to_string_lossy().into_owned()
                )));
            }
            other => panic!("expected stdio, got {other:?}"),
        }
        assert!(entries.iter().all(|e| e.name != "dup"));
    }

    #[test]
    fn sanitize_server_name_replaces_outsiders() {
        assert_eq!(sanitize_server_name("my.server"), "my_server");
        assert_eq!(sanitize_server_name("a b"), "a_b");
        assert_eq!(sanitize_server_name("ok-name_1"), "ok-name_1");
    }

    #[test]
    fn unparseable_project_file_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join(".mcp.json"), "{ not json").unwrap();
        let entries = load(&opts(&project, None, &[], &[], &no_env));
        assert!(entries.is_empty());
    }

    #[test]
    fn remote_endpoint_duplicate_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).unwrap();
        let claude_json = dir.path().join("claude.json");
        write_json(
            &claude_json,
            serde_json::json!({
                "mcpServers": {"web": {"type": "http", "url": "https://X.example.com:443/mcp/"}}
            }),
        );
        let plugin = PluginServers {
            plugin: "p".to_string(),
            root: dir.path().join("p"),
            data_dir: dir.path().join("pd"),
            servers: serde_json::json!({
                "web2": {"url": "https://x.example.com/mcp"}
            }),
        };
        let entries = load(&opts(
            &project,
            Some(&claude_json),
            &[],
            std::slice::from_ref(&plugin),
            &no_env,
        ));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "web");
        assert_eq!(entries[0].scope, Scope::User);
        match &entries[0].transport {
            Transport::Remote { kind, url, .. } => {
                assert_eq!(kind, "http");
                assert_eq!(url, "https://X.example.com:443/mcp/");
            }
            other => panic!("expected remote, got {other:?}"),
        }
    }
}
