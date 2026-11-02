//! Automatic compaction, port of `packages/core/src/session/compaction.ts`: when the context nears the model's window, the
//! older conversation is summarized by the model and the summary replaces it; the newest messages stay verbatim.
//!
//! Documented deltas: no background summaries (`precompute`, off by default upstream too), no native provider compaction,
//! no `/compact`. The old messages are removed from the store instead of being kept behind a marker: on a small machine the
//! transcript is memory. When the turn in progress is itself too large, nothing is kept beside the summary; upstream always
//! keeps from the latest user message.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use oc_provider::{ChatMessage, ChatRequest, Client, OnEvent, ToolChoice};
use oc_schema::{AssistantContent, Message, ModelRef, ToolContent, ToolState};
use oc_store::{synthetic_message, Store};

use crate::{abortable, AgentError};

/// The least of the window kept free for the last reply before compaction and for the summary itself.
const RESERVE_MIN: u64 = 16_000;
/// Share of the window kept free before automatic compaction.
const RESERVE_SHARE: f64 = 0.15;
/// Tokens of recent conversation kept verbatim beside the summary.
const DEFAULT_KEEP: u64 = 15_000;
/// After a "too long" rejection, the attempt aims at this share of what was rejected.
const SHRINK: f64 = 0.85;
/// Characters kept, from the start and end, of a cut tool input, tool output, or user message.
const TRANSCRIPT_CLIP: usize = 2_000;
const CHARS_PER_TOKEN: usize = 4;

const OPEN: &str = "<conversation-checkpoint>";
const CLOSE: &str = "</conversation-checkpoint>";

const SUMMARY_TEMPLATE: &str = "You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.\n<template>\n## Objective\n- [one or two brief sentences describing what the user is trying to accomplish]\n\n## Requirements\n- [constraints, preferences, requirements, and scope boundaries stated by the user, or \"(none)\"]\n\n## Decisions\n- [decisions already made and why, or \"(none)\"]\n\n## Work State\nBreak the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.\n### Completed\n- [goals that have been completed; otherwise \"(none)\"]\n\n### Active\n- [goals currently being worked on; otherwise \"(none)\"]\n\n### Blocked\n- [anything blocking progress, and why; otherwise \"(none)\"]\n\n## Next Move\n1. [ordered list of next actions, or \"(none)\"]\n\n## Relevant Files\nList the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write \"(none)\".\n- `[file or directory path]`: [brief reason it matters]\n\n## Important Context\n- [facts the next agent cannot continue without and cannot easily find on its own; or \"(none)\"]\n</template>";

const SUMMARY_RULES: &str = "Rules:\n- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.\n- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.\n- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.\n- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved.\n- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.\n- Do not mention the summary process or that context was compacted.";

const NUDGE: &str = "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template.";

/// Compaction settings: an unknown window never triggers it, as upstream, unless the provider rejects a request.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Settings {
    /// The model's context window in tokens.
    pub window: Option<u64>,
    /// Tokens kept free below the window; unset keeps 15%, and at least 16k.
    pub buffer: Option<u64>,
    pub keep: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { window: None, buffer: None, keep: DEFAULT_KEEP }
    }
}

impl Settings {
    /// `OC_CONTEXT_WINDOW`, `OC_COMPACT_BUFFER`, `OC_COMPACT_KEEP`.
    pub fn from_env() -> Self {
        let number = |name: &str| std::env::var(name).ok().and_then(|s| s.trim().parse::<u64>().ok());
        Self {
            window: number("OC_CONTEXT_WINDOW").filter(|w| *w > 0),
            buffer: number("OC_COMPACT_BUFFER"),
            keep: number("OC_COMPACT_KEEP").unwrap_or(DEFAULT_KEEP),
        }
    }

    /// The prompt size at which compaction is due.
    pub fn ceiling(&self) -> Option<u64> {
        let window = self.window?;
        let reserve = self.buffer.unwrap_or_else(|| RESERVE_MIN.max((window as f64 * RESERVE_SHARE) as u64));
        Some(window.saturating_sub(reserve))
    }
}

/// What a compaction did.
#[derive(Debug, Clone, PartialEq)]
pub enum Compacted {
    Done { before: u64, after: u64 },
    /// An empty conversation.
    Nothing,
    Failed(String),
    Interrupted,
}

fn estimate(text: &str) -> u64 {
    (text.len() / CHARS_PER_TOKEN) as u64
}

fn clip(text: &str) -> String {
    if text.len() <= 2 * TRANSCRIPT_CLIP {
        return text.to_string();
    }
    let mut head = TRANSCRIPT_CLIP;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - TRANSCRIPT_CLIP;
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}\n... ({} characters left out) ...\n{}", &text[..head], tail - head, &text[tail..])
}

