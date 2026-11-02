//! oc-agent: port of the session runner (`packages/core/src/session/runner/`)
//! — the step loop, tool settlement, the MAX_STEPS gate, and the transcript
//! mapping (`to-llm-message.ts`, subset: no file attachments, no hosted
//! tools, no provider-metadata replay).

pub mod compaction;
pub mod task;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use oc_provider::{ChatMessage, ChatRequest, Client, OnEvent, StreamEvent, ToolChoice};
use oc_schema::{
    AssistantContent, AssistantTool, AssistantToolTime, LlmResponse, Message, ModelRef, Outcome,
    ToolContent, ToolState,
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

/// How soon a fired abort stops a model stream or a tool that is running.
const ABORT_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// Streaming progress of one runner turn, delivered to the caller's observer.
#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    ReasoningDelta {
        delta: String,
    },
    TextDelta {
        delta: String,
    },
    ToolCallStarted {
        name: String,
        input: serde_json::Value,
    },
    ToolCallFinished {
        name: String,
        ok: bool,
        preview: String,
    },
    StepFinished {
        usage: Option<oc_schema::LlmUsage>,
    },
    CompactionStarted,
    CompactionFinished {
        result: compaction::Compacted,
    },
}

/// Callback receiving [`RunEvent`]s in order; the default does nothing.
pub type Observer = Arc<dyn Fn(RunEvent) + Send + Sync>;

/// Terminal approval for a rule that resolves to `ask`. Returning `false`
/// refuses the action, and the refusal goes back to the model.
pub type PermissionAsk = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

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
    /// Permission ruleset evaluated before every tool execution; `deny`
    /// refuses, `ask` calls [`Self::permission_ask`] when present and refuses
    /// otherwise, and the refusal goes back to the model as the tool's error.
    pub permissions: oc_permission::Ruleset,
    /// Observer for streamed deltas and tool/step progress.
    pub observer: Observer,
    /// Interactive approval for `ask` rules (None refuses like the server).
    pub permission_ask: Option<PermissionAsk>,
    /// When the context is summarized to stay inside the model's window.
    pub compaction: compaction::Settings,
}

fn allow_all_permissions() -> oc_permission::Ruleset {
    oc_permission::Ruleset {
        rules: vec![oc_permission::Rule {
            action: "*".into(),
            resource: "*".into(),
            effect: oc_permission::Effect::Allow,
        }],
    }
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            agent: "build".into(),
            max_steps: None,
            abort: Arc::new(AtomicBool::new(false)),
            permissions: allow_all_permissions(),
            observer: Arc::new(|_| {}),
            permission_ask: None,
            compaction: compaction::Settings::default(),
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
    store: &Store,
    registry: &Registry,
    client: &Client,
    session_id: &str,
    model: ModelRef,
    text: &str,
    opts: &RunOptions,
) -> Result<RunOutput, AgentError> {
    store.append_message(session_id, |id, t| {
        user_message(text.to_string(), Vec::new(), id, t)
    })?;
    run_turn(store, registry, client, session_id, model, opts).await
}

