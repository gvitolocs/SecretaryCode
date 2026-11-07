use axum::body::Body;
use axum::http::header::CONTENT_TYPE;
use axum::response::Response;
use axum::routing::post;
use axum::Router;

async fn completion() -> Response {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hello from mock\"}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
        "data: [DONE]\n\n",
    );
    Response::builder()
        .header(CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn ask_runs_the_turn_in_process_against_a_mock_stream() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().route("/v1/chat/completions", post(completion));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let data = tempfile::tempdir().unwrap();
    let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
        .args(["ask", "say hello"])
        .current_dir(data.path())
        .env_remove("OC_BASE")
        .env("OC_BASE_URL", format!("http://{addr}/v1"))
        .env("OC_MODEL", "openai/gpt-test")
        .env("OC_DATA", data.path())
        .env(
            "OC_PERMISSIONS",
            r#"[{"action":"*","resource":"*","effect":"allow"}]"#,
        )
        .output()
        .await
        .unwrap();
    server.abort();

    assert!(
        out.status.success(),
        "status {:?}\nstdout: {}\nstderr: {}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stdout.contains("hello from mock"), "{stdout}");
    assert!(stderr.contains("[succeeded]"), "{stderr}");
    assert!(stderr.contains("tokens in 3/out 2"), "{stderr}");
    assert!(data.path().join("session/sessions.json").is_file());
    let logs: Vec<_> = std::fs::read_dir(data.path().join("trace"))
        .unwrap()
        .collect();
    assert_eq!(logs.len(), 1);
    let path = logs[0].as_ref().unwrap().path();
    let trace = std::fs::read_to_string(&path).unwrap();
    let rows: Vec<serde_json::Value> = trace
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.first().unwrap()["event"], "turn.start");
    assert_eq!(rows.last().unwrap()["event"], "turn.finish");
    assert!(rows
        .iter()
        .any(|r| r["event"] == "request.finish" && r["usage"]["output"] == 2.0));
    assert!(
        !trace.contains("hello from mock"),
        "trace records metrics, not response content"
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn mistral_uses_its_key_and_default_model_with_openai_chat_transport() {
    async fn mistral_completion(
        headers: axum::http::HeaderMap,
        axum::Json(body): axum::Json<serde_json::Value>,
    ) -> Response {
        assert_eq!(headers["authorization"], "Bearer fixture-mistral-key");
        assert_eq!(body["model"], "mistral-small-latest");
        completion().await
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/v1/chat/completions", post(mistral_completion)),
        )
        .await
        .unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
        .args(["ask", "say hello"])
        .current_dir(dir.path())
        .env_remove("OC_BASE")
        .env_remove("OC_MODEL")
        .env_remove("OC_API_KEY")
        .env_remove("OC_API_KEY_FILE")
        .env_remove("OC_EXTRA_BODY")
        .env("OC_PROVIDER", "mistral")
        .env("OC_BASE_URL", format!("http://{addr}/v1"))
        .env("MISTRAL_API_KEY", "fixture-mistral-key")
        .output()
        .await
        .unwrap();
    server.abort();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("hello from mock"));
    assert!(!String::from_utf8_lossy(&out.stderr).contains("fixture-mistral-key"));
}

#[tokio::test]
async fn trace_can_be_disabled_or_redirected_and_io_errors_do_not_stop_the_agent() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/v1/chat/completions", post(completion)),
        )
        .await
        .unwrap();
    });
    for mode in ["off", "file", "directory"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("explicit.jsonl");
        let setting = match mode {
            "off" => "off".to_string(),
            "file" => path.to_string_lossy().into_owned(),
            _ => dir.path().to_string_lossy().into_owned(),
        };
        let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
            .args(["ask", "say hello"])
            .current_dir(dir.path())
            .env_remove("OC_BASE")
            .env_remove("OC_EXTRA_BODY")
            .env("OC_BASE_URL", format!("http://{addr}/v1"))
            .env("OC_MODEL", "openai/gpt-test")
            .env("OC_DATA", dir.path())
            .env("OC_TRACE", setting)
            .output()
            .await
            .unwrap();
        assert!(
            out.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(String::from_utf8_lossy(&out.stdout).contains("hello from mock"));
        assert_eq!(path.is_file(), mode == "file");
        assert!(
            !dir.path().join("trace").exists(),
            "explicit trace settings override the default"
        );
        if mode == "directory" {
            assert!(String::from_utf8_lossy(&out.stderr).contains("cannot open diagnostic trace"));
        }
    }
    server.abort();
}

