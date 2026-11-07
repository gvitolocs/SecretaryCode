//! Shell analysis for Claude Code `Bash(...)` permission rules: compound
//! commands, wrappers, read-only commands, rule patterns.
//!
//! From code.claude.com/docs/en/permissions ("Compound commands",
//! "Wrappers", "Read-only commands", "Wildcard patterns"). This is a
//! best-effort reading of the command text, as Claude Code's own is: a
//! rule is not a security boundary around a program.

/// One simple command after splitting a compound command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimpleCommand {
    /// The command as written in the line, trimmed.
    pub raw: String,
    /// The command after wrapper and assignment stripping, trimmed.
    pub text: String,
    /// True when it came from inside `$( … )` or backticks.
    pub nested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Analysis {
    pub commands: Vec<SimpleCommand>,
    /// False for an unterminated quote, unbalanced `$(`/`(`/backtick, or an
    /// operator with nothing after it (`npm test &&`).
    pub parsed: bool,
    /// The line has `$(`, a backtick, or a `$NAME` / `${NAME}` expansion
    /// outside single quotes.
    pub dynamic: bool,
}

/// Leading assignments an allow rule may look past.
const SAFE_ASSIGNMENTS: &[&str] = &[
    "LANG", "LANGUAGE", "LC_ALL", "NO_COLOR", "FORCE_COLOR", "TERM", "TZ", "CI", "NODE_ENV", "RUST_BACKTRACE",
    "RUST_LOG", "PYTHONUNBUFFERED",
];

/// Split a command line into its simple commands (nested ones last).
pub fn analyze(line: &str, strip_all_assignments: bool) -> Analysis {
    let mut a = Analysis { commands: Vec::new(), parsed: true, dynamic: false };
    let mut nested_sources: Vec<String> = Vec::new();
    split_into(line, strip_all_assignments, false, &mut a, &mut nested_sources);
    let mut i = 0;
    while i < nested_sources.len() {
        let src = nested_sources[i].clone();
        let mut more = Vec::new();
        split_into(&src, strip_all_assignments, true, &mut a, &mut more);
        nested_sources.extend(more);
        i += 1;
    }
    a
}

