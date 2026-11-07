//! One session's Claude Code project: everything loaded once at start, and
//! the [`oc_agent::hooks::TurnHooks`] implementation that applies it to each
//! turn — permission rules and modes, hook events, on-demand memory, the
//! `skill` tool, subagent profiles and MCP servers.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use oc_agent::hooks::{
    CompactVerdict, HookDecision, PermissionVerdict, PostTool, PreTool, StopContext, StopVerdict, ToolCall, ToolResult,
    TurnHooks,
};
use oc_permission::claude::{parse_rule, PathContext, Request, RuleKind, Rules, Source, Verdict};
use oc_permission::claude_bash;
use serde_json::{json, Map, Value};

use crate::agents::{self, AgentDef};
use crate::hooks::{self, Handler, HookSet, Interp, Origin, RunContext};
use crate::memory::{InstructionFiles, Memory, MemoryOptions};
use crate::paths::ClaudeEnv;
use crate::plugins::{self, Plugin};
use crate::settings::{Layer, Settings};
use crate::skills::{self, Catalog, RenderVars, Skill};
use crate::toolmap;

/// Claude Code's permission modes (code.claude.com/docs/en/permission-modes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
    DontAsk,
    BypassPermissions,
}

impl PermissionMode {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "default" | "manual" | "auto" => Self::Default,
            "acceptEdits" => Self::AcceptEdits,
            "plan" => Self::Plan,
            "dontAsk" => Self::DontAsk,
            "bypassPermissions" => Self::BypassPermissions,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::DontAsk => "dontAsk",
            Self::BypassPermissions => "bypassPermissions",
        }
    }
}

/// How the session was started (command-line flags and their env twins).
#[derive(Debug, Clone, Default)]
pub struct LoadOptions {
    /// `--settings <file-or-json>`.
    pub settings_arg: Option<String>,
    /// `--plugin-dir`.
    pub plugin_dirs: Vec<PathBuf>,
    /// `--permission-mode`.
    pub permission_mode: Option<String>,
    /// `--allowedTools` / `--disallowedTools` rules.
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    /// Load `@imports` of project memory files that point outside the cwd.
    pub external_imports: bool,
}

pub type Notice = Arc<dyn Fn(&str) + Send + Sync>;

pub struct ClaudeRuntime {
    pub env: ClaudeEnv,
    pub settings: Settings,
    pub plugins: Vec<Plugin>,
    pub catalog: Catalog,
    pub agents: Vec<AgentDef>,
    pub warnings: Vec<String>,
    pub mode: PermissionMode,
    rules: Rules,
    /// `allowed-tools` of skills invoked this turn.
    grants: Mutex<Rules>,
    hooks: RwLock<HookSet>,
    registered_skill_hooks: Mutex<Vec<String>>,
    memory: Mutex<Memory>,
    session_context: Mutex<Vec<String>>,
    transcript: Mutex<Option<PathBuf>>,
    working_dirs: Vec<PathBuf>,
    notice: Notice,
}

impl ClaudeRuntime {
    pub fn load(env: ClaudeEnv, opts: &LoadOptions) -> Self {
        let settings = Settings::load(&env, opts.settings_arg.as_deref());
        let mut warnings: Vec<String> = settings.errors.clone();
        let (plugins, perr) = plugins::load_all(&opts.plugin_dirs, &env.config_dir);
        warnings.extend(perr);
        for p in &plugins {
            warnings.extend(p.warnings.iter().map(|w| format!("plugin {}: {w}", p.name)));
        }

        // Rules: settings files, then --allowedTools / --disallowedTools.
        let mut rules = settings.permission_rules();
        let cli = Source { name: "command line".into(), anchor: env.cwd.clone() };
        for raw in &opts.allowed_tools {
            rules.extend(&single(raw, RuleKind::Allow, &cli));
        }
        for raw in &opts.disallowed_tools {
            rules.extend(&single(raw, RuleKind::Deny, &cli));
        }

        let bypass_disabled = settings.str("permissions.disableBypassPermissionsMode").as_deref() == Some("disable");
        let mut mode = opts
            .permission_mode
            .as_deref()
            .or(settings.str("permissions.defaultMode").as_deref())
            .and_then(PermissionMode::parse)
            .unwrap_or(PermissionMode::Default);
        if mode == PermissionMode::BypassPermissions && bypass_disabled {
            warnings.push("bypassPermissions is disabled by settings; using default".into());
            mode = PermissionMode::Default;
        }

        // Hooks: settings files, then plugins, then subagent frontmatter.
        let mut hook_set = HookSet::default();
        for (_layer, value) in settings.hooks() {
            let (set, w) = HookSet::parse(&value, &Origin::Settings, &env.project_dir);
            hook_set.extend(set);
            warnings.extend(w);
        }
        let managed_hooks_only = settings
            .files
            .iter()
            .any(|f| f.layer == Layer::Managed && f.value.get("allowManagedHooksOnly") == Some(&Value::Bool(true)));
        if !managed_hooks_only {
            for p in &plugins {
                let origin = Origin::Plugin { name: p.name.clone(), root: p.root.clone(), data: p.data_dir.clone() };
                for h in &p.hooks {
                    let (set, w) = HookSet::parse(h, &origin, &p.root);
                    hook_set.extend(set);
                    warnings.extend(w);
                }
            }
        }
        let catalog = Catalog::load(&env, &plugins);
        let agents = agents::load(&env, &plugins);
        for a in &agents {
            if let Some(h) = &a.hooks {
                let (set, w) = HookSet::parse(h, &Origin::Agent(a.name.clone()), &env.project_dir);
                hook_set.extend(set);
                warnings.extend(w);
            }
        }

        // Memory.
        let instruction_files = settings
            .files
            .iter()
            .filter(|f| matches!(f.layer, Layer::User | Layer::Cli | Layer::Managed))
            .filter_map(|f| {
                ["cc-plugin-agents-md@builtin", "agents-md@builtin"].iter().find_map(|id| {
                    f.value
                        .pointer(&format!("/pluginConfigs/{id}/options/instructionFiles"))
                        .and_then(Value::as_str)
                        .and_then(InstructionFiles::parse)
                })
            })
            .last()
            .unwrap_or_default();
        let memory = Memory::load(
            &env,
            MemoryOptions {
                excludes: settings.strings("claudeMdExcludes"),
                external_imports: opts.external_imports,
                instruction_files,
            },
        );
        for p in &memory.skipped_imports {
            warnings.push(format!("external CLAUDE.md import not loaded (needs approval): {}", p.display()));
        }

        let mut working_dirs = vec![env.cwd.clone()];
        for d in settings.strings("permissions.additionalDirectories") {
            working_dirs.push(crate::paths::resolve(&d, &env.cwd, &env.home));
        }

        Self {
            settings,
            plugins,
            catalog,
            agents,
            warnings,
            mode,
            rules,
            grants: Mutex::new(Rules::default()),
            hooks: RwLock::new(hook_set),
            registered_skill_hooks: Mutex::new(Vec::new()),
            memory: Mutex::new(memory),
            session_context: Mutex::new(Vec::new()),
            transcript: Mutex::new(None),
            working_dirs,
            notice: Arc::new(|text: &str| eprintln!("{text}")),
            env,
        }
    }

