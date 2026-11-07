//! oc-cli: thin client for oc-server, plus an embedded one-process mode.
//!
//! Usage: oc-cli <new|list|get|ask|run|abort|synth|events> [args]
//!   new [title]           POST /api/session
//!   list                  GET /api/session
//!   get <sessionID>       GET /api/session/:id
//!   ask <text> [dir]      new session (+worktree) + POST prompt, prints the reply
//!   run <sessionID> <text>  POST prompt on an existing session
//!   abort <sessionID>     POST abort
//!   synth <id> <text>     POST /api/session/:id/synthetic
//!   events [n]            stream GET /event for n events (default 3)
//!
//! Embedded mode runs the runner in this process: `--local`, or `OC_BASE`
//! unset with `OC_BASE_URL` set. `ask <text> [dir]` runs one turn; `chat [dir]`
//! is a line REPL.
//!
//! `tunnel keygen|run ...` is `oc-tunnel`, the forward to a model on another
//! machine, in the same file.
//!
//! Env: OC_BASE (server), OC_BASE_URL/OC_PROVIDER/OC_MODEL/OC_API_KEY,
//! OC_API_KEY_FILE, OC_EXTRA_BODY, OC_DATA, OC_PERMISSIONS, OC_SHOW_THINKING,
//! OC_VERBOSE, OC_MAX_STEPS, OC_CWD, OC_CONTEXT_WINDOW, OC_COMPACT_BUFFER,
//! OC_COMPACT_KEEP.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use oc_agent::compaction::{Compacted, Settings};
use oc_agent::{Observer, RunEvent, RunOptions};
use oc_schema::Outcome;
use oc_store::{CreateInput, Store};
use oc_tools::Registry;

mod acp;

const DEFAULT_BASE: &str = "http://127.0.0.1:18212";

fn main() {
    // One file on a small machine: `oc-cli tunnel ...` is oc-tunnel, which makes its own runtime.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("tunnel") {
        std::process::exit(oc_tunnel::main_with(&args[1..]));
    }
    // `acp` speaks JSON-RPC on stdio and makes its own multi-threaded runtime
    // (a synchronous permission ask blocks a worker while stdin is read elsewhere).
    if args.first().map(String::as_str) == Some("acp") {
        std::process::exit(acp::run());
    }
    run(args);
}

#[tokio::main(flavor = "current_thread")]
async fn run(mut args: Vec<String>) {
    let mut local = false;
    args.retain(|arg| {
        if arg == "--local" {
            local = true;
            false
        } else {
            true
        }
    });

    let base = non_empty_env("OC_BASE");
    let base_url = non_empty_env("OC_BASE_URL");
    let embedded = local
        || (base.is_none()
            && (base_url.is_some()
                || non_empty_env("MISTRAL_API_KEY").is_some()
                || non_empty_env("OC_PROVIDER").as_deref() == Some("mistral")));
    if embedded {
        let code = match args.first().map(String::as_str) {
            Some("ask") => embedded_ask(&args).await,
            Some("chat") => embedded_chat(&args).await,
            _ => usage("embedded mode supports ask and chat"),
        };
        // Return from the embedded runner first so registry drop stops jobs.
        std::process::exit(code);
    }

    let base = base.unwrap_or_else(|| DEFAULT_BASE.into());
    let client = reqwest::Client::new();
    let result = match args.first().map(String::as_str) {
        Some("new") => {
            let title = args.get(1).cloned();
            client
                .post(format!("{base}/api/session"))
                .json(&serde_json::json!({ "title": title, "agent": "build" }))
                .send()
                .await
        }
        Some("list") => client.get(format!("{base}/api/session")).send().await,
        Some("get") => match args.get(1) {
            Some(id) => client.get(format!("{base}/api/session/{id}")).send().await,
            None => usage("get needs a session id"),
        },
        Some("synth") => match (args.get(1), args.get(2)) {
            (Some(id), Some(text)) => {
                client
                    .post(format!("{base}/api/session/{id}/synthetic"))
                    .json(&serde_json::json!({ "text": text }))
                    .send()
                    .await
            }
            _ => usage("synth needs <sessionID> <text>"),
        },
        Some("ask") => {
            let text = args.get(1).cloned();
            let Some(text) = text else {
                usage("ask needs a prompt")
            };
            let cwd = args
                .get(2)
                .cloned()
                .or_else(|| std::env::var("OC_CWD").ok())
                .unwrap_or_default();
            let created = client
                .post(format!("{base}/api/session"))
                .json(&serde_json::json!({
                    "title": first_line(&text),
                    "agent": "build",
                    "directory": cwd,
                }))
                .send()
                .await
                .and_then(|r| r.error_for_status());
            let created: serde_json::Value = match created {
                Ok(res) => res.json().await.unwrap_or(serde_json::Value::Null),
                Err(e) => fail(2, &format!("create failed: {e}")),
            };
            let Some(id) = created["info"]["id"].as_str().map(str::to_string) else {
                fail(2, "create returned no session id");
            };
            eprintln!("session {id}");
            return run_prompt(&client, &base, &id, &text).await;
        }
        Some("run") => match (args.get(1), args.get(2)) {
            (Some(id), Some(text)) => return run_prompt(&client, &base, id, text).await,
            _ => usage("run needs <sessionID> <text>"),
        },
        Some("abort") => match args.get(1) {
            Some(id) => {
                client
                    .post(format!("{base}/api/session/{id}/abort"))
                    .send()
                    .await
            }
            None => usage("abort needs a session id"),
        },
        Some("events") => return stream_events(&base, args.get(1)).await,
        _ => usage("unknown command"),
    };
    match result {
        Ok(res) => {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            println!("{status} {body}");
            if !status.is_success() {
                std::process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("request failed: {e}");
            std::process::exit(2);
        }
    }
}

// ===== Embedded mode =====

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn embedded_store() -> Result<Store, String> {
    match non_empty_env("OC_DATA") {
        Some(dir) => Store::open(Path::new(&dir)).map_err(|e| format!("open {dir}: {e}")),
        None => Ok(Store::new()),
    }
}

fn embedded_dir(arg: Option<&String>) -> Result<PathBuf, String> {
    let dir = arg
        .cloned()
        .or_else(|| non_empty_env("OC_CWD"))
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?);
    std::fs::canonicalize(&dir).map_err(|e| format!("invalid directory {}: {e}", dir.display()))
}