/// One pass over `line`: segments at top-level operators go to `a`,
/// `$( … )` and backtick bodies go to `nested`.
fn split_into(line: &str, strip_all: bool, nested: bool, a: &mut Analysis, inner: &mut Vec<String>) {
    let chars: Vec<char> = line.chars().collect();
    let mut segments: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut i = 0;
    let mut dangling = false; // an operator that needs a right-hand side
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                cur.push(c);
                if let Some(&n) = chars.get(i + 1) {
                    cur.push(n);
                }
                i += 2;
                continue;
            }
            '\'' => {
                let Some(end) = chars[i + 1..].iter().position(|&x| x == '\'') else {
                    a.parsed = false;
                    cur.extend(&chars[i..]);
                    break;
                };
                cur.extend(&chars[i..=i + 1 + end]);
                i += end + 2;
                continue;
            }
            '"' => {
                let mut j = i + 1;
                let mut closed = false;
                while j < chars.len() {
                    match chars[j] {
                        '\\' => j += 2,
                        '"' => {
                            closed = true;
                            break;
                        }
                        '$' if chars.get(j + 1) == Some(&'(') => {
                            a.dynamic = true;
                            match matching_paren(&chars, j + 1) {
                                Some(end) => {
                                    inner.push(chars[j + 2..end].iter().collect());
                                    j = end + 1;
                                }
                                None => {
                                    a.parsed = false;
                                    j = chars.len();
                                }
                            }
                        }
                        '`' => {
                            a.dynamic = true;
                            match chars[j + 1..].iter().position(|&x| x == '`') {
                                Some(end) => {
                                    inner.push(chars[j + 1..j + 1 + end].iter().collect());
                                    j += end + 2;
                                }
                                None => {
                                    a.parsed = false;
                                    j = chars.len();
                                }
                            }
                        }
                        '$' if chars.get(j + 1).is_some_and(|n| n.is_alphabetic() || *n == '_' || *n == '{') => {
                            a.dynamic = true;
                            j += 1;
                        }
                        _ => j += 1,
                    }
                }
                if !closed {
                    a.parsed = false;
                    cur.extend(&chars[i..]);
                    break;
                }
                cur.extend(&chars[i..=j]);
                i = j + 1;
                continue;
            }
            '$' if chars.get(i + 1) == Some(&'(') => {
                a.dynamic = true;
                match matching_paren(&chars, i + 1) {
                    Some(end) => {
                        inner.push(chars[i + 2..end].iter().collect());
                        cur.extend(&chars[i..=end]);
                        i = end + 1;
                    }
                    None => {
                        a.parsed = false;
                        cur.extend(&chars[i..]);
                        break;
                    }
                }
                continue;
            }
            '$' if chars.get(i + 1).is_some_and(|n| n.is_alphabetic() || *n == '_' || *n == '{') => {
                a.dynamic = true;
            }
            '`' => {
                a.dynamic = true;
                match chars[i + 1..].iter().position(|&x| x == '`') {
                    Some(end) => {
                        inner.push(chars[i + 1..i + 1 + end].iter().collect());
                        cur.extend(&chars[i..=i + 1 + end]);
                        i += end + 2;
                    }
                    None => {
                        a.parsed = false;
                        cur.extend(&chars[i..]);
                        break;
                    }
                }
                continue;
            }
            '(' if cur.trim().is_empty() => {
                // a subshell: its body is analyzed as commands of this line
                match matching_paren(&chars, i) {
                    Some(end) => {
                        let body: String = chars[i + 1..end].iter().collect();
                        split_into(&body, strip_all, nested, a, inner);
                        cur.clear();
                        i = end + 1;
                    }
                    None => {
                        a.parsed = false;
                        i = chars.len();
                    }
                }
                continue;
            }
            ';' | '\n' => {
                segments.push(std::mem::take(&mut cur));
                dangling = false;
                i += 1;
                continue;
            }
            '&' => {
                let prev = cur.chars().last();
                if prev == Some('>') || prev == Some('<') || chars.get(i + 1) == Some(&'>') {
                    cur.push(c); // `2>&1`, `>&2`, `&>file`
                    i += 1;
                    continue;
                }
                segments.push(std::mem::take(&mut cur));
                if chars.get(i + 1) == Some(&'&') {
                    dangling = true;
                    i += 2;
                } else {
                    dangling = false; // background `&`
                    i += 1;
                }
                continue;
            }
            '|' => {
                if cur.ends_with('>') {
                    cur.push(c); // `>|` noclobber override
                    i += 1;
                    continue;
                }
                segments.push(std::mem::take(&mut cur));
                dangling = true;
                i += if matches!(chars.get(i + 1), Some('|') | Some('&')) { 2 } else { 1 };
                continue;
            }
            _ => {}
        }
        if !c.is_whitespace() {
            dangling = false;
        }
        cur.push(c);
        i += 1;
    }
    if dangling && cur.trim().is_empty() {
        a.parsed = false;
    }
    segments.push(cur);
    for seg in segments {
        let mut seg = seg.trim().to_string();
        // `{ a; b; }` groups: drop the braces; the `;` split already ran.
        if let Some(rest) = seg.strip_prefix("{ ") {
            seg = rest.trim().to_string();
        }
        loop {
            let first = seg.split_whitespace().next().unwrap_or("");
            if matches!(first, "if" | "then" | "else" | "elif" | "do" | "while" | "until" | "!") {
                seg = seg[first.len()..].trim_start().to_string();
            } else {
                break;
            }
        }
        let first = seg.split_whitespace().next().unwrap_or("");
        if seg.is_empty() || matches!(seg.as_str(), "fi" | "done" | "esac" | "}") || first == "for" {
            continue;
        }
        a.commands.push(SimpleCommand { text: strip_wrappers(&seg, strip_all), raw: seg, nested });
    }
}