    /// Where user-facing notices (hook errors, `systemMessage`) go.
    pub fn with_notice(mut self, notice: Notice) -> Self {
        self.notice = notice;
        self
    }

    pub fn set_transcript_path(&self, path: Option<PathBuf>) {
        *self.transcript.lock().unwrap() = path;
    }

    /// True when this directory has any Claude Code configuration at all.
    pub fn active(&self) -> bool {
        !self.settings.files.is_empty()
            || !self.memory.lock().unwrap().files.is_empty()
            || !self.catalog.skills.is_empty()
            || !self.agents.is_empty()
            || !self.plugins.is_empty()
            || self.env.project_dir.join(".mcp.json").is_file()
    }

    /// The `env` block of the merged settings, applied to this process (and
    /// so to every subprocess); plugin `bin/` folders go on `PATH`.
    pub fn apply_env(&self) {
        for (k, v) in self.settings.env() {
            std::env::set_var(k, v);
        }
        let bins: Vec<PathBuf> = self.plugins.iter().filter_map(|p| p.bin.clone()).collect();
        if !bins.is_empty() {
            let mut paths = bins;
            if let Some(cur) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&cur));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                std::env::set_var("PATH", joined);
            }
        }
    }

    /// The `model` setting as an OpenCode model ref, for an Anthropic
    /// endpoint only (an alias means nothing to another provider).
    pub fn model_for(&self, provider: &str) -> Option<String> {
        let m = self.settings.str("model")?;
        if m == "default" || provider != "anthropic" {
            return None;
        }
        Some(format!("anthropic/{}", crate::settings::resolve_model_alias(&m)))
    }

    /// The system prompt's project instructions: CLAUDE.md files and what
    /// SessionStart hooks added.
    pub fn instructions(&self) -> String {
        let mut text = self.memory.lock().unwrap().render();
        for c in self.session_context.lock().unwrap().iter() {
            text.push_str("\n\n");
            text.push_str(&oc_agent::hooks::system_reminder(c));
        }
        text
    }

    // ===== hook plumbing =====

    fn common_input(&self, event: &str, session_id: &str, cwd: &Path, agent: Option<&str>) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("session_id".into(), json!(session_id));
        let transcript = self.transcript.lock().unwrap().clone();
        m.insert(
            "transcript_path".into(),
            json!(transcript.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
        );
        m.insert("cwd".into(), json!(cwd.to_string_lossy()));
        m.insert("permission_mode".into(), json!(self.mode.as_str()));
        m.insert("hook_event_name".into(), json!(event));
        if let Some(a) = agent {
            m.insert("agent_id".into(), json!(session_id));
            m.insert("agent_type".into(), json!(a));
        }
        m
    }

    fn default_timeout(event: &str) -> Duration {
        match event {
            "UserPromptSubmit" | "PreModelSwitch" | "PostModelSwitch" => Duration::from_secs(30),
            _ => Duration::from_secs(600),
        }
    }

    async fn fire(
        &self,
        event: &str,
        match_value: Option<&str>,
        agent: Option<&str>,
        input: Map<String, Value>,
        req: Option<(&Request<'_>, &PathContext)>,
        cwd: &Path,
    ) -> Vec<(Handler, hooks::RunResult, Interp)> {
        let handlers = self.hooks.read().unwrap().matching(event, match_value, agent);
        if handlers.is_empty() {
            return Vec::new();
        }
        let ctx = RunContext { cwd: cwd.to_path_buf(), project_dir: self.env.project_dir.clone() };
        let out = hooks::run_all(&handlers, event, &Value::Object(input), req, Self::default_timeout(event), &ctx).await;
        for (h, _, interp) in &out {
            if h.once && matches!(interp, Interp::Json(_) | Interp::Text(_)) {
                self.hooks.write().unwrap().remove_once(event, h);
            }
            if let Interp::NonBlocking(msg) = interp {
                (self.notice)(&format!("{event} hook error: [{}]: {msg}", h.display()));
            }
            if let Interp::Json(map) = interp {
                if let Some(msg) = map.get("systemMessage").and_then(Value::as_str) {
                    if !matches!(event, "Notification" | "SessionEnd" | "PreCompact") {
                        (self.notice)(msg);
                    }
                }
            }
        }
        out
    }

    /// `SessionStart` (`startup`, `resume`, `clear`, `compact`): plain stdout
    /// and `additionalContext` become context for the model.
    pub async fn session_start(&self, session_id: &str, source: &str, model: Option<&str>) {
        let mut input = self.common_input("SessionStart", session_id, &self.env.cwd.clone(), None);
        input.insert("source".into(), json!(source));
        if let Some(m) = model {
            input.insert("model".into(), json!(m));
        }
        let cwd = self.env.cwd.clone();
        let out = self.fire("SessionStart", Some(source), None, input, None, &cwd).await;
        let mut ctx = self.session_context.lock().unwrap();
        for (h, _, interp) in out {
            if matches!(h.kind, hooks::Kind::Http { .. }) {
                continue; // only command (and mcp_tool) hooks run on SessionStart
            }
            match interp {
                Interp::Text(t) if !t.trim().is_empty() => ctx.push(cap(t.trim())),
                Interp::Json(map) => {
                    if let Some(c) = hooks::specific(&map, "additionalContext").and_then(Value::as_str) {
                        ctx.push(cap(c));
                    }
                }
                Interp::Block { stderr, .. } if !stderr.is_empty() => (self.notice)(&format!("SessionStart hook error: {stderr}")),
                _ => {}
            }
        }
    }

    /// `UserPromptSubmit`: Ok(context notes to send with the prompt) or
    /// Err(reason) when a hook blocked the prompt. Also ends the previous
    /// turn's skill grants.
    pub async fn user_prompt_submit(&self, session_id: &str, prompt: &str) -> Result<Vec<String>, String> {
        self.begin_user_turn();
        let cwd = self.env.cwd.clone();
        let mut input = self.common_input("UserPromptSubmit", session_id, &cwd, None);
        input.insert("prompt".into(), json!(prompt));
        let out = self.fire("UserPromptSubmit", None, None, input, None, &cwd).await;
        let mut notes = Vec::new();
        let mut blocked: Option<String> = None;
        for (h, _, interp) in out {
            match interp {
                Interp::Block { stderr, json } => {
                    let reason = json
                        .as_ref()
                        .and_then(|m| m.get("reason").and_then(Value::as_str).map(str::to_string))
                        .unwrap_or(stderr);
                    blocked.get_or_insert(reason);
                }
                Interp::FailedBlock(msg) => {
                    blocked.get_or_insert(format!("UserPromptSubmit hook error: [{}]: {msg}", h.display()));
                }
                Interp::Text(t) if !t.trim().is_empty() => notes.push(format!("UserPromptSubmit hook says:\n{}", cap(t.trim()))),
                Interp::Json(map) => {
                    if map.get("continue") == Some(&Value::Bool(false)) {
                        blocked.get_or_insert(map.get("stopReason").and_then(Value::as_str).unwrap_or("stopped by a hook").to_string());
                    }
                    if map.get("decision").and_then(Value::as_str) == Some("block") {
                        blocked.get_or_insert(map.get("reason").and_then(Value::as_str).unwrap_or("blocked by a hook").to_string());
                    }
                    if let Some(c) = hooks::specific(&map, "additionalContext").and_then(Value::as_str) {
                        notes.push(format!("UserPromptSubmit hook additional context:\n{}", cap(c)));
                    }
                }
                _ => {}
            }
        }
        match blocked {
            Some(reason) => Err(format!("{reason}\n\nOriginal prompt: {prompt}")),
            None => Ok(notes),
        }
    }

    /// `SessionEnd` with Claude Code's short budget (1.5 s, raised by the
    /// largest per-hook timeout up to 60 s, or
    /// `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`).
    pub async fn session_end(&self, session_id: &str, reason: &str) {
        let handlers = self.hooks.read().unwrap().matching("SessionEnd", Some(reason), None);
        if handlers.is_empty() {
            return;
        }
        let env_ms = std::env::var("CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS").ok().and_then(|v| v.parse::<u64>().ok());
        let budget = match env_ms {
            Some(ms) => Duration::from_millis(ms),
            None => {
                let max = handlers.iter().filter_map(|h| h.timeout).fold(1.5_f64, f64::max).min(60.0);
                Duration::from_secs_f64(max)
            }
        };
        let cwd = self.env.cwd.clone();
        let mut input = self.common_input("SessionEnd", session_id, &cwd, None);
        input.insert("reason".into(), json!(reason));
        let ctx = RunContext { cwd: cwd.clone(), project_dir: self.env.project_dir.clone() };
        let default = env_ms.map(Duration::from_millis).unwrap_or(Duration::from_millis(1500));
        let run = hooks::run_all(&handlers, "SessionEnd", &Value::Object(input), None, default, &ctx);
        let _ = tokio::time::timeout(budget, run).await;
    }

    /// A new user message: the previous turn's `allowed-tools` grants end.
    pub fn begin_user_turn(&self) {
        self.grants.lock().unwrap().rules.clear();
    }

    // ===== permissions =====

    fn path_context(&self, worktree: &Path) -> PathContext {
        PathContext { cwd: worktree.to_path_buf(), home: self.env.home.clone() }
    }

    fn inside_working_dirs(&self, path: &str, worktree: &Path) -> bool {
        let p = crate::paths::resolve(path, worktree, &self.env.home);
        p.starts_with(worktree) || self.working_dirs.iter().any(|d| p.starts_with(d))
    }

    /// The rules' and mode's verdict for one call in Claude Code terms.
    pub fn verdict(&self, tool: &str, input: &Value, worktree: &Path) -> PermissionVerdict {
        let req = Request { tool, input };
        let pctx = self.path_context(worktree);
        let mut rules = self.rules.clone();
        rules.extend(&self.grants.lock().unwrap());
        match rules.evaluate(&req, &pctx) {
            Verdict::Deny(rule) => {
                return PermissionVerdict::Deny(format!("Permission to use {tool} has been denied by the rule {rule}."))
            }
            Verdict::Ask(rule) if self.mode == PermissionMode::DontAsk => {
                return PermissionVerdict::Deny(format!("Permission to use {tool} was denied: the ask rule {rule} can't prompt in dontAsk mode."))
            }
            Verdict::Ask(_) => return PermissionVerdict::Ask,
            Verdict::Allow(_) => return PermissionVerdict::Allow,
            Verdict::None => {}
        }
        let read_only = self.read_only_call(tool, input, worktree);
        if read_only {
            return PermissionVerdict::Allow;
        }
        match self.mode {
            PermissionMode::BypassPermissions => PermissionVerdict::Allow,
            PermissionMode::AcceptEdits if self.accept_edits_covers(tool, input, worktree) => PermissionVerdict::Allow,
            PermissionMode::DontAsk => PermissionVerdict::Deny(format!(
                "Permission to use {tool} was denied: dontAsk mode runs only pre-approved tools."
            )),
            PermissionMode::Plan => PermissionVerdict::Deny(format!(
                "{tool} is not available in plan mode: only read-only actions run until the plan is approved."
            )),
            _ => PermissionVerdict::Pass,
        }
    }

    /// What Manual mode runs without asking: reads inside the working
    /// directories, read-only Bash commands, and tools that need no permission.
    fn read_only_call(&self, tool: &str, input: &Value, worktree: &Path) -> bool {
        match tool {
            "TodoWrite" | "Skill" | "Agent" | "TaskOutput" => true,
            "Read" => input.get("file_path").and_then(Value::as_str).is_some_and(|p| self.inside_working_dirs(p, worktree)),
            "Glob" | "Grep" => self.inside_working_dirs(input.get("path").and_then(Value::as_str).unwrap_or(""), worktree),
            "Bash" => {
                let Some(cmd) = input.get("command").and_then(Value::as_str) else {
                    return false;
                };
                let a = claude_bash::analyze(cmd, false);
                a.parsed && !a.commands.is_empty() && a.commands.iter().all(|c| claude_bash::is_read_only(&c.text))
            }
            _ => false,
        }
    }

    /// acceptEdits: file edits inside the working directories and the
    /// common filesystem commands on in-scope relative paths.
    fn accept_edits_covers(&self, tool: &str, input: &Value, worktree: &Path) -> bool {
        match tool {
            "Edit" | "Write" | "NotebookEdit" => input
                .get("file_path")
                .and_then(Value::as_str)
                .is_some_and(|p| self.inside_working_dirs(p, worktree)),
            "Bash" => {
                let Some(cmd) = input.get("command").and_then(Value::as_str) else {
                    return false;
                };
                let a = claude_bash::analyze(cmd, false);
                a.parsed
                    && !a.dynamic
                    && a.commands.iter().all(|c| {
                        let mut words = c.text.split_whitespace();
                        let program = words.next().unwrap_or("");
                        let fs = matches!(program, "mkdir" | "touch" | "rm" | "rmdir" | "mv" | "cp" | "sed");
                        let in_scope = words.filter(|w| !w.starts_with('-')).all(|w| self.inside_working_dirs(w, worktree));
                        claude_bash::is_read_only(&c.text) || fs && in_scope
                    })
            }
            _ => false,
        }
    }

    // ===== skills =====

    /// `/name args` typed by the user: the skill or command's rendered
    /// content becomes the prompt. Ok(None) when the line is not a known
    /// user-invocable command.
    pub async fn expand_slash(&self, session_id: &str, line: &str) -> Result<Option<String>, String> {
        let Some(rest) = line.trim_start().strip_prefix('/') else {
            return Ok(None);
        };
        let (name, args) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        let Some(skill) = self.catalog.find(name).filter(|s| s.user_invocable).cloned() else {
            return Ok(None);
        };
        self.invoke_skill(&skill, args.trim(), session_id, &self.env.cwd.clone()).await.map(Some)
    }

    /// Render a skill for this turn: substitutions, injected commands,
    /// `allowed-tools` grants and frontmatter hooks.
    pub async fn invoke_skill(&self, skill: &Skill, args: &str, session_id: &str, worktree: &Path) -> Result<String, String> {
        let vars = RenderVars { session_id, project_dir: &self.env.project_dir, effort: "medium" };
        let mut text = skills::render(skill, args, &vars);
        // allowed-tools first: they pre-approve the skill's own injected commands.
        let subst = |s: &str| {
            let mut s = s
                .replace("${CLAUDE_SKILL_DIR}", &skill.dir.to_string_lossy())
                .replace("${CLAUDE_PROJECT_DIR}", &self.env.project_dir.to_string_lossy());
            if let Some((_, root, data)) = &skill.plugin {
                s = s.replace("${CLAUDE_PLUGIN_ROOT}", &root.to_string_lossy()).replace("${CLAUDE_PLUGIN_DATA}", &data.to_string_lossy());
            }
            s
        };
        let managed_only = self
            .settings
            .files
            .iter()
            .any(|f| f.layer == Layer::Managed && f.value.get("allowManagedPermissionRulesOnly") == Some(&Value::Bool(true)));
        if !managed_only {
            let source = Source { name: format!("skill {}", skill.name), anchor: self.env.project_dir.clone() };
            let mut grants = self.grants.lock().unwrap();
            for t in &skill.allowed_tools {
                grants.extend(&single(&subst(t), RuleKind::Allow, &source));
            }
        }
        let shell_disabled = self.settings.bool("disableSkillShellExecution") == Some(true)
            && skill.source != skills::SkillSource::Managed;
        for (placeholder, cmd) in skills::injected_commands(&text.clone()) {
            let replacement = if shell_disabled {
                "[shell command execution disabled by policy]".to_string()
            } else {
                let input = json!({"command": cmd});
                match self.verdict("Bash", &input, worktree) {
                    PermissionVerdict::Allow => {}
                    _ => return Err(format!("Shell command permission check failed for pattern \"{placeholder}\"")),
                }
                run_injected(&cmd, worktree).await.map_err(|out| format!("Shell command failed for pattern \"{placeholder}\": {out}"))?
            };
            text = text.replacen(&placeholder, &replacement, 1);
        }
        if let Some(h) = &skill.hooks {
            let mut done = self.registered_skill_hooks.lock().unwrap();
            if !done.contains(&skill.name) {
                done.push(skill.name.clone());
                let (set, w) = HookSet::parse(h, &Origin::Skill(skill.name.clone()), &self.env.project_dir);
                self.hooks.write().unwrap().extend(set);
                for warning in w {
                    (self.notice)(&format!("skill {}: {warning}", skill.name));
                }
            }
        }
        Ok(text)
    }

    /// The `skill` tool the model calls, when any skill is model-invocable.
    pub fn skill_tool(self: &Arc<Self>) -> Option<Arc<dyn oc_tools::Tool>> {
        self.catalog.model_invocable().then(|| Arc::new(SkillTool { rt: self.clone() }) as Arc<dyn oc_tools::Tool>)
    }

    // ===== subagents =====

    /// Subagent definitions as task-tool profiles for a registry.
    pub fn agent_profiles(&self, registry: &[String], provider: &str) -> Vec<oc_agent::task::AgentProfile> {
        self.agents
            .iter()
            .map(|def| {
                let (tools, denied) = agents::resolve_tools(def, registry);
                let mut prompt = def.prompt.clone();
                for name in &def.skills {
                    if let Some(s) = self.catalog.find(name).filter(|s| !s.disable_model_invocation) {
                        prompt.push_str(&format!("\n\n# Skill: {}\n\n{}", s.name, s.body.trim()));
                    }
                }
                let model = def.model.as_deref().filter(|m| *m != "inherit").and_then(|m| {
                    if m.contains('/') {
                        oc_schema::ModelRef::parse(m).ok()
                    } else if provider == "anthropic" {
                        oc_schema::ModelRef::parse(&format!("anthropic/{}", crate::settings::resolve_model_alias(m))).ok()
                    } else {
                        None
                    }
                });
                oc_agent::task::AgentProfile {
                    name: def.name.clone(),
                    description: def.description.clone(),
                    prompt: (!prompt.trim().is_empty()).then_some(prompt),
                    tools,
                    disallowed_tools: denied,
                    model,
                    max_steps: def.max_turns,
                    instructions: def.omit_claude_md.then(|| Arc::new(String::new())),
                }
            })
            .collect()
    }

    // ===== MCP =====

    /// MCP servers from `~/.claude.json`, `.mcp.json` and plugins, as
    /// oc-mcp stdio configs (remote transports are listed as warnings).
    pub fn mcp_servers(&self) -> (Vec<oc_mcp::McpServerConfig>, Vec<String>) {
        let plugin_servers: Vec<crate::mcp::PluginServers> = self
            .plugins
            .iter()
            .map(|p| crate::mcp::PluginServers {
                plugin: p.name.clone(),
                root: p.root.clone(),
                data_dir: p.data_dir.clone(),
                servers: p.mcp_servers.clone(),
            })
            .collect();
        let disabled = self.settings.strings("disabledMcpjsonServers");
        let lookup = |k: &str| std::env::var(k).ok();
        let entries = crate::mcp::load(&crate::mcp::LoadOptions {
            project_dir: &self.env.project_dir,
            claude_json: Some(&self.env.claude_json),
            disabled_project_servers: &disabled,
            plugins: &plugin_servers,
            env: &lookup,
        });
        let mut warnings = Vec::new();
        for e in &entries {
            for w in &e.warnings {
                warnings.push(format!("MCP server {}: {w}", e.name));
            }
            if let crate::mcp::Transport::Remote { kind, .. } = &e.transport {
                warnings.push(format!("MCP server {} uses the {kind} transport, which oc-mcp does not speak yet; skipped", e.name));
            }
        }
        (crate::mcp::to_oc_configs(&entries), warnings)
    }
}

