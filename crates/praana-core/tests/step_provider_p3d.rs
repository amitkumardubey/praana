//! P3D (issue #405): bind `HeadlessLoop::StepProvider` to the P2B OpenAI
//! Chat/Responses + OpenRouter Chat adapters via `turn::provider`.
//!
//! Local fake HTTP servers only. No real keys, no public network.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use praana_core::clock::SystemClock;
use praana_core::config::{build_defaults, EffectiveConfigV1};
use praana_core::credentials::store::{
    credentials_path, save_store, upsert_credential, CredentialStoreV1,
};
use praana_core::id::MonotonicUlidGenerator;
use praana_core::protocol::events::InterruptionReason;
use praana_core::provider::{
    catalog_cache_path, endpoint_fingerprint, CATALOG_CACHE_SCHEMA_VERSION,
};
use praana_core::turn::provider::OpenAiStepProvider;
use praana_core::turn::{
    AcceptedStepSink, HeadlessLoop, LoopConfig, LoopFault, PrepareContext, StepProvider, TurnReport,
};

const BUNDLED_OPENAI_MODEL: &str = "gpt-5.6-sol";

fn fixtures_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/rust-v2/providers/v1")
}

fn fixture(relative: &str) -> String {
    std::fs::read_to_string(fixtures_root().join(relative))
        .unwrap_or_else(|error| panic!("fixture {relative}: {error}"))
}

// ---------------------------------------------------------------------------
// Fake HTTP server
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct RecordedRequest {
    path: String,
    headers: String,
    body: String,
}

struct FakeServer {
    addr: std::net::SocketAddr,
    hits: Arc<AtomicUsize>,
    recorded: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl FakeServer {
    fn base_url(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    fn request(&self, index: usize) -> RecordedRequest {
        self.recorded.lock().unwrap()[index].clone()
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

fn read_request(stream: &mut TcpStream) -> RecordedRequest {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut tmp).unwrap_or(0);
        if n == 0 {
            break None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(split) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            break Some(split);
        }
    };
    let Some(split) = header_end else {
        return RecordedRequest {
            path: String::new(),
            headers: String::new(),
            body: String::new(),
        };
    };
    let headers = String::from_utf8_lossy(&buf[..split]).to_string();
    let length = headers
        .lines()
        .find_map(|line| {
            line.split_once(':').and_then(|(name, value)| {
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
            })
        })
        .flatten()
        .unwrap_or(0);
    while buf.len() < split + 4 + length {
        let n = stream.read(&mut tmp).unwrap_or(0);
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let path = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default()
        .to_owned();
    let body = String::from_utf8_lossy(&buf[split + 4..]).to_string();
    RecordedRequest {
        path,
        headers,
        body,
    }
}

fn sse_response(status: u16, body: &str, extra_headers: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n{extra_headers}\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn spawn_server<F>(responder: F) -> FakeServer
where
    F: Fn(usize, &RecordedRequest, &FakeServer) -> Vec<u8> + Send + Sync + 'static,
{
    spawn_server_inner(responder, Duration::ZERO)
}

/// Like [`spawn_server`], but the connection is held open for `hold` after the
/// response is written (for cancellation-during-stream tests).
fn spawn_holding_server<F>(responder: F, hold: Duration) -> FakeServer
where
    F: Fn(usize, &RecordedRequest, &FakeServer) -> Vec<u8> + Send + Sync + 'static,
{
    spawn_server_inner(responder, hold)
}

fn spawn_server_inner<F>(responder: F, hold: Duration) -> FakeServer
where
    F: Fn(usize, &RecordedRequest, &FakeServer) -> Vec<u8> + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake server");
    let addr = listener.local_addr().expect("local addr");
    let hits = Arc::new(AtomicUsize::new(0));
    let recorded: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let server = FakeServer {
        addr,
        hits: hits.clone(),
        recorded: recorded.clone(),
    };
    let server_view = FakeServer {
        addr,
        hits: hits.clone(),
        recorded: recorded.clone(),
    };
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let index = hits.fetch_add(1, Ordering::SeqCst);
            let request = read_request(&mut stream);
            recorded.lock().unwrap().push(request);
            let request = recorded.lock().unwrap()[index].clone();
            let response = responder(index, &request, &server_view);
            let _ = stream.write_all(&response);
            let _ = stream.flush();
            if !hold.is_zero() {
                std::thread::sleep(hold);
            }
        }
    });
    server
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn write_credentials(home: &Path, provider: &str, value: &str) {
    let mut store = CredentialStoreV1::empty();
    upsert_credential(&mut store, provider, value.to_owned(), 1_700_000_000_000)
        .expect("upsert credential");
    save_store(&credentials_path(home), &store).expect("save credentials");
}

struct RecordingSink {
    slot: Arc<Mutex<Vec<String>>>,
}

impl AcceptedStepSink for RecordingSink {
    fn on_accepted_text(&mut self, text: &str) {
        self.slot.lock().unwrap().push(text.to_owned());
    }
}

fn recording_sink() -> (RecordingSink, Arc<Mutex<Vec<String>>>) {
    let slot = Arc::new(Mutex::new(Vec::new()));
    (RecordingSink { slot: slot.clone() }, slot)
}

fn openai_config(home: &Path, base_url: &str) -> EffectiveConfigV1 {
    let mut config = build_defaults(home);
    config.llm.provider = "openai".into();
    config.llm.protocol = "openai-responses-v1".into();
    config.llm.model = BUNDLED_OPENAI_MODEL.into();
    config.llm.min_output_tokens = 16;
    config.llm.max_output_tokens = 256;
    config.providers.openai.base_url = base_url.to_owned();
    config.turn.max_steps = 6;
    config.turn.max_attempts = 3;
    config.tools.shell_enabled = true;
    config
}

fn loop_config(config: EffectiveConfigV1, session: &Path, workspace: &Path) -> LoopConfig {
    LoopConfig {
        session_dir: session.to_path_buf(),
        workspace: workspace.to_path_buf(),
        config,
        clock: Arc::new(SystemClock),
        ids: Arc::new(MonotonicUlidGenerator::system()),
        fault: LoopFault::None,
    }
}

fn read_events(session_dir: &Path) -> Vec<Value> {
    let text = std::fs::read_to_string(session_dir.join("events.jsonl")).unwrap_or_default();
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("event json"))
        .collect()
}