/// One runner turn: step until the model answers without tool calls, the
/// step limit gates, an abort fires, or a provider error ends the run.
pub async fn run_turn(
    store: &Store,
    registry: &Registry,
    client: &Client,
    session_id: &str,
    model: ModelRef,
    opts: &RunOptions,
) -> Result<RunOutput, AgentError> {
    if store.get_session(session_id).is_err() {
        return Err(AgentError::NotFound(session_id.to_string()));
    }
    let worktree = worktree_of(store, session_id);
    let system = system_prompt(&model, &worktree);
    let mut step: u32 = 0;
    let mut last_text: Option<String> = None;
    // What the provider last counted; a new turn starts from an estimate.
    let mut last_input: Option<u64> = None;
    let mut overflow_tried = false;
    let compact_now = |rejected: Option<u64>| {
        compact_and_report(store, client, &model, &system, session_id, opts, rejected)
    };
    let outcome = loop {
        if opts.abort.load(Ordering::Relaxed) {
            break Outcome::Interrupted;
        }
        let limit_reached = opts.max_steps.is_some_and(|m| step >= m);
        if let Some(ceiling) = opts.compaction.ceiling() {
            let used = match last_input {
                Some(n) => n,
                None => compaction::estimate_context(&system, &store.messages(session_id)?),
            };
            if used >= ceiling {
                if compact_now(None).await? == compaction::Compacted::Interrupted {
                    break Outcome::Interrupted;
                }
                last_input = None;
            }
        }
        let history = store.messages(session_id)?;
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
            tool_choice: if limit_reached {
                ToolChoice::None
            } else {
                ToolChoice::Auto
            },
        };
        let forward = {
            let observer = opts.observer.clone();
            Arc::new(move |event: StreamEvent| match event {
                StreamEvent::Text { delta } => observer(RunEvent::TextDelta { delta }),
                StreamEvent::Reasoning { delta } => observer(RunEvent::ReasoningDelta { delta }),
                _ => {}
            }) as OnEvent
        };
        // Dropping the stream on an abort closes the connection, so the
        // endpoint stops generating and its slot is free again.
        let streamed = abortable(&opts.abort, client.complete_streaming(&model.id, &req, forward));
        let resp = match streamed.await {
            None => break Outcome::Interrupted,
            Some(Ok(r)) => r,
            Some(Err(e)) => {
                // Too long for the window: summarize and send it again, once.
                if !overflow_tried && compaction::is_overflow(&e.to_string()) {
                    overflow_tried = true;
                    let rejected = compaction::estimate_context(&system, &history);
                    match compact_now(Some(rejected)).await? {
                        compaction::Compacted::Done { .. } => {
                            last_input = None;
                            continue;
                        }
                        compaction::Compacted::Interrupted => break Outcome::Interrupted,
                        _ => {}
                    }
                }
                // A provider failure ends the run as `failed`: the failure is
                // recorded on a terminal assistant message, the idle marker
                // lands, and the session outcome flips (upstream's retry
                // ladder lives in SessionRunnerRetry; the port stops).
                record_provider_failure(store, session_id, &opts.agent, &model, &e.to_string())?;
                store.append_message(session_id, |id, t| idle_message(Outcome::Failed, id, t))?;
                store.set_outcome(session_id, Outcome::Failed)?;
                return Ok(RunOutput {
                    outcome: Outcome::Failed,
                    steps: step,
                    text: None,
                });
            }
        };
        settle_step(
            store,
            registry,
            session_id,
            &opts.agent,
            &model,
            &resp,
            &opts.permissions,
            opts.permission_ask.as_ref(),
            &opts.observer,
            &opts.abort,
        )
        .await?;
        fold_usage(store, session_id, &resp)?;
        (opts.observer)(RunEvent::StepFinished {
            usage: resp.usage.clone(),
        });
        overflow_tried = false;
        if let Some(u) = &resp.usage {
            last_input = Some((u.input + u.cache_read + u.cache_write) as u64);
        }
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
    store.append_message(session_id, |id, t| idle_message(outcome, id, t))?;
    store.set_outcome(session_id, outcome)?;
    Ok(RunOutput {
        outcome,
        steps: step + 1,
        text: last_text,
    })
}

async fn compact_and_report(
    store: &Store,
    client: &Client,
    model: &ModelRef,
    system: &str,
    session_id: &str,
    opts: &RunOptions,
    rejected: Option<u64>,
) -> Result<compaction::Compacted, AgentError> {
    (opts.observer)(RunEvent::CompactionStarted);
    let result =
        compaction::compact(store, client, model, system, session_id, &opts.compaction, rejected, &opts.abort).await?;
    (opts.observer)(RunEvent::CompactionFinished { result: result.clone() });
    Ok(result)
}

