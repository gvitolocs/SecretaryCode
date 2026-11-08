use oc_tools::{Registry, ToolContext};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

fn context(path: &Path, session: &str) -> ToolContext {
    ToolContext {
        worktree: path.into(),
        session_id: session.into(),
        call_id: "call_job".into(),
    }
}

async fn launch(registry: &Registry, ctx: &ToolContext, command: &str) -> String {
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        registry.execute(
            "shell",
            &json!({"command": command, "background": true}),
            ctx,
        ),
    )
    .await
    .expect("launch must return promptly")
    .unwrap();
    output.metadata.unwrap()["job_id"].as_str().unwrap().into()
}

async fn job(registry: &Registry, ctx: &ToolContext, action: &str, id: &str) -> Value {
    registry
        .execute("job", &json!({"action": action, "job_id": id}), ctx)
        .await
        .unwrap()
        .metadata
        .unwrap()
}

async fn collect(registry: &Registry, ctx: &ToolContext, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let output = job(registry, ctx, "output", id).await;
            if matches!(
                output["status"].as_str(),
                Some("exited" | "cancelled" | "timed_out" | "failed")
            ) {
                return output;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("job must finish")
}

#[tokio::test]
async fn launch_continue_collect_and_repeat_output() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), "owner");
    let registry = Registry::builtin(dir.path());
    // A gate makes the prompt-return assertion independent of scheduler speed.
    let id = launch(
        &registry,
        &ctx,
        "while [ ! -f gate ]; do sleep 0.01; done; printf collected; printf diagnostic >&2",
    )
    .await;
    assert_eq!(
        job(&registry, &ctx, "status", &id).await["status"],
        "running"
    );
    registry
        .execute("write", &json!({"path": "gate", "content": "go"}), &ctx)
        .await
        .unwrap();
    let output = collect(&registry, &ctx, &id).await;
    assert_eq!(output["status"], "exited");
    assert_eq!(output["exit"], 0);
    assert_eq!(output["stdout"], "collected");
    assert_eq!(output["stderr"], "diagnostic");
    assert_eq!(output["truncated"], false);
    assert_eq!(job(&registry, &ctx, "output", &id).await, output);
    assert_eq!(
        job(&registry, &ctx, "list", "").await["jobs"][0]["job_id"],
        id
    );
}

#[tokio::test]
async fn nonzero_exit_is_retained() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), "owner");
    let registry = Registry::builtin(dir.path());
    let id = launch(&registry, &ctx, "printf failure >&2; exit 23").await;
    let output = collect(&registry, &ctx, &id).await;
    assert_eq!(output["status"], "exited");
    assert_eq!(output["exit"], 23);
    assert_eq!(output["stderr"], "failure");
    assert!(output["signal"].is_null());
}

#[tokio::test]
async fn sessions_cannot_inspect_or_cancel_each_others_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let owner = context(dir.path(), "owner");
    let other = context(dir.path(), "other");
    let registry = Registry::builtin(dir.path());
    let id = launch(&registry, &owner, "sleep 60").await;
    assert_eq!(job(&registry, &other, "list", "").await["jobs"], json!([]));
    for action in ["status", "output", "cancel"] {
        let error = registry
            .execute("job", &json!({"action": action, "job_id": id}), &other)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("unknown job"));
    }
    assert_eq!(
        job(&registry, &owner, "status", &id).await["status"],
        "running"
    );
    let other_registry = Registry::builtin(dir.path());
    assert!(
        other_registry
            .execute("job", &json!({"action": "status", "job_id": id}), &owner)
            .await
            .is_err()
    );
    job(&registry, &owner, "cancel", &id).await;
    assert_eq!(collect(&registry, &owner, &id).await["status"], "cancelled");
}

async fn wait_for_file(path: &Path) -> String {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                if !text.trim().is_empty() {
                    return text;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("process must publish its pid")
}

// A killed orphan can remain a zombie until the host's init reaps it. Zombies
// cannot execute or keep pipes open and must not count as live descendants.
fn running(pid: i32) -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        !stat.rsplit_once(") ").unwrap().1.starts_with('Z')
    }
    #[cfg(not(target_os = "linux"))]
    unsafe {
        libc::kill(pid, 0) == 0
    }
}

async fn assert_stopped(pids: &[i32]) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while pids.iter().any(|pid| running(*pid)) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("all processes in the group must stop");
}

// The nested shell and its sleep ignore TERM, so cancellation must reach the
// whole process group using KILL, including the grandchild.
const TREE: &str = "echo $$ > shell.pid; sh -c 'trap \"\" TERM; sleep 60 & echo $! > leaf.pid; echo $$ > child.pid; wait' & wait";

