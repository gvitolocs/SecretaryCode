//! oc-provider: port of `packages/ai/src/protocols` from the OpenCode fork
//! (anomalyco/opencode @ v2.1.4, cloned at 68bc26b).
//!
//! Two protocols behind one client:
//! - OpenAI Chat Completions (`openai-chat.ts`): `POST {base}/chat/completions`
//! - Anthropic Messages (`anthropic-messages.ts`): `POST {base}/v1/messages`
//!
//! `Client::complete` is the non-streaming path (single JSON document);
//! `Client::complete_streaming` adds SSE streaming (`stream: true`) with
//! protocol-neutral [`StreamEvent`]s and the same `LlmResponse` result. The
//! upstream protocols are stream-first (`stream: true` is hardcoded in both
//! `fromRequest`s); this port makes streaming opt-in and keeps the
//! non-streaming path for transports that cannot stream.
//!
//! `Client::with_extra_body` merges a JSON object into the top level of every
//! outgoing chat body (the `OC_EXTRA_BODY` knob for endpoints that need
//! vendor fields such as `chat_template_kwargs`).
//!
//! Documented deltas vs upstream (all upstream file references are
//! `packages/ai/src/protocols/{openai-chat,anthropic-messages}.ts`):
//! - Non-streaming: no `stream`, `stream_options`, `tool_stream`; no SSE
//!   parsing. Bodies are the upstream shape minus streaming fields.
//!   Streaming bodies add `stream: true` (plus `stream_options`:
//!   `{"include_usage": true}` for OpenAI); zai's `tool_stream` is not
//!   ported. Streaming deltas and semantics are documented in the
//!   `streaming` module.
//! - OpenAI tool-result text parts are joined with `\n\n` (task contract);
//!   upstream `lowerToolMessages` joins with `"\n"`.
//! - OpenAI assistant replay with text `None` + tool calls OMITS `content`;
//!   upstream sends `content: null`.
//! - OpenAI `finish_reason: "error"` maps to `FinishReason::Error` (upstream
//!   raises an `AIError` instead; the port surface cannot fail there).
//! - Anthropic `system` is sent as the upstream block array
//!   (`[{"type":"text","text":…}]`), not a bare string.
//! - Anthropic assistant `tool_use.input` comes from parsing the stored
//!   `LlmToolCall.arguments` string (upstream carries a native object);
//!   invalid or non-object JSON degrades to `{}`.
//! - Anthropic `stop_reason` accepts both `"refusal"` (upstream) and
//!   `"refuse"` (task contract spelling) as `ContentFilter`.
//! - Anthropic usage maps the raw disjoint fields (`input_tokens` stays the
//!   *non-cached* count; cache read/write are separate). Upstream sums them
//!   into an inclusive `inputTokens`; this port keeps the disjoint split so
//!   `oc_schema::TokenUsage::total()` does not double-count.
//! - Anthropic `max_tokens` is the task-contract constant `8192`; upstream
//!   defaults to `32_000`.
//! - Tool-call ids are replayed verbatim; upstream's `scrubToolCallID` /
//!   Mistral/OpenAI id-mangling is not ported.
//! - Consecutive `ToolResult` transcript messages are merged into a single
//!   Anthropic user turn (upstream does the same); OpenAI keeps one
//!   `role:"tool"` message per result.
//! - File parts degrade to the text placeholder `` `[file: <mime> <url>] ``
//!   in both protocols (upstream sends native image/document blocks).

use std::sync::Arc;

use futures_util::TryStreamExt;
use oc_schema::{FinishReason, LlmResponse, LlmToolCall, LlmUsage, ToolContent, ToolDef};
use serde_json::{json, Map, Value};

mod streaming;
pub use streaming::{
    drive_sse, parse_anthropic_sse_frame, parse_openai_sse_frame, parse_sse_frame, AnthropicStreamState, ByteStream,
    OnEvent, OpenAiStreamState, SseFrame, StreamEvent,
};

// =============================================================================
// Public contract
// =============================================================================

/// Which wire protocol an endpoint speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    OpenAI,
    Anthropic,
}

/// A provider endpoint: protocol, base URL (no trailing path for the
/// protocol route) and optional API key.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub protocol: Protocol,
    /// e.g. `"https://api.openai.com/v1"` or `"https://api.anthropic.com"`.
    pub base_url: String,
    pub api_key: Option<String>,
}

