//! Process-local jobs. Workers never own the manager; every worker is owned
//! by an entry whose drop kills the group synchronously and aborts the worker.
use super::*;
use std::collections::{BTreeMap, VecDeque};
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};
use tokio::io::{AsyncRead, AsyncReadExt};

const MAX_JOBS: usize = 128;
static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub(super) struct JobManager {
    entries: Mutex<BTreeMap<String, Entry>>,
}

struct Entry {
    session: String,
    state: Arc<Mutex<State>>,
    worker: tokio::task::JoinHandle<()>,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.state.lock().unwrap().group.kill_now();
        self.worker.abort();
    }
}

// Also clean up if the Tokio runtime stops while the registry still exists.
// Construct before spawning so this guard runs even if the worker never polls.
struct WorkerGuard(Arc<Mutex<State>>);

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        state.group.kill_now();
        if matches!(state.status, "running" | "cancelling" | "timing_out") {
            state.status = "failed";
            state.error = Some("background worker stopped before completion".into());
        }
    }
}

struct State {
    group: KillGroup,
    status: &'static str,
    exit: Option<i32>,
    signal: Option<i32>,
    error: Option<String>,
    stdout: Capture,
    stderr: Capture,
}

// Keep the first and last bytes while continuing to drain both pipes. Each
// stream retains at most MAX_OUTPUT_BYTES, even for invalid UTF-8 or no newlines.
#[derive(Default)]
struct Capture {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: u64,
}

impl Capture {
    fn push(&mut self, bytes: &[u8]) {
        self.total = self.total.saturating_add(bytes.len() as u64);
        let head_len = (MAX_OUTPUT_BYTES / 2 - self.head.len()).min(bytes.len());
        self.head.extend_from_slice(&bytes[..head_len]);
        for &byte in &bytes[head_len..] {
            if self.tail.len() == MAX_OUTPUT_BYTES / 2 {
                self.tail.pop_front();
            }
            self.tail.push_back(byte);
        }
    }

    fn omitted(&self) -> u64 {
        self.total - (self.head.len() + self.tail.len()) as u64
    }

    fn text(&self) -> String {
        let tail: Vec<u8> = self.tail.iter().copied().collect();
        if self.omitted() == 0 {
            let mut bytes = self.head.clone();
            bytes.extend_from_slice(&tail);
            return String::from_utf8_lossy(&bytes).into_owned();
        }
        format!(
            "{}\n... (output truncated: {} bytes omitted)\n{}",
            String::from_utf8_lossy(&self.head),
            self.omitted(),
            String::from_utf8_lossy(&tail)
        )
    }
}

impl State {
    fn snapshot(&self, id: &str, output: bool) -> serde_json::Value {
        let mut value = serde_json::json!({
            "job_id": id, "status": self.status, "exit": self.exit,
            "signal": self.signal, "error": self.error,
            "truncated": self.stdout.omitted() > 0 || self.stderr.omitted() > 0,
            "stdout_bytes": self.stdout.total, "stderr_bytes": self.stderr.total,
            "stdout_omitted_bytes": self.stdout.omitted(),
            "stderr_omitted_bytes": self.stderr.omitted(),
        });
        if output {
            value["stdout"] = self.stdout.text().into();
            value["stderr"] = self.stderr.text().into();
        }
        value
    }
}

fn response(value: serde_json::Value) -> ToolOutput {
    let mut output = ToolOutput::text(value.to_string());
    output.metadata = Some(value);
    output
}

