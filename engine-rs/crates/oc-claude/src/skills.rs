//! Skills and custom commands (code.claude.com/docs/en/skills).
//!
//! `SKILL.md` folders in `~/.claude/skills/`, in `.claude/skills/` from the
//! cwd up to the repository root, and in plugins (`plugin:name`); Markdown
//! commands in `.claude/commands/` (subfolders give `dir:name`). Descriptions
//! go to the model; a body loads only when the skill is invoked, by the user
//! (`/name args`) or by the model through the `skill` tool.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::frontmatter;
use crate::paths::ClaudeEnv;
use crate::plugins::Plugin;

/// The listing cap for `description` + `when_to_use`.
pub const DESCRIPTION_CAP: usize = 1536;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SkillSource {
    Managed,
    Personal,
    Project,
    Plugin,
}

#[derive(Debug, Clone)]
pub struct Skill {
    /// The command name (`deploy`, `frontend:component`, `my-plugin:review`).
    pub name: String,
    /// Other names that invoke it (the folder name when `name` differs, the
    /// bare name of a plugin skill).
    pub aliases: Vec<String>,
    pub description: String,
    pub body: String,
    /// The skill's folder (`${CLAUDE_SKILL_DIR}`), or the command file's folder.
    pub dir: PathBuf,
    pub file: Option<PathBuf>,
    pub is_command: bool,
    pub source: SkillSource,
    pub plugin: Option<(String, PathBuf, PathBuf)>,
    pub disable_model_invocation: bool,
    pub user_invocable: bool,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub model: Option<String>,
    pub arguments: Vec<String>,
    pub argument_hint: Option<String>,
    pub hooks: Option<Value>,
    pub context_fork: bool,
    pub agent: Option<String>,
}

impl Skill {
    fn from_text(name: String, text: &str, dir: &Path, file: Option<PathBuf>, is_command: bool, source: SkillSource) -> Self {
        let fm = frontmatter::split(text);
        let body = if fm.present { fm.body.clone() } else { text.to_string() };
        let mut description = fm
            .str_field("description")
            .unwrap_or_else(|| body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string());
        if let Some(when) = fm.str_field("when_to_use") {
            description = format!("{description} {when}");
        }
        if description.chars().count() > DESCRIPTION_CAP {
            description = description.chars().take(DESCRIPTION_CAP).collect();
        }
        let description = description.replace('<', "&lt;").replace('>', "&gt;");
        Skill {
            name,
            aliases: Vec::new(),
            description,
            body,
            dir: dir.to_path_buf(),
            file,
            is_command,
            source,
            plugin: None,
            disable_model_invocation: fm.bool_field("disable-model-invocation").unwrap_or(false),
            user_invocable: fm.bool_field("user-invocable").unwrap_or(true),
            allowed_tools: fm.list_field("allowed-tools").unwrap_or_default(),
            disallowed_tools: fm.list_field("disallowed-tools").unwrap_or_default(),
            model: fm.str_field("model").filter(|m| m != "inherit"),
            arguments: fm.list_field("arguments").unwrap_or_default(),
            argument_hint: fm.str_field("argument-hint"),
            hooks: fm.get("hooks").filter(|h| h.is_object()).cloned(),
            context_fork: fm.str_field("context").as_deref() == Some("fork"),
            agent: fm.str_field("agent"),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub skills: Vec<Skill>,
}

/// Characters a skill or command name can't hold.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with("anthropic-skills")
        && !name.eq_ignore_ascii_case("synced")
        && !name.contains(['<', '>'])
        && !name.contains("  ")
        && name.trim() == name
        && name.chars().all(|c| !c.is_control() && (c == ' ' || !c.is_whitespace()) && !('\u{200b}'..='\u{200f}').contains(&c))
}

impl Catalog {
    pub fn load(env: &ClaudeEnv, plugins: &[Plugin]) -> Self {
        let mut c = Catalog::default();
        // Higher-priority sources first: an earlier name wins.
        if let Some(dir) = &env.managed_dir {
            c.add_skill_dir(&dir.join(".claude/skills"), SkillSource::Managed, None);
        }
        c.add_skill_dir(&env.config_dir.join("skills"), SkillSource::Personal, None);
        for dir in env.up_to_repo_root() {
            if crate::paths::normalize(&dir.join(".claude")) == crate::paths::normalize(&env.config_dir) {
                continue;
            }
            c.add_skill_dir(&dir.join(".claude/skills"), SkillSource::Project, None);
        }
        // Commands lose to skills of the same name.
        c.add_command_dir(&env.config_dir.join("commands"), SkillSource::Personal, None);
        for dir in env.up_to_repo_root() {
            if crate::paths::normalize(&dir.join(".claude")) == crate::paths::normalize(&env.config_dir) {
                continue;
            }
            c.add_command_dir(&dir.join(".claude/commands"), SkillSource::Project, None);
        }
        for p in plugins {
            let tag = Some(p);
            for d in &p.skill_dirs {
                c.add_skill_dir(d, SkillSource::Plugin, tag);
            }
            if let Some(file) = &p.root_skill {
                if let Ok(text) = std::fs::read_to_string(file) {
                    let fm = frontmatter::split(&text);
                    let short = fm.str_field("name").unwrap_or_else(|| p.name.clone());
                    c.push_plugin(Skill::from_text(short, &text, &p.root, Some(file.clone()), false, SkillSource::Plugin), p);
                }
            }
            for d in &p.command_dirs {
                c.add_command_dir(d, SkillSource::Plugin, tag);
            }
            for cmd in &p.commands {
                let text = match (&cmd.file, &cmd.content) {
                    (Some(f), _) => std::fs::read_to_string(f).unwrap_or_default(),
                    (None, Some(t)) => t.clone(),
                    _ => continue,
                };
                let dir = cmd.file.as_ref().and_then(|f| f.parent().map(Path::to_path_buf)).unwrap_or(p.root.clone());
                let mut s = Skill::from_text(cmd.name.clone(), &text, &dir, cmd.file.clone(), true, SkillSource::Plugin);
                if let Some(d) = &cmd.description {
                    s.description = d.clone();
                }
                if s.argument_hint.is_none() {
                    s.argument_hint = cmd.argument_hint.clone();
                }
                if !cmd.allowed_tools.is_empty() {
                    s.allowed_tools = cmd.allowed_tools.clone();
                }
                c.push_plugin(s, p);
            }
        }
        c
    }

