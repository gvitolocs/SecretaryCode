//! Custom subagents (code.claude.com/docs/en/sub-agents): Markdown files with
//! `name`/`description` frontmatter and the system prompt as the body, in
//! `.claude/agents/` (walking up from the cwd; closest wins),
//! `~/.claude/agents/`, and plugins (`plugin:name`, lowest priority).

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::frontmatter;
use crate::paths::ClaudeEnv;
use crate::plugins::Plugin;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSource {
    Project,
    User,
    Plugin,
}

#[derive(Debug, Clone)]
pub struct AgentDef {
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub file: PathBuf,
    pub source: AgentSource,
    /// Claude Code tool names (or `mcp__…` patterns); None inherits all.
    pub tools: Option<Vec<String>>,
    pub disallowed_tools: Vec<String>,
    pub model: Option<String>,
    pub max_turns: Option<u32>,
    pub skills: Vec<String>,
    pub hooks: Option<Value>,
    pub omit_claude_md: bool,
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().is_some_and(|e| e == "md") {
            out.push(p);
        }
    }
}

/// Parse one agent file. Files without `name` or `description`, or whose
/// name holds `:` (reserved for plugins), are skipped.
pub fn parse(file: &Path, source: AgentSource, plugin: Option<&str>) -> Option<AgentDef> {
    let text = std::fs::read_to_string(file).ok()?;
    let fm = frontmatter::split(&text);
    if !fm.present || fm.error.is_some() {
        return None;
    }
    let short = fm.str_field("name")?.trim().to_string();
    let description = fm.str_field("description")?;
    if short.is_empty() || short.chars().count() > 256 || short.contains(':') {
        return None;
    }
    let name = match plugin {
        Some(p) => format!("{p}:{short}"),
        None => short,
    };
    let is_plugin = source == AgentSource::Plugin;
    Some(AgentDef {
        name,
        description,
        prompt: fm.body.trim().to_string(),
        file: file.to_path_buf(),
        source,
        tools: fm.list_field("tools"),
        disallowed_tools: fm.list_field("disallowedTools").unwrap_or_default(),
        model: fm.str_field("model"),
        max_turns: fm.str_field("maxTurns").and_then(|v| v.parse().ok()),
        skills: fm.list_field("skills").unwrap_or_default(),
        // "Ignored for plugin subagents"
        hooks: if is_plugin { None } else { fm.get("hooks").filter(|h| h.is_object()).cloned() },
        omit_claude_md: fm.bool_field("omitClaudeMd").unwrap_or(false),
    })
}

/// Every subagent, highest priority first, one per name.
pub fn load(env: &ClaudeEnv, plugins: &[Plugin]) -> Vec<AgentDef> {
    let mut out: Vec<AgentDef> = Vec::new();
    let push = |def: AgentDef, out: &mut Vec<AgentDef>| {
        if !out.iter().any(|d| d.name == def.name) {
            out.push(def);
        }
    };
    // Project: cwd first, so the closest definition wins.
    for dir in env.up_to_repo_root() {
        if crate::paths::normalize(&dir.join(".claude")) == crate::paths::normalize(&env.config_dir) {
            continue;
        }
        let mut files = Vec::new();
        collect(&dir.join(".claude/agents"), &mut files);
        for f in files {
            if let Some(d) = parse(&f, AgentSource::Project, None) {
                push(d, &mut out);
            }
        }
    }
    let mut files = Vec::new();
    collect(&env.config_dir.join("agents"), &mut files);
    for f in files {
        if let Some(d) = parse(&f, AgentSource::User, None) {
            push(d, &mut out);
        }
    }
    for p in plugins {
        for f in &p.agent_files {
            if let Some(d) = parse(f, AgentSource::Plugin, Some(&p.name)) {
                push(d, &mut out);
            }
        }
    }
    out
}

