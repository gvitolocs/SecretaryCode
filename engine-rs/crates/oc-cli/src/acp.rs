//! `oc-cli acp`: LucinaCode as an Agent Client Protocol agent over stdio.
//!
//! One JSON-RPC 2.0 object per line on stdin/stdout (logs go to stderr).
//! Behaviour is ported from upstream OpenCode's `packages/cli/src/acp/`
//! (agent.ts, service.ts, turn.ts, permission.ts, tool.ts, content.ts,
//! replay.ts, error.ts), subset: initialize, session/new, session/load,
//! session/prompt, session/cancel.
//!
//! The loop runs on a multi-threaded runtime of its own: `PermissionAsk` is
//! a synchronous callback, so an `ask` rule blocks its worker thread on a
//! std channel until the client's `session/request_permission` response
//! arrives on stdin. On a current-thread runtime that would deadlock the
//! stdin reader; here the reader and the main loop run on other workers.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use oc_agent::compaction::Settings;
use oc_agent::{Observer, RunEvent, RunOptions};
use oc_schema::{AssistantContent, Message, Outcome, ToolState};
use oc_store::{CreateInput, Store};
use oc_tools::Registry;

/// Entry point: build the runtime and serve until stdin closes.
pub fn run() -> i32 {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .max(2);
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("acp: cannot start the runtime: {e}");
            return 2;
        }
    };
    runtime.block_on(serve())
}

/// Serializes every write to stdout; only JSON-RPC ever goes there.
struct Out {
    stdout: Mutex<std::io::Stdout>,
}

impl Out {
    fn send(&self, value: &serde_json::Value) {
        let mut line = serde_json::to_string(value).unwrap_or_else(|_| "{}".into());
        line.push('\n');
        let mut stdout = self.stdout.lock().unwrap();
        let _ = stdout.write_all(line.as_bytes());
        let _ = stdout.flush();
    }

    fn session_update(&self, session_id: &str, update: serde_json::Value) {
        self.send(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": session_id, "update": update },
        }));
    }
}

/// State shared with the synchronous permission callback.
struct Shared {
    out: Arc<Out>,
    /// Client responses to our own requests (session/request_permission),
    /// keyed by request id.
    pending: HashMap<i64, PendingPermission>,
    next_request_id: i64,
}

/// One open `session/request_permission`: the session it belongs to and the
/// channel the client's response — or a cancel — is delivered on.
struct PendingPermission {
    session_id: String,
    tx: std::sync::mpsc::Sender<serde_json::Value>,
}

struct Session {
    cwd: PathBuf,
    abort: Arc<AtomicBool>,
    running: bool,
    /// `allow_always` grants for the rest of the session: (action, resource).
    always: Arc<Mutex<Vec<(String, String)>>>,
}

/// One running turn: the request id to answer and the session it runs for.
struct TurnEnd {
    request_id: serde_json::Value,
    session_id: String,
    result: Result<oc_agent::RunOutput, oc_agent::AgentError>,
}

struct Agent {
    store: Arc<Store>,
    shared: Arc<Mutex<Shared>>,
    sessions: HashMap<String, Session>,
}

enum Incoming {
    Line(serde_json::Result<serde_json::Value>),
}