    fn taken(&self, name: &str) -> bool {
        self.skills.iter().any(|s| s.name == name || s.aliases.iter().any(|a| a == name))
    }

    fn add_skill_dir(&mut self, dir: &Path, source: SkillSource, plugin: Option<&Plugin>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut folders: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.join("SKILL.md").is_file()).collect();
        folders.sort();
        for folder in folders {
            let folder_name = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if plugin.is_none() && !valid_name(&folder_name) {
                continue;
            }
            let file = folder.join("SKILL.md");
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            let real = std::fs::canonicalize(&folder).unwrap_or(folder.clone());
            if self.skills.iter().any(|s| s.dir == real) {
                continue; // two locations pointing at one target load once
            }
            let fm = frontmatter::split(&text);
            let short = fm.str_field("name").filter(|n| valid_name(n)).unwrap_or(folder_name.clone());
            let mut skill = Skill::from_text(short.clone(), &text, &real, Some(file), false, source);
            match plugin {
                Some(p) => self.push_plugin(skill, p),
                None => {
                    if self.taken(&short) && self.taken(&folder_name) {
                        continue;
                    }
                    if self.taken(&short) {
                        skill.name = folder_name.clone();
                    } else if folder_name != short && !self.taken(&folder_name) {
                        skill.aliases.push(folder_name);
                    }
                    self.skills.push(skill);
                }
            }
        }
    }

    fn add_command_dir(&mut self, dir: &Path, source: SkillSource, plugin: Option<&Plugin>) {
        let mut files = Vec::new();
        collect(dir, dir, &mut files);
        files.sort();
        for (rel, file) in files {
            let name = rel.trim_end_matches(".md").replace('/', ":");
            if plugin.is_none() && !valid_name(&name) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            let parent = file.parent().unwrap_or(dir).to_path_buf();
            let skill = Skill::from_text(name.clone(), &text, &parent, Some(file), true, source);
            match plugin {
                Some(p) => self.push_plugin(skill, p),
                None if self.taken(&name) => {}
                None => self.skills.push(skill),
            }
        }
    }

