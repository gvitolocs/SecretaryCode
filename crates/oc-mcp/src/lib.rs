//! oc-mcp: a Model Context Protocol client over stdio plus the bridge that
//! surfaces MCP tools as registry tools.
//!
//! Framing: MCP stdio is NEWLINE-DELIMITED JSON-RPC 2.0 (Content-Length
//! framing is LSP — the classic mix-up). Lifecycle: `initialize` request →
//! response → `notifications/initialized` → `tools/list` → `tools/call`.
//! Non-response notifications are ignored. The io is injectable so tests can
//! drive a scripted server without a process.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use async_trait::async_trait;
use oc_schema::{ToolContent, ToolDef};
use oc_tools::{Registry, Tool, ToolContext, ToolError, ToolOutput};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("io: {0}")]
    Io(String),
    #[error("protocol: {0}")]
    Protocol(String),
    #[error("server error {code}: {message}")]
    Server { code: i64, message: String },
    #[error("timed out")]
    Timeout,
}

#[derive(Debug, Clone)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct McpToolInfo {
    pub name: String,
    pub description: Option<String>,
    /// JSON Schema object for the input.
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct McpCallResult {
    /// Text parts joined with newlines; other part types render as
    /// `[<type>: …]` placeholders.
    pub text: String,
    pub is_error: bool,
}

const INIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

enum Pending {
    Wait(oneshot::Sender<Result<serde_json::Value, McpError>>),
}

