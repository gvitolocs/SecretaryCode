//! oc-mcp tests: framing, request routing, the registry bridge, and the
//! spawn/shutdown path. A scripted in-memory server drives the client over
//! duplex pipes; a real python3 child covers the spawn path. No network.

use crate::{McpClient, McpServerConfig, McpTool};
use oc_tools::{Registry, Tool, ToolContext};
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn ctx(dir: &Path) -> ToolContext {
    ToolContext {
        worktree: dir.to_path_buf(),
        session_id: "ses_t".into(),
        call_id: "call_t".into(),
    }
}

const INIT_RESULT: &str = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"t","version":"1"}}}"#;

/// Spawn a scripted MCP server over duplex pipes: for each request line it
/// pops the next scripted response, substituting the request's id.
async fn scripted(script: Vec<serde_json::Value>) -> McpClient {
    use tokio::io::duplex;
    let (c_in, s_in) = duplex(64 * 1024);
    let (mut s_out, c_out) = duplex(64 * 1024);
    // the handshake consumes the first answer automatically
    let mut queue = vec![serde_json::from_str::<serde_json::Value>(INIT_RESULT).unwrap()];
    queue.extend(script);
    tokio::spawn(async move {
        let mut lines = BufReader::new(s_in).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("[scripted] got: {line}");
            let Ok(req) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if let Some(notif) = req.get("method").and_then(|m| m.as_str()) {
                if notif.starts_with("notifications/") {
                    continue;
                }
            }
            let Some(mut resp) = (!queue.is_empty()).then(|| queue.remove(0)) else {
                continue;
            };
            if let Some(id) = req.get("id") {
                resp["id"] = id.clone();
            }
            eprintln!("[scripted] responding: {resp}");
            let _ = s_out.write_all(format!("{resp}\n").as_bytes()).await;
        }
    });
    let client = McpClient::over_io(Box::new(c_in), Box::new(c_out));
    // run the real handshake: the scripted queue's first answer answers it
    client.initialize("test").await.unwrap();
    client
}

fn init_script() -> Vec<serde_json::Value> {
    vec![]
}

#[tokio::test]
async fn handshake_completes_over_memory_io() {
    let client = scripted(init_script()).await;
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn list_tools_maps_name_description_schema() {
    let mut script = init_script();
    script.push(serde_json::json!({
        "id": 0,
        "result": {"tools": [
            {"name": "read_file", "description": "Reads a file.", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
            {"name": "no_desc", "inputSchema": {"type": "object"}}
        ]}
    }));
    let client = scripted(script).await;
    let tools = client.list_tools().await.unwrap();
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].name, "read_file");
    assert_eq!(tools[0].description.as_deref(), Some("Reads a file."));
    assert_eq!(tools[0].input_schema["required"][0], "path");
    assert!(tools[1].description.is_none());
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn call_tool_joins_text_and_flags_errors() {
    let mut script = init_script();
    script.push(serde_json::json!({
        "id": 0,
        "result": {"content": [{"type": "text", "text": "line one"}, {"type": "text", "text": "line two"}]}
    }));
    script.push(serde_json::json!({
        "id": 0,
        "result": {"content": [{"type": "text", "text": "boom"}], "isError": true}
    }));
    let client = scripted(script).await;
    let ok = client.call_tool("t", serde_json::json!({})).await.unwrap();
    assert_eq!(ok.text, "line one\nline two");
    assert!(!ok.is_error);
    let err = client.call_tool("t", serde_json::json!({})).await.unwrap();
    assert!(err.is_error);
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn server_error_result_maps_to_mcp_error() {
    let mut script = init_script();
    script.push(serde_json::json!({
        "id": 0,
        "error": {"code": -32601, "message": "method not found"}
    }));
    let client = scripted(script).await;
    let err = client
        .call_tool("t", serde_json::json!({}))
        .await
        .unwrap_err();
    assert!(
        matches!(&err, crate::McpError::Server { code: -32601, .. }),
        "{err}"
    );
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn notifications_are_ignored_and_later_responses_still_route() {
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};
    // bespoke server: pushes a stray notification BEFORE the tools/list
    // response — the client must ignore the notification and still route
    let (c_in, s_in) = duplex(64 * 1024);
    let (mut s_out, c_out) = duplex(64 * 1024);
    let init: serde_json::Value = serde_json::from_str(INIT_RESULT).unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(s_in).lines();
        let first = true;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(req) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(id) = req.get("id") else { continue };
            let _ = s_out
                .write_all(
                    format!("{{\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools_changed\"}}\n")
                        .as_bytes(),
                )
                .await;
            let _ = &first;
            let result = serde_json::json!({"tools": []});
            let _ = s_out
                .write_all(
                    format!(
                        "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{}}}\n",
                        id,
                        serde_json::to_string(&result).unwrap()
                    )
                    .as_bytes(),
                )
                .await;
            let _ = init; // shape reference
        }
    });
    let client = McpClient::over_io(Box::new(c_in), Box::new(c_out));
    client.initialize("test").await.unwrap();
    let tools = client.list_tools().await.unwrap();
    assert!(
        tools.is_empty(),
        "the notification must not route as a response"
    );
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn bridge_exposes_tools_in_registry_with_namespacing() {
    let mut script = init_script();
    script.push(serde_json::json!({
        "id": 0,
        "result": {"tools": [
            {"name": "query", "description": "Runs a query.", "inputSchema": {"type": "object"}}
        ]}
    }));
    let client = Arc::new(scripted(script).await);
    let dir = tempfile::tempdir().unwrap();
    let tools: Vec<Arc<dyn Tool>> = vec![Arc::new(McpTool {
        server: "db".into(),
        info: crate::McpToolInfo {
            name: "query".into(),
            description: Some("Runs a query.".into()),
            input_schema: serde_json::json!({"type": "object"}),
        },
        client: client.clone(),
    })];
    let registry = Registry::builtin(dir.path()).with_tools(tools);
    let defs = registry.defs();
    let mcp_def = defs
        .iter()
        .find(|d| d.name.starts_with("mcp__"))
        .expect("mcp tool registered");
    assert_eq!(mcp_def.name, "mcp__db__query");
    assert_eq!(mcp_def.description, "Runs a query.");

    // call through the registry: the script answers the tools/call
    let mut script2 = vec![serde_json::json!({
        "id": 0,
        "result": {"content": [{"type": "text", "text": "query result"}]}
    })];
    script2.reverse();
    // (the shared client's script was consumed by list_tools in this test's
    // setup above; drive the bridge directly against a fresh client instead)
    let _ = script2;
    let fresh = Arc::new(scripted(vec![
        serde_json::json!({"id": 0, "result": {"content": [{"type": "text", "text": "query result"}]}}),
    ]).await);
    let bridge = McpTool {
        server: "db".into(),
        info: crate::McpToolInfo {
            name: "query".into(),
            description: None,
            input_schema: serde_json::json!({"type": "object"}),
        },
        client: fresh,
    };
    let out = bridge
        .execute(&serde_json::json!({"sql": "select 1"}), &ctx(dir.path()))
        .await
        .unwrap();
    let oc_schema::ToolContent::Text { text } = &out.content[0] else {
        panic!("not text")
    };
    assert_eq!(text, "query result");
    assert_eq!(out.metadata.unwrap()["server"], "db");
}

