//! YAML frontmatter of Claude Code Markdown files (skills, commands,
//! subagents, rules). See docs/claude-code-compat.md.
//!
//! Claude Code reads frontmatter only when the opening `---` is the file's
//! first line; YAML that doesn't parse leaves the file with no fields
//! (skills reference, "Frontmatter reference").

use serde_json::{Map, Value};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Frontmatter {
    /// The parsed fields (empty when there is none or it failed to parse).
    pub fields: Map<String, Value>,
    /// The Markdown after the closing `---` line, or the whole text.
    pub body: String,
    /// Set when the YAML did not parse or was not a mapping.
    pub error: Option<String>,
    /// True when an opening and a closing marker were found.
    pub present: bool,
}

fn is_marker(line: &str) -> bool {
    line.trim_end_matches(['\r', ' ', '\t']) == "---"
}

/// Split a Markdown file into frontmatter and body.
pub fn split(text: &str) -> Frontmatter {
    let whole = || Frontmatter { body: text.to_string(), ..Default::default() };
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(first_end) = t.find('\n') else {
        return whole();
    };
    if !is_marker(&t[..first_end]) {
        return whole();
    }
    let rest = &t[first_end + 1..];
    let mut offset = 0;
    let mut close: Option<(usize, usize)> = None; // (yaml end, body start)
    for line in rest.split_inclusive('\n') {
        if is_marker(line.trim_end_matches('\n')) {
            close = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let Some((yaml_end, body_start)) = close else {
        return whole();
    };
    let yaml = &rest[..yaml_end];
    let body = rest[body_start..].to_string();
    let mut fm = Frontmatter { body, present: true, ..Default::default() };
    if yaml.trim().is_empty() {
        return fm;
    }
    match serde_yaml::from_str::<Value>(&yaml.replace("\r\n", "\n")) {
        Ok(Value::Object(map)) => fm.fields = map,
        Ok(Value::Null) => {}
        Ok(_) => fm.error = Some("frontmatter is not a mapping".into()),
        Err(e) => fm.error = Some(e.to_string()),
    }
    fm
}

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Split on separators at nesting depth 0 for `()`, `{}` and `[]`.
fn split_depth0(s: &str, is_sep: impl Fn(char) -> bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    for c in s.chars() {
        match c {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            _ => {}
        }
        if depth <= 0 && is_sep(c) {
            if !cur.trim().is_empty() {
                out.push(cur.trim().to_string());
            }
            cur.clear();
        } else {
            cur.push(c);
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

impl Frontmatter {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }

    pub fn str_field(&self, key: &str) -> Option<String> {
        self.get(key).and_then(scalar)
    }

    /// `true`/`false`, and `yes`/`no`/`on`/`off`/`1`/`0` in any case.
    pub fn bool_field(&self, key: &str) -> Option<bool> {
        match self.get(key)? {
            Value::Bool(b) => Some(*b),
            Value::Number(n) => match n.as_i64() {
                Some(1) => Some(true),
                Some(0) => Some(false),
                _ => None,
            },
            Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
                "true" | "yes" | "on" | "1" => Some(true),
                "false" | "no" | "off" | "0" => Some(false),
                _ => None,
            },
            _ => None,
        }
    }

    fn list(&self, key: &str, is_sep: impl Fn(char) -> bool) -> Option<Vec<String>> {
        match self.get(key)? {
            Value::Array(items) => Some(
                items
                    .iter()
                    .filter_map(scalar)
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
            ),
            v => scalar(v).map(|s| split_depth0(&s, is_sep)),
        }
    }

    /// Tool lists: a YAML list, or a string split on commas and whitespace
    /// outside parentheses (`Bash(git add *) Bash(git commit *), Read`).
    pub fn list_field(&self, key: &str) -> Option<Vec<String>> {
        self.list(key, |c| c == ',' || c.is_whitespace())
    }

    /// Path lists: a YAML list, or a string split on commas outside braces
    /// (`src/**/*.{ts,tsx}, lib/**`).
    pub fn comma_list_field(&self, key: &str) -> Option<Vec<String>> {
        self.list(key, |c| c == ',')
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_file() {
        let fm = split("---\nname: deploy\ndescription: Deploy the application\ndisable-model-invocation: true\nallowed-tools: Bash(git add *) Bash(git commit *)\n---\nDeploy $ARGUMENTS now.\n");
        assert!(fm.present && fm.error.is_none());
        assert_eq!(fm.str_field("name").as_deref(), Some("deploy"));
        assert_eq!(fm.bool_field("disable-model-invocation"), Some(true));
        assert_eq!(fm.list_field("allowed-tools").unwrap(), vec!["Bash(git add *)", "Bash(git commit *)"]);
        assert_eq!(fm.body, "Deploy $ARGUMENTS now.\n");
    }

    #[test]
    fn no_or_misplaced_or_unclosed_frontmatter() {
        for text in ["# Title\ntext", "\n---\na: 1\n---\nx", "---\nname: x\nbody"] {
            let fm = split(text);
            assert!(!fm.present);
            assert_eq!(fm.body, text);
            assert!(fm.fields.is_empty() && fm.error.is_none());
        }
    }

    #[test]
    fn bad_yaml_keeps_the_body() {
        let fm = split("---\nname: [unclosed\n---\nbody\n");
        assert!(fm.present && fm.error.is_some() && fm.fields.is_empty());
        assert_eq!(fm.body, "body\n");
        let fm = split("---\n- a\n- b\n---\nx");
        assert!(fm.error.is_some());
    }

    #[test]
    fn lists() {
        let fm = split("---\ntools:\n  - Read\n  - Grep\nother: \"Read, Grep, Bash\"\npaths: \"src/**/*.{ts,tsx}, lib/**/*.ts\"\nyl:\n  - \"a/**\"\n---\n");
        assert_eq!(fm.list_field("tools").unwrap(), vec!["Read", "Grep"]);
        assert_eq!(fm.list_field("other").unwrap(), vec!["Read", "Grep", "Bash"]);
        assert_eq!(fm.comma_list_field("paths").unwrap(), vec!["src/**/*.{ts,tsx}", "lib/**/*.ts"]);
        assert_eq!(fm.comma_list_field("yl").unwrap(), vec!["a/**"]);
        assert_eq!(fm.list_field("missing"), None);
    }

    #[test]
    fn booleans_and_scalars() {
        let fm = split("---\na: yes\nb: On\nc: \"0\"\nd: 1\ne: false\nf: maybe\nmaxTurns: 5\n---\n");
        assert_eq!(fm.bool_field("a"), Some(true));
        assert_eq!(fm.bool_field("b"), Some(true));
        assert_eq!(fm.bool_field("c"), Some(false));
        assert_eq!(fm.bool_field("d"), Some(true));
        assert_eq!(fm.bool_field("e"), Some(false));
        assert_eq!(fm.bool_field("f"), None);
        assert_eq!(fm.str_field("maxTurns").as_deref(), Some("5"));
    }

    #[test]
    fn nested_hooks() {
        let fm = split("---\nhooks:\n  PreToolUse:\n    - matcher: \"Bash\"\n      hooks:\n        - type: command\n          command: \"./scripts/check.sh\"\n---\n");
        assert_eq!(fm.get("hooks").unwrap()["PreToolUse"][0]["matcher"], "Bash");
    }

    #[test]
    fn crlf_bom_and_empty() {
        let fm = split("---\r\nname: x\r\n---\r\nbody\r\n");
        assert_eq!(fm.str_field("name").as_deref(), Some("x"));
        assert_eq!(fm.body, "body\r\n");
        let fm = split("\u{feff}---\nname: y\n---\nb");
        assert_eq!(fm.str_field("name").as_deref(), Some("y"));
        let fm = split("---\n---\nbody");
        assert!(fm.present && fm.fields.is_empty() && fm.error.is_none());
        assert_eq!(fm.body, "body");
    }
}
