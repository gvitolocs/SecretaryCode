//! oc-schema: port of `packages/schema/src` (subset) from the OpenCode
//! fork (anomalyco/opencode @ v2.1.4, cloned at 68bc26b). Shapes follow the
//! upstream Effect Schema definitions; JSON keys keep upstream camelCase
//! (`projectID`, `parentID`, …) so the port is wire-compatible with the v2
//! HTTP API.

pub mod identifier;

use serde::{Deserialize, Serialize};

/// `SessionID` — `ses_` + descending sortable suffix.
pub mod session_id {
    use super::identifier;

    pub fn create() -> String {
        format!("ses_{}", identifier::descending())
    }

    pub fn validate(id: &str) -> Result<(), identifier::InvalidId> {
        if let Some(rest) = id.strip_prefix("ses_") {
            identifier::validate(rest)
        } else {
            Err(identifier::InvalidId(id.to_string()))
        }
    }
}

/// `Session.Message.ID` — `msg_` + ascending sortable suffix.
pub mod message_id {
    use super::identifier;

    pub fn create() -> String {
        format!("msg_{}", identifier::ascending())
    }

    pub fn validate(id: &str) -> Result<(), identifier::InvalidId> {
        if let Some(rest) = id.strip_prefix("msg_") {
            identifier::validate(rest)
        } else {
            Err(identifier::InvalidId(id.to_string()))
        }
    }
}

/// `TokenUsage.Info` — upstream `total()` ported verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: f64,
    pub output: f64,
    pub reasoning: f64,
    pub cache: CacheUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CacheUsage {
    pub read: f64,
    pub write: f64,
}

impl TokenUsage {
    pub fn total(&self) -> f64 {
        self.input + self.output + self.reasoning + self.cache.read + self.cache.write
    }
}

impl Default for TokenUsage {
    fn default() -> Self {
        Self {
            input: 0.0,
            output: 0.0,
            reasoning: 0.0,
            cache: CacheUsage { read: 0.0, write: 0.0 },
        }
    }
}

/// `Model.Ref` — `providerID/modelID[/variant]` string parse ported.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelRef {
    pub id: String,
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("invalid model reference: {0}")]
pub struct InvalidModelRef(pub String);

impl ModelRef {
    /// Port of `Model.Ref.parse("provider/model")`.
    pub fn parse(input: &str) -> Result<Self, InvalidModelRef> {
        let provider_end = input.find('/').ok_or_else(|| InvalidModelRef(input.into()))?;
        if provider_end == 0 {
            return Err(InvalidModelRef(input.into()));
        }
        let rest = &input[provider_end + 1..];
        if rest.is_empty() {
            return Err(InvalidModelRef(input.into()));
        }
        let (id, variant) = match rest.split_once('@') {
            Some((id, v)) if !v.is_empty() => (id, Some(v.to_string())),
            _ => (rest, None),
        };
        Ok(Self {
            id: id.to_string(),
            provider_id: input[..provider_end].to_string(),
            variant,
        })
    }
}

/// `Location.Ref` — `{directory, workspaceID?}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocationRef {
    pub directory: String,
    #[serde(rename = "workspaceID", default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// `Session.Info` — ported field-for-field from `schema/src/session.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    #[serde(rename = "parentID", default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(rename = "projectID")]
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    /// `Money.USD` upstream is a dollars float.
    pub cost: f64,
    pub tokens: TokenUsage,
    /// Outcome of the last completed execution, recorded at `time.idle`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    pub time: SessionTime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub location: LocationRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subpath: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Succeeded,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SessionTime {
    pub created: u64,
    pub updated: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<u64>,
}

/// Session list query filters — port of `session.list` HTTP parameters
/// (`ListFilterFields`): `order`, `search`, `parentID`, `archived`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionListFilter {
    pub order: Option<Order>,
    pub search: Option<String>,
    pub parent_id: Option<Option<String>>,
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    Asc,
    Desc,
}

