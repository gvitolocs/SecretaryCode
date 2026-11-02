//! SQLite persistence backend: the same durable boundary upstream's
//! Effect+drizzle layer provides, kept schema-free — every row stores the
//! serialized JSON document (`SessionInfo` / `Message`), so the `oc-schema`
//! wire shapes remain the single source of truth (document-store style).
//!
//! ```text
//! sessions(id TEXT PRIMARY KEY, json TEXT NOT NULL)
//! messages(session_id TEXT NOT NULL, id TEXT NOT NULL,
//!          seq INTEGER NOT NULL,     json TEXT NOT NULL,
//!          PRIMARY KEY (session_id, id))
//! ```
//!
//! `seq` is a monotonic per-session append order (max+1 on insert), so row
//! order is stable without relying on the `msg_` ID sort; `Store::messages`
//! still sorts by ID for compatibility. Every mutation commits immediately
//! (autocommit).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use super::{message_base, Backend, Message, SessionInfo, Store, StoreError};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (session_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (session_id, id));
";

fn db(e: impl std::fmt::Display) -> StoreError {
    StoreError::Db(e.to_string())
}

/// Serialize a document row. The documents written here were parsed from the
/// same types, so a serialization failure is a bug surfaced as `Db`.
fn doc<T: serde::Serialize>(value: &T) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|e| db(format!("serialize document: {e}")))
}

/// Lock the shared connection. The guard is held only inside these synchronous
/// helpers, so it never crosses an await point in callers.
pub(super) fn lock(conn: &Mutex<Connection>) -> Result<MutexGuard<'_, Connection>, StoreError> {
    conn.lock()
        .map_err(|_| StoreError::Db("connection mutex poisoned".into()))
}

impl Store {
    /// Open (or create) a SQLite-backed store — same semantics as `open(dir)`
    /// with document rows instead of files. A fresh path creates the tables;
    /// an existing database loads all sessions and messages at open.
    pub fn open_sqlite(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| StoreError::Io(e.to_string()))?;
            }
        }
        let conn = Connection::open(path).map_err(db)?;
        conn.execute_batch(SCHEMA).map_err(db)?;

        let mut sessions = HashMap::new();
        let mut messages: HashMap<String, Vec<Message>> = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT json FROM sessions").map_err(db)?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(db)?;
            for row in rows {
                let json = row.map_err(db)?;
                let info: SessionInfo = serde_json::from_str(&json)
                    .map_err(|e| db(format!("parse session document: {e}")))?;
                sessions.insert(info.id.clone(), info);
            }
        }
        {
            let mut stmt = conn
                .prepare("SELECT session_id, json FROM messages ORDER BY session_id, seq")
                .map_err(db)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(db)?;
            for row in rows {
                let (session_id, json) = row.map_err(db)?;
                let msg: Message = serde_json::from_str(&json)
                    .map_err(|e| db(format!("parse message document: {e}")))?;
                messages.entry(session_id).or_default().push(msg);
            }
        }

        Ok(Self {
            inner: std::sync::RwLock::new(super::Inner {
                sessions,
                messages,
                backend: Backend::Db(Mutex::new(conn)),
            }),
        })
    }
}

/// Upsert one session document.
pub(super) fn upsert_session(conn: &Connection, s: &SessionInfo) -> Result<(), StoreError> {
    conn.execute(
        "INSERT INTO sessions (id, json) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        rusqlite::params![s.id, doc(s)?],
    )
    .map_err(db)?;
    Ok(())
}

/// Delete a session document and all of its message rows.
pub(super) fn delete_session(conn: &Connection, id: &str) -> Result<(), StoreError> {
    conn.execute(
        "DELETE FROM messages WHERE session_id = ?1",
        rusqlite::params![id],
    )
    .map_err(db)?;
    conn.execute("DELETE FROM sessions WHERE id = ?1", rusqlite::params![id])
        .map_err(db)?;
    Ok(())
}

/// Insert an appended message with `seq = max(seq) + 1` for the session.
pub(super) fn append_message_row(
    conn: &Connection,
    session_id: &str,
    msg: &Message,
) -> Result<(), StoreError> {
    let id = message_base(msg).id.clone();
    conn.execute(
        "INSERT INTO messages (session_id, id, seq, json)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE session_id = ?1), ?3)",
        rusqlite::params![session_id, id, doc(msg)?],
    )
    .map_err(db)?;
    Ok(())
}

