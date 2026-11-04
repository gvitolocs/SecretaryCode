//! oc-tools: the built-in tool registry — port of
//! `packages/core/src/tool/plugin/*.ts` (shell, read, write, edit,
//! glob, grep, todowrite, webfetch). Descriptions follow the upstream prompt
//! material, with the port's inline-truncation behaviour stated explicitly.
//!
//! Documented deltas: permission checks live in `oc-agent` before the tool
//! runs, background jobs have process-local registry lifetime, no
//! large-output-to-file spooling (output is truncated inline), webfetch
//! strips HTML with a regex (upstream converts to markdown), grep shells to
//! `rg` when present with a regex-walk fallback.

use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

mod jobs;

use async_trait::async_trait;
use oc_schema::{ToolContent, ToolDef};

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    /// The tool ran but failed; the message goes back to the model.
    #[error("{0}")]
    Failed(String),
    #[error("unknown tool: {0}")]
    Unknown(String),
}

pub struct ToolContext {
    /// Absolute working directory for file tools and the shell cwd.
    pub worktree: PathBuf,
    pub session_id: String,
    pub call_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct ToolOutput {
    pub content: Vec<ToolContent>,
    pub metadata: Option<serde_json::Value>,
}

impl ToolOutput {
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            content: vec![ToolContent::Text { text: s.into() }],
            metadata: None,
        }
    }
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn def(&self) -> ToolDef;
    async fn execute(
        &self,
        input: &serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError>;
}

#[derive(Clone)]
pub struct Registry {
    tools: Vec<Arc<dyn Tool>>,
}

impl Registry {
    /// All builtins, in registration order.
    pub fn builtin(_worktree: &Path) -> Self {
        let shell = select_shell(std::env::var("PATH").ok().as_deref());
        let jobs = Arc::new(jobs::JobManager::default());
        Self {
            tools: vec![
                Arc::new(BashTool {
                    shell,
                    jobs: jobs.clone(),
                }),
                Arc::new(jobs::JobTool { jobs }),
                Arc::new(ReadTool),
                Arc::new(WriteTool),
                Arc::new(EditTool),
                Arc::new(GlobTool),
                Arc::new(GrepTool),
                Arc::new(TodoWriteTool),
                Arc::new(WebfetchTool),
            ],
        }
    }

    /// Append extra tools after the builtins (MCP servers, the subagent
    /// task tool, plugins). First registration wins on duplicate names.
    pub fn with_tools(mut self, extra: Vec<Arc<dyn Tool>>) -> Self {
        for tool in extra {
            let name = tool.def().name.clone();
            if self.tools.iter().any(|t| t.def().name == name) {
                continue;
            }
            self.tools.push(tool);
        }
        self
    }

    pub fn defs(&self) -> Vec<ToolDef> {
        self.tools.iter().map(|t| t.def()).collect()
    }

    pub async fn execute(
        &self,
        name: &str,
        input: &serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let tool = self
            .tools
            .iter()
            .find(|t| t.def().name == name)
            .ok_or_else(|| ToolError::Unknown(name.to_string()))?;
        tool.execute(input, ctx).await
    }
}

/// Read a required string field, failing with the field name.
fn req_str(input: &serde_json::Value, field: &str) -> Result<String, ToolError> {
    input
        .get(field)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| ToolError::Failed(format!("missing required field: {field}")))
}

