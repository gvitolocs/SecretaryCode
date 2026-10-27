//! Tests for the oc-provider protocol subset. No network: the `Client` is
//! exercised through a mock `Transport` that captures what was posted.

use std::sync::{Arc, Mutex};

use crate::{
    build_anthropic_request, build_openai_request, parse_anthropic_response, parse_openai_response, ChatMessage,
    ChatRequest, Client, Endpoint, Protocol, ProviderError, ToolChoice, Transport,
};
use oc_schema::{FinishReason, LlmToolCall, LlmUsage, ToolContent, ToolDef};
use serde_json::{json, Value};

fn tool(name: &str) -> ToolDef {
    ToolDef {
        name: name.to_owned(),
        description: format!("{name} does things"),
        parameters: json!({
            "type": "object",
            "properties": { "path": { "type": "string" } },
            "required": ["path"],
        }),
    }
}

fn call(id: &str, name: &str, arguments: &str) -> LlmToolCall {
    LlmToolCall { id: id.to_owned(), name: name.to_owned(), arguments: arguments.to_owned() }
}

// =============================================================================
// OpenAI request builder
// =============================================================================

#[test]
fn openai_minimal_body() {
    let req = ChatRequest {
        model: "gpt-5".into(),
        system: None,
        messages: vec![ChatMessage::User { text: "hello".into() }],
        tools: vec![],
        tool_choice: ToolChoice::Auto,
    };
    assert_eq!(
        build_openai_request("gpt-5", &req),
        json!({
            "model": "gpt-5",
            "messages": [ { "role": "user", "content": "hello" } ]
        })
    );
}

#[test]
fn openai_full_body() {
    let req = ChatRequest {
        model: "gpt-5".into(),
        system: Some("You are terse.".into()),
        messages: vec![
            ChatMessage::User { text: "list files".into() },
            ChatMessage::Assistant {
                text: Some("checking".into()),
                tool_calls: vec![call("call_1", "bash", r#"{"cmd":"ls"}"#)],
            },
            ChatMessage::ToolResult {
                call_id: "call_1".into(),
                name: "bash".into(),
                content: vec![ToolContent::Text { text: "a.txt".into() }],
            },
        ],
        tools: vec![tool("bash")],
        tool_choice: ToolChoice::Auto,
    };
    assert_eq!(
        build_openai_request("gpt-5", &req),
        json!({
            "model": "gpt-5",
            "messages": [
                { "role": "system", "content": "You are terse." },
                { "role": "user", "content": "list files" },
                {
                    "role": "assistant",
                    "content": "checking",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": { "name": "bash", "arguments": "{\"cmd\":\"ls\"}" }
                        }
                    ]
                },
                { "role": "tool", "tool_call_id": "call_1", "content": "a.txt" }
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "bash",
                        "description": "bash does things",
                        "parameters": {
                            "type": "object",
                            "properties": { "path": { "type": "string" } },
                            "required": ["path"]
                        }
                    }
                }
            ],
            "tool_choice": "auto"
        })
    );
}

#[test]
fn openai_assistant_without_text_omits_content() {
    let req = ChatRequest {
        model: "gpt-5".into(),
        system: None,
        messages: vec![
            ChatMessage::User { text: "go".into() },
            ChatMessage::Assistant { text: None, tool_calls: vec![call("c1", "bash", "{}")] },
        ],
        tools: vec![],
        tool_choice: ToolChoice::Auto,
    };
    let body = build_openai_request("gpt-5", &req);
    let assistant = &body["messages"][1];
    assert_eq!(assistant["role"], "assistant");
    assert!(assistant.get("content").is_none(), "content must be omitted: {assistant}");
    assert_eq!(assistant["tool_calls"][0]["function"]["name"], "bash");
}

#[test]
fn openai_tool_choice_none() {
    let req = ChatRequest {
        model: "gpt-5".into(),
        system: None,
        messages: vec![ChatMessage::User { text: "hi".into() }],
        tools: vec![tool("bash")],
        tool_choice: ToolChoice::None,
    };
    assert_eq!(build_openai_request("gpt-5", &req)["tool_choice"], "none");
}

#[test]
fn openai_no_tools_omits_keys() {
    let req = ChatRequest {
        model: "gpt-5".into(),
        system: Some("sys".into()),
        messages: vec![ChatMessage::User { text: "hi".into() }],
        tools: vec![],
        tool_choice: ToolChoice::Auto,
    };
    let body = build_openai_request("gpt-5", &req);
    assert!(body.get("tools").is_none());
    assert!(body.get("tool_choice").is_none());
    // system still comes first
    assert_eq!(body["messages"][0], json!({ "role": "system", "content": "sys" }));
}

#[test]
fn openai_tool_result_text_and_file_placeholder() {
    let req = ChatRequest {
        model: "gpt-5".into(),
        system: None,
        messages: vec![ChatMessage::ToolResult {
            call_id: "c9".into(),
            name: "read".into(),
            content: vec![
                ToolContent::Text { text: "line one".into() },
                ToolContent::Text { text: "line two".into() },
                ToolContent::File { mime: "image/png".into(), url: "file:///tmp/a.png".into() },
            ],
        }],
        tools: vec![],
        tool_choice: ToolChoice::Auto,
    };
    let body = build_openai_request("gpt-5", &req);
    assert_eq!(
        body["messages"][0],
        json!({
            "role": "tool",
            "tool_call_id": "c9",
            "content": "line one\n\nline two\n\n[file: image/png file:///tmp/a.png]"
        })
    );
}

