//! Replay one frozen transcript prefix, without executing any model tools.
//! Usage: replay_step HISTORY ASSISTANT_COUNT WORKTREE OUTPUT REPLAY_REASONING
//! OUTPUT contains the fixture request/response; credentials are never included.
use std::sync::{Arc, Mutex};
use std::time::Instant;

use oc_provider::{ChatRequest, StreamEvent, ToolChoice};
use oc_schema::Message;
use serde_json::json;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 5 {
        return Err("expected HISTORY ASSISTANT_COUNT WORKTREE OUTPUT REPLAY_REASONING".into());
    }
    let history: Vec<Message> = serde_json::from_str(&std::fs::read_to_string(&args[0])?)?;
    let count: usize = args[1].parse()?;
    let mut seen = 0;
    let prefix: Vec<_> = history
        .into_iter()
        .take_while(|m| {
            if matches!(m, Message::Assistant(_)) {
                seen += 1;
            }
            seen <= count
        })
        .collect();
    let worktree = std::path::Path::new(&args[2]);
    let replay = args[4] == "1";
    let model = oc_agent::model_from_env();
    let request = ChatRequest {
        model: model.id.clone(),
        system: Some(oc_agent::system_prompt(&model, worktree)),
        messages: oc_agent::to_llm_messages_for_model(&prefix, replay.then_some(&model)),
        tools: oc_tools::Registry::builtin(worktree).defs(),
        tool_choice: ToolChoice::Auto,
    };
    let started = Instant::now();
    let metrics = Arc::new(Mutex::new(json!({})));
    let sink = metrics.clone();
    let observer = Arc::new(move |event| {
        let mut m = sink.lock().unwrap();
        match event {
            StreamEvent::RequestPrepared { metadata } => m["request"] = metadata,
            StreamEvent::ResponseStarted => {
                m["response_headers_ms"] = json!(started.elapsed().as_secs_f64() * 1000.0)
            }
            StreamEvent::ProviderTimings { timings } => m["provider_timings"] = timings,
            StreamEvent::Reasoning { .. }
            | StreamEvent::Text { .. }
            | StreamEvent::ToolCallStarted { .. } => {
                if m.get("first_delta_ms").is_none() {
                    m["first_delta_ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
                }
            }
            _ => {}
        }
    });
    let response = oc_agent::client_from_env()
        .complete_streaming(&model.id, &request, observer)
        .await?;
    let result = json!({"replay_reasoning":replay,"elapsed_seconds":started.elapsed().as_secs_f64(),
        "metrics":*metrics.lock().unwrap(),"response":response,
        "request":oc_provider::build_openai_request(&model.id,&request)});
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&args[3])?;
    file.write_all(serde_json::to_string_pretty(&result)?.as_bytes())?;
    println!(
        "replay={replay}, {:.3}s, tokens={:?}",
        started.elapsed().as_secs_f64(),
        response.usage
    );
    Ok(())
}