fn single(raw: &str, kind: RuleKind, source: &Source) -> Rules {
    let mut r = Rules::default();
    if let Some(rule) = parse_rule(raw, kind, source.clone()) {
        r.push(rule);
    }
    r
}

/// Hook text that reaches the model is capped at 10,000 characters.
fn cap(text: &str) -> String {
    const CAP: usize = 10_000;
    if text.chars().count() <= CAP {
        return text.to_string();
    }
    let preview: String = text.chars().take(2_000).collect();
    format!("{preview}\n[hook output truncated: {} characters in all]", text.chars().count())
}

/// Run one injected skill command like the shell tool: stderr merged, two
/// minutes, a non-zero exit fails (exit 1 is fine for searches).
async fn run_injected(cmd: &str, cwd: &Path) -> Result<String, String> {
    let program = if std::path::Path::new("/bin/bash").exists() { "bash" } else { "sh" };
    let child = tokio::process::Command::new(program)
        .arg("-c")
        .arg(format!("{cmd} 2>&1"))
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(120), child).await {
        Ok(Ok(out)) => {
            let text = String::from_utf8_lossy(&out.stdout).trim_end().to_string();
            match out.status.code() {
                Some(0) => Ok(text),
                Some(1) if skills::search_command(cmd) => Ok(text),
                code => Err(format!("exit {code:?}: {text}")),
            }
        }
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("timed out after 120 s".into()),
    }
}