// =============================================================================
// OpenAI response parser
// =============================================================================

#[test]
fn openai_parse_text_only_with_usage() {
    let v = json!({
        "choices": [ {
            "message": { "role": "assistant", "content": "all done" },
            "finish_reason": "stop"
        } ],
        "usage": {
            "prompt_tokens": 120,
            "completion_tokens": 34,
            "prompt_tokens_details": { "cached_tokens": 90, "cache_write_tokens": 10 },
            "completion_tokens_details": { "reasoning_tokens": 12 }
        }
    });
    let got = parse_openai_response(&v).expect("parses");
    assert_eq!(got.text.as_deref(), Some("all done"));
    assert!(got.tool_calls.is_empty());
    assert_eq!(got.finish, FinishReason::Stop);
    assert_eq!(got.raw_finish, None);
    assert_eq!(
        got.usage,
        Some(LlmUsage { input: 120.0, output: 34.0, reasoning: 12.0, cache_read: 90.0, cache_write: 10.0 })
    );
}

#[test]
fn openai_parse_tool_calls_verbatim_arguments() {
    let v = json!({
        "choices": [ {
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {
                        "id": "call_abc",
                        "type": "function",
                        "function": { "name": "bash", "arguments": "{\"cmd\":\"ls -la\"}" }
                    }
                ]
            },
            "finish_reason": "tool_calls"
        } ],
        "usage": null
    });
    let got = parse_openai_response(&v).expect("parses");
    assert_eq!(got.text, None, "null content maps to None");
    assert_eq!(got.tool_calls.len(), 1);
    assert_eq!(got.tool_calls[0].id, "call_abc");
    assert_eq!(got.tool_calls[0].name, "bash");
    assert_eq!(got.tool_calls[0].arguments, "{\"cmd\":\"ls -la\"}", "arguments pass through verbatim");
    assert_eq!(got.finish, FinishReason::ToolCalls);
    assert_eq!(got.usage, None);
}

#[test]
fn openai_parse_unknown_finish_reason_keeps_raw() {
    let v = json!({
        "choices": [ {
            "message": { "role": "assistant", "content": "hm" },
            "finish_reason": "policy_violation"
        } ]
    });
    let got = parse_openai_response(&v).expect("parses");
    assert_eq!(got.finish, FinishReason::Unknown);
    assert_eq!(got.raw_finish.as_deref(), Some("policy_violation"));
}

#[test]
fn openai_parse_error_finish_reason_maps_to_error() {
    let v = json!({
        "choices": [ {
            "message": { "role": "assistant", "content": "" },
            "finish_reason": "error"
        } ]
    });
    let got = parse_openai_response(&v).expect("parses");
    assert_eq!(got.finish, FinishReason::Error);
    assert_eq!(got.text, None, "empty content collapses to None");
}

#[test]
fn openai_parse_malformed_missing_choices() {
    let err = parse_openai_response(&json!({ "usage": {} })).expect_err("must be malformed");
    assert!(matches!(err, ProviderError::Malformed(_)), "got {err:?}");
}

#[test]
fn openai_parse_malformed_multiple_choices() {
    let v = json!({
        "choices": [
            { "message": { "content": "a" }, "finish_reason": "stop" },
            { "message": { "content": "b" }, "finish_reason": "stop" }
        ]
    });
    let err = parse_openai_response(&v).expect_err("must be malformed");
    assert!(matches!(err, ProviderError::Malformed(_)), "got {err:?}");
}

// =============================================================================
// Anthropic request builder
// =============================================================================

#[test]
fn anthropic_minimal_body() {
    let req = ChatRequest {
        model: "claude-sonnet-4".into(),
        system: None,
        messages: vec![ChatMessage::User { text: "hello".into() }],
        tools: vec![],
        tool_choice: ToolChoice::Auto,
    };
    assert_eq!(
        build_anthropic_request("claude-sonnet-4", &req),
        json!({
            "model": "claude-sonnet-4",
            "max_tokens": 8192,
            "messages": [
                { "role": "user", "content": [ { "type": "text", "text": "hello" } ] }
            ]
        })
    );
}

#[test]
fn anthropic_full_body() {
    let req = ChatRequest {
        model: "claude-sonnet-4".into(),
        system: Some("You are terse.".into()),
        messages: vec![
            ChatMessage::User { text: "list files".into() },
            ChatMessage::Assistant {
                text: Some("checking".into()),
                tool_calls: vec![call("toolu_1", "bash", r#"{"cmd":"ls"}"#)],
            },
            ChatMessage::ToolResult {
                call_id: "toolu_1".into(),
                name: "bash".into(),
                content: vec![ToolContent::Text { text: "a.txt".into() }],
            },
        ],
        tools: vec![tool("bash")],
        tool_choice: ToolChoice::Auto,
    };
    assert_eq!(
        build_anthropic_request("claude-sonnet-4", &req),
        json!({
            "model": "claude-sonnet-4",
            "max_tokens": 8192,
            "system": [ { "type": "text", "text": "You are terse." } ],
            "messages": [
                { "role": "user", "content": [ { "type": "text", "text": "list files" } ] },
                {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "checking" },
                        { "type": "tool_use", "id": "toolu_1", "name": "bash", "input": { "cmd": "ls" } }
                    ]
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": [ { "type": "text", "text": "a.txt" } ]
                        }
                    ]
                }
            ],
            "tools": [
                {
                    "name": "bash",
                    "description": "bash does things",
                    "input_schema": {
                        "type": "object",
                        "properties": { "path": { "type": "string" } },
                        "required": ["path"]
                    }
                }
            ],
            "tool_choice": { "type": "auto" }
        })
    );
}

