//! oc-permission: port of `packages/schema/src/permission.ts` — the
//! `Ruleset` of `{action, resource, effect}` rules with wildcard resources,
//! plus `util/wildcard.ts`'s matcher. Upstream: "Evaluated after the agent's
//! rules; the last matching rule wins."

pub mod claude_bash;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// `Permission.Effect`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    Allow,
    Deny,
    Ask,
}

/// `Permission.Rule`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    pub action: String,
    pub resource: String,
    pub effect: Effect,
}

/// `Permission.Ruleset` — ordered; the LAST matching rule decides. On the
/// wire it is the upstream array of rules (not a `{rules: [...]}` object).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Ruleset {
    pub rules: Vec<Rule>,
}

impl Serialize for Ruleset {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.rules.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Ruleset {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<Rule>::deserialize(deserializer).map(|rules| Self { rules })
    }
}

impl Ruleset {
    /// The effect for `action` + `resource`: the last matching rule wins;
    /// no match asks, matching upstream `Permission.evaluate`'s fallback.
    pub fn decide(&self, action: &str, resource: &str) -> Effect {
        let mut effect = Effect::Ask;
        for rule in &self.rules {
            if wildcard_match(action, &rule.action)
                && (rule.resource == "*" || wildcard_match(resource, &rule.resource))
            {
                effect = rule.effect;
            }
        }
        effect
    }
}

/// Port of `util/wildcard.ts` `match`: backslashes normalize to `/`, regex
/// specials escape, `*` → `.*`, `?` → `.`, and a trailing `" *"` becomes
/// `"( .*)?"` so `"src"` also matches `"src sub/dir"` style resources.
pub fn wildcard_match(input: &str, pattern: &str) -> bool {
    let normalized = input.replace('\\', "/");
    let mut escaped = pattern.replace('\\', "/");
    escaped = regex::escape(&escaped)
        .replace(r"\*", ".*")
        .replace(r"\?", ".");
    if escaped.ends_with(" .*") {
        let cut = escaped.len() - 3;
        escaped = format!("{}( .*)?", &escaped[..cut]);
    }
    regex::Regex::new(&format!("^{escaped}$"))
        .map(|re| re.is_match(&normalized))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_matches_like_upstream() {
        assert!(wildcard_match("src/main.rs", "*.rs"));
        assert!(wildcard_match("src/main.rs", "src/*"));
        assert!(!wildcard_match("/repo/src", "/repo"));
        assert!(!wildcard_match("/repo/src/deep", "/repo"));
        assert!(!wildcard_match("other/main.rs", "src/*"));
        assert!(wildcard_match("a/b/c", "a/*")); // `*` spans `/` like upstream
        assert!(!wildcard_match("file.txt ", "file.txt"));
    }

    #[test]
    fn action_wildcards_match() {
        let rs = Ruleset {
            rules: vec![Rule {
                action: "*".into(),
                resource: "*".into(),
                effect: Effect::Ask,
            }],
        };
        assert_eq!(rs.decide("shell", "ls"), Effect::Ask);
        assert_eq!(rs.decide("question", "ok?"), Effect::Ask);
    }

    #[test]
    fn last_matching_rule_wins() {
        let rs = Ruleset {
            rules: vec![
                Rule {
                    action: "bash".into(),
                    resource: "*".into(),
                    effect: Effect::Deny,
                },
                Rule {
                    action: "bash".into(),
                    resource: "git *".into(),
                    effect: Effect::Allow,
                },
            ],
        };
        assert_eq!(rs.decide("bash", "git status"), Effect::Allow);
        assert_eq!(rs.decide("bash", "rm -rf /"), Effect::Deny);
        assert_eq!(rs.decide("read", "anything"), Effect::Ask); // no rule → ask
    }

    #[test]
    fn ask_effect_and_ruleset_json() {
        let rs: Ruleset =
            serde_json::from_str(r#"[{"action":"webfetch","resource":"*","effect":"ask"}]"#)
                .unwrap();
        assert_eq!(rs.decide("webfetch", "https://x"), Effect::Ask);
    }
}
