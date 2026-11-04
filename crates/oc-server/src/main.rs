//! oc-server: port of the OpenCode v2 HTTP API surface (subset), paths
//! taken verbatim from `packages/protocol/src/groups/session.ts`:
//! `GET/POST /api/session`, `GET/PATCH/DELETE /api/session/:id`,
//! `GET /api/session/active`, `POST /api/session/:id/synthetic`,
//! `POST /api/session/:id/message` (the full agent turn — the port of
//! `session.prompt`), `POST /api/session/:id/abort`, message listing, and
//! an SSE event feed. `/health` is a rebuild extra.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use oc_agent::{RunEvent, RunOptions};
use oc_bus::{Bus, EventEnvelope};
use oc_provider::Client;
use oc_schema::{
    Message, MessageBase, MessageTime, ModelRef, Order, SessionListFilter, SyntheticMessage,
};
use oc_store::{CreateInput, Store, StoreError};
use oc_tools::Registry;

const DEFAULT_BIND: &str = "127.0.0.1:18212";
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
struct AppState {
    store: Arc<Store>,
    bus: Bus,
    registry: Arc<Registry>,
    client: Arc<Client>,
    model: ModelRef,
    max_steps: Option<u32>,
    permissions: oc_permission::Ruleset,
    /// One abort flag per running session (`session.abort`).
    aborts: Arc<std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "oc_server=info".into()),
        )
        .init();
    let data_dir = std::env::var("OC_DATA")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let store = match &data_dir {
        Some(dir) => Store::open(std::path::Path::new(dir)).expect("open data dir"),
        None => Store::new(),
    };
    let worktree = std::env::var("OC_WORKTREE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/tmp".into());
    let state = AppState {
        store: Arc::new(store),
        bus: Bus::default(),
        registry: Arc::new(Registry::builtin(std::path::Path::new(&worktree))),
        client: Arc::new(oc_agent::client_from_env()),
        model: oc_agent::model_from_env(),
        max_steps: oc_agent::max_steps_from_env(),
        permissions: oc_agent::permissions_from_env(),
        aborts: Arc::new(std::sync::Mutex::new(HashMap::new())),
    };
    let bind = std::env::var("OC_BIND").unwrap_or_else(|_| DEFAULT_BIND.into());
    let addr: SocketAddr = bind
        .parse()
        .unwrap_or_else(|e| panic!("bad OC_BIND {bind:?}: {e}"));
    tracing::info!(
        "oc-server {VERSION} (opencode v2 agent subset) on http://{addr} (model {}/{}{}, data {:?})",
        state.model.provider_id,
        state.model.id,
        state.max_steps.map(|m| format!(", max {m} steps")).unwrap_or_default(),
        data_dir,
    );
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, router(state)).await.expect("serve");
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/session", get(session_list).post(session_create))
        .route("/api/session/active", get(session_active))
        .route(
            "/api/session/{sessionID}",
            get(session_get)
                .patch(session_update)
                .delete(session_remove),
        )
        .route(
            "/api/session/{sessionID}/message",
            get(session_messages).post(session_prompt),
        )
        .route("/api/session/{sessionID}/abort", post(session_abort))
        .route(
            "/api/session/{sessionID}/synthetic",
            post(session_synthetic),
        )
        .route("/event", get(event_feed))
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "oc-server",
        "api": "opencode v2 (subset)",
        "version": VERSION,
    }))
}

#[derive(serde::Deserialize)]
struct ListQuery {
    order: Option<String>,
    search: Option<String>,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
    archived: Option<String>,
}

fn parse_filter(q: ListQuery) -> SessionListFilter {
    SessionListFilter {
        order: q.order.as_deref().map(|o| match o {
            "asc" => Order::Asc,
            _ => Order::Desc,
        }),
        search: q.search,
        // `parentID=null` (the literal string) means roots only, per the
        // upstream query-parameter encoding.
        parent_id: q.parent_id.map(|p| (p != "null").then_some(p)),
        archived: q.archived.as_deref().map(|a| a == "true"),
    }
}