#[test]
fn anthropic_invalid_arguments_become_empty_object() {
    let req = ChatRequest {
        model: "claude-sonnet-4".into(),
        system: None,
        messages: vec![
            ChatMessage::User { text: "go".into() },
            // Both spellings the model might emit: garbage and a non-object.
            ChatMessage::Assistant {
                text: None,
                tool_calls: vec![call("t1", "bash", "not json at all"), call("t2", "bash", "[1,2]")],
            },
        ],
        tools: vec![],
        tool_choice: ToolChoice::Auto,
    };
    let body = build_anthropic_request("claude-sonnet-4", &req);
    let blocks = body["messages"][1]["content"].as_array().expect("assistant blocks");
    assert_eq!(blocks.len(), 2, "no text block when text is None");
    assert_eq!(blocks[0], json!({ "type": "tool_use", "id": "t1", "name": "bash", "input": {} }));
    assert_eq!(blocks[1], json!({ "type": "tool_use", "id": "t2", "name": "bash", "input": {} }));
}

#[test]
fn anthropic_consecutive_tool_results_merge_into_one_user_turn() {
    let req = ChatRequest {
        model: "claude-sonnet-4".into(),
        system: None,
        messages: vec![
            ChatMessage::ToolResult {
                call_id: "t1".into(),
                name: "bash".into(),
                content: vec![ToolContent::Text { text: "one".into() }],
            },
            ChatMessage::ToolResult {
                call_id: "t2".into(),
                name: "read".into(),
                content: vec![ToolContent::Text { text: "two".into() }],
            },
        ],
        tools: vec![],
        tool_choice: ToolChoice::Auto,
    };
    let body = build_anthropic_request("claude-sonnet-4", &req);
    let messages = body["messages"].as_array().expect("messages");
    assert_eq!(messages.len(), 1, "one merged user turn, got {body}");
    assert_eq!(messages[0]["role"], "user");
    let blocks = messages[0]["content"].as_array().expect("content blocks");
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["tool_use_id"], "t1");
    assert_eq!(blocks[1]["tool_use_id"], "t2");
}

#[test]
fn anthropic_no_tools_omits_keys() {
    let req = ChatRequest {
        model: "claude-sonnet-4".into(),
        system: Some("sys".into()),
        messages: vec![ChatMessage::User { text: "hi".into() }],
        tools: vec![],
        tool_choice: ToolChoice::None,
    };
    let body = build_anthropic_request("claude-sonnet-4", &req);
    assert!(body.get("tools").is_none());
    assert!(body.get("tool_choice").is_none());
}

#[test]
fn anthropic_tool_choice_none() {
    let req = ChatRequest {
        model: "claude-sonnet-4".into(),
        system: None,
        messages: vec![ChatMessage::User { text: "hi".into() }],
        tools: vec![tool("bash")],
        tool_choice: ToolChoice::None,
    };
    assert_eq!(build_anthropic_request("claude-sonnet-4", &req)["tool_choice"], json!({ "type": "none" }));
}

#[test]
fn anthropic_tool_result_file_becomes_text_placeholder() {
    let req = ChatRequest {
        model: "claude-sonnet-4".into(),
        system: None,
        messages: vec![ChatMessage::ToolResult {
            call_id: "t1".into(),
            name: "shot".into(),
            content: vec![
                ToolContent::Text { text: "screenshot:".into() },
                ToolContent::File { mime: "image/png".into(), url: "file:///tmp/a.png".into() },
            ],
        }],
        tools: vec![],
        tool_choice: ToolChoice::Auto,
    };
    let body = build_anthropic_request("claude-sonnet-4", &req);
    assert_eq!(
        body["messages"][0]["content"][0]["content"],
        json!([
            { "type": "text", "text": "screenshot:" },
            { "type": "text", "text": "[file: image/png file:///tmp/a.png]" }
        ])
    );
}

// =============================================================================
// Anthropic response parser
// =============================================================================

#[test]
fn anthropic_parse_text_only_with_usage() {
    let v = json!({
        "id": "msg_1",
        "content": [ { "type": "text", "text": "all done" } ],
        "stop_reason": "end_turn",
        "usage": {
            "input_tokens": 100,
            "output_tokens": 40,
            "cache_read_input_tokens": 60,
            "cache_creation_input_tokens": 5,
            "output_tokens_details": { "thinking_tokens": 8 }
        }
    });
    let got = parse_anthropic_response(&v).expect("parses");
    assert_eq!(got.text.as_deref(), Some("all done"));
    assert_eq!(got.finish, FinishReason::Stop);
    assert_eq!(
        got.usage,
        Some(LlmUsage { input: 100.0, output: 40.0, reasoning: 8.0, cache_read: 60.0, cache_write: 5.0 })
    );
}