/// One provider-neutral transcript message — port of the runner's
/// to-llm-message mapping (`ChatMessage` in the upstream session runner).
#[derive(Debug, Clone, PartialEq)]
pub enum ChatMessage {
    User { text: String },
    Assistant { text: Option<String>, reasoning: Option<String>, tool_calls: Vec<LlmToolCall> },
    ToolResult { call_id: String, name: String, content: Vec<ToolContent> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolChoice {
    Auto,
    None,
}

/// A complete (non-streaming) chat request.
#[derive(Debug, Clone)]
pub struct ChatRequest {
    /// Model id only (no provider prefix). Fallback for `complete("")`.
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDef>,
    pub tool_choice: ToolChoice,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ProviderError {
    #[error("http {status}: {body}")]
    Http { status: u16, body: String },
    #[error("transport: {0}")]
    Transport(String),
    #[error("malformed response: {0}")]
    Malformed(String),
}

/// The HTTP boundary. `Client` builds URL/headers/body; the transport does
/// the POST and hands back the decoded JSON document. Transports that can
/// stream also implement `post_stream`; implementors that do not keep the
/// default (streaming then falls back to `post_json` via `complete`).
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    async fn post_json(
        &self,
        url: &str,
        headers: Vec<(String, String)>,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, ProviderError>;

    /// POST and hand back the raw SSE byte stream (the caller parses frames).
    async fn post_stream(
        &self,
        url: &str,
        headers: Vec<(String, String)>,
        body: serde_json::Value,
    ) -> Result<ByteStream, ProviderError> {
        let _ = (url, headers, body);
        Err(ProviderError::Transport(STREAMING_UNSUPPORTED.into()))
    }
}

/// The `ProviderError::Transport` message a transport without streaming
/// support produces; `complete_streaming` falls back to `complete` on it.
pub const STREAMING_UNSUPPORTED: &str = "streaming not supported by this transport";

/// One protocol client over one endpoint.
pub struct Client {
    endpoint: Endpoint,
    transport: Arc<dyn Transport>,
    extra_body: Option<Value>,
}

// =============================================================================
// Client
// =============================================================================

impl Client {
    /// Client with the default reqwest transport (rustls).
    pub fn new(endpoint: Endpoint) -> Self {
        Self::with_transport(endpoint, Arc::new(ReqwestTransport::default()))
    }

    /// Client over a caller-supplied transport (tests, proxies).
    pub fn with_transport(endpoint: Endpoint, transport: Arc<dyn Transport>) -> Self {
        Self { endpoint, transport, extra_body: None }
    }

    /// Merge `extra` into the top level of every request body. Non-object
    /// values are ignored; object keys overwrite the generated body's keys.
    pub fn with_extra_body(mut self, extra: Value) -> Self {
        if extra.is_object() {
            self.extra_body = Some(extra);
        }
        self
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// Run one completion. `model_id` wins over `req.model` when non-empty.
    pub async fn complete(&self, model_id: &str, req: &ChatRequest) -> Result<LlmResponse, ProviderError> {
        let (url, headers, body) = self.prepare(model_id, req, false);
        let response = self.transport.post_json(&url, headers, body).await?;
        match self.endpoint.protocol {
            Protocol::OpenAI => parse_openai_response(&response),
            Protocol::Anthropic => parse_anthropic_response(&response),
        }
    }

    /// Run one completion over SSE, reporting deltas through `on_event` and
    /// returning the accumulated [`LlmResponse`] (same shape `complete`
    /// returns). The request bodies are `complete`'s plus `stream: true`
    /// (and `stream_options: {"include_usage": true}` for OpenAI).
    ///
    /// If the transport does not implement `post_stream` (it returns the
    /// [`STREAMING_UNSUPPORTED`] error), this falls back to `complete` and no
    /// content events are emitted (request metadata is still reported). `Finished` marks the protocol's terminal SSE
    /// event (`data: [DONE]` for OpenAI, `message_stop` for Anthropic); a
    /// stream that ends without it still produces a response.
    pub async fn complete_streaming(
        &self,
        model_id: &str,
        req: &ChatRequest,
        on_event: OnEvent,
    ) -> Result<LlmResponse, ProviderError> {
        let (url, headers, body) = self.prepare(model_id, req, true);
        let messages = body.get("messages").and_then(Value::as_array);
        let generation: Map<String, Value> = [
            "temperature",
            "top_p",
            "top_k",
            "min_p",
            "presence_penalty",
            "frequency_penalty",
            "seed",
            "max_tokens",
            "max_completion_tokens",
            "reasoning_effort",
        ]
        .iter()
        .filter_map(|key| {
            body.get(*key)
                .filter(|v| {
                    v.is_number()
                        || matches!(
                            v.as_str(),
                            Some("none" | "off" | "low" | "medium" | "high" | "max")
                        )
                })
                .map(|v| ((*key).into(), v.clone()))
        })
        .collect();
        let template: Map<String, Value> =
            ["enable_thinking", "preserve_thinking", "reasoning_effort"]
                .iter()
                .filter_map(|key| {
                    body.get("chat_template_kwargs")
                        .and_then(|v| v.get(*key))
                        .filter(|v| {
                            v.is_boolean()
                                || matches!(
                                    v.as_str(),
                                    Some("none" | "off" | "low" | "medium" | "high" | "max")
                                )
                        })
                        .map(|v| ((*key).into(), v.clone()))
                })
                .collect();
        on_event(StreamEvent::RequestPrepared {
            metadata: json!({
                "model": body.get("model"),
                "protocol": match self.endpoint.protocol { Protocol::OpenAI => "openai-chat", Protocol::Anthropic => "anthropic-messages" },
                "generation": generation,
                "chat_template_kwargs": template,
                "tool_names": req.tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
                "body_bytes": serde_json::to_vec(&body).map(|v| v.len()).unwrap_or(0),
                "messages": messages.map(|v| v.len()),
                "tool_schema_bytes": body.get("tools").map(|v| v.to_string().len()).unwrap_or(0),
                "system_bytes": req.system.as_ref().map(|v| v.len()).unwrap_or(0),
            }),
        });
        match self.transport.post_stream(&url, headers, body).await {
            Ok(stream) => {
                on_event(StreamEvent::ResponseStarted);
                streaming::drive_sse(stream, self.endpoint.protocol, on_event).await
            }
            Err(ProviderError::Transport(message)) if message == STREAMING_UNSUPPORTED => {
                self.complete(model_id, req).await
            }
            Err(error) => Err(error),
        }
    }

    /// Build the POST target: URL, headers, and body (`stream` fields added
    /// when `streaming`).
    fn prepare(&self, model_id: &str, req: &ChatRequest, streaming: bool) -> (String, Vec<(String, String)>, Value) {
        let model = if model_id.is_empty() { req.model.as_str() } else { model_id };
        let mut body = match self.endpoint.protocol {
            Protocol::OpenAI => (
                format!("{}/chat/completions", self.endpoint.base_url.trim_end_matches('/')),
                openai_headers(&self.endpoint),
                build_openai_request(model, req),
            ),
            Protocol::Anthropic => (
                format!("{}/v1/messages", self.endpoint.base_url.trim_end_matches('/')),
                anthropic_headers(&self.endpoint),
                build_anthropic_request(model, req),
            ),
        };
        if let Some(extra) = self.extra_body.as_ref().and_then(Value::as_object) {
            let object = body.2.as_object_mut().expect("request body is an object");
            for (key, value) in extra {
                object.insert(key.clone(), value.clone());
            }
        }
        if streaming {
            let object = body.2.as_object_mut().expect("request body is an object");
            object.insert("stream".into(), json!(true));
            if self.endpoint.protocol == Protocol::OpenAI {
                object.insert("stream_options".into(), json!({ "include_usage": true }));
            }
        }
        body
    }
}

/// OpenAI auth: `Authorization: Bearer <key>` when an api key is present.
fn openai_headers(endpoint: &Endpoint) -> Vec<(String, String)> {
    match &endpoint.api_key {
        Some(key) => vec![("Authorization".into(), format!("Bearer {key}"))],
        None => Vec::new(),
    }
}

/// Anthropic auth: `x-api-key` when present, plus the pinned API version
/// (upstream `anthropic-messages.ts` sends `anthropic-version: 2023-06-01`).
fn anthropic_headers(endpoint: &Endpoint) -> Vec<(String, String)> {
    let mut headers = vec![("anthropic-version".into(), "2023-06-01".into())];
    if let Some(key) = &endpoint.api_key {
        headers.push(("x-api-key".into(), key.clone()));
    }
    headers
}

/// Default `Transport` backed by reqwest with rustls.
#[derive(Default)]
struct ReqwestTransport {
    http: reqwest::Client,
}

#[async_trait::async_trait]
impl Transport for ReqwestTransport {
    async fn post_json(&self, url: &str, headers: Vec<(String, String)>, body: Value) -> Result<Value, ProviderError> {
        let text = self.post_for_text(url, headers, &body).await?;
        serde_json::from_str(&text).map_err(|e| ProviderError::Malformed(e.to_string()))
    }

    async fn post_stream(&self, url: &str, headers: Vec<(String, String)>, body: Value) -> Result<ByteStream, ProviderError> {
        let response = self.post(url, headers, &body).await?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let body = response.text().await.map_err(|e| ProviderError::Transport(e.to_string()))?;
            return Err(ProviderError::Http { status, body });
        }
        Ok(Box::pin(
            response
                .bytes_stream()
                .map_err(|e| ProviderError::Transport(e.to_string())),
        ))
    }
}

impl ReqwestTransport {
    async fn post_for_text(
        &self,
        url: &str,
        headers: Vec<(String, String)>,
        body: &Value,
    ) -> Result<String, ProviderError> {
        let response = self.post(url, headers, body).await?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|e| ProviderError::Transport(e.to_string()))?;
        if !(200..300).contains(&status) {
            return Err(ProviderError::Http { status, body: text });
        }
        Ok(text)
    }

    async fn post(
        &self,
        url: &str,
        headers: Vec<(String, String)>,
        body: &Value,
    ) -> Result<reqwest::Response, ProviderError> {
        let mut request = self
            .http
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        for (name, value) in headers {
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| ProviderError::Transport(format!("invalid header name {name:?}: {e}")))?;
            let value = reqwest::header::HeaderValue::from_str(&value)
                .map_err(|e| ProviderError::Transport(format!("invalid header value {value:?}: {e}")))?;
            request = request.header(name, value);
        }
        request
            .json(body)
            .send()
            .await
            .map_err(|e| ProviderError::Transport(e.to_string()))
    }
}

// =============================================================================
// Shared lowering helpers
// =============================================================================

/// Placeholder a `ToolContent::File` degrades to (both protocols).
fn file_placeholder(mime: &str, url: &str) -> String {
    format!("[file: {mime} {url}]")
}

/// One string per content part: text as-is, file as its placeholder.
fn content_to_strings(content: &[ToolContent]) -> Vec<String> {
    content
        .iter()
        .map(|part| match part {
            ToolContent::Text { text } => text.clone(),
            ToolContent::File { mime, url } => file_placeholder(mime, url),
        })
        .collect()
}

fn tool_call_wire(id: &str, name: &str, arguments: &str) -> Value {
    json!({ "id": id, "type": "function", "function": { "name": name, "arguments": arguments } })
}

/// Anthropic `tool_use.input` from a stored arguments string: parsed object,
/// degrading to `{}` on invalid JSON or a non-object value.
fn parse_tool_arguments(arguments: &str) -> Value {
    match serde_json::from_str::<Value>(arguments) {
        Ok(v) if v.is_object() => v,
        _ => json!({}),
    }
}

/// `Some(text)` only for non-blank text; blank/absent collapses to `None`.
fn non_empty(text: &Option<String>) -> Option<&str> {
    match text {
        Some(t) if !t.trim().is_empty() => Some(t),
        _ => None,
    }
}

// =============================================================================
// OpenAI Chat Completions
// =============================================================================

/// Build the `POST {base}/chat/completions` body (upstream
/// `openai-chat.ts` `fromRequest`, non-streaming subset).
pub fn build_openai_request(model: &str, req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
        messages.push(json!({ "role": "system", "content": system }));
    }