/// Index of the `)` closing the `(` at `open`, quotes respected.
fn matching_paren(chars: &[char], open: usize) -> Option<usize> {
    let mut depth = 0;
    let mut i = open;
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 1,
            '\'' => i += chars[i + 1..].iter().position(|&x| x == '\'')? + 1,
            '"' => {
                let mut j = i + 1;
                while j < chars.len() && chars[j] != '"' {
                    if chars[j] == '\\' {
                        j += 1;
                    }
                    j += 1;
                }
                if j >= chars.len() {
                    return None;
                }
                i = j;
            }
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Words split on whitespace outside quotes, keeping quotes in the words.
fn words(cmd: &str) -> Vec<(usize, usize)> {
    let b = cmd.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i] as char).is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let start = i;
        let mut quote: Option<u8> = None;
        while i < b.len() {
            let c = b[i];
            match quote {
                Some(q) if c == q => quote = None,
                Some(b'"') if c == b'\\' => i += 1,
                Some(_) => {}
                None if c == b'\'' || c == b'"' => quote = Some(c),
                None if c == b'\\' => i += 1,
                None if (c as char).is_ascii_whitespace() => break,
                None => {}
            }
            i += 1;
        }
        out.push((start, i.min(b.len())));
    }
    out
}

fn assignment_name(word: &str) -> Option<&str> {
    let (name, _) = word.split_once('=')?;
    let ok = !name.is_empty()
        && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    ok.then_some(name)
}

/// Strip wrappers and leading assignments from one simple command.
pub fn strip_wrappers(cmd: &str, strip_all_assignments: bool) -> String {
    let mut s = cmd.trim().to_string();
    loop {
        let ws = words(&s);
        let Some(&(w0s, w0e)) = ws.first() else {
            return s;
        };
        let w0 = &s[w0s..w0e];
        let word = |n: usize| ws.get(n).map(|&(a, b)| &s[a..b]);
        let rest_from = |n: usize| ws.get(n).map(|&(a, _)| s[a..].to_string()).unwrap_or_default();
        let next = if let Some(name) = assignment_name(w0) {
            let safe = SAFE_ASSIGNMENTS.contains(&name) || name.starts_with("LC_");
            if !(strip_all_assignments || safe) {
                return s;
            }
            rest_from(1)
        } else {
            match w0 {
                "time" => {
                    let n = if word(1) == Some("-p") { 2 } else { 1 };
                    rest_from(n)
                }
                "nohup" | "builtin" | "noglob" => rest_from(1),
                "command" => match word(1) {
                    Some("-v") | Some("-V") => return s,
                    _ => rest_from(1),
                },
                "xargs" => match word(1) {
                    Some(w) if !w.starts_with('-') => rest_from(1),
                    _ => return s,
                },
                "timeout" => {
                    let mut n = 1;
                    while let Some(w) = word(n) {
                        if matches!(w, "-s" | "-k" | "--signal" | "--kill-after") {
                            n += 2;
                        } else if w.starts_with('-') {
                            n += 1;
                        } else {
                            break;
                        }
                    }
                    if word(n).is_none() {
                        return s;
                    }
                    rest_from(n + 1) // the duration
                }
                "nice" => {
                    let mut n = 1;
                    while let Some(w) = word(n) {
                        if w == "-n" {
                            n += 2;
                        } else if w.starts_with("--adjustment") || (w.starts_with('-') && w[1..].parse::<i32>().is_ok()) {
                            n += 1;
                        } else {
                            break;
                        }
                    }
                    rest_from(n)
                }
                "stdbuf" => {
                    let mut n = 1;
                    while let Some(w) = word(n) {
                        if matches!(w, "-i" | "-o" | "-e") {
                            n += 2;
                        } else if w.starts_with('-') {
                            n += 1;
                        } else {
                            break;
                        }
                    }
                    rest_from(n)
                }
                _ => return s,
            }
        };
        let next = next.trim().to_string();
        if next == s || next.is_empty() {
            return s;
        }
        s = next;
    }
}

