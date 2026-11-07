//! oc-claude: run Claude Code projects as they are.
//!
//! Clean-room: every behaviour here comes from Claude Code's public
//! documentation (code.claude.com/docs: memory, settings, permissions, hooks,
//! skills, subagents, MCP, plugins). No Claude Code program code was read.
//! `docs/claude-code-compat.md` maps each behaviour to its doc page and test.

pub mod agents;
pub mod frontmatter;
pub mod hooks;
pub mod mcp;
pub mod memory;
pub mod paths;
pub mod plugins;
pub mod runtime;
pub mod settings;
pub mod skills;
pub mod toolmap;

pub use paths::ClaudeEnv;
pub use runtime::{ClaudeRuntime, LoadOptions, PermissionMode};

/// `OC_CLAUDE_COMPAT=off` (or `0`/`false`/`no`) turns the layer off.
pub fn enabled() -> bool {
    !matches!(
        std::env::var("OC_CLAUDE_COMPAT").map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Ok("off" | "0" | "false" | "no")
    )
}