#[test]
fn anthropic_parse_thinking_and_multiple_text_blocks() {
    let v = json!({
        "content": [
            { "type": "thinking", "thinking": "let me think", "signature": "sig" },
            { "type": "text", "text": "part one" },
            { "type": "text", "text": "part two" }
        ],
        "stop_reason": "stop_sequence"
    });
    let got = parse_anthropic_response(&v).expect("parses");
    assert_eq!(got.reasoning.as_deref(), Some("let me think"));
    assert_eq!(got.text.as_deref(), Some("part one\npart two"));
    assert_eq!(got.finish, FinishReason::Stop);
}

#[test]
fn anthropic_parse_tool_use_encodes_input() {
    let v = json!({
        "content": [
            { "type": "tool_use", "id": "toolu_9", "name": "bash", "input": { "cmd": "ls", "n": 2 } }
        ],
        "stop_reason": "tool_use",
        "usage": { "input_tokens": 10, "output_tokens": 20 }
    });
    let got = parse_anthropic_response(&v).expect("parses");
    assert_eq!(got.text, None);
    assert_eq!(got.finish, FinishReason::ToolCalls);
    assert_eq!(got.tool_calls.len(), 1);
    assert_eq!(got.tool_calls[0].id, "toolu_9");
    assert_eq!(got.tool_calls[0].name, "bash");
    assert_eq!(
        got.tool_calls[0].arguments,
        json!({ "cmd": "ls", "n": 2 }).to_string(),
        "arguments are the JSON-encoded input object"
    );
}

#[test]
fn anthropic_parse_stop_reason_matrix() {
    let parse = |stop: &str| {
        let v = json!({ "content": [], "stop_reason": stop });
        parse_anthropic_response(&v).expect("parses")
    };
    assert_eq!(parse("end_turn").finish, FinishReason::Stop);
    assert_eq!(parse("stop_sequence").finish, FinishReason::Stop);
    assert_eq!(parse("pause_turn").finish, FinishReason::Stop);
    assert_eq!(parse("max_tokens").finish, FinishReason::Length);
    assert_eq!(parse("model_context_window_exceeded").finish, FinishReason::Length);
    assert_eq!(parse("tool_use").finish, FinishReason::ToolCalls);
    assert_eq!(parse("refusal").finish, FinishReason::ContentFilter);
    assert_eq!(parse("refuse").finish, FinishReason::ContentFilter, "task-contract spelling");
    let unknown = parse("guardrail_intervention");
    assert_eq!(unknown.finish, FinishReason::Unknown);
    assert_eq!(unknown.raw_finish.as_deref(), Some("guardrail_intervention"));
}

#[test]
fn anthropic_parse_malformed_missing_content() {
    let err = parse_anthropic_response(&json!({ "stop_reason": "end_turn" })).expect_err("must be malformed");
    assert!(matches!(err, ProviderError::Malformed(_)), "got {err:?}");
}

#[test]
fn anthropic_parse_malformed_tool_use_missing_id() {
    let v = json!({
        "content": [ { "type": "tool_use", "name": "bash", "input": {} } ],
        "stop_reason": "tool_use"
    });
    let err = parse_anthropic_response(&v).expect_err("must be malformed");
    assert!(matches!(err, ProviderError::Malformed(_)), "got {err:?}");
}

// =============================================================================
// Client over a mock transport
// =============================================================================

#[derive(Clone)]
struct Captured {
    url: String,
    headers: Vec<(String, String)>,
    body: Value,
}

struct MockTransport {
    reply: Mutex<Option<Result<Value, ProviderError>>>,
    captured: Mutex<Option<Captured>>,
}

impl MockTransport {
    fn ok(response: Value) -> Arc<Self> {
        Arc::new(Self {
            reply: Mutex::new(Some(Ok(response))),
            captured: Mutex::new(None),
        })
    }

    fn err(error: ProviderError) -> Arc<Self> {
        Arc::new(Self {
            reply: Mutex::new(Some(Err(error))),
            captured: Mutex::new(None),
        })
    }

    fn captured(&self) -> Captured {
        self.captured.lock().expect("capture lock").clone().expect("transport was called")
    }
}

#[async_trait::async_trait]
impl Transport for MockTransport {
    async fn post_json(&self, url: &str, headers: Vec<(String, String)>, body: Value) -> Result<Value, ProviderError> {
        *self.captured.lock().expect("capture lock") = Some(Captured {
            url: url.to_owned(),
            headers,
            body,
        });
        self.reply.lock().expect("reply lock").take().expect("transport called more than once")
    }
}

fn openai_endpoint() -> Endpoint {
    Endpoint {
        protocol: Protocol::OpenAI,
        base_url: "https://api.openai.com/v1/".into(), // trailing slash is trimmed
        api_key: Some("sk-test".into()),
    }
}

fn anthropic_endpoint() -> Endpoint {
    Endpoint {
        protocol: Protocol::Anthropic,
        base_url: "https://api.anthropic.com".into(),
        api_key: Some("sk-ant-test".into()),
    }
}