fn event_kinds(session_dir: &Path) -> Vec<String> {
    read_events(session_dir)
        .iter()
        .filter_map(|event| {
            event
                .pointer("/event/kind")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn events_of_kind<'a>(events: &'a [Value], kind: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|event| event.pointer("/event/kind").and_then(Value::as_str) == Some(kind))
        .collect()
}

fn diagnostic_json(report: &TurnReport) -> Value {
    let diagnostic = report
        .diagnostic
        .as_ref()
        .expect("expected a diagnostic on the turn report");
    serde_json::to_value(diagnostic).expect("serialize protocol error")
}

async fn until<F: Fn() -> bool>(check: F, what: &str) {
    for _ in 0..300 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

fn assert_admission_preceded_send(session_dir: &Path, request: &RecordedRequest) {
    let attempt_started = events_of_kind(&read_events(session_dir), "assistant_attempt_started")
        .iter()
        .any(|event| {
            let hash = event
                .pointer("/event/data/request_hash")
                .and_then(Value::as_str);
            let body: Value = serde_json::from_str(&request.body).expect("request body json");
            let sent_hash =
                praana_core::protocol::hashes::calculate_request_hash(&body).expect("hash body");
            hash == Some(sent_hash.as_str())
        });
    assert!(
        attempt_started,
        "durable assistant_attempt_started must precede every send (kinds: {:?})",
        event_kinds(session_dir)
    );
}

// ---------------------------------------------------------------------------
// Profile resolution (P2A rules, no network fetch)
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn make_home_private(home: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(not(unix))]
fn make_home_private(_home: &Path) {}

#[test]
fn openrouter_trusted_cache_resolves_profile_without_network() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    let official = "https://openrouter.ai/api/v1";
    let fingerprint = endpoint_fingerprint(official).unwrap();
    let cache = json!({
        "schema_version": CATALOG_CACHE_SCHEMA_VERSION,
        "provider": "openrouter",
        "endpoint_fingerprint": fingerprint,
        "fetched_at_ms": 1_700_000_000_000i64,
        "expires_at_ms": 1_900_000_000_000i64,
        "etag": Value::Null,
        "body_sha256": endpoint_fingerprint("https://cache.example/body").unwrap(),
        "models": [{
            "provider": "openrouter",
            "model_id": "mystery-model-xyz",
            "display_name": "Mystery",
            "context_length": 900_000u64,
            "max_completion_tokens": 4_096u64,
            "supported_parameters": ["tools"],
            "reasoning_efforts": [],
        }],
    });
    std::fs::create_dir_all(home.join("cache")).unwrap();
    std::fs::write(
        catalog_cache_path(&home),
        serde_json::to_string_pretty(&cache).unwrap(),
    )
    .unwrap();

    let mut config = build_defaults(&home);
    config.llm.provider = "openrouter".into();
    config.llm.protocol = "openai-chat-v1".into();
    config.llm.model = "mystery-model-xyz".into();
    config.llm.context_window = 0;

    let provider =
        OpenAiStepProvider::new(&config, &home, temp.path()).expect("provider constructs");
    let prepared = provider
        .prepare_admitted(
            0,
            &PrepareContext {
                input: "hello",
                notices: Vec::new(),
            },
        )
        .expect("prepare resolves from trusted cache");
    let profile = prepared.profile.expect("cache-backed profile");
    assert_eq!(profile.context_window_tokens, 900_000);
    let expected_max = config.llm.max_output_tokens.min(900_000 - 1);
    assert_eq!(profile.max_output_tokens, expected_max);
    assert!(profile.catalog_cache_sha256.is_some(), "trusted cache hash");
    let expected = endpoint_fingerprint(official).unwrap();
    assert_eq!(
        serde_json::to_value(profile.endpoint_fingerprint).unwrap(),
        serde_json::to_value(expected).unwrap(),
        "profile fingerprint follows the configured (official) endpoint"
    );
}

#[test]
fn custom_endpoint_ignores_untrusted_cache_but_uses_configured_window() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir_all(home.join("cache")).unwrap();
    // Cache written for the official endpoint; configured endpoint is local.
    let cache = json!({
        "schema_version": CATALOG_CACHE_SCHEMA_VERSION,
        "provider": "openrouter",
        "endpoint_fingerprint": endpoint_fingerprint("https://openrouter.ai/api/v1").unwrap(),
        "fetched_at_ms": 1_700_000_000_000i64,
        "expires_at_ms": 1_900_000_000_000i64,
        "etag": Value::Null,
        "body_sha256": endpoint_fingerprint("https://cache.example/body").unwrap(),
        "models": [{
            "provider": "openrouter",
            "model_id": "mystery-model-xyz",
            "display_name": "Mystery",
            "context_length": 900_000u64,
            "max_completion_tokens": 4_096u64,
            "supported_parameters": ["tools"],
            "reasoning_efforts": [],
        }],
    });
    std::fs::write(
        catalog_cache_path(&home),
        serde_json::to_string_pretty(&cache).unwrap(),
    )
    .unwrap();

    let mut config = build_defaults(&home);
    config.llm.provider = "openrouter".into();
    config.llm.protocol = "openai-chat-v1".into();
    config.llm.model = "mystery-model-xyz".into();
    config.llm.context_window = 50_000;
    config.llm.max_output_tokens = 2_048;
    config.providers.openrouter.base_url = "http://127.0.0.1:9/v1".into();

    let provider =
        OpenAiStepProvider::new(&config, &home, temp.path()).expect("provider constructs");
    let prepared = provider
        .prepare_admitted(
            0,
            &PrepareContext {
                input: "hello",
                notices: Vec::new(),
            },
        )
        .expect("prepare falls back to configured window");
    let profile = prepared.profile.expect("row-backed untrusted profile");
    assert_eq!(
        profile.context_window_tokens, 50_000,
        "untrusted row window must not leak; configured window wins"
    );
    assert!(
        profile.catalog_cache_sha256.is_none(),
        "untrusted cache carries no catalog_cache_sha256"
    );
}