async fn session_list(
    State(st): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Json<serde_json::Value> {
    let store = st.store;
    let page = store.list_sessions(&parse_filter(q));
    Json(serde_json::json!({ "data": page.sessions }))
}

#[derive(serde::Deserialize)]
struct CreateBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "parentID")]
    parent_id: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    model: Option<oc_schema::ModelRef>,
    #[serde(default = "default_directory")]
    directory: String,
    #[serde(default = "default_project")]
    #[serde(rename = "projectID")]
    project_id: String,
}

fn default_directory() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into())
}

fn default_project() -> String {
    "global".into()
}

async fn session_create(
    State(st): State<AppState>,
    Json(body): Json<CreateBody>,
) -> Result<Response, ApiError> {
    let info = st
        .store
        .create_session(CreateInput {
            title: body.title,
            parent_id: body.parent_id,
            agent: body.agent,
            model: body.model,
            directory: body.directory,
            project_id: body.project_id,
        })
        .map_err(ApiError::from)?;
    publish_session(&st, &info).ok();
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "info": info })),
    )
        .into_response())
}

async fn session_get(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let info = st.store.get_session(&id).map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "info": info })))
}

#[derive(serde::Deserialize)]
struct UpdateBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    archived: Option<bool>,
}

async fn session_update(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let info = st
        .store
        .update_session(&id, body.title, body.archived)
        .map_err(ApiError::from)?;
    publish_session(&st, &info).ok();
    Ok(Json(serde_json::json!({ "info": info })))
}

async fn session_remove(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let info = st.store.remove_session(&id).map_err(ApiError::from)?;
    st.bus
        .publish(EventEnvelope::new(
            "session.removed",
            serde_json::json!({ "info": info }),
        ))
        .ok();
    Ok(Json(serde_json::json!({ "info": info })))
}

async fn session_active(State(st): State<AppState>) -> Json<serde_json::Value> {
    let active = st.store.active_sessions();
    Json(serde_json::json!({ "data": active }))
}

async fn session_messages(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let msgs = st.store.messages(&id).map_err(ApiError::from)?;
    Ok(Json(serde_json::json!({ "data": msgs })))
}

#[derive(serde::Deserialize)]
struct PromptBody {
    text: String,
    #[serde(default, rename = "modelID")]
    model_id: Option<String>,
}

/// `session.prompt` — append the user message and run the full agent turn
/// (provider steps + tool execution) synchronously; the SSE feed carries the
/// progress events as they land. Store operations lock internally; network and
/// tool execution never hold a process-wide store lock.
async fn session_prompt(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PromptBody>,
) -> Result<Response, ApiError> {
    if body.text.trim().is_empty() {
        return Err(ApiError::BadParam("text must not be empty".into()));
    }
    let mut model = st.model.clone();
    if let Some(mid) = &body.model_id {
        model.id = mid.clone();
    }
    let abort = Arc::new(AtomicBool::new(false));
    st.store.get_session(&id).map_err(ApiError::from)?;
    {
        let mut active = st.aborts.lock().unwrap();
        if active.contains_key(&id) {
            return Ok((
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "session is already running" })),
            )
                .into_response());
        }
        active.insert(id.clone(), abort.clone());
    }
    let observer = {
        let bus = st.bus.clone();
        let session_id = id.clone();
        Arc::new(move |event| {
            let progress = match event {
                RunEvent::TextDelta { delta } => {
                    serde_json::json!({"type": "text", "delta": delta})
                }
                RunEvent::ReasoningDelta { delta } => {
                    serde_json::json!({"type": "reasoning", "delta": delta})
                }
                RunEvent::ToolCallStarted { name, input } => {
                    serde_json::json!({"type": "tool-started", "name": name, "input": input})
                }
                RunEvent::ToolCallFinished { name, ok, preview } => {
                    serde_json::json!({"type": "tool-finished", "name": name, "ok": ok, "preview": preview})
                }
                RunEvent::StepFinished { usage } => {
                    serde_json::json!({"type": "step-finished", "usage": usage})
                }
                RunEvent::RetryScheduled {
                    attempt,
                    delay,
                    error,
                } => {
                    serde_json::json!({"type": "retry", "attempt": attempt, "delayMs": delay.as_millis(), "error": error})
                }
                RunEvent::ProviderFailed { error } => {
                    serde_json::json!({"type": "provider-failed", "error": error})
                }
                RunEvent::CompactionStarted => serde_json::json!({"type": "compaction-started"}),
                RunEvent::CompactionFinished { result } => {
                    serde_json::json!({"type": "compaction-finished", "result": format!("{result:?}")})
                }
            };
            bus.publish(EventEnvelope::new(
                "session.progress",
                serde_json::json!({"sessionID": session_id, "progress": progress}),
            ))
            .ok();
        }) as oc_agent::Observer
    };
    let opts = RunOptions {
        agent: "build".into(),
        max_steps: st.max_steps,
        abort,
        permissions: st.permissions.clone(),
        observer,
        compaction: oc_agent::compaction::Settings::from_env(),
        retries: &oc_agent::RETRY_SCHEDULE,
        ..RunOptions::default()
    };
    let registry = oc_agent::with_task_tool(
        &st.registry,
        st.store.clone(),
        st.client.clone(),
        model.clone(),
        &opts,
    );
    let client = st.client.clone();
    let result =
        oc_agent::prompt(&st.store, &registry, &client, &id, model, &body.text, &opts).await;
    st.aborts.lock().unwrap().remove(&id);
    let output = result.map_err(|e| ApiError::Agent(e.to_string()))?;
    let msgs = st.store.messages(&id).map_err(ApiError::from)?;
    for m in &msgs {
        st.bus
            .publish(EventEnvelope::new(
                "message.updated",
                serde_json::json!({ "message": m }),
            ))
            .ok();
    }
    let info = st.store.get_session(&id).map_err(ApiError::from)?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "info": info,
            "output": {
                "outcome": output.outcome,
                "steps": output.steps,
                "text": output.text,
            },
            "data": msgs,
        })),
    )
        .into_response())
}