/// Does a Claude Code Bash rule pattern match one simple command?
/// `*` is any text (spaces too); a trailing ` *` that is the only wildcard
/// also matches the bare command; a final `:*` equals ` *`.
pub fn pattern_matches(pattern: &str, command: &str) -> bool {
    let pattern = pattern.trim();
    let command = command.trim();
    let pattern = match pattern.strip_suffix(":*") {
        Some(base) => format!("{base} *"),
        None => pattern.to_string(),
    };
    if !pattern.contains('*') {
        return pattern == command;
    }
    if pattern.matches('*').count() == 1 {
        if let Some(base) = pattern.strip_suffix(" *") {
            if command == base {
                return true;
            }
        }
    }
    let re = format!("^{}$", regex::escape(&pattern).replace(r"\*", "(?s:.*)"));
    regex::Regex::new(&re).is_ok_and(|re| re.is_match(command))
}

fn unquoted_glob(word: &str) -> bool {
    !(word.starts_with('\'') || word.starts_with('"')) && word.contains(['*', '?', '['])
}

/// Is one simple command in Claude Code's built-in read-only set?
pub fn is_read_only(command: &str) -> bool {
    let ws: Vec<&str> = words(command).iter().map(|&(a, b)| &command[a..b]).collect();
    let Some(&program) = ws.first() else {
        return false;
    };
    // Output redirections and tee write files.
    for (i, w) in ws.iter().enumerate() {
        let target_ok = |t: Option<&&str>| t.is_some_and(|t| *t == "/dev/null");
        if w.contains("2>&1") || *w == ">&2" || *w == "1>&2" {
            continue;
        }
        if let Some(pos) = w.find('>') {
            let after = &w[pos..].trim_start_matches(['>', '&', '|']);
            let target = if after.is_empty() { ws.get(i + 1) } else { Some(after) };
            if !target_ok(target) {
                return false;
            }
        }
        if *w == "tee" {
            return false;
        }
    }
    match program {
        "ls" | "cat" | "echo" | "pwd" | "head" | "tail" | "grep" | "wc" | "which" | "diff" | "stat" | "du" | "cd" => true,
        "find" => !ws[1..].iter().any(|w| {
            matches!(*w, "-exec" | "-execdir" | "-ok" | "-okdir" | "-delete" | "-fprint" | "-fprint0" | "-fprintf" | "-fls" | "-files0-from")
                || unquoted_glob(w)
        }),
        "git" => {
            let Some(&sub) = ws.get(1) else {
                return false;
            };
            if sub.starts_with('-') || ws[2..].iter().any(|w| unquoted_glob(w)) {
                return false;
            }
            let args = &ws[2..];
            match sub {
                "status" | "log" | "diff" | "show" | "rev-parse" | "ls-files" | "blame" | "describe" => true,
                "remote" => args.is_empty() || args == ["-v"],
                "branch" => args.iter().all(|a| matches!(*a, "-a" | "-r" | "-v" | "-vv" | "--list" | "--show-current")),
                _ => false,
            }
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(a: &Analysis) -> Vec<&str> {
        a.commands.iter().map(|c| c.text.as_str()).collect()
    }

    #[test]
    fn pattern_table() {
        let rows: &[(&str, &[&str], &[&str])] = &[
            ("npm run build", &["npm run build"], &["npm run build --watch"]),
            ("npm run *", &["npm run build", "npm run test --watch", "npm run"], &["npm install"]),
            ("git log * main", &["git log --oneline main", "git log -5 main"], &["git log main", "git push origin main"]),
            ("git * main", &["git merge main", "git push origin main"], &["git log"]),
            ("* --version", &["node --version"], &["node -v"]),
            ("ls *", &["ls -la", "ls"], &["lsof"]),
            ("ls*", &["ls -la", "lsof"], &[]),
            ("* --help *", &["npm --help x"], &["npm --help"]),
            ("ls:*", &["ls", "ls -la"], &["lsof"]),
            ("git:* push", &["git:x push"], &["git push"]),
        ];
        for (pattern, yes, no) in rows {
            for c in *yes {
                assert!(pattern_matches(pattern, c), "{pattern} should match {c}");
            }
            for c in *no {
                assert!(!pattern_matches(pattern, c), "{pattern} should not match {c}");
            }
        }
    }

    #[test]
    fn splitting() {
        let a = analyze("git status && npm test", true);
        assert_eq!(texts(&a), ["git status", "npm test"]);
        assert!(a.parsed && !a.dynamic);
        assert!(texts(&analyze("cd /tmp && git clean -f", true)).contains(&"git clean -f"));
        let a = analyze("echo \"$(git clean -f)\"", true);
        assert!(a.dynamic);
        assert!(a.commands.iter().any(|c| c.nested && c.text == "git clean -f"));
        let a = analyze("echo `rm -rf x`", true);
        assert!(a.commands.iter().any(|c| c.nested && c.text == "rm -rf x"));
        assert!(texts(&analyze("for f in *.tmp; do rm $f; done", true)).contains(&"rm $f"));
        assert!(!analyze("npm test &&", true).parsed);
        assert!(!analyze("echo 'unterminated", true).parsed);
        assert_eq!(texts(&analyze("make 2>&1 | tee build.log", true)), ["make 2>&1", "tee build.log"]);
        assert_eq!(analyze("echo 'a && b'", true).commands.len(), 1);
        assert_eq!(texts(&analyze("a; b || c | d |& e & f\ng", true)), ["a", "b", "c", "d", "e", "f", "g"]);
        assert_eq!(texts(&analyze("(cd x && rm y)", true)), ["cd x", "rm y"]);
        assert_eq!(texts(&analyze("echo $(echo $(rm -rf z))", true)).last(), Some(&"rm -rf z"));
        assert_eq!(texts(&analyze("if true; then rm a; fi", true)), ["true", "rm a"]);
    }

    #[test]
    fn wrappers() {
        assert_eq!(strip_wrappers("timeout 30 npm test", false), "npm test");
        assert_eq!(strip_wrappers("FOO=bar rm -rf tmp/", true), "rm -rf tmp/");
        assert_eq!(strip_wrappers("FOO=bar rm -rf tmp/", false), "FOO=bar rm -rf tmp/");
        assert_eq!(strip_wrappers("NODE_ENV=test npm test", false), "npm test");
        assert_eq!(strip_wrappers("nice -n 5 nohup npm test", false), "npm test");
        assert_eq!(strip_wrappers("xargs grep pattern", false), "grep pattern");
        assert_eq!(strip_wrappers("xargs -n1 grep pattern", false), "xargs -n1 grep pattern");
        assert_eq!(strip_wrappers("command -v git", false), "command -v git");
        assert_eq!(strip_wrappers("stdbuf -oL make", false), "make");
        assert_eq!(strip_wrappers("timeout -s KILL 5 make", false), "make");
        assert_eq!(strip_wrappers("LC_ALL=C time -p sort x", false), "sort x");
        assert_eq!(strip_wrappers("watch ls", true), "watch ls");
        assert_eq!(strip_wrappers("A='x y' B=\"z\" env", true), "env");
    }

    #[test]
    fn read_only_set() {
        for c in ["ls -la", "git status", "git log --oneline", "git branch", "cat README.md", "grep -r foo .", "ls 2>/dev/null", "ls 2>&1"] {
            assert!(is_read_only(c), "{c}");
        }
        for c in ["git push", "git -C x status", "find . -delete", "find . -name *.rs", "ls > out.txt", "rm x", "git branch -D x", "cat a >> b"] {
            assert!(!is_read_only(c), "{c}");
        }
        assert!(is_read_only("find . -name '*.rs'"));
    }
}