fn create_session(store: &Store, dir: &Path, title: &str) -> Result<String, String> {
    let model = oc_agent::model_from_env();
    store
        .create_session(CreateInput {
            title: Some(title.to_string()),
            parent_id: None,
            agent: Some("build".into()),
            model: Some(model),
            directory: dir.to_string_lossy().into_owned(),
            project_id: "global".into(),
        })
        .map(|info| info.id)
        .map_err(|e| format!("create session: {e}"))
}

struct RenderState {
    thinking_marker: bool,
    text_written: bool,
    last_text_newline: bool,
    reasoning_written: bool,
}

struct Renderer {
    show_thinking: bool,
    verbose: bool,
    state: Mutex<RenderState>,
}

impl Renderer {
    fn from_env() -> Arc<Self> {
        Arc::new(Self {
            show_thinking: env_flag("OC_SHOW_THINKING"),
            verbose: env_flag("OC_VERBOSE"),
            state: Mutex::new(RenderState {
                thinking_marker: false,
                text_written: false,
                last_text_newline: false,
                reasoning_written: false,
            }),
        })
    }

    fn observer(self: &Arc<Self>, session: &str) -> Observer {
        let renderer = self.clone();
        oc_agent::traced_observer(Arc::new(move |event| renderer.render(event)), session)
    }

