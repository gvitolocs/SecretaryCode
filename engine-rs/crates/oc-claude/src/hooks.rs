//! Claude Code hooks (code.claude.com/docs/en/hooks): configuration,
//! matchers, the `if` filter, command and HTTP handlers, and how a run's
//! exit code, stdout and stderr turn into an outcome. Event semantics (what a
//! block means for PreToolUse vs Stop) live in `runtime.rs`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use oc_permission::claude::{if_matches, parse_rule, PathContext, Request, Rule, RuleKind, Source};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Events whose `matcher` field is honoured (hooks reference, "Matcher patterns").
const MATCHER_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
    "SessionStart",
    "Setup",
    "SessionEnd",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "ConfigChange",
    "DirectoryAdded",
    "FileChanged",
    "StopFailure",
    "InstructionsLoaded",
    "UserPromptExpansion",
    "Elicitation",
    "ElicitationResult",
    "PreModelSwitch",
    "PostModelSwitch",
];

/// Tool events: the only ones where `if` is evaluated.
const TOOL_EVENTS: &[&str] = &["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"];

/// Where a handler was declared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// Any settings file.
    Settings,
    Plugin { name: String, root: PathBuf, data: PathBuf },
    /// Skill frontmatter: registered when the skill runs.
    Skill(String),
    /// Subagent frontmatter: only while that subagent runs.
    Agent(String),
}

