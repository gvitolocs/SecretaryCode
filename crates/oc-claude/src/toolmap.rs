//! OpenCode tool names and inputs ↔ Claude Code's. Rules, hook matchers
//! and hook JSON use Claude Code's canonical names (`Bash`, `Read`, …) and
//! input fields (`file_path`, `old_string`, …); the model keeps calling the
//! OpenCode tools.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// OpenCode registry name → Claude Code tool name.
pub fn claude_name(oc: &str) -> String {
    match oc {
        "shell" => "Bash",
        "read" => "Read",
        "write" => "Write",
        "edit" => "Edit",
        "glob" => "Glob",
        "grep" => "Grep",
        "webfetch" => "WebFetch",
        "todowrite" => "TodoWrite",
        "task" => "Agent",
        "skill" => "Skill",
        "job" => "TaskOutput",
        other => return other.to_string(),
    }
    .to_string()
}

/// Claude Code tool name (in a subagent's `tools` list, say) → OpenCode
/// registry name. None for tools OpenCode does not have.
pub fn oc_name(claude: &str) -> Option<String> {
    Some(
        match claude {
            "Bash" => "shell",
            "Read" => "read",
            "Write" => "write",
            "Edit" | "MultiEdit" => "edit",
            "Glob" => "glob",
            "Grep" => "grep",
            "WebFetch" => "webfetch",
            "TodoWrite" => "todowrite",
            "Agent" | "Task" => "task",
            "Skill" => "skill",
            "TaskOutput" | "TaskStop" => "job",
            other if other.starts_with("mcp__") => other,
            _ => return None,
        }
        .to_string(),
    )
}

fn abs(raw: Option<&str>, worktree: &Path) -> String {
    let p = match raw {
        None | Some("") => worktree.to_path_buf(),
        Some(r) if Path::new(r).is_absolute() => PathBuf::from(r),
        Some(r) => worktree.join(r),
    };
    crate::paths::normalize(&p).to_string_lossy().into_owned()
}

fn copy(src: &Value, out: &mut Map<String, Value>, from: &str, to: &str) {
    if let Some(v) = src.get(from) {
        out.insert(to.to_string(), v.clone());
    }
}

/// An OpenCode tool input in Claude Code's shape. File paths come out
/// absolute, as the hooks reference promises for `Read`/`Write`/`Edit`.
pub fn to_claude_input(oc: &str, input: &Value, worktree: &Path) -> Value {
    let s = |k: &str| input.get(k).and_then(Value::as_str);
    let mut out = Map::new();
    match oc {
        "shell" => {
            copy(input, &mut out, "command", "command");
            copy(input, &mut out, "description", "description");
            copy(input, &mut out, "timeout", "timeout");
            out.insert("run_in_background".into(), json!(input.get("background").and_then(Value::as_bool).unwrap_or(false)));
        }
        "read" => {
            out.insert("file_path".into(), json!(abs(s("path"), worktree)));
            copy(input, &mut out, "offset", "offset");
            copy(input, &mut out, "limit", "limit");
        }
        "write" => {
            out.insert("file_path".into(), json!(abs(s("path"), worktree)));
            copy(input, &mut out, "content", "content");
        }
        "edit" => {
            out.insert("file_path".into(), json!(abs(s("path"), worktree)));
            copy(input, &mut out, "oldString", "old_string");
            copy(input, &mut out, "newString", "new_string");
            copy(input, &mut out, "replaceAll", "replace_all");
        }
        "glob" => {
            copy(input, &mut out, "pattern", "pattern");
            out.insert("path".into(), json!(abs(s("path"), worktree)));
        }
        "grep" => {
            copy(input, &mut out, "pattern", "pattern");
            out.insert("path".into(), json!(abs(s("path"), worktree)));
            copy(input, &mut out, "include", "glob");
        }
        "webfetch" => {
            copy(input, &mut out, "url", "url");
            copy(input, &mut out, "format", "format");
        }
        "task" => {
            if let Some(a) = input.get("agent").or_else(|| input.get("subagent_type")) {
                out.insert("subagent_type".into(), a.clone());
            }
            copy(input, &mut out, "description", "description");
            copy(input, &mut out, "prompt", "prompt");
            copy(input, &mut out, "model", "model");
        }
        _ => return input.clone(),
    }
    Value::Object(out)
}