async fn serve() -> i32 {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Incoming>(64);
    tokio::spawn(async move {
        loop {
            match read_stdin_line().await {
                Ok(Some(line)) => {
                    if tx
                        .send(Incoming::Line(serde_json::from_str(&line)))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
    });

    let store = match std::env::var("OC_DATA") {
        Ok(dir) if !dir.trim().is_empty() => match Store::open(std::path::Path::new(&dir)) {
            Ok(store) => Arc::new(store),
            Err(e) => {
                eprintln!("acp: open {dir}: {e}");
                return 2;
            }
        },
        _ => Arc::new(Store::new()),
    };
    let shared = Arc::new(Mutex::new(Shared {
        out: Arc::new(Out {
            stdout: Mutex::new(std::io::stdout()),
        }),
        pending: HashMap::new(),
        next_request_id: 0,
    }));
    let mut agent = Agent {
        store,
        shared,
        sessions: HashMap::new(),
    };

    // One turn per session at a time, but several sessions may run at once:
    // every running turn is kept here until it finishes and answers on its
    // own, while stdin is still read so permission responses and cancels
    // reach the turns.
    let mut turns: tokio::task::JoinSet<TurnEnd> = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            incoming = rx.recv() => match incoming {
                None => break,
                Some(Incoming::Line(parsed)) => {
                    agent.handle_line(parsed, &mut turns).await;
                }
            },
            end = turns.join_next(), if !turns.is_empty() => match end {
                Some(Ok(end)) => agent.finish_turn(end).await,
                Some(Err(e)) => eprintln!("acp: turn task ended: {e}"),
                None => {}
            },
        }
    }
    0
}

impl Agent {
    fn out(&self) -> Arc<Out> {
        self.shared.lock().unwrap().out.clone()
    }

    fn respond(&self, id: &serde_json::Value, result: serde_json::Value) {
        self.out().send(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }));
    }

    fn respond_error(&self, id: &serde_json::Value, code: i64, message: &str) {
        self.out().send(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }));
    }

    /// Handle one stdin line, spawning a turn into `turns` when the line was
    /// a `session/prompt` that started running.
    async fn handle_line(
        &mut self,
        parsed: serde_json::Result<serde_json::Value>,
        turns: &mut tokio::task::JoinSet<TurnEnd>,
    ) {
        let msg = match parsed {
            Ok(msg) => msg,
            Err(_) => {
                self.respond_error(&serde_json::Value::Null, -32700, "parse error");
                return;
            }
        };
        let id = msg.get("id").cloned();
        let method = msg
            .get("method")
            .and_then(|m| m.as_str())
            .map(str::to_string);
        // A response to one of our own requests (e.g. request_permission).
        if let (Some(id), None) = (&id, &method) {
            if let Some(request_id) = id.as_i64() {
                let pending = self.shared.lock().unwrap().pending.remove(&request_id);
                if let Some(pending) = pending {
                    let _ = pending.tx.send(msg);
                    return;
                }
            }
        }
        let Some(method) = method else {
            return;
        };
        let params = msg
            .get("params")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        match method.as_str() {
            "initialize" => {
                self.respond(
                    &id.unwrap_or(serde_json::Value::Null),
                    serde_json::json!({
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "loadSession": true,
                            "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true },
                        },
                        "authMethods": [],
                    }),
                );
            }
            "session/new" => {
                self.session_new(&id.unwrap_or(serde_json::Value::Null), &params);
            }
            "session/load" => {
                self.session_load(&id.unwrap_or(serde_json::Value::Null), &params);
            }
            "session/prompt" => {
                self.session_prompt(&id.unwrap_or(serde_json::Value::Null), &params, turns);
            }
            "session/cancel" => {
                if let Some(session_id) = params.get("sessionId").and_then(|s| s.as_str()) {
                    if let Some(session) = self.sessions.get(session_id) {
                        session.abort.store(true, Ordering::Relaxed);
                    }
                    // A pending permission ask blocks its worker on a channel;
                    // resolve this session's open requests as cancelled so the
                    // ask refuses and the turn can end.
                    let mut shared = self.shared.lock().unwrap();
                    let open: Vec<i64> = shared
                        .pending
                        .iter()
                        .filter(|(_, p)| p.session_id == session_id)
                        .map(|(request_id, _)| *request_id)
                        .collect();
                    for request_id in open {
                        if let Some(pending) = shared.pending.remove(&request_id) {
                            let _ = pending.tx.send(serde_json::json!({
                                "result": { "outcome": { "outcome": "cancelled" } }
                            }));
                        }
                    }
                }
            }
            _ => {
                if let Some(id) = id {
                    self.respond_error(&id, -32601, "method not found");
                }
            }
        }
    }

    fn session_new(&mut self, id: &serde_json::Value, params: &serde_json::Value) {
        let cwd = params
            .get("cwd")
            .and_then(|c| c.as_str())
            .map(PathBuf::from)
            .or_else(|| std::env::var("OC_CWD").ok().map(PathBuf::from))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let cwd = std::fs::canonicalize(&cwd).unwrap_or(cwd);
        let model = oc_agent::model_from_env();
        let title = cwd
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "acp".into());
        let created = self.store.create_session(CreateInput {
            title: Some(title),
            parent_id: None,
            agent: Some("build".into()),
            model: Some(model),
            directory: cwd.to_string_lossy().into_owned(),
            project_id: "global".into(),
        });
        match created {
            Ok(info) => {
                self.sessions.insert(
                    info.id.clone(),
                    Session {
                        cwd,
                        abort: Arc::new(AtomicBool::new(false)),
                        running: false,
                        always: Arc::new(Mutex::new(Vec::new())),
                    },
                );
                self.respond(id, serde_json::json!({ "sessionId": info.id }));
            }
            Err(e) => self.respond_error(id, -32603, &format!("create session: {e}")),
        }
    }

    fn session_load(&mut self, id: &serde_json::Value, params: &serde_json::Value) {
        let Some(session_id) = params.get("sessionId").and_then(|s| s.as_str()) else {
            self.respond_error(id, -32602, "session/load needs sessionId");
            return;
        };
        let info = match self.store.get_session(session_id) {
            Ok(info) => info,
            Err(_) => {
                self.respond_error(id, -32602, &format!("session not found: {session_id}"));
                return;
            }
        };
        self.sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Session {
                cwd: PathBuf::from(&info.location.directory),
                abort: Arc::new(AtomicBool::new(false)),
                running: false,
                always: Arc::new(Mutex::new(Vec::new())),
            });
        // Replay the stored history as session/update notifications.
        if let Ok(messages) = self.store.messages(session_id) {
            for message in &messages {
                for update in replay_updates(message) {
                    self.out().session_update(session_id, update);
                }
            }
        }
        self.respond(id, serde_json::Value::Null);
    }

    fn session_prompt(
        &mut self,
        id: &serde_json::Value,
        params: &serde_json::Value,
        turns: &mut tokio::task::JoinSet<TurnEnd>,
    ) {
        let Some(session_id) = params
            .get("sessionId")
            .and_then(|s| s.as_str())
            .map(str::to_string)
        else {
            self.respond_error(id, -32602, "session/prompt needs sessionId");
            return;
        };
        let Some(session) = self.sessions.get_mut(&session_id) else {
            self.respond_error(id, -32602, &format!("session not found: {session_id}"));
            return;
        };
        if session.running {
            self.respond_error(
                id,
                -32603,
                &format!("Session already has an active ACP prompt: {session_id}"),
            );
            return;
        }
        let text = prompt_text(params.get("prompt"));
        let cwd = session.cwd.clone();
        let abort = session.abort.clone();
        let always = session.always.clone();
        session.running = true;

        let shared = self.shared.clone();
        let out = self.out();
        let session_for_events = session_id.clone();
        let observer: Observer = Arc::new(move |event| match event {
            RunEvent::TextDelta { delta } => out.session_update(
                &session_for_events,
                serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": delta },
                }),
            ),
            RunEvent::ReasoningDelta { delta } => out.session_update(
                &session_for_events,
                serde_json::json!({
                    "sessionUpdate": "agent_thought_chunk",
                    "content": { "type": "text", "text": delta },
                }),
            ),
            RunEvent::ToolCallStarted {
                call_id,
                name,
                input,
            } => {
                out.session_update(
                    &session_for_events,
                    serde_json::json!({
                        "sessionUpdate": "tool_call",
                        "toolCallId": call_id,
                        "title": tool_title(&name, &input),
                        "kind": tool_kind(&name),
                        "status": "pending",
                        "rawInput": input,
                    }),
                );
            }
            RunEvent::ToolCallFinished {
                call_id,
                ok,
                preview,
                ..
            } => {
                out.session_update(
                    &session_for_events,
                    serde_json::json!({
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": call_id,
                        "status": if ok { "completed" } else { "failed" },
                        "content": [{ "type": "content", "content": { "type": "text", "text": preview } }],
                        "rawOutput": { "output": preview },
                    }),
                );
            }
            _ => {}
        });
        let ask_session = session_id.clone();
        let ask_cwd = cwd.clone();
        let permission_ask: oc_agent::PermissionAsk = Arc::new(move |request| {
            ask_permission(&shared, &ask_session, &always, &ask_cwd, request)
        });

        let opts = RunOptions {
            agent: "build".into(),
            max_steps: oc_agent::max_steps_from_env(),
            abort,
            permissions: acp_permissions_from_env(),
            observer,
            permission_ask: Some(permission_ask),
            compaction: Settings::from_env(),
            retries: &oc_agent::RETRY_SCHEDULE,
            replay_reasoning: oc_agent::reasoning_replay_from_env(),
            ..RunOptions::default()
        };
        let registry = Registry::builtin(&cwd);
        let client = Arc::new(oc_agent::client_from_env());
        let model = oc_agent::model_from_env();
        let registry = oc_agent::with_task_tool(
            &registry,
            self.store.clone(),
            client.clone(),
            model.clone(),
            &opts,
        );
        let store = self.store.clone();
        let request_id = id.clone();
        turns.spawn(async move {
            let result =
                oc_agent::prompt(&store, &registry, &client, &session_id, model, &text, &opts)
                    .await;
            TurnEnd {
                request_id,
                session_id,
                result,
            }
        });
    }

    async fn finish_turn(&mut self, end: TurnEnd) {
        if let Some(session) = self.sessions.get_mut(&end.session_id) {
            session.running = false;
        }
        match end.result {
            Ok(output) => {
                let stop_reason = match output.outcome {
                    Outcome::Interrupted => "cancelled",
                    Outcome::Succeeded => {
                        if oc_agent::max_steps_from_env().is_some_and(|limit| output.steps >= limit)
                        {
                            "max_turn_requests"
                        } else if last_finish_is_length(&self.store, &end.session_id) {
                            "max_tokens"
                        } else {
                            "end_turn"
                        }
                    }
                    Outcome::Failed => "end_turn",
                };
                self.respond(
                    &end.request_id,
                    serde_json::json!({ "stopReason": stop_reason }),
                );
            }
            Err(e) => {
                self.respond_error(&end.request_id, -32603, &format!("turn failed: {e}"));
            }
        }
    }
}

