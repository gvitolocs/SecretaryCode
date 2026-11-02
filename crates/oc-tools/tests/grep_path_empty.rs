use oc_tools::{Registry, ToolContext};
use std::path::Path;

#[tokio::test]
async fn grep_falls_back_when_rg_is_not_on_path() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("code.rs"),
        "fn main() {}\nlet NEEDLE = 1;\n",
    )
    .unwrap();
    let ctx = ToolContext {
        worktree: dir.path().to_path_buf(),
        session_id: "ses_test".into(),
        call_id: "call_test".into(),
    };
    let old = std::env::var_os("PATH");
    std::env::set_var("PATH", "");
    let r = Registry::builtin(Path::new("/tmp"));
    let out = r
        .execute(
            "grep",
            &serde_json::json!({"pattern": "NEEDLE", "path": dir.path().to_string_lossy()}),
            &ctx,
        )
        .await
        .unwrap();
    if let Some(old) = old {
        std::env::set_var("PATH", old);
    }
    let oc_schema::ToolContent::Text { text } = &out.content[0] else {
        panic!()
    };
    assert!(text.contains("code.rs:2:let NEEDLE = 1;"), "{text}");
}
