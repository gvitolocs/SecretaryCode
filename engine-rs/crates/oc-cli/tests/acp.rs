use axum::body::Body;
use axum::http::header::CONTENT_TYPE;
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use futures_util::StreamExt;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// A mock that answers each request with the next of `bodies`, as an event stream.
async fn serve_steps(bodies: Vec<String>) -> (String, tokio::task::JoinHandle<()>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let bodies = std::sync::Arc::new(bodies);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let (calls, bodies) = (calls.clone(), bodies.clone());
            async move {
                let i = calls.fetch_add(1, Ordering::SeqCst);
                Response::builder()
                    .header(CONTENT_TYPE, "text/event-stream")
                    .body(Body::from(bodies[i.min(bodies.len() - 1)].clone()))
                    .unwrap()
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}/v1"), server)
}

/// A mock that answers each request with the next of `bodies`, as an event
/// stream, after waiting `delay` — so two turns overlap in time.
async fn serve_steps_slow(
    bodies: Vec<String>,
    delay: Duration,
) -> (String, tokio::task::JoinHandle<()>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let bodies = std::sync::Arc::new(bodies);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let (calls, bodies) = (calls.clone(), bodies.clone());
            async move {
                let i = calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(delay).await;
                Response::builder()
                    .header(CONTENT_TYPE, "text/event-stream")
                    .body(Body::from(bodies[i.min(bodies.len() - 1)].clone()))
                    .unwrap()
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}/v1"), server)
}

fn text_step(text: &str) -> String {
    format!(
        "data: {}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n",
        serde_json::json!({"choices":[{"index":0,"delta":{"content":text}}]})
    )
}

fn call_step(name: &str, args: serde_json::Value) -> String {
    let call = serde_json::json!({
        "choices": [{
            "index": 0,
            "delta": { "tool_calls": [{
                "index": 0, "id": "call_1", "type": "function",
                "function": { "name": name, "arguments": serde_json::to_string(&args).unwrap() },
            }]},
        }],
    });
    format!(
        "data: {call}\n\ndata: {}\n\ndata: [DONE]\n\n",
        serde_json::json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]})
    )
}

/// One delta, then the stream stays open: the turn only ends via cancel.
async fn slow_stream() -> Response {
    let first =
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n".to_string();
    let stream = futures_util::stream::once(async move { Ok::<_, std::io::Error>(first) })
        .chain(futures_util::stream::pending());
    Response::builder()
        .header(CONTENT_TYPE, "text/event-stream")
        .body(Body::from_stream(stream))
        .unwrap()
}

struct AcpClient {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
}

