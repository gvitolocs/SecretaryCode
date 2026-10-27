//! oc-store: session store — the port of the session surface of
//! `packages/core/src/session/` (SQL-backed upstream; here an in-memory
//! engine with an optional JSON-file persistence layer, same operations and
//! list-filter semantics from `session.list`'s `ListFilterFields`). Because
//! `ses_` IDs embed an *inverted* sort key, plain ascending string order of
//! IDs is exactly "newest first", the same trick upstream's default list
//! order relies on.
//!
//! Persistence backends: upstream v2 persists through Effect+drizzle into
//! SQLite; the port keeps the same durable boundary with three interchangeable
//! backends behind one in-memory engine, flushing after every mutation:
//!
//! - memory (default): no persistence.
//! - JSON files (`Store::open`), written atomically (tmp + rename):
//!
//! ```text
//! <data>/session/sessions.json        all Session.Info records
//! <data>/session/message/<ses_id>.json  one file per session, Vec<Message>
//! ```
//!
//! - SQLite (`Store::open_sqlite`): schema-free document rows — every row
//!   stores the serialized JSON document, so the `oc-schema` wire shapes stay
//!   the single source of truth (`src/sqlite.rs`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use oc_schema::{
    message_id, session_id, IdleMessage, Message, MessageBase, MessageTime, ModelRef, Order,
    Outcome, SessionErrorValue, SessionInfo, SessionListFilter, SessionTime, SystemMessage,
};

mod sqlite;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("invalid parent: {0}")]
    InvalidParent(String),
    #[error("io: {0}")]
    Io(String),
    #[error("sqlite: {0}")]
    Db(String),
}

/// Where mutations flush. `Files` keeps the JSON layout byte-identical; `Db`
/// writes document rows through a shared SQLite connection (wrapped in a
/// `Mutex` because `rusqlite::Connection` is `Send` but not `Sync`).
#[derive(Default)]
enum Backend {
    #[default]
    Memory,
    Files(PathBuf),
    Db(Mutex<rusqlite::Connection>),
}

#[derive(Default)]
pub struct Store {
    sessions: HashMap<String, SessionInfo>,
    messages: HashMap<String, Vec<Message>>,
    backend: Backend,
}

/// One page of the session list, mirroring `session.list`'s data+optional
/// next-anchor shape, trimmed to the fields this port uses.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionPage {
    pub sessions: Vec<SessionInfo>,
}

pub struct CreateInput {
    pub title: Option<String>,
    pub parent_id: Option<String>,
    pub agent: Option<String>,
    pub model: Option<ModelRef>,
    pub directory: String,
    pub project_id: String,
}