    for message in &req.messages {
        match message {
            ChatMessage::User { text } => messages.push(json!({ "role": "user", "content": text })),
            ChatMessage::Assistant { text, reasoning, tool_calls } => {
                // Drop fully empty assistant turns (upstream skips blank
                // assistant messages); keep the turn when it carries calls.
                let text = non_empty(text);
                if text.is_none() && tool_calls.is_empty() {
                    continue;
                }
                let mut entry = Map::new();
                entry.insert("role".into(), json!("assistant"));
                if let Some(reasoning) = non_empty(reasoning) {
                    entry.insert("reasoning_content".into(), json!(reasoning));
                }
                if let Some(text) = text {
                    // Verbatim text; `content` is omitted when None + calls
                    // are present (upstream sends `content: null`).
                    entry.insert("content".into(), json!(text));
                }
                if !tool_calls.is_empty() {
                    entry.insert(
                        "tool_calls".into(),
                        Value::Array(
                            tool_calls
                                .iter()
                                .map(|tc| tool_call_wire(&tc.id, &tc.name, &tc.arguments))
                                .collect(),
                        ),
                    );
                }
                messages.push(Value::Object(entry));
            }
            ChatMessage::ToolResult { call_id, content, .. } => {
                // Text parts joined with `\n\n`, file parts as placeholders.
                let content = content_to_strings(content).join("\n\n");
                messages.push(json!({ "role": "tool", "tool_call_id": call_id, "content": content }));
            }
        }
    }

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert("messages".into(), Value::Array(messages));
    if !req.tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(
                req.tools
                    .iter()
                    .map(|tool: &ToolDef| {
                        json!({
                            "type": "function",
                            "function": {
                                "name": tool.name,
                                "description": tool.description,
                                "parameters": tool.parameters,
                            }
                        })
                    })
                    .collect(),
            ),
        );
        body.insert(
            "tool_choice".into(),
            json!(match req.tool_choice {
                ToolChoice::Auto => "auto",
                ToolChoice::None => "none",
            }),
        );
    }
    Value::Object(body)
}