impl Origin {
    pub fn label(&self) -> String {
        match self {
            Origin::Settings => "[settings]".into(),
            Origin::Plugin { name, .. } => format!("[plugin:{name}]"),
            Origin::Skill(_) => "[skill]".into(),
            Origin::Agent(_) => "[settings]".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    Command {
        command: String,
        args: Option<Vec<String>>,
        shell: Option<String>,
        is_async: bool,
    },
    Http {
        url: String,
        headers: Vec<(String, String)>,
        allowed_env_vars: Vec<String>,
    },
    /// `mcp_tool`, `prompt`, `agent`: parsed, not run (see the fidelity matrix).
    Unsupported(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Copy)]
pub enum OnFailure {
    Continue,
    Block,
}

#[derive(Debug, Clone)]
pub struct Handler {
    pub kind: Kind,
    pub if_rule: Option<Rule>,
    pub timeout: Option<f64>,
    pub once: bool,
    pub on_failure: Option<OnFailure>,
    pub origin: Origin,
}

impl Handler {
    /// What the hook runs, for messages (`[command]`).
    pub fn display(&self) -> String {
        match &self.kind {
            Kind::Command { command, args, .. } => match args {
                Some(a) if !a.is_empty() => format!("{command} {}", a.join(" ")),
                _ => command.clone(),
            },
            Kind::Http { url, .. } => url.clone(),
            Kind::Unsupported(t) => t.clone(),
        }
    }

    fn dedupe_key(&self) -> Option<String> {
        // Settings copies of one handler run once; plugin and skill copies stay apart.
        (self.origin == Origin::Settings).then(|| format!("{:?}|{:?}|{:?}", self.kind, self.if_rule.as_ref().map(|r| &r.raw), self.timeout))
    }
}

#[derive(Debug, Clone)]
pub struct Group {
    pub matcher: Option<String>,
    pub handlers: Vec<Handler>,
}

/// Every configured hook, by event name.
#[derive(Debug, Clone, Default)]
pub struct HookSet {
    pub events: BTreeMap<String, Vec<Group>>,
}

impl HookSet {
    /// Parse a `hooks` object (`{"PreToolUse": [{"matcher": .., "hooks": [..]}]}`).
    pub fn parse(value: &Value, origin: &Origin, anchor: &Path) -> (HookSet, Vec<String>) {
        let mut set = HookSet::default();
        let mut warnings = Vec::new();
        let Some(events) = value.as_object() else {
            return (set, warnings);
        };
        for (event, groups) in events {
            // Subagent frontmatter: a Stop hook fires as SubagentStop.
            let event_name = match (origin, event.as_str()) {
                (Origin::Agent(_), "Stop") => "SubagentStop".to_string(),
                _ => event.clone(),
            };
            let Some(groups) = groups.as_array() else {
                warnings.push(format!("hooks.{event}: not an array"));
                continue;
            };
            for g in groups {
                let matcher = g.get("matcher").and_then(Value::as_str).map(str::to_string);
                let mut handlers = Vec::new();
                for h in g.get("hooks").and_then(Value::as_array).into_iter().flatten() {
                    match parse_handler(h, origin, anchor) {
                        Ok(handler) => handlers.push(handler),
                        Err(e) => warnings.push(format!("hooks.{event}: {e}")),
                    }
                }
                if !handlers.is_empty() {
                    set.events.entry(event_name.clone()).or_default().push(Group { matcher, handlers });
                }
            }
        }
        (set, warnings)
    }

    pub fn extend(&mut self, other: HookSet) {
        for (event, groups) in other.events {
            self.events.entry(event).or_default().extend(groups);
        }
    }

    /// Handlers for an event whose matcher accepts `value`, settings
    /// duplicates removed. Agent-scoped handlers only for that agent.
    pub fn matching(&self, event: &str, value: Option<&str>, agent: Option<&str>) -> Vec<Handler> {
        let mut out: Vec<Handler> = Vec::new();
        let mut keys: Vec<String> = Vec::new();
        for g in self.events.get(event).into_iter().flatten() {
            let ok = !MATCHER_EVENTS.contains(&event) || matcher_matches(g.matcher.as_deref(), value.unwrap_or(""), event);
            if !ok {
                continue;
            }
            for h in &g.handlers {
                if let Origin::Agent(name) = &h.origin {
                    if agent != Some(name.as_str()) {
                        continue;
                    }
                }
                if let Some(k) = h.dedupe_key() {
                    if keys.contains(&k) {
                        continue;
                    }
                    keys.push(k);
                }
                out.push(h.clone());
            }
        }
        out
    }

    /// Drop a `once` skill handler after its first successful run.
    pub fn remove_once(&mut self, event: &str, done: &Handler) {
        if let Some(groups) = self.events.get_mut(event) {
            for g in groups.iter_mut() {
                g.handlers.retain(|h| !(h.once && h.kind == done.kind && h.origin == done.origin));
            }
        }
    }
}

fn parse_handler(h: &Value, origin: &Origin, anchor: &Path) -> Result<Handler, String> {
    let ty = h.get("type").and_then(Value::as_str).unwrap_or("command");
    let kind = match ty {
        "command" => Kind::Command {
            command: h
                .get("command")
                .and_then(Value::as_str)
                .ok_or("command hook without `command`")?
                .to_string(),
            args: h
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()),
            shell: h.get("shell").and_then(Value::as_str).map(str::to_string),
            is_async: h.get("async").and_then(Value::as_bool) == Some(true)
                || h.get("asyncRewake").and_then(Value::as_bool) == Some(true),
        },
        "http" => Kind::Http {
            url: h.get("url").and_then(Value::as_str).ok_or("http hook without `url`")?.to_string(),
            headers: h
                .get("headers")
                .and_then(Value::as_object)
                .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
                .unwrap_or_default(),
            allowed_env_vars: h
                .get("allowedEnvVars")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
        },
        other => Kind::Unsupported(other.to_string()),
    };
    let if_rule = h
        .get("if")
        .and_then(Value::as_str)
        .map(|raw| {
            parse_rule(raw, RuleKind::Allow, Source { name: "hook if".into(), anchor: anchor.to_path_buf() })
                .ok_or_else(|| format!("bad `if` rule {raw:?}"))
        })
        .transpose()?;
    Ok(Handler {
        kind,
        if_rule,
        timeout: h.get("timeout").and_then(Value::as_f64),
        once: matches!(origin, Origin::Skill(_)) && h.get("once").and_then(Value::as_bool) == Some(true),
        on_failure: match h.get("onFailure").and_then(Value::as_str) {
            Some("block") => Some(OnFailure::Block),
            Some("continue") => Some(OnFailure::Continue),
            _ => None,
        },
        origin: origin.clone(),
    })
}

/// `"*"`, `""` or no matcher: everything. Only letters, digits, `_`, `-`,
/// spaces, `,` and `|`: exact names separated by `|` or `,` (`|` only, and
/// no `-`/space/`,`, for FileChanged and StopFailure). Anything else: an
/// unanchored regular expression.
pub fn matcher_matches(matcher: Option<&str>, value: &str, event: &str) -> bool {
    let Some(m) = matcher.map(str::trim) else {
        return true;
    };
    if m.is_empty() || m == "*" {
        return true;
    }
    let narrow = event == "FileChanged" || event == "StopFailure";
    let exact = m.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '_' || c == '|' || (!narrow && (c == '-' || c == ' ' || c == ','))
    });
    if exact {
        let seps: &[char] = if narrow { &['|'] } else { &['|', ','] };
        return m.split(seps).map(str::trim).any(|alt| alt == value);
    }
    regex::Regex::new(m).is_ok_and(|re| re.is_match(value))
}

