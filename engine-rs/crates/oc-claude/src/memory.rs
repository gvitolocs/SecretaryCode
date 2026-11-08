//! CLAUDE.md memory (code.claude.com/docs/en/memory).
//!
//! At launch, in this order: the managed `CLAUDE.md`, `~/.claude/CLAUDE.md`,
//! `~/.claude/rules/`, then for every directory from the filesystem root down
//! to the cwd: `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**/*.md`
//! and last `CLAUDE.local.md`. `AGENTS.md` loads instead when no CLAUDE.md
//! of the project kind exists in the cwd or above. `@path` imports expand up
//! to four hops. Subdirectory files and path-scoped rules load when a tool
//! touches a file there.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};

use crate::frontmatter;
use crate::paths::{normalize, resolve, ClaudeEnv};

/// Import depth limit: "a maximum depth of four hops".
pub const MAX_IMPORT_HOPS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Managed,
    User,
    UserRule,
    Project,
    ProjectRule,
    Local,
    Agents,
}

impl Scope {
    fn label(self) -> &'static str {
        match self {
            Scope::Managed => "managed policy instructions",
            Scope::User => "user instructions for all projects",
            Scope::UserRule => "user rule",
            Scope::Project => "project instructions",
            Scope::ProjectRule => "project rule",
            Scope::Local => "local project instructions, not checked in",
            Scope::Agents => "project instructions (AGENTS.md)",
        }
    }

    /// User-scope files are the user's own: their imports load without approval.
    fn trusted_imports(self) -> bool {
        matches!(self, Scope::Managed | Scope::User | Scope::UserRule)
    }
}

/// Which instruction files load (the "Project instructions" setting).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InstructionFiles {
    #[default]
    ClaudeMdOrAgentsMd,
    ClaudeMdAndAgentsMd,
    ClaudeMd,
    ManagedOnly,
}

impl InstructionFiles {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "claude-md-or-agents-md" => Self::ClaudeMdOrAgentsMd,
            "claude-md-and-agents-md" => Self::ClaudeMdAndAgentsMd,
            "claude-md" => Self::ClaudeMd,
            "managed-only" => Self::ManagedOnly,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct MemoryOptions {
    /// `claudeMdExcludes`: globs against absolute paths (never the managed file).
    pub excludes: Vec<String>,
    /// Load `@imports` of project files that resolve outside the cwd. Claude
    /// Code asks once per project; a headless run has no one to ask.
    pub external_imports: bool,
    pub instruction_files: InstructionFiles,
}

#[derive(Debug, Clone)]
pub struct MemoryFile {
    pub path: PathBuf,
    pub scope: Scope,
    /// The content with frontmatter and block comments removed and imports expanded.
    pub content: String,
}

#[derive(Debug, Clone)]
struct PathRule {
    path: PathBuf,
    scope: Scope,
    content: String,
    matcher: GlobSet,
}

#[derive(Debug, Clone)]
pub struct Memory {
    pub files: Vec<MemoryFile>,
    /// External imports that were not loaded (no approval).
    pub skipped_imports: Vec<PathBuf>,
    loaded: HashSet<PathBuf>,
    pending_rules: Vec<PathRule>,
    excludes: GlobSet,
    cwd: PathBuf,
    home: PathBuf,
    opts: MemoryOptions,
    agents_mode: bool,
}

impl Memory {
    pub fn load(env: &ClaudeEnv, opts: MemoryOptions) -> Self {
        let excludes = build_set(&opts.excludes, false);
        let mut m = Memory {
            files: Vec::new(),
            skipped_imports: Vec::new(),
            loaded: HashSet::new(),
            pending_rules: Vec::new(),
            excludes,
            cwd: env.cwd.clone(),
            home: env.home.clone(),
            opts: opts.clone(),
            agents_mode: false,
        };
        if let Some(dir) = &env.managed_dir {
            m.add_file(&dir.join("CLAUDE.md"), Scope::Managed);
        }
        if opts.instruction_files == InstructionFiles::ManagedOnly {
            return m;
        }
        let user_md = env.config_dir.join("CLAUDE.md");
        m.add_file(&user_md, Scope::User);
        m.add_rules_dir(&env.config_dir.join("rules"), Scope::UserRule, &env.cwd);

        let ancestors = env.ancestors_root_first();
        // CLAUDE.md files of the project kind in the cwd or above decide
        // whether AGENTS.md loads; the user's own file does not count.
        let has_claude_md = ancestors.iter().any(|d| {
            [d.join("CLAUDE.md"), d.join(".claude/CLAUDE.md"), d.join("CLAUDE.local.md")]
                .iter()
                .any(|p| p.is_file() && normalize(p) != normalize(&user_md))
        });
        let (claude, agents) = match opts.instruction_files {
            InstructionFiles::ClaudeMdOrAgentsMd => (true, !has_claude_md),
            InstructionFiles::ClaudeMdAndAgentsMd => (true, true),
            InstructionFiles::ClaudeMd => (true, false),
            InstructionFiles::ManagedOnly => (false, false),
        };
        m.agents_mode = agents;
        for dir in &ancestors {
            if claude {
                m.add_file(&dir.join("CLAUDE.md"), Scope::Project);
                m.add_file(&dir.join(".claude/CLAUDE.md"), Scope::Project);
                if normalize(&dir.join(".claude")) != normalize(&env.config_dir) {
                    m.add_rules_dir(&dir.join(".claude/rules"), Scope::ProjectRule, dir);
                }
            }
            if agents {
                m.add_file(&dir.join("AGENTS.md"), Scope::Agents);
                m.add_file(&dir.join(".claude/AGENTS.md"), Scope::Agents);
            }
            if claude {
                m.add_file(&dir.join("CLAUDE.local.md"), Scope::Local);
            }
        }
        m
    }