/// Parse a non-streaming `chat/completions` response.
pub fn parse_openai_response(v: &Value) -> Result<LlmResponse, ProviderError> {
    let choices = v
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| ProviderError::Malformed("missing choices".into()))?;
    if choices.len() != 1 {
        return Err(ProviderError::Malformed(format!(
            "expected exactly one choice, got {}",
            choices.len()
        )));
    }
    let choice = &choices[0];
    let message = choice
        .get("message")
        .ok_or_else(|| ProviderError::Malformed("missing choices[0].message".into()))?;

    // `content` is `null` when the model only called tools; some compatible
    // providers return content parts instead of a plain string.
    let text = match message.get("content") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => non_empty(&Some(s.clone())).map(str::to_owned),
        Some(Value::Array(parts)) => {
            let joined: String = parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<&str>>()
                .join("");
            non_empty(&Some(joined)).map(str::to_owned)
        }
        Some(_) => return Err(ProviderError::Malformed("choices[0].message.content is not text".into())),
    };

    let tool_calls = match message.get("tool_calls") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(calls)) => {
            let mut out = Vec::with_capacity(calls.len());
            for call in calls {
                let function = call
                    .get("function")
                    .ok_or_else(|| ProviderError::Malformed("tool call missing function".into()))?;
                let id = function_id(call)?;
                let name = function
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ProviderError::Malformed("tool call missing function.name".into()))?;
                // Arguments pass through verbatim (a JSON-encoded object
                // string); missing arguments degrade to "{}".
                let arguments = function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}")
                    .to_owned();
                out.push(LlmToolCall { id, name: name.to_owned(), arguments });
            }
            out
        }
        Some(_) => return Err(ProviderError::Malformed("choices[0].message.tool_calls is not a list".into())),
    };

    let (finish, raw_finish) = openai_finish_reason(choice.get("finish_reason").and_then(Value::as_str));

    let usage = match v.get("usage") {
        None | Some(Value::Null) => None,
        Some(u) => Some(openai_usage(u)),
    };

    Ok(LlmResponse { text, reasoning: None, tool_calls, finish, raw_finish, usage })
}