impl AcpClient {
    async fn spawn(dir: &std::path::Path, url: &str, extra_env: &[(&str, &str)]) -> Self {
        let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"));
        cmd.arg("acp")
            .current_dir(dir)
            .env_remove("OC_BASE")
            .env_remove("OC_PERMISSIONS")
            .env("OC_BASE_URL", url)
            .env("OC_MODEL", "openai/gpt-test")
            .env("OC_DATA", dir)
            .env("OC_API_KEY", "test-key")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
        }
    }

    async fn send(&mut self, value: serde_json::Value) {
        let mut line = serde_json::to_string(&value).unwrap();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    /// Read one JSON-RPC line from stdout.
    async fn recv(&mut self) -> serde_json::Value {
        let line = tokio::time::timeout(Duration::from_secs(30), self.lines.next_line())
            .await
            .expect("timed out waiting for an ACP line")
            .expect("stdout closed")
            .expect("read stdout");
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("bad JSON-RPC line {line:?}: {e}"))
    }

    /// Read until the response to `id` arrives; returns (notifications seen, response).
    async fn recv_response(&mut self, id: i64) -> (Vec<serde_json::Value>, serde_json::Value) {
        let mut notifications = Vec::new();
        loop {
            let msg = self.recv().await;
            if msg.get("id").and_then(|v| v.as_i64()) == Some(id)
                && (msg.get("result").is_some() || msg.get("error").is_some())
            {
                return (notifications, msg);
            }
            notifications.push(msg);
        }
    }

    async fn initialize_and_new(&mut self, cwd: &std::path::Path) -> String {
        self.send(serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": 1, "clientCapabilities": {} },
        }))
        .await;
        let (_, init) = self.recv_response(1).await;
        assert_eq!(init["result"]["protocolVersion"], 1);
        assert_eq!(init["result"]["agentCapabilities"]["loadSession"], true);
        assert_eq!(
            init["result"]["agentCapabilities"]["promptCapabilities"]["embeddedContext"],
            true
        );
        assert_eq!(init["result"]["authMethods"], serde_json::json!([]));

        self.send(serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "session/new",
            "params": { "cwd": cwd.to_string_lossy(), "mcpServers": [] },
        }))
        .await;
        let (_, new) = self.recv_response(2).await;
        new["result"]["sessionId"].as_str().unwrap().to_string()
    }

    async fn prompt(
        &mut self,
        id: i64,
        session_id: &str,
        text: &str,
    ) -> (Vec<serde_json::Value>, serde_json::Value) {
        self.send(serde_json::json!({
            "jsonrpc": "2.0", "id": id, "method": "session/prompt",
            "params": { "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] },
        }))
        .await;
        self.recv_response(id).await
    }

    async fn shutdown(mut self) -> (tokio::process::Child,) {
        drop(self.stdin);
        let _ = tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await;
        (self.child,)
    }
}

#[tokio::test]
async fn initialize_new_prompt_streams_chunks_and_ends_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let (url, server) = serve_steps(vec![text_step("hello from mock")]).await;
    let mut client = AcpClient::spawn(dir.path(), &url, &[]).await;
    let session = client.initialize_and_new(dir.path()).await;
    let (notifications, response) = client.prompt(3, &session, "say hello").await;
    server.abort();

    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    let chunks: Vec<_> = notifications
        .iter()
        .filter(|m| m["method"] == "session/update")
        .map(|m| {
            m["params"]["update"]["sessionUpdate"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert!(
        chunks.contains(&"agent_message_chunk".to_string()),
        "{chunks:?}"
    );
    let text: String = notifications
        .iter()
        .filter(|m| m["params"]["update"]["sessionUpdate"] == "agent_message_chunk")
        .map(|m| {
            m["params"]["update"]["content"]["text"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert!(text.contains("hello from mock"), "{text}");
    // stdout carried only JSON-RPC: every line parsed as JSON above.
    client.shutdown().await;
}

#[tokio::test]
async fn permission_request_reject_leaves_the_file_and_allow_edits_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "the bug\n").unwrap();
    let edit = call_step(
        "edit",
        serde_json::json!({"path":"a.txt","oldString":"bug","newString":"fix"}),
    );
    let (url, server) = serve_steps(vec![
        edit.clone(),
        text_step("blocked"),
        edit,
        text_step("done"),
    ])
    .await;
    // OC_PERMISSIONS unset: the Juno defaults ask for edit.
    let mut client = AcpClient::spawn(dir.path(), &url, &[]).await;
    let session = client.initialize_and_new(dir.path()).await;

    // First prompt: the edit tool asks; reject_once leaves the file alone.
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": 10, "method": "session/prompt",
            "params": { "sessionId": session, "prompt": [{ "type": "text", "text": "fix it" }] },
        }))
        .await;
    let mut notifications = Vec::new();
    let response = loop {
        let msg = client.recv().await;
        if msg["method"] == "session/request_permission" {
            let request_id = msg["id"].as_i64().unwrap();
            assert_eq!(msg["params"]["sessionId"], session);
            let options = msg["params"]["options"].as_array().unwrap();
            let ids: Vec<_> = options
                .iter()
                .map(|o| o["optionId"].as_str().unwrap())
                .collect();
            assert_eq!(ids, ["allow_once", "allow_always", "reject_once"]);
            client
                .send(serde_json::json!({
                    "jsonrpc": "2.0", "id": request_id,
                    "result": { "outcome": { "outcome": "selected", "optionId": "reject_once" } },
                }))
                .await;
            let (mut notes, resp) = client.recv_response(10).await;
            notifications.extend(notes);
            break resp;
        }
        notifications.push(msg);
    };
    server.abort();
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "the bug\n"
    );
    assert!(
        notifications
            .iter()
            .any(|m| m["params"]["update"]["sessionUpdate"] == "tool_call"),
        "{notifications:#?}"
    );
    assert!(notifications
        .iter()
        .any(
            |m| m["params"]["update"]["sessionUpdate"] == "tool_call_update"
                && m["params"]["update"]["status"] == "failed"
        ));

    // Second prompt on the same session: allow_once edits the file.
    let (url2, server2) = serve_steps(vec![
        call_step(
            "edit",
            serde_json::json!({"path":"a.txt","oldString":"bug","newString":"fix"}),
        ),
        text_step("done"),
    ])
    .await;
    let mut client2 = AcpClient::spawn(dir.path(), &url2, &[]).await;
    let session2 = client2.initialize_and_new(dir.path()).await;
    client2
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": 20, "method": "session/prompt",
            "params": { "sessionId": session2, "prompt": [{ "type": "text", "text": "fix it" }] },
        }))
        .await;
    let mut notifications = Vec::new();
    let response = loop {
        let msg = client2.recv().await;
        if msg["method"] == "session/request_permission" {
            let request_id = msg["id"].as_i64().unwrap();
            client2
                .send(serde_json::json!({
                    "jsonrpc": "2.0", "id": request_id,
                    "result": { "outcome": { "outcome": "selected", "optionId": "allow_once" } },
                }))
                .await;
            let (mut notes, resp) = client2.recv_response(20).await;
            notifications.extend(notes);
            break resp;
        }
        notifications.push(msg);
    };
    server2.abort();
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "the fix\n"
    );
    assert!(notifications
        .iter()
        .any(
            |m| m["params"]["update"]["sessionUpdate"] == "tool_call_update"
                && m["params"]["update"]["status"] == "completed"
        ));
    client.shutdown().await;
    client2.shutdown().await;
}