#[test]
fn unknown_model_without_cache_falls_back_to_configured_window() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    let mut config = build_defaults(&home);
    config.llm.provider = "openai".into();
    config.llm.protocol = "openai-responses-v1".into();
    config.llm.model = "totally-unknown-model".into();
    config.llm.context_window = 128_000;
    config.llm.min_output_tokens = 16;
    config.llm.max_output_tokens = 256;
    config.turn.max_steps = 4;
    config.turn.max_attempts = 3;

    let provider =
        OpenAiStepProvider::new(&config, &home, temp.path()).expect("provider constructs");
    let prepared = provider
        .prepare_admitted(
            0,
            &PrepareContext {
                input: "hello",
                notices: Vec::new(),
            },
        )
        .expect("prepare with configured-window fallback");
    assert!(
        prepared.profile.is_none(),
        "unknown model without cache resolves to the legacy no-profile path"
    );
}

// ---------------------------------------------------------------------------
// Full-loop lifecycle against a local fake server
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bundled_profile_exact_body_durable_admission_then_send_and_commit() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(move |_index, _request, _server| {
        let body = fixture("openai-responses/streams/text-completed.sse");
        sse_response(200, &body, "retry-after-ms: 0\r\n")
    });

    let config = openai_config(&home, &server.base_url());
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");
    let (mut sink, accepted) = recording_sink();

    let report = loop_
        .run_turn_with_sink("hello p3d please respond", &provider, &mut sink)
        .await
        .expect("turn commits");
    assert!(report.interruption.is_none(), "committed turn");
    assert!(report.diagnostic.is_none(), "no diagnostic on success");
    assert_eq!(accepted.lock().unwrap().as_slice(), ["ready"]);

    assert_eq!(server.hits(), 1, "exactly one send");
    let request = server.request(0);
    assert!(
        request.path.ends_with("/v1/responses"),
        "responses endpoint, got {}",
        request.path
    );
    let headers = request.headers.to_ascii_lowercase();
    assert!(
        headers.contains("authorization: bearer p3d-secret-key"),
        "credential rides the authorization header only"
    );
    assert!(
        !request.body.contains("p3d-secret-key"),
        "credential must never appear in the request body"
    );
    assert_admission_preceded_send(&session, &request);

    let body: Value = serde_json::from_str(&request.body).expect("request body json");
    assert_eq!(body.get("stream"), Some(&Value::Bool(true)));
    assert_eq!(
        body.get("model").and_then(Value::as_str),
        Some(BUNDLED_OPENAI_MODEL)
    );
    let flat = body.to_string();
    assert!(
        flat.contains("hello p3d please respond"),
        "input reaches the body"
    );
    assert!(!flat.is_empty());

    let events = read_events(&session);
    let started = events_of_kind(&events, "assistant_attempt_started");
    assert_eq!(started.len(), 1);
    let model = started[0]["event"]["data"]["model"].clone();
    let expected = endpoint_fingerprint(&server.base_url()).unwrap();
    assert_eq!(
        model.get("endpoint_fingerprint"),
        Some(&serde_json::to_value(expected).unwrap()),
        "model selection carries the configured endpoint fingerprint"
    );
    let request_hash = started[0]["event"]["data"]["request_hash"].clone();
    let sent_hash = praana_core::protocol::hashes::calculate_request_hash(&body).unwrap();
    assert_eq!(request_hash, serde_json::to_value(sent_hash).unwrap());

    let kinds = event_kinds(&session);
    assert!(kinds.contains(&"session_started".to_string()));
    assert!(kinds.contains(&"user_message_accepted".to_string()));
    assert!(kinds.contains(&"turn_started".to_string()));
    assert!(kinds.contains(&"assistant_step_accepted".to_string()));
    assert!(kinds.contains(&"turn_committed".to_string()));
    assert!(!kinds.contains(&"turn_interrupted".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_model_without_window_fails_admission_before_any_send() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server =
        spawn_server(|_index, _request, _server| sse_response(200, "data: [DONE]\n\n", ""));

    let mut config = openai_config(&home, &server.base_url());
    config.llm.model = "totally-unknown-model".into();
    config.llm.context_window = 0;
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let report = loop_
        .run_turn("hello", &provider)
        .await
        .expect("turn yields a report, not a hard error");
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ProviderFailure)
    );
    let diagnostic = diagnostic_json(&report);
    assert_eq!(
        diagnostic.get("code"),
        Some(&json!("E_ADMISSION_CONTEXT_WINDOW_UNKNOWN"))
    );
    assert_eq!(diagnostic.get("class"), Some(&json!("validation")));

    assert_eq!(server.hits(), 0, "no send before a durable attempt start");
    let kinds = event_kinds(&session);
    assert!(!kinds.contains(&"assistant_attempt_started".to_string()));
    assert!(kinds.contains(&"turn_interrupted".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_request_rejects_with_active_turn_too_large_and_no_send() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server =
        spawn_server(|_index, _request, _server| sse_response(200, "data: [DONE]\n\n", ""));

    let mut config = openai_config(&home, &server.base_url());
    config.llm.context_window = 1_000;
    config.llm.max_output_tokens = 64;
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let huge = "p".repeat(12_000);
    let report = loop_
        .run_turn(&huge, &provider)
        .await
        .expect("turn yields a report");
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ActiveTurnTooLarge)
    );
    let diagnostic = diagnostic_json(&report);
    assert_eq!(
        diagnostic.get("code"),
        Some(&json!("E_ACTIVE_TURN_TOO_LARGE"))
    );
    assert_eq!(diagnostic.get("class"), Some(&json!("context_length")));

    assert_eq!(server.hits(), 0, "rejected admission never sends");
    let kinds = event_kinds(&session);
    assert!(!kinds.contains(&"assistant_attempt_started".to_string()));
    assert!(kinds.contains(&"turn_interrupted".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_credential_fails_closed_with_auth_diagnostic_and_zero_sends() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    // Deliberately no credentials.json and no provider env fallback.

    let server =
        spawn_server(|_index, _request, _server| sse_response(200, "data: [DONE]\n\n", ""));

    let mut config = build_defaults(&home);
    config.llm.provider = "openrouter".into();
    config.llm.protocol = "openai-chat-v1".into();
    config.llm.model = BUNDLED_OPENAI_MODEL.into();
    config.llm.context_window = 128_000;
    config.llm.min_output_tokens = 16;
    config.llm.max_output_tokens = 256;
    config.turn.max_steps = 4;
    config.turn.max_attempts = 3;
    config.providers.openrouter.base_url = server.base_url();
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let report = loop_
        .run_turn("hello", &provider)
        .await
        .expect("turn yields a report");
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ProviderFailure)
    );
    let diagnostic = diagnostic_json(&report);
    assert_eq!(diagnostic.get("code"), Some(&json!("E_PROVIDER_AUTH")));
    assert_eq!(diagnostic.get("class"), Some(&json!("authentication")));

    assert_eq!(server.hits(), 0, "zero HTTP sends without a credential");
    let events = read_events(&session);
    assert_eq!(
        events_of_kind(&events, "assistant_attempt_started").len(),
        1,
        "credential resolves after one durable attempt start"
    );
    let failed = events_of_kind(&events, "assistant_attempt_failed");
    assert_eq!(failed.len(), 1, "exactly one failed authentication attempt");
    assert_eq!(
        failed[0]["event"]["data"]["error"]["code"],
        json!("E_PROVIDER_AUTH")
    );
    assert_eq!(
        events_of_kind(&events, "turn_interrupted").len(),
        1,
        "one provider-failure interruption"
    );
    assert!(!event_kinds(&session).contains(&"assistant_step_accepted".to_string()));
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pre_emission_server_error_retries_with_fresh_attempt_ids_and_retry_of() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(|index, _request, _server| {
        if index == 0 {
            sse_response(
                500,
                "{\"error\":{\"message\":\"boom\"}}",
                "retry-after-ms: 0\r\n",
            )
        } else {
            let body = fixture("openai-responses/streams/text-completed.sse");
            sse_response(200, &body, "")
        }
    });

    let config = openai_config(&home, &server.base_url());
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let report = loop_
        .run_turn("hello", &provider)
        .await
        .expect("turn commits");
    assert!(report.interruption.is_none(), "retry recovers to a commit");
    assert_eq!(server.hits(), 2, "one retry only, budget respected");

    let events = read_events(&session);
    let started = events_of_kind(&events, "assistant_attempt_started");
    assert_eq!(started.len(), 2);
    let first_id = started[0]["attempt_id"].clone();
    let second_id = started[1]["attempt_id"].clone();
    assert_ne!(first_id, second_id, "every retry gets a fresh attempt id");
    assert_eq!(started[0]["event"]["data"]["retry_of"], Value::Null);
    assert_eq!(
        started[1]["event"]["data"]["retry_of"], first_id,
        "second attempt records retry_of the first"
    );
    assert_eq!(
        events_of_kind(&events, "assistant_attempt_failed").len(),
        1,
        "the pre-emission failure is durable before the retry"
    );
    assert_eq!(events_of_kind(&events, "turn_committed").len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_emission_disconnect_never_retries() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let partial = fixture("openai-chat/streams/disconnect-after-text.sse");
    let server = spawn_server(move |_index, _request, _server| sse_response(200, &partial, ""));

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let report = loop_.run_turn("hello", &provider).await.expect("report");
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ProviderFailure)
    );
    assert_eq!(
        server.hits(),
        1,
        "post-emission failure must not retry or resend"
    );

    let events = read_events(&session);
    assert_eq!(
        events_of_kind(&events, "assistant_attempt_started").len(),
        1
    );
    let failed = events_of_kind(&events, "assistant_attempt_failed");
    assert_eq!(failed.len(), 1);
    assert_eq!(
        failed[0]["event"]["data"]["observable_delta_emitted"],
        json!(true),
        "emission barrier is recorded on the failed attempt"
    );
    assert!(!event_kinds(&session).contains(&"assistant_step_accepted".to_string()));
    assert!(event_kinds(&session).contains(&"turn_interrupted".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retry_budget_exhaustion_stops_with_last_diagnostic() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(|_index, _request, _server| {
        sse_response(
            500,
            "{\"error\":{\"message\":\"always down\"}}",
            "retry-after-ms: 0\r\n",
        )
    });

    let config = openai_config(&home, &server.base_url());
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let report = loop_.run_turn("hello", &provider).await.expect("report");
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ProviderFailure)
    );
    let diagnostic = diagnostic_json(&report);
    assert_eq!(diagnostic.get("code"), Some(&json!("E_PROVIDER_STREAM")));
    assert_eq!(diagnostic.get("class"), Some(&json!("transport")));

    assert_eq!(server.hits(), 3, "bounded by turn.max_attempts");
    let events = read_events(&session);
    assert_eq!(
        events_of_kind(&events, "assistant_attempt_started").len(),
        3
    );
    assert_eq!(events_of_kind(&events, "assistant_attempt_failed").len(), 3);
}

