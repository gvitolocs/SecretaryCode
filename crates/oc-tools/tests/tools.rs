//! oc-tools tests: registry surface, file-tool semantics, shell execution,
//! search tools. All run in tempfile worktrees; webfetch only exercises its
//! error paths (no network in tests).

use oc_tools::{Registry, ToolContext, ToolError, ToolOutput};
use std::path::Path;
use std::sync::Arc;

fn ctx(dir: &Path) -> ToolContext {
    ToolContext {
        worktree: dir.to_path_buf(),
        session_id: "ses_test".into(),
        call_id: "call_test".into(),
    }
}

fn j(v: serde_json::Value) -> serde_json::Value {
    v
}

#[tokio::test]
async fn registry_lists_all_builtins_with_verbatim_names() {
    let r = Registry::builtin(Path::new("/tmp"));
    let names: Vec<String> = r.defs().iter().map(|d| d.name.clone()).collect();
    assert_eq!(
        names,
        ["shell", "read", "write", "edit", "glob", "grep", "todowrite", "webfetch"]
    );
    for d in r.defs() {
        assert!(!d.description.trim().is_empty(), "{} has an empty description", d.name);
        assert_eq!(d.parameters["type"], "object");
    }
}

#[tokio::test]
async fn write_then_read_roundtrip_with_line_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    r.execute(
        "write",
        &j(serde_json::json!({"path": "src/app.txt", "content": "alpha\nbeta\ngamma\n"})),
        &c,
    )
    .await
    .unwrap();
    // parent dirs were created
    assert!(dir.path().join("src/app.txt").exists());

    let out = r
        .execute("read", &j(serde_json::json!({"path": "src/app.txt"})), &c)
        .await
        .unwrap();
    let ToolOutput { content, .. } = out;
    let oc_schema::ToolContent::Text { text } = &content[0] else { panic!("not text") };
    assert_eq!(text, "1: alpha\n2: beta\n3: gamma");

    // offset/limit slice, 1-based
    let out = r
        .execute(
            "read",
            &j(serde_json::json!({"path": "src/app.txt", "offset": 2, "limit": 1})),
            &c,
        )
        .await
        .unwrap();
    let oc_schema::ToolContent::Text { text } = &out.content[0] else { panic!() };
    // line 3 exists but wasn't shown: the page says where to continue
    assert_eq!(text, "2: beta\n... (truncated; read more from offset 3)");
}

#[tokio::test]
async fn read_missing_file_names_it() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    let err = r
        .execute("read", &j(serde_json::json!({"path": "nope.txt"})), &c)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("file not found"), "{err}");
}

#[tokio::test]
async fn read_directory_lists_entries() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("b.txt"), "x").unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    std::fs::write(dir.path().join("a.txt"), "y").unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    let out = r.execute("read", &j(serde_json::json!({"path": "."})), &c).await.unwrap();
    let oc_schema::ToolContent::Text { text } = &out.content[0] else { panic!() };
    assert_eq!(text, "a.txt\nb.txt\nsub/");
}

#[tokio::test]
async fn edit_unique_replace_and_ambiguity_failure() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    std::fs::write(dir.path().join("f.txt"), "one two one\n").unwrap();

    // unique replace
    r.execute(
        "edit",
        &j(serde_json::json!({"path": "f.txt", "oldString": "two", "newString": "2"})),
        &c,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "one 2 one\n");

    // ambiguous without replaceAll fails
    let err = r
        .execute(
            "edit",
            &j(serde_json::json!({"path": "f.txt", "oldString": "one", "newString": "1"})),
            &c,
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("2 times"), "{err}");

    // replaceAll replaces every occurrence
    r.execute(
        "edit",
        &j(serde_json::json!({"path": "f.txt", "oldString": "one", "newString": "1", "replaceAll": true})),
        &c,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "1 2 1\n");

    // same newString as oldString fails
    let err = r
        .execute(
            "edit",
            &j(serde_json::json!({"path": "f.txt", "oldString": "1", "newString": "1"})),
            &c,
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("must differ"), "{err}");
}

#[tokio::test]
async fn edit_preserves_missing_trailing_newline() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    std::fs::write(dir.path().join("f.txt"), "no newline here").unwrap();
    r.execute(
        "edit",
        &j(serde_json::json!({"path": "f.txt", "oldString": "here", "newString": "there\n"})),
        &c,
    )
    .await
    .unwrap();
    let body = std::fs::read_to_string(dir.path().join("f.txt")).unwrap();
    assert_eq!(body, "no newline there");
}