    /// Everything loaded so far, for the system prompt.
    pub fn render(&self) -> String {
        render_files(&self.files)
    }

    /// A tool touched `path`: load the subdirectory CLAUDE.md files and the
    /// path-scoped rules it brings in, once each, and return their text.
    pub fn on_file_access(&mut self, path: &Path) -> Vec<String> {
        let path = normalize(path);
        let before = self.files.len();
        if path.starts_with(&self.cwd) && path != self.cwd {
            let dir = if path.is_dir() { path.clone() } else { path.parent().map(Path::to_path_buf).unwrap_or_default() };
            let mut dirs: Vec<PathBuf> = dir
                .ancestors()
                .take_while(|d| d.starts_with(&self.cwd) && *d != self.cwd)
                .map(Path::to_path_buf)
                .collect();
            dirs.reverse();
            for d in dirs {
                let had_claude = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]
                    .iter()
                    .any(|n| d.join(n).is_file());
                // Subdirectory files load on demand in every mode, managed-only included.
                self.add_file(&d.join("CLAUDE.md"), Scope::Project);
                self.add_file(&d.join(".claude/CLAUDE.md"), Scope::Project);
                self.add_rules_dir(&d.join(".claude/rules"), Scope::ProjectRule, &d);
                if self.agents_mode && !had_claude {
                    self.add_file(&d.join("AGENTS.md"), Scope::Agents);
                }
                self.add_file(&d.join("CLAUDE.local.md"), Scope::Local);
            }
        }
        // Path-scoped rules whose globs match this file.
        let mut i = 0;
        while i < self.pending_rules.len() {
            if self.pending_rules[i].matcher.is_match(&path) {
                let rule = self.pending_rules.remove(i);
                self.files.push(MemoryFile {
                    path: rule.path,
                    scope: rule.scope,
                    content: rule.content,
                });
            } else {
                i += 1;
            }
        }
        self.files[before..]
            .iter()
            .map(|f| render_files(std::slice::from_ref(f)))
            .collect()
    }

    fn excluded(&self, path: &Path, scope: Scope) -> bool {
        scope != Scope::Managed && self.excludes.is_match(path)
    }

    fn add_file(&mut self, path: &Path, scope: Scope) {
        let path = normalize(path);
        if !path.is_file() || self.excluded(&path, scope) {
            return;
        }
        let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !self.loaded.insert(key) {
            return;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            return;
        };
        let mut content = strip_block_comments(&text);
        let mut visited = HashSet::new();
        visited.insert(path.clone());
        let imports = self.expand_imports(&content, &path, scope, 1, &mut visited);
        if !imports.is_empty() {
            content.push_str(&imports);
        }
        self.files.push(MemoryFile { path, scope, content });
    }

