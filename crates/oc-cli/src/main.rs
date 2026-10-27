//! oc-cli: minimal client for oc-server, mirroring the v2 API calls the
//! upstream CLI/TUI make (session create / list / get / prompt / abort /
//! synthetic / events).
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
//! Env: OC_BASE (default http://127.0.0.1:18212)

const DEFAULT_BASE: &str = "http://127.0.0.1:18212";

#[tokio::main]
async fn main() {
    let base =
        std::env::var("OC_BASE").unwrap_or_else(|_| DEFAULT_BASE.into());
    let args: Vec<String> = std::env::args().skip(1).collect();
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
            None => return usage("get needs a session id"),
        },
        Some("synth") => match (args.get(1), args.get(2)) {
            (Some(id), Some(text)) => {
                client
                    .post(format!("{base}/api/session/{id}/synthetic"))
                    .json(&serde_json::json!({ "text": text }))
                    .send()
                    .await
            }
            _ => return usage("synth needs <sessionID> <text>"),
        },
        Some("ask") => {
            let text = args.get(1).cloned();
            let Some(text) = text else { return usage("ask needs a prompt") };
            // optional worktree: 2nd arg or OC_CWD (the session's directory
            // decides where file tools and shell commands run)
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
                Err(e) => return fail(2, &format!("create failed: {e}")),
            };
            let Some(id) = created["info"]["id"].as_str().map(str::to_string) else {
                return fail(2, "create returned no session id");
            };
            eprintln!("session {id}");
            return run_prompt(&client, &base, &id, &text).await;
        }
        Some("run") => match (args.get(1), args.get(2)) {
            (Some(id), Some(text)) => return run_prompt(&client, &base, id, text).await,
            _ => return usage("run needs <sessionID> <text>"),
        },
        Some("abort") => match args.get(1) {
            Some(id) => client.post(format!("{base}/api/session/{id}/abort")).send().await,
            None => return usage("abort needs a session id"),
        },
        Some("events") => return stream_events(&base, args.get(1)).await,
        _ => return usage("unknown command"),
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
                return fail(1, &format!("{status} {}", body["error"].as_str().unwrap_or("")));
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

fn fail(code: i32, msg: &str) {
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
    use std::io::Write;
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

fn usage(msg: &str) {
    eprintln!(
        "{msg}\nusage: oc-cli <new [title]|list|get <id>|ask <text> [dir]|run <id> <text>|abort <id>|synth <id> <text>|events [n]>\nenv: OC_BASE, OC_CWD"
    );
    std::process::exit(64);
}