    /// Plugin skills are namespaced `plugin:name`; the bare name also works
    /// while nothing else uses it.
    fn push_plugin(&mut self, mut skill: Skill, p: &Plugin) {
        let short = skill.name.clone();
        let prefix = format!("{}:", p.name);
        skill.name = if short.starts_with(&prefix) { short.clone() } else { format!("{prefix}{short}") };
        let bare = skill.name.trim_start_matches(&prefix).to_string();
        if !self.taken(&bare) {
            skill.aliases.push(bare);
        }
        skill.plugin = Some((p.name.clone(), p.root.clone(), p.data_dir.clone()));
        if !self.taken(&skill.name) {
            self.skills.push(skill);
        }
    }

    pub fn find(&self, name: &str) -> Option<&Skill> {
        let name = name.trim_start_matches('/');
        self.skills
            .iter()
            .find(|s| s.name == name)
            .or_else(|| self.skills.iter().find(|s| s.aliases.iter().any(|a| a == name)))
    }

    /// What the model sees: the skills it may invoke, one per line.
    pub fn listing(&self) -> String {
        self.skills
            .iter()
            .filter(|s| !s.disable_model_invocation)
            .map(|s| format!("- {}: {}", s.name, s.description))
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn model_invocable(&self) -> bool {
        self.skills.iter().any(|s| !s.disable_model_invocation)
    }
}

fn collect(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(base, &p, out);
        } else if p.extension().is_some_and(|x| x == "md") {
            if let Ok(rel) = p.strip_prefix(base) {
                out.push((rel.to_string_lossy().into_owned(), p.clone()));
            }
        }
    }
}

/// Shell-style splitting of `$ARGUMENTS` into positions.
pub fn split_args(args: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    let mut chars = args.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') if matches!(chars.peek(), Some('"') | Some('\\')) => cur.push(chars.next().unwrap_or('\\')),
            (Some(_), c) => cur.push(c),
            (None, '"') | (None, '\'') => {
                quote = Some(c);
                started = true;
            }
            (None, '\\') => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    started = true;
                }
            }
            (None, c) if c.is_whitespace() => {
                if started || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            (None, c) => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started || !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Values for `${CLAUDE_*}` substitution.
pub struct RenderVars<'a> {
    pub session_id: &'a str,
    pub project_dir: &'a Path,
    pub effort: &'a str,
}