/// Does a handler's `if` rule accept this tool call? (Only on tool events;
/// a handler with `if` never runs on other events.)
pub fn if_accepts(h: &Handler, event: &str, req: Option<(&Request, &PathContext)>) -> bool {
    match (&h.if_rule, req) {
        (None, _) => true,
        (Some(_), _) if !TOOL_EVENTS.contains(&event) => false,
        (Some(rule), Some((req, ctx))) => if_matches(rule, req, ctx),
        (Some(_), None) => false,
    }
}

/// One handler's run.
#[derive(Debug, Clone, Default)]
pub struct RunResult {
    pub exit: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// It could not start, timed out, or the HTTP call failed.
    pub failed: Option<String>,
    pub timed_out: bool,
}

/// How Claude Code reads a finished run (hooks reference, "Exit code output").
#[derive(Debug, Clone, PartialEq)]
pub enum Interp {
    /// Exit 0, or any code with valid JSON: the fields apply.
    Json(serde_json::Map<String, Value>),
    /// Exit 0 with plain text (or nothing).
    Text(String),
    /// Exit 2: block; the reason is stderr unless the JSON gives one.
    Block { stderr: String, json: Option<serde_json::Map<String, Value>> },
    /// Any other failure: the action goes ahead (unless onFailure is block).
    NonBlocking(String),
    /// A failure of a hook with `onFailure: "block"`.
    FailedBlock(String),
}

/// stdout counts as JSON only when it is one object with nothing around it
/// but whitespace.
fn parse_stdout(stdout: &str) -> Option<Result<serde_json::Map<String, Value>, String>> {
    let t = stdout.trim();
    if !(t.starts_with('{') && t.ends_with('}')) {
        return None;
    }
    Some(match serde_json::from_str::<Value>(t) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err("hook output is not a JSON object".into()),
        Err(e) => Err(format!("hook output is not valid JSON: {e}")),
    })
}

pub fn interpret(run: &RunResult, h: &Handler) -> Interp {
    let block_on_failure = h.on_failure == Some(OnFailure::Block);
    if let Some(why) = &run.failed {
        let msg = if run.timed_out { format!("timed out ({why})") } else { format!("failed ({why})") };
        return if block_on_failure {
            Interp::FailedBlock(format!("{msg}; blocking because onFailure is \"block\""))
        } else {
            Interp::NonBlocking(msg)
        };
    }
    let parsed = parse_stdout(&run.stdout);
    match run.exit {
        Some(0) => match parsed {
            Some(Ok(map)) => Interp::Json(map),
            Some(Err(e)) if block_on_failure => Interp::FailedBlock(format!("{e}; blocking because onFailure is \"block\"")),
            Some(Err(e)) => Interp::NonBlocking(e),
            None => Interp::Text(run.stdout.clone()),
        },
        Some(2) => Interp::Block {
            stderr: run.stderr.trim().to_string(),
            json: parsed.and_then(Result::ok),
        },
        other => {
            if !block_on_failure {
                if let Some(Ok(map)) = parsed {
                    return Interp::Json(map);
                }
            }
            let first = run.stderr.lines().next().unwrap_or("").trim().to_string();
            let msg = match other {
                Some(code) => format!("Failed with non-blocking status code {code}: {first}"),
                None => format!("killed by a signal: {first}"),
            };
            if block_on_failure {
                Interp::FailedBlock(format!("{msg}; blocking because onFailure is \"block\""))
            } else {
                Interp::NonBlocking(msg)
            }
        }
    }
}

/// Context every handler runs with.
#[derive(Debug, Clone)]
pub struct RunContext {
    pub cwd: PathBuf,
    pub project_dir: PathBuf,
}

/// The placeholders a handler sees, as strings.
fn placeholders(h: &Handler, ctx: &RunContext) -> Vec<(&'static str, String)> {
    let mut v = vec![("CLAUDE_PROJECT_DIR", ctx.project_dir.to_string_lossy().into_owned())];
    if let Origin::Plugin { root, data, .. } = &h.origin {
        v.push(("CLAUDE_PLUGIN_ROOT", root.to_string_lossy().into_owned()));
        v.push(("CLAUDE_PLUGIN_DATA", data.to_string_lossy().into_owned()));
    }
    v
}