/// A subagent's tool list in OpenCode registry names. `tools` is an
/// allowlist after `disallowedTools` has removed entries; an entry with a
/// specifier (`Bash(git push *)`) removes the whole tool. MCP entries:
/// `mcp__server__*` / `mcp__server` / `mcp__*` against the registry.
pub fn resolve_tools(def: &AgentDef, registry: &[String]) -> (Option<Vec<String>>, Vec<String>) {
    let expand = |entry: &str| -> Vec<String> {
        let tool = entry.split('(').next().unwrap_or(entry).trim();
        if tool.starts_with("mcp__") {
            let pat = if tool.ends_with('*') {
                tool.to_string()
            } else if tool.matches("__").count() == 1 {
                format!("{tool}__*")
            } else {
                tool.to_string()
            };
            let re = format!("^{}$", regex::escape(&pat).replace(r"\*", ".*"));
            let re = regex::Regex::new(&re).ok();
            return registry.iter().filter(|n| re.as_ref().is_some_and(|r| r.is_match(n))).cloned().collect();
        }
        crate::toolmap::oc_name(tool).filter(|n| registry.contains(n)).into_iter().collect()
    };
    let denied: Vec<String> = def.disallowed_tools.iter().flat_map(|e| expand(e)).collect();
    let allowed = def.tools.as_ref().map(|list| {
        let mut v: Vec<String> = list.iter().flat_map(|e| expand(e)).filter(|n| !denied.contains(n)).collect();
        v.dedup();
        v
    });
    (allowed, denied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn priority_and_fields() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let home = root.join("home");
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        write(&home.join(".claude/agents/reviewer.md"), "---\nname: code-reviewer\ndescription: user one\n---\nU");
        write(&repo.join(".claude/agents/review/reviewer.md"), "---\nname: code-reviewer\ndescription: Reviews code\ntools: Read, Glob, Grep\nmodel: sonnet\nmaxTurns: 5\n---\nYou are a code reviewer.\n");
        write(&repo.join("app/.claude/agents/closest.md"), "---\nname: code-reviewer\ndescription: closest\n---\nC");
        write(&repo.join(".claude/agents/bad.md"), "---\nname: a:b\ndescription: x\n---\n");
        write(&repo.join(".claude/agents/nodesc.md"), "---\nname: nodesc\n---\n");
        let env = ClaudeEnv::new(&repo, &home, &home.join(".claude"), &home.join(".claude.json"), None);
        let defs = load(&env, &[]);
        assert_eq!(defs.len(), 1);
        let d = &defs[0];
        assert_eq!(d.description, "Reviews code");
        assert_eq!(d.prompt, "You are a code reviewer.");
        assert_eq!(d.max_turns, Some(5));
        assert_eq!(d.model.as_deref(), Some("sonnet"));
        let env = ClaudeEnv::new(&repo.join("app"), &home, &home.join(".claude"), &home.join(".claude.json"), None);
        assert_eq!(load(&env, &[])[0].description, "closest");
    }

    #[test]
    fn tool_resolution() {
        let registry: Vec<String> = ["shell", "read", "glob", "grep", "edit", "write", "mcp__github__get", "mcp__github__put", "mcp__slack__post"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut d = AgentDef {
            name: "x".into(),
            description: "d".into(),
            prompt: String::new(),
            file: PathBuf::new(),
            source: AgentSource::Project,
            tools: Some(vec!["Read".into(), "Grep".into(), "Bash".into(), "mcp__github__*".into(), "NotebookEdit".into()]),
            disallowed_tools: vec!["Bash(git push *)".into()],
            model: None,
            max_turns: None,
            skills: vec![],
            hooks: None,
            omit_claude_md: false,
        };
        let (allowed, denied) = resolve_tools(&d, &registry);
        assert_eq!(allowed.unwrap(), vec!["read", "grep", "mcp__github__get", "mcp__github__put"]);
        assert_eq!(denied, vec!["shell"]);
        d.tools = None;
        d.disallowed_tools = vec!["mcp__github".into()];
        let (allowed, denied) = resolve_tools(&d, &registry);
        assert!(allowed.is_none());
        assert_eq!(denied, vec!["mcp__github__get", "mcp__github__put"]);
    }
}
