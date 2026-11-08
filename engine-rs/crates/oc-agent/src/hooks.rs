//! Turn hooks: the seam an embedding (oc-claude, for Claude Code projects)
//! uses to watch and steer a turn. The runner itself stays ignorant of where
//! hooks come from; it only asks at fixed points:
//!
//! - before each tool call ([`TurnHooks::pre_tool`]), which can rewrite the
//!   input, force allow/ask/deny, add context, or stop the turn;
//! - for a permission verdict layered over the OpenCode ruleset
//!   ([`TurnHooks::permission`]);
//! - after each tool call ([`TurnHooks::post_tool`]);
//! - when the model is about to stop ([`TurnHooks::stop`]), which can send it
//!   back to work;
//! - before compaction ([`TurnHooks::pre_compact`]);
//! - when a permission prompt is shown ([`TurnHooks::notify`]).
//!
//! Every method has a do-nothing default, so `None` hooks and a default impl
//! behave exactly like the runner without hooks.

use std::path::Path;

use async_trait::async_trait;

/// One tool call as the runner sees it, in OpenCode's tool names and inputs.
#[derive(Debug, Clone, Copy)]
pub struct ToolCall<'a> {
    pub session_id: &'a str,
    pub call_id: &'a str,
    pub name: &'a str,
    pub input: &'a serde_json::Value,
    pub worktree: &'a Path,
    /// The agent name running the turn (`build`, or a subagent's type).
    pub agent: &'a str,
    /// True inside a subagent started by the `task` tool.
    pub subagent: bool,
}

/// A hook's explicit permission answer for one tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookDecision {
    Allow,
    Ask,
    Deny,
}

/// What the pre-tool hooks returned.
#[derive(Debug, Clone, Default)]
pub struct PreTool {
    pub decision: Option<HookDecision>,
    /// Shown to the model on deny, to the user on ask.
    pub reason: Option<String>,
    /// Replaces the whole tool input before permissions and execution.
    pub updated_input: Option<serde_json::Value>,
    /// Text added next to the tool result for the model.
    pub context: Vec<String>,
    /// `continue: false`: end the turn after this call, with this reason.
    pub stop: Option<String>,
}

/// A rules verdict layered over the OpenCode ruleset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionVerdict {
    Allow,
    Ask,
    Deny(String),
    /// No opinion: the OpenCode ruleset decides.
    Pass,
}

/// What the post-tool hooks returned.
#[derive(Debug, Clone, Default)]
pub struct PostTool {
    pub context: Vec<String>,
    /// Replaces the text the model sees as the tool's result.
    pub replace_output: Option<String>,
    pub stop: Option<String>,
}

/// The result a post-tool hook sees.
#[derive(Debug, Clone, Copy)]
pub enum ToolResult<'a> {
    Ok(&'a str),
    Err(&'a str),
}

/// The context of a stop decision.
#[derive(Debug, Clone, Copy)]
pub struct StopContext<'a> {
    pub session_id: &'a str,
    pub worktree: &'a Path,
    pub agent: &'a str,
    pub subagent: bool,
    pub last_text: Option<&'a str>,
    /// True when the turn is already continuing because of a stop hook.
    pub stop_hook_active: bool,
}

/// Whether the model may stop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopVerdict {
    Stop,
    /// Keep working; the text goes to the model as the next instruction.
    Continue(String),
}

/// Before compaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactVerdict {
    /// Compact, with optional extra instructions for the summary.
    Proceed(Option<String>),
    Block(String),
}

#[async_trait]
pub trait TurnHooks: Send + Sync {
    async fn pre_tool(&self, _call: &ToolCall<'_>) -> PreTool {
        PreTool::default()
    }

    fn permission(&self, _call: &ToolCall<'_>) -> PermissionVerdict {
        PermissionVerdict::Pass
    }

    async fn post_tool(
        &self,
        _call: &ToolCall<'_>,
        _result: ToolResult<'_>,
        _duration_ms: u64,
    ) -> PostTool {
        PostTool::default()
    }

    async fn stop(&self, _ctx: &StopContext<'_>) -> StopVerdict {
        StopVerdict::Stop
    }

    async fn pre_compact(&self, _session_id: &str, _worktree: &Path, _trigger: &str) -> CompactVerdict {
        CompactVerdict::Proceed(None)
    }

    /// A permission prompt is about to be shown (Claude Code's
    /// `Notification` with `permission_prompt`).
    async fn notify(&self, _session_id: &str, _worktree: &Path, _kind: &str, _message: &str) {}

    /// Whether a tool stays in the model's tool list (a bare deny rule
    /// removes it).
    fn tool_visible(&self, _name: &str) -> bool {
        true
    }
}

/// Wrap text for the model as a harness note, the way the system prompt
/// tells the model to read `<system-reminder>` blocks.
pub fn system_reminder(text: &str) -> String {
    let safe = text
        .replace("<system-reminder>", "&lt;system-reminder>")
        .replace("</system-reminder>", "&lt;/system-reminder>");
    format!("<system-reminder>\n{safe}\n</system-reminder>")
}