/// OpenAI `finish_reason` → union mapping (shared by the non-streaming and
/// streaming parses).
fn openai_finish_reason(raw: Option<&str>) -> (FinishReason, Option<String>) {
    match raw {
        Some("stop") | Some("end") => (FinishReason::Stop, None),
        Some("length") => (FinishReason::Length, None),
        Some("tool_calls") | Some("function_call") => (FinishReason::ToolCalls, None),
        Some("content_filter") => (FinishReason::ContentFilter, None),
        // Upstream raises on `error`; the port records it on the union.
        Some("error") => (FinishReason::Error, None),
        Some(other) => (FinishReason::Unknown, Some(other.to_owned())),
        None => (FinishReason::Unknown, None),
    }
}

/// OpenAI usage object → `LlmUsage` (shared by both parse paths).
fn openai_usage(u: &Value) -> LlmUsage {
    LlmUsage {
        input: json_f64(u.get("prompt_tokens")),
        output: json_f64(u.get("completion_tokens")),
        reasoning: json_f64(
            u.get("completion_tokens_details")
                .and_then(|d| d.get("reasoning_tokens")),
        ),
        // OpenAI reports cached reads under `prompt_tokens_details`;
        // DeepSeek-compatible surfaces use the flat fallbacks.
        cache_read: first_f64(&[
            u.get("prompt_tokens_details").and_then(|d| d.get("cached_tokens")),
            u.get("prompt_cache_hit_tokens"),
            u.get("cached_tokens"),
        ]),
        cache_write: first_f64(&[
            u.get("prompt_tokens_details").and_then(|d| d.get("cache_write_tokens")),
            u.get("cache_created_input_tokens"),
        ]),
    }
}