fn opt_str(input: &serde_json::Value, field: &str) -> Option<String> {
    input
        .get(field)
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn opt_u64(input: &serde_json::Value, field: &str) -> Option<u64> {
    input.get(field).and_then(|v| v.as_u64())
}

fn opt_bool(input: &serde_json::Value, field: &str) -> Option<bool> {
    input.get(field).and_then(|v| v.as_bool())
}

/// Resolve `path` (relative to the worktree) or the worktree itself,
/// refusing escapes above the worktree.
fn resolve(ctx: &ToolContext, path: Option<&str>) -> Result<PathBuf, ToolError> {
    let base = normalize(&ctx.worktree);
    match path {
        None | Some("") => Ok(base),
        Some(p) => {
            let cand = Path::new(p);
            let joined = if cand.is_absolute() {
                cand.to_path_buf()
            } else {
                base.join(cand)
            };
            let norm = normalize(&joined);
            if !norm.starts_with(&base) {
                return Err(ToolError::Failed(format!(
                    "path escapes the working directory: {p}"
                )));
            }
            Ok(norm)
        }
    }
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn text_output(s: String) -> Result<ToolOutput, ToolError> {
    Ok(ToolOutput::text(s))
}

// ===== shell (upstream plugin/shell.ts) =====

const SHELL_NAME: &str = "shell";
const DEFAULT_TIMEOUT_MS: u64 = 2 * 60 * 1_000;
const MAX_OUTPUT_BYTES: usize = 30_000;

#[derive(Debug, Clone)]
struct Shell {
    path: PathBuf,
    name: String,
}

fn shell_denied(name: &str) -> bool {
    matches!(name, "fish" | "nu" | "powershell" | "pwsh")
}

fn shell_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn executable(file: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    file.is_file()
        && std::fs::metadata(file)
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

fn which(name: &str, path_env: Option<&str>) -> Option<PathBuf> {
    let candidate = Path::new(name);
    if candidate.components().count() > 1 {
        return executable(candidate).then(|| candidate.to_path_buf());
    }
    let path = path_env.unwrap_or("");
    std::env::split_paths(path)
        .map(|dir| dir.join(name))
        .find(|file| executable(file))
}

fn select_shell(path_env: Option<&str>) -> Shell {
    let from_env = std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| {
            let name = shell_name(Path::new(&value));
            if shell_denied(&name) {
                None
            } else {
                which(&value, path_env).map(|path| Shell { path, name })
            }
        });
    if let Some(shell) = from_env {
        return shell;
    }
    for name in ["bash", "sh"] {
        if let Some(path) = which(name, path_env) {
            return Shell {
                path,
                name: name.to_string(),
            };
        }
    }
    Shell {
        path: PathBuf::from("/bin/sh"),
        name: "sh".into(),
    }
}

fn shell_description(shell: &Shell) -> String {
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    [
        "Execute a shell command and return its output.".to_string(),
        format!("Commands run on {os} using {}.", shell.name),
        "Quote file paths containing spaces or special characters.".into(),
        "Prefer dedicated tools over shell commands when possible.".into(),
        "Large output is truncated to its head and tail; filter the command when you need a specific part.".into(),
        "Rely on automatic truncation unless filtering the output is more useful.".into(),
        "Commands accept an optional timeout. Set background:true to return a job_id promptly, then use job status/output/list/cancel in the same session. Background jobs default to no timeout. Jobs and retained output are process-local, survive only while this registry is owned, and are killed when it is dropped. At most 128 jobs are retained per registry.".into(),
    ]
    .join(" ")
}

struct BashTool {
    shell: Shell,
    jobs: Arc<jobs::JobManager>,
}

/// Shared spawn path preserves shell cwd, stdio and process-group semantics.
fn spawn_shell(
    shell: &Shell,
    command: &str,
    workdir: &Path,
) -> Result<tokio::process::Child, ToolError> {
    let mut cmd = tokio::process::Command::new(&shell.path);
    cmd.arg("-c").arg(command).current_dir(workdir);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    cmd.process_group(0);
    cmd.spawn()
        .map_err(|e| ToolError::Failed(format!("spawn failed: {e}")))
}

/// Kills the whole process group when the tool future is dropped or times out.
struct KillGroup(Option<i32>);

impl KillGroup {
    fn disarm(&mut self) {
        self.0 = None;
    }

    fn kill_now(&mut self) {
        if let Some(pgid) = self.0.take() {
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }
}

impl Drop for KillGroup {
    fn drop(&mut self) {
        self.kill_now();
    }
}

fn truncate_middle(text: &str) -> (String, bool) {
    if text.len() <= MAX_OUTPUT_BYTES {
        return (text.to_string(), false);
    }
    let budget = MAX_OUTPUT_BYTES.saturating_sub(160);
    let mut head = budget / 2;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - budget / 2;
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    let omitted = tail - head;
    (
        format!(
            "{}\n... (output truncated: {} bytes omitted, showing the first {} and last {} bytes)\n{}",
            &text[..head],
            omitted,
            head,
            text.len() - tail,
            &text[tail..]
        ),
        true,
    )
}

#[async_trait]
impl Tool for BashTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: SHELL_NAME.into(),
            description: shell_description(&self.shell),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command string to execute"},
                    "background": {"type": "boolean", "description": "Launch a session-scoped, process-local managed job and return its job_id immediately (default false). Use the job tool to collect or cancel it."},
                    "workdir": {"type": "string", "description": "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."},
                    "timeout": {"type": "number", "description": format!("Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to {DEFAULT_TIMEOUT_MS} for foreground commands.")}
                },
                "required": ["command"]
            }),
        }
    }

    async fn execute(
        &self,
        input: &serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let command = req_str(input, "command")?;
        let background = opt_bool(input, "background").unwrap_or(false);
        let timeout =
            opt_u64(input, "timeout").unwrap_or(if background { 0 } else { DEFAULT_TIMEOUT_MS });
        let workdir = match opt_str(input, "workdir") {
            Some(dir) => resolve(ctx, Some(&dir))?,
            None => ctx.worktree.clone(),
        };
        if !workdir.is_dir() {
            return Err(ToolError::Failed(format!(
                "working directory does not exist: {}",
                workdir.display()
            )));
        }
        if background {
            return self
                .jobs
                .launch(&self.shell, &command, &workdir, timeout, &ctx.session_id);
        }
        let child = spawn_shell(&self.shell, &command, &workdir)?;
        let mut kill = KillGroup(child.id().map(|pid| pid as i32));
        let wait = async {
            let out = child
                .wait_with_output()
                .await
                .map_err(|e| ToolError::Failed(e.to_string()))?;
            Ok::<_, ToolError>(out)
        };
        let out = if timeout == 0 {
            let out = wait.await?;
            kill.disarm();
            out
        } else {
            match tokio::time::timeout(Duration::from_millis(timeout), wait).await {
                Ok(r) => {
                    let out = r?;
                    kill.disarm();
                    out
                }
                Err(_) => {
                    kill.kill_now();
                    return Err(ToolError::Failed(format!(
                        "command timed out after {timeout}ms"
                    )));
                }
            }
        };
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !stderr.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&stderr);
        }
        let (mut text, truncated) = truncate_middle(&text);
        let exit = out.status.code().unwrap_or(-1);
        let signal = out.status.signal().map(|s| format!("{s}"));
        let meta = serde_json::json!({ "exit": exit, "truncated": truncated, "signal": signal });
        if exit != 0 {
            text.push_str(&format!("\n(exit code {exit})"));
        }
        let mut output = ToolOutput::text(text);
        output.metadata = Some(meta);
        Ok(output)
    }
}