fn sample_request() -> ChatRequest {
    ChatRequest {
        model: "fallback-model".into(),
        system: Some("be brief".into()),
        messages: vec![ChatMessage::User { text: "hi".into() }],
        tools: vec![],
        tool_choice: ToolChoice::Auto,
    }
}

#[tokio::test]
async fn client_openai_posts_to_chat_completions() {
    let transport = MockTransport::ok(json!({
        "choices": [ {
            "message": { "role": "assistant", "content": "hello there" },
            "finish_reason": "stop"
        } ],
        "usage": { "prompt_tokens": 7, "completion_tokens": 3 }
    }));
    let client = Client::with_transport(openai_endpoint(), transport.clone());

    let got = client.complete("gpt-5", &sample_request()).await.expect("completes");

    let captured = transport.captured();
    assert_eq!(captured.url, "https://api.openai.com/v1/chat/completions");
    assert!(
        captured.headers.contains(&("Authorization".into(), "Bearer sk-test".into())),
        "headers: {:?}",
        captured.headers
    );
    assert_eq!(captured.body["model"], "gpt-5", "model_id parameter wins");
    assert_eq!(captured.body["messages"][0], json!({ "role": "system", "content": "be brief" }));
    assert_eq!(got.text.as_deref(), Some("hello there"));
    assert_eq!(got.finish, FinishReason::Stop);
    assert_eq!(got.usage, Some(LlmUsage { input: 7.0, output: 3.0, ..Default::default() }));
}

#[tokio::test]
async fn client_anthropic_posts_to_v1_messages() {
    let transport = MockTransport::ok(json!({
        "content": [ { "type": "text", "text": "bonjour" } ],
        "stop_reason": "end_turn",
        "usage": { "input_tokens": 4, "output_tokens": 2 }
    }));
    let client = Client::with_transport(anthropic_endpoint(), transport.clone());

    let got = client.complete("claude-sonnet-4", &sample_request()).await.expect("completes");

    let captured = transport.captured();
    assert_eq!(captured.url, "https://api.anthropic.com/v1/messages");
    assert!(
        captured.headers.contains(&("x-api-key".into(), "sk-ant-test".into())),
        "headers: {:?}",
        captured.headers
    );
    assert!(
        captured.headers.contains(&("anthropic-version".into(), "2023-06-01".into())),
        "headers: {:?}",
        captured.headers
    );
    assert_eq!(captured.body["max_tokens"], 8192);
    assert_eq!(got.text.as_deref(), Some("bonjour"));
    assert_eq!(got.finish, FinishReason::Stop);
}

#[tokio::test]
async fn client_without_api_key_omits_auth_headers() {
    let transport = MockTransport::ok(json!({
        "choices": [ { "message": { "content": "x" }, "finish_reason": "stop" } ]
    }));
    let endpoint = Endpoint { api_key: None, ..openai_endpoint() };
    let client = Client::with_transport(endpoint, transport.clone());
    client.complete("gpt-5", &sample_request()).await.expect("completes");
    let captured = transport.captured();
    assert!(
        !captured.headers.iter().any(|(name, _)| name == "Authorization"),
        "no auth header without an api key: {:?}",
        captured.headers
    );
}

#[tokio::test]
async fn client_http_error_propagates() {
    let transport = MockTransport::err(ProviderError::Http { status: 429, body: "slow down".into() });
    let client = Client::with_transport(openai_endpoint(), transport);
    let err = client.complete("gpt-5", &sample_request()).await.expect_err("must fail");
    assert!(matches!(err, ProviderError::Http { status: 429, .. }), "got {err:?}");
}

#[tokio::test]
async fn client_empty_model_id_falls_back_to_request_model() {
    let transport = MockTransport::ok(json!({
        "choices": [ { "message": { "content": "x" }, "finish_reason": "stop" } ]
    }));
    let client = Client::with_transport(openai_endpoint(), transport.clone());
    client.complete("", &sample_request()).await.expect("completes");
    assert_eq!(transport.captured().body["model"], "fallback-model");
}

// =============================================================================
// Streaming: scripted byte-stream transport
// =============================================================================

use crate::{
    parse_anthropic_sse_frame, parse_openai_sse_frame, parse_sse_frame, AnthropicStreamState, ByteStream, OnEvent,
    OpenAiStreamState, SseFrame, StreamEvent,
};
use bytes::Bytes;

struct ScriptedStream {
    captured: Mutex<Option<Captured>>,
    chunks: Vec<Result<Bytes, ProviderError>>,
}

impl ScriptedStream {
    fn new(chunks: Vec<Result<Bytes, ProviderError>>) -> Arc<Self> {
        Arc::new(Self { captured: Mutex::new(None), chunks })
    }

    fn captured(&self) -> Captured {
        self.captured.lock().expect("capture lock").clone().expect("transport was called")
    }
}

#[async_trait::async_trait]
impl Transport for ScriptedStream {
    async fn post_json(&self, _url: &str, _headers: Vec<(String, String)>, _body: Value) -> Result<Value, ProviderError> {
        Err(ProviderError::Transport("post_json reached although post_stream is implemented".into()))
    }

