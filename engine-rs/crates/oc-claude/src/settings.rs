//! `settings.json` files and their precedence
//! (code.claude.com/docs/en/settings, "Settings precedence").
//!
//! Highest first: managed, command line (`--settings`), project local
//! (`.claude/settings.local.json`), shared project (`.claude/settings.json`),
//! user (`~/.claude/settings.json`). A scalar from a higher level wins; lists
//! such as `permissions.allow` merge across levels; objects merge per key.

use std::path::{Path, PathBuf};

use oc_permission::claude::{parse_rule, RuleKind, Rules, Source};
use serde_json::Value;

use crate::paths::ClaudeEnv;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Layer {
    User,
    Project,
    Local,
    Cli,
    Managed,
}

impl Layer {
    pub fn name(self) -> &'static str {
        match self {
            Layer::User => "user",
            Layer::Project => "project",
            Layer::Local => "local",
            Layer::Cli => "cli",
            Layer::Managed => "managed",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SettingsFile {
    pub layer: Layer,
    /// None for inline `--settings` JSON.
    pub path: Option<PathBuf>,
    pub value: Value,
    /// Where `/path` permission patterns from this file anchor.
    pub anchor: PathBuf,
}

#[derive(Debug, Clone, Default)]
pub struct Settings {
    /// Lowest precedence first.
    pub files: Vec<SettingsFile>,
    pub merged: Value,
    /// Files that exist but did not parse.
    pub errors: Vec<String>,
}

impl Settings {
    /// Read every layer. `cli` is the `--settings` value: a path to a JSON
    /// file or inline JSON.
    pub fn load(env: &ClaudeEnv, cli: Option<&str>) -> Self {
        let mut s = Settings::default();
        let project = &env.project_dir;
        s.read_file(Layer::User, &env.config_dir.join("settings.json"), &env.config_dir);
        s.read_file(Layer::Project, &project.join(".claude/settings.json"), project);
        s.read_file(Layer::Local, &project.join(".claude/settings.local.json"), project);
        if let Some(raw) = cli.map(str::trim).filter(|r| !r.is_empty()) {
            if raw.starts_with('{') {
                match serde_json::from_str::<Value>(raw) {
                    Ok(value) if value.is_object() => s.files.push(SettingsFile {
                        layer: Layer::Cli,
                        path: None,
                        value,
                        anchor: env.cwd.clone(),
                    }),
                    _ => s.errors.push("--settings: not a JSON object".into()),
                }
            } else {
                let path = crate::paths::resolve(raw, &env.cwd, &env.home);
                let anchor = path.parent().map(Path::to_path_buf).unwrap_or_else(|| env.cwd.clone());
                s.read_file(Layer::Cli, &path, &anchor);
            }
        }
        if let Some(dir) = &env.managed_dir {
            s.read_file(Layer::Managed, &dir.join("managed-settings.json"), &env.cwd);
        }
        s.merged = s.files.iter().fold(Value::Object(Default::default()), |mut acc, f| {
            merge(&mut acc, &f.value);
            acc
        });
        s
    }

    /// From explicit values (tests, embedders), lowest precedence first.
    pub fn from_values(files: Vec<SettingsFile>) -> Self {
        let merged = files.iter().fold(Value::Object(Default::default()), |mut acc, f| {
            merge(&mut acc, &f.value);
            acc
        });
        Self {
            files,
            merged,
            errors: Vec::new(),
        }
    }

    fn read_file(&mut self, layer: Layer, path: &Path, anchor: &Path) {
        let Ok(text) = std::fs::read_to_string(path) else {
            return;
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(value) if value.is_object() => self.files.push(SettingsFile {
                layer,
                path: Some(path.to_path_buf()),
                value,
                anchor: anchor.to_path_buf(),
            }),
            Ok(_) => self.errors.push(format!("{}: not a JSON object", path.display())),
            Err(e) => self.errors.push(format!("{}: {e}", path.display())),
        }
    }

    /// A merged key by dotted path (`permissions.defaultMode`).
    pub fn get(&self, dotted: &str) -> Option<&Value> {
        dotted.split('.').try_fold(&self.merged, |v, k| v.get(k))
    }

    pub fn str(&self, dotted: &str) -> Option<String> {
        self.get(dotted).and_then(Value::as_str).map(str::to_string)
    }

    pub fn bool(&self, dotted: &str) -> Option<bool> {
        self.get(dotted).and_then(Value::as_bool)
    }

    /// A merged list of strings (lists merge across layers).
    pub fn strings(&self, dotted: &str) -> Vec<String> {
        self.get(dotted)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    }

    /// `permissions.allow` / `ask` / `deny` from every file, each rule tagged
    /// with its file's anchor. With `allowManagedPermissionRulesOnly` in
    /// managed settings only managed rules count.
    pub fn permission_rules(&self) -> Rules {
        let managed_only = self
            .files
            .iter()
            .any(|f| f.layer == Layer::Managed && f.value.pointer("/allowManagedPermissionRulesOnly") == Some(&Value::Bool(true)));
        let mut rules = Rules::default();
        for f in &self.files {
            if managed_only && f.layer != Layer::Managed {
                continue;
            }
            let source = Source {
                name: f
                    .path
                    .as_ref()
                    .map(|p| format!("{} settings ({})", f.layer.name(), p.display()))
                    .unwrap_or_else(|| "--settings".into()),
                anchor: f.anchor.clone(),
            };
            for (key, kind) in [("allow", RuleKind::Allow), ("ask", RuleKind::Ask), ("deny", RuleKind::Deny)] {
                let Some(list) = f.value.pointer(&format!("/permissions/{key}")).and_then(Value::as_array) else {
                    continue;
                };
                for raw in list.iter().filter_map(Value::as_str) {
                    if let Some(rule) = parse_rule(raw, kind, source.clone()) {
                        rules.push(rule);
                    }
                }
            }
        }
        rules
    }

    /// The `env` block, highest precedence per variable.
    pub fn env(&self) -> Vec<(String, String)> {
        self.get("env")
            .and_then(Value::as_object)
            .map(|o| {
                o.iter()
                    .filter_map(|(k, v)| match v {
                        Value::String(s) => Some((k.clone(), s.clone())),
                        Value::Number(n) => Some((k.clone(), n.to_string())),
                        Value::Bool(b) => Some((k.clone(), b.to_string())),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every file's `hooks` object, lowest precedence first, with its layer.
    /// `disableAllHooks` (merged) turns off all but managed hooks; only a
    /// managed `disableAllHooks` turns off managed ones too.
    pub fn hooks(&self) -> Vec<(Layer, Value)> {
        let managed_off = self
            .files
            .iter()
            .any(|f| f.layer == Layer::Managed && f.value.get("disableAllHooks") == Some(&Value::Bool(true)));
        let all_off = self.bool("disableAllHooks") == Some(true);
        let managed_only = self
            .files
            .iter()
            .any(|f| f.layer == Layer::Managed && f.value.get("allowManagedHooksOnly") == Some(&Value::Bool(true)));
        self.files
            .iter()
            .filter(|f| match f.layer {
                Layer::Managed => !managed_off,
                _ => !all_off && !managed_only,
            })
            .filter_map(|f| f.value.get("hooks").filter(|h| h.is_object()).map(|h| (f.layer, h.clone())))
            .collect()
    }
}

/// Merge `top` (higher precedence) into `acc`: objects per key, arrays
/// concatenated without duplicates, anything else replaced.
pub fn merge(acc: &mut Value, top: &Value) {
    match (acc, top) {
        (Value::Object(a), Value::Object(t)) => {
            for (k, v) in t {
                match a.get_mut(k) {
                    Some(existing) => merge(existing, v),
                    None => {
                        a.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (Value::Array(a), Value::Array(t)) => {
            for v in t {
                if !a.contains(v) {
                    a.push(v.clone());
                }
            }
        }
        (slot, v) => *slot = v.clone(),
    }
}

/// Claude Code's documented model aliases on the Anthropic API
/// (code.claude.com/docs/en/model-config, "Model aliases").
pub fn resolve_model_alias(model: &str) -> String {
    let (base, suffix) = match model.strip_suffix("[1m]") {
        Some(b) => (b, "[1m]"),
        None => (model, ""),
    };
    let id = match base {
        "opus" => "claude-opus-5-5",
        "sonnet" => "claude-sonnet-5-5",
        "haiku" => "claude-haiku-5-5",
        "fable" | "best" => "claude-fable-5-1",
        other => other,
    };
    let _ = suffix; // the 1M window is native on these models
    id.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(layer: Layer, value: Value) -> SettingsFile {
        SettingsFile {
            layer,
            path: Some(PathBuf::from(format!("/{}.json", layer.name()))),
            value,
            anchor: PathBuf::from("/repo"),
        }
    }

    #[test]
    fn higher_layers_win_and_lists_merge() {
        let s = Settings::from_values(vec![
            file(Layer::User, json!({"model": "opus", "env": {"A": "user", "B": "user"}, "permissions": {"allow": ["Bash(ls *)"]}})),
            file(Layer::Project, json!({"model": "sonnet", "env": {"A": "project"}, "permissions": {"allow": ["Bash(npm *)", "Bash(ls *)"]}})),
            file(Layer::Local, json!({"env": {"B": "local"}, "spinnerTipsEnabled": false})),
        ]);
        assert_eq!(s.str("model").as_deref(), Some("sonnet"));
        let env: std::collections::HashMap<_, _> = s.env().into_iter().collect();
        assert_eq!(env["A"], "project");
        assert_eq!(env["B"], "local");
        assert_eq!(s.strings("permissions.allow"), vec!["Bash(ls *)", "Bash(npm *)"]);
        assert_eq!(s.bool("spinnerTipsEnabled"), Some(false));
    }

    #[test]
    fn rules_keep_their_source_anchor() {
        let mut user = file(Layer::User, json!({"permissions": {"deny": ["Read(/secrets/**)"]}}));
        user.anchor = PathBuf::from("/home/u/.claude");
        let s = Settings::from_values(vec![user, file(Layer::Project, json!({"permissions": {"ask": ["Bash(git push *)"]}}))]);
        let rules = s.permission_rules();
        assert_eq!(rules.rules.len(), 2);
        assert_eq!(rules.rules[0].source.anchor, PathBuf::from("/home/u/.claude"));
        assert_eq!(rules.rules[1].kind, RuleKind::Ask);
    }

    #[test]
    fn managed_only_rules() {
        let s = Settings::from_values(vec![
            file(Layer::Project, json!({"permissions": {"allow": ["Bash"]}})),
            file(Layer::Managed, json!({"allowManagedPermissionRulesOnly": true, "permissions": {"deny": ["WebFetch"]}})),
        ]);
        let rules = s.permission_rules();
        assert_eq!(rules.rules.len(), 1);
        assert_eq!(rules.rules[0].raw, "WebFetch");
    }

    #[test]
    fn disable_all_hooks_spares_managed() {
        let h = json!({"Stop": []});
        let s = Settings::from_values(vec![
            file(Layer::User, json!({"hooks": h, "disableAllHooks": true})),
            file(Layer::Managed, json!({"hooks": h})),
        ]);
        assert_eq!(s.hooks().len(), 1);
        assert_eq!(s.hooks()[0].0, Layer::Managed);
        let s = Settings::from_values(vec![
            file(Layer::User, json!({"hooks": h, "disableAllHooks": true})),
            file(Layer::Project, json!({"hooks": h, "disableAllHooks": false})),
        ]);
        assert_eq!(s.hooks().len(), 2, "a project false overrides a user true");
    }

    #[test]
    fn model_aliases() {
        assert_eq!(resolve_model_alias("opus"), "claude-opus-5-5");
        assert_eq!(resolve_model_alias("sonnet[1m]"), "claude-sonnet-5-5");
        assert_eq!(resolve_model_alias("claude-haiku-5-5"), "claude-haiku-5-5");
    }

    #[test]
    fn loads_files_from_disk_with_precedence() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        std::fs::write(home.join(".claude/settings.json"), r#"{"model":"opus","permissions":{"deny":["Read(./.env)"]}}"#).unwrap();
        std::fs::write(project.join(".claude/settings.json"), r#"{"model":"sonnet"}"#).unwrap();
        std::fs::write(project.join(".claude/settings.local.json"), "{ not json").unwrap();
        let env = ClaudeEnv::new(&project, &home, &home.join(".claude"), &home.join(".claude.json"), None);
        let s = Settings::load(&env, Some(r#"{"model":"haiku"}"#));
        assert_eq!(s.str("model").as_deref(), Some("haiku"));
        assert_eq!(s.errors.len(), 1);
        assert_eq!(s.permission_rules().rules.len(), 1);
    }
}
