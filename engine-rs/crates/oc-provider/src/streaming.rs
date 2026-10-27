//! Streaming subset: SSE frame parsing for both protocols.
//!
//! The upstream protocols are stream-first (`openai-chat.ts` /
//! `anthropic-messages.ts` stream state machines); this module reuses the
//! non-streaming parsers' finish-reason and usage mapping and accumulates
//! deltas into the same `LlmResponse` shape.
//!
//! Documented deltas vs upstream (all upstream file references are
//! `packages/ai/src/protocols/{openai-chat,anthropic-messages}.ts`):
//! - OpenAI tool-call deltas require `tool_calls[].index` (upstream also
//!   falls back to id matching / batch position for compatible providers
//!   that omit it).
//! - OpenAI reasoning deltas come from `reasoning_content`, `reasoning` or
//!   `reasoning_text` (upstream adds a per-model configured field); the
//!   accumulated reasoning surfaces on `LlmResponse.reasoning`, which the
//!   non-streaming parse always leaves `None`.
//! - OpenAI usage is honored on the top-level `usage` field and, like
//!   upstream, on `choices[0].usage` (Moonshot-style compatible providers).
//! - An OpenAI stream that ends without `[DONE]` or a `finish_reason` still
//!   produces a response; the missing reason maps to `FinishReason::Unknown`
//!   (upstream raises an `AIError`).
//! - Anthropic usage is right-biased merged per field (non-zero wins) across
//!   `message_start` and `message_delta`, mirroring upstream `mergeUsage`.
//! - Anthropic `signature_delta` deltas and `compaction_delta` are ignored
//!   (reasoning signatures / compaction are not ported).
//! - An Anthropic `error` event maps to `ProviderError::Malformed`
//!   (upstream raises a classified provider error).

use std::collections::BTreeMap;
use std::sync::Arc;

use futures_util::StreamExt;
use oc_schema::{FinishReason, LlmResponse, LlmToolCall, LlmUsage};
use serde_json::Value;

use crate::{anthropic_finish_reason, anthropic_usage, openai_finish_reason, openai_usage, Protocol, ProviderError};

/// The raw byte stream a `Transport::post_stream` hands back.
pub type ByteStream =
    std::pin::Pin<Box<dyn futures_util::Stream<Item = Result<bytes::Bytes, ProviderError>> + Send>>;

/// Protocol-neutral streaming event handed to the caller's callback.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    Text { delta: String },
    Reasoning { delta: String },
    ToolCallStarted { index: usize, id: String, name: String },
    ToolCallDelta { index: usize, arguments_delta: String },
    Finished, // terminal SSE event received
}

/// Callback invoked once per streamed event, in stream order.
pub type OnEvent = Arc<dyn Fn(StreamEvent) + Send + Sync>;

// =============================================================================
// SSE framing
// =============================================================================

/// One decoded SSE frame: a JSON payload or the `[DONE]` sentinel.
#[derive(Debug, Clone, PartialEq)]
pub enum SseFrame {
    Json(Value),
    Done,
}

/// Decode one SSE frame (the frame's joined `data:` payload). Blank frames
/// are skipped (`None`); `[DONE]` maps to [`SseFrame::Done`]; anything else
/// must be JSON.
pub fn parse_sse_frame(frame: &str) -> Result<Option<SseFrame>, ProviderError> {
    let payload = frame.trim();
    if payload.is_empty() {
        return Ok(None);
    }
    if payload == "[DONE]" {
        return Ok(Some(SseFrame::Done));
    }
    let value = serde_json::from_str(payload)
        .map_err(|e| ProviderError::Malformed(format!("invalid SSE data payload: {e}")))?;
    Ok(Some(SseFrame::Json(value)))
}

/// Buffers raw SSE bytes and yields complete event frames. A frame is the
/// event's `data:` payload; multiple `data:` lines of one event are joined
/// with `\n`. `event:`/`id:`/`retry:` lines and comments are irrelevant here
/// (both upstream protocols put the type inside the JSON payload).
#[derive(Default)]
struct SseBuffer {
    buf: Vec<u8>,
    data: Vec<String>,
}

