//! oc-agent: port of the session runner (`packages/core/src/session/runner/`)
//! — the step loop, tool settlement, the MAX_STEPS gate, and the transcript
//! mapping (`to-llm-message.ts`, subset: no file attachments, no hosted
//! tools, no provider-metadata replay).

pub mod task;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::RwLock;

use oc_provider::{ChatMessage, ChatRequest, Client, ToolChoice};
use oc_schema::{
    AssistantContent, AssistantTool, AssistantToolTime, LlmResponse,
    Message, ModelRef, Outcome, ToolContent, ToolState,
};
use oc_store::{assistant_message, idle_message, session_error, user_message, Store};
use oc_tools::{Registry, ToolContext};

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("store: {0}")]
    Store(#[from] oc_store::StoreError),
    #[error("provider: {0}")]
    Provider(#[from] oc_provider::ProviderError),
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("tool part missing: {0}")]
    ToolPartMissing(String),
}

/// `MAX_STEPS_PROMPT` — ported verbatim from
/// `packages/core/src/session/runner/max-steps.ts`.
pub const MAX_STEPS_PROMPT: &str = "CRITICAL - MAXIMUM STEPS REACHED\n\nThe maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.\n\nSTRICT REQUIREMENTS:\n1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)\n2. MUST provide a text response summarizing work done so far\n3. This constraint overrides ALL other instructions, including any user requests for edits or tool use\n\nResponse must include:\n- Statement that maximum steps for this agent have been reached\n- Summary of what has been accomplished so far\n- List of any remaining tasks that were not completed\n- Recommendations for what should be done next\n\nAny attempt to use tools is a critical violation. Respond with text ONLY.";