/// A hook's `updatedInput` (Claude Code shape) back into the OpenCode
/// tool's input. It replaces the whole input, so a field the hook left out
/// is dropped, except OpenCode-only fields Claude Code has no name for
/// (`workdir`, `hidden`, …), which keep their value.
pub fn from_claude_input(oc: &str, updated: &Value, original: &Value) -> Value {
    let Some(u) = updated.as_object() else {
        return original.clone();
    };
    let mut out = Map::new();
    let take = |out: &mut Map<String, Value>, from: &str, to: &str| {
        if let Some(v) = u.get(from) {
            out.insert(to.to_string(), v.clone());
        }
    };
    let keep = |out: &mut Map<String, Value>, k: &str| {
        if let Some(v) = original.get(k) {
            out.insert(k.to_string(), v.clone());
        }
    };
    match oc {
        "shell" => {
            take(&mut out, "command", "command");
            take(&mut out, "description", "description");
            take(&mut out, "timeout", "timeout");
            take(&mut out, "run_in_background", "background");
            keep(&mut out, "workdir");
        }
        "read" => {
            take(&mut out, "file_path", "path");
            take(&mut out, "offset", "offset");
            take(&mut out, "limit", "limit");
        }
        "write" => {
            take(&mut out, "file_path", "path");
            take(&mut out, "content", "content");
        }
        "edit" => {
            take(&mut out, "file_path", "path");
            take(&mut out, "old_string", "oldString");
            take(&mut out, "new_string", "newString");
            take(&mut out, "replace_all", "replaceAll");
        }
        "glob" => {
            take(&mut out, "pattern", "pattern");
            take(&mut out, "path", "path");
            keep(&mut out, "hidden");
            keep(&mut out, "limit");
        }
        "grep" => {
            take(&mut out, "pattern", "pattern");
            take(&mut out, "path", "path");
            take(&mut out, "glob", "include");
            keep(&mut out, "literal");
        }
        "webfetch" => {
            take(&mut out, "url", "url");
            take(&mut out, "format", "format");
            keep(&mut out, "timeout");
        }
        "task" => {
            take(&mut out, "subagent_type", "agent");
            take(&mut out, "description", "description");
            take(&mut out, "prompt", "prompt");
            take(&mut out, "model", "model");
        }
        _ => return updated.clone(),
    }
    Value::Object(out)
}

/// The file a call reads or writes, for on-demand CLAUDE.md and rules.
pub fn touched_path(oc: &str, input: &Value, worktree: &Path) -> Option<PathBuf> {
    match oc {
        "read" | "write" | "edit" => Some(PathBuf::from(abs(input.get("path").and_then(Value::as_str), worktree))),
        "glob" | "grep" => input
            .get("path")
            .and_then(Value::as_str)
            .map(|p| PathBuf::from(abs(Some(p), worktree))),
        _ => None,
    }
}

/// The `tool_response` a PostToolUse hook sees. OpenCode tools return
/// text; Bash gets Claude Code's documented output shape.
pub fn tool_response(oc: &str, input: &Value, text: &str, worktree: &Path) -> Value {
    match oc {
        "shell" => json!({"stdout": text, "stderr": "", "interrupted": false, "isImage": false}),
        "write" | "edit" => json!({
            "filePath": abs(input.get("path").and_then(Value::as_str), worktree),
            "success": true,
            "output": text,
        }),
        _ => json!({"output": text}),
    }
}

/// A hook's `updatedToolOutput` as the text the model sees.
pub fn output_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Object(o) if o.contains_key("stdout") => {
            let out = o.get("stdout").and_then(Value::as_str).unwrap_or("");
            let err = o.get("stderr").and_then(Value::as_str).unwrap_or("");
            if err.is_empty() { out.to_string() } else { format!("{out}\n{err}") }
        }
        Value::Object(o) if o.get("output").is_some_and(Value::is_string) => o["output"].as_str().unwrap_or("").to_string(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip() {
        for oc in ["shell", "read", "write", "edit", "glob", "grep", "webfetch", "todowrite", "task", "skill"] {
            assert_eq!(oc_name(&claude_name(oc)).as_deref(), Some(oc));
        }
        assert_eq!(claude_name("mcp__s__t"), "mcp__s__t");
        assert_eq!(oc_name("NotebookEdit"), None);
    }

    #[test]
    fn inputs_round_trip() {
        let wt = Path::new("/repo");
        let edit = json!({"path": "src/a.rs", "oldString": "a", "newString": "b"});
        let c = to_claude_input("edit", &edit, wt);
        assert_eq!(c["file_path"], "/repo/src/a.rs");
        assert_eq!(c["old_string"], "a");
        let mut updated = c.clone();
        updated["new_string"] = json!("c");
        let back = from_claude_input("edit", &updated, &edit);
        assert_eq!(back, json!({"path": "/repo/src/a.rs", "oldString": "a", "newString": "c"}));
        let sh = to_claude_input("shell", &json!({"command": "ls", "workdir": "x"}), wt);
        assert_eq!(sh, json!({"command": "ls", "run_in_background": false}));
        let back = from_claude_input("shell", &json!({"command": "ls -la"}), &json!({"command": "ls", "workdir": "x"}));
        assert_eq!(back, json!({"command": "ls -la", "workdir": "x"}));
    }

    #[test]
    fn output_shapes() {
        assert_eq!(output_text(&json!({"stdout": "[redacted]", "stderr": ""})), "[redacted]");
        assert_eq!(output_text(&json!("plain")), "plain");
        assert_eq!(touched_path("read", &json!({"path": "a/b.md"}), Path::new("/r")), Some(PathBuf::from("/r/a/b.md")));
    }
}