    /// Rule files, recursively (symlinks followed, cycles cut). A rule with
    /// `paths` waits for a matching file; one without loads now.
    fn add_rules_dir(&mut self, dir: &Path, scope: Scope, base: &Path) {
        let mut seen = HashSet::new();
        let mut files = Vec::new();
        collect_md(dir, &mut seen, &mut files);
        files.sort();
        for path in files {
            if self.excluded(&path, scope) {
                continue;
            }
            let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if self.loaded.contains(&key) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let fm = frontmatter::split(&text);
            let body = if fm.present { fm.body.clone() } else { text.clone() };
            let mut content = strip_block_comments(&body);
            let mut visited = HashSet::new();
            visited.insert(path.clone());
            content.push_str(&self.expand_imports(&content.clone(), &path, scope, 1, &mut visited));
            let paths = if fm.error.is_none() { fm.comma_list_field("paths") } else { None };
            self.loaded.insert(key);
            match paths.filter(|p| !p.is_empty()) {
                Some(globs) => {
                    let rooted: Vec<String> = globs.iter().map(|g| rooted_glob(base, g)).collect();
                    self.pending_rules.push(PathRule {
                        path,
                        scope,
                        content,
                        matcher: build_set(&rooted, true),
                    });
                }
                None => self.files.push(MemoryFile { path, scope, content }),
            }
        }
    }

    /// `@path` imports outside code: relative to the importing file, `~/`
    /// from home, absolute as is; `\ ` keeps a space in the path. A path that
    /// is not a readable file stays plain text.
    fn expand_imports(
        &mut self,
        content: &str,
        from: &Path,
        scope: Scope,
        hop: usize,
        visited: &mut HashSet<PathBuf>,
    ) -> String {
        if hop > MAX_IMPORT_HOPS {
            return String::new();
        }
        let base = from.parent().unwrap_or(Path::new("/")).to_path_buf();
        let mut out = String::new();
        for raw in import_paths(content) {
            let target = resolve(&raw, &base, &self.home);
            if !target.is_file() || visited.contains(&target) || self.excluded(&target, scope) {
                continue;
            }
            if !scope.trusted_imports() && !target.starts_with(&self.cwd) && !self.opts.external_imports {
                if !self.skipped_imports.contains(&target) {
                    self.skipped_imports.push(target);
                }
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&target) else {
                continue;
            };
            visited.insert(target.clone());
            let body = strip_block_comments(&text);
            let nested = self.expand_imports(&body, &target, scope, hop + 1, visited);
            out.push_str(&format!(
                "\n\n<imported path=\"{}\" from=\"{}\">\n{}{}\n</imported>",
                target.display(),
                from.display(),
                body.trim_end(),
                nested
            ));
        }
        out
    }
}

fn render_files(files: &[MemoryFile]) -> String {
    files
        .iter()
        .filter(|f| !f.content.trim().is_empty())
        .map(|f| format!("Contents of {} ({}):\n\n{}", f.path.display(), f.scope.label(), f.content.trim_end()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn collect_md(dir: &Path, seen: &mut HashSet<PathBuf>, out: &mut Vec<PathBuf>) {
    let Ok(canon) = std::fs::canonicalize(dir) else {
        return;
    };
    if !seen.insert(canon) {
        return; // a symlink cycle
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_md(&p, seen, out);
        } else if p.extension().is_some_and(|e| e == "md") && p.is_file() {
            out.push(p);
        }
    }
}

/// A `paths` pattern made absolute against the rule's base directory: a
/// pattern without `/` matches at any depth, a leading `/` anchors at the
/// base, anything else is relative to the base.
fn rooted_glob(base: &Path, pattern: &str) -> String {
    let base = globset::escape(base.to_string_lossy().trim_end_matches('/'));
    let p = pattern.trim();
    if let Some(rest) = p.strip_prefix('/') {
        format!("{base}/{rest}")
    } else if !p.contains('/') {
        format!("{base}/**/{p}")
    } else {
        format!("{base}/{}", p.trim_start_matches("./"))
    }
}

fn build_set(patterns: &[String], literal_separator: bool) -> GlobSet {
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        if let Ok(g) = GlobBuilder::new(p).literal_separator(literal_separator).build() {
            b.add(g);
        }
    }
    b.build().unwrap_or_else(|_| GlobSet::empty())
}

/// Drop block-level `<!-- … -->` comments outside fenced code blocks.
pub fn strip_block_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_fence = false;
    let mut in_comment = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if in_comment {
            if let Some(end) = line.find("-->") {
                in_comment = false;
                let rest = &line[end + 3..];
                if !rest.trim().is_empty() {
                    out.push_str(rest);
                }
            }
            continue;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            out.push_str(line);
            continue;
        }
        if !in_fence && trimmed.starts_with("<!--") {
            match trimmed.find("-->") {
                Some(end) => {
                    let rest = &trimmed[end + 3..];
                    if !rest.trim().is_empty() {
                        out.push_str(rest);
                    }
                }
                None => in_comment = true,
            }
            continue;
        }
        out.push_str(line);
    }
    out
}

