//! Fixture tests: a Claude Code project on disk, loaded by ClaudeRuntime,
//! driven through the same TurnHooks calls oc-agent makes — and one whole
//! turn through oc-agent's runner with a scripted model.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use oc_agent::hooks::{CompactVerdict, HookDecision, PermissionVerdict, StopContext, StopVerdict, ToolCall, ToolResult, TurnHooks};
use oc_claude::{ClaudeEnv, ClaudeRuntime, LoadOptions};
use serde_json::{json, Value};

struct Fx {
    _dir: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    project: PathBuf,
}

fn write(p: &Path, text: &str) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

fn script(p: &Path, text: &str) {
    write(p, text);
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A small Claude Code project: memory, settings with rules and hooks, a
/// skill, a command, a subagent.
fn project() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let home = root.join("home");
    let project = root.join("proj");
    std::fs::create_dir_all(project.join(".git")).unwrap();
    write(&home.join(".claude/CLAUDE.md"), "Always answer in English.");
    write(&project.join("CLAUDE.md"), "# Project\nUse cargo for builds. See @docs/style.md\n");
    write(&project.join("docs/style.md"), "Four-space indents.");
    write(&project.join("secret.txt"), "TOP SECRET");
    script(
        &project.join(".claude/hooks/no-rm.sh"),
        "#!/bin/sh\ninput=$(cat)\ncase \"$input\" in *'\"command\":\"rm '*) echo \"Blocked: rm commands are not allowed\" >&2; exit 2;; esac\nexit 0\n",
    );
    script(
        &project.join(".claude/hooks/stop.sh"),
        "#!/bin/sh\ninput=$(cat)\ncase \"$input\" in *'\"stop_hook_active\":true'*) exit 0;; esac\necho '{\"decision\":\"block\",\"reason\":\"Run the tests before finishing.\"}'\n",
    );
    write(
        &project.join(".claude/settings.json"),
        &json!({
            "permissions": {
                "allow": ["Bash(cargo test *)"],
                "ask": ["Bash(git push *)"],
                "deny": ["Read(./secret.txt)", "WebFetch"]
            },
            "env": {"OC_CLAUDE_FIXTURE_ENV": "from-settings"},
            "hooks": {
                "PreToolUse": [
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/no-rm.sh"}]},
                    {"matcher": "Write|Edit", "hooks": [{"type": "command", "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"Generated files live in gen/.\"}}'"}]}
                ],
                "PostToolUse": [
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"updatedToolOutput\":{\"stdout\":\"[redacted]\",\"stderr\":\"\"}}}'", "if": "Bash(cat *)"}]}
                ],
                "UserPromptSubmit": [
                    {"hooks": [{"type": "command", "command": "input=$(cat); case \"$input\" in *password*) echo 'no secrets in prompts' >&2; exit 2;; esac; echo 'Current branch: main'"}]}
                ],
                "SessionStart": [
                    {"matcher": "startup", "hooks": [{"type": "command", "command": "echo 'Open issue: #42'"}]}
                ],
                "Stop": [
                    {"hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop.sh"}]}
                ],
                "PreCompact": [
                    {"matcher": "auto", "hooks": [{"type": "command", "command": "echo 'Keep the list of failing tests.'"}]}
                ]
            }
        })
        .to_string(),
    );
    write(&project.join(".claude/settings.local.json"), r#"{"permissions": {"deny": ["Bash(curl *)"]}}"#);
    write(
        &project.join(".claude/skills/release-notes/SKILL.md"),
        "---\nname: release-notes\ndescription: Write release notes from the git log\nallowed-tools: Bash(git log *)\n---\nWrite release notes for $ARGUMENTS.\nRecent: !`echo v1.2.3`\n",
    );
    write(&project.join(".claude/skills/deploy/SKILL.md"), "---\ndescription: Deploy\ndisable-model-invocation: true\n---\nDeploy now.\n");
    write(&project.join(".claude/commands/fix-issue.md"), "---\ndescription: Fix an issue\n---\nFix GitHub issue $ARGUMENTS following our standards.\n");
    write(
        &project.join(".claude/agents/reviewer.md"),
        "---\nname: code-reviewer\ndescription: Reviews code for quality\ntools: Read, Grep, Glob\nmaxTurns: 4\n---\nYou are a careful code reviewer.\n",
    );
    Fx { _dir: dir, root, home, project }
}