    async fn post_stream(&self, url: &str, headers: Vec<(String, String)>, body: Value) -> Result<ByteStream, ProviderError> {
        *self.captured.lock().expect("capture lock") = Some(Captured { url: url.to_owned(), headers, body });
        Ok(Box::pin(futures_util::stream::iter(self.chunks.clone())))
    }
}

/// `data: {json}\n\n` wire frames for each value.
fn sse_chunks(frames: &[Value]) -> Vec<Result<Bytes, ProviderError>> {
    frames
        .iter()
        .map(|v| Ok(Bytes::from(format!("data: {v}\n\n"))))
        .collect()
}

fn done_chunk() -> Result<Bytes, ProviderError> {
    Ok(Bytes::from("data: [DONE]\n\n"))
}

/// A callback sink collecting every event in stream order.
fn recorder() -> (OnEvent, Arc<Mutex<Vec<StreamEvent>>>) {
    let events: Arc<Mutex<Vec<StreamEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (Arc::new(move |event| sink.lock().expect("event lock").push(event)), events)
}

#[tokio::test]
async fn openai_streaming_text_usage_and_done() {
    let frames = vec![
        json!({ "choices": [ { "index": 0, "delta": { "role": "assistant", "content": "Hel" } } ] }),
        json!({ "choices": [ { "index": 0, "delta": { "content": "lo" } } ] }),
        json!({ "choices": [ { "index": 0, "delta": {}, "finish_reason": "stop" } ] }),
        json!({ "choices": [ { "index": 0, "delta": {} } ], "usage": { "prompt_tokens": 7, "completion_tokens": 3 } }),
    ];
    let mut chunks = sse_chunks(&frames);
    chunks.push(done_chunk());
    let transport = ScriptedStream::new(chunks);
    let client = Client::with_transport(openai_endpoint(), transport.clone());

    let (on_event, events) = recorder();
    let got = client.complete_streaming("gpt-5", &sample_request(), on_event).await.expect("streams");

    assert_eq!(
        *events.lock().expect("event lock"),
        vec![
            StreamEvent::Text { delta: "Hel".into() },
            StreamEvent::Text { delta: "lo".into() },
            StreamEvent::Finished,
        ]
    );
    assert_eq!(
        got,
        parse_openai_response(&json!({
            "choices": [ { "message": { "content": "Hello" }, "finish_reason": "stop" } ],
            "usage": { "prompt_tokens": 7, "completion_tokens": 3 }
        }))
        .expect("parses"),
        "stream result equals the non-streaming parse of the full body"
    );

    let captured = transport.captured();
    assert_eq!(captured.url, "https://api.openai.com/v1/chat/completions");
    assert_eq!(captured.body["stream"], true);
    assert_eq!(captured.body["stream_options"], json!({ "include_usage": true }));
    assert_eq!(captured.body["model"], "gpt-5");
}

#[tokio::test]
async fn openai_streaming_tool_call_fragment_reassembly() {
    // call_1's arguments arrive split across three frames.
    let frames = vec![
        json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
            { "index": 0, "id": "call_1", "type": "function", "function": { "name": "bash", "arguments": "" } }
        ] } } ] }),
        json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": "{\"cmd\":" } }
        ] } } ] }),
        json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": "\"ls -la\"}" } }
        ] } } ] }),
        json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
            { "index": 1, "id": "call_2", "type": "function", "function": { "name": "read", "arguments": "{\"path\":\"a\"}" } }
        ] } } ] }),
        json!({ "choices": [ { "index": 0, "delta": {}, "finish_reason": "tool_calls" } ] }),
        json!({ "choices": [ { "index": 0, "delta": {} } ], "usage": { "prompt_tokens": 5, "completion_tokens": 9 } }),
    ];
    let mut chunks = sse_chunks(&frames);
    chunks.push(done_chunk());
    let transport = ScriptedStream::new(chunks);
    let client = Client::with_transport(openai_endpoint(), transport.clone());

    let (on_event, events) = recorder();
    let got = client.complete_streaming("gpt-5", &sample_request(), on_event).await.expect("streams");

    assert_eq!(
        *events.lock().expect("event lock"),
        vec![
            StreamEvent::ToolCallStarted { index: 0, id: "call_1".into(), name: "bash".into() },
            StreamEvent::ToolCallDelta { index: 0, arguments_delta: "{\"cmd\":".into() },
            StreamEvent::ToolCallDelta { index: 0, arguments_delta: "\"ls -la\"}".into() },
            StreamEvent::ToolCallStarted { index: 1, id: "call_2".into(), name: "read".into() },
            StreamEvent::ToolCallDelta { index: 1, arguments_delta: "{\"path\":\"a\"}".into() },
            StreamEvent::Finished,
        ]
    );
    assert_eq!(
        got,
        parse_openai_response(&json!({
            "choices": [ {
                "message": {
                    "content": null,
                    "tool_calls": [
                        { "id": "call_1", "type": "function", "function": { "name": "bash", "arguments": "{\"cmd\":\"ls -la\"}" } },
                        { "id": "call_2", "type": "function", "function": { "name": "read", "arguments": "{\"path\":\"a\"}" } }
                    ]
                },
                "finish_reason": "tool_calls"
            } ],
            "usage": { "prompt_tokens": 5, "completion_tokens": 9 }
        }))
        .expect("parses"),
        "reassembled stream equals the non-streaming parse of the full body"
    );
    assert_eq!(got.tool_calls[0].arguments, "{\"cmd\":\"ls -la\"}", "fragments concatenated");
}