/// Run `work` until it ends or `abort` fires; `None` means it was dropped.
async fn abortable<F: std::future::Future>(abort: &AtomicBool, work: F) -> Option<F::Output> {
    tokio::pin!(work);
    loop {
        tokio::select! {
            out = &mut work => return Some(out),
            _ = tokio::time::sleep(ABORT_POLL) => {
                if abort.load(Ordering::Relaxed) {
                    return None;
                }
            }
        }
    }
}

/// Create the assistant message for one completed provider step: text and
/// reasoning parts verbatim, one tool part per call in `running` state, then
/// execute each call and settle its part to `completed`/`error` in place.
#[allow(clippy::too_many_arguments)]
async fn settle_step(
    store: &Store,
    registry: &Registry,
    session_id: &str,
    agent: &str,
    model: &ModelRef,
    resp: &LlmResponse,
    permissions: &oc_permission::Ruleset,
    permission_ask: Option<&PermissionAsk>,
    observer: &Observer,
    abort: &AtomicBool,
) -> Result<(), AgentError> {
    let now = now_ms();
    let mut content: Vec<AssistantContent> = Vec::new();
    if let Some(r) = &resp.reasoning {
        if !r.is_empty() {
            content.push(AssistantContent::Reasoning(oc_schema::AssistantReasoning {
                text: r.clone(),
            }));
        }
    }
    if let Some(t) = &resp.text {
        content.push(AssistantContent::Text(oc_schema::AssistantText {
            text: t.clone(),
        }));
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
            state: ToolState::Running {
                input: input.clone(),
                metadata: None,
            },
            time: AssistantToolTime {
                created: now,
                ran: None,
                completed: None,
            },
        }));
        tool_inputs.push((call.id.clone(), input));
    }
    let stored = store.append_message(session_id, |id, t| {
        assistant_message(agent, model.clone(), content, id, t)
    })?;
    let assistant_id = message_id_of(&stored).to_string();

    for (call, (call_id, input)) in resp.tool_calls.iter().zip(tool_inputs.iter()) {
        let ran = now_ms();
        let ctx = ToolContext {
            worktree: worktree_of(store, session_id),
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
        observer(RunEvent::ToolCallStarted {
            name: call.name.clone(),
            input: input.clone(),
        });
        let executed =
            match opts_permissions_check(permissions, &call.name, &resource, permission_ask) {
                // Dropping a shell call kills its process group.
                Ok(()) => abortable(abort, registry.execute(&call.name, input, &ctx))
                    .await
                    .unwrap_or_else(|| Err(oc_tools::ToolError::Failed("aborted by the user".into()))),
                Err(reason) => Err(oc_tools::ToolError::Failed(reason)),
            };
        let (ok, preview) = match &executed {
            Ok(out) => (true, tool_output_preview(out)),
            Err(error) => (false, error.to_string()),
        };
        observer(RunEvent::ToolCallFinished {
            name: call.name.clone(),
            ok,
            preview,
        });
        let completed = now_ms();

        let history = store.messages(session_id)?;
        let mut msg = history
            .into_iter()
            .find(|m| message_id_of(m) == assistant_id)
            .ok_or_else(|| AgentError::ToolPartMissing(assistant_id.clone()))?;
        let Message::Assistant(a) = &mut msg else {
            continue;
        };
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
                content: Some(vec![ToolContent::Text {
                    text: e.to_string(),
                }]),
                metadata: None,
            },
        };
        store.replace_message(session_id, msg)?;
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

fn fold_usage(store: &Store, session_id: &str, resp: &LlmResponse) -> Result<(), AgentError> {
    if let Some(usage) = &resp.usage {
        // Pricing tables (models.dev) are not ported; cost stays 0 —
        // documented delta. Token totals still accumulate.
        store.add_usage(session_id, 0.0, usage)?;
    }
    Ok(())
}