/// The skill body with `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name` and the
/// `${CLAUDE_*}` variables substituted (skills reference, "Available string
/// substitutions"). Argument values are inserted literally; when no
/// placeholder received the arguments they are appended as `ARGUMENTS: …`.
pub fn render(skill: &Skill, args: &str, vars: &RenderVars) -> String {
    let positions = split_args(args);
    let body = &skill.body;
    let mut out = String::with_capacity(body.len() + args.len());
    let mut received = false;
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() && chars[i + 1] == '$' && (i == 0 || chars[i - 1] != '\\') {
            if let Some((_, len)) = placeholder_at(&chars, i + 1, &skill.arguments) {
                out.extend(&chars[i + 1..i + 1 + len]);
                i += 1 + len;
                continue;
            }
        }
        if c == '$' {
            if let Some((ph, len)) = placeholder_at(&chars, i, &skill.arguments) {
                match ph {
                    Placeholder::All => {
                        out.push_str(args);
                        received = true;
                    }
                    Placeholder::Index(n) => match positions.get(n) {
                        Some(v) => {
                            out.push_str(v);
                            received = true;
                        }
                        None => out.extend(&chars[i..i + len]),
                    },
                    Placeholder::Named(n) => {
                        received = true;
                        out.push_str(positions.get(n).map(String::as_str).unwrap_or(""));
                    }
                }
                i += len;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    if !received && !args.trim().is_empty() {
        out = format!("{}\n\nARGUMENTS: {}", out.trim_end(), args.trim());
    }
    let mut subst = vec![
        ("CLAUDE_SESSION_ID", vars.session_id.to_string()),
        ("CLAUDE_EFFORT", vars.effort.to_string()),
        ("CLAUDE_SKILL_DIR", skill.dir.to_string_lossy().into_owned()),
        ("CLAUDE_PROJECT_DIR", vars.project_dir.to_string_lossy().into_owned()),
    ];
    if let Some((_, root, data)) = &skill.plugin {
        subst.push(("CLAUDE_PLUGIN_ROOT", root.to_string_lossy().into_owned()));
        subst.push(("CLAUDE_PLUGIN_DATA", data.to_string_lossy().into_owned()));
    }
    for (k, v) in subst {
        out = out.replace(&format!("${{{k}}}"), &v);
    }
    out
}

enum Placeholder {
    All,
    Index(usize),
    Named(usize),
}

fn placeholder_at(chars: &[char], i: usize, names: &[String]) -> Option<(Placeholder, usize)> {
    let rest: String = chars[i + 1..].iter().take(64).collect();
    if let Some(after) = rest.strip_prefix("ARGUMENTS") {
        if let Some(idx) = after.strip_prefix('[') {
            let digits: String = idx.chars().take_while(char::is_ascii_digit).collect();
            if !digits.is_empty() && idx[digits.len()..].starts_with(']') {
                return Some((Placeholder::Index(digits.parse().ok()?), 1 + 9 + 1 + digits.len() + 1));
            }
        }
        let next = after.chars().next();
        if next.is_none_or(|c| !(c.is_alphanumeric() || c == '_')) {
            return Some((Placeholder::All, 10));
        }
    }
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if !digits.is_empty() {
        return Some((Placeholder::Index(digits.parse().ok()?), 1 + digits.len()));
    }
    let word: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
    if let Some(pos) = names.iter().position(|n| *n == word) {
        return Some((Placeholder::Named(pos), 1 + word.len()));
    }
    None
}

/// The injected commands of a rendered body: `` !`cmd` `` inline and
/// ` ```! ` fenced blocks. Returns (placeholder text, command) pairs.
pub fn injected_commands(body: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut lines = body.split_inclusive('\n').peekable();
    let mut in_fence = false;
    while let Some(line) = lines.next() {
        let t = line.trim_start();
        if t.starts_with("```!") && !in_fence {
            let mut block = line.to_string();
            let mut cmd = String::new();
            for l in lines.by_ref() {
                block.push_str(l);
                if l.trim_start().starts_with("```") {
                    break;
                }
                cmd.push_str(l);
            }
            out.push((block, cmd.trim_end().to_string()));
            continue;
        }
        if t.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let mut rest = line;
        while let Some(pos) = rest.find("!`") {
            let after = &rest[pos + 2..];
            let Some(end) = after.find('`') else {
                break;
            };
            let cmd = &after[..end];
            if !cmd.trim().is_empty() {
                out.push((format!("!`{cmd}`"), cmd.to_string()));
            }
            rest = &after[end + 1..];
        }
    }
    out
}

/// Exit 1 is a normal result for search and comparison commands.
pub fn search_command(cmd: &str) -> bool {
    let first = cmd.split_whitespace().next().unwrap_or("");
    matches!(first, "grep" | "egrep" | "fgrep" | "rg" | "diff" | "cmp" | "find" | "test" | "[")
        || cmd.trim_start().starts_with("git diff")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn skill(body: &str, arguments: &[&str]) -> Skill {
        let mut s = Skill::from_text("s".into(), body, Path::new("/skills/s"), None, false, SkillSource::Project);
        s.arguments = arguments.iter().map(|a| a.to_string()).collect();
        s
    }

    fn vars() -> RenderVars<'static> {
        RenderVars { session_id: "ses_1", project_dir: Path::new("/proj"), effort: "medium" }
    }

    #[test]
    fn substitutions() {
        let s = skill("Fix issue $ARGUMENTS now", &[]);
        assert_eq!(render(&s, "123", &vars()), "Fix issue 123 now");
        let s = skill("Migrate $ARGUMENTS[0] from $1 to $2.", &[]);
        assert_eq!(render(&s, "SearchBar JavaScript TypeScript", &vars()), "Migrate SearchBar from JavaScript to TypeScript.");
        let s = skill("A=$0 B=$1 C=$2", &[]);
        assert_eq!(render(&s, "\"hello world\" second", &vars()), "A=hello world B=second C=$2");
        let s = skill("Issue $issue on $branch", &["issue", "branch"]);
        assert_eq!(render(&s, "42", &vars()), "Issue 42 on ");
        let s = skill("No placeholders.", &[]);
        assert_eq!(render(&s, "x y", &vars()), "No placeholders.\n\nARGUMENTS: x y");
        let s = skill("Costs \\$1.00 for $0", &[]);
        assert_eq!(render(&s, "a", &vars()), "Costs $1.00 for a");
        let s = skill("Summarize $0", &[]);
        assert_eq!(render(&s, "\"$ARGUMENTS from yesterday\"", &vars()), "Summarize $ARGUMENTS from yesterday");
        let s = skill("log ${CLAUDE_SESSION_ID} in ${CLAUDE_SKILL_DIR} of ${CLAUDE_PROJECT_DIR}", &[]);
        assert_eq!(render(&s, "", &vars()), "log ses_1 in /skills/s of /proj");
    }

    #[test]
    fn discovery_names_and_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let home = root.join("home");
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        write(&home.join(".claude/skills/deploy/SKILL.md"), "---\ndescription: personal deploy\n---\nP");
        write(&repo.join(".claude/skills/deploy/SKILL.md"), "---\ndescription: project deploy\n---\nQ");
        write(&repo.join(".claude/skills/staging/SKILL.md"), "---\nname: ship\ndescription: Ship it\ndisable-model-invocation: true\n---\nShip");
        write(&repo.join(".claude/skills/bg/SKILL.md"), "---\ndescription: background knowledge\nuser-invocable: false\n---\nBG");
        write(&repo.join(".claude/commands/frontend/component.md"), "Make a component $ARGUMENTS");
        write(&repo.join(".claude/commands/deploy.md"), "command loses to skill");
        write(&repo.join("pkg/.keep"), "");
        let env = ClaudeEnv::new(&repo.join("pkg"), &home, &home.join(".claude"), &home.join(".claude.json"), None);
        let c = Catalog::load(&env, &[]);
        assert_eq!(c.find("deploy").unwrap().description, "personal deploy");
        assert_eq!(c.find("ship").unwrap().body, "Ship");
        assert_eq!(c.find("staging").unwrap().name, "ship", "the folder name also invokes it");
        assert_eq!(c.find("/frontend:component").unwrap().body, "Make a component $ARGUMENTS");
        assert!(c.find("frontend:component").unwrap().is_command);
        let listing = c.listing();
        assert!(listing.contains("- deploy: personal deploy"));
        assert!(listing.contains("- bg: background knowledge"));
        assert!(!listing.contains("ship"), "disable-model-invocation hides it from the model");
        assert!(!c.find("bg").unwrap().user_invocable);
    }

    #[test]
    fn description_falls_back_to_first_line() {
        let s = Skill::from_text("x".into(), "\n\nFirst real line\nmore", Path::new("/"), None, false, SkillSource::Project);
        assert_eq!(s.description, "First real line");
    }

    #[test]
    fn injected_command_parsing() {
        let body = "PR: !`gh pr diff` and !`git log -1`\n```!\nnode --version\ngit status --short\n```\n```\n!`not this`\n```\n";
        let cmds: Vec<String> = injected_commands(body).into_iter().map(|(_, c)| c).collect();
        assert_eq!(cmds, vec!["gh pr diff", "git log -1", "node --version\ngit status --short"]);
    }

    #[test]
    fn arg_splitting() {
        assert_eq!(split_args("a \"b c\" 'd e' f\\ g"), vec!["a", "b c", "d e", "f g"]);
        assert_eq!(split_args("  "), Vec::<String>::new());
        assert_eq!(split_args("\"\""), vec![""]);
    }
}
