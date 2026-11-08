//! Where Claude Code's files live (settings, memory and MCP pages of the docs).

use std::path::{Path, PathBuf};

/// The directories one session reads Claude Code configuration from.
#[derive(Debug, Clone)]
pub struct ClaudeEnv {
    /// The current working directory of the session.
    pub cwd: PathBuf,
    /// The project root where the session started (`CLAUDE_PROJECT_DIR`).
    pub project_dir: PathBuf,
    pub home: PathBuf,
    /// `~/.claude`, or `CLAUDE_CONFIG_DIR`.
    pub config_dir: PathBuf,
    /// `~/.claude.json` (user and local MCP servers).
    pub claude_json: PathBuf,
    /// The managed-policy directory for this OS, when there is one.
    pub managed_dir: Option<PathBuf>,
}

impl ClaudeEnv {
    /// From the process environment, for a session in `cwd`.
    pub fn from_env(cwd: &Path) -> Self {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        let config_override = std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let config_dir = config_override.clone().unwrap_or_else(|| home.join(".claude"));
        let claude_json = match config_override {
            Some(dir) => dir.join(".claude.json"),
            None => home.join(".claude.json"),
        };
        let managed_dir = if let Some(dir) = std::env::var_os("OC_CLAUDE_MANAGED_DIR") {
            Some(PathBuf::from(dir)).filter(|d| !d.as_os_str().is_empty())
        } else if cfg!(target_os = "macos") {
            Some(PathBuf::from("/Library/Application Support/ClaudeCode"))
        } else if cfg!(target_os = "linux") {
            Some(PathBuf::from("/etc/claude-code"))
        } else {
            None
        };
        Self::new(cwd, &home, &config_dir, &claude_json, managed_dir)
    }

    /// Explicit directories (tests, embedders).
    pub fn new(
        cwd: &Path,
        home: &Path,
        config_dir: &Path,
        claude_json: &Path,
        managed_dir: Option<PathBuf>,
    ) -> Self {
        let cwd = normalize(cwd);
        Self {
            project_dir: cwd.clone(),
            cwd,
            home: home.to_path_buf(),
            config_dir: config_dir.to_path_buf(),
            claude_json: claude_json.to_path_buf(),
            managed_dir,
        }
    }

    /// The directories from the filesystem root down to the cwd.
    pub fn ancestors_root_first(&self) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = self.cwd.ancestors().map(Path::to_path_buf).collect();
        dirs.reverse();
        dirs
    }

    /// The cwd and its parents up to the repository root (the first
    /// directory holding `.git`), or up to the filesystem root outside a repo.
    pub fn up_to_repo_root(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for dir in self.cwd.ancestors() {
            out.push(dir.to_path_buf());
            if dir.join(".git").exists() {
                break;
            }
        }
        out
    }

    pub fn permission_context(&self) -> oc_permission::claude::PathContext {
        oc_permission::claude::PathContext {
            cwd: self.cwd.clone(),
            home: self.home.clone(),
        }
    }
}

/// Lexical normalization: `.` dropped, `..` pops.
pub fn normalize(p: &Path) -> PathBuf {
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

/// Expand `~` and make `raw` absolute against `base`.
pub fn resolve(raw: &str, base: &Path, home: &Path) -> PathBuf {
    let p = if raw == "~" {
        home.to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest)
    } else if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        base.join(raw)
    };
    normalize(&p)
}