    fn render(&self, event: RunEvent) {
        match event {
            RunEvent::Trace { record } => {
                if self.verbose && record["event"] == "request.finish" {
                    eprintln!("[step {} attempt {}] model {:.3}s, first delta {}ms, input {}, cache {}, output {}, reasoning {} bytes",
                        record["step"], record["attempt"], record["elapsed_ms"].as_f64().unwrap_or(0.0) / 1000.0,
                        record["stream"]["first_delta_ms"], record["usage"]["input"], record["usage"]["cache_read"],
                        record["usage"]["output"], record["stream"]["reasoning_bytes"]);
                }
            }
            RunEvent::TextDelta { delta } => {
                print!("{delta}");
                let _ = std::io::stdout().flush();
                let mut state = self.state.lock().unwrap();
                state.text_written = true;
                state.last_text_newline = delta.ends_with('\n');
            }
            RunEvent::ReasoningDelta { delta } => {
                let mut state = self.state.lock().unwrap();
                if self.show_thinking {
                    eprint!("{delta}");
                    let _ = std::io::stderr().flush();
                    state.reasoning_written = true;
                } else if !state.thinking_marker {
                    eprintln!("thinking…");
                    state.thinking_marker = true;
                }
            }
            RunEvent::ToolCallStarted { name, input, .. } => {
                eprintln!("> {name}: {}", summarize_input(&input));
            }
            RunEvent::ToolCallFinished { ok, preview, .. } => {
                if ok {
                    eprintln!("  ok, {} lines", preview.lines().count());
                } else {
                    eprintln!("  error: {}", first_line(&preview));
                }
                if self.verbose && !preview.trim().is_empty() {
                    for line in preview.lines() {
                        eprintln!("    {line}");
                    }
                }
            }
            RunEvent::StepFinished { .. } => {}
            RunEvent::CompactionStarted => eprintln!("compacting the conversation…"),
            RunEvent::CompactionFinished { result } => match result {
                Compacted::Done { before, after } => {
                    eprintln!("  about {before} tokens down to about {after}")
                }
                Compacted::Nothing => eprintln!("  nothing to compact"),
                Compacted::Failed(error) => eprintln!("  compaction failed: {error}"),
                Compacted::Interrupted => {}
            },
            RunEvent::RetryScheduled {
                attempt,
                delay,
                error,
            } => {
                eprintln!(
                    "model request failed ({}); try {} in {} s",
                    first_line(&error),
                    attempt + 1,
                    delay.as_secs()
                )
            }
            RunEvent::ProviderFailed { error } => eprintln!("model request failed: {error}"),
            RunEvent::OutputLimitReached => {
                eprintln!("the response hit the output token limit; continuing")
            }
        }
    }

    fn finish(&self, text: Option<&str>) {
        let state = self.state.lock().unwrap();
        if state.text_written {
            if !state.last_text_newline {
                println!();
            }
        } else if let Some(text) = text {
            println!("{text}");
        }
        if self.show_thinking && state.reasoning_written {
            eprintln!();
        }
    }
}

fn summarize_input(input: &serde_json::Value) -> String {
    let raw = input
        .get("command")
        .or_else(|| input.get("path"))
        .or_else(|| input.get("url"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| input.to_string());
    let mut line = first_line(&raw);
    if line.chars().count() > 200 {
        line = line.chars().take(200).collect::<String>() + "…";
    }
    line
}

fn token(f64_value: f64) -> String {
    if f64_value.fract() == 0.0 {
        format!("{f64_value:.0}")
    } else {
        format!("{f64_value:.1}")
    }
}

fn outcome_name(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Succeeded => "succeeded",
        Outcome::Failed => "failed",
        Outcome::Interrupted => "interrupted",
    }
}

fn outcome_code(outcome: Outcome) -> i32 {
    match outcome {
        Outcome::Succeeded => 0,
        Outcome::Failed => 1,
        Outcome::Interrupted => 130,
    }
}

fn turn_summary(
    outcome: Outcome,
    steps: u32,
    before: &oc_schema::TokenUsage,
    after: &oc_schema::TokenUsage,
    elapsed: std::time::Duration,
) {
    eprintln!(
        "[{}] {} steps, tokens in {}/out {}, {:.1}s",
        outcome_name(outcome),
        steps,
        token(after.input - before.input),
        token(after.output - before.output),
        elapsed.as_secs_f64(),
    );
}