async fn tool_call_stream() -> Response {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":\\\"touch escaped.txt\\\"}\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n",
    );
    Response::builder()
        .header(CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

async fn final_text_stream() -> Response {
    let body = concat!(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"blocked after permission rejection\"}}]}\n\n",
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    );
    Response::builder()
        .header(CONTENT_TYPE, "text/event-stream")
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn ask_auto_rejects_actions_that_need_permission() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let calls = calls.clone();
            async move {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    tool_call_stream().await
                } else {
                    final_text_stream().await
                }
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let data = tempfile::tempdir().unwrap();
    let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
        .args(["ask", "try to escape"])
        .current_dir(data.path())
        .env_remove("OC_BASE")
        .env_remove("OC_PERMISSIONS")
        .env("OC_BASE_URL", format!("http://{addr}/v1"))
        .env("OC_MODEL", "openai/gpt-test")
        .env("OC_DATA", data.path())
        .env("OC_VERBOSE", "1")
        .output()
        .await
        .unwrap();
    server.abort();

    assert!(
        out.status.success(),
        "status {:?}\nstdout: {}\nstderr: {}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stdout.contains("blocked after permission rejection"),
        "{stdout}"
    );
    assert!(
        stderr.contains("permission requires interactive approval"),
        "{stderr}"
    );
    assert!(
        !data.path().join("escaped.txt").exists(),
        "the shell tool must not run"
    );
}

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

/// One tool call whose arguments arrive in two pieces, after a reasoning delta.
fn call_step(name: &str, args: serde_json::Value) -> String {
    let args = args.to_string();
    let (head, tail) = args.split_at(args.len() / 2);
    let delta = |d: serde_json::Value| {
        format!(
            "data: {}\n\n",
            serde_json::json!({"choices":[{"index":0,"delta":d}]})
        )
    };
    [
        delta(serde_json::json!({"reasoning_content":"let me see"})),
        delta(serde_json::json!({"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":name,"arguments":head}}]})),
        delta(serde_json::json!({"tool_calls":[{"index":0,"function":{"arguments":tail}}]})),
        "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n".to_string(),
        "data: [DONE]\n\n".to_string(),
    ]
    .concat()
}

fn text_step(text: &str) -> String {
    format!(
        "data: {}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n",
        serde_json::json!({"choices":[{"index":0,"delta":{"content":text}}]})
    )
}

const ALLOW_ALL: &str = r#"[{"action":"*","resource":"*","effect":"allow"}]"#;

#[tokio::test]
async fn ask_edits_a_file_and_runs_a_command_in_its_directory() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "the bug\n").unwrap();
    let (url, server) = serve_steps(vec![
        call_step(
            "edit",
            serde_json::json!({"path":"a.txt","oldString":"bug","newString":"fix"}),
        ),
        call_step(
            "shell",
            serde_json::json!({"command":"cat a.txt > seen.txt"}),
        ),
        text_step("done"),
    ])
    .await;
    let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
        .args(["ask", "fix it"])
        .arg(dir.path())
        .env_remove("OC_BASE")
        .env_remove("OC_SHOW_THINKING")
        .env("OC_BASE_URL", url)
        .env("OC_MODEL", "openai/gpt-test")
        .env("OC_PERMISSIONS", ALLOW_ALL)
        .output()
        .await
        .unwrap();
    server.abort();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(out.status.success(), "{stdout}\n{stderr}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("seen.txt")).unwrap(),
        "the fix\n"
    );
    assert!(stdout.contains("done"), "{stdout}");
    assert!(
        !stdout.contains("let me see"),
        "reasoning stays out of the text: {stdout}"
    );
    assert!(stderr.contains("thinking"), "{stderr}");
    assert!(stderr.contains("> shell: cat a.txt"), "{stderr}");
}