// ===== read (upstream plugin/read.ts + tool/read-filesystem.ts) =====

const READ_NAME: &str = "read";
const MAX_READ_LINES: usize = 2_000;
const MAX_READ_BYTES: usize = 50 * 1024;
const MAX_LINE_LENGTH: usize = 2_000;
const READ_DESCRIPTION: &str = "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.";

struct ReadTool;

fn clamp_line(line: &str) -> String {
    if line.len() > MAX_LINE_LENGTH {
        let mut cut = MAX_LINE_LENGTH;
        while !line.is_char_boundary(cut) {
            cut -= 1;
        }
        format!(
            "{}... (line truncated to {MAX_LINE_LENGTH} chars)",
            &line[..cut]
        )
    } else {
        line.to_string()
    }
}

#[async_trait]
impl Tool for ReadTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: READ_NAME.into(),
            description: READ_DESCRIPTION.into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File or directory to read"},
                    "offset": {"type": "number", "description": "The line or directory entry to start reading from (1-based)"},
                    "limit": {"type": "number", "description": "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"}
                },
                "required": ["path"]
            }),
        }
    }

    async fn execute(
        &self,
        input: &serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let path = resolve(ctx, opt_str(input, "path").as_deref())?;
        let meta = std::fs::metadata(&path)
            .map_err(|_| ToolError::Failed(format!("file not found: {}", path.display())))?;
        let offset = opt_u64(input, "offset").unwrap_or(1).max(1) as usize;
        let limit =
            (opt_u64(input, "limit").unwrap_or(MAX_READ_LINES as u64) as usize).min(MAX_READ_LINES);
        if meta.is_dir() {
            let mut entries: Vec<String> = std::fs::read_dir(&path)
                .map_err(|e| ToolError::Failed(e.to_string()))?
                .flatten()
                .map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if e.path().is_dir() {
                        format!("{name}/")
                    } else {
                        name
                    }
                })
                .collect();
            entries.sort();
            let start = (offset - 1).min(entries.len());
            let page: Vec<String> = entries.into_iter().skip(start).take(limit).collect();
            return text_output(page.join("\n"));
        }
        let bytes = std::fs::read(&path).map_err(|e| ToolError::Failed(e.to_string()))?;
        let content = String::from_utf8_lossy(&bytes);
        let mut lines: Vec<&str> = content
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .collect();
        // a trailing newline ends the last line instead of starting an empty one
        if content.ends_with('\n') && matches!(lines.last(), Some(l) if l.is_empty()) {
            lines.pop();
        }
        let mut out: Vec<String> = Vec::new();
        let mut size = 0usize;
        let mut next: Option<usize> = None;
        for (i, line) in lines.iter().enumerate().skip(offset - 1) {
            if out.len() >= limit || size >= MAX_READ_BYTES {
                next = Some(i + 1);
                break;
            }
            let text = clamp_line(line);
            size += text.len() + if out.is_empty() { 0 } else { 1 };
            if size > MAX_READ_BYTES {
                next = Some(i + 1);
                break;
            }
            out.push(format!("{}: {}", i + 1, text));
        }
        if out.is_empty() && offset != 1 {
            return Err(ToolError::Failed(format!(
                "offset {offset} is out of range: the file has {} lines",
                lines.len()
            )));
        }
        if let Some(n) = next {
            out.push(format!("... (truncated; read more from offset {n})"));
        }
        text_output(out.join("\n"))
    }
}

