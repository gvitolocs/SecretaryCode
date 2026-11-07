//! Claude Code permission rules (`permissions.allow` / `ask` / `deny` in
//! `settings.json`), evaluated the documented way: deny first, then ask,
//! then allow; the first match in that order decides and specificity does
//! not change it (code.claude.com/docs/en/permissions, "Manage
//! permissions" and "Permission rule syntax").
//!
//! Requests use Claude Code's tool names and input fields (`Bash` with
//! `command`, `Read`/`Edit`/`Write` with `file_path`, `Glob`/`Grep` with
//! `path`, `WebFetch` with `url`, `Agent` with `subagent_type`, `Skill` with
//! `skill`, MCP tools as `mcp__<server>__<tool>`); the caller translates
//! its own tools into that shape.

use std::path::{Component, Path, PathBuf};

use crate::claude_bash;

/// Which list a rule came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuleKind {
    Allow,
    Ask,
    Deny,
}

/// Where a rule came from: a name for messages and the directory a `/path`
/// pattern anchors at (the project for project/local settings, `~/.claude`
/// for user settings, the file's directory for `--settings <file>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub name: String,
    pub anchor: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    /// The rule as written.
    pub raw: String,
    pub tool: String,
    /// The text inside the parentheses; None for a bare tool name or `(*)`.
    pub spec: Option<String>,
    pub kind: RuleKind,
    pub source: Source,
}

/// Parse `Tool` or `Tool(specifier)`. Parentheses inside the specifier are
/// literal. `Tool(*)` is the same as `Tool`. Returns None for an empty or
/// malformed rule (no tool name, or a `(` without the closing `)`).
pub fn parse_rule(raw: &str, kind: RuleKind, source: Source) -> Option<Rule> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    let (tool, spec) = match text.find('(') {
        Some(open) => {
            if !text.ends_with(')') {
                return None;
            }
            let tool = text[..open].trim();
            let spec = text[open + 1..text.len() - 1].trim();
            (tool, if spec.is_empty() || spec == "*" { None } else { Some(spec.to_string()) })
        }
        None => (text, None),
    };
    if tool.is_empty() {
        return None;
    }
    // "When Claude Code loads a settings file, it skips any `mcp__` rule that has parentheses."
    if tool.starts_with("mcp__") && spec.is_some() {
        return None;
    }
    Some(Rule {
        raw: text.to_string(),
        tool: tool.to_string(),
        spec,
        kind,
        source,
    })
}

/// One tool call in Claude Code terms.
#[derive(Debug, Clone, Copy)]
pub struct Request<'a> {
    pub tool: &'a str,
    pub input: &'a serde_json::Value,
}

/// The session's directories, for path rules.
#[derive(Debug, Clone)]
pub struct PathContext {
    /// The current (primary working) directory: relative patterns anchor here.
    pub cwd: PathBuf,
    pub home: PathBuf,
}

/// The rules' answer for one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Deny(String),
    Ask(String),
    Allow(String),
    /// No rule matched.
    None,
}

#[derive(Debug, Clone, Default)]
pub struct Rules {
    pub rules: Vec<Rule>,
}

impl Rules {
    pub fn push(&mut self, rule: Rule) {
        if !self.rules.iter().any(|r| r.raw == rule.raw && r.kind == rule.kind && r.source == rule.source) {
            self.rules.push(rule);
        }
    }

    pub fn extend(&mut self, other: &Rules) {
        for r in &other.rules {
            self.push(r.clone());
        }
    }

    pub fn of_kind(&self, kind: RuleKind) -> impl Iterator<Item = &Rule> {
        self.rules.iter().filter(move |r| r.kind == kind)
    }

    /// Deny, then ask, then allow.
    pub fn evaluate(&self, req: &Request, ctx: &PathContext) -> Verdict {
        if let Some(rule) = self.first_match(RuleKind::Deny, req, ctx) {
            return Verdict::Deny(rule);
        }
        if let Some(rule) = self.first_match(RuleKind::Ask, req, ctx) {
            return Verdict::Ask(rule);
        }
        if let Some(rule) = self.allow_match(req, ctx) {
            return Verdict::Allow(rule);
        }
        Verdict::None
    }