impl SseBuffer {
    /// Feed one chunk; returns every frame the chunk completed. Frames may
    /// split across chunk boundaries.
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            self.take_line(&line[..line.len() - 1], &mut frames);
        }
        frames
    }

    /// Frames still open at end-of-stream (a server that omits the final
    /// blank line, or a truncated frame).
    fn flush(&mut self) -> Vec<String> {
        let mut frames = Vec::new();
        if !self.buf.is_empty() {
            let line = std::mem::take(&mut self.buf);
            self.take_line(&line, &mut frames);
        }
        if !self.data.is_empty() {
            frames.push(std::mem::take(&mut self.data).join("\n"));
        }
        frames
    }

    fn take_line(&mut self, raw: &[u8], frames: &mut Vec<String>) {
        let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
        let line = String::from_utf8_lossy(raw);
        if line.is_empty() {
            if !self.data.is_empty() {
                frames.push(std::mem::take(&mut self.data).join("\n"));
            }
        } else if let Some(rest) = line.strip_prefix("data:") {
            // SSE strips exactly one leading space after the field name.
            self.data.push(rest.strip_prefix(' ').unwrap_or(rest).to_owned());
        }
    }
}

// =============================================================================
// OpenAI Chat Completions streaming
// =============================================================================

#[derive(Debug, Default, Clone)]
struct OpenAiPendingToolCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    /// `ToolCallStarted` fires exactly once per index (first fragment),
    /// carrying whatever id/name the stream has delivered so far.
    announced: bool,
}

/// Accumulator for one OpenAI `chat/completions` stream. Fed by
/// [`parse_openai_sse_frame`], finished with [`OpenAiStreamState::finish`].
#[derive(Debug, Default)]
pub struct OpenAiStreamState {
    text: String,
    reasoning: String,
    tool_calls: BTreeMap<usize, OpenAiPendingToolCall>,
    finish: Option<(FinishReason, Option<String>)>,
    usage: Option<LlmUsage>,
}

/// Apply one OpenAI streaming chunk to the state; returns the events it
/// produced in order. Unknown chunk shapes are ignored.
pub fn parse_openai_sse_frame(chunk: &Value, state: &mut OpenAiStreamState) -> Result<Vec<StreamEvent>, ProviderError> {
    let mut events = Vec::new();

    // Trailing usage chunk (with `stream_options.include_usage`), plus the
    // Moonshot-style `choices[0].usage` fallback.
    if let Some(u) = non_null(chunk.get("usage")) {
        state.usage = Some(openai_usage(u));
    }
    let choice = chunk.pointer("/choices/0");
    if let Some(u) = choice.and_then(|c| non_null(c.get("usage"))) {
        state.usage = Some(openai_usage(u));
    }

    let Some(choice) = choice else {
        return Ok(events);
    };
    if let Some(raw) = choice.get("finish_reason").and_then(Value::as_str) {
        state.finish = Some(openai_finish_reason(Some(raw)));
    }
    let Some(delta) = choice.get("delta") else {
        return Ok(events);
    };

    if let Some(text) = delta.get("content").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        state.text.push_str(text);
        events.push(StreamEvent::Text { delta: text.to_owned() });
    }

    // Reasoning: upstream checks a configured field plus
    // `reasoning_content` / `reasoning` / `reasoning_text`; the port checks
    // those three in order.
    let reasoning = ["reasoning_content", "reasoning", "reasoning_text"].iter().find_map(|field| {
        delta.get(*field).and_then(Value::as_str).filter(|s| !s.is_empty())
    });
    if let Some(reasoning) = reasoning {
        state.reasoning.push_str(reasoning);
        events.push(StreamEvent::Reasoning { delta: reasoning.to_owned() });
    }

    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let index = call
                .get("index")
                .and_then(Value::as_u64)
                .ok_or_else(|| ProviderError::Malformed("tool call delta missing index".into()))?
                as usize;
            let entry = state.tool_calls.entry(index).or_default();
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                if entry.id.is_none() {
                    entry.id = Some(id.to_owned());
                }
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                if entry.name.is_none() {
                    entry.name = Some(name.to_owned());
                }
            }
            if !entry.announced {
                entry.announced = true;
                events.push(StreamEvent::ToolCallStarted {
                    index,
                    id: entry.id.clone().unwrap_or_default(),
                    name: entry.name.clone().unwrap_or_default(),
                });
            }
            if let Some(fragment) = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                entry.arguments.push_str(fragment);
                events.push(StreamEvent::ToolCallDelta {
                    index,
                    arguments_delta: fragment.to_owned(),
                });
            }
        }
    }

    Ok(events)
}