// ===== write (upstream plugin/write.ts) =====

const WRITE_NAME: &str = "write";

struct WriteTool;

#[async_trait]
impl Tool for WriteTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: WRITE_NAME.into(),
            description: "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file to write to"},
                    "content": {"type": "string", "description": "Content to write to the file"}
                },
                "required": ["path", "content"]
            }),
        }
    }

    async fn execute(
        &self,
        input: &serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let path = resolve(ctx, opt_str(input, "path").as_deref())?;
        let content = req_str(input, "content")?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| ToolError::Failed(e.to_string()))?;
        }
        std::fs::write(&path, &content).map_err(|e| ToolError::Failed(e.to_string()))?;
        let mut out = ToolOutput::text(format!("wrote {}", path.display()));
        out.metadata = Some(serde_json::json!({ "path": path.display().to_string() }));
        Ok(out)
    }
}

// ===== edit (upstream plugin/edit.ts) =====

const EDIT_NAME: &str = "edit";
const EDIT_DESCRIPTION: &str = "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.";

struct EditTool;

#[async_trait]
impl Tool for EditTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: EDIT_NAME.into(),
            description: EDIT_DESCRIPTION.into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File to edit"},
                    "oldString": {"type": "string", "description": "Exact text to find and replace"},
                    "newString": {"type": "string", "description": "Text to replace oldString with (must differ from oldString)"},
                    "replaceAll": {"type": "boolean", "description": "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."}
                },
                "required": ["path", "oldString", "newString"]
            }),
        }
    }

    async fn execute(
        &self,
        input: &serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let path = resolve(ctx, opt_str(input, "path").as_deref())?;
        let old_string = req_str(input, "oldString")?;
        let new_string = req_str(input, "newString")?;
        let replace_all = opt_bool(input, "replaceAll").unwrap_or(false);
        if old_string == new_string {
            return Err(ToolError::Failed(
                "newString must differ from oldString".into(),
            ));
        }
        let bytes = std::fs::read(&path)
            .map_err(|_| ToolError::Failed(format!("file not found: {}", path.display())))?;
        let original = String::from_utf8_lossy(&bytes).into_owned();
        let count = original.matches(&old_string).count();
        if count == 0 {
            return Err(ToolError::Failed(format!(
                "oldString not found in {}",
                path.display()
            )));
        }
        if count > 1 && !replace_all {
            return Err(ToolError::Failed(format!(
                "oldString matched {count} times in {}; add surrounding context to make it unique, or set replaceAll to true",
                path.display()
            )));
        }
        // preserve the file's trailing-newline state
        let mut replacement = new_string.clone();
        let had_trailing = original.ends_with('\n');
        if !had_trailing && replacement.ends_with('\n') {
            replacement.pop();
        }
        let edited = if replace_all {
            original.replace(&old_string, &replacement)
        } else {
            original.replacen(&old_string, &replacement, 1)
        };
        std::fs::write(&path, &edited).map_err(|e| ToolError::Failed(e.to_string()))?;
        let replacements = if replace_all { count } else { 1 };
        let mut out = ToolOutput::text(format!(
            "edited {} ({} replacement{})",
            path.display(),
            replacements,
            if replacements == 1 { "" } else { "s" }
        ));
        out.metadata = Some(serde_json::json!({ "replacements": replacements }));
        Ok(out)
    }
}