impl Store {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open (or create) a file-backed store. Existing sessions and messages
    /// under `data_dir` are loaded; files missing means a fresh store.
    pub fn open(data_dir: &Path) -> Result<Self, StoreError> {
        let mut store = Self {
            backend: Backend::Files(data_dir.to_path_buf()),
            ..Self::default()
        };
        let sessions_path = data_dir.join("session").join("sessions.json");
        if sessions_path.exists() {
            let raw = std::fs::read_to_string(&sessions_path)
                .map_err(|e| StoreError::Io(e.to_string()))?;
            let list: Vec<SessionInfo> =
                serde_json::from_str(&raw).map_err(|e| StoreError::Io(e.to_string()))?;
            for s in list {
                store.sessions.insert(s.id.clone(), s);
            }
        }
        let msg_dir = data_dir.join("session").join("message");
        if msg_dir.is_dir() {
            let entries =
                std::fs::read_dir(&msg_dir).map_err(|e| StoreError::Io(e.to_string()))?;
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if !store.sessions.contains_key(stem) {
                    continue;
                }
                let raw =
                    std::fs::read_to_string(&path).map_err(|e| StoreError::Io(e.to_string()))?;
                let list: Vec<Message> =
                    serde_json::from_str(&raw).map_err(|e| StoreError::Io(e.to_string()))?;
                store.messages.insert(stem.to_string(), list);
            }
        }
        Ok(store)
    }

    fn write_atomic(path: &Path, body: &str) -> Result<(), StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| StoreError::Io(e.to_string()))?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).map_err(|e| StoreError::Io(e.to_string()))?;
        std::fs::rename(&tmp, path).map_err(|e| StoreError::Io(e.to_string()))?;
        Ok(())
    }

    fn persist_sessions(&self) -> Result<(), StoreError> {
        match &self.backend {
            Backend::Memory => Ok(()),
            Backend::Files(dir) => {
                let mut list: Vec<&SessionInfo> = self.sessions.values().collect();
                list.sort_by(|a, b| a.id.cmp(&b.id));
                let body =
                    serde_json::to_string(&list).map_err(|e| StoreError::Io(e.to_string()))?;
                Self::write_atomic(&dir.join("session").join("sessions.json"), &body)
            }
            Backend::Db(conn) => {
                // The in-memory map is the source of truth and this runs right
                // after every session mutation, so upserting every document
                // keeps the table in lockstep (remove_session deletes below).
                let conn = sqlite::lock(conn)?;
                for s in self.sessions.values() {
                    sqlite::upsert_session(&conn, s)?;
                }
                Ok(())
            }
        }
    }

    /// Files backend: rewrite the session's message file atomically. (The
    /// SQLite backend writes rows directly at the mutation sites.)
    fn persist_messages(&self, session_id: &str) -> Result<(), StoreError> {
        let Backend::Files(dir) = &self.backend else {
            return Ok(());
        };
        let empty = Vec::new();
        let list = self.messages.get(session_id).unwrap_or(&empty);
        let body = serde_json::to_string(list).map_err(|e| StoreError::Io(e.to_string()))?;
        Self::write_atomic(
            &dir.join("session").join("message").join(format!("{session_id}.json")),
            &body,
        )
    }

    /// `session.create` — ID generated with the upstream scheme, times
    /// stamped, cost/tokens zeroed.
    pub fn create_session(&mut self, input: CreateInput) -> Result<SessionInfo, StoreError> {
        if let Some(parent) = &input.parent_id {
            if !self.sessions.contains_key(parent) {
                return Err(StoreError::InvalidParent(parent.clone()));
            }
        }
        let now = now_ms();
        let info = SessionInfo {
            id: session_id::create(),
            parent_id: input.parent_id,
            project_id: input.project_id,
            agent: input.agent,
            model: input.model,
            cost: 0.0,
            tokens: Default::default(),
            outcome: None,
            time: SessionTime { created: now, updated: now, idle: None, viewed: None, archived: None },
            title: input.title,
            location: oc_schema::LocationRef { directory: input.directory, workspace_id: None },
            subpath: None,
        };
        self.sessions.insert(info.id.clone(), info.clone());
        self.persist_sessions()?;
        Ok(info)
    }

    /// `session.list` with the ported filter semantics:
    /// - default order: newest first. `ses_` IDs embed an *inverted* sort
    ///   key, so plain ascending string order IS newest-first.
    /// - `order=asc`: oldest first (reverse string order).
    /// - `search`: case-insensitive substring on title
    /// - `parentID`: exact parent match; JSON `null` (None here) = roots only
    /// - `archived`: `true` → only archived, `false`/absent → only active
    pub fn list_sessions(&self, filter: &SessionListFilter) -> SessionPage {
        let mut sessions: Vec<SessionInfo> = self.sessions.values().cloned().collect();
        if let Some(parent) = &filter.parent_id {
            sessions.retain(|s| s.parent_id.as_ref() == parent.as_ref());
        }
        if filter.archived != Some(true) {
            sessions.retain(|s| s.time.archived.is_none());
        }
        if let Some(query) = &filter.search {
            let q = query.to_lowercase();
            sessions.retain(|s| {
                s.title
                    .as_deref()
                    .map(|t| t.to_lowercase().contains(&q))
                    .unwrap_or(false)
            });
        }
        sessions.sort_by(|a, b| a.id.cmp(&b.id)); // ascending = newest first
        if filter.order == Some(Order::Asc) {
            sessions.reverse(); // oldest first
        }
        SessionPage { sessions }
    }

    pub fn get_session(&self, id: &str) -> Result<SessionInfo, StoreError> {
        self.sessions.get(id).cloned().ok_or_else(|| StoreError::NotFound(id.into()))
    }

    /// `session.update` (PATCH) — title and archive transitions; touches
    /// `time.updated`.
    pub fn update_session(
        &mut self,
        id: &str,
        title: Option<String>,
        archived: Option<bool>,
    ) -> Result<SessionInfo, StoreError> {
        let s = self.sessions.get_mut(id).ok_or_else(|| StoreError::NotFound(id.into()))?;
        if let Some(t) = title {
            s.title = Some(t);
        }
        if let Some(arch) = archived {
            s.time.archived = arch.then_some(now_ms());
        }
        s.time.updated = now_ms();
        let out = s.clone();
        self.persist_sessions()?;
        Ok(out)
    }

    /// `session.remove`.
    pub fn remove_session(&mut self, id: &str) -> Result<SessionInfo, StoreError> {
        self.messages.remove(id);
        let out = self.sessions.remove(id).ok_or_else(|| StoreError::NotFound(id.into()))?;
        match &self.backend {
            Backend::Memory => {}
            Backend::Files(dir) => {
                self.persist_sessions()?;
                let path = dir.join("session").join("message").join(format!("{id}.json"));
                let _ = std::fs::remove_file(path);
            }
            Backend::Db(conn) => {
                let conn = sqlite::lock(conn)?;
                sqlite::delete_session(&conn, id)?;
            }
        }
        Ok(out)
    }

    /// Mark a run's terminal outcome (`outcome` + `time.idle`).
    pub fn set_outcome(&mut self, id: &str, outcome: Outcome) -> Result<SessionInfo, StoreError> {
        let s = self.sessions.get_mut(id).ok_or_else(|| StoreError::NotFound(id.into()))?;
        s.outcome = Some(outcome);
        let now = now_ms();
        s.time.idle = Some(now);
        s.time.updated = now;
        let out = s.clone();
        self.persist_sessions()?;
        Ok(out)
    }

    /// Fold a completed assistant step's cost/tokens into the session total.
    pub fn add_usage(
        &mut self,
        id: &str,
        cost: f64,
        usage: &oc_schema::LlmUsage,
    ) -> Result<SessionInfo, StoreError> {
        let s = self.sessions.get_mut(id).ok_or_else(|| StoreError::NotFound(id.into()))?;
        s.cost += cost;
        s.tokens.input += usage.input;
        s.tokens.output += usage.output;
        s.tokens.reasoning += usage.reasoning;
        s.tokens.cache.read += usage.cache_read;
        s.tokens.cache.write += usage.cache_write;
        let out = s.clone();
        self.persist_sessions()?;
        Ok(out)
    }

    /// `session.active` — sessions with no idle time and not archived,
    /// newest first.
    pub fn active_sessions(&self) -> Vec<SessionInfo> {
        let mut v: Vec<SessionInfo> = self
            .sessions
            .values()
            .filter(|s| s.time.idle.is_none() && s.time.archived.is_none())
            .cloned()
            .collect();
        v.sort_by(|a, b| a.id.cmp(&b.id)); // ascending string order = newest first
        v
    }

    /// Append a message to a session (`session.synthetic`, `session.prompt`
    /// land here after their handlers build the message).
    pub fn append_message(
        &mut self,
        session_id: &str,
        build: impl FnOnce(String, u64) -> Message,
    ) -> Result<Message, StoreError> {
        if !self.sessions.contains_key(session_id) {
            return Err(StoreError::NotFound(session_id.into()));
        }
        let msg = build(message_id::create(), now_ms());
        self.messages.entry(session_id.to_string()).or_default().push(msg.clone());
        match &self.backend {
            Backend::Memory => {}
            Backend::Files(_) => self.persist_messages(session_id)?,
            Backend::Db(conn) => {
                let conn = sqlite::lock(conn)?;
                sqlite::append_message_row(&conn, session_id, &msg)?;
            }
        }
        Ok(msg)
    }

    /// Replace a stored message in place — the agent loop mutates a tool
    /// part's state from running to completed/error after execution.
    pub fn replace_message(&mut self, session_id: &str, msg: Message) -> Result<(), StoreError> {
        let list = self
            .messages
            .get_mut(session_id)
            .ok_or_else(|| StoreError::NotFound(session_id.into()))?;
        let id = message_base(&msg).id.clone();
        match list.iter_mut().find(|m| message_base(m).id == id) {
            Some(slot) => *slot = msg.clone(),
            None => return Err(StoreError::NotFound(id)),
        }
        match &self.backend {
            Backend::Memory => {}
            Backend::Files(_) => self.persist_messages(session_id)?,
            Backend::Db(conn) => {
                let conn = sqlite::lock(conn)?;
                sqlite::replace_message_row(&conn, session_id, &msg)?;
            }
        }
        Ok(())
    }

    /// Messages of a session, oldest first (ascending `msg_` IDs).
    pub fn messages(&self, session_id: &str) -> Result<Vec<Message>, StoreError> {
        let mut v = self
            .messages
            .get(session_id)
            .cloned()
            .ok_or_else(|| StoreError::NotFound(session_id.into()))?;
        v.sort_by(|a, b| message_base(a).id.cmp(&message_base(b).id));
        Ok(v)
    }
}

