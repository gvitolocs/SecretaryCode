//! Plugins (code.claude.com/docs/en/plugins-reference): a directory with an
//! optional `.claude-plugin/plugin.json` and components in their standard
//! places (`skills/`, `commands/`, `agents/`, `hooks/hooks.json`,
//! `.mcp.json`, `bin/`) or where the manifest points.
//!
//! oc-claude loads plugins from directories given explicitly (`--plugin-dir`
//! or `OC_CLAUDE_PLUGIN_DIRS`), the way `claude --plugin-dir` does. Installing
//! from marketplaces is out of scope.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// One command a plugin declares, from a file or inline.
#[derive(Debug, Clone)]
pub struct PluginCommand {
    pub name: String,
    pub file: Option<PathBuf>,
    pub content: Option<String>,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub allowed_tools: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Plugin {
    pub name: String,
    pub root: PathBuf,
    /// `~/.claude/plugins/data/<id>/` (`CLAUDE_PLUGIN_DATA`).
    pub data_dir: PathBuf,
    pub manifest: Value,
    /// Directories that each hold `<name>/SKILL.md` folders.
    pub skill_dirs: Vec<PathBuf>,
    /// A plugin-root `SKILL.md` loaded as a single skill.
    pub root_skill: Option<PathBuf>,
    pub commands: Vec<PluginCommand>,
    /// Command directories (flat `.md` files).
    pub command_dirs: Vec<PathBuf>,
    pub agent_files: Vec<PathBuf>,
    /// `hooks` objects (each the event map, without the `"hooks"` wrapper).
    pub hooks: Vec<Value>,
    /// `mcpServers` maps, in load order (later names replace earlier ones).
    pub mcp_servers: Value,
    pub bin: Option<PathBuf>,
    pub warnings: Vec<String>,
}

fn data_dir_for(config_dir: &Path, name: &str) -> PathBuf {
    let id: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    config_dir.join("plugins/data").join(id)
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn paths_of(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

/// Load one plugin directory.
pub fn load(root: &Path, config_dir: &Path) -> Result<Plugin, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{}: not a directory", root.display()));
    }
    let manifest_path = root.join(".claude-plugin/plugin.json");
    let manifest = if manifest_path.is_file() {
        read_json(&manifest_path).ok_or_else(|| format!("{}: invalid JSON", manifest_path.display()))?
    } else {
        Value::Object(Default::default())
    };
    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    let within = |rel: &str| -> Option<PathBuf> {
        let p = crate::paths::normalize(&root.join(rel));
        p.starts_with(&root).then_some(p)
    };
    let mut warnings = Vec::new();

    // skills: the default `skills/` plus manifest paths
    let mut skill_dirs = Vec::new();
    if root.join("skills").is_dir() {
        skill_dirs.push(root.join("skills"));
    }
    for rel in paths_of(manifest.get("skills")) {
        match within(&rel) {
            Some(p) if p.is_dir() => skill_dirs.push(p),
            _ => warnings.push(format!("skills path {rel} not found in the plugin")),
        }
    }
    let root_skill = (skill_dirs.is_empty() && manifest.get("skills").is_none() && root.join("SKILL.md").is_file())
        .then(|| root.join("SKILL.md"));

    // commands: `commands/`, or a path / list / object map
    let mut commands = Vec::new();
    let mut command_dirs = Vec::new();
    if root.join("commands").is_dir() {
        command_dirs.push(root.join("commands"));
    }
    match manifest.get("commands") {
        Some(Value::Object(map)) => {
            for (cname, entry) in map {
                let file = entry.get("source").and_then(Value::as_str).and_then(|s| within(s));
                let content = entry.get("content").and_then(Value::as_str).map(str::to_string);
                if file.is_some() == content.is_some() {
                    warnings.push(format!("command {cname}: set exactly one of source or content"));
                    continue;
                }
                commands.push(PluginCommand {
                    name: cname.clone(),
                    file,
                    content,
                    description: entry.get("description").and_then(Value::as_str).map(str::to_string),
                    argument_hint: entry.get("argumentHint").and_then(Value::as_str).map(str::to_string),
                    allowed_tools: paths_of(entry.get("allowedTools")),
                });
            }
        }
        other => {
            for rel in paths_of(other) {
                match within(&rel) {
                    Some(p) if p.is_dir() => command_dirs.push(p),
                    Some(p) if p.is_file() => commands.push(PluginCommand {
                        name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                        file: Some(p),
                        content: None,
                        description: None,
                        argument_hint: None,
                        allowed_tools: Vec::new(),
                    }),
                    _ => warnings.push(format!("commands path {rel} not found in the plugin")),
                }
            }
        }
    }

    // agents
    let mut agent_files = Vec::new();
    if root.join("agents").is_dir() {
        collect_md(&root.join("agents"), &mut agent_files);
    }
    for rel in paths_of(manifest.get("agents")) {
        match within(&rel) {
            Some(p) if p.is_file() => agent_files.push(p),
            _ => warnings.push(format!("agents path {rel} not found in the plugin")),
        }
    }

    // hooks: hooks/hooks.json, then the manifest's path / inline / array
    let mut hooks = Vec::new();
    let hooks_file = |p: &Path, warnings: &mut Vec<String>| -> Option<Value> {
        match read_json(p) {
            Some(v) => match v.get("hooks") {
                Some(h) if h.is_object() => Some(h.clone()),
                _ => {
                    warnings.push(format!("{}: a hooks file needs the top-level \"hooks\" key", p.display()));
                    None
                }
            },
            None => {
                warnings.push(format!("{}: unreadable hooks file", p.display()));
                None
            }
        }
    };
    if root.join("hooks/hooks.json").is_file() {
        hooks.extend(hooks_file(&root.join("hooks/hooks.json"), &mut warnings));
    }
    let hook_entries: Vec<Value> = match manifest.get("hooks") {
        Some(Value::Array(a)) => a.clone(),
        Some(v) => vec![v.clone()],
        None => Vec::new(),
    };
    for entry in hook_entries {
        match entry {
            Value::String(rel) => match within(&rel) {
                Some(p) if p != root.join("hooks/hooks.json") => hooks.extend(hooks_file(&p, &mut warnings)),
                Some(_) => {}
                None => warnings.push(format!("hooks path {rel} outside the plugin")),
            },
            Value::Object(_) => hooks.push(entry),
            _ => {}
        }
    }

    // MCP servers: .mcp.json first, then the manifest's shapes in order
    let mut mcp = serde_json::Map::new();
    let mut add_map = |v: &Value| {
        let servers = v.get("mcpServers").unwrap_or(v);
        if let Some(o) = servers.as_object() {
            for (k, s) in o {
                mcp.insert(k.clone(), s.clone());
            }
        }
    };
    if let Some(v) = read_json(&root.join(".mcp.json")) {
        add_map(&v);
    }
    let mcp_entries: Vec<Value> = match manifest.get("mcpServers") {
        Some(Value::Array(a)) => a.clone(),
        Some(v) => vec![v.clone()],
        None => Vec::new(),
    };
    for entry in mcp_entries {
        match &entry {
            Value::String(rel) if rel.ends_with(".mcpb") || rel.ends_with(".dxt") => {
                warnings.push(format!("MCP bundle {rel} is not supported"));
            }
            Value::String(rel) => match within(rel).and_then(|p| read_json(&p)) {
                Some(v) => add_map(&v),
                None => warnings.push(format!("mcpServers file {rel} not readable")),
            },
            Value::Object(_) => add_map(&entry),
            _ => {}
        }
    }

    let bin = root.join("bin");
    Ok(Plugin {
        data_dir: data_dir_for(config_dir, &name),
        name,
        root: root.clone(),
        manifest,
        skill_dirs,
        root_skill,
        commands,
        command_dirs,
        agent_files,
        hooks,
        mcp_servers: Value::Object(mcp),
        bin: bin.is_dir().then_some(bin),
        warnings,
    })
}

fn collect_md(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            collect_md(&p, out);
        } else if p.extension().is_some_and(|e| e == "md") {
            out.push(p);
        }
    }
}

