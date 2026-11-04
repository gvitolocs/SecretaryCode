//! The `task` (subagent) tool — port of
//! `packages/core/src/tool/plugin/subagent.ts`, synchronous variant: spawn a
//! child session under the current one, run the prompt through the same
//! runner with a restricted registry (no nested `task` — the port caps
//! delegation at one level, where upstream allows configured depth), and
//! return the child's final text to the calling model.

use std::sync::Arc;

use async_trait::async_trait;
use oc_provider::Client;
use oc_schema::{ModelRef, ToolDef};
use oc_store::Store;
use oc_tools::{Registry, Tool, ToolContext, ToolError, ToolOutput};

use crate::RunOptions;

pub const TASK_NAME: &str = "task";
pub const TASK_DESCRIPTION: &str = "Delegate a task to a specialized subagent: it runs in its own session (recorded under this one) with its own context window, and its final answer comes back as this tool's result. Use it for self-contained work that would flood this conversation — an investigation, a bulk refactor, a long search — and prefer one subagent per independent task. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.";

pub struct TaskTool {
    store: Arc<Store>,
    client: Arc<Client>,
    /// The registry the CHILD runs with — must not contain another task tool
    /// (the port caps delegation at one level).
    tools: Arc<Registry>,
    model: ModelRef,
    agent: String,
    max_steps: Option<u32>,
    options: RunOptions,
}

impl TaskTool {
    /// Child executions inherit the caller's permissions, cancellation and model settings.
    pub fn with_options(mut self, options: &RunOptions) -> Self {
        self.options = options.clone();
        self
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Arc<Store>,
        client: Arc<Client>,
        tools: Arc<Registry>,
        model: ModelRef,
        agent: String,
        max_steps: Option<u32>,
    ) -> Self {
        Self {
            store,
            client,
            tools,
            model,
            agent,
            max_steps,
            options: RunOptions::default(),
        }
    }
}