/// Tool-call id lives on the call itself (`call.id`).
fn function_id(call: &Value) -> Result<String, ProviderError> {
    call.get("id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ProviderError::Malformed("tool call missing id".into()))
}

// =============================================================================
// Anthropic Messages
// =============================================================================

/// Task-contract constant for `max_tokens` (upstream defaults to 32_000).
const ANTHROPIC_MAX_TOKENS: i64 = 8_192;

/// Build the `POST {base}/v1/messages` body (upstream
/// `anthropic-messages.ts` `fromRequest`, non-streaming subset).
pub fn build_anthropic_request(model: &str, req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    // Consecutive tool results merge into one user turn (upstream appends
    // `tool_result` blocks to the previous all-tool_result user message).
    let mut pending_results: Vec<Value> = Vec::new();
    let flush_results = |messages: &mut Vec<Value>, pending: &mut Vec<Value>| {
        if !pending.is_empty() {
            messages.push(json!({ "role": "user", "content": pending }));
            *pending = Vec::new();
        }
    };

    for message in &req.messages {
        match message {
            ChatMessage::User { text } => {
                flush_results(&mut messages, &mut pending_results);
                messages.push(json!({ "role": "user", "content": [ { "type": "text", "text": text } ] }));
            }
            ChatMessage::Assistant { text, tool_calls, .. } => {
                flush_results(&mut messages, &mut pending_results);
                let mut blocks = Vec::new();
                if let Some(text) = non_empty(text) {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                for call in tool_calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": call.id,
                        "name": call.name,
                        "input": parse_tool_arguments(&call.arguments),
                    }));
                }
                // Upstream drops assistant turns that lower to no blocks.
                if !blocks.is_empty() {
                    messages.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            ChatMessage::ToolResult { call_id, content, .. } => {
                let content: Vec<Value> = content
                    .iter()
                    .map(|part| match part {
                        ToolContent::Text { text } => json!({ "type": "text", "text": text }),
                        ToolContent::File { mime, url } => {
                            json!({ "type": "text", "text": file_placeholder(mime, url) })
                        }
                    })
                    .collect();
                pending_results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": call_id,
                    "content": content,
                }));
            }
        }
    }
    flush_results(&mut messages, &mut pending_results);

    let mut body = Map::new();
    body.insert("model".into(), json!(model));
    body.insert(
        "max_tokens".into(),
        json!(ANTHROPIC_MAX_TOKENS),
    );
    if let Some(system) = req.system.as_deref().filter(|s| !s.trim().is_empty()) {
        // Upstream sends the system prompt as a text-block array.
        body.insert("system".into(), json!([ { "type": "text", "text": system } ]));
    }
    body.insert("messages".into(), Value::Array(messages));
    if !req.tools.is_empty() {
        body.insert(
            "tools".into(),
            Value::Array(
                req.tools
                    .iter()
                    .map(|tool: &ToolDef| {
                        json!({
                            "name": tool.name,
                            "description": tool.description,
                            "input_schema": tool.parameters,
                        })
                    })
                    .collect(),
            ),
        );
        // Anthropic rejects tool_choice without tools (upstream omits it too).
        let tool_choice = match req.tool_choice {
            ToolChoice::Auto => json!({ "type": "auto" }),
            ToolChoice::None => json!({ "type": "none" }),
        };
        body.insert("tool_choice".into(), tool_choice);
    }
    Value::Object(body)
}