#[test]
fn openai_stream_parser_reassembles_fragments_purely() {
    let mut state = OpenAiStreamState::default();
    let frames = [
        json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
            { "index": 0, "id": "call_1", "type": "function", "function": { "name": "bash" } }
        ] } } ] }),
        json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": "{\"cmd\":" } }
        ] } } ] }),
        json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": "\"ls\"" } }
        ] } } ] }),
        json!({ "choices": [ { "index": 0, "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": "}" } }
        ] } } ] }),
    ];
    for frame in &frames {
        parse_openai_sse_frame(frame, &mut state).expect("frame parses");
    }
    let got = state.finish().expect("finishes");
    assert_eq!(
        got.tool_calls,
        vec![call("call_1", "bash", "{\"cmd\":\"ls\"}")],
        "arguments split over 4 frames reassemble"
    );
}

#[test]
fn openai_stream_unknown_frames_are_ignored() {
    let mut state = OpenAiStreamState::default();
    assert!(parse_openai_sse_frame(&json!({ "totally": "unknown" }), &mut state).expect("ok").is_empty());
    assert!(parse_openai_sse_frame(&json!({ "choices": [] }), &mut state).expect("ok").is_empty());
    assert!(
        parse_openai_sse_frame(&json!({ "choices": [ { "index": 0, "delta": {} } ] }), &mut state)
            .expect("ok")
            .is_empty()
    );
    assert_eq!(
        state.finish().expect("finishes"),
        parse_openai_response(&json!({ "choices": [ { "message": { "content": null } } ] })).expect("parses"),
        "empty stream behaves like an empty non-streaming body (finish Unknown)"
    );
}

#[test]
fn parse_sse_frame_decodes_sentinel_blank_and_json() {
    assert_eq!(parse_sse_frame("[DONE]").expect("ok"), Some(SseFrame::Done));
    assert_eq!(parse_sse_frame("   \n").expect("ok"), None, "blank frames are skipped");
    assert!(parse_sse_frame("not json").is_err(), "non-JSON payload is malformed");
    assert!(matches!(parse_sse_frame("{\"type\":\"ping\"}").expect("ok"), Some(SseFrame::Json(_))));
}

#[tokio::test]
async fn anthropic_streaming_text_usage_merge_and_message_stop() {
    let frames = vec![
        json!({ "type": "message_start", "message": { "id": "msg_1", "usage": {
            "input_tokens": 100, "cache_read_input_tokens": 60, "cache_creation_input_tokens": 5 } } }),
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "bon" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "jour" } }),
        json!({ "type": "content_block_stop", "index": 0 }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 40 } }),
        json!({ "type": "message_stop" }),
    ];
    let transport = ScriptedStream::new(sse_chunks(&frames));
    let client = Client::with_transport(anthropic_endpoint(), transport.clone());

    let (on_event, events) = recorder();
    let got = client.complete_streaming("claude-sonnet-4", &sample_request(), on_event).await.expect("streams");

    assert_eq!(
        *events.lock().expect("event lock"),
        vec![
            StreamEvent::Text { delta: "bon".into() },
            StreamEvent::Text { delta: "jour".into() },
            StreamEvent::Finished,
        ]
    );
    assert_eq!(
        got,
        parse_anthropic_response(&json!({
            "content": [ { "type": "text", "text": "bonjour" } ],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 100, "output_tokens": 40,
                "cache_read_input_tokens": 60, "cache_creation_input_tokens": 5
            }
        }))
        .expect("parses"),
        "usage merges message_start input with message_delta output"
    );

    let captured = transport.captured();
    assert_eq!(captured.url, "https://api.anthropic.com/v1/messages");
    assert_eq!(captured.body["stream"], true);
    assert!(captured.body.get("stream_options").is_none(), "stream_options is OpenAI-only");
}

#[tokio::test]
async fn anthropic_streaming_tool_call_reassembly() {
    let frames = vec![
        json!({ "type": "message_start", "message": { "usage": { "input_tokens": 10 } } }),
        json!({ "type": "content_block_start", "index": 0, "content_block": {
            "type": "tool_use", "id": "toolu_1", "name": "bash", "input": {} } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": "{\"cmd\":" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": "\"ls\"," } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "input_json_delta", "partial_json": "\"n\":2}" } }),
        json!({ "type": "content_block_stop", "index": 0 }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 20 } }),
        json!({ "type": "message_stop" }),
    ];
    let transport = ScriptedStream::new(sse_chunks(&frames));
    let client = Client::with_transport(anthropic_endpoint(), transport.clone());

    let (on_event, events) = recorder();
    let got = client.complete_streaming("claude-sonnet-4", &sample_request(), on_event).await.expect("streams");

    assert_eq!(
        *events.lock().expect("event lock"),
        vec![
            StreamEvent::ToolCallStarted { index: 0, id: "toolu_1".into(), name: "bash".into() },
            StreamEvent::ToolCallDelta { index: 0, arguments_delta: "{\"cmd\":".into() },
            StreamEvent::ToolCallDelta { index: 0, arguments_delta: "\"ls\",".into() },
            StreamEvent::ToolCallDelta { index: 0, arguments_delta: "\"n\":2}".into() },
            StreamEvent::Finished,
        ]
    );
    assert_eq!(
        got,
        parse_anthropic_response(&json!({
            "content": [ { "type": "tool_use", "id": "toolu_1", "name": "bash", "input": { "cmd": "ls", "n": 2 } } ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 10, "output_tokens": 20 }
        }))
        .expect("parses"),
        "reassembled partial_json equals the non-streaming input encoding"
    );
}