#[async_trait]
impl Tool for TaskTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: TASK_NAME.into(),
            description: TASK_DESCRIPTION.into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "agent": {"type": "string", "description": "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead."},
                    "description": {"type": "string", "description": "A short 3-5 word label for the task, displayed to the user"},
                    "prompt": {"type": "string", "description": "The task for the subagent to perform"},
                    "model": {"type": "string", "description": "NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as \"providerID/modelID\". Do not guess the ID."}
                },
                "required": ["description", "prompt"]
            }),
        }
    }

    async fn execute(
        &self,
        input: &serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let description = input
            .get("description")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::Failed("missing required field: description".into()))?;
        let prompt = input
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::Failed("missing required field: prompt".into()))?;
        let agent = input
            .get("agent")
            .and_then(|v| v.as_str())
            .unwrap_or(&self.agent)
            .to_string();
        let mut model = self.model.clone();
        if let Some(m) = input.get("model").and_then(|v| v.as_str()) {
            model = ModelRef::parse(m)
                .map_err(|e| ToolError::Failed(format!("bad model ref {m:?}: {e}")))?;
        }

        // child session under the caller, in the caller's worktree
        let info = self
            .store
            .create_session(oc_store::CreateInput {
                title: Some(description.to_string()),
                parent_id: Some(ctx.session_id.clone()),
                agent: Some(agent.clone()),
                model: Some(model.clone()),
                directory: ctx.worktree.to_string_lossy().into_owned(),
                project_id: "global".into(),
            })
            .map_err(|e| ToolError::Failed(e.to_string()))?;
        let opts = RunOptions {
            agent,
            max_steps: self.max_steps,
            ..self.options.clone()
        };
        let output = crate::prompt(
            &self.store,
            &self.tools,
            &self.client,
            &info.id,
            model,
            prompt,
            &opts,
        )
        .await
        .map_err(|e| ToolError::Failed(format!("subagent failed: {e}")))?;

        let text = output.text.clone().unwrap_or_else(|| {
            format!(
                "the subagent finished with outcome {:?} without writing a final answer",
                output.outcome
            )
        });
        let out = ToolOutput::text(format!(
            "{}\n\n[subagent session {} — {} in {} steps]",
            text,
            info.id,
            match output.outcome {
                oc_schema::Outcome::Succeeded => "succeeded",
                oc_schema::Outcome::Failed => "failed",
                oc_schema::Outcome::Interrupted => "interrupted",
            },
            output.steps
        ));
        let _ = &out.content;
        let mut out = out;
        out.metadata = Some(serde_json::json!({
            "sessionID": info.id,
            "outcome": output.outcome,
            "steps": output.steps,
        }));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oc_provider::{Endpoint, Protocol, ProviderError, Transport};
    use oc_schema::{AssistantContent, Message, Outcome, ToolState};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };

    struct Scripted(Mutex<std::collections::VecDeque<serde_json::Value>>);

    #[async_trait]
    impl Transport for Scripted {
        async fn post_json(
            &self,
            _url: &str,
            _headers: Vec<(String, String)>,
            _body: serde_json::Value,
        ) -> Result<serde_json::Value, ProviderError> {
            self.0
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| ProviderError::Malformed("unexpected provider request".into()))
        }
    }

    fn setup(
        options: &RunOptions,
        responses: Vec<serde_json::Value>,
    ) -> (
        tempfile::TempDir,
        Arc<Store>,
        TaskTool,
        ToolContext,
        Arc<Scripted>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let parent = store
            .create_session(oc_store::CreateInput {
                title: None,
                parent_id: None,
                agent: None,
                model: None,
                directory: dir.path().to_string_lossy().into_owned(),
                project_id: "global".into(),
            })
            .unwrap();
        let transport = Arc::new(Scripted(Mutex::new(responses.into())));
        let client = Arc::new(Client::with_transport(
            Endpoint {
                protocol: Protocol::OpenAI,
                base_url: "http://mock/v1".into(),
                api_key: None,
            },
            transport.clone(),
        ));
        let tool = TaskTool::new(
            store.clone(),
            client,
            Arc::new(Registry::builtin(dir.path())),
            ModelRef::parse("openai/test").unwrap(),
            "build".into(),
            None,
        )
        .with_options(options);
        let ctx = ToolContext {
            worktree: dir.path().to_path_buf(),
            session_id: parent.id,
            call_id: "task-test".into(),
        };
        (dir, store, tool, ctx, transport)
    }

    #[tokio::test]
    async fn parent_abort_interrupts_child_before_provider_request() {
        let options = RunOptions {
            abort: Arc::new(AtomicBool::new(true)),
            ..RunOptions::default()
        };
        let (_dir, _store, tool, ctx, _transport) = setup(&options, vec![]);
        let out = tool
            .execute(
                &serde_json::json!({"description":"cancelled child","prompt":"do nothing"}),
                &ctx,
            )
            .await
            .unwrap();
        let meta = out.metadata.unwrap();
        assert_eq!(
            serde_json::from_value::<Outcome>(meta["outcome"].clone()).unwrap(),
            Outcome::Interrupted
        );
        assert_eq!(meta["steps"], 0);
        assert!(options.abort.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn parent_denied_write_preserves_file_and_records_child_tool_error() {
        let options = RunOptions {
            permissions: oc_permission::Ruleset {
                rules: vec![oc_permission::Rule {
                    action: "write".into(),
                    resource: "*".into(),
                    effect: oc_permission::Effect::Deny,
                }],
            },
            ..RunOptions::default()
        };
        let responses = vec![
            serde_json::json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{
                "id":"write1","type":"function","function":{"name":"write","arguments":
                r#"{"path":"guard.txt","content":"changed"}"#}}]},"finish_reason":"tool_calls"}]}),
            serde_json::json!({"choices":[{"message":{"role":"assistant","content":"write refused"},"finish_reason":"stop"}]}),
        ];
        let (dir, store, tool, ctx, transport) = setup(&options, responses);
        let guard = dir.path().join("guard.txt");
        std::fs::write(&guard, "original").unwrap();
        let out = tool
            .execute(
                &serde_json::json!({"description":"denied write","prompt":"overwrite guard.txt"}),
                &ctx,
            )
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(guard).unwrap(), "original");
        assert!(
            transport.0.lock().unwrap().is_empty(),
            "both scripted model responses must be consumed"
        );
        let meta = out.metadata.unwrap();
        let sid = meta["sessionID"].as_str().unwrap();
        let mut denied = false;
        for message in store.messages(sid).unwrap() {
            if let Message::Assistant(message) = message {
                for part in message.content {
                    if let AssistantContent::Tool(part) = part {
                        if let ToolState::Error {
                            content: Some(content),
                            ..
                        } = part.state
                        {
                            denied |= content.iter().any(|c| matches!(c, oc_schema::ToolContent::Text { text } if text.contains("permission denied")));
                        }
                    }
                }
            }
        }
        assert!(denied, "child transcript must record the denied write");
    }
}
