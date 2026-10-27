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
use tokio::sync::RwLock;

use crate::RunOptions;

pub const TASK_NAME: &str = "task";
pub const TASK_DESCRIPTION: &str = "Delegate a task to a specialized subagent: it runs in its own session (recorded under this one) with its own context window, and its final answer comes back as this tool's result. Use it for self-contained work that would flood this conversation — an investigation, a bulk refactor, a long search — and prefer one subagent per independent task. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.";

pub struct TaskTool {
    store: Arc<RwLock<Store>>,
    client: Arc<Client>,
    /// The registry the CHILD runs with — must not contain another task tool
    /// (the port caps delegation at one level).
    tools: Arc<Registry>,
    model: ModelRef,
    agent: String,
    max_steps: Option<u32>,
}

impl TaskTool {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Arc<RwLock<Store>>,
        client: Arc<Client>,
        tools: Arc<Registry>,
        model: ModelRef,
        agent: String,
        max_steps: Option<u32>,
    ) -> Self {
        Self { store, client, tools, model, agent, max_steps }
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

    async fn execute(&self, input: &serde_json::Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
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
        let info = {
            let mut store = self.store.write().await;
            store
                .create_session(oc_store::CreateInput {
                    title: Some(description.to_string()),
                    parent_id: Some(ctx.session_id.clone()),
                    agent: Some(agent.clone()),
                    model: Some(model.clone()),
                    directory: ctx.worktree.to_string_lossy().into_owned(),
                    project_id: "global".into(),
                })
                .map_err(|e| ToolError::Failed(e.to_string()))?
        };
        let opts = RunOptions {
            agent,
            max_steps: self.max_steps,
            abort: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            permissions: oc_permission::Ruleset::default(),
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
            format!("the subagent finished with outcome {:?} without writing a final answer", output.outcome)
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