    /// A bare-name or tool-name-glob deny removes the tool from the model's
    /// context (`Bash`, `Bash(*)`, `mcp__*`, `*`).
    pub fn removes_tool(&self, tool: &str) -> bool {
        self.of_kind(RuleKind::Deny)
            .any(|r| r.spec.is_none() && tool_name_matches(&r.tool, tool, RuleKind::Deny))
    }

    fn first_match(&self, kind: RuleKind, req: &Request, ctx: &PathContext) -> Option<String> {
        // Path rules need per-source `!` negation; everything else is a plain scan.
        if let Some(path) = path_of(req, ctx) {
            let fam = path_family(req.tool, kind);
            let mut sources: Vec<&Source> = Vec::new();
            for r in self.of_kind(kind) {
                if !sources.contains(&&r.source) {
                    sources.push(&r.source);
                }
            }
            for source in sources {
                let mut hit: Option<&Rule> = None;
                for r in self.of_kind(kind).filter(|r| &r.source == source) {
                    if !fam.contains(&r.tool.as_str()) {
                        continue;
                    }
                    let Some(spec) = r.spec.as_deref() else {
                        // A bare name covers its own tool; a bare `Edit` covers
                        // every tool that edits files.
                        if r.tool == req.tool
                            || r.tool == "Edit" && matches!(req.tool, "Write" | "NotebookEdit")
                        {
                            hit = hit.or(Some(r));
                        }
                        continue;
                    };
                    if !path_rule_tool(&r.tool) {
                        continue; // `Write(path)`, `Glob(path)`, `Grep(path)` never match a path
                    }
                    if let Some(neg) = spec.strip_prefix('!') {
                        if hit.is_some() && path_matches(neg, kind, &r.source, ctx, &path, true) {
                            hit = None;
                        }
                    } else if path_matches(spec, kind, &r.source, ctx, &path, false) {
                        hit = hit.or(Some(r));
                    }
                }
                if let Some(r) = hit {
                    return Some(r.raw.clone());
                }
            }
            // Bare tool names and globs on the tool itself still apply.
            return self
                .of_kind(kind)
                .find(|r| r.spec.is_none() && tool_name_matches(&r.tool, req.tool, kind) && !fam.contains(&r.tool.as_str()))
                .map(|r| r.raw.clone());
        }
        self.of_kind(kind)
            .find(|r| rule_matches_call(r, req, ctx, kind))
            .map(|r| r.raw.clone())
    }

    fn allow_match(&self, req: &Request, ctx: &PathContext) -> Option<String> {
        if req.tool == "Bash" {
            let command = req.input.get("command").and_then(|v| v.as_str())?;
            let allows: Vec<&Rule> = self.of_kind(RuleKind::Allow).filter(|r| r.tool == "Bash").collect();
            if let Some(r) = allows.iter().find(|r| r.spec.is_none()) {
                return Some(r.raw.clone());
            }
            let analysis = claude_bash::analyze(command, false);
            if !analysis.parsed || analysis.commands.is_empty() {
                return None;
            }
            let mut used: Vec<String> = Vec::new();
            for cmd in &analysis.commands {
                let hit = allows
                    .iter()
                    .find(|r| claude_bash::pattern_matches(r.spec.as_deref().unwrap_or("*"), &cmd.text));
                match hit {
                    Some(r) => used.push(r.raw.clone()),
                    None if claude_bash::is_read_only(&cmd.text) => {}
                    None => return None,
                }
            }
            return Some(if used.is_empty() { "read-only command".into() } else { used.join(", ") });
        }
        self.first_match(RuleKind::Allow, req, ctx)
    }
}