fn message_base(m: &Message) -> &MessageBase {
    match m {
        Message::User(u) => &u.base,
        Message::Assistant(a) => &a.base,
        Message::Synthetic(s) => &s.base,
        Message::System(s) => &s.base,
        Message::AgentSwitched(a) => &a.base,
        Message::ModelSwitched(m) => &m.base,
        Message::Idle(i) => &i.base,
    }
}

/// Constructors the agent loop and server share (IDs/timestamps applied here,
/// so call sites stay declarative).
pub fn user_message(text: String, files: Vec<String>, id: String, created: u64) -> Message {
    Message::User(oc_schema::UserMessage {
        base: MessageBase { id, metadata: None, time: MessageTime { created } },
        text,
        files,
        agents: Vec::new(),
    })
}

pub fn assistant_message(
    agent: &str,
    model: ModelRef,
    content: Vec<oc_schema::AssistantContent>,
    id: String,
    created: u64,
) -> Message {
    Message::Assistant(oc_schema::AssistantMessage {
        base: MessageBase { id, metadata: None, time: MessageTime { created } },
        agent: agent.to_string(),
        model,
        content,
        finish: None,
        raw_finish: None,
        cost: None,
        tokens: None,
        error: None,
        time: oc_schema::AssistantTime { created, streamed: None, completed: None },
    })
}