fn content_text(content: &[ToolContent]) -> String {
    content
        .iter()
        .map(|part| match part {
            ToolContent::Text { text } => text.clone(),
            ToolContent::File { mime, url } => format!("[file: {mime} {url}]"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// How far one message of the transcript is shortened: 0 whole; 1 tool outputs cut; 2 tool outputs left out and inputs cut;
/// 3 only the user's text, cut.
fn message_text(m: &Message, level: u8) -> Option<String> {
    match m {
        Message::User(u) if !u.text.is_empty() => {
            Some(format!("User: {}", if level >= 3 { clip(&u.text) } else { u.text.clone() }))
        }
        Message::Synthetic(s) => Some(s.text.clone()),
        Message::Assistant(a) if level < 3 => {
            let mut out = Vec::new();
            for part in &a.content {
                match part {
                    AssistantContent::Text(t) if !t.text.is_empty() => out.push(format!("Assistant: {}", t.text)),
                    AssistantContent::Tool(tool) => {
                        let (input, output) = match &tool.state {
                            ToolState::Running { input, .. } => (input, None),
                            ToolState::Completed { input, content, .. } => (input, Some(content_text(content))),
                            ToolState::Error { input, error, .. } => (input, error.message.clone()),
                        };
                        let input = input.to_string();
                        let input = if level >= 2 { clip(&input) } else { input };
                        out.push(format!("Tool {}: {input}", tool.name));
                        match output {
                            Some(o) if level == 0 => out.push(format!("Result: {o}")),
                            Some(o) if level == 1 => out.push(format!("Result: {}", clip(&o))),
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            (!out.is_empty()).then(|| out.join("\n"))
        }
        _ => None,
    }
}

fn history_tokens(history: &[Message]) -> u64 {
    history.iter().filter_map(|m| message_text(m, 0)).map(|t| estimate(&t)).sum()
}

/// The estimated size of what would be sent, for a turn's first request.
pub(crate) fn estimate_context(system: &str, history: &[Message]) -> u64 {
    estimate(system) + history_tokens(history)
}

/// Where the part kept verbatim starts: `history.len()` keeps nothing, `None` means nothing to compact.
fn split(history: &[Message], keep: u64, max_tail: u64) -> Option<usize> {
    let entries: Vec<(usize, u64, bool)> = history
        .iter()
        .enumerate()
        .filter_map(|(i, m)| message_text(m, 0).map(|t| (i, estimate(&t), matches!(m, Message::User(_)))))
        .collect();
    if entries.is_empty() {
        return None;
    }
    // Drop the oldest entries until the rest fit the allowance, but always keep the newest one.
    let mut total = 0;
    let mut dropped = entries.len();
    for (n, (_, size, _)) in entries.iter().enumerate().rev() {
        if total + size > keep {
            break;
        }
        total += size;
        dropped = n;
    }
    let dropped = dropped.min(entries.len() - 1);
    // Start at a user message so an assistant's tool calls and results stay together.
    let boundary = entries[..=dropped].iter().rposition(|e| e.2).filter(|n| *n > 0);
    let latest = entries.iter().rposition(|e| e.2).filter(|n| *n > 0);
    let start = match boundary.or(latest) {
        Some(n) => entries[n].0,
        // One exchange, nothing older: summarize it all and keep nothing.
        None => return Some(history.len()),
    };
    let tail: u64 = entries.iter().filter(|e| e.0 >= start).map(|e| e.1).sum();
    Some(if tail > max_tail { history.len() } else { start })
}

fn build_prompt(update: bool) -> String {
    let shared = [
        "Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user.",
        SUMMARY_TEMPLATE,
        SUMMARY_RULES,
        "Do not continue the task or call tools.",
        "Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
    ];
    let lead: &[&str] = if update {
        &[
            "Update the existing checkpoint in the conversation above into one consolidated summary.",
            "Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes or resolves it.",
            "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move.",
            "Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>` wrapper tags from the previous checkpoint.",
        ]
    } else {
        &["You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work."]
    };
    lead.iter().chain(shared.iter()).copied().collect::<Vec<_>>().join("\n\n")
}

/// The transcript at the first level that fits `budget`, or the shortest one.
fn transcript(messages: &[Message], budget: u64) -> String {
    let mut text = String::new();
    for level in 0..=3 {
        text = messages.iter().filter_map(|m| message_text(m, level)).collect::<Vec<_>>().join("\n\n");
        if estimate(&text) <= budget {
            break;
        }
    }
    text
}

/// The provider said the request is longer than the window.
pub(crate) fn is_overflow(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("context")
        && ["exceed", "too long", "too large", "too many", "overflow", "maximum"].iter().any(|w| e.contains(w))
}

/// Summarize and replace. `rejected` is the size of a request the provider has just refused.
pub(crate) async fn compact(
    store: &Store,
    client: &Client,
    model: &ModelRef,
    system: &str,
    session_id: &str,
    settings: &Settings,
    rejected: Option<u64>,
    abort: &AtomicBool,
) -> Result<Compacted, AgentError> {
    let history = store.messages(session_id)?;
    let before = estimate_context(system, &history);
    let room = settings.ceiling().unwrap_or(before).min(before);
    let budget = match rejected {
        Some(size) => room.min((size as f64 * SHRINK) as u64),
        None => room,
    };
    let Some(start) = split(&history, settings.keep, budget / 2) else {
        return Ok(Compacted::Nothing);
    };
    let update = matches!(history.first(), Some(Message::Synthetic(s)) if s.text.starts_with(OPEN));
    let body = transcript(&history[..start], budget.saturating_sub(estimate(system) + 2_000));
    let mut messages = vec![ChatMessage::User { text: format!("{body}\n\n{}", build_prompt(update)) }];
    let mut summary = None;
    for _ in 0..2 {
        let req = ChatRequest {
            model: model.id.clone(),
            system: Some(system.to_string()),
            messages: messages.clone(),
            tools: Vec::new(),
            tool_choice: ToolChoice::None,
        };
        let quiet: OnEvent = Arc::new(|_| {});
        let resp = match abortable(abort, client.complete_streaming(&model.id, &req, quiet)).await {
            None => return Ok(Compacted::Interrupted),
            Some(Ok(r)) => r,
            Some(Err(e)) => return Ok(Compacted::Failed(e.to_string())),
        };
        let text = resp.text.unwrap_or_default();
        if text.contains("## ") {
            summary = Some(text);
            break;
        }
        messages.push(ChatMessage::Assistant { text: Some(text), tool_calls: Vec::new() });
        messages.push(ChatMessage::User { text: NUDGE.into() });
    }
    let Some(summary) = summary else {
        return Ok(Compacted::Failed("the model did not write the summary".into()));
    };
    // Messages sort by id: the checkpoint takes the oldest message's, so it stays first.
    let oldest = history.first().map(|m| crate::message_id_of(m).to_string()).unwrap_or_default();
    let created = crate::now_ms();
    let checkpoint = synthetic_message(&format!("{OPEN}\n<summary>\n{summary}\n</summary>\n{CLOSE}"), oldest, created);
    let mut kept = vec![checkpoint];
    kept.extend(history[start..].iter().cloned());
    let after = estimate_context(system, &kept);
    store.replace_history(session_id, kept)?;
    Ok(Compacted::Done { before, after })
}

#[cfg(test)]
mod tests {
    use super::*;
    use oc_store::{assistant_message, user_message};

    fn user(i: u32, chars: usize) -> Message {
        user_message("u".repeat(chars), Vec::new(), format!("msg_{i:04}"), u64::from(i))
    }

    fn assistant(i: u32, chars: usize) -> Message {
        let content = vec![AssistantContent::Text(oc_schema::AssistantText { text: "a".repeat(chars) })];
        assistant_message("build", ModelRef::parse("openai/x").unwrap(), content, format!("msg_{i:04}"), u64::from(i))
    }

    #[test]
    fn ceiling_keeps_a_share_or_the_minimum_free() {
        let s = |window, buffer| Settings { window: Some(window), buffer, keep: DEFAULT_KEEP };
        assert_eq!(s(200_000, None).ceiling(), Some(170_000));
        assert_eq!(s(81_920, None).ceiling(), Some(65_920));
        assert_eq!(s(81_920, Some(32_768)).ceiling(), Some(49_152));
        assert_eq!(Settings::default().ceiling(), None);
    }

    #[test]
    fn keeps_recent_messages_from_a_user_boundary() {
        let h = vec![user(1, 4000), assistant(2, 40_000), user(3, 400), assistant(4, 400)];
        assert_eq!(split(&h, 500, 10_000), Some(2));
    }

    #[test]
    fn everything_fitting_keeps_only_the_latest_exchange() {
        let h = vec![user(1, 40), assistant(2, 40), user(3, 40), assistant(4, 40)];
        assert_eq!(split(&h, 15_000, 10_000), Some(2));
    }

    #[test]
    fn a_single_exchange_is_summarized_whole() {
        let h = vec![user(1, 40), assistant(2, 40)];
        assert_eq!(split(&h, 15_000, 10_000), Some(2));
        assert_eq!(split(&[], 15_000, 10_000), None);
    }

    #[test]
    fn a_huge_turn_in_progress_is_summarized_whole() {
        let h = vec![user(1, 40), assistant(2, 40), user(3, 40), assistant(4, 400_000)];
        assert_eq!(split(&h, 15_000, 10_000), Some(4));
        let one = vec![user(1, 40), assistant(2, 400_000)];
        assert_eq!(split(&one, 15_000, 10_000), Some(2));
    }

    #[test]
    fn the_transcript_shortens_until_it_fits() {
        let h = vec![user(1, 100), assistant(2, 100)];
        assert!(transcript(&h, 1_000).contains("Assistant:"));
        // The assistant's words go only at the last level.
        assert!(!transcript(&h, 10).contains("Assistant:"));
    }

    #[test]
    fn llama_cpp_overflow_is_recognized() {
        assert!(is_overflow("HTTP 400: the request exceeds the available context size"));
        assert!(is_overflow("maximum context length is 4096 tokens"));
        assert!(!is_overflow("HTTP 500: slot busy"));
    }
}