async fn tree_pids(dir: &Path) -> Vec<i32> {
    let mut pids = Vec::new();
    for name in ["shell.pid", "child.pid", "leaf.pid"] {
        pids.push(wait_for_file(&dir.join(name)).await.trim().parse().unwrap());
    }
    assert!(pids.iter().all(|pid| running(*pid)));
    pids
}

#[tokio::test]
async fn cancel_kills_descendants_and_retains_signal() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), "owner");
    let registry = Registry::builtin(dir.path());
    let id = launch(&registry, &ctx, TREE).await;
    let pids = tree_pids(dir.path()).await;
    job(&registry, &ctx, "cancel", &id).await;
    let output = collect(&registry, &ctx, &id).await;
    assert_eq!(output["status"], "cancelled");
    assert_eq!(output["signal"], libc::SIGKILL);
    assert_eq!(output["exit"], -1);
    assert_stopped(&pids).await;
    assert_eq!(
        job(&registry, &ctx, "cancel", &id).await["status"],
        "cancelled"
    );
}

#[tokio::test]
async fn last_registry_owner_drop_kills_jobs_and_descendants() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), "owner");
    let registry = std::sync::Arc::new(Registry::builtin(dir.path()));
    let owner = registry.clone();
    let id = launch(&registry, &ctx, TREE).await;
    let pids = tree_pids(dir.path()).await;
    drop(registry);
    assert_eq!(job(&owner, &ctx, "status", &id).await["status"], "running");
    drop(owner);
    assert_stopped(&pids).await;
}

#[tokio::test]
async fn timeout_kills_job_and_records_exit() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), "owner");
    let registry = Registry::builtin(dir.path());
    let output = registry
        .execute(
            "shell",
            &json!({"command": "sleep 60", "background": true, "timeout": 50}),
            &ctx,
        )
        .await
        .unwrap();
    let id = output.metadata.unwrap()["job_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let output = collect(&registry, &ctx, &id).await;
    assert_eq!(output["status"], "timed_out");
    assert_eq!(output["signal"], libc::SIGKILL);
}

#[tokio::test]
async fn completed_shell_cleans_up_descendants_holding_output_pipes() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), "owner");
    let registry = Registry::builtin(dir.path());
    let id = launch(&registry, &ctx, "sleep 60 & echo $! > leaf.pid; exit 0").await;
    let pid = wait_for_file(&dir.path().join("leaf.pid"))
        .await
        .trim()
        .parse()
        .unwrap();
    let output = collect(&registry, &ctx, &id).await;
    assert_eq!(output["exit"], 0);
    assert_stopped(&[pid]).await;
}

#[tokio::test]
async fn both_streams_are_drained_with_bounded_head_and_tail() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), "owner");
    let registry = Registry::builtin(dir.path());
    let id = launch(&registry, &ctx,
        "printf HEAD; head -c 2000000 /dev/zero; printf TAIL; printf ERRHEAD >&2; head -c 2000000 /dev/zero >&2; printf ERRTAIL >&2").await;
    let output = collect(&registry, &ctx, &id).await;
    assert_eq!(output["exit"], 0);
    assert_eq!(output["truncated"], true);
    for (stream, head, tail, total) in [
        ("stdout", "HEAD", "TAIL", 2_000_008u64),
        ("stderr", "ERRHEAD", "ERRTAIL", 2_000_014u64),
    ] {
        let text = output[stream].as_str().unwrap();
        assert!(text.starts_with(head));
        assert!(text.ends_with(tail));
        assert!(text.contains("output truncated"));
        assert!(text.len() < 30_200);
        assert_eq!(output[format!("{stream}_bytes")], total);
        assert_eq!(output[format!("{stream}_omitted_bytes")], total - 30_000);
    }
}

#[tokio::test]
async fn invalid_actions_missing_ids_and_bad_workdir_fail_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), "owner");
    let registry = Registry::builtin(dir.path());
    for input in [
        json!({"action": "bogus"}),
        json!({"action": "status"}),
        json!({"action": "output", "job_id": "missing"}),
    ] {
        assert!(registry.execute("job", &input, &ctx).await.is_err());
    }
    assert!(registry.execute("shell", &json!({"command": "touch should-not-exist", "background": true, "workdir": "missing"}), &ctx).await.is_err());
    assert!(!dir.path().join("should-not-exist").exists());
    assert_eq!(job(&registry, &ctx, "list", "").await["jobs"], json!([]));
}

#[test]
fn runtime_shutdown_kills_descendants_even_if_registry_is_still_owned() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path(), "owner");
    let registry = Registry::builtin(dir.path());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (id, pids) = runtime.block_on(async {
        let id = launch(&registry, &ctx, TREE).await;
        (id, tree_pids(dir.path()).await)
    });
    drop(runtime);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        assert_stopped(&pids).await;
        assert_eq!(
            job(&registry, &ctx, "status", &id).await["status"],
            "failed"
        );
    });
}