impl OpenAiStreamState {
    /// Build the final response. Tool calls come back in `index` order with
    /// argument fragments concatenated (empty arguments degrade to `"{}"`,
    /// like the non-streaming parser); a missing id/name is malformed.
    pub fn finish(self) -> Result<LlmResponse, ProviderError> {
        let tool_calls = self
            .tool_calls
            .into_iter()
            .map(|(_, pending)| {
                let id = pending
                    .id
                    .ok_or_else(|| ProviderError::Malformed("streamed tool call missing id".into()))?;
                let name = pending
                    .name
                    .ok_or_else(|| ProviderError::Malformed("streamed tool call missing name".into()))?;
                let arguments = if pending.arguments.is_empty() { "{}".to_owned() } else { pending.arguments };
                Ok(LlmToolCall { id, name, arguments })
            })
            .collect::<Result<Vec<_>, ProviderError>>()?;
        let (finish, raw_finish) = self.finish.unwrap_or((FinishReason::Unknown, None));
        Ok(LlmResponse {
            text: collapse(self.text),
            reasoning: collapse(self.reasoning),
            tool_calls,
            finish,
            raw_finish,
            usage: self.usage,
        })
    }
}

// =============================================================================
// Anthropic Messages streaming
// =============================================================================

#[derive(Debug, Default, Clone)]
struct AnthropicPendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Accumulator for one Anthropic Messages stream. Fed by
/// [`parse_anthropic_sse_frame`], finished with
/// [`AnthropicStreamState::finish`].
#[derive(Debug, Default)]
pub struct AnthropicStreamState {
    /// Per content-block text; blocks join with `\n` at finish, deltas
    /// inside a block concatenate — matching the non-streaming parse.
    text_blocks: BTreeMap<usize, String>,
    thinking_blocks: BTreeMap<usize, String>,
    tools: BTreeMap<usize, AnthropicPendingToolCall>,
    finish: Option<(FinishReason, Option<String>)>,
    usage: Option<LlmUsage>,
}

/// Apply one Anthropic SSE event to the state; returns the events it
/// produced in order. Unknown event types (and `ping`) are ignored; an
/// `error` event is malformed.
pub fn parse_anthropic_sse_frame(
    event: &Value,
    state: &mut AnthropicStreamState,
) -> Result<Vec<StreamEvent>, ProviderError> {
    let mut events = Vec::new();
    match event.get("type").and_then(Value::as_str) {
        Some("message_start") => {
            if let Some(u) = event.pointer("/message/usage").and_then(non_null) {
                state.usage = Some(anthropic_usage(u));
            }
        }
        Some("content_block_start") => {
            let block = event.get("content_block").unwrap_or(&Value::Null);
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                let index = block_index(event)?;
                let id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ProviderError::Malformed("tool_use block missing id".into()))?;
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ProviderError::Malformed("tool_use block missing name".into()))?;
                // A whole `input` object here is server-side completion;
                // client tools start with `{}`.
                let arguments = match block.get("input") {
                    Some(input) if input.as_object().is_some_and(|o| !o.is_empty()) => input.to_string(),
                    _ => String::new(),
                };
                state.tools.insert(index, AnthropicPendingToolCall {
                    id: id.to_owned(),
                    name: name.to_owned(),
                    arguments,
                });
                events.push(StreamEvent::ToolCallStarted { index, id: id.to_owned(), name: name.to_owned() });
            }
        }
        Some("content_block_delta") => {
            let delta = event.get("delta").unwrap_or(&Value::Null);
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => {
                    if let Some(text) = delta.get("text").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        let index = block_index(event)?;
                        state.text_blocks.entry(index).or_default().push_str(text);
                        events.push(StreamEvent::Text { delta: text.to_owned() });
                    }
                }
                Some("thinking_delta") => {
                    if let Some(thinking) = delta.get("thinking").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        let index = block_index(event)?;
                        state.thinking_blocks.entry(index).or_default().push_str(thinking);
                        events.push(StreamEvent::Reasoning { delta: thinking.to_owned() });
                    }
                }
                Some("input_json_delta") => {
                    let index = block_index(event)?;
                    let entry = state
                        .tools
                        .get_mut(&index)
                        .ok_or_else(|| ProviderError::Malformed("tool argument delta without a tool_use start".into()))?;
                    if let Some(fragment) = delta
                        .get("partial_json")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        entry.arguments.push_str(fragment);
                        events.push(StreamEvent::ToolCallDelta {
                            index,
                            arguments_delta: fragment.to_owned(),
                        });
                    }
                }
                // `signature_delta` and anything new are ignored (reasoning
                // signatures are not ported).
                _ => {}
            }
        }
        Some("message_delta") => {
            // The final delta carries the authoritative totals; right-biased
            // merge per field (upstream `mergeUsage`).
            if let Some(u) = event.get("usage").and_then(non_null) {
                let next = anthropic_usage(u);
                match &mut state.usage {
                    None => state.usage = Some(next),
                    Some(current) => {
                        if next.input != 0.0 {
                            current.input = next.input;
                        }
                        if next.output != 0.0 {
                            current.output = next.output;
                        }
                        if next.reasoning != 0.0 {
                            current.reasoning = next.reasoning;
                        }
                        if next.cache_read != 0.0 {
                            current.cache_read = next.cache_read;
                        }
                        if next.cache_write != 0.0 {
                            current.cache_write = next.cache_write;
                        }
                    }
                }
            }
            if let Some(raw) = event.pointer("/delta/stop_reason").and_then(Value::as_str) {
                state.finish = Some(anthropic_finish_reason(Some(raw)));
            }
        }
        Some("message_stop") => events.push(StreamEvent::Finished),
        Some("error") => {
            let message = event
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("anthropic stream error event");
            return Err(ProviderError::Malformed(message.to_owned()));
        }
        // `ping`, `content_block_stop` and unknown types are ignored.
        _ => {}
    }
    Ok(events)
}