/// Plugin directories from `OC_CLAUDE_PLUGIN_DIRS` (colon-separated) plus
/// explicit ones.
pub fn load_all(explicit: &[PathBuf], config_dir: &Path) -> (Vec<Plugin>, Vec<String>) {
    let mut dirs: Vec<PathBuf> = explicit.to_vec();
    if let Some(v) = std::env::var_os("OC_CLAUDE_PLUGIN_DIRS") {
        dirs.extend(std::env::split_paths(&v).filter(|p| !p.as_os_str().is_empty()));
    }
    let mut plugins = Vec::new();
    let mut errors = Vec::new();
    for d in dirs {
        match load(&d, config_dir) {
            Ok(p) if plugins.iter().any(|q: &Plugin| q.name == p.name) => {
                errors.push(format!("plugin {} loaded twice; keeping the first", p.name))
            }
            Ok(p) => plugins.push(p),
            Err(e) => errors.push(e),
        }
    }
    (plugins, errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn standard_layout_and_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("deploy-tools");
        write(&root.join(".claude-plugin/plugin.json"), r#"{
            "name": "deploy-tools",
            "commands": {"about": {"content": "Explain the plugin.", "description": "Describe"}},
            "agents": ["./extra/reviewer.md"],
            "hooks": [{"PostToolUse": [{"matcher": "Write", "hooks": [{"type": "command", "command": "fmt"}]}]}],
            "mcpServers": {"api": {"command": "${CLAUDE_PLUGIN_ROOT}/server"}}
        }"#);
        write(&root.join("skills/deploy/SKILL.md"), "---\nname: deploy\n---\nDeploy");
        write(&root.join("commands/status.md"), "Status");
        write(&root.join("agents/tester.md"), "---\nname: tester\ndescription: t\n---\nTest");
        write(&root.join("extra/reviewer.md"), "---\nname: reviewer\ndescription: r\n---\nReview");
        write(&root.join("hooks/hooks.json"), r#"{"hooks": {"PreToolUse": []}}"#);
        write(&root.join(".mcp.json"), r#"{"mcpServers": {"db": {"command": "db"}, "api": {"command": "old"}}}"#);
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let p = load(&root, &dir.path().join("cfg")).unwrap();
        assert_eq!(p.name, "deploy-tools");
        assert_eq!(p.skill_dirs.len(), 1);
        assert_eq!(p.command_dirs.len(), 1);
        assert_eq!(p.commands[0].name, "about");
        assert_eq!(p.agent_files.len(), 2);
        assert_eq!(p.hooks.len(), 2);
        assert_eq!(p.mcp_servers["api"]["command"], "${CLAUDE_PLUGIN_ROOT}/server", "manifest replaces .mcp.json");
        assert!(p.mcp_servers.get("db").is_some());
        assert!(p.bin.is_some());
        assert!(p.data_dir.ends_with("plugins/data/deploy-tools"));
        assert!(p.warnings.is_empty(), "{:?}", p.warnings);
    }

    #[test]
    fn no_manifest_uses_directory_name_and_root_skill() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("solo");
        write(&root.join("SKILL.md"), "---\nname: review\n---\nReview");
        let p = load(&root, dir.path()).unwrap();
        assert_eq!(p.name, "solo");
        assert!(p.root_skill.is_some());
    }

    #[test]
    fn hooks_file_without_wrapper_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("p");
        write(&root.join("hooks/hooks.json"), r#"{"PreToolUse": []}"#);
        let p = load(&root, dir.path()).unwrap();
        assert!(p.hooks.is_empty());
        assert_eq!(p.warnings.len(), 1);
    }
}