/// Record a provider failure on a terminal assistant message for the step.
fn record_provider_failure(
    store: &Store,
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
            a.time.completed = Some(now);
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
    ask: Option<&PermissionAsk>,
) -> Result<(), String> {
    match permissions.decide(action, resource) {
        oc_permission::Effect::Allow => Ok(()),
        oc_permission::Effect::Deny => {
            Err(format!("permission denied by ruleset: {action} {resource}"))
        }
        oc_permission::Effect::Ask => match ask {
            Some(ask) if ask(action, resource) => Ok(()),
            Some(_) => Err(format!("permission denied by the user: {action} {resource}")),
            None => Err(format!(
                "permission requires interactive approval, which this runner cannot ask for: {action} {resource}"
            )),
        },
    }
}

fn tool_output_preview(output: &oc_tools::ToolOutput) -> String {
    output
        .content
        .iter()
        .map(|part| match part {
            ToolContent::Text { text } => text.clone(),
            ToolContent::File { mime, url } => format!("[file: {mime} {url}]"),
        })
        .collect::<Vec<_>>()
        .join("\n")
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
    use oc_schema::FinishReason;
    use oc_store::Store;

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
            Self {
                responses: std::sync::Mutex::new(vec![]),
                requests: std::sync::Mutex::new(vec![]),
                fail_with: Some(err),
            }
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

    fn session() -> (tempfile::TempDir, Store, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
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
        (dir, store, s.id)
    }

    fn model() -> ModelRef {
        ModelRef::parse("openai/gpt-test").unwrap()
    }

    struct ScriptedStreaming {
        responses:
            std::sync::Mutex<std::collections::VecDeque<Vec<Result<bytes::Bytes, ProviderError>>>>,
    }

    impl ScriptedStreaming {
        fn new(responses: Vec<Vec<Result<bytes::Bytes, ProviderError>>>) -> Arc<Self> {
            Arc::new(Self {
                responses: std::sync::Mutex::new(responses.into()),
            })
        }
    }

    #[async_trait]
    impl Transport for ScriptedStreaming {
        async fn post_json(
            &self,
            _url: &str,
            _headers: Vec<(String, String)>,
            _body: serde_json::Value,
        ) -> Result<serde_json::Value, ProviderError> {
            Err(ProviderError::Transport(
                "post_json must not be used when streaming".into(),
            ))
        }

        async fn post_stream(
            &self,
            _url: &str,
            _headers: Vec<(String, String)>,
            _body: serde_json::Value,
        ) -> Result<oc_provider::ByteStream, ProviderError> {
            let chunks = self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| ProviderError::Malformed("stream script exhausted".into()))?;
            Ok(Box::pin(futures_util::stream::iter(chunks)))
        }
    }

    fn sse(frames: &[serde_json::Value]) -> Vec<Result<bytes::Bytes, ProviderError>> {
        frames
            .iter()
            .map(|frame| Ok(bytes::Bytes::from(format!("data: {frame}\n\n"))))
            .collect()
    }

    fn done() -> Result<bytes::Bytes, ProviderError> {
        Ok(bytes::Bytes::from("data: [DONE]\n\n"))
    }

    fn event_recorder() -> (Observer, Arc<std::sync::Mutex<Vec<RunEvent>>>) {
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        (
            Arc::new(move |event| sink.lock().unwrap().push(event)),
            events,
        )
    }

    #[tokio::test]
    async fn streamed_tool_call_reasoning_and_observer_events() {
        let (dir, store, sid) = session();
        let tool_call = sse(&[
            serde_json::json!({ "choices": [ { "index": 0, "delta": { "reasoning_content": "plan" } } ] }),
            serde_json::json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
                { "index": 0, "id": "call_1", "type": "function", "function": { "name": "write", "arguments": "" } }
            ] } } ] }),
            serde_json::json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
                { "index": 0, "function": { "arguments": "{\"path\":\"note" } }
            ] } } ] }),
            serde_json::json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
                { "index": 0, "function": { "arguments": ".txt\",\"content\":\"hi\"}" } }
            ] } } ] }),
            serde_json::json!({ "choices": [ { "index": 0, "delta": {}, "finish_reason": "tool_calls" } ] }),
            serde_json::json!({ "choices": [ { "index": 0, "delta": {} } ], "usage": { "prompt_tokens": 10, "completion_tokens": 4 } }),
        ]);
        let mut first = tool_call;
        first.push(done());
        let mut second = sse(&[
            serde_json::json!({ "choices": [ { "index": 0, "delta": { "content": "done" } } ] }),
            serde_json::json!({ "choices": [ { "index": 0, "delta": {}, "finish_reason": "stop" } ] }),
            serde_json::json!({ "choices": [ { "index": 0, "delta": {} } ], "usage": { "prompt_tokens": 12, "completion_tokens": 2 } }),
        ]);
        second.push(done());
        let client = Client::with_transport(
            oc_provider::Endpoint {
                protocol: oc_provider::Protocol::OpenAI,
                base_url: "http://mock/v1".into(),
                api_key: None,
            },
            ScriptedStreaming::new(vec![first, second]),
        );
        let registry = Registry::builtin(dir.path());
        let (observer, events) = event_recorder();
        let out = prompt(
            &store,
            &registry,
            &client,
            &sid,
            model(),
            "write it",
            &RunOptions { observer, ..opts() },
        )
        .await
        .unwrap();
        assert_eq!(out.outcome, Outcome::Succeeded);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("note.txt")).unwrap(),
            "hi"
        );

        let events = events.lock().unwrap().clone();
        assert!(events.contains(&RunEvent::ReasoningDelta {
            delta: "plan".into()
        }));
        assert!(events.contains(&RunEvent::TextDelta {
            delta: "done".into()
        }));
        assert!(events.iter().any(|event| matches!(
            event,
            RunEvent::ToolCallStarted { name, input }
                if name == "write" && input["path"] == "note.txt" && input["content"] == "hi"
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            RunEvent::ToolCallFinished { name, ok: true, .. } if name == "write"
        )));
        let finished = events
            .iter()
            .filter(|event| matches!(event, RunEvent::StepFinished { .. }))
            .count();
        assert_eq!(finished, 2, "one step-finished event per provider step");
    }

    #[tokio::test]
    async fn stream_cut_before_finish_reason_fails_the_turn() {
        let (_dir, store, sid) = session();
        let chunks = sse(&[serde_json::json!({
            "choices": [ { "index": 0, "delta": { "content": "partial answer" } } ]
        })]);
        let client = Client::with_transport(
            oc_provider::Endpoint {
                protocol: oc_provider::Protocol::OpenAI,
                base_url: "http://mock/v1".into(),
                api_key: None,
            },
            ScriptedStreaming::new(vec![chunks]),
        );
        let registry = Registry::builtin(std::path::Path::new("/tmp"));
        let out = prompt(&store, &registry, &client, &sid, model(), "go", &opts())
            .await
            .unwrap();
        assert_eq!(out.outcome, Outcome::Failed);
        assert_eq!(
            store.get_session(&sid).unwrap().outcome,
            Some(Outcome::Failed)
        );
        let error = store
            .messages(&sid)
            .unwrap()
            .into_iter()
            .find_map(|message| match message {
                Message::Assistant(assistant) => assistant.error,
                _ => None,
            })
            .expect("provider failure recorded on an assistant message");
        assert_eq!(error.name, "ProviderError");
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
        let msgs = store.messages(&sid).unwrap();
        let kinds: Vec<&str> = msgs.iter().map(|m| kind(m)).collect();
        assert_eq!(kinds, ["user", "assistant", "idle"]);
        let s = store.get_session(&sid).unwrap();
        assert_eq!(s.outcome, Some(Outcome::Succeeded));
        assert_eq!(s.tokens.input, 10.0);
        assert_eq!(s.tokens.output, 5.0);
    }

    #[tokio::test]
    async fn tool_call_settles_then_text_arrives() {
        let (dir, store, sid) = session();
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
        let out = prompt(
            &store,
            &registry,
            &client,
            &sid,
            model(),
            "write note.txt",
            &opts(),
        )
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
        let msgs = store.messages(&sid).unwrap();
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
        let o = RunOptions {
            max_steps: Some(0),
            ..opts()
        };
        let out = prompt(&store, &registry, &client, &sid, model(), "go", &o)
            .await
            .unwrap();
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
            Arc::new(Scripted::failing(ProviderError::Http {
                status: 500,
                body: "boom".into(),
            })),
        );
        let registry = Registry::builtin(std::path::Path::new("/tmp"));
        let out = prompt(&store, &registry, &client, &sid, model(), "go", &opts())
            .await
            .unwrap();
        assert_eq!(out.outcome, Outcome::Failed);
        let s = store.get_session(&sid).unwrap();
        assert_eq!(s.outcome, Some(Outcome::Failed));
        let msgs = store.messages(&sid).unwrap();
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
        let o = RunOptions {
            abort: abort.clone(),
            ..opts()
        };
        let out = prompt(&store, &registry, &client, &sid, model(), "go", &o)
            .await
            .unwrap();
        assert_eq!(out.outcome, Outcome::Interrupted);
        let _ = &client; // scripted transport was empty: any call would fail the test via script exhaustion
    }

    #[test]
    fn build_default_permissions_ask_except_questions() {
        let rules = default_build_permissions();
        assert_eq!(
            rules.decide("shell", "rm -rf /"),
            oc_permission::Effect::Ask
        );
        assert_eq!(
            rules.decide("read", "src/main.rs"),
            oc_permission::Effect::Ask
        );
        assert_eq!(
            rules.decide("question", "continue?"),
            oc_permission::Effect::Allow
        );
    }

    #[test]
    fn transcript_mapping_matches_upstream_roles() {
        let store = Store::new();
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
        store
            .append_message(&s.id, |id, t| user_message("do it".into(), vec![], id, t))
            .unwrap();
        store
            .append_message(&s.id, |id, t| {
                oc_store::synthetic_message("context update", id, t)
            })
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
                        time: AssistantToolTime {
                            created: t,
                            ran: Some(t),
                            completed: Some(t),
                        },
                    })];
                    a.finish = Some(FinishReason::ToolCalls);
                }
                m
            })
            .unwrap();
        store
            .append_message(&s.id, |id, t| idle_message(Outcome::Succeeded, id, t))
            .unwrap();
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
        assert_eq!(
            kinds,
            ["user", "user", "assistant(1 calls)", "tool(call_9)"]
        );
    }
}