#[tokio::test]
async fn session_cancel_stops_a_slow_turn_as_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().route("/v1/chat/completions", post(slow_stream));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let url = format!("http://{addr}/v1");
    let mut client = AcpClient::spawn(dir.path(), &url, &[]).await;
    let session = client.initialize_and_new(dir.path()).await;
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": 7, "method": "session/prompt",
            "params": { "sessionId": session, "prompt": [{ "type": "text", "text": "wait" }] },
        }))
        .await;
    // Let the stream start, then cancel.
    tokio::time::sleep(Duration::from_millis(500)).await;
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "method": "session/cancel",
            "params": { "sessionId": session },
        }))
        .await;
    let (_, response) = client.recv_response(7).await;
    server.abort();
    assert_eq!(response["result"]["stopReason"], "cancelled", "{response}");
    client.shutdown().await;
}

#[tokio::test]
async fn session_load_replays_the_stored_history() {
    let dir = tempfile::tempdir().unwrap();
    let (url, server) = serve_steps(vec![text_step("the answer")]).await;
    let mut client = AcpClient::spawn(dir.path(), &url, &[]).await;
    let session = client.initialize_and_new(dir.path()).await;
    let (_, response) = client.prompt(3, &session, "the question").await;
    assert_eq!(response["result"]["stopReason"], "end_turn");

    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": 4, "method": "session/load",
            "params": { "sessionId": session, "cwd": dir.path().to_string_lossy(), "mcpServers": [] },
        }))
        .await;
    let (notifications, response) = client.recv_response(4).await;
    server.abort();
    assert!(
        response.get("result").is_some_and(|r| r.is_null()),
        "{response}"
    );
    let updates: Vec<(String, String)> = notifications
        .iter()
        .filter(|m| m["method"] == "session/update")
        .map(|m| {
            let u = &m["params"]["update"];
            (
                u["sessionUpdate"].as_str().unwrap().to_string(),
                u["content"]["text"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    assert!(
        updates
            .iter()
            .any(|(k, t)| k == "user_message_chunk" && t == "the question"),
        "{updates:?}"
    );
    assert!(
        updates
            .iter()
            .any(|(k, t)| k == "agent_message_chunk" && t.contains("the answer")),
        "{updates:?}"
    );
    client.shutdown().await;
}

#[tokio::test]
async fn unknown_method_is_a_method_not_found_error() {
    let dir = tempfile::tempdir().unwrap();
    let (url, server) = serve_steps(vec![text_step("unused")]).await;
    let mut client = AcpClient::spawn(dir.path(), &url, &[]).await;
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": 99, "method": "session/frobnicate", "params": {},
        }))
        .await;
    let (_, response) = client.recv_response(99).await;
    server.abort();
    assert_eq!(response["error"]["code"], -32601, "{response}");
    client.shutdown().await;
}