/// Options for one turn of the runner.
#[derive(Clone)]
pub struct RunOptions {
    /// Agent name carried on assistant messages (upstream `Agent.ID`).
    pub agent: String,
    /// Upstream gates the limit on `agent.info.steps`; None means unlimited.
    pub max_steps: Option<u32>,
    /// Cooperative abort: checked before each step; a fired abort ends the
    /// turn as `interrupted`.
    pub abort: Arc<AtomicBool>,
    /// Permission ruleset evaluated before every tool execution; `deny` and
    /// `ask` both refuse in this headless runner (ask needs a human surface),
    /// and the refusal goes back to the model as the tool's error.
    pub permissions: oc_permission::Ruleset,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            agent: "build".into(),
            max_steps: None,
            abort: Arc::new(AtomicBool::new(false)),
            permissions: oc_permission::Ruleset::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunOutput {
    pub outcome: Outcome,
    pub steps: u32,
    /// The final assistant text of the turn, when the model wrote any.
    pub text: Option<String>,
}

/// Append the user turn, then run the loop. (`session.prompt`'s handler.)
pub async fn prompt(
    store: &Arc<RwLock<Store>>,
    registry: &Registry,
    client: &Client,
    session_id: &str,
    model: ModelRef,
    text: &str,
    opts: &RunOptions,
) -> Result<RunOutput, AgentError> {
    store.write().await.append_message(session_id, |id, t| user_message(text.to_string(), Vec::new(), id, t))?;
    run_turn(store, registry, client, session_id, model, opts).await
}

/// One runner turn: step until the model answers without tool calls, the
/// step limit gates, an abort fires, or a provider error ends the run.
pub async fn run_turn(
    store: &Arc<RwLock<Store>>,
    registry: &Registry,
    client: &Client,
    session_id: &str,
    model: ModelRef,
    opts: &RunOptions,
) -> Result<RunOutput, AgentError> {
    if store.read().await.get_session(session_id).is_err() {
        return Err(AgentError::NotFound(session_id.to_string()));
    }
    let mut system = system_prompt(&model);
    let worktree = worktree_of(&*store.read().await, session_id);
    if let Some(instructions) = worktree_instructions(&worktree) {
        system.push_str("\n\n");
        system.push_str(&instructions);
    }
    let mut step: u32 = 0;
    let mut last_text: Option<String> = None;
    let outcome = loop {
        if opts.abort.load(Ordering::Relaxed) {
            break Outcome::Interrupted;
        }
        let limit_reached = opts.max_steps.is_some_and(|m| step >= m);
        let history = store.read().await.messages(session_id)?;
        let mut messages = to_llm_messages(&history);
        if limit_reached {
            // runner/llm.ts: the gate appends the gate text as an assistant
            // message to the REQUEST and pins toolChoice none, keeping tool
            // definitions so the provider's cached prefix survives.
            messages.push(ChatMessage::Assistant {
                text: Some(MAX_STEPS_PROMPT.into()),
                tool_calls: Vec::new(),
            });
        }
        let req = ChatRequest {
            model: model.id.clone(),
            system: Some(system.clone()),
            messages,
            tools: registry.defs(),
            tool_choice: if limit_reached { ToolChoice::None } else { ToolChoice::Auto },
        };
        let resp = match client.complete(&model.id, &req).await {
            Ok(r) => r,
            Err(e) => {
                // A provider failure ends the run as `failed`: the failure is
                // recorded on a terminal assistant message, the idle marker
                // lands, and the session outcome flips (upstream's retry
                // ladder lives in SessionRunnerRetry; the port stops).
                record_provider_failure(&mut *store.write().await, session_id, &opts.agent, &model, &e.to_string())?;
                store.write().await.append_message(session_id, |id, t| idle_message(Outcome::Failed, id, t))?;
                store.write().await.set_outcome(session_id, Outcome::Failed)?;
                return Ok(RunOutput { outcome: Outcome::Failed, steps: step, text: None });
            }
        };
        settle_step(store, registry, session_id, &opts.agent, &model, &resp, &opts.permissions).await?;
        fold_usage(&mut *store.write().await, session_id, &resp)?;
        last_text = resp.text.clone();
        let has_calls = !resp.tool_calls.is_empty();
        if !has_calls || limit_reached || opts.abort.load(Ordering::Relaxed) {
            break if opts.abort.load(Ordering::Relaxed) {
                Outcome::Interrupted
            } else {
                Outcome::Succeeded
            };
        }
        step += 1;
    };
    store.write().await.append_message(session_id, |id, t| idle_message(outcome, id, t))?;
    store.write().await.set_outcome(session_id, outcome)?;
    Ok(RunOutput { outcome, steps: step + 1, text: last_text })
}

/// Create the assistant message for one completed provider step: text and
/// reasoning parts verbatim, one tool part per call in `running` state, then
/// execute each call and settle its part to `completed`/`error` in place.
async fn settle_step(
    store: &Arc<RwLock<Store>>,
    registry: &Registry,
    session_id: &str,
    agent: &str,
    model: &ModelRef,
    resp: &LlmResponse,
    permissions: &oc_permission::Ruleset,
) -> Result<(), AgentError> {
    let now = now_ms();
    let mut content: Vec<AssistantContent> = Vec::new();
    if let Some(r) = &resp.reasoning {
        if !r.is_empty() {
            content.push(AssistantContent::Reasoning(oc_schema::AssistantReasoning { text: r.clone() }));
        }
    }
    if let Some(t) = &resp.text {
        content.push(AssistantContent::Text(oc_schema::AssistantText { text: t.clone() }));
    }
    let mut tool_inputs: Vec<(String, serde_json::Value)> = Vec::new();
    for call in &resp.tool_calls {
        let input: serde_json::Value =
            serde_json::from_str(&call.arguments).unwrap_or(serde_json::Value::Null);
        content.push(AssistantContent::Tool(AssistantTool {
            id: call.id.clone(),
            name: call.name.clone(),
            executed: None,
            native: None,
            state: ToolState::Running { input: input.clone(), metadata: None },
            time: AssistantToolTime { created: now, ran: None, completed: None },
        }));
        tool_inputs.push((call.id.clone(), input));
    }
    let stored = store.write().await.append_message(session_id, |id, t| {
        assistant_message(agent, model.clone(), content, id, t)
    })?;
    let assistant_id = message_id_of(&stored).to_string();

    for (call, (call_id, input)) in resp.tool_calls.iter().zip(tool_inputs.iter()) {
        let ran = now_ms();
        let ctx = ToolContext {
            worktree: worktree_of(&*store.read().await, session_id),
            session_id: session_id.to_string(),
            call_id: call_id.clone(),
        };
        // permission gate: the resource is the tool's primary target —
        // its path / command / url when present, "*" otherwise
        let resource = input
            .get("path")
            .or_else(|| input.get("command"))
            .or_else(|| input.get("url"))
            .and_then(|v| v.as_str())
            .unwrap_or("*")
            .to_string();
        let executed = match opts_permissions_check(permissions, &call.name, &resource) {
            Ok(()) => registry.execute(&call.name, input, &ctx).await,
            Err(reason) => Err(oc_tools::ToolError::Failed(reason)),
        };
        let completed = now_ms();

        let history = store.read().await.messages(session_id)?;
        let mut msg = history
            .into_iter()
            .find(|m| message_id_of(m) == assistant_id)
            .ok_or_else(|| AgentError::ToolPartMissing(assistant_id.clone()))?;
        let Message::Assistant(a) = &mut msg else { continue };
        let Some(part) = a.content.iter_mut().find_map(|c| match c {
            AssistantContent::Tool(t) if t.id == *call_id => Some(t),
            _ => None,
        }) else {
            return Err(AgentError::ToolPartMissing(call_id.clone()));
        };
        part.executed = Some(true);
        part.time.ran = Some(ran);
        part.time.completed = Some(completed);
        part.state = match &executed {
            Ok(out) => ToolState::Completed {
                input: input.clone(),
                content: out.content.clone(),
                metadata: out.metadata.clone(),
            },
            Err(e) => ToolState::Error {
                input: input.clone(),
                error: session_error("ToolError", &e.to_string()),
                // the failure text goes back to the model so it can react
                content: Some(vec![ToolContent::Text { text: e.to_string() }]),
                metadata: None,
            },
        };
        store.write().await.replace_message(session_id, msg)?;
    }
    Ok(())
}

fn message_id_of(m: &Message) -> &str {
    match m {
        Message::User(u) => &u.base.id,
        Message::Assistant(a) => &a.base.id,
        Message::Synthetic(s) => &s.base.id,
        Message::System(s) => &s.base.id,
        Message::AgentSwitched(a) => &a.base.id,
        Message::ModelSwitched(m) => &m.base.id,
        Message::Idle(i) => &i.base.id,
    }
}

fn worktree_of(store: &Store, session_id: &str) -> std::path::PathBuf {
    store
        .get_session(session_id)
        .ok()
        .map(|s| std::path::PathBuf::from(s.location.directory))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn fold_usage(store: &mut Store, session_id: &str, resp: &LlmResponse) -> Result<(), AgentError> {
    if let Some(usage) = &resp.usage {
        // Pricing tables (models.dev) are not ported; cost stays 0 —
        // documented delta. Token totals still accumulate.
        store.add_usage(session_id, 0.0, usage)?;
    }
    Ok(())
}

/// Record a provider failure on a terminal assistant message for the step.
fn record_provider_failure(
    store: &mut Store,
    session_id: &str,
    agent: &str,
    model: &ModelRef,
    message: &str,
) -> Result<(), AgentError> {
    let now = now_ms();
    store.append_message(session_id, |id, t| {
        let mut m = assistant_message(agent, model.clone(), Vec::new(), id, t);
        if let Message::Assistant(a) = &mut m {
            a.error = Some(session_error("ProviderError", message));
            a.base.time.completed = Some(now);
        }
        m
    })?;
    Ok(())
}

/// Headless permission check: `deny` and `ask` both refuse (ask needs a
/// human surface the runner does not have), with the reason sent to the model.
fn opts_permissions_check(
    permissions: &oc_permission::Ruleset,
    action: &str,
    resource: &str,
) -> Result<(), String> {
    match permissions.decide(action, resource) {
        oc_permission::Effect::Allow => Ok(()),
        oc_permission::Effect::Deny => {
            Err(format!("permission denied by ruleset: {action} {resource}"))
        }
        oc_permission::Effect::Ask => Err(format!(
            "permission requires interactive approval, which this runner cannot ask for: {action} {resource}"
        )),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use oc_provider::{ProviderError, Transport};
    use oc_store::Store;
    use oc_schema::FinishReason;

    /// A transport playing back scripted OpenAI-shaped response bodies and
    /// recording every request it was given.
    struct Scripted {
        responses: std::sync::Mutex<Vec<serde_json::Value>>,
        requests: std::sync::Mutex<Vec<serde_json::Value>>,
        fail_with: Option<ProviderError>,
    }

    impl Scripted {
        fn new(responses: Vec<serde_json::Value>) -> Self {
            Self {
                responses: std::sync::Mutex::new(responses),
                requests: std::sync::Mutex::new(Vec::new()),
                fail_with: None,
            }
        }
        fn failing(err: ProviderError) -> Self {
            Self { responses: std::sync::Mutex::new(vec![]), requests: std::sync::Mutex::new(vec![]), fail_with: Some(err) }
        }
        fn requests(&self) -> Vec<serde_json::Value> {
            self.requests.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl Transport for Scripted {
        async fn post_json(
            &self,
            _url: &str,
            _headers: Vec<(String, String)>,
            body: serde_json::Value,
        ) -> Result<serde_json::Value, ProviderError> {
            self.requests.lock().unwrap().push(body);
            if let Some(err) = &self.fail_with {
                return Err(err.clone());
            }
            self.responses
                .lock()
                .unwrap()
                .pop()
                .ok_or_else(|| ProviderError::Malformed("script exhausted".into()))
        }
    }

    fn openai_text(text: &str) -> serde_json::Value {
        serde_json::json!({
            "choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}
        })
    }

    fn openai_tool_call(id: &str, name: &str, arguments: &str) -> serde_json::Value {
        serde_json::json!({
            "choices": [{"message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{"id": id, "type": "function", "function": {"name": name, "arguments": arguments}}]
            }, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 8}
        })
    }

    fn session() -> (tempfile::TempDir, Arc<RwLock<Store>>, String) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let s = store
            .create_session(oc_store::CreateInput {
                title: None,
                parent_id: None,
                agent: Some("build".into()),
                model: None,
                directory: dir.path().to_string_lossy().to_string(),
                project_id: "global".into(),
            })
            .unwrap();
        (dir, Arc::new(RwLock::new(store)), s.id)
    }

    fn model() -> ModelRef {
        ModelRef::parse("openai/gpt-test").unwrap()
    }


    #[tokio::test]
    async fn text_only_run_succeeds() {
        let (_dir, store, sid) = session();
        let client = Client::with_transport(
            oc_provider::Endpoint {
                protocol: oc_provider::Protocol::OpenAI,
                base_url: "http://mock/v1".into(),
                api_key: Some("k".into()),
            },
            Arc::new(Scripted::new(vec![openai_text("all done")])),
        );
        let registry = Registry::builtin(std::path::Path::new("/tmp"));
        let out = prompt(&store, &registry, &client, &sid, model(), "fix it", &opts())
            .await
            .unwrap();
        assert_eq!(out.outcome, Outcome::Succeeded);
        assert_eq!(out.text.as_deref(), Some("all done"));
        let msgs = store.read().await.messages(&sid).unwrap();
        let kinds: Vec<&str> = msgs.iter().map(|m| kind(m)).collect();
        assert_eq!(kinds, ["user", "assistant", "idle"]);
        let s = store.read().await.get_session(&sid).unwrap();
        assert_eq!(s.outcome, Some(Outcome::Succeeded));
        assert_eq!(s.tokens.input, 10.0);
        assert_eq!(s.tokens.output, 5.0);
    }

    #[tokio::test]
    async fn tool_call_settles_then_text_arrives() {
        let (dir, store, sid) = session();
        std::fs::write(dir.path().join("AGENTS.md"), "Project instruction: use the note file.").unwrap();
        let scripted = Arc::new(Scripted::new(vec![
            openai_text("done: created the file"),
            openai_tool_call("call_1", "write", r#"{"path":"note.txt","content":"hi"}"#),
        ]));
        let client = Client::with_transport(
            oc_provider::Endpoint {
                protocol: oc_provider::Protocol::OpenAI,
                base_url: "http://mock/v1".into(),
                api_key: None,
            },
            scripted.clone(),
        );
        let registry = Registry::builtin(dir.path());
        let out = prompt(&store, &registry, &client, &sid, model(), "write note.txt", &opts())
            .await
            .unwrap();
        assert_eq!(out.outcome, Outcome::Succeeded);
        assert_eq!(out.text.as_deref(), Some("done: created the file"));

        // the file was really written by the tool
        assert_eq!(
            std::fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "hi"
        );

        // step 2's request carried the tool result for call_1
        let requests = scripted.requests();
        assert!(requests[0]["messages"][0]["content"].as_str().unwrap().contains("Project instruction: use the note file."));
        let second = &requests[1];
        let roles: Vec<&str> = second["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        // system prompt first, then the turn's transcript
        assert_eq!(roles, ["system", "user", "assistant", "tool"]);
        let tool_msg = &second["messages"][3];
        assert_eq!(tool_msg["tool_call_id"], "call_1");

        // the stored tool part is completed with executed=true
        let msgs = store.read().await.messages(&sid).unwrap();
        let kinds: Vec<&str> = msgs.iter().map(|m| kind(m)).collect();
        assert_eq!(kinds, ["user", "assistant", "assistant", "idle"]);
        for m in &msgs {
            if let Message::Assistant(a) = m {
                for part in &a.content {
                    if let AssistantContent::Tool(t) = part {
                        assert_eq!(t.executed, Some(true));
                        match &t.state {
                            ToolState::Completed { content, .. } => {
                                assert!(!content.is_empty());
                            }
                            other => panic!("expected completed, got {other:?}"),
                        }
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn max_steps_gate_pins_tool_choice_and_gates_text() {
        let (_dir, store, sid) = session();
        let scripted = Arc::new(Scripted::new(vec![openai_text("summary of work")]));
        let client = Client::with_transport(
            oc_provider::Endpoint {
                protocol: oc_provider::Protocol::OpenAI,
                base_url: "http://mock/v1".into(),
                api_key: None,
            },
            scripted.clone(),
        );
        let registry = Registry::builtin(std::path::Path::new("/tmp"));
        let o = RunOptions { max_steps: Some(0), ..opts() };
        let out = prompt(&store, &registry, &client, &sid, model(), "go", &o).await.unwrap();
        assert_eq!(out.outcome, Outcome::Succeeded);
        let requests = scripted.requests();
        let body = &requests[0];
        assert_eq!(body["tool_choice"], "none");
        let last = body["messages"].as_array().unwrap().last().unwrap();
        assert_eq!(last["role"], "assistant");
        assert_eq!(last["content"], MAX_STEPS_PROMPT);
    }

    #[tokio::test]
    async fn provider_failure_marks_session_failed() {
        let (_dir, store, sid) = session();
        let client = Client::with_transport(
            oc_provider::Endpoint {
                protocol: oc_provider::Protocol::OpenAI,
                base_url: "http://mock/v1".into(),
                api_key: None,
            },
            Arc::new(Scripted::failing(ProviderError::Http { status: 500, body: "boom".into() })),
        );
        let registry = Registry::builtin(std::path::Path::new("/tmp"));
        let out = prompt(&store, &registry, &client, &sid, model(), "go", &opts()).await.unwrap();
        assert_eq!(out.outcome, Outcome::Failed);
        let s = store.read().await.get_session(&sid).unwrap();
        assert_eq!(s.outcome, Some(Outcome::Failed));
        let msgs = store.read().await.messages(&sid).unwrap();
        let kinds: Vec<&str> = msgs.iter().map(|m| kind(m)).collect();
        assert_eq!(kinds, ["user", "assistant", "idle"]);
        let failed = msgs.iter().find_map(|m| match m {
            Message::Assistant(a) => a.error.clone(),
            _ => None,
        });
        assert_eq!(failed.unwrap().name, "ProviderError");
        assert!(msgs.iter().any(|m| matches!(
            m,
            Message::Idle(i) if i.outcome == Outcome::Failed
        )));
    }

    #[tokio::test]
    async fn abort_before_run_interrupts() {
        let (_dir, store, sid) = session();
        let client = Client::with_transport(
            oc_provider::Endpoint {
                protocol: oc_provider::Protocol::OpenAI,
                base_url: "http://mock/v1".into(),
                api_key: None,
            },
            Arc::new(Scripted::new(vec![])),
        );
        let registry = Registry::builtin(std::path::Path::new("/tmp"));
        let abort = Arc::new(AtomicBool::new(true));
        let o = RunOptions { abort: abort.clone(), ..opts() };
        let out = prompt(&store, &registry, &client, &sid, model(), "go", &o).await.unwrap();
        assert_eq!(out.outcome, Outcome::Interrupted);
        let _ = &client; // scripted transport was empty: any call would fail the test via script exhaustion

    }

    #[test]
    fn transcript_mapping_matches_upstream_roles() {
        let mut store = Store::new();
        let s = store
            .create_session(oc_store::CreateInput {
                title: None,
                parent_id: None,
                agent: None,
                model: None,
                directory: "/tmp".into(),
                project_id: "global".into(),
            })
            .unwrap();
        store.append_message(&s.id, |id, t| user_message("do it".into(), vec![], id, t)).unwrap();
        store
            .append_message(&s.id, |id, t| oc_store::synthetic_message("context update", id, t))
            .unwrap();
        store
            .append_message(&s.id, |id, t| {
                let mut m = assistant_message("build", model(), vec![], id, t);
                if let Message::Assistant(a) = &mut m {
                    a.content = vec![AssistantContent::Tool(AssistantTool {
                        id: "call_9".into(),
                        name: "bash".into(),
                        executed: Some(true),
                        native: None,
                        state: ToolState::Completed {
                            input: serde_json::json!({"command": "ls"}),
                            content: vec![ToolContent::Text { text: "out".into() }],
                            metadata: None,
                        },
                        time: AssistantToolTime { created: t, ran: Some(t), completed: Some(t) },
                    })];
                    a.finish = Some(FinishReason::ToolCalls);
                }
                m
            })
            .unwrap();
        store.append_message(&s.id, |id, t| idle_message(Outcome::Succeeded, id, t)).unwrap();
        let history = store.messages(&s.id).unwrap();
        let mapped = to_llm_messages(&history);
        let kinds: Vec<String> = mapped
            .iter()
            .map(|m| match m {
                ChatMessage::User { .. } => "user".to_string(),
                ChatMessage::Assistant { tool_calls, .. } => {
                    format!("assistant({} calls)", tool_calls.len())
                }
                ChatMessage::ToolResult { call_id, .. } => format!("tool({call_id})"),
            })
            .collect();
        // synthetic → user; idle dropped; executed tool part → call + result
        assert_eq!(kinds, ["user", "user", "assistant(1 calls)", "tool(call_9)"]);
    }

}

#[cfg(test)]
fn opts() -> RunOptions {
    RunOptions {
        permissions: oc_permission::Ruleset {
            rules: vec![oc_permission::Rule {
                action: "*".into(), resource: "*".into(), effect: oc_permission::Effect::Allow,
            }],
        },
        ..RunOptions::default()
    }
}

#[cfg(test)]
fn kind(m: &Message) -> &'static str {
    match m {
        Message::User(_) => "user",
        Message::Assistant(_) => "assistant",
        Message::Synthetic(_) => "synthetic",
        Message::System(_) => "system",
        Message::AgentSwitched(_) => "agent-switched",
        Message::ModelSwitched(_) => "model-switched",
        Message::Idle(_) => "idle",
    }
}

// ===== Transcript mapping — port of to-llm-message.ts (subset) =====

/// `toLLMMessages`: stored history → provider-neutral chat messages.
/// - user → user text (upstream also inlines text attachments; the port has
///   no attachment pipeline yet)
/// - synthetic → user text (upstream sends it as a user-role message)
/// - system → hoisted into the system prompt by the caller (delta: upstream
///   keeps an in-transcript system message; from the model's view both reach
///   it as system-level context)
/// - assistant → assistant text + its tool calls; executed parts additionally
///   emit tool-result messages right after (upstream's `results` path)
/// - agent-switched / idle / model-switched → dropped
pub fn to_llm_messages(history: &[Message]) -> Vec<ChatMessage> {
    let mut out = Vec::new();
    for m in history {
        match m {
            Message::User(u) => {
                if !u.text.is_empty() {
                    out.push(ChatMessage::User { text: u.text.clone() });
                }
            }
            Message::Synthetic(s) => {
                out.push(ChatMessage::User { text: s.text.clone() });
            }
            Message::System(_) => {
                // hoisted by the caller into the system prompt
            }
            Message::AgentSwitched(_) | Message::ModelSwitched(_) | Message::Idle(_) => {}
            Message::Assistant(a) => {
                let mut text = String::new();
                let mut tool_calls = Vec::new();
                for part in &a.content {
                    match part {
                        AssistantContent::Text(t) => {
                            if !t.text.is_empty() {
                                if !text.is_empty() {
                                    text.push_str("\n\n");
                                }
                                text.push_str(&t.text);
                            }
                        }
                        AssistantContent::Reasoning(r) => {
                            // upstream replays readable reasoning with
                            // provider-bound metadata only for the producing
                            // model; the port has no metadata replay, so
                            // reasoning is dropped — documented delta
                            let _ = r;
                        }
                        AssistantContent::Tool(tool) => {
                            let input = match &tool.state {
                                ToolState::Running { input, .. }
                                | ToolState::Completed { input, .. }
                                | ToolState::Error { input, .. } => input.clone(),
                            };
                            tool_calls.push(oc_schema::LlmToolCall {
                                id: tool.id.clone(),
                                name: tool.name.clone(),
                                arguments: serde_json::to_string(&input)
                                    .unwrap_or_else(|_| "{}".into()),
                            });
                        }
                    }
                }
                let text_opt = if text.is_empty() { None } else { Some(text) };
                if text_opt.is_none() && tool_calls.is_empty() {
                    continue;
                }
                out.push(ChatMessage::Assistant { text: text_opt, tool_calls });
                // tool results for executed parts, in part order
                for part in &a.content {
                    if let AssistantContent::Tool(tool) = part {
                        if tool.executed != Some(true) {
                            continue;
                        }
                        let content: Vec<ToolContent> = match &tool.state {
                            ToolState::Completed { content, .. } => content.clone(),
                            ToolState::Error { content, error, .. } => content
                                .clone()
                                .unwrap_or_else(|| {
                                    vec![ToolContent::Text {
                                        text: error
                                            .message
                                            .clone()
                                            .unwrap_or_else(|| error.name.clone()),
                                    }]
                                }),
                            _ => vec![],
                        };
                        out.push(ChatMessage::ToolResult {
                            call_id: tool.id.clone(),
                            name: tool.name.clone(),
                            content,
                        });
                    }
                }
            }
        }
    }
    out
}

// ===== System prompt =====

/// The model-facing system prompt: identity, tool guidance, and the
/// worktree's AGENTS.md when present (the port of upstream's instruction
/// discovery, root file only).
pub fn system_prompt(model: &ModelRef) -> String {
    let today = today_iso();
    let mut s = format!(
        "You are opencode, the open-source coding agent, running in the user's terminal.\n\
         You are powered by the model {provider}/{model}.\n\
         Today's date is {today}.\n",
        provider = model.provider_id,
        model = model.id,
        today = today,
    );
    s.push_str(
        "\nYou can read, write and edit files, run shell commands, search the\n\
         workspace with glob and grep, and keep a task list with todowrite.\n\
         Prefer reading a file before editing it; make edits with the edit\n\
         tool's exact-match replace; keep shell commands short and non-interactive.\n\
         Answer in plain text when you are done, saying what you changed.\n",
    );
    s
}

/// AGENTS.md content at the worktree root, if any — the instruction file the
/// upstream loader feeds into the prompt verbatim.
pub fn worktree_instructions(worktree: &std::path::Path) -> Option<String> {
    let path = worktree.join("AGENTS.md");
    std::fs::read_to_string(path).ok().filter(|s| !s.trim().is_empty())
}

fn today_iso() -> String {
    // days since epoch → YYYY-MM-DD, no chrono dependency
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    civil_from_days((secs / 86_400) as i64)
}

fn civil_from_days(z: i64) -> String {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

// ===== Environment configuration (shared by server and CLI) =====

/// Provider endpoint from the environment: `OC_PROVIDER` (`openai` |
/// `anthropic`, default openai), `OC_BASE_URL` (protocol default when
/// unset), and the key from `OC_API_KEY` or the provider's conventional
/// variable (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).
pub fn endpoint_from_env() -> oc_provider::Endpoint {
    let provider = std::env::var("OC_PROVIDER")
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let (protocol, default_base, conventional_key) = match provider.as_str() {
        "anthropic" => (
            oc_provider::Protocol::Anthropic,
            "https://api.anthropic.com",
            "ANTHROPIC_API_KEY",
        ),
        _ => (
            oc_provider::Protocol::OpenAI,
            "https://api.openai.com/v1",
            "OPENAI_API_KEY",
        ),
    };
    let base_url = std::env::var("OC_BASE_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| default_base.to_string());
    let api_key = std::env::var("OC_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var(conventional_key).ok())
        .filter(|s| !s.trim().is_empty());
    oc_provider::Endpoint { protocol, base_url, api_key }
}

/// Model ref from `OC_MODEL` (default `openai/gpt-4o-mini`; a local endpoint
/// names its own model there).
pub fn model_from_env() -> ModelRef {
    let raw = std::env::var("OC_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "openai/gpt-4o-mini".into());
    ModelRef::parse(&raw).unwrap_or_else(|_| ModelRef::parse("openai/gpt-4o-mini").unwrap())
}

/// Step limit from `OC_MAX_STEPS`; unset/invalid = unlimited (upstream's
/// default: the gate applies only when the agent defines steps).
pub fn max_steps_from_env() -> Option<u32> {
    std::env::var("OC_MAX_STEPS")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
}

#[cfg(test)]
mod multi_agent_tests {
    use super::*;
    use crate::task::TaskTool;
    use async_trait::async_trait;
    use oc_provider::{Endpoint, Protocol, ProviderError, Transport};
    use std::sync::Mutex;
    use tokio::sync::RwLock;

    /// Same scripted transport as the runner tests, shared via Arc so the
    /// task tool's child turn pulls the next scripted response.
    struct Scripted2 {
        responses: Mutex<Vec<serde_json::Value>>,
    }

    #[async_trait]
    impl Transport for Scripted2 {
        async fn post_json(
            &self,
            _url: &str,
            _headers: Vec<(String, String)>,
            _body: serde_json::Value,
        ) -> Result<serde_json::Value, ProviderError> {
            self.responses
                .lock()
                .unwrap()
                .pop()
                .ok_or_else(|| ProviderError::Malformed("script exhausted".into()))
        }
    }

    fn openai_text(text: &str) -> serde_json::Value {
        serde_json::json!({
            "choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}
        })
    }

    fn openai_tool_call(id: &str, name: &str, arguments: &str) -> serde_json::Value {
        serde_json::json!({
            "choices": [{"message": {
                "role": "assistant", "content": null,
                "tool_calls": [{"id": id, "type": "function", "function": {"name": name, "arguments": arguments}}]
            }, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 8}
        })
    }

    #[tokio::test]
    async fn task_tool_spawns_child_session_and_returns_its_answer() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(RwLock::new(Store::open(dir.path()).unwrap()));
        let parent = {
            let mut st = store.write().await;
            st.create_session(oc_store::CreateInput {
                title: Some("parent".into()),
                parent_id: None,
                agent: Some("build".into()),
                model: None,
                directory: dir.path().to_string_lossy().into_owned(),
                project_id: "global".into(),
            })
            .unwrap()
        };
        let scripted = Arc::new(Scripted2 {
            responses: Mutex::new(vec![
                // parent step 2: wrap the child's answer
                openai_text("parent wrapped: child finished"),
                // child turn: text answer
                openai_text("child finished"),
                // parent step 1: delegate
                openai_tool_call(
                    "call_t1",
                    "task",
                    r#"{"description":"probe the repo","prompt":"look around"}"#,
                ),
            ]),
        });
        let client = Arc::new(Client::with_transport(
            Endpoint { protocol: Protocol::OpenAI, base_url: "http://mock/v1".into(), api_key: None },
            scripted,
        ));
        // child registry has NO task tool (delegation capped at one level)
        let child_registry = Arc::new(Registry::builtin(dir.path()));
        let task = TaskTool::new(
            store.clone(),
            client.clone(),
            child_registry,
            ModelRef::parse("openai/gpt-test").unwrap(),
            "build".into(),
            None,
        );
        let registry = Registry::builtin(dir.path()).with_tools(vec![Arc::new(task)]);
        let model = ModelRef::parse("openai/gpt-test").unwrap();
        let out = tokio::time::timeout(std::time::Duration::from_secs(5), prompt(
            &store,
            &registry,
            &client,
            &parent.id,
            model,
            "delegate the probe",
            &opts(),
        ))
        .await
        .expect("delegated turn must not hold the parent store lock")
        .unwrap();

        assert_eq!(out.outcome, Outcome::Succeeded);
        assert_eq!(out.text.as_deref(), Some("parent wrapped: child finished"));

        // a child session exists under the parent with its own transcript
        let st = store.read().await;
        let children = st.list_sessions(&oc_schema::SessionListFilter {
            parent_id: Some(Some(parent.id.clone())),
            ..Default::default()
        });
        assert_eq!(children.sessions.len(), 1, "exactly one child session");
        let child = &children.sessions[0];
        assert_eq!(child.title.as_deref(), Some("probe the repo"));
        let child_msgs = st.messages(&child.id).unwrap();
        let child_kinds: Vec<&str> = child_msgs.iter().map(kind).collect();
        assert_eq!(child_kinds, ["user", "assistant", "idle"]);
        let parent_msgs = st.messages(&parent.id).unwrap();
        let parent_kinds: Vec<&str> = parent_msgs.iter().map(kind).collect();
        assert_eq!(parent_kinds, ["user", "assistant", "assistant", "idle"]);
        // the parent's tool part carries the child's answer
        for m in &parent_msgs {
            if let Message::Assistant(a) = m {
                for part in &a.content {
                    if let AssistantContent::Tool(t) = part {
                        match &t.state {
                            ToolState::Completed { content, .. } => {
                                let oc_schema::ToolContent::Text { text } = &content[0] else { panic!() };
                                assert!(text.contains("child finished"), "{text}");
                            }
                            other => panic!("expected completed, got {other:?}"),
                        }
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn permission_deny_settles_tool_part_as_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let sid = store
            .create_session(oc_store::CreateInput {
                title: None,
                parent_id: None,
                agent: None,
                model: None,
                directory: dir.path().to_string_lossy().into_owned(),
                project_id: "global".into(),
            })
            .unwrap()
            .id;
        let scripted = Arc::new(Scripted2 {
            responses: Mutex::new(vec![
                openai_text("understood, skipped the shell step"),
                openai_tool_call("call_d1", "shell", r#"{"command": "rm -rf /"}"#),
            ]),
        });
        let client = Client::with_transport(
            Endpoint { protocol: Protocol::OpenAI, base_url: "http://mock/v1".into(), api_key: None },
            scripted,
        );
        let registry = Registry::builtin(dir.path());
        let permissions = oc_permission::Ruleset {
            rules: vec![oc_permission::Rule {
                action: "shell".into(),
                resource: "*".into(),
                effect: oc_permission::Effect::Deny,
            }],
        };
        let store = Arc::new(RwLock::new(store));
        let o = RunOptions { permissions, ..opts() };
        let out = prompt(&store, &registry, &client, &sid, ModelRef::parse("openai/gpt-test").unwrap(), "go", &o)
            .await
            .unwrap();
        assert_eq!(out.outcome, Outcome::Succeeded);
        let msgs = store.read().await.messages(&sid).unwrap();
        for m in &msgs {
            if let Message::Assistant(a) = m {
                for part in &a.content {
                    if let AssistantContent::Tool(t) = part {
                        assert_eq!(t.executed, Some(true));
                        match &t.state {
                            ToolState::Error { error, content, .. } => {
                                assert_eq!(error.name, "ToolError");
                                let Some(vec) = content else { panic!("error text missing") };
                                let oc_schema::ToolContent::Text { text } = &vec[0] else { panic!() };
                                assert!(text.contains("permission denied"), "{text}");
                            }
                            other => panic!("expected error state, got {other:?}"),
                        }
                    }
                }
            }
        }
    }
}