/// `Session.Message` union (subset port) — tagged by `"type"` like upstream
/// `Schema.tag`. Covers the upstream union: user / assistant / synthetic /
/// system / agent-switched / model-switched / idle (shell, skill,
/// location-switched and compaction variants are declared upstream but not
/// yet produced by the port).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Message {
    #[serde(rename = "user")]
    User(UserMessage),
    #[serde(rename = "assistant")]
    Assistant(AssistantMessage),
    #[serde(rename = "synthetic")]
    Synthetic(SyntheticMessage),
    #[serde(rename = "system")]
    System(SystemMessage),
    #[serde(rename = "agent-switched")]
    AgentSwitched(AgentSwitched),
    #[serde(rename = "model-switched")]
    ModelSwitched(ModelSwitched),
    #[serde(rename = "idle")]
    Idle(IdleMessage),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageBase {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    pub time: MessageTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MessageTime {
    pub created: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UserMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyntheticMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSwitched {
    #[serde(flatten)]
    pub base: MessageBase,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelSwitched {
    #[serde(flatten)]
    pub base: MessageBase,
    pub model: ModelRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<ModelRef>,
}

/// `Session.Message.System` — a model-facing update, frozen at emit time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    /// The model-facing update text, frozen at emit time.
    pub text: String,
    /// A short human-readable summary for transcript display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// `Session.Message.Idle` — marks the session going idle; every step since
/// the previous marker belongs to one turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IdleMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SessionErrorValue>,
}

/// `Session.Error` — upstream is a tagged error record; the port keeps the
/// two fields every producer writes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionErrorValue {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(flatten, default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// `Tool.Content` union (schema/src/tool.ts) — text and file parts a tool
/// result carries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ToolContent {
    Text { text: String },
    File { mime: String, url: String },
}

/// `Session.Message.AssistantContent` union — text / reasoning / tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AssistantContent {
    Text(AssistantText),
    Reasoning(AssistantReasoning),
    Tool(AssistantTool),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantText {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantReasoning {
    pub text: String,
}

/// `Session.Message.Assistant.Tool` — one provider tool call and its state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantTool {
    /// The provider call id (`call_…` / `toolu_…`).
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executed: Option<bool>,
    /// Provider-owned replay data echoed back verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native: Option<serde_json::Value>,
    pub state: ToolState,
    pub time: AssistantToolTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AssistantToolTime {
    pub created: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ran: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
}

/// `Session.Message.ToolState` union — tagged by `"status"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ToolState {
    #[serde(rename = "running")]
    Running {
        input: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<serde_json::Value>,
    },
    #[serde(rename = "completed")]
    Completed {
        input: serde_json::Value,
        content: Vec<ToolContent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<serde_json::Value>,
    },
    #[serde(rename = "error")]
    Error {
        input: serde_json::Value,
        error: SessionErrorValue,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<ToolContent>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata: Option<serde_json::Value>,
    },
}

/// `LLM.FinishReason` (schema/src/llm.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinishReason {
    Stop,
    Length,
    #[serde(rename = "tool-calls")]
    ToolCalls,
    #[serde(rename = "content-filter")]
    ContentFilter,
    Error,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssistantMessage {
    #[serde(flatten)]
    pub base: MessageBase,
    pub agent: String,
    pub model: ModelRef,
    pub content: Vec<AssistantContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish: Option<FinishReason>,
    /// The provider's own finish string, when it names something the union
    /// above does not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_finish: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SessionErrorValue>,
    pub time: AssistantTime,
}

/// A provider-neutral tool definition — port of `@opencode/ai`
/// `ToolDefinition` (`ai/src/tool.ts`): what goes on the wire as a
/// `tools` entry, whichever protocol speaks it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema object for the input.
    pub parameters: serde_json::Value,
}

// ===== Provider-neutral LLM response types (oc-provider's contract) =====

/// Token usage as the providers report it; cache split kept apart.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct LlmUsage {
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub reasoning: f64,
    #[serde(default)]
    pub cache_read: f64,
    #[serde(default)]
    pub cache_write: f64,
}

/// One tool call the model asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmToolCall {
    /// Provider call id, echoed back in the tool result.
    pub id: String,
    pub name: String,
    /// The arguments as the provider sent them: a JSON-encoded object string.
    pub arguments: String,
}