impl JobManager {
    pub(super) fn launch(
        &self,
        shell: &Shell,
        command: &str,
        workdir: &Path,
        timeout: u64,
        session: &str,
    ) -> Result<ToolOutput, ToolError> {
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= MAX_JOBS {
            return Err(ToolError::Failed(format!(
                "background job limit reached ({MAX_JOBS} retained jobs per registry)"
            )));
        }
        let mut child = spawn_shell(shell, command, workdir)?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let id = format!("job_{}", NEXT_JOB.fetch_add(1, Ordering::Relaxed));
        let state = Arc::new(Mutex::new(State {
            group: KillGroup(child.id().map(|pid| pid as i32)),
            status: "running",
            exit: None,
            signal: None,
            error: None,
            stdout: Capture::default(),
            stderr: Capture::default(),
        }));
        let shared = state.clone();
        let guard = WorkerGuard(state.clone());
        let worker = tokio::spawn(async move {
            let _guard = guard;
            let wait = async {
                let result = if timeout == 0 {
                    child.wait().await
                } else {
                    match tokio::time::timeout(Duration::from_millis(timeout), child.wait()).await {
                        Ok(result) => result,
                        Err(_) => {
                            {
                                let mut state = shared.lock().unwrap();
                                if state.status == "running" {
                                    state.status = "timing_out";
                                }
                                state.group.kill_now();
                            }
                            child.wait().await
                        }
                    }
                };
                // Clean up any descendants even if the shell exited first.
                // This also closes inherited pipes so readers cannot hang.
                shared.lock().unwrap().group.kill_now();
                result
            };
            let (exit, stdout, stderr) = tokio::join!(
                wait,
                drain(stdout, &shared, true),
                drain(stderr, &shared, false)
            );
            let mut state = shared.lock().unwrap();
            state.status = match state.status {
                "cancelling" => "cancelled",
                "timing_out" => "timed_out",
                _ => {
                    if exit.is_ok() {
                        "exited"
                    } else {
                        "failed"
                    }
                }
            };
            match exit {
                Ok(exit) => {
                    state.exit = Some(exit.code().unwrap_or(-1));
                    state.signal = exit.signal();
                }
                Err(error) => state.error = Some(error.to_string()),
            }
            if let Err(error) = stdout.and(stderr) {
                state.error = Some(format!("output read failed: {error}"));
            }
        });
        let output = response(state.lock().unwrap().snapshot(&id, false));
        entries.insert(
            id,
            Entry {
                session: session.into(),
                state,
                worker,
            },
        );
        Ok(output)
    }
}

async fn drain(
    mut pipe: impl AsyncRead + Unpin,
    shared: &Mutex<State>,
    stdout: bool,
) -> std::io::Result<()> {
    let mut bytes = [0; 8192];
    loop {
        let size = pipe.read(&mut bytes).await?;
        if size == 0 {
            return Ok(());
        }
        let mut state = shared.lock().unwrap();
        let capture = if stdout {
            &mut state.stdout
        } else {
            &mut state.stderr
        };
        capture.push(&bytes[..size]);
    }
}

pub(super) struct JobTool {
    pub(super) jobs: Arc<JobManager>,
}

#[async_trait]
impl Tool for JobTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "job".into(),
            description: format!(
                "Manage shell background jobs in the calling session. Use action status for state and exit/signal, output for a nonblocking snapshot of retained stdout/stderr, list for this session's jobs, or cancel to kill the entire process group. Remaining descendants are also killed when the shell exits. Poll status/output until exited, cancelled, timed_out or failed; cancel may first return cancelling. Each stream retains the first and last bytes up to {MAX_OUTPUT_BYTES} bytes with explicit truncation and omitted-byte counts. Jobs and output are process-local, retained only for this registry's lifetime; dropping the registry kills jobs. At most {MAX_JOBS} job records are retained per registry. Launch commands through shell with background:true; job operations use the job permission."
            ),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["status", "output", "list", "cancel"]},
                    "job_id": {"type": "string", "description": "Required except for list; returned by shell background:true"}
                },
                "required": ["action"]
            }),
        }
    }

    async fn execute(
        &self,
        input: &serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, ToolError> {
        let action = req_str(input, "action")?;
        if !matches!(action.as_str(), "status" | "output" | "list" | "cancel") {
            return Err(ToolError::Failed(format!("unknown job action: {action}")));
        }
        let entries = self.jobs.entries.lock().unwrap();
        if action == "list" {
            let jobs: Vec<_> = entries
                .iter()
                .filter(|(_, entry)| entry.session == ctx.session_id)
                .map(|(id, entry)| entry.state.lock().unwrap().snapshot(id, false))
                .collect();
            return Ok(response(serde_json::json!({"jobs": jobs})));
        }
        let id = req_str(input, "job_id")?;
        let entry = entries
            .get(&id)
            .filter(|entry| entry.session == ctx.session_id)
            .ok_or_else(|| ToolError::Failed(format!("unknown job: {id}")))?;
        let mut state = entry.state.lock().unwrap();
        if action == "cancel" && state.status == "running" {
            state.status = "cancelling";
            state.group.kill_now();
        }
        Ok(response(state.snapshot(&id, action == "output")))
    }
}