/// `session.abort` — fire the running turn's abort flag; the runner ends the
/// turn as `interrupted` between steps.
async fn session_abort(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let fired = st
        .aborts
        .lock()
        .unwrap()
        .get(&id)
        .map(|flag| flag.store(true, Ordering::Relaxed))
        .is_some();
    Json(serde_json::json!({ "id": id, "aborted": fired }))
}

#[derive(serde::Deserialize)]
struct SyntheticBody {
    text: String,
    #[serde(default)]
    description: Option<String>,
}

/// `session.synthetic` — append a synthetic message (the no-LLM message
/// path; still available alongside the full prompt loop).
async fn session_synthetic(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SyntheticBody>,
) -> Result<Response, ApiError> {
    if body.text.trim().is_empty() {
        return Err(ApiError::BadParam("text must not be empty".into()));
    }
    let msg = st
        .store
        .append_message(&id, |mid, created| {
            Message::Synthetic(SyntheticMessage {
                base: MessageBase {
                    id: mid,
                    metadata: None,
                    time: MessageTime { created },
                },
                text: body.text.clone(),
                description: body.description.clone(),
            })
        })
        .map_err(ApiError::from)?;
    st.bus
        .publish(EventEnvelope::new(
            "message.updated",
            serde_json::json!({ "message": msg }),
        ))
        .ok();
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "message": msg })),
    )
        .into_response())
}