/// The model's way to load a skill (Claude Code's Skill tool).
struct SkillTool {
    rt: Arc<ClaudeRuntime>,
}

#[async_trait]
impl oc_tools::Tool for SkillTool {
    fn def(&self) -> oc_schema::ToolDef {
        oc_schema::ToolDef {
            name: "skill".into(),
            description: format!(
                "Load a skill: its full instructions come back as this tool's result, and you follow them. \
                 Use one when the user's request matches its description, or when the user names it as /name. \
                 Available skills:\n{}",
                self.rt.catalog.listing()
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "skill": {"type": "string", "description": "The skill name, as listed"},
                    "args": {"type": "string", "description": "Arguments for the skill, if any"}
                },
                "required": ["skill"]
            }),
        }
    }

    async fn execute(&self, input: &Value, ctx: &oc_tools::ToolContext) -> Result<oc_tools::ToolOutput, oc_tools::ToolError> {
        let name = input.get("skill").and_then(Value::as_str).unwrap_or("").trim_start_matches('/');
        let args = input.get("args").and_then(Value::as_str).unwrap_or("");
        let Some(skill) = self.rt.catalog.find(name).cloned() else {
            return Err(oc_tools::ToolError::Failed(format!("Unknown skill: {name}")));
        };
        if skill.disable_model_invocation {
            return Err(oc_tools::ToolError::Failed(format!(
                "The skill {} can only be run by the user, by typing /{}. Do not carry out its steps another way; suggest that the user run it.",
                skill.name, skill.name
            )));
        }
        let text = self
            .rt
            .invoke_skill(&skill, args, &ctx.session_id, &ctx.worktree)
            .await
            .map_err(oc_tools::ToolError::Failed)?;
        let mut out = oc_tools::ToolOutput::text(format!("Skill {} loaded. Follow these instructions:\n\n{text}", skill.name));
        out.metadata = Some(json!({"skill": skill.name}));
        Ok(out)
    }
}