/// Text of a `session/prompt` prompt: text blocks joined with newlines;
/// `resource` blocks contribute `[uri]\ntext` as upstream content.ts does;
/// other block types are ignored.
fn prompt_text(prompt: Option<&serde_json::Value>) -> String {
    let Some(blocks) = prompt.and_then(|p| p.as_array()) else {
        return String::new();
    };
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    parts.push(text.to_string());
                }
            }
            Some("resource") => {
                if let Some(resource) = block.get("resource") {
                    if let (Some(uri), Some(text)) = (
                        resource.get("uri").and_then(|u| u.as_str()),
                        resource.get("text").and_then(|t| t.as_str()),
                    ) {
                        parts.push(format!("[{uri}]\n{text}"));
                    }
                }
            }
            _ => {}
        }
    }
    parts.join("\n")
}

/// Upstream tool.ts `toToolKind`.
fn tool_kind(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "shell" | "bash" => "execute",
        "webfetch" => "fetch",
        "edit" | "patch" | "write" => "edit",
        "grep" | "glob" => "search",
        "read" => "read",
        "task" | "subagent" => "think",
        _ => "other",
    }
}

/// Upstream tool.ts `toolTitle`: the shell command, else the tool name.
fn tool_title(name: &str, input: &serde_json::Value) -> String {
    if name == "shell" {
        input
            .get("command")
            .and_then(|c| c.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| name.to_string())
    } else {
        name.to_string()
    }
}

