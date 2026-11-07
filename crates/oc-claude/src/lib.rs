//! oc-claude: run Claude Code projects as they are.
//!
//! Clean-room: every behaviour here comes from Claude Code's public
//! documentation (code.claude.com/docs: memory, settings, permissions, hooks,
//! skills, subagents, MCP, plugins). No Claude Code program code was read.
//! `docs/claude-code-compat.md` maps each behaviour to its doc page and test.

pub mod frontmatter;
pub mod mcp;