/// All of a session's message rows, in one transaction.
pub(super) fn replace_history_rows(
    conn: &Connection,
    session_id: &str,
    messages: &[Message],
) -> Result<(), StoreError> {
    let tx = conn.unchecked_transaction().map_err(db)?;
    tx.execute(
        "DELETE FROM messages WHERE session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(db)?;
    for msg in messages {
        append_message_row(&tx, session_id, msg)?;
    }
    tx.commit().map_err(db)
}

/// Overwrite one stored message document in place (same `seq`).
pub(super) fn replace_message_row(
    conn: &Connection,
    session_id: &str,
    msg: &Message,
) -> Result<(), StoreError> {
    let id = message_base(msg).id.clone();
    let updated = conn
        .execute(
            "UPDATE messages SET json = ?3 WHERE session_id = ?1 AND id = ?2",
            rusqlite::params![session_id, id, doc(msg)?],
        )
        .map_err(db)?;
    if updated == 0 {
        // Appends always write their row before this runs, so a miss means
        // the document set drifted — restore it as a fresh append (max+1).
        append_message_row(conn, session_id, msg)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CreateInput;
    use oc_schema::{LlmUsage, MessageBase, MessageTime, Outcome, SessionListFilter};

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

    fn append_synthetic(store: &Store, session_id: &str, text: &str) {
        let owned = text.to_string();
        store
            .append_message(session_id, move |id, t| {
                Message::Synthetic(oc_schema::SyntheticMessage {
                    base: MessageBase {
                        id,
                        metadata: None,
                        time: MessageTime { created: t },
                    },
                    text: owned,
                    description: None,
                })
            })
            .unwrap();
    }

    fn texts(msgs: &[Message]) -> Vec<&str> {
        msgs.iter()
            .map(|m| match m {
                Message::Synthetic(s) => s.text.as_str(),
                _ => "",
            })
            .collect()
    }

    /// Mirrors `file_persistence_roundtrip`: create → append → replace →
    /// drop → reopen the same path → session + edited message present.
    #[test]
    fn sqlite_persistence_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("store.sqlite");
        let store = Store::open_sqlite(&db_path).unwrap();
        let s = store.create_session(mk("/a")).unwrap();
        append_synthetic(&store, &s.id, "durable");
        // mutate a message in place, then reopen from the database
        let msgs = store.messages(&s.id).unwrap();
        let mut edited = msgs[0].clone();
        if let Message::Synthetic(syn) = &mut edited {
            syn.text = "edited".into();
        }
        store.replace_message(&s.id, edited).unwrap();
        drop(store);

        let reopened = Store::open_sqlite(&db_path).unwrap();
        assert_eq!(reopened.get_session(&s.id).unwrap().id, s.id);
        let msgs = reopened.messages(&s.id).unwrap();
        assert_eq!(msgs.len(), 1);
        match &msgs[0] {
            Message::Synthetic(syn) => assert_eq!(syn.text, "edited"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn sqlite_usage_folds_and_second_open_sees_everything() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("store.sqlite");
        let store = Store::open_sqlite(&db_path).unwrap();
        let a = store.create_session(mk("/a")).unwrap();
        let b = store.create_session(mk("/b")).unwrap();
        append_synthetic(&store, &a.id, "m1");
        std::thread::sleep(std::time::Duration::from_millis(2));
        append_synthetic(&store, &a.id, "m2");
        let u = LlmUsage {
            input: 10.0,
            output: 5.0,
            ..Default::default()
        };
        store.add_usage(&a.id, 0.01, &u).unwrap();
        store.add_usage(&a.id, 0.02, &u).unwrap();
        store.set_outcome(&b.id, Outcome::Succeeded).unwrap();
        drop(store);

        let reopened = Store::open_sqlite(&db_path).unwrap();
        assert_eq!(
            reopened
                .list_sessions(&SessionListFilter::default())
                .sessions
                .len(),
            2
        );
        let done = reopened.get_session(&a.id).unwrap();
        assert_eq!(done.cost, 0.03);
        assert_eq!(done.tokens.input, 20.0);
        assert_eq!(done.tokens.output, 10.0);
        let msgs = reopened.messages(&a.id).unwrap();
        assert_eq!(
            texts(&msgs),
            ["m1", "m2"],
            "append order survives the reopen"
        );
        let idle = reopened.get_session(&b.id).unwrap();
        assert_eq!(idle.outcome, Some(Outcome::Succeeded));
        assert!(idle.time.idle.is_some());
    }

    #[test]
    fn sqlite_remove_session_deletes_messages() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("store.sqlite");
        let store = Store::open_sqlite(&db_path).unwrap();
        let s = store.create_session(mk("/a")).unwrap();
        append_synthetic(&store, &s.id, "gone");
        store.remove_session(&s.id).unwrap();
        assert!(store.get_session(&s.id).is_err());
        assert!(store.messages(&s.id).is_err());
        drop(store);

        let reopened = Store::open_sqlite(&db_path).unwrap();
        assert!(reopened.get_session(&s.id).is_err());
        assert!(reopened.messages(&s.id).is_err());
        // the reopened store stays usable
        let s2 = reopened.create_session(mk("/b")).unwrap();
        assert!(reopened.get_session(&s2.id).is_ok());
    }

    #[test]
    fn sqlite_append_rejects_unknown_session_without_writes() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("store.sqlite");
        let store = Store::open_sqlite(&db_path).unwrap();
        assert!(matches!(
            store.append_message("ses_missing0000000000000000000", |_, _| {
                Message::Synthetic(oc_schema::SyntheticMessage {
                    base: MessageBase {
                        id: "msg_x".into(),
                        metadata: None,
                        time: MessageTime { created: 0 },
                    },
                    text: "nope".into(),
                    description: None,
                })
            }),
            Err(StoreError::NotFound(_))
        ));
        drop(store);
        // reopened cleanly: nothing half-written
        assert!(Store::open_sqlite(&db_path).is_ok());
    }
}