/// The `@path` imports of a Markdown text: outside fenced code blocks and
/// backtick code spans, at the start of a word, ending at whitespace unless
/// the space is backslash-escaped. Quoted paths are not imports.
pub fn import_paths(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        let mut in_span = false;
        while i < chars.len() {
            let c = chars[i];
            if c == '`' {
                in_span = !in_span;
                i += 1;
                continue;
            }
            let at_word_start = i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(';
            if !in_span && c == '@' && at_word_start && i + 1 < chars.len() {
                let next = chars[i + 1];
                if next == '"' || next == '\'' || next.is_whitespace() {
                    i += 1;
                    continue;
                }
                let mut path = String::new();
                let mut j = i + 1;
                while j < chars.len() {
                    let ch = chars[j];
                    if ch == '\\' && j + 1 < chars.len() && chars[j + 1] == ' ' {
                        path.push(' ');
                        j += 2;
                        continue;
                    }
                    if ch.is_whitespace() || ch == '`' {
                        break;
                    }
                    path.push(ch);
                    j += 1;
                }
                // Trailing sentence punctuation is not part of the path.
                while path.ends_with(['.', ',', ';', ':', ')', '!', '?']) {
                    path.pop();
                }
                if !path.is_empty() {
                    out.push(path);
                }
                i = j;
                continue;
            }
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fx {
        _dir: tempfile::TempDir,
        root: PathBuf,
        home: PathBuf,
    }

    fn fx() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let home = root.join("home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        Fx { _dir: dir, root, home }
    }

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn env(fx: &Fx, cwd: &Path) -> ClaudeEnv {
        ClaudeEnv::new(cwd, &fx.home, &fx.home.join(".claude"), &fx.home.join(".claude.json"), Some(fx.root.join("managed")))
    }

    fn order(m: &Memory) -> Vec<String> {
        m.files
            .iter()
            .map(|f| f.content.lines().next().unwrap_or("").to_string())
            .collect()
    }

    #[test]
    fn load_order_root_to_cwd_local_last() {
        let fx = fx();
        let repo = fx.root.join("repo");
        let cwd = repo.join("foo/bar");
        write(&fx.root.join("managed/CLAUDE.md"), "managed");
        write(&fx.home.join(".claude/CLAUDE.md"), "user");
        write(&fx.home.join(".claude/rules/pref.md"), "user rule");
        write(&repo.join("CLAUDE.md"), "repo");
        write(&repo.join(".claude/CLAUDE.md"), "repo dot");
        write(&repo.join(".claude/rules/testing.md"), "repo rule");
        write(&repo.join("CLAUDE.local.md"), "repo local");
        write(&repo.join("foo/CLAUDE.md"), "foo");
        write(&cwd.join("CLAUDE.md"), "bar");
        write(&cwd.join("CLAUDE.local.md"), "bar local");
        write(&repo.join("AGENTS.md"), "agents");
        let m = Memory::load(&env(&fx, &cwd), MemoryOptions::default());
        assert_eq!(
            order(&m),
            ["managed", "user", "user rule", "repo", "repo dot", "repo rule", "repo local", "foo", "bar", "bar local"]
        );
        let text = m.render();
        assert!(text.contains("(project instructions)"));
        assert!(!text.contains("agents"), "AGENTS.md is skipped when CLAUDE.md exists");
    }

    #[test]
    fn agents_md_when_no_claude_md() {
        let fx = fx();
        let repo = fx.root.join("repo");
        write(&fx.home.join(".claude/CLAUDE.md"), "user");
        write(&repo.join("AGENTS.md"), "agents root");
        write(&repo.join(".claude/AGENTS.md"), "agents dot");
        let m = Memory::load(&env(&fx, &repo), MemoryOptions::default());
        assert_eq!(order(&m), ["user", "agents root", "agents dot"]);
        let m = Memory::load(&env(&fx, &repo), MemoryOptions { instruction_files: InstructionFiles::ClaudeMd, ..Default::default() });
        assert_eq!(order(&m), ["user"]);
        write(&repo.join("CLAUDE.md"), "claude");
        let m = Memory::load(&env(&fx, &repo), MemoryOptions { instruction_files: InstructionFiles::ClaudeMdAndAgentsMd, ..Default::default() });
        assert_eq!(order(&m), ["user", "claude", "agents root", "agents dot"]);
    }

    #[test]
    fn imports_expand_relative_with_depth_limit() {
        let fx = fx();
        let repo = fx.root.join("repo");
        write(&repo.join("CLAUDE.md"), "See @docs/a.md and `@ignored.md`.\n```\n@also-ignored.md\n```\n");
        write(&repo.join("docs/a.md"), "A @b.md");
        write(&repo.join("docs/b.md"), "B @c.md");
        write(&repo.join("docs/c.md"), "C @d.md");
        write(&repo.join("docs/d.md"), "D @e.md");
        write(&repo.join("docs/e.md"), "E too deep");
        write(&repo.join("ignored.md"), "IGNORED");
        write(&repo.join("also-ignored.md"), "IGNORED2");
        let m = Memory::load(&env(&fx, &repo), MemoryOptions::default());
        let text = m.render();
        for part in ["A @b.md", "B @c.md", "C @d.md", "D @e.md"] {
            assert!(text.contains(part), "{part} missing");
        }
        assert!(!text.contains("E too deep"), "five hops is past the limit");
        assert!(!text.contains("IGNORED"));
    }

    #[test]
    fn escaped_spaces_and_external_imports() {
        let fx = fx();
        let repo = fx.root.join("repo");
        write(&repo.join("Design Docs/api.md"), "API conventions");
        write(&fx.home.join("prefs.md"), "my prefs");
        write(&repo.join("CLAUDE.md"), "- api @Design\\ Docs/api.md\n- mine @~/prefs.md\n- quoted @\"x.md\"\n");
        let m = Memory::load(&env(&fx, &repo), MemoryOptions::default());
        let text = m.render();
        assert!(text.contains("API conventions"));
        assert!(!text.contains("my prefs"), "external imports of project files need approval");
        assert_eq!(m.skipped_imports, vec![fx.home.join("prefs.md")]);
        let m = Memory::load(&env(&fx, &repo), MemoryOptions { external_imports: true, ..Default::default() });
        assert!(m.render().contains("my prefs"));
        // the user's own file imports without approval
        write(&fx.home.join(".claude/CLAUDE.md"), "@~/prefs.md");
        let m = Memory::load(&env(&fx, &repo), MemoryOptions::default());
        assert!(m.render().contains("my prefs"));
    }

    #[test]
    fn comments_stripped_outside_code() {
        let text = "keep\n<!-- maintainer\nnotes -->\nafter\n```\n<!-- in code -->\n```\n<!-- one line -->\n";
        let out = strip_block_comments(text);
        assert!(out.contains("keep") && out.contains("after") && out.contains("<!-- in code -->"));
        assert!(!out.contains("maintainer") && !out.contains("one line"));
    }

    #[test]
    fn path_scoped_rules_and_nested_claude_md_load_on_demand() {
        let fx = fx();
        let repo = fx.root.join("repo");
        write(&repo.join("CLAUDE.md"), "root");
        write(&repo.join(".claude/rules/api.md"), "---\npaths:\n  - \"src/api/**/*.ts\"\n---\nAPI RULE\n");
        write(&repo.join(".claude/rules/md.md"), "---\npaths: \"*.md\"\n---\nMD RULE\n");
        write(&repo.join("pkg/CLAUDE.md"), "PKG");
        let mut m = Memory::load(&env(&fx, &repo), MemoryOptions::default());
        assert_eq!(order(&m), ["root"]);
        assert!(m.on_file_access(&repo.join("src/other.ts")).is_empty());
        let got = m.on_file_access(&repo.join("src/api/v1/users.ts"));
        assert_eq!(got.len(), 1);
        assert!(got[0].contains("API RULE") && !got[0].contains("paths:"));
        assert!(m.on_file_access(&repo.join("src/api/v1/users.ts")).is_empty(), "once");
        let got = m.on_file_access(&repo.join("pkg/deep/notes.md"));
        assert!(got.iter().any(|g| g.contains("PKG")));
        assert!(got.iter().any(|g| g.contains("MD RULE")), "bare patterns match at any depth");
    }

    #[test]
    fn excludes_skip_files_but_not_managed() {
        let fx = fx();
        let repo = fx.root.join("repo");
        write(&fx.root.join("managed/CLAUDE.md"), "managed");
        write(&fx.root.join("CLAUDE.md"), "monorepo");
        write(&repo.join("CLAUDE.md"), "repo");
        let opts = MemoryOptions {
            excludes: vec![format!("{}/CLAUDE.md", fx.root.display()), "**/managed/CLAUDE.md".into()],
            ..Default::default()
        };
        let m = Memory::load(&env(&fx, &repo), opts);
        assert_eq!(order(&m), ["managed", "repo"]);
    }

    #[test]
    fn import_parser_edge_cases() {
        assert_eq!(import_paths("See @README for x and @package.json."), vec!["README", "package.json"]);
        assert_eq!(import_paths("mail me@example.com"), Vec::<String>::new());
        assert_eq!(import_paths("(@docs/x.md)"), vec!["docs/x.md"]);
    }
}