/// Does one rule match one call, as an `if` condition on a hook handler?
/// Bash: any subcommand matching runs the hook; an unparseable command, or a
/// pattern naming more than the program on a command with `$()`, backticks
/// or `$VAR`, runs it too (hooks reference, "How `if` patterns match Bash
/// commands"). Paths use allow-rule depth (`Edit(src/**)` is `<cwd>/src`).
pub fn if_matches(rule: &Rule, req: &Request, ctx: &PathContext) -> bool {
    if rule.tool == "Bash" && req.tool == "Bash" {
        let Some(spec) = rule.spec.as_deref() else {
            return true;
        };
        let Some(command) = req.input.get("command").and_then(|v| v.as_str()) else {
            return false;
        };
        let analysis = claude_bash::analyze(command, true);
        if !analysis.parsed {
            return true;
        }
        if analysis.commands.iter().any(|c| claude_bash::pattern_matches(spec, &c.text)) {
            return true;
        }
        let named = spec.trim();
        let named = named.strip_suffix(":*").or_else(|| named.strip_suffix(" *")).unwrap_or(named);
        return analysis.dynamic && named.split_whitespace().count() > 1;
    }
    if let Some(path) = path_of(req, ctx) {
        if !path_family(req.tool, RuleKind::Allow).contains(&rule.tool.as_str()) {
            return rule.spec.is_none() && tool_name_matches(&rule.tool, req.tool, RuleKind::Deny);
        }
        return match rule.spec.as_deref() {
            None => rule.tool == req.tool || rule.tool == "Read" || rule.tool == "Edit",
            Some(spec) => path_rule_tool(&rule.tool) && path_matches(spec, RuleKind::Allow, &rule.source, ctx, &path, false),
        };
    }
    rule_matches_call(rule, req, ctx, RuleKind::Deny)
}

fn rule_matches_call(r: &Rule, req: &Request, _ctx: &PathContext, kind: RuleKind) -> bool {
    if !tool_name_matches(&r.tool, req.tool, kind) {
        return false;
    }
    let Some(spec) = r.spec.as_deref() else {
        return true;
    };
    match req.tool {
        "Bash" => {
            let Some(command) = req.input.get("command").and_then(|v| v.as_str()) else {
                return false;
            };
            // Deny and ask apply when any subcommand matches, nested ones included.
            let analysis = claude_bash::analyze(command, true);
            analysis.commands.iter().any(|c| claude_bash::pattern_matches(spec, &c.text))
                || !analysis.parsed && claude_bash::pattern_matches(spec, &claude_bash::strip_wrappers(command, true))
        }
        "WebFetch" => {
            let Some(domain) = spec.strip_prefix("domain:") else {
                return false;
            };
            let Some(url) = req.input.get("url").and_then(|v| v.as_str()) else {
                return false;
            };
            host_of(url).is_some_and(|host| domain_matches(domain.trim(), &host))
        }
        "Agent" | "Task" => {
            let name = req
                .input
                .get("subagent_type")
                .or_else(|| req.input.get("agent"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            param_or_name(spec, req.input, name)
        }
        "Skill" => {
            let name = req.input.get("skill").and_then(|v| v.as_str()).unwrap_or("");
            let spec = spec.strip_prefix("skill:").map(str::trim).unwrap_or(spec);
            glob_text(spec, name)
        }
        _ => param_match(spec, req.input) && kind != RuleKind::Allow,
    }
}

/// `Agent(name)` names the subagent type; `Agent(model:opus)` (deny/ask)
/// matches a top-level input parameter.
fn param_or_name(spec: &str, input: &serde_json::Value, name: &str) -> bool {
    if spec.contains(':') && param_match(spec, input) {
        return true;
    }
    glob_text(spec, name)
}

/// `param:value` on a top-level scalar input field; `*` in the value is a
/// wildcard; an omitted parameter never matches.
fn param_match(spec: &str, input: &serde_json::Value) -> bool {
    let Some((name, value)) = spec.split_once(':') else {
        return false;
    };
    let (name, value) = (name.trim(), value.trim());
    let actual = match input.get(name) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Bool(b)) => b.to_string(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => return false,
    };
    glob_text(value, &actual)
}

/// `*` matches any text, everything else literally, whole string.
fn glob_text(pattern: &str, text: &str) -> bool {
    let re = format!("^{}$", regex::escape(pattern).replace(r"\*", ".*"));
    regex::Regex::new(&re).is_ok_and(|re| re.is_match(text))
}

/// Tool-name matching: exact names; `mcp__server` covers the server's
/// tools; deny and ask accept globs anywhere in the name; allow accepts a
/// glob only after a literal `mcp__<server>__` prefix.
pub fn tool_name_matches(rule_tool: &str, tool: &str, kind: RuleKind) -> bool {
    if rule_tool == tool {
        return true;
    }
    // `Task` is the Agent tool's older name.
    if (rule_tool == "Task" && tool == "Agent") || (rule_tool == "Agent" && tool == "Task") {
        return true;
    }
    if let Some(rest) = rule_tool.strip_prefix("mcp__") {
        // `mcp__server` = every tool of that server. As a deny or ask rule a
        // longer name (`mcp__reports__v2`) also covers a server whose own name
        // contains `__`; as an allow rule only the plain server form counts.
        if !rest.contains('*')
            && (kind != RuleKind::Allow || !rest.contains("__"))
            && tool.starts_with(&format!("{rule_tool}__"))
        {
            return true;
        }
    }
    if !rule_tool.contains('*') {
        return false;
    }
    if kind == RuleKind::Allow {
        let Some(rest) = rule_tool.strip_prefix("mcp__") else {
            return false;
        };
        let Some((server, _)) = rest.split_once("__") else {
            return false;
        };
        if server.is_empty() || server.contains('*') {
            return false;
        }
    }
    glob_text(rule_tool, tool)
}

// ===== paths =====

/// The rule tools whose specifier is a path pattern.
fn path_rule_tool(tool: &str) -> bool {
    tool == "Read" || tool == "Edit"
}

/// Which rule tool names apply to a path-carrying call. Read rules cover
/// Read, Glob and Grep; Edit rules cover Edit, Write and NotebookEdit; a Read
/// deny also blocks edits of the same path.
fn path_family(tool: &str, kind: RuleKind) -> &'static [&'static str] {
    match (tool, kind) {
        ("Read", _) => &["Read"],
        ("Glob", _) => &["Read", "Glob"],
        ("Grep", _) => &["Read", "Grep"],
        ("Edit", RuleKind::Deny) => &["Edit", "Read"],
        ("Write", RuleKind::Deny) => &["Edit", "Read", "Write"],
        ("NotebookEdit", RuleKind::Deny) => &["Edit", "NotebookEdit"],
        ("Edit", _) => &["Edit"],
        ("Write", _) => &["Edit", "Write"],
        ("NotebookEdit", _) => &["Edit", "NotebookEdit"],
        _ => &[],
    }
}