#[tokio::test]
async fn two_sessions_prompted_at_once_each_get_their_own_response() {
    let dir = tempfile::tempdir().unwrap();
    let (url, server) = serve_steps_slow(
        vec![text_step("answer A"), text_step("answer B")],
        Duration::from_millis(400),
    )
    .await;
    let mut client = AcpClient::spawn(dir.path(), &url, &[]).await;
    let session_a = client.initialize_and_new(dir.path()).await;
    // A second session in the same agent process.
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": 5, "method": "session/new",
            "params": { "cwd": dir.path().to_string_lossy(), "mcpServers": [] },
        }))
        .await;
    let (_, new_b) = client.recv_response(5).await;
    let session_b = new_b["result"]["sessionId"].as_str().unwrap().to_string();
    assert_ne!(session_a, session_b);

    // Prompt both sessions without waiting for the first to finish.
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
            "params": { "sessionId": session_a, "prompt": [{ "type": "text", "text": "for A" }] },
        }))
        .await;
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": 4, "method": "session/prompt",
            "params": { "sessionId": session_b, "prompt": [{ "type": "text", "text": "for B" }] },
        }))
        .await;

    let mut responses: std::collections::HashMap<i64, serde_json::Value> =
        std::collections::HashMap::new();
    let mut notifications = Vec::new();
    while responses.len() < 2 {
        let msg = client.recv().await;
        if let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
            if (id == 3 || id == 4) && (msg.get("result").is_some() || msg.get("error").is_some()) {
                responses.insert(id, msg);
                continue;
            }
        }
        notifications.push(msg);
    }
    server.abort();
    assert_eq!(
        responses[&3]["result"]["stopReason"], "end_turn",
        "session A's own response: {}",
        responses[&3]
    );
    assert_eq!(
        responses[&4]["result"]["stopReason"], "end_turn",
        "session B's own response: {}",
        responses[&4]
    );
    // Each session streamed its own chunks.
    let chunk_sessions: Vec<&str> = notifications
        .iter()
        .filter(|m| {
            m["method"] == "session/update"
                && m["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
        })
        .map(|m| m["params"]["sessionId"].as_str().unwrap())
        .collect();
    assert!(
        chunk_sessions.contains(&session_a.as_str()),
        "{chunk_sessions:?}"
    );
    assert!(
        chunk_sessions.contains(&session_b.as_str()),
        "{chunk_sessions:?}"
    );
    client.shutdown().await;
}