fn is_hidden(e: &walkdir::DirEntry) -> bool {
    e.file_name().to_string_lossy().starts_with('.')
}

// ===== glob (upstream plugin/glob.ts) =====

const GLOB_NAME: &str = "glob";
const DEFAULT_SEARCH_LIMIT: usize = 100;

struct GlobTool;

/// Convert a glob with `**` to a regex: `**/` matches zero or more
/// directories, `*`/`?` stay within a segment, everything else is literal.
fn glob_to_regex(pattern: &str) -> String {
    let mut re = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' if i + 1 < chars.len() && chars[i + 1] == '*' => {
                if i + 2 < chars.len() && chars[i + 2] == '/' {
                    re.push_str("(?:.*/)?");
                    i += 3;
                    continue;
                }
                re.push_str(".*");
                i += 2;
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\' => {
                re.push('\\');
                re.push(chars[i]);
            }
            c => re.push(c),
        }
        i += 1;
    }
    re.push('$');
    re
}

#[async_trait]
impl Tool for GlobTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: GLOB_NAME.into(),
            description:
                "Search file paths using a glob pattern (examples: \"**/*.ts\", \"src/**/*.tsx\")."
                    .into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern to match files against"},
                    "path": {"type": "string", "description": "Directory to search. Defaults to the current working directory."},
                    "hidden": {"type": "boolean", "description": "Include hidden files and directories (default: false)."},
                    "limit": {"type": "number", "description": "Maximum number of matching files to return (default: 100)"}
                },
                "required": ["pattern"]
            }),
        }
    }

    async fn execute(
        &self,
        input: &serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let pattern = req_str(input, "pattern")?;
        let base = resolve(ctx, opt_str(input, "path").as_deref())?;
        let hidden = opt_bool(input, "hidden").unwrap_or(false);
        let limit = opt_u64(input, "limit").unwrap_or(DEFAULT_SEARCH_LIMIT as u64) as usize;
        let re = regex::Regex::new(&glob_to_regex(&pattern))
            .map_err(|e| ToolError::Failed(format!("bad pattern: {e}")))?;
        let mut matches: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
        for entry in walkdir::WalkDir::new(&base)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || hidden || !is_hidden(e))
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&base)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .into_owned();
            if re.is_match(&rel) {
                let mtime = std::fs::metadata(entry.path())
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                matches.push((mtime, entry.path().to_path_buf()));
                if matches.len() > limit * 4 {
                    break; // walk cap; sorted then trimmed below
                }
            }
        }
        matches.sort_by(|a, b| b.0.cmp(&a.0)); // newest first, like upstream's mtime sort
        matches.truncate(limit);
        let lines: Vec<String> = matches
            .iter()
            .map(|(_, p)| {
                p.strip_prefix(&base)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        if lines.is_empty() {
            return text_output(format!("no files match {pattern}"));
        }
        text_output(lines.join("\n"))
    }
}

// ===== grep (upstream plugin/grep.ts; rg with a regex-walk fallback) =====

const GREP_NAME: &str = "grep";
const GREP_DESCRIPTION: &str = "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.";

struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: GREP_NAME.into(),
            description: GREP_DESCRIPTION.into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regular expression or literal text to match in file contents."},
                    "path": {"type": "string", "description": "File or directory to search. Defaults to the current working directory."},
                    "include": {"type": "string", "description": "Glob pattern to filter files (for example, \"*.js\" or \"*.{ts,tsx}\")"},
                    "literal": {"type": "boolean", "description": "Treat `pattern` as exact text instead of a regular expression (default: false)."},
                    "caseSensitive": {"type": "boolean", "description": "Use case-sensitive matching (default: true)."}
                },
                "required": ["pattern"]
            }),
        }
    }

    async fn execute(
        &self,
        input: &serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let pattern = req_str(input, "pattern")?;
        let base = resolve(ctx, opt_str(input, "path").as_deref())?;
        let literal = opt_bool(input, "literal").unwrap_or(false);
        let case_sensitive = opt_bool(input, "caseSensitive").unwrap_or(true);
        let include = opt_str(input, "include");

        let mut cmd = tokio::process::Command::new("rg");
        cmd.arg("--no-heading")
            .arg("-n")
            .arg("--max-count")
            .arg("200");
        if literal {
            cmd.arg("--fixed-strings");
        }
        if !case_sensitive {
            cmd.arg("--ignore-case");
        }
        if let Some(glob) = &include {
            cmd.arg("--glob").arg(glob);
        }
        cmd.arg("--").arg(&pattern).arg(&base);
        cmd.current_dir(&ctx.worktree);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let Ok(child) = cmd.spawn() else {
            return self
                .fallback(&pattern, &base, &include, literal, case_sensitive)
                .await;
        };
        let out = child
            .wait_with_output()
            .await
            .map_err(|e| ToolError::Failed(e.to_string()))?;
        match out.status.code() {
            Some(0) | Some(1) => {} // 0 = matches, 1 = no matches
            _ => {
                // rg missing or unusable → walk fallback
                return self
                    .fallback(&pattern, &base, &include, literal, case_sensitive)
                    .await;
            }
        }
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        if text.trim().is_empty() {
            return text_output("no matches".into());
        }
        let base_str = base.to_string_lossy();
        let rel = text
            .lines()
            .map(|l| {
                l.strip_prefix(base_str.as_ref())
                    .and_then(|r| r.strip_prefix('/'))
                    .map(str::to_string)
                    .unwrap_or_else(|| l.to_string())
            })
            .collect::<Vec<_>>()
            .join("\n");
        text_output(rel)
    }
}

impl GrepTool {
    /// Regex-walk fallback with the same `path:line: text` output.
    async fn fallback(
        &self,
        pattern: &str,
        base: &Path,
        include: &Option<String>,
        literal: bool,
        case_sensitive: bool,
    ) -> Result<ToolOutput, ToolError> {
        let pattern = if literal {
            regex::escape(pattern)
        } else {
            pattern.to_string()
        };
        let mut builder = regex::RegexBuilder::new(&pattern);
        builder.case_insensitive(!case_sensitive);
        let re = builder
            .build()
            .map_err(|e| ToolError::Failed(format!("bad pattern: {e}")))?;
        let include_re = include.as_deref().and_then(|g| {
            let name_only = g.split('/').next_back().unwrap_or(g);
            regex::Regex::new(&glob_to_regex(name_only)).ok()
        });
        let mut out: Vec<String> = Vec::new();
        for entry in walkdir::WalkDir::new(base)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            if let Some(filter) = &include_re {
                let name = entry.file_name().to_string_lossy();
                if !filter.is_match(&name) {
                    continue;
                }
            }
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            let text = String::from_utf8_lossy(&bytes);
            for (i, line) in text.lines().enumerate().take(5000) {
                if re.is_match(line) {
                    out.push(format!(
                        "{}:{}:{}",
                        entry.path().display(),
                        i + 1,
                        clamp_line(line)
                    ));
                    if out.len() >= 500 {
                        return text_output(out.join("\n"));
                    }
                }
            }
        }
        if out.is_empty() {
            return text_output("no matches".into());
        }
        text_output(out.join("\n"))
    }
}

// ===== todowrite (upstream plugin/todo.ts + tool/todowrite.txt) =====

const TODOWRITE_NAME: &str = "todowrite";
const TODOWRITE_DESCRIPTION: &str = "Create and update a todo list for the current session. The user sees it as your working plan.\n\nUse it proactively when a task has 3 or more distinct steps, or when the user gives several tasks or asks for a todo list. Skip it for a single simple task or a purely conversational request. When in doubt, use it.\n\n- Send the full list on every call; it replaces the previous one.\n- Mark items `in_progress` when you start them and `completed` as soon as they're actually done.\n- Only call it when the list changes.";

struct TodoWriteTool;