fn path_of(req: &Request, ctx: &PathContext) -> Option<PathBuf> {
    let field = match req.tool {
        "Read" | "Edit" | "Write" => "file_path",
        "NotebookEdit" => "notebook_path",
        "Glob" | "Grep" => "path",
        _ => return None,
    };
    let raw = req.input.get(field).and_then(|v| v.as_str()).unwrap_or("");
    Some(absolute(raw, ctx))
}

/// An absolute, lexically normalized path (`~` expands to home).
pub fn absolute(raw: &str, ctx: &PathContext) -> PathBuf {
    let joined = if raw.is_empty() {
        ctx.cwd.clone()
    } else if raw == "~" {
        ctx.home.clone()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        ctx.home.join(rest)
    } else if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        ctx.cwd.join(raw)
    };
    normalize(&joined)
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// gitignore-style path matching with Claude Code's four anchors:
/// `//path` (filesystem root), `~/path` (home), `/path` (the rule's settings
/// source), `path` or `./path` (the current directory). A bare name (no `/`
/// inside) matches at any depth; a single directory segment followed by
/// `/**` matches at any depth in deny and ask rules but only at the anchor in
/// allow rules; every other shape is anchored. A pattern that matches a
/// directory covers everything under it. `negated` reads `!` patterns
/// relative to the current directory, as the docs say.
fn path_matches(
    spec: &str,
    kind: RuleKind,
    source: &Source,
    ctx: &PathContext,
    path: &Path,
    negated: bool,
) -> bool {
    let spec = spec.trim();
    let (anchor, pattern): (PathBuf, &str) = if negated {
        let p = spec.trim_start_matches("./");
        (ctx.cwd.clone(), p.trim_start_matches('/'))
    } else if let Some(rest) = spec.strip_prefix("//") {
        (PathBuf::from("/"), rest)
    } else if let Some(rest) = spec.strip_prefix("~/") {
        (ctx.home.clone(), rest)
    } else if let Some(rest) = spec.strip_prefix('/') {
        (source.anchor.clone(), rest)
    } else {
        (ctx.cwd.clone(), spec.strip_prefix("./").unwrap_or(spec))
    };
    // `/`, `//`, `~/` and an explicit `./` name one place; a bare name
    // follows gitignore and matches at any depth.
    let explicit_anchor = !negated && (spec.starts_with('/') || spec.starts_with("~/") || spec.starts_with("./"));
    let pattern = pattern.trim_end_matches('/');
    if pattern.is_empty() {
        return path.starts_with(&anchor);
    }
    let any_depth = if explicit_anchor || pattern.starts_with("**/") {
        false
    } else if !pattern.contains('/') {
        true
    } else if kind != RuleKind::Allow {
        // `secrets/**` style: one directory segment, then `/**`
        pattern
            .strip_suffix("/**")
            .is_some_and(|dir| !dir.contains('/') && !dir.is_empty())
    } else {
        false
    };
    let anchor_text = anchor.to_string_lossy().trim_end_matches('/').to_string();
    let escaped_anchor = globset::escape(&anchor_text);
    let full = if any_depth {
        format!("{escaped_anchor}/**/{pattern}")
    } else {
        format!("{escaped_anchor}/{pattern}")
    };
    let Ok(glob) = globset::GlobBuilder::new(&full)
        .literal_separator(true)
        .backslash_escape(true)
        .build()
    else {
        // An unusable pattern still guards its exact path in deny/ask rules.
        return kind != RuleKind::Allow && path == anchor.join(pattern);
    };
    let matcher = glob.compile_matcher();
    // `dir/**` also covers searching `dir` itself (Grep/Glob on the folder).
    if let Some(dir) = full.strip_suffix("/**") {
        if let Ok(g) = globset::GlobBuilder::new(dir).literal_separator(true).backslash_escape(true).build() {
            if g.compile_matcher().is_match(path) {
                return true;
            }
        }
    }
    // The path, or a directory above it (inside the anchor), matching the
    // pattern: gitignore excludes a directory's contents with it.
    let mut cur = Some(path);
    while let Some(p) = cur {
        if !p.starts_with(&anchor) || p == anchor {
            break;
        }
        if matcher.is_match(p) {
            return true;
        }
        cur = p.parent();
    }
    false
}

