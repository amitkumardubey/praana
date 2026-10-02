//! P3D (issue #624): bind `HeadlessLoop::StepProvider` to the P2B OpenAI
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
                state_tail: "",
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
                state_tail: "",
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
                state_tail: "",
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

// ---------------------------------------------------------------------------
// F1: no raw provider body in events, stdout or stderr
// ---------------------------------------------------------------------------

/// A provider error body that echoes the configured credential and the
/// Authorization header. Nothing derived from it may reach durable events.
fn secret_echo_body() -> String {
    "{\"error\":{\"message\":\"invalid api key p3d-secret-key\",\
      \"echo\":{\"authorization\":\"Bearer p3d-secret-key\"}},\
      \"request\":{\"model\":\"gpt-5.6-sol\"}}"
        .to_owned()
}

fn assert_secret_absent_from_session(session: &Path, canary: &str, events: &[Value]) {
    assert!(
        event_kinds(session).contains(&"assistant_attempt_failed".to_string()),
        "the attempt still fails durably: {:?}",
        event_kinds(session)
    );
    let failed = events_of_kind(events, "assistant_attempt_failed");
    let recorded = failed[0].to_string();
    assert!(
        !recorded.contains(canary),
        "the credential echo must never be durable: {recorded}"
    );
    let log = std::fs::read_to_string(session.join("events.jsonl")).unwrap_or_default();
    assert!(
        !log.contains(canary),
        "the credential echo must never reach events.jsonl"
    );
    for name in ["meta.json", "config.snapshot.json"] {
        let path = session.join(name);
        if path.exists() {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            assert!(!text.contains(canary), "{name} must not carry the echo");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unauthorized_echoing_the_credential_never_reaches_events() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let body = secret_echo_body();
    let server = spawn_server(move |_index, _request, _server| {
        sse_response(401, &body, "retry-after-ms: 0\r\n")
    });

    let config = openai_config(&home, &server.base_url());
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
    assert_eq!(diagnostic.get("http_status"), Some(&json!(401)));
    assert!(
        !diagnostic.to_string().contains("p3d-secret-key"),
        "the diagnostic carries no provider body: {diagnostic}"
    );
    // A 401 is not retryable, so exactly one send.
    assert_eq!(server.hits(), 1);
    assert_secret_absent_from_session(&session, "p3d-secret-key", &read_events(&session));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_error_echoing_the_credential_retries_without_persisting_it() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let body = secret_echo_body();
    let server = spawn_server(move |_index, _request, _server| {
        sse_response(500, &body, "retry-after-ms: 0\r\n")
    });

    let config = openai_config(&home, &server.base_url());
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
    assert_eq!(diagnostic.get("code"), Some(&json!("E_PROVIDER_STREAM")));
    assert_eq!(diagnostic.get("class"), Some(&json!("transport")));
    assert_eq!(
        diagnostic.get("message"),
        Some(&json!("provider responded with HTTP 500")),
        "HTTP failures persist a fixed safe message, never the body"
    );
    assert_eq!(server.hits(), 3, "retries are unaffected by redaction");
    assert_secret_absent_from_session(&session, "p3d-secret-key", &read_events(&session));
}

// ---------------------------------------------------------------------------
// F2: Responses phase, reasoning summaries, emission barrier
// ---------------------------------------------------------------------------

/// A minimal Responses stream carrying a single `response.output_text.delta`
/// and a terminal `response.completed`.
fn responses_text_completed(text: &str) -> String {
    format!(
        "event: response.created\n\
         data: {{\"type\":\"response.created\",\"response\":{{\"id\":\"resp_t\",\"model\":\"gpt-5.6-sol\"}}}}\n\n\
         event: response.output_text.delta\n\
         data: {{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"{text}\"}}\n\n\
         event: response.completed\n\
         data: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_t\",\"status\":\"completed\",\"output\":[],\"usage\":{{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}}}}\n\n"
    )
}

/// A Responses stream with `phase: "final_answer"` and a reasoning item with
/// encrypted content.
fn responses_phase_reasoning() -> String {
    concat!(
        "event: response.output_item.added\n",
        "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_01\"}}\n\n",
        "event: response.reasoning_summary_text.delta\n",
        "data: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"delta\":\"Checked the two files.\"}\n\n",
        "event: response.reasoning_summary_text.done\n",
        "data: {\"type\":\"response.reasoning_summary_text.done\",\"output_index\":0,\"text\":\"Checked the two files.\"}\n\n",
        "event: response.output_item.done\n",
        "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_01\",\"encrypted_content\":\"opaque-ciphertext\"}}\n\n",
        "event: response.output_item.added\n",
        "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"message\",\"id\":\"msg_01\",\"phase\":\"final_answer\"}}\n\n",
        "event: response.output_text.delta\n",
        "data: {\"type\":\"response.output_text.delta\",\"output_index\":1,\"delta\":\"the answer\"}\n\n",
        "event: response.output_item.done\n",
        "data: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"type\":\"message\",\"id\":\"msg_01\",\"phase\":\"final_answer\"}}\n\n",
        "event: response.completed\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_phase\",\"status\":\"completed\",\"output\":[{\"type\":\"reasoning\",\"id\":\"rs_01\"},{\"type\":\"message\",\"id\":\"msg_01\",\"phase\":\"final_answer\"}]}}\n\n"
    )
    .to_owned()
}

fn json_types(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .map(|item| item["type"].as_str().unwrap_or("?").to_owned())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn responses_phase_and_reasoning_summary_replay_in_order() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(move |_index, _request, _server| {
        sse_response(200, &responses_phase_reasoning(), "")
    });

    let config = openai_config(&home, &server.base_url());
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");
    let (mut sink, accepted) = recording_sink();

    let report = loop_
        .run_turn_with_sink("first turn", &provider, &mut sink)
        .await
        .expect("turn commits");
    assert!(report.interruption.is_none(), "the turn commits");

    let events = read_events(&session);
    let steps = events_of_kind(&events, "assistant_step_accepted");
    assert_eq!(steps.len(), 1);

    // The parsed Responses phase survives onto the accepted message.
    assert_eq!(
        steps[0]["event"]["data"]["message"]["phase"],
        json!("final_answer"),
        "the parsed Responses phase reaches the accepted message"
    );

    // The reasoning summary is an ordered block ahead of the visible text.
    let blocks = steps[0]["event"]["data"]["message"]["blocks"]
        .as_array()
        .expect("blocks array");
    let block_kinds = json_types(blocks);
    assert_eq!(
        block_kinds,
        ["reasoning_summary", "text"],
        "the reasoning summary precedes the visible text: {blocks:?}"
    );
    assert_eq!(blocks[0]["data"]["text"], json!("Checked the two files."));
    assert_eq!(
        accepted.lock().unwrap().as_slice(),
        ["the answer"],
        "only user-visible text reaches the sink"
    );

    // The continuation keeps the provider output order, phase included.
    let continuation = &steps[0]["event"]["data"]["message"]["continuation"]["data"];
    let items = continuation["output_items"]
        .as_array()
        .expect("output items");
    assert_eq!(
        json_types(items),
        ["reasoning", "message"],
        "the continuation preserves the provider output order: {items:?}"
    );
    assert_eq!(
        items[1]["data"]["phase"],
        json!("final_answer"),
        "the continuation item carries the phase too: {items:?}"
    );

    // The next turn replays the accepted assistant message in order, with its
    // phase, before the new user input. (Responses continuation replay of the
    // provider's own output items is P2B's tool-cycle path, which this packet
    // does not drive; the ordering of those items is asserted above.)
    let (mut sink_two, _) = recording_sink();
    loop_
        .run_turn_with_sink("second turn", &provider, &mut sink_two)
        .await
        .expect("second turn commits");
    assert_eq!(server.hits(), 2, "one send per turn");
    let second: Value = serde_json::from_str(&server.request(1).body).expect("second body");
    let replayed = second["input"].as_array().expect("input array");
    assert_eq!(
        json_types(replayed),
        ["message", "message", "message"],
        "history replays in order, then the new user input: {replayed:?}"
    );
    assert_eq!(
        replayed[1]["phase"],
        json!("final_answer"),
        "the replayed assistant message keeps its phase: {replayed:?}"
    );
    assert_eq!(
        replayed[1]["content"][0]["text"],
        json!("the answer"),
        "the accepted text replays unchanged: {replayed:?}"
    );
    assert_eq!(replayed[2]["content"][0]["text"], json!("second turn"));
}

/// A Responses tool start with no argument deltas and no terminal event.
fn responses_disconnect_after_tool_start() -> String {
    concat!(
        "event: response.created\n",
        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_cut\",\"model\":\"gpt-5.6-sol\"}}\n\n",
        "event: response.output_item.added\n",
        "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_cut\",\"name\":\"shell\",\"arguments\":\"\"}}\n\n"
    )
    .to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn responses_tool_start_before_arguments_is_never_retried() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let partial = responses_disconnect_after_tool_start();
    let server = spawn_server(move |_index, _request, _server| sse_response(200, &partial, ""));

    let config = openai_config(&home, &server.base_url());
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
        "a tool start crosses the emission barrier, so no retry is scheduled"
    );

    let events = read_events(&session);
    assert_eq!(
        events_of_kind(&events, "assistant_attempt_started").len(),
        1,
        "exactly one attempt"
    );
    let failed = events_of_kind(&events, "assistant_attempt_failed");
    assert_eq!(failed.len(), 1);
    assert_eq!(
        failed[0]["event"]["data"]["observable_delta_emitted"],
        json!(false),
        "a tool start is emission but not an observable delta"
    );
    assert!(!event_kinds(&session).contains(&"assistant_step_accepted".to_string()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn responses_refusal_only_failure_records_no_observable_delta() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    // A refusal delta followed by a disconnect: the barrier is crossed but no
    // user-visible text was emitted.
    let partial = concat!(
        "event: response.refusal.delta\n",
        "data: {\"type\":\"response.refusal.delta\",\"output_index\":0,\"delta\":\"no\"}\n\n"
    )
    .to_owned();
    let server = spawn_server(move |_index, _request, _server| sse_response(200, &partial, ""));

    let config = openai_config(&home, &server.base_url());
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let report = loop_
        .run_turn("do something disallowed", &provider)
        .await
        .expect("report");
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ProviderFailure)
    );
    assert_eq!(server.hits(), 1, "a refusal still forbids retry");

    let events = read_events(&session);
    let failed = events_of_kind(&events, "assistant_attempt_failed");
    assert_eq!(failed.len(), 1);
    assert_eq!(
        failed[0]["event"]["data"]["observable_delta_emitted"],
        json!(false),
        "a refusal is not an observable delta"
    );
    // A refusal has no partial-output form (it is only ever accepted whole),
    // so the durable record claims no text block.
    let blocks = failed[0]["event"]["data"]["partial_output"]["blocks"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        !json_types(&blocks).contains(&"text".to_owned()),
        "no text block is claimed for a refusal-only failure: {blocks:?}"
    );
}

// ---------------------------------------------------------------------------
// F3: project context discovery and provenance
// ---------------------------------------------------------------------------

const AGENTS_CANARY: &str = "PRJ-CANARY-ALPHA";

fn write_project_agents(workspace: &Path, body: &str) {
    std::fs::write(workspace.join("AGENTS.md"), body).expect("write project AGENTS.md");
}

fn creation_provenance(session: &Path) -> String {
    let text = std::fs::read_to_string(session.join("meta.json")).expect("meta.json");
    let value: Value = serde_json::from_str(text.trim_end_matches('\n')).expect("meta json");
    value["project_context_source_sha256"]
        .as_str()
        .expect("creation provenance digest")
        .to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_agents_bytes_reach_the_request_and_the_creation_digest() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_project_agents(
        &workspace,
        &format!("# Project\n\nAlways answer with {AGENTS_CANARY}.\n"),
    );
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(move |_index, _request, _server| {
        sse_response(200, &responses_text_completed("ok"), "")
    });

    let config = openai_config(&home, &server.base_url());
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ = HeadlessLoop::create_with_project_context(
        loop_config(config, &session, &workspace),
        Some(provider.project_context().clone()),
    )
    .expect("loop create");
    let report = loop_
        .run_turn("hello", &provider)
        .await
        .expect("turn commits");
    assert!(report.interruption.is_none());

    let body: Value = serde_json::from_str(&server.request(0).body).expect("request body");
    let instructions = body["instructions"].as_str().expect("instructions");
    assert!(
        instructions.contains(AGENTS_CANARY),
        "the discovered project instructions reach the request"
    );

    let expected = praana_core::system_context::load::project_context_source_sha256(
        &provider.project_context().all_sources,
    );
    assert_eq!(
        creation_provenance(&session),
        expected.as_str(),
        "meta.json records the digest of the sources the request was built from"
    );
    assert_ne!(
        creation_provenance(&session),
        praana_core::history::event_log::EMPTY_PROJECT_CONTEXT_SOURCE_SHA256,
        "the empty-provenance digest is never recorded when sources exist"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_reports_project_context_change_without_source_text() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_project_agents(&workspace, "# Project\n\nFirst version.\n");
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(move |_index, _request, _server| {
        sse_response(200, &responses_text_completed("ok"), "")
    });

    let config = openai_config(&home, &server.base_url());
    let first = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ = HeadlessLoop::create_with_project_context(
        loop_config(config.clone(), &session, &workspace),
        Some(first.project_context().clone()),
    )
    .expect("loop create");
    loop_
        .run_turn("first", &first)
        .await
        .expect("first turn commits");
    drop(loop_);
    let creation_digest = creation_provenance(&session);

    // The project instruction file changes between create and resume.
    write_project_agents(&workspace, "# Project\n\nSecond version.\n");
    let resumed_provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let resumed = HeadlessLoop::resume_with_project_context(
        loop_config(config, &session, &workspace),
        Some(resumed_provider.project_context().clone()),
    )
    .expect("resume");
    assert!(
        resumed.project_context_changed_since_create(),
        "a changed project context is reported on resume"
    );
    assert_eq!(
        creation_provenance(&session),
        creation_digest,
        "resume never rewrites the creation provenance"
    );
}

// ---------------------------------------------------------------------------
// F4: the uploaded bytes are the admitted bytes
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uploaded_bytes_equal_the_canonical_admitted_body() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(move |_index, _request, _server| {
        sse_response(200, &responses_text_completed("uploaded bytes"), "")
    });

    let config = openai_config(&home, &server.base_url());
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");
    loop_
        .run_turn("hello", &provider)
        .await
        .expect("turn commits");

    let request = server.request(0);
    let sent: Value = serde_json::from_str(&request.body).expect("request body json");
    let canonical = praana_core::protocol::json::serialize_canonical(&sent).expect("canonical");
    assert_eq!(
        request.body.as_bytes(),
        canonical.as_slice(),
        "the raw upload is byte-for-byte the canonical admitted body"
    );

    // The durable request hash covers exactly those bytes.
    let events = read_events(&session);
    let started = events_of_kind(&events, "assistant_attempt_started");
    let durable_hash = praana_core::protocol::hashes::calculate_request_hash(&sent).unwrap();
    assert_eq!(
        started[0]["event"]["data"]["request_hash"],
        serde_json::to_value(durable_hash).unwrap()
    );

    // The upload is canonical regardless of what a value-level serializer
    // would have produced: the same value re-serialized and rehashed always
    // authorizes, and a byte-level mutation never does (covered by the
    // in-crate `admitted_bytes_*` unit tests).
    let rehash = praana_core::protocol::hashes::calculate_request_hash(&sent).unwrap();
    assert_eq!(
        rehash.as_str(),
        started[0]["event"]["data"]["request_hash"]
            .as_str()
            .unwrap_or(""),
        "the durable hash is reproducible from the uploaded value"
    );
}

// ---------------------------------------------------------------------------
// Review "unverified" list: headless risk deny/allow, step limit
// ---------------------------------------------------------------------------

/// A Chat tool-call body for `shell` running `command`. `call_id` must be
/// unique per send: a reused provider call id is a protocol violation.
fn chat_shell_call_body(call_id: &str, command: &str) -> String {
    format!(
        "data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":[{{\"index\":0,\"id\":\"{call_id}\",\"function\":{{\"name\":\"shell\",\"arguments\":\"{{\\\"command\\\":\\\"{command}\\\"}}\"}}}}]}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn headless_risk_class_is_denied_without_allow() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    // `rm -rf` carries the `rm` risk fact.
    let server = spawn_server(move |index, _request, _server| {
        let call_id = format!("call_risk_{index}");
        sse_response(200, &chat_shell_call_body(&call_id, "rm -rf target"), "")
    });

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    // The server keeps asking for the call, so the step budget ends the turn.
    let _report = loop_.run_turn("clean up", &provider).await.expect("report");
    let events = read_events(&session);
    let finished = events_of_kind(&events, "tool_execution_finished");
    assert!(!finished.is_empty(), "the call is classified durably");
    for record in &finished {
        assert_eq!(
            record["event"]["data"]["result"]["status"],
            json!("blocked"),
            "a denied confirm-tier class is blocked, not run: {record}"
        );
        let result = record["event"]["data"]["result"].to_string();
        assert!(
            result.contains("TOOL_RISK_HEADLESS_DENIED"),
            "headless denies a confirm-tier class unless it is allowed: {result}"
        );
    }
    assert!(
        !target_marker(&workspace).exists(),
        "the denied command never ran"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn headless_risk_class_runs_when_allowed() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(workspace.join("target")).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(move |index, _request, _server| {
        let body = if index == 0 {
            chat_shell_call_body("call_risk_1", "rm -rf target")
        } else {
            chat_final_text_body("cleaned")
        };
        sse_response(200, &body, "")
    });

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    config.risk.allow = vec!["rm".to_owned()];
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let report = loop_.run_turn("clean up", &provider).await.expect("report");
    assert!(
        report.interruption.is_none(),
        "an allowed class runs and the turn commits: {:?} {:?}",
        report.interruption,
        report.diagnostic
    );
    let events = read_events(&session);
    let finished = events_of_kind(&events, "tool_execution_finished");
    assert_eq!(finished.len(), 1);
    assert_eq!(
        finished[0]["event"]["data"]["result"]["status"],
        json!("success"),
        "the allowed class ran to completion: {}",
        finished[0]
    );
    assert!(
        !finished[0]["event"]["data"]["result"]
            .to_string()
            .contains("TOOL_RISK"),
        "no policy error for an allowed class: {}",
        finished[0]
    );
    assert!(
        !target_marker(&workspace).exists(),
        "the allowed command really removed the marker"
    );
}

fn target_marker(workspace: &Path) -> PathBuf {
    workspace.join("target")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn step_limit_interrupts_with_the_step_limit_reason() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    // Every response asks for another tool call, so the step budget runs out.
    let server = spawn_server(move |index, _request, _server| {
        let call_id = format!("call_step_{index}");
        sse_response(200, &chat_shell_call_body(&call_id, "echo p3d-step"), "")
    });

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    config.turn.max_steps = 2;
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let report = loop_
        .run_turn("loop forever", &provider)
        .await
        .expect("report");
    assert_eq!(report.interruption, Some(InterruptionReason::StepLimit));
    assert_eq!(server.hits(), 2, "the step budget bounds the sends");

    let events = read_events(&session);
    assert_eq!(
        events_of_kind(&events, "assistant_step_accepted").len(),
        2,
        "each budgeted step is accepted durably"
    );
    let interrupted = events_of_kind(&events, "turn_interrupted");
    assert_eq!(interrupted.len(), 1);
    assert_eq!(
        interrupted[0]["event"]["data"]["reason"],
        json!("step_limit"),
        "the interruption reason is durable: {}",
        interrupted[0]
    );
    assert!(
        !event_kinds(&session).contains(&"turn_committed".to_string()),
        "a step-limited turn never commits"
    );
}

// ---------------------------------------------------------------------------
// F7: admission arithmetic underflow is an accounting error, not a reject
// ---------------------------------------------------------------------------

/// The safety margin is capped at `window / 10`, so a window of 1000 leaves
/// 100 for the margin. An output reserve of 950 does not fit in the remaining
/// 900 and `W - Rout - Rreason - Margin` underflows, which Compaction §4.1
/// classifies as `ADMISSION_ARITHMETIC_OVERFLOW`, not a context reject. A
/// regression that mapped underflow back to `E_ACTIVE_TURN_TOO_LARGE` would
/// otherwise stay green.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reserve_larger_than_the_window_is_an_admission_accounting_error() {
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
    // Smallest config-valid window; the requested output reserve alone exceeds
    // it, so admission underflows before any estimate is compared.
    config.llm.context_window = 1_000;
    config.llm.max_output_tokens = 950;
    config.llm.min_output_tokens = 16;
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");

    let report = loop_.run_turn("hello", &provider).await.expect("report");
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ProviderFailure),
        "an accounting error is not a context-length reject: {:?}",
        report.diagnostic
    );
    let diagnostic = diagnostic_json(&report);
    assert_eq!(
        diagnostic.get("code"),
        Some(&json!("E_ADMISSION_ACCOUNTING")),
        "underflow is E_ADMISSION_ACCOUNTING: {diagnostic}"
    );
    assert_eq!(diagnostic.get("class"), Some(&json!("internal")));

    assert_eq!(server.hits(), 0, "an accounting error never sends");
    let kinds = event_kinds(&session);
    assert!(
        !kinds.contains(&"assistant_attempt_started".to_string()),
        "the underflow is detected before the durable attempt start: {kinds:?}"
    );
    assert!(kinds.contains(&"turn_interrupted".to_string()));
}

struct InstrumentedStepProvider<P> {
    inner: P,
    prepares: AtomicUsize,
    seen_tails: std::sync::Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl<P: StepProvider> StepProvider for InstrumentedStepProvider<P> {
    fn prepare(
        &self,
        step_index: u32,
    ) -> Result<praana_core::turn::PreparedRequest, praana_core::turn::TurnError> {
        self.inner.prepare(step_index)
    }

    async fn complete(
        &self,
        step_index: u32,
        admitted: &praana_core::turn::AdmittedRequest,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<praana_core::turn::ProviderOutput, praana_core::turn::TurnError> {
        self.inner.complete(step_index, admitted, cancel).await
    }

    fn prepare_admitted(
        &self,
        step_index: u32,
        ctx: &PrepareContext<'_>,
    ) -> Result<praana_core::turn::PreparedStep, praana_core::turn::TurnError> {
        self.prepares.fetch_add(1, Ordering::SeqCst);
        self.seen_tails
            .lock()
            .unwrap()
            .push(ctx.state_tail.to_string());
        self.inner.prepare_admitted(step_index, ctx)
    }

    async fn complete_step(
        &self,
        step_index: u32,
        admitted: &praana_core::turn::AdmittedRequest,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<praana_core::turn::StepOutcome, praana_core::turn::TurnError> {
        self.inner.complete_step(step_index, admitted, cancel).await
    }

    fn bind_session(&self, session_dir: &Path) {
        self.inner.bind_session(session_dir);
    }

    fn set_output_reserve(&self, tokens: u64) {
        self.inner.set_output_reserve(tokens);
    }

    fn clear_output_reserve(&self) {
        self.inner.clear_output_reserve();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn state_mutation_in_step_n_appears_in_step_n_plus_one_and_retry_re_renders() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(|index, _request, _server| match index {
        0 => {
            let body = concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"creating task\\n\"},\"finish_reason\":null}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_step0_task\",\"function\":{\"name\":\"create_task\",\"arguments\":\"{\\\"title\\\":\\\"mutated_in_step_0\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                    "data: [DONE]\n\n"
                );
            sse_response(200, body, "")
        }
        1 => sse_response(
            500,
            "{\"error\":{\"message\":\"transient error\"}}",
            "retry-after-ms: 0\r\n",
        ),
        _ => sse_response(200, &chat_final_text_body("step 1 complete"), ""),
    });

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    let provider = InstrumentedStepProvider {
        inner: OpenAiStepProvider::new(&config, &home, &workspace).expect("provider"),
        prepares: AtomicUsize::new(0),
        seen_tails: std::sync::Mutex::new(Vec::new()),
    };
    let mut loop_ =
        HeadlessLoop::create(loop_config(config, &session, &workspace)).expect("loop create");
    let (mut sink, _) = recording_sink();

    let report = loop_
        .run_turn_with_sink("test mutation across steps", &provider, &mut sink)
        .await
        .expect("turn commits");
    assert!(report.interruption.is_none());
    assert_eq!(
        server.hits(),
        3,
        "step 0 send, step 1 send (500), step 1 retry send (200)"
    );
    assert_eq!(
        provider.prepares.load(Ordering::SeqCst),
        3,
        "step 0 prepare, step 1 attempt 0 prepare, step 1 attempt 1 retry prepare"
    );

    let tails = provider.seen_tails.lock().unwrap().clone();
    assert_eq!(tails.len(), 3);
    assert!(
        !tails[0].contains("mutated_in_step_0"),
        "step 0 prepare tail does not contain mutated task"
    );
    assert!(
        tails[1].contains("mutated_in_step_0"),
        "step 1 attempt 0 prepare tail contains mutated task"
    );
    assert_eq!(
        tails[1], tails[2],
        "step 1 retry prepare re-renders the exact same mutated tail"
    );

    let req_step0 = server.request(0);
    let val_step0: Value = serde_json::from_str(&req_step0.body).unwrap();
    let sys_step0 = val_step0["messages"][0]["content"].as_str().unwrap();
    assert!(
        !sys_step0.contains("mutated_in_step_0"),
        "step 0 request instruction does not yet have mutated task"
    );

    let req_step1_attempt0 = server.request(1);
    let val_step1_att0: Value = serde_json::from_str(&req_step1_attempt0.body).unwrap();
    let sys_step1_att0 = val_step1_att0["messages"][0]["content"].as_str().unwrap();
    assert!(
        sys_step1_att0.contains("mutated_in_step_0"),
        "step 1 attempt 0 request instruction includes the mutated state tail"
    );

    let req_step1_attempt1 = server.request(2);
    let val_step1_att1: Value = serde_json::from_str(&req_step1_attempt1.body).unwrap();
    let sys_step1_att1 = val_step1_att1["messages"][0]["content"].as_str().unwrap();
    assert!(
        sys_step1_att1.contains("mutated_in_step_0"),
        "step 1 retry request instruction includes the mutated state tail"
    );
    assert_eq!(
        sys_step1_att0, sys_step1_att1,
        "step 1 retry re-renders the identical instruction body"
    );

    // Also verify unit level prepare_admitted offset correctness with normative tail
    let tail_v0 = include_str!("fixtures/state_graph_v1/tail_empty.txt");
    let prep0 = provider
        .inner
        .prepare_admitted(
            0,
            &PrepareContext {
                input: "test",
                notices: Vec::new(),
                state_tail: tail_v0,
            },
        )
        .unwrap();
    let offset0 = prep0.state_tail_offset.expect("offset is Some");
    let content = prep0.request.request_body["messages"][0]["content"]
        .as_str()
        .unwrap();
    assert_eq!(
        &content.as_bytes()[offset0..offset0 + tail_v0.len()],
        tail_v0.as_bytes()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runtime_facts_session_id_matches_authoritative_session_on_create_and_resume() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let session = temp.path().join("session");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    write_credentials(&home, "openai", "p3d-secret-key");

    let server = spawn_server(|_index, _request, _server| {
        sse_response(200, &chat_final_text_body("turn complete"), "")
    });

    let mut config = openai_config(&home, &server.base_url());
    config.llm.protocol = "openai-chat-v1".into();
    let provider = OpenAiStepProvider::new(&config, &home, &workspace).expect("provider");

    // 1. Create turn
    let mut loop_create = HeadlessLoop::create(loop_config(config.clone(), &session, &workspace))
        .expect("loop create");
    let report_create = loop_create
        .run_turn("turn 1", &provider)
        .await
        .expect("turn 1");
    assert!(report_create.interruption.is_none());
    assert_eq!(server.hits(), 1);

    // Read meta.json to get actual session_id
    let meta_text = std::fs::read_to_string(session.join("meta.json")).unwrap();
    let meta_json: Value = serde_json::from_str(&meta_text).unwrap();
    let actual_session_id = meta_json["session_id"].as_str().unwrap();
    assert!(!actual_session_id.is_empty());
    assert_ne!(
        actual_session_id, "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "actual session id is not placeholder"
    );

    let req0 = server.request(0);
    let val0: Value = serde_json::from_str(&req0.body).unwrap();
    let sys0 = val0["messages"][0]["content"].as_str().unwrap();
    assert!(
        sys0.contains(&format!("- session_id: {actual_session_id}")),
        "turn 1 request contains actual session_id in runtime facts: {sys0}"
    );
    assert!(
        !sys0.contains("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        "turn 1 request must never contain placeholder session_id"
    );

    // Drop loop_create to release session lock before resume
    drop(loop_create);

    // 2. Resume turn
    let mut loop_resume =
        HeadlessLoop::resume(loop_config(config, &session, &workspace)).expect("loop resume");
    let report_resume = loop_resume
        .run_turn("turn 2", &provider)
        .await
        .expect("turn 2");
    assert!(report_resume.interruption.is_none());
    assert_eq!(server.hits(), 2);

    let req1 = server.request(1);
    let val1: Value = serde_json::from_str(&req1.body).unwrap();
    let sys1 = val1["messages"][0]["content"].as_str().unwrap();
    assert!(
        sys1.contains(&format!("- session_id: {actual_session_id}")),
        "turn 2 (resumed) request contains actual session_id in runtime facts: {sys1}"
    );
    assert!(
        !sys1.contains("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        "turn 2 request must never contain placeholder session_id"
    );
}