fn runtime(fx: &Fx, opts: LoadOptions) -> Arc<ClaudeRuntime> {
    let env = ClaudeEnv::new(&fx.project, &fx.home, &fx.home.join(".claude"), &fx.home.join(".claude.json"), Some(fx.root.join("managed")));
    let notices: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = notices.clone();
    Arc::new(ClaudeRuntime::load(env, &opts).with_notice(Arc::new(move |t: &str| sink.lock().unwrap().push(t.to_string()))))
}

fn call<'a>(name: &'a str, input: &'a Value, wt: &'a Path) -> ToolCall<'a> {
    ToolCall { session_id: "ses_test", call_id: "call_1", name, input, worktree: wt, agent: "build", subagent: false }
}

#[test]
fn memory_settings_and_catalog_load() {
    let fx = project();
    let rt = runtime(&fx, LoadOptions::default());
    assert!(rt.active());
    let text = rt.instructions();
    assert!(text.contains("Always answer in English."));
    assert!(text.contains("Use cargo for builds"));
    assert!(text.contains("Four-space indents."), "@import expanded");
    assert!(text.find("Always answer").unwrap() < text.find("Use cargo").unwrap(), "user before project");
    assert!(rt.catalog.find("release-notes").is_some());
    assert!(rt.catalog.find("fix-issue").unwrap().is_command);
    assert_eq!(rt.agents[0].name, "code-reviewer");
    rt.apply_env();
    assert_eq!(std::env::var("OC_CLAUDE_FIXTURE_ENV").as_deref(), Ok("from-settings"));
}

#[test]
fn permission_rules_and_modes() {
    let fx = project();
    let wt = fx.project.clone();
    let rt = runtime(&fx, LoadOptions::default());
    let v = |name: &str, input: Value| rt.permission(&call(name, &input, &wt));
    assert_eq!(v("shell", json!({"command": "ls -la"})), PermissionVerdict::Allow, "read-only Bash");
    assert_eq!(v("shell", json!({"command": "cargo test --all && git status"})), PermissionVerdict::Allow);
    assert_eq!(v("shell", json!({"command": "git push origin main"})), PermissionVerdict::Ask);
    assert!(matches!(v("shell", json!({"command": "curl https://x"})), PermissionVerdict::Deny(_)), "local settings merge");
    assert!(matches!(v("read", json!({"path": "secret.txt"})), PermissionVerdict::Deny(_)));
    assert!(matches!(v("edit", json!({"path": "secret.txt", "oldString": "a", "newString": "b"})), PermissionVerdict::Deny(_)), "Read deny blocks edits");
    assert_eq!(v("read", json!({"path": "CLAUDE.md"})), PermissionVerdict::Allow, "reads inside the cwd");
    assert_eq!(v("write", json!({"path": "new.txt", "content": "x"})), PermissionVerdict::Pass, "edits ask in default mode");
    assert!(!rt.tool_visible("webfetch"), "bare deny removes the tool");
    assert!(rt.tool_visible("shell"));

    let rt = runtime(&fx, LoadOptions { permission_mode: Some("acceptEdits".into()), ..Default::default() });
    assert_eq!(rt.permission(&call("write", &json!({"path": "new.txt", "content": "x"}), &wt)), PermissionVerdict::Allow);
    assert_eq!(rt.permission(&call("shell", &json!({"command": "mkdir -p out && touch out/a"}), &wt)), PermissionVerdict::Allow);
    let rt = runtime(&fx, LoadOptions { permission_mode: Some("dontAsk".into()), ..Default::default() });
    assert!(matches!(rt.permission(&call("shell", &json!({"command": "git push x"}), &wt)), PermissionVerdict::Deny(_)));
    let rt = runtime(&fx, LoadOptions { permission_mode: Some("bypassPermissions".into()), ..Default::default() });
    assert_eq!(rt.permission(&call("shell", &json!({"command": "make"}), &wt)), PermissionVerdict::Allow);
    assert!(matches!(rt.permission(&call("read", &json!({"path": "secret.txt"}), &wt)), PermissionVerdict::Deny(_)), "deny holds in bypass");
    let rt = runtime(&fx, LoadOptions { disallowed_tools: vec!["Bash(make *)".into()], ..Default::default() });
    assert!(matches!(rt.permission(&call("shell", &json!({"command": "make all"}), &wt)), PermissionVerdict::Deny(_)));
}