// ===== WebFetch domains =====

/// The lowercased hostname of an http(s) URL, trailing dot removed.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        stripped.split(']').next()?.to_string()
    } else {
        host_port.split(':').next()?.to_string()
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// `domain:example.com` = that host only; `domain:*.example.com` = any
/// subdomain at any depth, not the apex; `domain:*` = every host; any other
/// `*` matches within one label only.
pub fn domain_matches(rule: &str, host: &str) -> bool {
    let rule = rule.trim_end_matches('.').to_ascii_lowercase();
    if rule == "*" {
        return true;
    }
    let (prefix, base) = match rule.strip_prefix("*.") {
        Some(base) => (r"(?:[^.]+\.)+", base),
        None => ("", rule.as_str()),
    };
    let re = format!("^{prefix}{}$", regex::escape(base).replace(r"\*", "[^.]*"));
    regex::Regex::new(&re).is_ok_and(|re| re.is_match(host))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn src(name: &str, anchor: &str) -> Source {
        Source {
            name: name.into(),
            anchor: PathBuf::from(anchor),
        }
    }

    fn rules(allow: &[&str], ask: &[&str], deny: &[&str]) -> Rules {
        let mut r = Rules::default();
        for (list, kind) in [(allow, RuleKind::Allow), (ask, RuleKind::Ask), (deny, RuleKind::Deny)] {
            for raw in list {
                r.push(parse_rule(raw, kind, src("project", "/repo")).unwrap());
            }
        }
        r
    }

    fn ctx() -> PathContext {
        PathContext {
            cwd: PathBuf::from("/repo"),
            home: PathBuf::from("/home/u"),
        }
    }

    fn bash(r: &Rules, cmd: &str) -> Verdict {
        r.evaluate(&Request { tool: "Bash", input: &json!({"command": cmd}) }, &ctx())
    }

    fn read(r: &Rules, tool: &str, path: &str) -> Verdict {
        let field = if tool == "Glob" || tool == "Grep" { "path" } else { "file_path" };
        r.evaluate(&Request { tool, input: &json!({ field: path }) }, &ctx())
    }

    fn is_deny(v: &Verdict) -> bool {
        matches!(v, Verdict::Deny(_))
    }
    fn is_allow(v: &Verdict) -> bool {
        matches!(v, Verdict::Allow(_))
    }
    fn is_ask(v: &Verdict) -> bool {
        matches!(v, Verdict::Ask(_))
    }

    #[test]
    fn parses_rule_shapes() {
        let s = src("user", "/h/.claude");
        let r = parse_rule("Bash(npm run *)", RuleKind::Allow, s.clone()).unwrap();
        assert_eq!((r.tool.as_str(), r.spec.as_deref()), ("Bash", Some("npm run *")));
        assert_eq!(parse_rule("Bash(*)", RuleKind::Deny, s.clone()).unwrap().spec, None);
        assert_eq!(parse_rule("Edit(./Finance (2024)/**)", RuleKind::Deny, s.clone()).unwrap().spec.as_deref(), Some("./Finance (2024)/**"));
        assert!(parse_rule("mcp__x__y(param:1)", RuleKind::Deny, s.clone()).is_none());
        assert!(parse_rule("Bash(unclosed", RuleKind::Deny, s.clone()).is_none());
        assert!(parse_rule("  ", RuleKind::Deny, s).is_none());
    }

    #[test]
    fn deny_beats_ask_beats_allow() {
        let r = rules(&["Bash(aws s3 ls)"], &["Bash(git clean *)"], &["Bash(aws *)"]);
        assert!(is_deny(&bash(&r, "aws s3 ls")));
        assert!(is_ask(&bash(&r, "cd /tmp && git clean -f")));
        assert!(is_ask(&bash(&r, "echo \"$(git clean -f)\"")));
        let r = rules(&["Bash(git clean *)"], &["Bash(git clean *)"], &[]);
        assert!(is_ask(&bash(&r, "git clean -f")));
    }

    #[test]
    fn compound_commands_need_every_part_allowed() {
        let r = rules(&["Bash(safe-cmd *)"], &[], &[]);
        assert!(is_allow(&bash(&r, "safe-cmd x")));
        assert_eq!(bash(&r, "safe-cmd && other-cmd"), Verdict::None);
        // read-only parts need no rule
        assert!(is_allow(&bash(&r, "safe-cmd x && ls -la")));
        let r = rules(&["Bash(npm *)"], &[], &[]);
        assert_eq!(bash(&r, "npm test &&"), Verdict::None);
        let r = rules(&["Bash(npm test *)"], &[], &[]);
        assert!(is_allow(&bash(&r, "timeout 30 npm test")));
        assert!(is_allow(&bash(&r, "NODE_ENV=test npm test")));
        assert_eq!(bash(&r, "FOO=bar npm test"), Verdict::None);
    }

    #[test]
    fn deny_matches_past_assignments_and_wrappers() {
        let r = rules(&[], &[], &["Bash(rm *)", "Bash(git push *)"]);
        assert!(is_deny(&bash(&r, "FOO=bar rm -rf tmp/")));
        assert!(is_deny(&bash(&r, "npm test && git push origin main")));
        assert!(!is_deny(&bash(&r, "git -C . push origin main")));
        assert!(!is_deny(&bash(&r, "/bin/rm -rf build/")));
    }

    #[test]
    fn bare_deny_removes_the_tool() {
        let r = rules(&[], &[], &["Bash", "mcp__*", "WebFetch(domain:*)"]);
        assert!(r.removes_tool("Bash"));
        assert!(r.removes_tool("mcp__github__get_issue"));
        assert!(!r.removes_tool("WebFetch"));
        assert!(!r.removes_tool("Read"));
    }

    #[test]
    fn read_deny_paths_follow_gitignore_depth() {
        let r = rules(&[], &[], &["Read(.env)", "Read(secrets/**)", "Read(./top.key)"]);
        assert!(is_deny(&read(&r, "Read", "/repo/.env")));
        assert!(is_deny(&read(&r, "Read", "/repo/sub/.env")), "bare names match at any depth");
        assert!(is_deny(&read(&r, "Read", "/repo/top.key")));
        assert!(!is_deny(&read(&r, "Read", "/repo/sub/top.key")), "./ anchors at the current directory");
        assert!(is_deny(&read(&r, "Read", "/repo/secrets/a/b.txt")));
        assert!(is_deny(&read(&r, "Read", "/repo/nested/secrets/k")), "deny dir/** matches at any depth");
        assert!(!is_deny(&read(&r, "Read", "/elsewhere/.env")));
        assert!(!is_deny(&read(&r, "Read", "/repo/src/main.rs")));
        // Read deny covers Grep/Glob paths and blocks edits
        assert!(is_deny(&read(&r, "Grep", "/repo/secrets")));
        assert!(is_deny(&read(&r, "Edit", "/repo/.env")));
        assert!(is_deny(&read(&r, "Write", "/repo/secrets/new.txt")));
    }

    #[test]
    fn allow_single_segment_is_anchored() {
        let r = rules(&["Edit(src/**)"], &[], &[]);
        assert!(is_allow(&read(&r, "Edit", "/repo/src/app.ts")));
        assert_eq!(read(&r, "Edit", "/repo/vendor/pkg/src/lib.js"), Verdict::None);
        let r = rules(&[], &[], &["Edit(src/**)"]);
        assert!(is_deny(&read(&r, "Edit", "/repo/vendor/pkg/src/lib.js")));
        let r = rules(&[], &[], &["Edit(/src/**)"]);
        assert!(is_deny(&read(&r, "Edit", "/repo/src/app.ts")));
        assert!(!is_deny(&read(&r, "Edit", "/repo/vendor/pkg/src/lib.js")));
        let r = rules(&[], &[], &["Edit(**/src/**)"]);
        assert!(is_deny(&read(&r, "Edit", "/repo/vendor/pkg/src/lib.js")));
    }

    #[test]
    fn path_anchors() {
        let mut r = Rules::default();
        r.push(parse_rule("Read(/secrets/**)", RuleKind::Deny, src("user", "/home/u/.claude")).unwrap());
        r.push(parse_rule("Read(~/.zshrc)", RuleKind::Deny, src("user", "/home/u/.claude")).unwrap());
        r.push(parse_rule("Edit(//tmp/scratch.txt)", RuleKind::Deny, src("user", "/home/u/.claude")).unwrap());
        assert!(is_deny(&read(&r, "Read", "/home/u/.claude/secrets/x")));
        assert!(!is_deny(&read(&r, "Read", "/repo/secrets/x")));
        assert!(is_deny(&read(&r, "Read", "~/.zshrc")));
        assert!(is_deny(&read(&r, "Edit", "/tmp/scratch.txt")));
        assert!(!is_deny(&read(&r, "Edit", "/repo/tmp/scratch.txt")));
    }

    #[test]
    fn star_stays_in_one_segment() {
        let r = rules(&[], &[], &["Read(src/*.rs)"]);
        assert!(is_deny(&read(&r, "Read", "/repo/src/main.rs")));
        assert!(!is_deny(&read(&r, "Read", "/repo/src/deep/main.rs")));
    }

    #[test]
    fn negation_carves_out_within_one_source() {
        let r = rules(&[], &[], &["Read(*.env)", "Read(!sample.env)"]);
        assert!(is_deny(&read(&r, "Read", "/repo/prod.env")));
        assert!(!is_deny(&read(&r, "Read", "/repo/sample.env")));
        let r = rules(&[], &[], &["Read(!sample.env)", "Read(*.env)"]);
        assert!(is_deny(&read(&r, "Read", "/repo/sample.env")), "a `!` listed first carves nothing");
        let mut r = rules(&[], &[], &["Read(*.env)"]);
        r.push(parse_rule("Read(!sample.env)", RuleKind::Deny, src("local", "/repo")).unwrap());
        assert!(is_deny(&read(&r, "Read", "/repo/sample.env")), "carve-outs stay in their source");
    }

    #[test]
    fn write_glob_grep_path_rules_never_match() {
        let r = rules(&[], &[], &["Grep(docs/**)", "Write(docs/**)"]);
        assert!(!is_deny(&read(&r, "Grep", "/repo/docs")));
        assert!(!is_deny(&read(&r, "Write", "/repo/docs/a.md")));
        let r = rules(&[], &[], &["Write"]);
        assert!(is_deny(&read(&r, "Write", "/repo/docs/a.md")));
        assert!(!is_deny(&read(&r, "Edit", "/repo/docs/a.md")));
    }

    #[test]
    fn webfetch_domains() {
        assert!(domain_matches("example.com", "example.com"));
        assert!(!domain_matches("example.com", "api.example.com"));
        assert!(domain_matches("*.example.com", "a.b.example.com"));
        assert!(!domain_matches("*.example.com", "example.com"));
        assert!(domain_matches("example.*", "example.org"));
        assert!(!domain_matches("example.*", "example.evil.com"));
        assert!(domain_matches("*", "anything.net"));
        assert_eq!(host_of("https://User@Example.COM.:8443/x?y").as_deref(), Some("example.com"));
        let r = rules(&[], &[], &["WebFetch(domain:evil.com)"]);
        let v = r.evaluate(&Request { tool: "WebFetch", input: &json!({"url": "https://evil.com/a"}) }, &ctx());
        assert!(is_deny(&v));
    }

    #[test]
    fn mcp_rules() {
        let r = rules(&["mcp__puppeteer"], &[], &[]);
        let call = |r: &Rules, t: &str| r.evaluate(&Request { tool: t, input: &json!({}) }, &ctx());
        assert!(is_allow(&call(&r, "mcp__puppeteer__puppeteer_navigate")));
        assert_eq!(call(&r, "mcp__github__x"), Verdict::None);
        let r = rules(&["mcp__github__get_*", "mcp__*", "*"], &[], &[]);
        assert!(is_allow(&call(&r, "mcp__github__get_issue")));
        assert_eq!(call(&r, "mcp__github__create_issue"), Verdict::None, "unanchored allow globs approve nothing");
        let r = rules(&[], &[], &["mcp__reports"]);
        assert!(is_deny(&call(&r, "mcp__reports__v2__run")));
    }

    #[test]
    fn agent_and_skill_rules() {
        let r = rules(&[], &[], &["Agent(Explore)", "Agent(model:opus)", "Skill(deploy)"]);
        let call = |t: &str, input: serde_json::Value| r.evaluate(&Request { tool: t, input: &input }, &ctx());
        assert!(is_deny(&call("Agent", json!({"subagent_type": "Explore"}))));
        assert!(is_deny(&call("Agent", json!({"subagent_type": "x", "model": "opus"}))));
        assert_eq!(call("Agent", json!({"subagent_type": "x"})), Verdict::None);
        assert!(is_deny(&call("Skill", json!({"skill": "deploy"}))));
    }

    #[test]
    fn hook_if_conditions() {
        let s = src("project", "/repo");
        let rule = |raw: &str| parse_rule(raw, RuleKind::Allow, s.clone()).unwrap();
        let req = |cmd: &str| json!({"command": cmd});
        let b = |raw: &str, cmd: &str| if_matches(&rule(raw), &Request { tool: "Bash", input: &req(cmd) }, &ctx());
        assert!(b("Bash(git *)", "FOO=bar git push"));
        assert!(b("Bash(git *)", "npm test && git push"));
        assert!(b("Bash(rm *)", "echo $(rm -rf /)"));
        assert!(!b("Bash(rm *)", "echo $(date)"));
        assert!(b("Bash(git push *)", "echo $(date)"));
        let e = |raw: &str, path: &str| {
            if_matches(&rule(raw), &Request { tool: "Edit", input: &json!({"file_path": path}) }, &ctx())
        };
        assert!(e("Edit(*.ts)", "/repo/a/b.ts"));
        assert!(e("Edit(src/**)", "/repo/src/x.rs"));
        assert!(!e("Edit(src/**)", "/repo/a/src/x.rs"));
        assert!(!e("Bash(git *)", "/repo/x"));
    }
}