/// The `session/request_permission` options, as upstream permission.ts.
fn permission_options() -> serde_json::Value {
    serde_json::json!([
        { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
        { "optionId": "allow_always", "name": "Always allow", "kind": "allow_always" },
        { "optionId": "reject_once", "name": "Reject", "kind": "reject_once" },
    ])
}

/// Synchronous `PermissionAsk`: send `session/request_permission` describing
/// the pending tool call and block on a std channel until the client's
/// response is routed back by the main loop — or the session is cancelled,
/// which completes the channel with a cancelled outcome. Runs on a
/// multi-threaded runtime worker, so the stdin reader keeps running on
/// another worker.
fn ask_permission(
    shared: &Arc<Mutex<Shared>>,
    session_id: &str,
    always: &Arc<Mutex<Vec<(String, String)>>>,
    cwd: &std::path::Path,
    request: &oc_agent::PermissionRequest,
) -> bool {
    if always
        .lock()
        .unwrap()
        .iter()
        .any(|(a, r)| a == &request.action && r == &request.resource)
    {
        return true;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let request_id = {
        let mut shared = shared.lock().unwrap();
        shared.next_request_id += 1;
        let id = shared.next_request_id;
        shared.pending.insert(
            id,
            PendingPermission {
                session_id: session_id.to_string(),
                tx,
            },
        );
        id
    };
    // The request describes the real pending tool call, as the `tool_call`
    // notification already announced it.
    let mut tool_call = serde_json::json!({
        "toolCallId": request.call_id,
        "title": tool_title(&request.tool, &request.input),
        "kind": tool_kind(&request.tool),
        "status": "pending",
        "rawInput": request.input,
    });
    if let Some(diff) = file_diff(cwd, &request.tool, &request.input) {
        tool_call["content"] = serde_json::json!([diff]);
    }
    shared.lock().unwrap().out.send(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "session/request_permission",
        "params": {
            "sessionId": session_id,
            "toolCall": tool_call,
            "options": permission_options(),
        },
    }));
    let response = match rx.recv() {
        Ok(response) => response,
        // The channel was dropped without an answer (e.g. the session went
        // away): refuse.
        Err(_) => return false,
    };
    let selected = response
        .get("result")
        .and_then(|r| r.get("outcome"))
        .and_then(|o| o.as_object())
        .and_then(|o| {
            if o.get("outcome").and_then(|v| v.as_str()) == Some("selected") {
                o.get("optionId").and_then(|v| v.as_str())
            } else {
                None
            }
        });
    match selected {
        Some("allow_once") => true,
        Some("allow_always") => {
            always
                .lock()
                .unwrap()
                .push((request.action.clone(), request.resource.clone()));
            true
        }
        _ => false,
    }
}