fn substitute(s: &str, vars: &[(&'static str, String)]) -> String {
    let mut out = s.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("${{{k}}}"), v);
    }
    out
}

/// Run one handler with `input` on stdin (or as the POST body).
pub async fn run_handler(h: &Handler, input: &Value, default_timeout: Duration, ctx: &RunContext) -> RunResult {
    let timeout = h
        .timeout
        .filter(|t| *t > 0.0)
        .map(Duration::from_secs_f64)
        .unwrap_or(default_timeout);
    match &h.kind {
        Kind::Command { command, args, shell, is_async } => {
            run_command(h, command, args.as_deref(), shell.as_deref(), *is_async, input, timeout, ctx).await
        }
        Kind::Http { url, headers, allowed_env_vars } => run_http(url, headers, allowed_env_vars, input, timeout).await,
        Kind::Unsupported(t) => RunResult {
            failed: Some(format!("`{t}` hooks are not supported by oc-claude")),
            ..Default::default()
        },
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_command(
    h: &Handler,
    command: &str,
    args: Option<&[String]>,
    shell: Option<&str>,
    is_async: bool,
    input: &Value,
    timeout: Duration,
    ctx: &RunContext,
) -> RunResult {
    let vars = placeholders(h, ctx);
    let mut cmd = match args {
        // Exec form: no shell, each argument as written.
        Some(args) => {
            let mut c = tokio::process::Command::new(substitute(command, &vars));
            c.args(args.iter().map(|a| substitute(a, &vars)));
            c
        }
        None => {
            let program = match shell {
                Some("powershell") => "pwsh",
                Some("bash") => "bash",
                _ if which("bash") => "bash",
                _ => "sh",
            };
            let mut c = tokio::process::Command::new(program);
            c.arg("-c").arg(substitute(command, &vars));
            c
        }
    };
    let cwd = if ctx.cwd.is_dir() { ctx.cwd.clone() } else { ctx.project_dir.clone() };
    cmd.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(if is_async { Stdio::null() } else { Stdio::piped() })
        .stderr(if is_async { Stdio::null() } else { Stdio::piped() })
        .kill_on_drop(!is_async);
    for (k, v) in &vars {
        cmd.env(k, v);
    }
    // "Command hooks run in their own session without a controlling terminal."
    // SAFETY: setsid is async-signal-safe and touches no Rust state.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RunResult {
                failed: Some(format!("could not start {command}: {e}")),
                ..Default::default()
            }
        }
    };
    let body = serde_json::to_vec(input).unwrap_or_default();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&body).await;
        drop(stdin);
    }
    if is_async {
        // Background hooks never decide anything.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        return RunResult { exit: Some(0), ..Default::default() };
    }
    let pid = child.id();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let work = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let read_out = async {
            if let Some(s) = stdout.as_mut() {
                let _ = s.read_to_end(&mut out).await;
            }
        };
        let read_err = async {
            if let Some(s) = stderr.as_mut() {
                let _ = s.read_to_end(&mut err).await;
            }
        };
        tokio::join!(read_out, read_err);
        let status = child.wait().await;
        (status, out, err)
    };
    match tokio::time::timeout(timeout, work).await {
        Ok((status, out, err)) => RunResult {
            exit: status.ok().and_then(|s| s.code()),
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            failed: None,
            timed_out: false,
        },
        Err(_) => {
            if let Some(pid) = pid {
                // The hook leads its own session and process group.
                // SAFETY: plain syscall on a pid we spawned.
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            RunResult {
                failed: Some(format!("after {}s", timeout.as_secs_f64())),
                timed_out: true,
                ..Default::default()
            }
        }
    }
}

fn which(program: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|paths| std::env::split_paths(&paths).any(|d| d.join(program).is_file()))
}

async fn run_http(
    url: &str,
    headers: &[(String, String)],
    allowed_env_vars: &[String],
    input: &Value,
    timeout: Duration,
) -> RunResult {
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(e) => return RunResult { failed: Some(e.to_string()), ..Default::default() },
    };
    let mut req = client.post(url).json(input);
    for (k, v) in headers {
        // Only the listed variables are interpolated into headers.
        let mut value = v.clone();
        for name in allowed_env_vars {
            let val = std::env::var(name).unwrap_or_default();
            value = value.replace(&format!("${{{name}}}"), &val).replace(&format!("${name}"), &val);
        }
        req = req.header(k, value);
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.text().await.unwrap_or_default();
            let trimmed = body.trim();
            if trimmed.is_empty() || trimmed.starts_with('{') {
                RunResult { exit: Some(0), stdout: body, ..Default::default() }
            } else {
                RunResult { failed: Some("2xx response with a body that is not JSON".into()), ..Default::default() }
            }
        }
        Ok(resp) => RunResult { failed: Some(format!("HTTP {}", resp.status())), ..Default::default() },
        Err(e) if e.is_timeout() => RunResult { failed: Some(e.to_string()), timed_out: true, ..Default::default() },
        Err(e) => RunResult { failed: Some(e.to_string()), ..Default::default() },
    }
}