#[cfg(test)]
fn opts() -> RunOptions {
    RunOptions::default()
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
                    out.push(ChatMessage::User {
                        text: u.text.clone(),
                    });
                }
            }
            Message::Synthetic(s) => {
                out.push(ChatMessage::User {
                    text: s.text.clone(),
                });
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
                out.push(ChatMessage::Assistant {
                    text: text_opt,
                    tool_calls,
                });
                // tool results for executed parts, in part order
                for part in &a.content {
                    if let AssistantContent::Tool(tool) = part {
                        if tool.executed != Some(true) {
                            continue;
                        }
                        let content: Vec<ToolContent> = match &tool.state {
                            ToolState::Completed { content, .. } => content.clone(),
                            ToolState::Error { content, error, .. } => {
                                content.clone().unwrap_or_else(|| {
                                    vec![ToolContent::Text {
                                        text: error
                                            .message
                                            .clone()
                                            .unwrap_or_else(|| error.name.clone()),
                                    }]
                                })
                            }
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

/// The model-facing system prompt: the upstream harness text and tool
/// guidance, the date and environment block, plus the worktree's AGENTS.md
/// when present (upstream's instruction discovery, root file only).
pub fn system_prompt(model: &ModelRef, worktree: &std::path::Path) -> String {
    let mut s = String::from(
        "You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.\n\n\
         # Harness\n\
         - Responses are rendered as GitHub-flavored Markdown.\n\
         - `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.\n\
         - Prefer parallelizing independent tool calls.\n\
         - Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.\n\
         - Use the write tool to create files or completely replace their content; use edit for targeted changes.\n\
         - Keep shell commands short and non-interactive.\n\n\
         # Communication\n\
         - Use clear file paths when referring to files.\n\
         - Keep responses clear and concise, and avoid unnecessary technical jargon.\n\n\
         # Working in codebases\n\
         - Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.\n\
         - Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.\n",
    );
    s.push_str(&format!(
        "\nYou are powered by the model {}/{}.\nToday's date: {}.\n",
        model.provider_id,
        model.id,
        today_iso(),
    ));
    let git = worktree.join(".git").exists();
    s.push_str("\n<env>\n");
    s.push_str(&format!("  Working directory: {}\n", worktree.display()));
    s.push_str(&format!(
        "  Workspace root folder: {}\n",
        worktree.display()
    ));
    s.push_str(&format!(
        "  Is directory a git repo: {}\n",
        if git { "yes" } else { "no" }
    ));
    s.push_str(&format!("  Platform: {}\n", std::env::consts::OS));
    s.push_str("</env>\n");
    if let Some(instructions) = worktree_instructions(worktree) {
        s.push_str("\n# Project instructions\n\n");
        s.push_str(&instructions);
        s.push('\n');
    }
    s
}

/// AGENTS.md content at the worktree root, if any — the instruction file the
/// upstream loader feeds into the prompt verbatim.
pub fn worktree_instructions(worktree: &std::path::Path) -> Option<String> {
    let path = worktree.join("AGENTS.md");
    std::fs::read_to_string(path)
        .ok()
        .filter(|s| !s.trim().is_empty())
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
/// unset), and the key from `OC_API_KEY`, `OC_API_KEY_FILE`, or the
/// provider's conventional variable (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).
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
    let api_key = api_key_from_env(conventional_key);
    oc_provider::Endpoint {
        protocol,
        base_url,
        api_key,
    }
}

/// The key from `OC_API_KEY`, else `OC_API_KEY_FILE` (trimmed), else the
/// provider's conventional variable. The value is never logged.
pub fn api_key_from_env(conventional_key: &str) -> Option<String> {
    std::env::var("OC_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var("OC_API_KEY_FILE")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .and_then(|path| std::fs::read_to_string(path).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| std::env::var(conventional_key).ok())
        .filter(|s| !s.trim().is_empty())
}

/// `OC_EXTRA_BODY`: a JSON object merged into the top level of each chat
/// request body. Invalid JSON is ignored (with a warning, never the value).
pub fn extra_body_from_env() -> Option<serde_json::Value> {
    let raw = std::env::var("OC_EXTRA_BODY").ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) if value.is_object() => Some(value),
        _ => {
            tracing::warn!("OC_EXTRA_BODY is not a JSON object; ignoring it");
            None
        }
    }
}

/// A client for the configured endpoint, with `OC_EXTRA_BODY` applied.
pub fn client_from_env() -> Client {
    let client = Client::new(endpoint_from_env());
    match extra_body_from_env() {
        Some(extra) => client.with_extra_body(extra),
        None => client,
    }
}

/// `OC_PERMISSIONS`: an inline JSON ruleset (`[{"action":..,"resource":..,
/// "effect":..}]`) or a path to a file holding one. Unset = allow-all (the
/// server's historic headless default).
pub fn permissions_from_env() -> oc_permission::Ruleset {
    let raw = std::env::var("OC_PERMISSIONS").unwrap_or_default();
    let raw = raw.trim();
    if raw.is_empty() {
        return allow_all_permissions();
    }
    let json = if raw.starts_with('[') {
        raw.to_string()
    } else {
        std::fs::read_to_string(raw).unwrap_or_default()
    };
    serde_json::from_str(&json).unwrap_or_else(|e| {
        tracing::warn!("bad OC_PERMISSIONS ruleset ({e}); running with allow-all");
        allow_all_permissions()
    })
}

/// Upstream's build-agent defaults: its only granted action is `question`,
/// and `Permission.evaluate` falls back to `ask` for everything else.
pub fn default_build_permissions() -> oc_permission::Ruleset {
    use oc_permission::{Effect, Rule, Ruleset};
    Ruleset {
        rules: vec![Rule {
            action: "question".into(),
            resource: "*".into(),
            effect: Effect::Allow,
        }],
    }
}

/// Permissions for embedded mode: `OC_PERMISSIONS` when set, else the
/// upstream build-agent default (every action asks).
pub fn embedded_permissions_from_env() -> oc_permission::Ruleset {
    let unset = std::env::var("OC_PERMISSIONS")
        .map(|raw| raw.trim().is_empty())
        .unwrap_or(true);
    if unset {
        default_build_permissions()
    } else {
        permissions_from_env()
    }
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
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let parent = {
            store
                .create_session(oc_store::CreateInput {
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
            Endpoint {
                protocol: Protocol::OpenAI,
                base_url: "http://mock/v1".into(),
                api_key: None,
            },
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
        let out = prompt(
            &store,
            &registry,
            &client,
            &parent.id,
            model,
            "delegate the probe",
            &opts(),
        )
        .await
        .unwrap();

        assert_eq!(out.outcome, Outcome::Succeeded);
        assert_eq!(out.text.as_deref(), Some("parent wrapped: child finished"));

        // a child session exists under the parent with its own transcript
        let children = store.list_sessions(&oc_schema::SessionListFilter {
            parent_id: Some(Some(parent.id.clone())),
            ..Default::default()
        });
        assert_eq!(children.sessions.len(), 1, "exactly one child session");
        let child = &children.sessions[0];
        assert_eq!(child.title.as_deref(), Some("probe the repo"));
        let child_msgs = store.messages(&child.id).unwrap();
        let child_kinds: Vec<&str> = child_msgs.iter().map(kind).collect();
        assert_eq!(child_kinds, ["user", "assistant", "idle"]);
        let parent_msgs = store.messages(&parent.id).unwrap();
        let parent_kinds: Vec<&str> = parent_msgs.iter().map(kind).collect();
        assert_eq!(parent_kinds, ["user", "assistant", "assistant", "idle"]);
        // the parent's tool part carries the child's answer
        for m in &parent_msgs {
            if let Message::Assistant(a) = m {
                for part in &a.content {
                    if let AssistantContent::Tool(t) = part {
                        match &t.state {
                            ToolState::Completed { content, .. } => {
                                let oc_schema::ToolContent::Text { text } = &content[0] else {
                                    panic!()
                                };
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
        let store = Store::open(dir.path()).unwrap();
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
            Endpoint {
                protocol: Protocol::OpenAI,
                base_url: "http://mock/v1".into(),
                api_key: None,
            },
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
        let o = RunOptions {
            permissions,
            ..opts()
        };
        let out = prompt(
            &store,
            &registry,
            &client,
            &sid,
            ModelRef::parse("openai/gpt-test").unwrap(),
            "go",
            &o,
        )
        .await
        .unwrap();
        assert_eq!(out.outcome, Outcome::Succeeded);
        let msgs = store.messages(&sid).unwrap();
        for m in &msgs {
            if let Message::Assistant(a) = m {
                for part in &a.content {
                    if let AssistantContent::Tool(t) = part {
                        assert_eq!(t.executed, Some(true));
                        match &t.state {
                            ToolState::Error { error, content, .. } => {
                                assert_eq!(error.name, "ToolError");
                                let Some(vec) = content else {
                                    panic!("error text missing")
                                };
                                let oc_schema::ToolContent::Text { text } = &vec[0] else {
                                    panic!()
                                };
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