// ===== TurnHooks =====

fn agent_of<'a>(call: &'a ToolCall<'a>) -> Option<&'a str> {
    call.subagent.then_some(call.agent)
}

#[async_trait]
impl TurnHooks for ClaudeRuntime {
    async fn pre_tool(&self, call: &ToolCall<'_>) -> PreTool {
        let tool = toolmap::claude_name(call.name);
        let cinput = toolmap::to_claude_input(call.name, call.input, call.worktree);
        let mut input = self.common_input("PreToolUse", call.session_id, call.worktree, agent_of(call));
        input.insert("tool_name".into(), json!(tool));
        input.insert("tool_input".into(), cinput.clone());
        input.insert("tool_use_id".into(), json!(call.call_id));
        if let Some(server) = tool.strip_prefix("mcp__").and_then(|r| r.split("__").next()) {
            input.insert("mcp_server".into(), json!({"name": server, "source": "project"}));
        }
        let req = Request { tool: &tool, input: &cinput };
        let pctx = self.path_context(call.worktree);
        let out = self.fire("PreToolUse", Some(&tool), agent_of(call), input, Some((&req, &pctx)), call.worktree).await;
        let mut pre = PreTool::default();
        let rank = |d: Option<HookDecision>| match d {
            Some(HookDecision::Deny) => 3,
            Some(HookDecision::Ask) => 1,
            Some(HookDecision::Allow) => 0,
            None => -1,
        };
        let mut decide = |pre: &mut PreTool, d: HookDecision, reason: Option<String>| {
            if rank(Some(d)) > rank(pre.decision) {
                pre.decision = Some(d);
                pre.reason = reason;
            }
        };
        for (h, _run, interp) in out {
            match interp {
                Interp::Block { stderr, json } => {
                    let reason = json
                        .as_ref()
                        .and_then(|m| hooks::specific(m, "permissionDecisionReason").and_then(Value::as_str).map(str::to_string))
                        .unwrap_or_else(|| format!("PreToolUse:{tool} hook error: [{}]: {stderr}", h.display()));
                    decide(&mut pre, HookDecision::Deny, Some(reason));
                }
                Interp::FailedBlock(msg) => {
                    decide(&mut pre, HookDecision::Deny, Some(format!("PreToolUse:{tool} hook error: [{}]: {msg}", h.display())));
                }
                Interp::Json(map) => {
                    if map.get("continue") == Some(&Value::Bool(false)) {
                        pre.stop = Some(map.get("stopReason").and_then(Value::as_str).unwrap_or("stopped by a PreToolUse hook").to_string());
                    }
                    let decision = hooks::specific(&map, "permissionDecision")
                        .and_then(Value::as_str)
                        .or_else(|| map.get("decision").and_then(Value::as_str));
                    let reason = hooks::specific(&map, "permissionDecisionReason")
                        .or_else(|| map.get("reason"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    match decision {
                        Some("deny") | Some("block") => decide(&mut pre, HookDecision::Deny, reason.or_else(|| Some(format!("{tool} was denied by a PreToolUse hook")))),
                        Some("ask") => decide(&mut pre, HookDecision::Ask, reason),
                        Some("allow") | Some("approve") => decide(&mut pre, HookDecision::Allow, reason),
                        _ => {} // "defer" and nothing: the normal flow
                    }
                    if decision != Some("defer") {
                        if let Some(u) = hooks::specific(&map, "updatedInput").filter(|u| u.is_object()) {
                            pre.updated_input = Some(toolmap::from_claude_input(call.name, u, call.input));
                        }
                        if let Some(c) = hooks::specific(&map, "additionalContext").and_then(Value::as_str) {
                            pre.context.push(cap(c));
                        }
                    }
                }
                _ => {}
            }
        }
        pre
    }

    fn permission(&self, call: &ToolCall<'_>) -> PermissionVerdict {
        let tool = toolmap::claude_name(call.name);
        let input = toolmap::to_claude_input(call.name, call.input, call.worktree);
        self.verdict(&tool, &input, call.worktree)
    }

    async fn post_tool(&self, call: &ToolCall<'_>, result: ToolResult<'_>, duration_ms: u64) -> PostTool {
        let mut post = PostTool::default();
        if let (Some(p), ToolResult::Ok(_)) = (toolmap::touched_path(call.name, call.input, call.worktree), result) {
            post.context.extend(self.memory.lock().unwrap().on_file_access(&p));
        }
        let tool = toolmap::claude_name(call.name);
        let cinput = toolmap::to_claude_input(call.name, call.input, call.worktree);
        let event = match result {
            ToolResult::Ok(_) => "PostToolUse",
            ToolResult::Err(_) => "PostToolUseFailure",
        };
        let mut input = self.common_input(event, call.session_id, call.worktree, agent_of(call));
        input.insert("tool_name".into(), json!(tool));
        input.insert("tool_input".into(), cinput.clone());
        input.insert("tool_use_id".into(), json!(call.call_id));
        match result {
            ToolResult::Ok(text) => {
                input.insert("tool_response".into(), toolmap::tool_response(call.name, call.input, text, call.worktree));
                input.insert("duration_ms".into(), json!(duration_ms));
            }
            ToolResult::Err(text) => {
                input.insert("error".into(), json!(text));
            }
        }
        let req = Request { tool: &tool, input: &cinput };
        let pctx = self.path_context(call.worktree);
        let out = self.fire(event, Some(&tool), agent_of(call), input, Some((&req, &pctx)), call.worktree).await;
        for (h, _run, interp) in out {
            match interp {
                Interp::Block { stderr, json } => {
                    post.context.push(format!("{event}:{tool} hook error: [{}]: {stderr}", h.display()));
                    if let Some(map) = json {
                        apply_post_json(&map, &mut post);
                    }
                }
                Interp::FailedBlock(msg) => post.context.push(format!("{event}:{tool} hook error: [{}]: {msg}", h.display())),
                Interp::Json(map) => apply_post_json(&map, &mut post),
                _ => {}
            }
        }
        post
    }

    async fn stop(&self, ctx: &StopContext<'_>) -> StopVerdict {
        let event = if ctx.subagent { "SubagentStop" } else { "Stop" };
        let agent = ctx.subagent.then_some(ctx.agent);
        let mut input = self.common_input(event, ctx.session_id, ctx.worktree, agent);
        input.insert("stop_hook_active".into(), json!(ctx.stop_hook_active));
        input.insert("last_assistant_message".into(), json!(ctx.last_text.unwrap_or("")));
        input.insert("background_tasks".into(), json!([]));
        input.insert("session_crons".into(), json!([]));
        if ctx.subagent {
            input.insert("agent_transcript_path".into(), json!(""));
        }
        let out = self.fire(event, agent, agent, input, None, ctx.worktree).await;
        let mut reasons: Vec<String> = Vec::new();
        for (_h, run, interp) in out {
            match interp {
                Interp::Json(map) if map.get("continue") == Some(&Value::Bool(false)) => return StopVerdict::Stop,
                Interp::Block { stderr, json } => {
                    if let Some(map) = &json {
                        if map.get("continue") == Some(&Value::Bool(false)) {
                            return StopVerdict::Stop;
                        }
                    }
                    // A missing hook script is a non-blocking error here.
                    if run.stdout.trim().is_empty() && stderr.contains("No such file or directory") {
                        continue;
                    }
                    let reason = json
                        .as_ref()
                        .and_then(|m| m.get("reason").and_then(Value::as_str).map(str::to_string))
                        .unwrap_or(stderr);
                    reasons.push(format!("{event} hook feedback:\n{reason}"));
                }
                Interp::Json(map) => {
                    if map.get("decision").and_then(Value::as_str) == Some("block") {
                        let reason = map.get("reason").and_then(Value::as_str).unwrap_or("A stop hook asked you to keep working.");
                        reasons.push(format!("{event} hook feedback:\n{reason}"));
                    }
                    if let Some(c) = hooks::specific(&map, "additionalContext").and_then(Value::as_str) {
                        reasons.push(format!("{event} hook feedback:\n{}", cap(c)));
                    }
                }
                _ => {}
            }
        }
        if reasons.is_empty() {
            StopVerdict::Stop
        } else {
            StopVerdict::Continue(reasons.join("\n\n"))
        }
    }

    async fn pre_compact(&self, session_id: &str, worktree: &Path, trigger: &str) -> CompactVerdict {
        let mut input = self.common_input("PreCompact", session_id, worktree, None);
        input.insert("trigger".into(), json!(trigger));
        input.insert("custom_instructions".into(), Value::Null);
        let out = self.fire("PreCompact", Some(trigger), None, input, None, worktree).await;
        let mut extra = Vec::new();
        for (_h, _run, interp) in out {
            match interp {
                Interp::Block { stderr, .. } => return CompactVerdict::Block(stderr),
                Interp::FailedBlock(msg) => return CompactVerdict::Block(msg),
                Interp::Json(map) if map.get("decision").and_then(Value::as_str) == Some("block") => {
                    return CompactVerdict::Block(map.get("reason").and_then(Value::as_str).unwrap_or("blocked").to_string())
                }
                Interp::Text(t) if !t.trim().is_empty() => extra.push(t.chars().take(10_000).collect::<String>()),
                _ => {}
            }
        }
        CompactVerdict::Proceed((!extra.is_empty()).then(|| extra.join("\n\n")))
    }

    async fn notify(&self, session_id: &str, worktree: &Path, kind: &str, message: &str) {
        let mut input = self.common_input("Notification", session_id, worktree, None);
        input.insert("message".into(), json!(message));
        input.insert("title".into(), json!(if kind == "permission_prompt" { "Permission needed" } else { "Notification" }));
        input.insert("notification_type".into(), json!(kind));
        let _ = self.fire("Notification", Some(kind), None, input, None, worktree).await;
    }

    fn tool_visible(&self, name: &str) -> bool {
        !self.rules.removes_tool(&toolmap::claude_name(name))
    }
}

fn apply_post_json(map: &Map<String, Value>, post: &mut PostTool) {
    if map.get("continue") == Some(&Value::Bool(false)) {
        post.stop = Some(map.get("stopReason").and_then(Value::as_str).unwrap_or("stopped by a PostToolUse hook").to_string());
    }
    if map.get("decision").and_then(Value::as_str) == Some("block") {
        if let Some(r) = map.get("reason").and_then(Value::as_str) {
            post.context.push(r.to_string());
        }
    }
    if let Some(c) = hooks::specific(map, "additionalContext").and_then(Value::as_str) {
        post.context.push(cap(c));
    }
    if let Some(v) = hooks::specific(map, "updatedToolOutput").or_else(|| hooks::specific(map, "updatedMCPToolOutput")) {
        post.replace_output = Some(toolmap::output_text(v));
    }
}