#[tokio::test]
async fn pre_tool_hook_blocks_with_stderr_and_adds_context() {
    let fx = project();
    let wt = fx.project.clone();
    let rt = runtime(&fx, LoadOptions::default());
    let input = json!({"command": "rm -rf build"});
    let pre = rt.pre_tool(&call("shell", &input, &wt)).await;
    assert_eq!(pre.decision, Some(HookDecision::Deny));
    let reason = pre.reason.unwrap();
    assert!(reason.starts_with("PreToolUse:Bash hook error:"), "{reason}");
    assert!(reason.ends_with("Blocked: rm commands are not allowed"), "{reason}");
    let input = json!({"command": "ls"});
    assert_eq!(rt.pre_tool(&call("shell", &input, &wt)).await.decision, None);
    let input = json!({"path": "a.txt", "content": "x"});
    let pre = rt.pre_tool(&call("write", &input, &wt)).await;
    assert_eq!(pre.context, vec!["Generated files live in gen/.".to_string()]);
}

#[tokio::test]
async fn post_tool_if_filter_and_updated_output() {
    let fx = project();
    let wt = fx.project.clone();
    let rt = runtime(&fx, LoadOptions::default());
    let input = json!({"command": "cat secret.txt"});
    let post = rt.post_tool(&call("shell", &input, &wt), ToolResult::Ok("TOP SECRET"), 3).await;
    assert_eq!(post.replace_output.as_deref(), Some("[redacted]"));
    let input = json!({"command": "ls"});
    let post = rt.post_tool(&call("shell", &input, &wt), ToolResult::Ok("a b"), 3).await;
    assert_eq!(post.replace_output, None, "`if: Bash(cat *)` skips other commands");
}

#[tokio::test]
async fn prompt_session_stop_and_compact_hooks() {
    let fx = project();
    let wt = fx.project.clone();
    let rt = runtime(&fx, LoadOptions::default());
    rt.session_start("ses_test", "startup", None).await;
    assert!(rt.instructions().contains("Open issue: #42"));
    let blocked = rt.user_prompt_submit("ses_test", "my password is hunter2").await.unwrap_err();
    assert!(blocked.starts_with("no secrets in prompts"), "{blocked}");
    let notes = rt.user_prompt_submit("ses_test", "fix the bug").await.unwrap();
    assert!(notes[0].contains("Current branch: main"));
    let ctx = StopContext { session_id: "ses_test", worktree: &wt, agent: "build", subagent: false, last_text: Some("done"), stop_hook_active: false };
    match rt.stop(&ctx).await {
        StopVerdict::Continue(reason) => assert!(reason.contains("Run the tests before finishing.")),
        other => panic!("{other:?}"),
    }
    let ctx = StopContext { stop_hook_active: true, ..ctx };
    assert_eq!(rt.stop(&ctx).await, StopVerdict::Stop);
    assert_eq!(rt.pre_compact("ses_test", &wt, "auto").await, CompactVerdict::Proceed(Some("Keep the list of failing tests.\n".into())));
}

#[tokio::test]
async fn slash_commands_and_skills() {
    let fx = project();
    let rt = runtime(&fx, LoadOptions::default());
    let text = rt.expand_slash("ses_test", "/fix-issue 123").await.unwrap().unwrap();
    assert_eq!(text.trim(), "Fix GitHub issue 123 following our standards.");
    assert_eq!(rt.expand_slash("ses_test", "/unknown x").await.unwrap(), None);
    let text = rt.expand_slash("ses_test", "/release-notes v2").await.unwrap().unwrap();
    assert!(text.contains("Write release notes for v2.") && text.contains("Recent: v1.2.3"), "{text}");
    // allowed-tools grants Bash(git log *) for the turn, then a new prompt clears it
    let wt = fx.project.clone();
    let input = json!({"command": "git log --format=%s | head -5 > notes.txt"});
    assert_eq!(rt.permission(&call("shell", &input, &wt)), PermissionVerdict::Pass);
    let input = json!({"command": "git log -n 5 --stat"});
    assert_eq!(rt.permission(&call("shell", &input, &wt)), PermissionVerdict::Allow);
    // the model's skill tool
    let tool = rt.skill_tool().expect("skills are listed");
    let def = tool.def();
    assert!(def.description.contains("release-notes: Write release notes"));
    assert!(!def.description.contains("- deploy"), "disable-model-invocation hides it");
    let ctx = oc_tools::ToolContext { worktree: fx.project.clone(), session_id: "ses_test".into(), call_id: "c".into() };
    let err = tool.execute(&json!({"skill": "deploy"}), &ctx).await.unwrap_err();
    assert!(err.to_string().contains("can only be run by the user"));
    let out = tool.execute(&json!({"skill": "release-notes", "args": "v3"}), &ctx).await.unwrap();
    let oc_schema::ToolContent::Text { text } = &out.content[0] else { panic!() };
    assert!(text.contains("release notes for v3"));
}