struct ClientIo {
    stdin: Mutex<Box<dyn AsyncWrite + Unpin + Send>>,
    next_id: Mutex<i64>,
    pending: Arc<Mutex<HashMap<i64, Pending>>>,
    tasks: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

pub struct McpClient {
    io: ClientIo,
    shutdown: Mutex<Option<tokio::process::Child>>,
}

impl McpClient {
    /// Spawn the server process, run the initialize handshake, and send the
    /// initialized notification.
    pub async fn spawn(cfg: &McpServerConfig) -> Result<Self, McpError> {
        let mut cmd = tokio::process::Command::new(&cfg.command);
        cmd.args(&cfg.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().map_err(|e| McpError::Io(format!("spawn {}: {e}", cfg.command)))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpError::Io("no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpError::Io("no stdout".into()))?;
        let client = Self::over_io(Box::new(stdin), Box::new(BufReader::new(stdout)));
        let mut me = client;
        me.shutdown = Mutex::new(Some(child));
        me.initialize(&cfg.name).await?;
        Ok(me)
    }

    /// Injectable-io constructor (tests drive a scripted server here).
    pub fn over_io(
        stdin: Box<dyn AsyncWrite + Unpin + Send>,
        stdout: Box<dyn AsyncRead + Unpin + Send>,
    ) -> Self {
        let pending: Arc<Mutex<HashMap<i64, Pending>>> = Arc::new(Mutex::new(HashMap::new()));
        // reader task: parse newline-delimited JSON, route responses
        let reader_pending = pending.clone();
        let tasks = std::sync::Mutex::new(Vec::new());
        let handle = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
                            continue; // unparseable line: skip, stay alive
                        };
                        let id = v.get("id").and_then(|i| i.as_i64());
                        match (id, v.get("method")) {
                            (Some(id), None) => {
                                // a response to one of ours
                                if let Some(Pending::Wait(tx)) =
                                    reader_pending.lock().await.remove(&id)
                                {
                                    let result = if let Some(err) = v.get("error") {
                                        Err(McpError::Server {
                                            code: err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1),
                                            message: err
                                                .get("message")
                                                .and_then(|m| m.as_str())
                                                .unwrap_or("unknown")
                                                .to_string(),
                                        })
                                    } else {
                                        Ok(v.get("result").cloned().unwrap_or(serde_json::Value::Null))
                                    };
                                    let _ = tx.send(result);
                                }
                            }
                            _ => {
                                // a server notification or request: ignored
                            }
                        }
                    }
                    _ => break, // stdout closed
                }
            }
        });
        tasks.lock().unwrap().push(handle);
        Self { io: ClientIo { stdin: Mutex::new(stdin), next_id: Mutex::new(1), pending, tasks }, shutdown: Mutex::new(None) }
    }

    /// Register the pending slot BEFORE the write: a fast server can answer
    /// between the write and the registration, and the reader would drop a
    /// response with no pending entry to resolve.
    async fn request(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, McpError> {
        let id = {
            let mut next = self.io.next_id.lock().await;
            let id = *next;
            *next += 1;
            id
        };
        let (tx, rx) = oneshot::channel();
        self.io.pending.lock().await.insert(id, Pending::Wait(tx));
        let write = async {
            let msg = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            });
            let mut stdin = self.io.stdin.lock().await;
            stdin
                .write_all(serde_json::to_string(&msg).unwrap().as_bytes())
                .await
                .map_err(|e| McpError::Io(e.to_string()))?;
            stdin.write_all(b"\n").await.map_err(|e| McpError::Io(e.to_string()))?;
            stdin.flush().await.map_err(|e| McpError::Io(e.to_string()))?;
            Ok(())
        };
        if let Err(e) = write.await {
            self.io.pending.lock().await.remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(McpError::Protocol("responder dropped".into())),
            Err(_) => {
                self.io.pending.lock().await.remove(&id);
                Err(McpError::Timeout)
            }
        }
    }

    async fn notify(&self, method: &str) -> Result<(), McpError> {
        let msg = serde_json::json!({ "jsonrpc": "2.0", "method": method });
        let mut stdin = self.io.stdin.lock().await;
        stdin
            .write_all(serde_json::to_string(&msg).unwrap().as_bytes())
            .await
            .map_err(|e| McpError::Io(e.to_string()))?;
        stdin.write_all(b"\n").await.map_err(|e| McpError::Io(e.to_string()))?;
        stdin.flush().await.map_err(|e| McpError::Io(e.to_string()))?;
        Ok(())
    }

    pub(crate) async fn initialize(&self, client_name: &str) -> Result<(), McpError> {
        let result = tokio::time::timeout(
            INIT_TIMEOUT,
            self.request(
                "initialize",
                serde_json::json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": client_name, "version": env!("CARGO_PKG_VERSION")},
                }),
            ),
        )
        .await
        .map_err(|_| McpError::Timeout)??;
        if result.is_null() {
            return Err(McpError::Protocol("initialize returned null".into()));
        }
        self.notify("notifications/initialized").await
    }

    pub async fn list_tools(&self) -> Result<Vec<McpToolInfo>, McpError> {
        let result = self.request("tools/list", serde_json::json!({})).await?;
        let tools = result
            .get("tools")
            .and_then(|t| t.as_array())
            .ok_or_else(|| McpError::Protocol("tools/list returned no tools array".into()))?;
        Ok(tools
            .iter()
            .filter_map(|t| {
                Some(McpToolInfo {
                    name: t.get("name")?.as_str()?.to_string(),
                    description: t.get("description").and_then(|d| d.as_str()).map(str::to_string),
                    input_schema: t.get("inputSchema").cloned().unwrap_or(serde_json::json!({"type":"object"})),
                })
            })
            .collect())
    }

    pub async fn call_tool(&self, name: &str, arguments: serde_json::Value) -> Result<McpCallResult, McpError> {
        let result = self
            .request("tools/call", serde_json::json!({ "name": name, "arguments": arguments }))
            .await?;
        let is_error = result.get("isError").and_then(|e| e.as_bool()).unwrap_or(false);
        let mut parts: Vec<String> = Vec::new();
        if let Some(content) = result.get("content").and_then(|c| c.as_array()) {
            for item in content {
                let ty = item.get("type").and_then(|t| t.as_str()).unwrap_or("unknown");
                match ty {
                    "text" => {
                        parts.push(item.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string());
                    }
                    other => parts.push(format!("[{other}: {}]", serde_json::to_string(item).unwrap_or_default())),
                }
            }
        }
        Ok(McpCallResult { text: parts.join("\n"), is_error })
    }

    /// Polite close: drop stdin (EOF ends most servers), wait briefly, kill
    /// on timeout.
    pub async fn shutdown(mut self) -> Result<(), McpError> {
        self.io.stdin.lock().await.shutdown().await.ok();
        if let Some(mut child) = self.shutdown.lock().await.take() {
            match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
                Ok(Ok(_)) | Err(_) => {} // clean exit or timed out; kill below
                Ok(Err(e)) => return Err(McpError::Io(e.to_string())),
            }
            if !matches!(child.try_wait(), Ok(Some(_))) {
                let _ = child.kill().await;
            }
        }
        for t in self.io.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
        Ok(())
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        if let Ok(mut tasks) = self.io.tasks.lock() {
            for t in tasks.drain(..) {
                t.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests;


// ===== registry bridge =====

/// One MCP tool as an oc-tools Tool; registry name: `mcp__<server>__<tool>`.
pub struct McpTool {
    server: String,
    info: McpToolInfo,
    client: Arc<McpClient>,
}

#[async_trait]
impl Tool for McpTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: format!("mcp__{}__{}", self.server, self.info.name),
            description: self
                .info
                .description
                .clone()
                .unwrap_or_else(|| format!("MCP tool {} from server {}", self.info.name, self.server)),
            parameters: self.info.input_schema.clone(),
        }
    }

    async fn execute(&self, input: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let result = self
            .client
            .call_tool(&self.info.name, input.clone())
            .await
            .map_err(|e| ToolError::Failed(format!("mcp call failed: {e}")))?;
        if result.is_error {
            return Err(ToolError::Failed(result.text));
        }
        let mut out = ToolOutput::text(result.text);
        out.metadata = Some(serde_json::json!({ "server": self.server, "tool": self.info.name }));
        Ok(out)
    }
}