async fn embedded_ask(args: &[String]) -> i32 {
    let Some(text) = args.get(1).cloned() else {
        usage("ask needs a prompt")
    };
    let dir = match embedded_dir(args.get(2)) {
        Ok(dir) => dir,
        Err(e) => fail(2, &e),
    };
    let store = match embedded_store() {
        Ok(store) => Arc::new(store),
        Err(e) => fail(2, &e),
    };
    let session = match create_session(&store, &dir, &first_line(&text)) {
        Ok(id) => id,
        Err(e) => fail(2, &e),
    };
    eprintln!("session {session}");
    let before = match store.get_session(&session) {
        Ok(info) => info.tokens,
        Err(e) => fail(2, &e.to_string()),
    };
    let renderer = Renderer::from_env();
    let abort = Arc::new(AtomicBool::new(false));
    let opts = RunOptions {
        agent: "build".into(),
        max_steps: oc_agent::max_steps_from_env(),
        abort: abort.clone(),
        permissions: oc_agent::embedded_permissions_from_env(),
        observer: renderer.observer(&session),
        permission_ask: None,
        compaction: Settings::from_env(),
        retries: &oc_agent::RETRY_SCHEDULE,
        replay_reasoning: oc_agent::reasoning_replay_from_env(),
    };
    let registry = Registry::builtin(&dir);
    let client = Arc::new(oc_agent::client_from_env());
    let model = oc_agent::model_from_env();
    let registry = oc_agent::with_task_tool(
        &registry,
        store.clone(),
        client.clone(),
        model.clone(),
        &opts,
    );
    let started = Instant::now();
    let mut signals = match Signals::new() {
        Ok(signals) => signals,
        Err(e) => fail(2, &format!("signals: {e}")),
    };
    let turn = oc_agent::prompt(&store, &registry, &client, &session, model, &text, &opts);
    let (output, _) = drive_turn(turn, &abort, &mut signals).await;
    let output = match output {
        Ok(output) => output,
        Err(e) => fail(2, &format!("turn failed: {e}")),
    };
    let after = match store.get_session(&session) {
        Ok(info) => info.tokens,
        Err(e) => fail(2, &e.to_string()),
    };
    renderer.finish(output.text.as_deref());
    turn_summary(
        output.outcome,
        output.steps,
        &before,
        &after,
        started.elapsed(),
    );
    outcome_code(output.outcome)
}

async fn embedded_chat(args: &[String]) -> i32 {
    let dir = match embedded_dir(args.get(1)) {
        Ok(dir) => dir,
        Err(e) => fail(2, &e),
    };
    let store = match embedded_store() {
        Ok(store) => Arc::new(store),
        Err(e) => fail(2, &e),
    };
    let registry = Registry::builtin(&dir);
    let client = Arc::new(oc_agent::client_from_env());
    let model = oc_agent::model_from_env();
    let permissions = oc_agent::embedded_permissions_from_env();
    let mut session = match create_session(&store, &dir, "chat") {
        Ok(id) => id,
        Err(e) => fail(2, &e),
    };
    eprintln!("session {session} in {}", dir.display());
    let mut signals = match Signals::new() {
        Ok(signals) => signals,
        Err(e) => fail(2, &format!("signals: {e}")),
    };
    loop {
        eprint!("> ");
        let _ = std::io::stderr().flush();
        let line = tokio::select! {
            line = read_stdin_line() => line,
            _ = signals.next() => break,
        };
        let line = match line {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(e) => fail(2, &format!("read stdin: {e}")),
        };
        let text = line.trim();
        match text {
            "" => continue,
            "/exit" => break,
            "/new" => {
                session = match create_session(&store, &dir, "chat") {
                    Ok(id) => id,
                    Err(e) => fail(2, &e),
                };
                eprintln!("session {session}");
                continue;
            }
            _ => {}
        }
        let before = match store.get_session(&session) {
            Ok(info) => info.tokens,
            Err(e) => fail(2, &e.to_string()),
        };
        let renderer = Renderer::from_env();
        let abort = Arc::new(AtomicBool::new(false));
        let opts = RunOptions {
            agent: "build".into(),
            max_steps: oc_agent::max_steps_from_env(),
            abort: abort.clone(),
            permissions: permissions.clone(),
            observer: renderer.observer(&session),
            permission_ask: Some(Arc::new(ask_on_terminal)),
            compaction: Settings::from_env(),
            retries: &oc_agent::RETRY_SCHEDULE,
            replay_reasoning: oc_agent::reasoning_replay_from_env(),
        };
        let turn_registry = oc_agent::with_task_tool(
            &registry,
            store.clone(),
            client.clone(),
            model.clone(),
            &opts,
        );
        let started = Instant::now();
        let turn = oc_agent::prompt(
            &store,
            &turn_registry,
            &client,
            &session,
            model.clone(),
            text,
            &opts,
        );
        let (output, stopped) = drive_turn(turn, &abort, &mut signals).await;
        if stopped == Some(Stop::Terminate) {
            return 143;
        }
        let output = match output {
            Ok(output) => output,
            Err(e) => {
                eprintln!("turn failed: {e}");
                continue;
            }
        };
        let after = match store.get_session(&session) {
            Ok(info) => info.tokens,
            Err(e) => fail(2, &e.to_string()),
        };
        renderer.finish(output.text.as_deref());
        turn_summary(
            output.outcome,
            output.steps,
            &before,
            &after,
            started.elapsed(),
        );
    }
    0
}