pub fn system_message(text: &str, description: &str, id: String, created: u64) -> Message {
    Message::System(SystemMessage {
        base: MessageBase { id, metadata: None, time: MessageTime { created } },
        text: text.to_string(),
        description: Some(description.to_string()),
    })
}

pub fn idle_message(outcome: Outcome, id: String, created: u64) -> Message {
    Message::Idle(IdleMessage {
        base: MessageBase { id, metadata: None, time: MessageTime { created } },
        outcome,
        error: None,
    })
}

pub fn synthetic_message(text: &str, id: String, created: u64) -> Message {
    Message::Synthetic(oc_schema::SyntheticMessage {
        base: MessageBase { id, metadata: None, time: MessageTime { created } },
        text: text.to_string(),
        description: None,
    })
}

pub fn session_error(name: &str, message: &str) -> SessionErrorValue {
    SessionErrorValue { name: name.to_string(), message: Some(message.to_string()), data: None }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use oc_schema::MessageTime;

    fn mk(dir: &str) -> CreateInput {
        CreateInput {
            title: None,
            parent_id: None,
            agent: Some("build".into()),
            model: None,
            directory: dir.into(),
            project_id: "global".into(),
        }
    }

    #[test]
    fn create_then_list_newest_first() {
        let mut store = Store::new();
        let a = store.create_session(mk("/tmp/a")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = store.create_session(mk("/tmp/b")).unwrap();
        let page = store.list_sessions(&SessionListFilter::default());
        let ids: Vec<_> = page.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, [b.id.as_str(), a.id.as_str()], "newest first");
    }

    #[test]
    fn order_asc_reverses() {
        let mut store = Store::new();
        store.create_session(mk("/a")).unwrap();
        store.create_session(mk("/b")).unwrap();
        let page = store.list_sessions(&SessionListFilter { order: Some(Order::Asc), ..Default::default() });
        assert_eq!(page.sessions.len(), 2);
        // asc = oldest first; oldest carries the largest inverted key.
        assert!(page.sessions[0].id > page.sessions[1].id);
    }

    #[test]
    fn search_filters_by_title_substring() {
        let mut store = Store::new();
        let mut a = mk("/a");
        a.title = Some("Fix the login bug".into());
        let mut b = mk("/b");
        b.title = Some("Write README".into());
        store.create_session(a).unwrap();
        store.create_session(b).unwrap();
        let page = store.list_sessions(&SessionListFilter {
            search: Some("LOGIN".into()),
            ..Default::default()
        });
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].title.as_deref(), Some("Fix the login bug"));
    }

    #[test]
    fn parent_filter_roots_only_with_null() {
        let mut store = Store::new();
        let root = store.create_session(mk("/a")).unwrap();
        let mut child = mk("/a");
        child.parent_id = Some(root.id.clone());
        store.create_session(child).unwrap();
        // parentID: null → roots only
        let page = store.list_sessions(&SessionListFilter {
            parent_id: Some(None),
            ..Default::default()
        });
        assert_eq!(page.sessions.len(), 1);
        // parentID: <id> → only that child
        let page = store.list_sessions(&SessionListFilter {
            parent_id: Some(Some(root.id.clone())),
            ..Default::default()
        });
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].parent_id.as_deref(), Some(root.id.as_str()));
    }

    #[test]
    fn archive_transition_and_filter() {
        let mut store = Store::new();
        let s = store.create_session(mk("/a")).unwrap();
        store.update_session(&s.id, None, Some(true)).unwrap();
        assert!(store.list_sessions(&SessionListFilter::default()).sessions.is_empty());
        assert_eq!(store.list_sessions(&SessionListFilter { archived: Some(true), ..Default::default() }).sessions.len(), 1);
    }

    #[test]
    fn create_rejects_unknown_parent() {
        let mut store = Store::new();
        let mut c = mk("/a");
        c.parent_id = Some("ses_doesnotexist0123456789abcdef".into());
        assert!(matches!(
            store.create_session(c),
            Err(StoreError::InvalidParent(_))
        ));
    }

    #[test]
    fn messages_append_and_sort_oldest_first() {
        let mut store = Store::new();
        let s = store.create_session(mk("/a")).unwrap();
        let m1 = store
            .append_message(&s.id, |id, t| {
                Message::Synthetic(oc_schema::SyntheticMessage {
                    base: MessageBase { id, metadata: None, time: MessageTime { created: t } },
                    text: "first".into(),
                    description: None,
                })
            })
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let m2 = store
            .append_message(&s.id, |id, t| {
                Message::Synthetic(oc_schema::SyntheticMessage {
                    base: MessageBase { id, metadata: None, time: MessageTime { created: t } },
                    text: "second".into(),
                    description: None,
                })
            })
            .unwrap();
        let list = store.messages(&s.id).unwrap();
        let texts: Vec<_> = list.iter().map(|m| match m {
            Message::Synthetic(s) => s.text.as_str(),
            _ => "",
        }).collect();
        assert_eq!(texts, ["first", "second"]);
        assert_eq!(message_base(&m1).id, message_base(&list[0]).id);
        assert_eq!(message_base(&m2).id, message_base(&list[1]).id);
        assert!(store.messages("ses_missing0000000000000000000").is_err());
    }

    #[test]
    fn outcome_sets_idle_and_active_list_shrinks() {
        let mut store = Store::new();
        let s = store.create_session(mk("/a")).unwrap();
        assert_eq!(store.active_sessions().len(), 1);
        store.set_outcome(&s.id, Outcome::Succeeded).unwrap();
        let done = store.get_session(&s.id).unwrap();
        assert_eq!(done.outcome, Some(Outcome::Succeeded));
        assert!(done.time.idle.is_some());
        assert!(store.active_sessions().is_empty());
    }

    #[test]
    fn file_persistence_roundtrip() {
        let dir = std::env::temp_dir().join(format!("oc-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut store = Store::open(&dir).unwrap();
        let s = store.create_session(mk("/a")).unwrap();
        store
            .append_message(&s.id, |id, t| {
                Message::Synthetic(oc_schema::SyntheticMessage {
                    base: MessageBase { id, metadata: None, time: MessageTime { created: t } },
                    text: "durable".into(),
                    description: None,
                })
            })
            .unwrap();
        // mutate a message in place, then reopen from disk
        let msgs = store.messages(&s.id).unwrap();
        let mut edited = msgs[0].clone();
        if let Message::Synthetic(syn) = &mut edited {
            syn.text = "edited".into();
        }
        store.replace_message(&s.id, edited).unwrap();
        drop(store);

        let reopened = Store::open(&dir).unwrap();
        assert_eq!(reopened.get_session(&s.id).unwrap().id, s.id);
        let msgs = reopened.messages(&s.id).unwrap();
        assert_eq!(msgs.len(), 1);
        match &msgs[0] {
            Message::Synthetic(syn) => assert_eq!(syn.text, "edited"),
            other => panic!("wrong variant: {other:?}"),
        }
        assert!(dir.join("session").join("sessions.json").exists());
        assert!(dir.join("session").join("message").join(format!("{}.json", s.id)).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn usage_folds_into_session_totals() {
        let mut store = Store::new();
        let s = store.create_session(mk("/a")).unwrap();
        let u = oc_schema::LlmUsage { input: 10.0, output: 5.0, ..Default::default() };
        store.add_usage(&s.id, 0.01, &u).unwrap();
        store.add_usage(&s.id, 0.02, &u).unwrap();
        let out = store.get_session(&s.id).unwrap();
        assert_eq!(out.cost, 0.03);
        assert_eq!(out.tokens.input, 20.0);
        assert_eq!(out.tokens.output, 10.0);
    }
}