#[tokio::test]
async fn ctrl_c_stops_a_running_command_with_its_children() {
    let dir = tempfile::tempdir().unwrap();
    let (url, server) = serve_steps(vec![
        call_step(
            "shell",
            serde_json::json!({"command":"echo $$ > pid; sleep 30; touch finished"}),
        ),
        text_step("not reached"),
    ])
    .await;
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
        .args(["ask", "wait"])
        .arg(dir.path())
        .env_remove("OC_BASE")
        .env("OC_BASE_URL", url)
        .env("OC_MODEL", "openai/gpt-test")
        .env("OC_PERMISSIONS", ALLOW_ALL)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let pid_file = dir.path().join("pid");
    for _ in 0..200 {
        if std::fs::read_to_string(&pid_file).is_ok_and(|s| s.ends_with('\n')) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let shell_pid = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .to_string();
    let oc_pid = child.id().unwrap().to_string();
    let started = std::time::Instant::now();
    tokio::process::Command::new("kill")
        .args(["-INT", &oc_pid])
        .status()
        .await
        .unwrap();
    let out = child.wait_with_output().await.unwrap();
    server.abort();
    assert_eq!(
        out.status.code(),
        Some(130),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        !std::path::Path::new(&format!("/proc/{shell_pid}")).exists(),
        "the command's shell must be gone"
    );
    assert!(!dir.path().join("finished").exists());
}

#[tokio::test]
async fn a_stream_cut_short_is_requested_again() {
    let dir = tempfile::tempdir().unwrap();
    // Cut short, then a good answer: the request goes out again, as upstream retries an incomplete stream.
    let cut = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"half an ans\"}}]}\n\n"
        .to_string();
    let (url, server) = serve_steps(vec![cut, text_step("whole answer")]).await;
    let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
        .args(["ask", "go"])
        .arg(dir.path())
        .env_remove("OC_BASE")
        .env("OC_BASE_URL", url)
        .env("OC_MODEL", "openai/gpt-test")
        .env("OC_PERMISSIONS", ALLOW_ALL)
        .output()
        .await
        .unwrap();
    server.abort();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert_eq!(out.status.code(), Some(0), "{stderr}");
    assert!(stderr.contains("model request failed"), "{stderr}");
    assert!(stdout.contains("whole answer"), "{stdout}");
}

fn usage_step(inner: String, prompt_tokens: u64) -> String {
    let usage = format!(
        "data: {{\"choices\":[{{\"index\":0,\"delta\":{{}}}}],\"usage\":{{\"prompt_tokens\":{prompt_tokens},\"completion_tokens\":1}}}}\n\n"
    );
    inner.replace("data: [DONE]\n\n", &format!("{usage}data: [DONE]\n\n"))
}

#[tokio::test]
async fn a_context_past_the_ceiling_is_summarized_and_the_turn_goes_on() {
    use std::sync::{Arc, Mutex};
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let seen = requests.clone();
    // Step 1 reports a prompt near the window, so the next request is the summary; then the turn goes on.
    let bodies = Arc::new(vec![
        usage_step(
            call_step("shell", serde_json::json!({"command":"true"})),
            90_000,
        ),
        text_step("## Objective\n- the checkpoint text"),
        text_step("finished after compaction"),
    ]);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |axum::Json(body): axum::Json<serde_json::Value>| {
            let (seen, bodies) = (seen.clone(), bodies.clone());
            async move {
                let i = {
                    let mut s = seen.lock().unwrap();
                    s.push(body);
                    s.len() - 1
                };
                Response::builder()
                    .header(CONTENT_TYPE, "text/event-stream")
                    .body(Body::from(bodies[i].clone()))
                    .unwrap()
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
        .args(["ask", "go"])
        .arg(dir.path())
        .env_remove("OC_BASE")
        .env("OC_BASE_URL", format!("http://{addr}/v1"))
        .env("OC_MODEL", "openai/gpt-test")
        .env("OC_PERMISSIONS", ALLOW_ALL)
        .env("OC_CONTEXT_WINDOW", "100000")
        .output()
        .await
        .unwrap();
    server.abort();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(out.status.success(), "{stdout}\n{stderr}");
    assert!(stderr.contains("compacting"), "{stderr}");
    assert!(stdout.contains("finished after compaction"), "{stdout}");
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    let summary_request = requests[1].to_string();
    assert!(
        summary_request.contains("summarize the conversation above"),
        "{summary_request}"
    );
    assert!(requests[1]
        .get("tools")
        .is_none_or(|t| t.as_array().is_some_and(|a| a.is_empty())));
    let next = requests[2].to_string();
    assert!(next.contains("conversation-checkpoint"), "{next}");
    assert!(next.contains("the checkpoint text"), "{next}");
}

#[tokio::test]
async fn a_request_the_endpoint_refuses_fails_at_once_and_says_why() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            Response::builder()
                .status(400)
                .body(Body::from("bad model name"))
                .unwrap()
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let started = std::time::Instant::now();
    let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
        .args(["ask", "go"])
        .arg(dir.path())
        .env_remove("OC_BASE")
        .env("OC_BASE_URL", format!("http://{addr}/v1"))
        .env("OC_MODEL", "openai/gpt-test")
        .env("OC_DATA", dir.path())
        .output()
        .await
        .unwrap();
    server.abort();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("bad model name"), "{stderr}");
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    // What it wrote can be read back: the next start opens the same store.
    let mut again = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
        .args(["ask", "go"])
        .arg(dir.path())
        .env_remove("OC_BASE")
        .env("OC_BASE_URL", "http://127.0.0.1:9/v1")
        .env("OC_MODEL", "openai/gpt-test")
        .env("OC_DATA", dir.path())
        .env("OC_MAX_STEPS", "0")
        .kill_on_drop(true)
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        again.try_wait().unwrap().is_none(),
        "the store must open: {:?}",
        again.try_wait()
    );
}