/// The `{"type":"diff",...}` content of a permission request for a tool that
/// changes files, as upstream permission.ts: computed before the tool runs by
/// applying the edit to the current file text in memory (the file is not
/// written). `None` when it cannot be computed — the request still goes out.
/// (The builtin registry has `edit` and `write`; there is no patch/multiedit.)
fn file_diff(
    cwd: &std::path::Path,
    tool: &str,
    input: &serde_json::Value,
) -> Option<serde_json::Value> {
    let raw_path = input.get("path").and_then(|p| p.as_str())?;
    let path = {
        let p = std::path::Path::new(raw_path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        }
    };
    match tool {
        "write" => {
            let content = input.get("content").and_then(|c| c.as_str())?;
            let old_text = std::fs::read_to_string(&path).ok();
            Some(serde_json::json!({
                "type": "diff",
                "path": path.to_string_lossy(),
                "oldText": old_text,
                "newText": content,
            }))
        }
        "edit" => {
            let old_string = input.get("oldString").and_then(|s| s.as_str())?;
            let new_string = input.get("newString").and_then(|s| s.as_str())?;
            let replace_all = input
                .get("replaceAll")
                .and_then(|r| r.as_bool())
                .unwrap_or(false);
            if old_string == new_string {
                return None;
            }
            let bytes = std::fs::read(&path).ok()?;
            let original = String::from_utf8_lossy(&bytes).into_owned();
            let count = original.matches(old_string).count();
            if count == 0 || (count > 1 && !replace_all) {
                return None;
            }
            // Same trailing-newline handling as the edit tool, so newText is
            // exactly what the tool would write.
            let mut replacement = new_string.to_string();
            if !original.ends_with('\n') && replacement.ends_with('\n') {
                replacement.pop();
            }
            let edited = if replace_all {
                original.replace(old_string, &replacement)
            } else {
                original.replacen(old_string, &replacement, 1)
            };
            Some(serde_json::json!({
                "type": "diff",
                "path": path.to_string_lossy(),
                "oldText": original,
                "newText": edited,
            }))
        }
        _ => None,
    }
}