#[async_trait]
impl Tool for TodoWriteTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: TODOWRITE_NAME.into(),
            description: TODOWRITE_DESCRIPTION.into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "description": "The updated todo list",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": {"type": "string", "description": "Brief description of the task"},
                                "status": {"type": "string", "description": "Current status of the task: pending, in_progress, completed, cancelled", "enum": ["pending", "in_progress", "completed", "cancelled"]}
                            },
                            "required": ["content", "status"]
                        }
                    }
                },
                "required": ["todos"]
            }),
        }
    }

    async fn execute(
        &self,
        input: &serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let todos = input
            .get("todos")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ToolError::Failed("missing required field: todos".into()))?;
        let mut lines: Vec<String> = Vec::new();
        for todo in todos {
            let content = todo
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ToolError::Failed("todo is missing content".into()))?;
            let status = todo
                .get("status")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ToolError::Failed("todo is missing status".into()))?;
            if !matches!(
                status,
                "pending" | "in_progress" | "completed" | "cancelled"
            ) {
                return Err(ToolError::Failed(format!(
                    "invalid status {status:?}: expected pending, in_progress, completed or cancelled"
                )));
            }
            let mark = match status {
                "completed" => "[x]",
                "in_progress" => "[~]",
                "cancelled" => "[-]",
                _ => "[ ]",
            };
            lines.push(format!("{mark} {content}"));
        }
        let mut out = ToolOutput::text(lines.join("\n"));
        out.metadata = Some(serde_json::json!({ "todos": todos }));
        Ok(out)
    }
}

// ===== webfetch (upstream plugin/webfetch.ts) =====

const WEBFETCH_NAME: &str = "webfetch";
const WEBFETCH_DESCRIPTION: &str = "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.";
const MAX_TIMEOUT_SECONDS: u64 = 120;
const MAX_FETCH_BYTES: usize = 2 * 1024 * 1024;

struct WebfetchTool;

#[async_trait]
impl Tool for WebfetchTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: WEBFETCH_NAME.into(),
            description: WEBFETCH_DESCRIPTION.into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The HTTP or HTTPS URL to fetch content from"},
                    "format": {"type": "string", "description": "The format to return the content in. Defaults to markdown.", "enum": ["text", "markdown", "html"]},
                    "timeout": {"type": "number", "description": "Optional timeout in seconds (maximum: 120)"}
                },
                "required": ["url"]
            }),
        }
    }

    async fn execute(
        &self,
        input: &serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let url = req_str(input, "url")?;
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(ToolError::Failed(format!("unsupported URL scheme: {url}")));
        }
        let timeout = opt_u64(input, "timeout")
            .unwrap_or(30)
            .clamp(1, MAX_TIMEOUT_SECONDS);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(timeout))
            .build()
            .map_err(|e| ToolError::Failed(e.to_string()))?;
        let res = client
            .get(&url)
            .send()
            .await
            .map_err(|e| ToolError::Failed(format!("fetch failed: {e}")))?;
        let status = res.status().as_u16();
        let content_type = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = res
            .bytes()
            .await
            .map_err(|e| ToolError::Failed(e.to_string()))?;
        if !(200..300).contains(&status) {
            return Err(ToolError::Failed(format!("http {status} for {url}")));
        }
        let mut text = String::from_utf8_lossy(&body).into_owned();
        if content_type.contains("text/html") {
            text = strip_html(&text);
        }
        if text.len() > MAX_FETCH_BYTES {
            let mut cut = MAX_FETCH_BYTES;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push_str("\n... (truncated)");
        }
        let mut out = ToolOutput::text(text);
        out.metadata = Some(serde_json::json!({ "url": url, "contentType": content_type }));
        Ok(out)
    }
}

/// Crude HTML→text: drop script/style blocks, tags, collapse whitespace.
/// (Upstream converts to markdown; documented delta.)
fn strip_html(html: &str) -> String {
    let no_scripts = regex::Regex::new(r"(?is)<(script|style)[^>]*>.*?</\1>").unwrap();
    let tags = regex::Regex::new(r"(?s)<[^>]*>").unwrap();
    let spaces = regex::Regex::new(r"\n{3,}").unwrap();
    let s = no_scripts.replace_all(html, "");
    let s = tags.replace_all(&s, " ");
    let s = html_entities(&s);
    spaces.replace_all(&s, "\n\n").trim().to_string()
}

fn html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}