/// Parse a non-streaming Messages API response.
pub fn parse_anthropic_response(v: &Value) -> Result<LlmResponse, ProviderError> {
    let content = v
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| ProviderError::Malformed("missing content".into()))?;

    let mut texts: Vec<&str> = Vec::new();
    let mut thinkings: Vec<&str> = Vec::new();
    let mut tool_calls = Vec::new();
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        texts.push(text);
                    }
                }
            }
            Some("thinking") => {
                if let Some(thinking) = block.get("thinking").and_then(Value::as_str) {
                    if !thinking.is_empty() {
                        thinkings.push(thinking);
                    }
                }
            }
            Some("tool_use") => {
                let id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ProviderError::Malformed("tool_use block missing id".into()))?;
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ProviderError::Malformed("tool_use block missing name".into()))?;
                let arguments = match block.get("input") {
                    None | Some(Value::Null) => "{}".to_owned(),
                    Some(input) => input.to_string(),
                };
                tool_calls.push(LlmToolCall { id: id.to_owned(), name: name.to_owned(), arguments });
            }
            // `redacted_thinking`, `server_tool_use`, server tool results and
            // anything new are ignored by the non-streaming subset.
            _ => {}
        }
    }

    let text = if texts.is_empty() { None } else { Some(texts.join("\n")) };
    let reasoning = if thinkings.is_empty() { None } else { Some(thinkings.join("\n")) };

    let (finish, raw_finish) = anthropic_finish_reason(v.get("stop_reason").and_then(Value::as_str));

    let usage = match v.get("usage") {
        None | Some(Value::Null) => None,
        Some(u) => Some(anthropic_usage(u)),
    };

    Ok(LlmResponse { text, reasoning, tool_calls, finish, raw_finish, usage })
}

/// Anthropic `stop_reason` → union mapping (shared by the non-streaming and
/// streaming parses).
fn anthropic_finish_reason(raw: Option<&str>) -> (FinishReason, Option<String>) {
    match raw {
        Some("end_turn") | Some("stop_sequence") | Some("pause_turn") => (FinishReason::Stop, None),
        Some("max_tokens") | Some("model_context_window_exceeded") => (FinishReason::Length, None),
        Some("tool_use") => (FinishReason::ToolCalls, None),
        // `"refusal"` is upstream; `"refuse"` is the task-contract spelling.
        Some("refusal") | Some("refuse") => (FinishReason::ContentFilter, None),
        Some(other) => (FinishReason::Unknown, Some(other.to_owned())),
        None => (FinishReason::Unknown, None),
    }
}

/// Anthropic usage object → `LlmUsage` (shared by both parse paths).
fn anthropic_usage(u: &Value) -> LlmUsage {
    LlmUsage {
        // Raw disjoint fields: `input_tokens` is the *non-cached* count
        // (upstream sums cache into an inclusive total; this port keeps the
        // split so totals are not double-counted downstream).
        input: json_f64(u.get("input_tokens")),
        output: json_f64(u.get("output_tokens")),
        reasoning: json_f64(
            u.get("output_tokens_details")
                .and_then(|d| d.get("thinking_tokens")),
        ),
        cache_read: json_f64(u.get("cache_read_input_tokens")),
        cache_write: json_f64(u.get("cache_creation_input_tokens")),
    }
}

// =============================================================================
// JSON number helpers
// =============================================================================

fn json_f64(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

/// First present, non-null number among the candidates.
fn first_f64(candidates: &[Option<&Value>]) -> f64 {
    candidates.iter().flatten().find_map(|v| v.as_f64()).unwrap_or(0.0)
}

#[cfg(test)]
mod tests;