#[tokio::test]
async fn anthropic_streaming_thinking_then_text() {
    let frames = vec![
        json!({ "type": "message_start", "message": { "usage": { "input_tokens": 10 } } }),
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "think" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "ing" } }),
        json!({ "type": "content_block_stop", "index": 0 }),
        json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "answer" } }),
        json!({ "type": "content_block_stop", "index": 1 }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "stop_sequence" } }),
        json!({ "type": "message_stop" }),
    ];
    let transport = ScriptedStream::new(sse_chunks(&frames));
    let client = Client::with_transport(anthropic_endpoint(), transport.clone());

    let (on_event, events) = recorder();
    let got = client.complete_streaming("claude-sonnet-4", &sample_request(), on_event).await.expect("streams");

    assert_eq!(
        *events.lock().expect("event lock"),
        vec![
            StreamEvent::Reasoning { delta: "think".into() },
            StreamEvent::Reasoning { delta: "ing".into() },
            StreamEvent::Text { delta: "answer".into() },
            StreamEvent::Finished,
        ]
    );
    assert_eq!(
        got,
        parse_anthropic_response(&json!({
            "content": [
                { "type": "thinking", "thinking": "thinking" },
                { "type": "text", "text": "answer" }
            ],
            "stop_reason": "stop_sequence",
            "usage": { "input_tokens": 10 }
        }))
        .expect("parses")
    );
}

#[test]
fn anthropic_stream_unknown_events_ignored_error_fails() {
    let mut state = AnthropicStreamState::default();
    assert!(parse_anthropic_sse_frame(&json!({ "type": "ping" }), &mut state).expect("ok").is_empty());
    assert!(
        parse_anthropic_sse_frame(&json!({ "type": "content_block_stop", "index": 0 }), &mut state)
            .expect("ok")
            .is_empty()
    );
    assert!(
        parse_anthropic_sse_frame(&json!({ "type": "sigil_delta", "index": 0 }), &mut state)
            .expect("ok")
            .is_empty(),
        "unknown event types are ignored"
    );
    let err = parse_anthropic_sse_frame(
        &json!({ "type": "error", "error": { "message": "overloaded" } }),
        &mut state,
    )
    .expect_err("error events fail the stream");
    assert!(matches!(err, ProviderError::Malformed(ref m) if m == "overloaded"), "got {err:?}");
}

#[tokio::test]
async fn anthropic_stream_frames_split_across_byte_chunks() {
    // The whole SSE payload split at arbitrary byte boundaries still frames
    // correctly (a frame may straddle chunks, including the `\n\n`).
    let frames = vec![
        json!({ "type": "message_start", "message": { "usage": { "input_tokens": 3 } } }),
        json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
        json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "hi" } }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 4 } }),
        json!({ "type": "message_stop" }),
    ];
    let payload: String = frames.iter().map(|f| format!("data: {f}\n\n")).collect();
    let chunks: Vec<Result<Bytes, ProviderError>> = payload
        .as_bytes()
        .chunks(7)
        .map(|slice| Ok(Bytes::copy_from_slice(slice)))
        .collect();
    let transport = ScriptedStream::new(chunks);
    let client = Client::with_transport(anthropic_endpoint(), transport);

    let (on_event, events) = recorder();
    let got = client.complete_streaming("claude-sonnet-4", &sample_request(), on_event).await.expect("streams");
    assert_eq!(
        *events.lock().expect("event lock"),
        vec![
            StreamEvent::Text { delta: "hi".into() },
            StreamEvent::Finished,
        ]
    );
    assert_eq!(got.text.as_deref(), Some("hi"));
    assert_eq!(got.finish, FinishReason::Stop);
    assert_eq!(got.usage, Some(LlmUsage { input: 3.0, output: 4.0, ..Default::default() }));
}

#[tokio::test]
async fn streaming_falls_back_to_complete_without_post_stream() {
    // MockTransport only implements post_json: the default post_stream
    // reports "streaming not supported" and complete_streaming falls back.
    let transport = MockTransport::ok(json!({
        "choices": [ { "message": { "content": "plain" }, "finish_reason": "stop" } ]
    }));
    let client = Client::with_transport(openai_endpoint(), transport.clone());

    let (on_event, events) = recorder();
    let got = client.complete_streaming("gpt-5", &sample_request(), on_event).await.expect("falls back");

    let captured = transport.captured();
    assert!(captured.body.get("stream").is_none(), "the fallback body must not stream");
    assert_eq!(got.text.as_deref(), Some("plain"));
    assert_eq!(got.finish, FinishReason::Stop);
    assert!(events.lock().expect("event lock").is_empty(), "no events are emitted on the fallback path");
}