impl AnthropicStreamState {
    /// Build the final response: text/thinking blocks join with `\n` in
    /// block order, tool arguments concatenate per block (empty degrades to
    /// `"{}"`).
    pub fn finish(self) -> Result<LlmResponse, ProviderError> {
        let join_blocks = |blocks: BTreeMap<usize, String>| {
            let parts: Vec<&str> = blocks.values().map(String::as_str).filter(|s| !s.is_empty()).collect();
            if parts.is_empty() { None } else { Some(parts.join("\n")) }
        };
        let tool_calls = self
            .tools
            .into_iter()
            .map(|(_, pending)| LlmToolCall {
                id: pending.id,
                name: pending.name,
                arguments: if pending.arguments.is_empty() { "{}".to_owned() } else { pending.arguments },
            })
            .collect();
        let (finish, raw_finish) = self.finish.unwrap_or((FinishReason::Unknown, None));
        Ok(LlmResponse {
            text: join_blocks(self.text_blocks),
            reasoning: join_blocks(self.thinking_blocks),
            tool_calls,
            finish,
            raw_finish,
            usage: self.usage,
        })
    }
}

fn block_index(event: &Value) -> Result<usize, ProviderError> {
    event
        .get("index")
        .and_then(Value::as_u64)
        .map(|i| i as usize)
        .ok_or_else(|| ProviderError::Malformed("content block event missing index".into()))
}

// =============================================================================
// Stream driver
// =============================================================================

/// Consume the byte stream, emit [`StreamEvent`]s and accumulate the final
/// [`LlmResponse`]. Returns after the protocol's terminal event (`[DONE]`
/// for OpenAI, `message_stop` for Anthropic) or at end-of-stream.
pub async fn drive_sse(
    mut stream: ByteStream,
    protocol: Protocol,
    on_event: OnEvent,
) -> Result<LlmResponse, ProviderError> {
    let mut buffer = SseBuffer::default();
    let mut openai = OpenAiStreamState::default();
    let mut anthropic = AnthropicStreamState::default();
    let mut terminal = false;

    'outer: while let Some(chunk) = stream.next().await {
        for frame in buffer.push(chunk?) {
            if handle_frame(&frame, protocol, &mut openai, &mut anthropic, &on_event)? {
                terminal = true;
                break 'outer;
            }
        }
    }
    if !terminal {
        for frame in buffer.flush() {
            handle_frame(&frame, protocol, &mut openai, &mut anthropic, &on_event)?;
        }
    }

    match protocol {
        Protocol::OpenAI => openai.finish(),
        Protocol::Anthropic => anthropic.finish(),
    }
}

/// Handle one frame; `Ok(true)` means the stream's terminal event fired.
fn handle_frame(
    frame: &str,
    protocol: Protocol,
    openai: &mut OpenAiStreamState,
    anthropic: &mut AnthropicStreamState,
    on_event: &OnEvent,
) -> Result<bool, ProviderError> {
    match protocol {
        Protocol::OpenAI => match parse_sse_frame(frame)? {
            Some(SseFrame::Done) => {
                on_event(StreamEvent::Finished);
                Ok(true)
            }
            Some(SseFrame::Json(chunk)) => {
                for event in parse_openai_sse_frame(&chunk, openai)? {
                    on_event(event);
                }
                Ok(false)
            }
            None => Ok(false),
        },
        Protocol::Anthropic => {
            if let Some(SseFrame::Json(event)) = parse_sse_frame(frame)? {
                for emitted in parse_anthropic_sse_frame(&event, anthropic)? {
                    on_event(emitted);
                }
            }
            Ok(false)
        }
    }
}

fn non_null(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

/// Blank text collapses to `None` (same rule as the non-streaming parsers).
fn collapse(text: String) -> Option<String> {
    if text.trim().is_empty() { None } else { Some(text) }
}
