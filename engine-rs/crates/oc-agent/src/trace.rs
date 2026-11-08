//! Content-free timings. The caller chooses whether and where to persist them.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use serde_json::{json, Value};

use crate::{Observer, RunEvent};

static NEXT_TURN: AtomicU64 = AtomicU64::new(1);

pub(crate) struct TurnTrace {
    session: String,
    turn: String,
    start: Instant,
    observer: Observer,
}

pub(crate) fn ms(elapsed: std::time::Duration) -> f64 {
    elapsed.as_secs_f64() * 1000.0
}

impl TurnTrace {
    pub(crate) fn new(session: &str, observer: Observer) -> Self {
        Self {
            session: session.into(),
            turn: format!(
                "run_{}_{}_{}",
                crate::now_ms(),
                std::process::id(),
                NEXT_TURN.fetch_add(1, Ordering::Relaxed)
            ),
            start: Instant::now(),
            observer,
        }
    }

    pub(crate) fn elapsed_ms(&self) -> f64 {
        ms(self.start.elapsed())
    }

    pub(crate) fn emit(&self, event: &str, details: Value) {
        let mut record = details;
        let fields = record
            .as_object_mut()
            .expect("trace details must be an object");
        fields.insert("schema_version".into(), json!(1));
        fields.insert("event".into(), json!(event));
        fields.insert("session_id".into(), json!(self.session));
        fields.insert("turn_id".into(), json!(self.turn));
        fields.insert("time_unix_ms".into(), json!(crate::now_ms()));
        fields.insert("turn_elapsed_ms".into(), json!(self.elapsed_ms()));
        (self.observer)(RunEvent::Trace { record });
    }

    pub(crate) fn request_id(&self, step: u32, attempt: usize) -> String {
        format!("{}:{step}:{attempt}", self.turn)
    }
}

#[derive(Default)]
pub(crate) struct StreamMetrics {
    pub response_headers_ms: Option<f64>,
    pub request_metadata: Option<Value>,
    pub first_delta_ms: Option<f64>,
    pub first_reasoning_ms: Option<f64>,
    pub first_text_ms: Option<f64>,
    pub reasoning_bytes: usize,
    pub text_bytes: usize,
    pub tool_argument_bytes: usize,
    pub provider_timings: Option<Value>,
}

impl StreamMetrics {
    pub(crate) fn observe(&mut self, event: &oc_provider::StreamEvent, elapsed_ms: f64) {
        use oc_provider::StreamEvent::*;
        match event {
            RequestPrepared { metadata } => self.request_metadata = Some(metadata.clone()),
            ResponseStarted => self.response_headers_ms = Some(elapsed_ms),
            Text { delta } if !delta.is_empty() => {
                self.first_text_ms.get_or_insert(elapsed_ms);
                self.first_delta_ms.get_or_insert(elapsed_ms);
                self.text_bytes += delta.len();
            }
            Reasoning { delta } if !delta.is_empty() => {
                self.first_reasoning_ms.get_or_insert(elapsed_ms);
                self.first_delta_ms.get_or_insert(elapsed_ms);
                self.reasoning_bytes += delta.len();
            }
            ToolCallStarted { .. } => {
                self.first_delta_ms.get_or_insert(elapsed_ms);
            }
            ToolCallDelta {
                arguments_delta, ..
            } => {
                self.first_delta_ms.get_or_insert(elapsed_ms);
                self.tool_argument_bytes += arguments_delta.len();
            }
            ProviderTimings { timings } => self.provider_timings = Some(timings.clone()),
            _ => {}
        }
    }

    pub(crate) fn json(&self) -> Value {
        json!({
            "response_headers_ms": self.response_headers_ms,
            "request": self.request_metadata,
            "first_delta_ms": self.first_delta_ms,
            "first_reasoning_ms": self.first_reasoning_ms,
            "first_text_ms": self.first_text_ms,
            "reasoning_bytes": self.reasoning_bytes,
            "text_bytes": self.text_bytes,
            "tool_argument_bytes": self.tool_argument_bytes,
            "provider_timings": self.provider_timings,
        })
    }
}

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct TraceWriter(Mutex<Option<File>>);

impl TraceWriter {
    fn from_env(session: &str) -> Option<Self> {
        let setting = std::env::var("OC_TRACE")
            .ok()
            .filter(|s| !s.trim().is_empty());
        if setting.as_deref().is_some_and(|s| matches!(s, "off" | "0")) {
            return None;
        }
        let path = setting.map(PathBuf::from).or_else(|| {
            std::env::var_os("OC_DATA").map(|data| {
                PathBuf::from(data)
                    .join("trace")
                    .join(format!("{session}.jsonl"))
            })
        })?;
        let open = || -> std::io::Result<File> {
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                std::fs::create_dir_all(parent)?;
            }
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(&path)?;
            if !file.metadata()?.is_file() {
                return Err(std::io::Error::other("trace must be a regular file"));
            }
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            Ok(file)
        };
        match open() {
            Ok(file) => {
                eprintln!("trace {}", path.display());
                Some(Self(Mutex::new(Some(file))))
            }
            Err(error) => {
                eprintln!("cannot open diagnostic trace {}: {error}", path.display());
                None
            }
        }
    }

    fn write(&self, record: &serde_json::Value) {
        let mut slot = self.0.lock().unwrap();
        let Some(file) = slot.as_mut() else {
            return;
        };
        let mut line = record.to_string();
        line.push('\n');
        if let Err(error) = file.write_all(line.as_bytes()).and_then(|_| file.flush()) {
            eprintln!("diagnostic trace disabled after write failure: {error}");
            *slot = None;
        }
    }
}

pub(crate) fn file_observer(observer: Observer, session: &str) -> Observer {
    let writer = TraceWriter::from_env(session);
    Arc::new(move |event| {
        if let (Some(writer), RunEvent::Trace { record }) = (&writer, &event) {
            writer.write(record);
        }
        observer(event);
    })
}