#[tokio::test]
async fn bridge_maps_is_error_to_tool_error() {
    let fresh = Arc::new(scripted(vec![
        serde_json::json!({"id": 0, "result": {"content": [{"type": "text", "text": "boom"}], "isError": true}}),
    ]).await);
    let bridge = McpTool {
        server: "db".into(),
        info: crate::McpToolInfo {
            name: "boom".into(),
            description: None,
            input_schema: serde_json::json!({"type":"object"}),
        },
        client: fresh,
    };
    let err = bridge
        .execute(&serde_json::json!({}), &ctx(Path::new("/tmp")))
        .await
        .unwrap_err();
    assert!(
        matches!(err, oc_tools::ToolError::Failed(ref m) if m == "boom"),
        "{err}"
    );
}

#[tokio::test]
async fn spawn_and_shutdown_with_real_child() {
    // a real python3 MCP server: newline JSON-RPC answering initialize and
    // tools/list (available on the box; skipped quietly if python3 is not)
    let Some(python) = which_python3() else {
        return;
    };
    let cfg = McpServerConfig {
        name: "py".into(),
        command: python,
        args: vec![
            "-c".into(),
            r#"
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    req = json.loads(line)
    if req.get("method") == "initialize":
        print(json.dumps({"jsonrpc":"2.0","id":req["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"py","version":"1"}}}), flush=True)
    elif req.get("method") == "tools/list":
        print(json.dumps({"jsonrpc":"2.0","id":req["id"],"result":{"tools":[{"name":"hello","description":"Says hello","inputSchema":{"type":"object"}}]}}), flush=True)
"#
            .into(),
        ],
        env: Vec::new(),
    };
    let client = McpClient::spawn(&cfg).await.unwrap();
    let tools = client.list_tools().await.unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "hello");
    client.shutdown().await.unwrap();
}

fn which_python3() -> Option<String> {
    std::process::Command::new("python3")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|_| "python3".to_string())
}

// silence dead-code warnings for the helper in non-test builds
#[allow(dead_code)]
fn _unused(t: &dyn Tool) -> &dyn Tool {
    // McpTool implements Tool; keep the trait import honest
    t
}

#[tokio::test]
async fn duplex_probe() {
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (mut c_in, s_in) = duplex(64 * 1024);
    let (mut s_out, c_out) = duplex(64 * 1024);
    tokio::spawn(async move {
        let mut lines = BufReader::new(s_in).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            let _ = (&mut s_out)
                .write_all(format!("echo:{l}\n").as_bytes())
                .await;
        }
    });
    c_in.write_all(b"ping\n").await.unwrap();
    c_in.flush().await.unwrap();
    let mut lines = BufReader::new(c_out).lines();
    let got = tokio::time::timeout(std::time::Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.as_deref(), Some("echo:ping"));
}