/// Spawn every configured server, list its tools, and build the bridge list.
/// A server that fails to start or list is skipped with a trace (the rest of
/// the registry keeps working).
pub async fn registry_tools(servers: Vec<McpServerConfig>) -> Vec<Arc<dyn Tool>> {
    let mut out: Vec<Arc<dyn Tool>> = Vec::new();
    for cfg in servers {
        match McpClient::spawn(&cfg).await {
            Ok(client) => match client.list_tools().await {
                Ok(tools) => {
                    let client = Arc::new(client);
                    for info in tools {
                        out.push(Arc::new(McpTool {
                            server: cfg.name.clone(),
                            info,
                            client: client.clone(),
                        }));
                    }
                }
                Err(e) => {
                    tracing::warn!("mcp server {} listed no tools: {e}", cfg.name);
                }
            },
            Err(e) => {
                tracing::warn!("mcp server {} failed to start: {e}", cfg.name);
            }
        }
    }
    out
}

/// Build the server list from `OC_MCP_SERVERS` (JSON array of
/// `{name, command, args?, env?}`); unset/invalid = empty.
pub fn servers_from_env() -> Vec<McpServerConfig> {
    let raw = std::env::var("OC_MCP_SERVERS").unwrap_or_default();
    if raw.trim().is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<serde_json::Value>>(&raw)
        .map(|list| {
            list.iter()
                .filter_map(|v| {
                    Some(McpServerConfig {
                        name: v.get("name")?.as_str()?.to_string(),
                        command: v.get("command")?.as_str()?.to_string(),
                        args: v
                            .get("args")
                            .and_then(|a| a.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                            .unwrap_or_default(),
                        env: v
                            .get("env")
                            .and_then(|e| e.as_object())
                            .map(|o| {
                                o.iter()
                                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Exposed for the server: attach every env-configured MCP server's tools.
pub async fn tools_from_env() -> Vec<Arc<dyn Tool>> {
    registry_tools(servers_from_env()).await
}