/// Run every handler of one event in parallel, filtered by `if`.
pub async fn run_all(
    handlers: &[Handler],
    event: &str,
    input: &Value,
    req: Option<(&Request<'_>, &PathContext)>,
    default_timeout: Duration,
    ctx: &RunContext,
) -> Vec<(Handler, RunResult, Interp)> {
    let selected: Vec<&Handler> = handlers.iter().filter(|h| if_accepts(h, event, req)).collect();
    let runs = selected.iter().map(|h| run_handler(h, input, default_timeout, ctx));
    let results = futures_util::future::join_all(runs).await;
    selected
        .into_iter()
        .zip(results)
        .map(|(h, r)| {
            let i = interpret(&r, h);
            (h.clone(), r, i)
        })
        .collect()
}

/// `hookSpecificOutput.<field>` or a top-level field.
pub fn specific<'a>(json: &'a serde_json::Map<String, Value>, field: &str) -> Option<&'a Value> {
    json.get("hookSpecificOutput").and_then(|h| h.get(field))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cmd(command: &str) -> Handler {
        Handler {
            kind: Kind::Command { command: command.into(), args: None, shell: None, is_async: false },
            if_rule: None,
            timeout: None,
            once: false,
            on_failure: None,
            origin: Origin::Settings,
        }
    }

    fn ctx(dir: &Path) -> RunContext {
        RunContext { cwd: dir.to_path_buf(), project_dir: dir.to_path_buf() }
    }

    #[test]
    fn matchers() {
        assert!(matcher_matches(None, "Bash", "PreToolUse"));
        assert!(matcher_matches(Some("*"), "Bash", "PreToolUse"));
        assert!(matcher_matches(Some("Edit|Write"), "Write", "PreToolUse"));
        assert!(matcher_matches(Some("Edit, Write"), "Edit", "PreToolUse"));
        assert!(!matcher_matches(Some("Edit"), "NotebookEdit", "PreToolUse"));
        assert!(matcher_matches(Some("Edit.*"), "NotebookEdit", "PreToolUse"), "regex is unanchored");
        assert!(!matcher_matches(Some("^Edit$"), "NotebookEdit", "PreToolUse"));
        assert!(matcher_matches(Some("mcp__memory__.*"), "mcp__memory__create", "PreToolUse"));
        assert!(!matcher_matches(Some("mcp__memory"), "mcp__memory__create", "PreToolUse"), "exact chars compare exactly");
        assert!(matcher_matches(Some("code-reviewer"), "code-reviewer", "SubagentStop"));
    }

    #[test]
    fn parse_and_dedupe() {
        let v = json!({
            "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "a.sh"}, {"type": "prompt", "prompt": "x"}]}],
            "Stop": [{"hooks": [{"type": "command", "command": "s.sh"}]}]
        });
        let (mut set, warnings) = HookSet::parse(&v, &Origin::Settings, Path::new("/p"));
        assert!(warnings.is_empty());
        let (again, _) = HookSet::parse(&v, &Origin::Settings, Path::new("/p"));
        set.extend(again);
        let pre = set.matching("PreToolUse", Some("Bash"), None);
        assert_eq!(pre.len(), 2, "duplicates across settings files run once");
        assert!(set.matching("PreToolUse", Some("Read"), None).is_empty());
        // Stop has no matcher support: always fires
        assert_eq!(set.matching("Stop", None, None).len(), 1);
        let (agent_set, _) = HookSet::parse(&json!({"Stop": [{"hooks": [{"command": "x"}]}]}), &Origin::Agent("rev".into()), Path::new("/p"));
        assert!(agent_set.events.contains_key("SubagentStop"));
        assert!(agent_set.matching("SubagentStop", Some("rev"), Some("other")).is_empty());
        assert_eq!(agent_set.matching("SubagentStop", Some("rev"), Some("rev")).len(), 1);
    }

    #[test]
    fn interpretation_table() {
        let h = cmd("x");
        let run = |exit: i32, out: &str, err: &str| RunResult { exit: Some(exit), stdout: out.into(), stderr: err.into(), ..Default::default() };
        assert!(matches!(interpret(&run(0, "{\"continue\":false}", ""), &h), Interp::Json(_)));
        assert!(matches!(interpret(&run(0, "plain", ""), &h), Interp::Text(t) if t == "plain"));
        assert!(matches!(interpret(&run(0, "{bad}", ""), &h), Interp::NonBlocking(_)));
        assert!(matches!(interpret(&run(2, "", "nope"), &h), Interp::Block { stderr, .. } if stderr == "nope"));
        assert!(matches!(interpret(&run(1, "{\"decision\":\"block\"}", ""), &h), Interp::Json(_)), "valid JSON decides on other codes");
        assert!(matches!(interpret(&run(1, "", "broke\nmore"), &h), Interp::NonBlocking(m) if m.contains("broke") && !m.contains("more")));
        let mut b = cmd("x");
        b.on_failure = Some(OnFailure::Block);
        assert!(matches!(interpret(&run(1, "{\"x\":1}", ""), &b), Interp::FailedBlock(_)));
        let failed = RunResult { failed: Some("no such file".into()), ..Default::default() };
        assert!(matches!(interpret(&failed, &b), Interp::FailedBlock(m) if m.contains("onFailure")));
        assert!(matches!(interpret(&failed, &h), Interp::NonBlocking(_)));
    }

    #[tokio::test]
    async fn command_gets_stdin_env_and_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let h = cmd("read line; echo \"$line\" | grep -q '\"tool_name\":\"Bash\"' && echo \"$CLAUDE_PROJECT_DIR\" && echo blocked >&2 && exit 2");
        let r = run_handler(&h, &json!({"tool_name": "Bash"}), Duration::from_secs(10), &ctx(dir.path())).await;
        assert_eq!(r.exit, Some(2));
        assert_eq!(r.stdout.trim(), dir.path().to_string_lossy());
        assert_eq!(r.stderr.trim(), "blocked");
    }

    #[tokio::test]
    async fn exec_form_and_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let mut h = cmd("echo");
        h.kind = Kind::Command { command: "echo".into(), args: Some(vec!["${CLAUDE_PROJECT_DIR}".into(), "$HOME".into()]), shell: None, is_async: false };
        let r = run_handler(&h, &json!({}), Duration::from_secs(10), &ctx(dir.path())).await;
        assert_eq!(r.stdout.trim(), format!("{} $HOME", dir.path().display()), "exec form: no shell expansion");
        let mut slow = cmd("sleep 5; echo late");
        slow.timeout = Some(0.3);
        let started = std::time::Instant::now();
        let r = run_handler(&slow, &json!({}), Duration::from_secs(10), &ctx(dir.path())).await;
        assert!(r.timed_out && started.elapsed() < Duration::from_secs(3));
        let missing = cmd("/no/such/hook.sh");
        let r = run_handler(&missing, &json!({}), Duration::from_secs(10), &ctx(dir.path())).await;
        assert_eq!(r.exit, Some(127));
    }

    #[tokio::test]
    async fn if_filter_runs_only_matching_calls() {
        let dir = tempfile::tempdir().unwrap();
        let v = json!({"PreToolUse": [{"matcher": "Bash", "hooks": [{"command": "exit 2", "if": "Bash(rm *)"}]}]});
        let (set, _) = HookSet::parse(&v, &Origin::Settings, dir.path());
        let handlers = set.matching("PreToolUse", Some("Bash"), None);
        let pctx = PathContext { cwd: dir.path().to_path_buf(), home: dir.path().to_path_buf() };
        let input = json!({"command": "ls"});
        let req = Request { tool: "Bash", input: &input };
        let out = run_all(&handlers, "PreToolUse", &json!({}), Some((&req, &pctx)), Duration::from_secs(5), &ctx(dir.path())).await;
        assert!(out.is_empty());
        let input = json!({"command": "rm -rf x"});
        let req = Request { tool: "Bash", input: &input };
        let out = run_all(&handlers, "PreToolUse", &json!({}), Some((&req, &pctx)), Duration::from_secs(5), &ctx(dir.path())).await;
        assert_eq!(out.len(), 1);
        // `if` on a non-tool event: never runs
        assert!(!if_accepts(&handlers[0], "Stop", None));
    }
}