#[tokio::test]
async fn cancel_while_a_permission_request_is_open_ends_the_turn_as_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "the bug\n").unwrap();
    let edit = call_step(
        "edit",
        serde_json::json!({"path":"a.txt","oldString":"bug","newString":"fix"}),
    );
    let (url, server) = serve_steps(vec![edit, text_step("never reached")]).await;
    let mut client = AcpClient::spawn(dir.path(), &url, &[]).await;
    let session = client.initialize_and_new(dir.path()).await;
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": 7, "method": "session/prompt",
            "params": { "sessionId": session, "prompt": [{ "type": "text", "text": "fix it" }] },
        }))
        .await;
    // Wait for the permission request, then never answer it.
    let request = loop {
        let msg = client.recv().await;
        if msg["method"] == "session/request_permission" {
            break msg;
        }
    };
    assert_eq!(request["params"]["sessionId"], session);
    // Cancel the session while the request is open.
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "method": "session/cancel",
            "params": { "sessionId": session },
        }))
        .await;
    let (_, response) = tokio::time::timeout(Duration::from_secs(10), client.recv_response(7))
        .await
        .expect("the prompt response arrives within a few seconds of the cancel");
    server.abort();
    assert_eq!(response["result"]["stopReason"], "cancelled", "{response}");
    // The refused edit never ran.
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "the bug\n"
    );
    client.shutdown().await;
}

#[tokio::test]
async fn permission_request_describes_the_pending_tool_call_with_a_diff() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "the bug\n").unwrap();
    let edit_input = serde_json::json!({"path":"a.txt","oldString":"bug","newString":"fix"});
    let (url, server) = serve_steps(vec![
        call_step("edit", edit_input.clone()),
        text_step("fixed"),
    ])
    .await;
    let mut client = AcpClient::spawn(dir.path(), &url, &[]).await;
    let session = client.initialize_and_new(dir.path()).await;
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": 8, "method": "session/prompt",
            "params": { "sessionId": session, "prompt": [{ "type": "text", "text": "fix it" }] },
        }))
        .await;
    let mut announced = None;
    let request = loop {
        let msg = client.recv().await;
        if msg["method"] == "session/request_permission" {
            break msg;
        }
        if msg["method"] == "session/update"
            && msg["params"]["update"]["sessionUpdate"] == "tool_call"
        {
            announced = Some(msg["params"]["update"].clone());
        }
    };
    let request_id = request["id"].as_i64().unwrap();
    let announced = announced.expect("a tool_call notification preceded the request");
    let tool_call = &request["params"]["toolCall"];
    // Same tool call the `tool_call` notification announced.
    assert_eq!(
        tool_call["toolCallId"], announced["toolCallId"],
        "{request}"
    );
    assert_eq!(tool_call["toolCallId"].as_str().unwrap(), "call_1");
    assert_eq!(tool_call["kind"], announced["kind"], "{request}");
    assert_eq!(tool_call["title"], announced["title"], "{request}");
    assert_eq!(tool_call["rawInput"], edit_input, "{request}");
    assert_eq!(announced["rawInput"], edit_input);
    // A diff content computed from the file before the change.
    let content = tool_call["content"].as_array().expect("diff content");
    assert_eq!(content.len(), 1, "{request}");
    let diff = &content[0];
    assert_eq!(diff["type"], "diff");
    let path = diff["path"].as_str().unwrap();
    assert!(std::path::Path::new(path).is_absolute(), "{path}");
    assert_eq!(
        path,
        std::fs::canonicalize(dir.path())
            .unwrap()
            .join("a.txt")
            .to_string_lossy()
    );
    assert_eq!(diff["oldText"], "the bug\n", "{request}");
    assert_eq!(diff["newText"], "the fix\n", "{request}");

    // allow_once runs the edit: the file becomes newText.
    client
        .send(serde_json::json!({
            "jsonrpc": "2.0", "id": request_id,
            "result": { "outcome": { "outcome": "selected", "optionId": "allow_once" } },
        }))
        .await;
    let (notifications, response) = client.recv_response(8).await;
    server.abort();
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "the fix\n"
    );
    assert!(notifications.iter().any(|m| {
        m["params"]["update"]["sessionUpdate"] == "tool_call_update"
            && m["params"]["update"]["status"] == "completed"
            && m["params"]["update"]["toolCallId"] == tool_call["toolCallId"]
    }));
    client.shutdown().await;
}