/// Stored history as `session/update` notifications, as upstream replay.ts.
fn replay_updates(message: &Message) -> Vec<serde_json::Value> {
    match message {
        Message::User(user) => vec![serde_json::json!({
            "sessionUpdate": "user_message_chunk",
            "messageId": user.base.id,
            "content": { "type": "text", "text": user.text },
        })],
        Message::Assistant(assistant) => assistant
            .content
            .iter()
            .flat_map(|part| match part {
                AssistantContent::Text(text) => vec![serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": assistant.base.id,
                    "content": { "type": "text", "text": text.text },
                })],
                AssistantContent::Reasoning(reasoning) => vec![serde_json::json!({
                    "sessionUpdate": "agent_thought_chunk",
                    "messageId": assistant.base.id,
                    "content": { "type": "text", "text": reasoning.text },
                })],
                AssistantContent::Tool(tool) => {
                    let input = tool_input_of(&tool.state);
                    let mut updates = vec![serde_json::json!({
                        "sessionUpdate": "tool_call",
                        "toolCallId": tool.id,
                        "title": tool_title(&tool.name, &input),
                        "kind": tool_kind(&tool.name),
                        "status": "pending",
                        "rawInput": input,
                    })];
                    let update = match &tool.state {
                        ToolState::Completed { content, .. } => serde_json::json!({
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": tool.id,
                            "status": "completed",
                            "content": content.iter().map(|part| match part {
                                oc_schema::ToolContent::Text { text } => serde_json::json!({
                                    "type": "content",
                                    "content": { "type": "text", "text": text },
                                }),
                                oc_schema::ToolContent::File { mime, url } => serde_json::json!({
                                    "type": "content",
                                    "content": { "type": "resource_link", "uri": url, "mimeType": mime },
                                }),
                            }).collect::<Vec<_>>(),
                            "rawOutput": { "input": input },
                        }),
                        ToolState::Error { error, .. } => serde_json::json!({
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": tool.id,
                            "status": "failed",
                            "content": [{ "type": "content", "content": { "type": "text", "text": error.name } }],
                            "rawOutput": { "input": input, "error": error.name },
                        }),
                        ToolState::Running { .. } => serde_json::json!({
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": tool.id,
                            "status": "in_progress",
                            "rawInput": input,
                        }),
                    };
                    updates.push(update);
                    updates
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn tool_input_of(state: &ToolState) -> serde_json::Value {
    match state {
        ToolState::Running { input, .. } => input.clone(),
        ToolState::Completed { input, .. } => input.clone(),
        ToolState::Error { input, .. } => input.clone(),
    }
}

fn last_finish_is_length(store: &Store, session_id: &str) -> bool {
    store
        .messages(session_id)
        .ok()
        .and_then(|messages| {
            messages.iter().rev().find_map(|m| match m {
                Message::Assistant(a) => a.finish,
                _ => None,
            })
        })
        .is_some_and(|finish| finish == oc_schema::FinishReason::Length)
}

/// Default permissions when OC_PERMISSIONS is unset, as the Juno app: read,
/// glob, grep and todowrite are allowed, everything else asks the client.
fn acp_permissions_from_env() -> oc_permission::Ruleset {
    let unset = std::env::var("OC_PERMISSIONS")
        .map(|raw| raw.trim().is_empty())
        .unwrap_or(true);
    if unset {
        use oc_permission::{Effect, Rule, Ruleset};
        Ruleset {
            rules: ["read", "glob", "grep", "todowrite"]
                .iter()
                .map(|action| Rule {
                    action: action.to_string(),
                    resource: "*".into(),
                    effect: Effect::Allow,
                })
                .collect(),
        }
    } else {
        oc_agent::permissions_from_env()
    }
}

async fn read_stdin_line() -> std::io::Result<Option<String>> {
    tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        match std::io::stdin().read_line(&mut line) {
            Ok(0) => Ok(None),
            Ok(_) => Ok(Some(line)),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?
}