#[test]
fn subagent_profiles() {
    let fx = project();
    let rt = runtime(&fx, LoadOptions::default());
    let registry: Vec<String> = ["shell", "read", "write", "edit", "glob", "grep"].iter().map(|s| s.to_string()).collect();
    let profiles = rt.agent_profiles(&registry, "openai");
    assert_eq!(profiles.len(), 1);
    let p = &profiles[0];
    assert_eq!(p.name, "code-reviewer");
    assert_eq!(p.tools.as_deref(), Some(&["read".to_string(), "grep".into(), "glob".into()][..]));
    assert_eq!(p.max_steps, Some(4));
    assert_eq!(p.prompt.as_deref(), Some("You are a careful code reviewer."));
}

// ===== one whole turn through the runner =====

struct Scripted(Mutex<std::collections::VecDeque<Value>>);

#[async_trait]
impl oc_provider::Transport for Scripted {
    async fn post_json(&self, _url: &str, _headers: Vec<(String, String)>, _body: Value) -> Result<Value, oc_provider::ProviderError> {
        self.0
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| oc_provider::ProviderError::Malformed("unexpected provider request".into()))
    }
}

fn tool_call(id: &str, name: &str, args: Value) -> Value {
    json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{
        "id": id, "type": "function", "function": {"name": name, "arguments": args.to_string()}}]},"finish_reason":"tool_calls"}]})
}

fn answer(text: &str) -> Value {
    json!({"choices":[{"message":{"role":"assistant","content":text},"finish_reason":"stop"}]})
}

#[tokio::test]
async fn whole_turn_hooks_rules_and_stop_hook() {
    let fx = project();
    write(&fx.project.join("victim.txt"), "keep me");
    let rt = runtime(&fx, LoadOptions::default());
    let store = Arc::new(oc_store::Store::new());
    let session = store
        .create_session(oc_store::CreateInput {
            title: None,
            parent_id: None,
            agent: Some("build".into()),
            model: None,
            directory: fx.project.to_string_lossy().into_owned(),
            project_id: "global".into(),
        })
        .unwrap()
        .id;
    let transport = Arc::new(Scripted(Mutex::new(
        vec![
            tool_call("c1", "shell", json!({"command": "rm victim.txt"})),
            tool_call("c2", "read", json!({"path": "secret.txt"})),
            answer("Done."),
            // the Stop hook sends the model back once
            tool_call("c3", "shell", json!({"command": "echo tests pass"})),
            answer("Tests pass."),
        ]
        .into(),
    )));
    let client = oc_provider::Client::with_transport(
        oc_provider::Endpoint { protocol: oc_provider::Protocol::OpenAI, base_url: "http://mock/v1".into(), api_key: None },
        transport.clone(),
    );
    let mut opts = oc_agent::RunOptions {
        permissions: oc_agent::default_build_permissions(),
        ..oc_agent::RunOptions::default()
    };
    opts.hooks = Some(rt.clone() as Arc<dyn TurnHooks>);
    opts.instructions = Some(Arc::new(rt.instructions()));
    let registry = oc_tools::Registry::builtin(&fx.project);
    let out = oc_agent::prompt(&store, &registry, &client, &session, oc_schema::ModelRef::parse("openai/test").unwrap(), "clean up", &opts)
        .await
        .unwrap();
    assert_eq!(out.outcome, oc_schema::Outcome::Succeeded);
    assert_eq!(out.text.as_deref(), Some("Tests pass."));
    assert_eq!(std::fs::read_to_string(fx.project.join("victim.txt")).unwrap(), "keep me", "the hook blocked rm");
    let errors: Vec<String> = store
        .messages(&session)
        .unwrap()
        .iter()
        .filter_map(|m| match m {
            oc_schema::Message::Assistant(a) => Some(a.content.clone()),
            _ => None,
        })
        .flatten()
        .filter_map(|c| match c {
            oc_schema::AssistantContent::Tool(t) => match t.state {
                oc_schema::ToolState::Error { error, .. } => Some(format!("{}: {}", t.name, error.message.unwrap_or_default())),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert!(errors[0].contains("Blocked: rm commands are not allowed"), "{errors:?}");
    assert!(errors[1].contains("denied by the rule Read(./secret.txt)"), "{errors:?}");
    let synthetic = store
        .messages(&session)
        .unwrap()
        .iter()
        .any(|m| matches!(m, oc_schema::Message::Synthetic(s) if s.text.contains("Run the tests before finishing.")));
    assert!(synthetic, "the stop hook's reason went back to the model");
    assert!(transport.0.lock().unwrap().is_empty());
}