#[tokio::test]
async fn chat_keeps_the_session_asks_before_acting_and_ends_on_exit() {
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncWriteExt;
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let seen = requests.clone();
    let bodies = Arc::new(vec![
        call_step("shell", serde_json::json!({"command":"touch approved"})),
        text_step("first answer"),
        call_step("shell", serde_json::json!({"command":"touch refused"})),
        text_step("second answer"),
        text_step("after new"),
    ]);
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |axum::Json(body): axum::Json<serde_json::Value>| {
            let (seen, bodies) = (seen.clone(), bodies.clone());
            async move {
                let i = {
                    let mut s = seen.lock().unwrap();
                    s.push(body);
                    s.len() - 1
                };
                Response::builder()
                    .header(CONTENT_TYPE, "text/event-stream")
                    .body(Body::from(bodies[i].clone()))
                    .unwrap()
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_oc-cli"))
        // keep the host's Claude Code config (~/.claude, MCP servers, hooks) out of tests
        .env("CLAUDE_CONFIG_DIR", "/nonexistent/oc-cli-test-claude")
        .env("OC_CLAUDE_MANAGED_DIR", "")
        .arg("chat")
        .arg(dir.path())
        .env_remove("OC_BASE")
        .env_remove("OC_PERMISSIONS")
        .env("OC_BASE_URL", format!("http://{addr}/v1"))
        .env("OC_MODEL", "openai/gpt-test")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(b"make it\ny\nand the other\nn\n/new\nfresh start\n/exit\n")
        .await
        .unwrap();
    let out = child.wait_with_output().await.unwrap();
    server.abort();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(out.status.success(), "{stdout}\n{stderr}");
    assert!(dir.path().join("approved").exists(), "{stderr}");
    assert!(!dir.path().join("refused").exists(), "{stderr}");
    assert!(stderr.contains("permission requested: shell"), "{stderr}");
    assert!(stderr.contains("denied by the user"), "{stderr}");
    for answer in ["first answer", "second answer", "after new"] {
        assert!(stdout.contains(answer), "{stdout}");
    }
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    // The second turn sees the first; after /new nothing of them is sent.
    assert!(requests[2].to_string().contains("make it"));
    let fresh = requests[4].to_string();
    assert!(
        fresh.contains("fresh start") && !fresh.contains("make it"),
        "{fresh}"
    );
}