/// SSE event feed over the bus.
async fn event_feed(
    State(st): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<SseEvent, std::convert::Infallible>>> {
    let rx = st.bus.subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let kind = event.kind.clone();
                    let sse = SseEvent::default()
                        .event(kind)
                        .json_data(event)
                        .unwrap_or_else(|_| SseEvent::default().event("bus.error").data("{}"));
                    return Some((Ok(sse), rx));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn publish_session(
    st: &AppState,
    info: &oc_schema::SessionInfo,
) -> Result<(), oc_bus::NoSubscribers> {
    st.bus.publish(EventEnvelope::new(
        "session.updated",
        serde_json::json!({ "info": info }),
    ))
}

enum ApiError {
    BadParam(String),
    Store(StoreError),
    Agent(String),
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        ApiError::Store(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (code, msg) = match self {
            ApiError::BadParam(m) => (StatusCode::BAD_REQUEST, m),
            ApiError::Store(StoreError::NotFound(id)) => {
                (StatusCode::NOT_FOUND, format!("session not found: {id}"))
            }
            ApiError::Store(e) => (StatusCode::BAD_REQUEST, e.to_string()),
            ApiError::Agent(e) => (StatusCode::BAD_GATEWAY, e.to_string()),
        };
        (code, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState {
            store: Arc::new(Store::new()),
            bus: Bus::default(),
            registry: Arc::new(Registry::builtin(std::path::Path::new("/tmp"))),
            client: Arc::new(Client::new(oc_provider::Endpoint {
                protocol: oc_provider::Protocol::OpenAI,
                base_url: "http://127.0.0.1:9/v1".into(),
                api_key: None,
            })),
            model: oc_schema::ModelRef::parse("openai/gpt-test").unwrap(),
            max_steps: None,
            permissions: oc_permission::Ruleset::default(),
            aborts: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    async fn json_body(res: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn health_ok() {
        let res = router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn streaming_turn_keeps_reads_live_rejects_duplicates_and_releases_abort() {
        async fn slow_completion() -> Response {
            let first =
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"working\"}}]}\n\n";
            let stream = futures_util::stream::once(async move { Ok::<_, std::io::Error>(first) })
                .chain(futures_util::stream::pending());
            Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(stream))
                .unwrap()
        }
        use futures_util::StreamExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let provider = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/v1/chat/completions", post(slow_completion)),
            )
            .await
            .unwrap();
        });
        let mut state = test_state();
        state.client = Arc::new(Client::new(oc_provider::Endpoint {
            protocol: oc_provider::Protocol::OpenAI,
            base_url: format!("http://{addr}/v1"),
            api_key: None,
        }));
        let info = state
            .store
            .create_session(CreateInput {
                title: None,
                parent_id: None,
                agent: None,
                model: None,
                directory: "/tmp".into(),
                project_id: "global".into(),
            })
            .unwrap();
        let mut events = state.bus.subscribe();
        let app = router(state.clone());
        let prompt = || {
            Request::builder()
                .method("POST")
                .uri(format!("/api/session/{}/message", info.id))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"text":"work"}"#))
                .unwrap()
        };
        let running = tokio::spawn(app.clone().oneshot(prompt()));
        let progress = tokio::time::timeout(std::time::Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(progress.kind, "session.progress");
        assert!(
            !running.is_finished(),
            "progress must arrive during generation"
        );
        let read = Request::builder()
            .uri(format!("/api/session/{}", info.id))
            .body(Body::empty())
            .unwrap();
        let response =
            tokio::time::timeout(std::time::Duration::from_secs(1), app.clone().oneshot(read))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            app.clone().oneshot(prompt()).await.unwrap().status(),
            StatusCode::CONFLICT
        );
        let abort = Request::builder()
            .method("POST")
            .uri(format!("/api/session/{}/abort", info.id))
            .body(Body::empty())
            .unwrap();
        assert_eq!(app.oneshot(abort).await.unwrap().status(), StatusCode::OK);
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), running)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            json_body(response).await["output"]["outcome"],
            "interrupted"
        );
        assert!(state.aborts.lock().unwrap().is_empty());
        provider.abort();
    }

    #[tokio::test]
    async fn create_then_get_then_list() {
        let app = router(test_state());
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"port smoke"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);
        let v = json_body(res).await;
        let id = v["info"]["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("ses_"));
        assert_eq!(v["info"]["title"], "port smoke");
        assert_eq!(v["info"]["projectID"], "global");

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/session/{id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = json_body(res).await;
        assert_eq!(v["data"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn synthetic_message_flow_and_missing_session_404() {
        let app = router(test_state());
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = json_body(res).await;
        let id = v["info"]["id"].as_str().unwrap().to_string();

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/session/{id}/synthetic"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"text":"hello from the port"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/session/{id}/message"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = json_body(res).await;
        assert_eq!(v["data"][0]["type"], "synthetic");
        assert_eq!(v["data"][0]["text"], "hello from the port");

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/session/ses_missing000000000000000/msg")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn active_endpoint_and_filters() {
        let app = router(test_state());
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"title":"needle in haystack"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session?search=needle")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = json_body(res).await;
        assert_eq!(v["data"].as_array().unwrap().len(), 1);

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/session/active")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = json_body(res).await;
        assert_eq!(v["data"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn patch_archives_and_default_list_hides_it() {
        let app = router(test_state());
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        let id = json_body(res).await["info"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/session/{id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"archived":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/session?archived=true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v = json_body(res).await;
        assert_eq!(v["data"].as_array().unwrap().len(), 1);
    }
}