/// One completed (non-streaming) provider response, protocol-agnostic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmResponse {
    /// The assistant text, when the model wrote any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<LlmToolCall>,
    pub finish: FinishReason,
    /// The provider's raw finish string when it is outside the union.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_finish: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<LlmUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AssistantTime {
    pub created: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "streamed"
    )]
    pub streamed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_info_roundtrips_upstream_shape() {
        // Field names must match the upstream encoded output exactly.
        let json = r#"{
            "id": "ses_0123456789abcdef0123456789",
            "projectID": "global",
            "cost": 0,
            "tokens": {"input": 10, "output": 5, "reasoning": 0, "cache": {"read": 0, "write": 0}},
            "outcome": "succeeded",
            "time": {"created": 1000, "updated": 1000},
            "title": "fix the build",
            "location": {"directory": "/tmp/repo"}
        }"#;
        let s: SessionInfo = serde_json::from_str(json).unwrap();
        assert_eq!(s.title.as_deref(), Some("fix the build"));
        assert_eq!(s.outcome, Some(Outcome::Succeeded));
        let back = serde_json::to_string(&s).unwrap();
        assert!(back.contains("\"projectID\""));
        assert!(!back.contains("project_id"));
    }

    #[test]
    fn model_ref_parse_port() {
        let r = ModelRef::parse("anthropic/claude-sonnet-4").unwrap();
        assert_eq!(r.provider_id, "anthropic");
        assert_eq!(r.id, "claude-sonnet-4");
        assert!(r.variant.is_none());
        let v = ModelRef::parse("openai/gpt-5@thinking").unwrap();
        assert_eq!(v.variant.as_deref(), Some("thinking"));
        assert!(ModelRef::parse("noprovider").is_err());
        assert!(ModelRef::parse("/model").is_err());
    }

    #[test]
    fn token_usage_total_port() {
        let t = TokenUsage {
            input: 1.0,
            output: 2.0,
            reasoning: 3.0,
            cache: CacheUsage { read: 4.0, write: 5.0 },
        };
        assert_eq!(t.total(), 15.0);
    }

    #[test]
    fn message_tags_match_upstream() {
        let m = Message::Synthetic(SyntheticMessage {
            base: MessageBase {
                id: message_id::create(),
                metadata: None,
                time: MessageTime { created: 1 },
            },
            text: "hello".into(),
            description: None,
        });
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["type"], "synthetic");

        let switched = Message::AgentSwitched(AgentSwitched {
            base: MessageBase {
                id: message_id::create(),
                metadata: None,
                time: MessageTime { created: 1 },
            },
            agent: "plan".into(),
            previous: Some("build".into()),
        });
        let json = serde_json::to_value(&switched).unwrap();
        assert_eq!(json["type"], "agent-switched");
        assert_eq!(json["previous"], "build");
    }

    #[test]
    fn assistant_wire_shape() {
        // serialized through the Message enum, as production always does —
        // the "type" tag lives on the enum
        let a = Message::Assistant(AssistantMessage {
            base: MessageBase {
                id: message_id::create(),
                metadata: None,
                time: MessageTime { created: 1 },
            },
            agent: "build".into(),
            model: ModelRef::parse("x/y").unwrap(),
            content: vec![
                AssistantContent::Text(AssistantText { text: "ok".into() }),
                AssistantContent::Tool(AssistantTool {
                    id: "call_1".into(),
                    name: "bash".into(),
                    executed: Some(true),
                    native: None,
                    state: ToolState::Completed {
                        input: serde_json::json!({"command": "ls"}),
                        content: vec![ToolContent::Text { text: "out".into() }],
                        metadata: None,
                    },
                    time: AssistantToolTime { created: 1, ran: Some(2), completed: Some(3) },
                }),
            ],
            finish: Some(FinishReason::ToolCalls),
            raw_finish: None,
            cost: Some(0.5),
            tokens: None,
            error: None,
            time: AssistantTime { created: 1, streamed: None, completed: Some(9) },
        });
        let json = serde_json::to_value(&a).unwrap();
        assert_eq!(json["type"], "assistant");
        assert_eq!(json["content"][0]["type"], "text");
        assert_eq!(json["content"][1]["type"], "tool");
        assert_eq!(json["content"][1]["state"]["status"], "completed");
        assert_eq!(json["content"][1]["state"]["content"][0]["type"], "text");
        assert_eq!(json["time"]["completed"], 9);
    }

    #[test]
    fn idle_and_system_wire_shapes() {
        let idle = Message::Idle(IdleMessage {
            base: MessageBase { id: message_id::create(), metadata: None, time: MessageTime { created: 5 } },
            outcome: Outcome::Succeeded,
            error: None,
        });
        let json = serde_json::to_value(&idle).unwrap();
        assert_eq!(json["type"], "idle");
        assert_eq!(json["outcome"], "succeeded");
        let sys = Message::System(SystemMessage {
            base: MessageBase { id: message_id::create(), metadata: None, time: MessageTime { created: 6 } },
            text: "compacted".into(),
            description: Some("context compacted".into()),
        });
        let json = serde_json::to_value(&sys).unwrap();
        assert_eq!(json["type"], "system");
        assert_eq!(json["description"], "context compacted");
    }

    #[test]
    fn id_prefixes_validate() {
        let s = session_id::create();
        let m = message_id::create();
        assert!(s.starts_with("ses_"));
        assert!(m.starts_with("msg_"));
        assert!(session_id::validate(&s).is_ok());
        assert!(message_id::validate(&m).is_ok());
        assert!(session_id::validate(&m).is_err());
        // sessions are descending-keyed: among ses_ IDs, newest sorts first
        let older = format!("ses_{}", identifier::create(true, 1000));
        assert!(s < older);
        assert!(session_id::validate(&older).is_ok());
    }
}