/// What a signal asks of a turn. A shell call runs in a process group of its
/// own, so only the runner can stop it: no signal may just end this process.
#[derive(Clone, Copy, PartialEq)]
enum Stop {
    /// Ctrl+C: stop this turn.
    Interrupt,
    /// SIGTERM or the terminal going away: stop this turn and leave.
    Terminate,
}

struct Signals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
    hangup: tokio::signal::unix::Signal,
}

impl Signals {
    fn new() -> std::io::Result<Self> {
        use tokio::signal::unix::{signal, SignalKind};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
            hangup: signal(SignalKind::hangup())?,
        })
    }

    async fn next(&mut self) -> Stop {
        tokio::select! {
            _ = self.interrupt.recv() => Stop::Interrupt,
            _ = self.terminate.recv() => Stop::Terminate,
            _ = self.hangup.recv() => Stop::Terminate,
        }
    }
}

/// Wait for a turn; a signal fires its abort and the turn ends as interrupted.
async fn drive_turn<F: std::future::Future>(
    turn: F,
    abort: &AtomicBool,
    signals: &mut Signals,
) -> (F::Output, Option<Stop>) {
    tokio::pin!(turn);
    tokio::select! {
        output = &mut turn => (output, None),
        stop = signals.next() => {
            abort.store(true, Ordering::Relaxed);
            ((&mut turn).await, Some(stop))
        }
    }
}

fn ask_on_terminal(request: &oc_agent::PermissionRequest) -> bool {
    eprint!(
        "permission requested: {} ({}); allow? [y/N] ",
        request.action, request.resource
    );
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes")
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

// ===== HTTP client mode =====

/// POST the prompt and print the transcript: each message's role and the
/// final assistant text.
async fn run_prompt(client: &reqwest::Client, base: &str, id: &str, text: &str) {
    eprintln!("thinking...");
    let res = client
        .post(format!("{base}/api/session/{id}/message"))
        .json(&serde_json::json!({ "text": text }))
        .send()
        .await;
    match res {
        Ok(res) => {
            let status = res.status();
            let body: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
            if !status.is_success() {
                fail(
                    1,
                    &format!("{status} {}", body["error"].as_str().unwrap_or("")),
                );
            }
            let out = &body["output"];
            if let Some(t) = out["text"].as_str() {
                println!("{t}");
            }
            eprintln!(
                "[{}] {} steps, cost {}, tokens in {}/out {}",
                out["outcome"].as_str().unwrap_or("?"),
                out["steps"].as_u64().unwrap_or(0),
                body["info"]["cost"].as_f64().unwrap_or(0.0),
                body["info"]["tokens"]["input"].as_f64().unwrap_or(0.0),
                body["info"]["tokens"]["output"].as_f64().unwrap_or(0.0),
            );
        }
        Err(e) => fail(2, &format!("request failed: {e}")),
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or(s).chars().take(60).collect()
}

fn fail(code: i32, msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(code);
}

async fn stream_events(base: &str, count: Option<&String>) {
    let want: usize = count.and_then(|c| c.parse().ok()).unwrap_or(3);
    let url = format!("{base}/event");
    let res = match reqwest::get(&url).await {
        Ok(r) => r,
        Err(e) => return eprintln!("connect failed: {e}"),
    };
    if !res.status().is_success() {
        return eprintln!("event feed returned {}", res.status());
    }
    let mut stream = res.bytes_stream();
    use futures_util::StreamExt;
    let mut seen = 0;
    let mut buf = Vec::new();
    while seen < want {
        match stream.next().await {
            Some(Ok(chunk)) => {
                buf.extend_from_slice(&chunk);
                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line);
                    if line.starts_with("event:") || line.starts_with("data:") {
                        print!("{line}");
                        let _ = std::io::stdout().flush();
                    }
                    if line.trim() == "" {
                        seen += 1;
                        println!("---");
                    }
                }
            }
            Some(Err(e)) => return eprintln!("stream error: {e}"),
            None => break,
        }
    }
}

fn usage(msg: &str) -> ! {
    eprintln!(
        "{msg}\nusage: oc-cli <new [title]|list|get <id>|ask <text> [dir]|run <id> <text>|abort <id>|synth <id> <text>|events [n]|chat [dir]> [--local]\nenv: OC_BASE, OC_BASE_URL, OC_DATA, OC_CWD, OC_SHOW_THINKING, OC_VERBOSE"
    );
    std::process::exit(64);
}