#[tokio::test]
async fn shell_runs_and_reports_exit_code() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    let out = r
        .execute("shell", &j(serde_json::json!({"command": "echo hello-shell"})), &c)
        .await
        .unwrap();
    let oc_schema::ToolContent::Text { text } = &out.content[0] else { panic!() };
    assert!(text.contains("hello-shell"), "{text}");
    assert_eq!(out.metadata.unwrap()["exit"], 0);

    let out = r
        .execute("shell", &j(serde_json::json!({"command": "exit 3"})), &c)
        .await
        .unwrap();
    assert_eq!(out.metadata.unwrap()["exit"], 3);

    // timeout kill
    let err = r
        .execute(
            "shell",
            &j(serde_json::json!({"command": "sleep 5", "timeout": 100})),
            &c,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ToolError::Failed(ref m) if m.contains("timed out")), "{err}");
}

#[tokio::test]
async fn glob_finds_nested_with_doublestar() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    std::fs::create_dir_all(dir.path().join("deep/nest")).unwrap();
    std::fs::write(dir.path().join("deep/nest/a.ts"), "x").unwrap();
    std::fs::write(dir.path().join("top.ts"), "x").unwrap();
    std::fs::write(dir.path().join("skip.txt"), "x").unwrap();

    let out = r
        .execute("glob", &j(serde_json::json!({"pattern": "**/*.ts"})), &c)
        .await
        .unwrap();
    let oc_schema::ToolContent::Text { text } = &out.content[0] else { panic!() };
    assert!(text.contains("deep/nest/a.ts"), "{text}");
    assert!(text.contains("top.ts"), "{text}");
    assert!(!text.contains("skip.txt"), "{text}");
}

#[tokio::test]
async fn grep_finds_lines_with_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    std::fs::write(dir.path().join("code.rs"), "fn main() {}\nlet NEEDLE = 1;\n").unwrap();
    let out = r
        .execute("grep", &j(serde_json::json!({"pattern": "NEEDLE"})), &c)
        .await
        .unwrap();
    let oc_schema::ToolContent::Text { text } = &out.content[0] else { panic!() };
    assert!(text.contains("code.rs:2:let NEEDLE = 1;"), "{text}");

    // no matches path
    let out = r
        .execute("grep", &j(serde_json::json!({"pattern": "zzz-not-there"})), &c)
        .await
        .unwrap();
    let oc_schema::ToolContent::Text { text } = &out.content[0] else { panic!() };
    assert!(text.contains("no matches"), "{text}");
}

#[tokio::test]
async fn todowrite_validates_and_renders() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    let out = r
        .execute(
            "todowrite",
            &j(serde_json::json!({"todos": [
                {"content": "first", "status": "completed"},
                {"content": "second", "status": "in_progress"},
                {"content": "third", "status": "pending"}
            ]})),
            &c,
        )
        .await
        .unwrap();
    let oc_schema::ToolContent::Text { text } = &out.content[0] else { panic!() };
    assert_eq!(text, "[x] first\n[~] second\n[ ] third");

    let err = r
        .execute(
            "todowrite",
            &j(serde_json::json!({"todos": [{"content": "x", "status": "done"}]})),
            &c,
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("invalid status"), "{err}");
}

#[tokio::test]
async fn webfetch_rejects_bad_scheme_and_unknown_tool_named() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    let err = r
        .execute("webfetch", &j(serde_json::json!({"url": "ftp://example.com"})), &c)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("unsupported URL scheme"), "{err}");

    let err = r.execute("no-such-tool", &j(serde_json::json!({})), &c).await.unwrap_err();
    assert!(matches!(err, ToolError::Unknown(n) if n == "no-such-tool"));
}

#[tokio::test]
async fn resolve_refuses_worktree_escapes() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path());
    let r = Registry::builtin(dir.path());
    let err = r
        .execute(
            "read",
            &j(serde_json::json!({"path": "../../etc/passwd"})),
            &c,
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("escapes the working directory"), "{err}");
}

#[tokio::test]
async fn registry_is_shareable_across_threads() {
    // the server holds it in an Arc and calls execute concurrently
    let r = Arc::new(Registry::builtin(Path::new("/tmp")));
    let (r1, r2) = (r.clone(), r.clone());
    let c = ctx(Path::new("/tmp"));
    let a = tokio::spawn(async move { r1.defs().len() });
    let b = tokio::spawn(async move {
        r2.execute("shell", &j(serde_json::json!({"command": "true"})), &c).await
    });
    assert_eq!(a.await.unwrap(), 8);
    b.await.unwrap().unwrap();
}