// ---------------------------------------------------------------------------
// Multi-step tool cycle, streaming sink, resume, cancellation
// ---------------------------------------------------------------------------

fn chat_text_then_tool_body() -> String {
    concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"running it now.\\n\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_p3d_1\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":\\\"echo p3d-tool-ok\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_owned()
}

fn chat_final_text_body(text: &str) -> String {
    format!(
        "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{text}\"}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n"
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn multi_step_shell_tool_cycle_commits_in_order() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(|index, _request, _server| {
        let body = if index == 0 {
            chat_text_then_tool_body()
        } else {
            chat_final_text_body("cycle complete")
        };
        sse_response(200, &body, "")
    });

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");
    let (mut sink, accepted) = recording_sink();

    let report = loop_
        .run_turn_with_sink("run echo", &provider, &mut sink)
        .await
        .expect("turn commits");
    assert!(report.interruption.is_none());
    assert_eq!(server.hits(), 2, "tool cycle sends exactly twice");

    let events = read_events(&session);
    assert_eq!(events_of_kind(&events, "assistant_step_accepted").len(), 2);
    assert_eq!(events_of_kind(&events, "tool_execution_started").len(), 1);
    assert_eq!(events_of_kind(&events, "tool_execution_finished").len(), 1);
    assert_eq!(events_of_kind(&events, "tool_batch_completed").len(), 1);
    assert_eq!(events_of_kind(&events, "turn_committed").len(), 1);
    assert_eq!(
        accepted.lock().unwrap().as_slice(),
        ["running it now.\n", "cycle complete"],
        "accepted text streams in block order"
    );

    let request_two = server.request(1);
    assert!(
        request_two.body.contains("p3d-tool-ok"),
        "tool result feeds the next step"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_text_reaches_sink_while_later_step_is_still_pending() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let gate = Arc::new((Mutex::new(false), Condvar::new()));
    let gate_view = gate.clone();
    let server = spawn_server(move |index, _request, _server| {
        let body = if index == 0 {
            chat_text_then_tool_body()
        } else {
            // Block the second send until the test has observed step one text.
            let (lock, cvar) = &*gate_view;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = cvar.wait(released).unwrap();
            }
            chat_final_text_body("second step text")
        };
        sse_response(200, &body, "")
    });

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");
    let (mut sink, accepted) = recording_sink();

    let handle = tokio::spawn(async move {
        let report = loop_
            .run_turn_with_sink("run echo", &provider, &mut sink)
            .await;
        (report, loop_.session_dir().to_path_buf())
    });

    until(
        || !accepted.lock().unwrap().is_empty(),
        "first accepted text on the sink while step two is pending",
    )
    .await;
    assert_eq!(
        accepted.lock().unwrap().as_slice(),
        ["running it now.\n"],
        "first block published at acceptance time, before the second step completes"
    );
    {
        let (lock, cvar) = &*gate;
        *lock.lock().unwrap() = true;
        cvar.notify_all();
    }

    let (report, _) = handle.await.expect("join run");
    let report = report.expect("turn commits");
    assert!(report.interruption.is_none());
    assert_eq!(
        accepted.lock().unwrap().as_slice(),
        ["running it now.\n", "second step text"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_never_replays_previously_accepted_text() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(move |index, _request, _server| {
        let body = if index == 0 {
            chat_final_text_body("first session text")
        } else {
            chat_final_text_body("fresh text after resume")
        };
        sse_response(200, &body, "")
    });

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config.clone(), &session, &workspace)).expect("create");
    let (mut sink_one, accepted_one) = recording_sink();
    let report = loop_
        .run_turn_with_sink("first turn", &provider, &mut sink_one)
        .await
        .expect("first turn commits");
    assert!(report.interruption.is_none());
    assert_eq!(
        accepted_one.lock().unwrap().as_slice(),
        ["first session text"]
    );
    drop(loop_);

    let mut resumed = HeadlessLoop::resume(loop_config(config, &session, &workspace))
        .expect("resume the session");
    let (mut sink_two, accepted_two) = recording_sink();
    let report = resumed
        .run_turn_with_sink("second turn", &provider, &mut sink_two)
        .await
        .expect("second turn commits");
    assert!(report.interruption.is_none());
    assert_eq!(
        accepted_two.lock().unwrap().as_slice(),
        ["fresh text after resume"],
        "only newly accepted blocks reach the sink; no replay"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_during_stream_never_accepts_partial_text() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    // First delta arrives, then the body never completes: the client must
    // cancel mid-stream without accepting the partial text.
    let server = spawn_holding_server(
        |_index, _request, _server| {
            let first = "data: {\"choices\":[{\"delta\":{\"content\":\"partial text\"},\"finish_reason\":null}]}\n\n";
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 10000000\r\nconnection: close\r\n\r\n{first}"
            )
            .into_bytes()
        },
        Duration::from_secs(60),
    );

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");
    let token = loop_.cancellation_token();
    let (mut sink, accepted) = recording_sink();

    let handle = tokio::spawn(async move {
        let report = loop_
            .run_turn_with_sink("hello", &provider, &mut sink)
            .await;
        (report, loop_.session_dir().to_path_buf())
    });

    until(|| server.hits() == 1, "the provider send to land").await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    token.cancel();
    let (report, session_dir) = handle.await.expect("join run");
    let report = report.expect("report");
    assert_eq!(report.interruption, Some(InterruptionReason::UserAbort));
    assert!(
        accepted.lock().unwrap().is_empty(),
        "no partial text is ever accepted or published"
    );
    assert_eq!(server.hits(), 1);
    let events = read_events(&session_dir);
    assert!(!event_kinds(&session_dir).contains(&"assistant_step_accepted".to_string()));
    let failed = events_of_kind(&events, "assistant_attempt_failed");
    assert_eq!(failed.len(), 1, "cancelled attempt fails durably");
    assert_eq!(
        failed[0]["event"]["data"]["observable_delta_emitted"],
        json!(true),
        "streamed delta was observable; retry stays forbidden after cancel"
    );
    assert!(event_kinds(&session_dir).contains(&"turn_interrupted".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refusal_stream_is_carried_as_an_ordered_block() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let refusal = fixture("openai-chat/streams/refusal.sse");
    let server = spawn_server(move |_index, _request, _server| sse_response(200, &refusal, ""));

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let report = loop_
        .run_turn("do something disallowed", &provider)
        .await
        .expect("report");
    assert!(
        report.interruption.is_none(),
        "refusal commits as its own step"
    );

    let events = read_events(&session);
    let accepted = events_of_kind(&events, "assistant_step_accepted");
    assert_eq!(accepted.len(), 1);
    let message = &accepted[0]["event"]["data"]["message"];
    let blocks = message["blocks"].as_array().expect("blocks array");
    assert_eq!(blocks.len(), 1, "single refusal block");
    let rendered = blocks[0].to_string();
    assert!(
        rendered.contains("\"refusal\"") && rendered.contains("no"),
        "ordered refusal block survives the seam, got {rendered}"
    );
}
