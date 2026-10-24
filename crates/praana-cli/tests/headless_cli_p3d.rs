//! P3D (issue #624): headless `praana run` / `praana resume` process contract —
//! grammar, stdout/stderr split, exit statuses, resume ID placement, signals,
//! and Windows fail-closed smoke.
//!
//! Local fake HTTP servers only. No real keys, no public network.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use praana_core::credentials::store::{
    credentials_path, save_store, upsert_credential, CredentialStoreV1,
};

// ---------------------------------------------------------------------------
// Fake HTTP server (std threads; the CLI under test is a separate process)
// ---------------------------------------------------------------------------

struct FakeServer {
    addr: std::net::SocketAddr,
    hits: Arc<AtomicUsize>,
    recorded: Arc<Mutex<Vec<String>>>,
}

impl FakeServer {
    fn base_url(&self) -> String {
        format!("http://{}/v1", self.addr)
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> String {
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
        return String::new();
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
    String::from_utf8_lossy(&buf).to_string()
}

fn sse_response(status: u16, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn spawn_server<F>(responder: F) -> FakeServer
where
    F: Fn(usize) -> Vec<u8> + Send + Sync + 'static,
{
    spawn_server_inner(responder, Duration::ZERO)
}

/// Like [`spawn_server`], but the connection stays open for `hold` after the
/// response is written (for cancellation-during-stream tests).
fn spawn_holding_server<F>(responder: F, hold: Duration) -> FakeServer
where
    F: Fn(usize) -> Vec<u8> + Send + Sync + 'static,
{
    spawn_server_inner(responder, hold)
}

fn spawn_server_inner<F>(responder: F, hold: Duration) -> FakeServer
where
    F: Fn(usize) -> Vec<u8> + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake server");
    let addr = listener.local_addr().expect("local addr");
    let hits = Arc::new(AtomicUsize::new(0));
    let recorded: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let hits_view = hits.clone();
    let recorded_view = recorded.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let index = hits_view.fetch_add(1, Ordering::SeqCst);
            let request = read_request(&mut stream);
            recorded_view.lock().unwrap().push(request);
            let response = responder(index);
            let _ = stream.write_all(&response);
            let _ = stream.flush();
            if !hold.is_zero() {
                std::thread::sleep(hold);
            }
        }
    });
    FakeServer {
        addr,
        hits,
        recorded,
    }
}

fn chat_text_body(text: &str) -> String {
    format!(
        "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{text}\"}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n"
    )
}

fn chat_text_then_tool_body() -> String {
    concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"alpha\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_cli_1\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":\\\"echo cli-ok\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n"
    )
    .to_owned()
}

fn chat_final_body(text: &str) -> String {
    chat_text_body(text)
}

fn responses_text_body(text: &str) -> String {
    format!(
        "event: response.created\ndata: {{\"type\":\"response.created\",\"response\":{{\"id\":\"resp_p3d\",\"model\":\"gpt-5.6-sol\"}}}}\n\nevent: response.output_text.delta\ndata: {{\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"{text}\"}}\n\nevent: response.output_text.done\ndata: {{\"type\":\"response.output_text.done\",\"output_index\":0,\"text\":\"{text}\"}}\n\nevent: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"resp_p3d\",\"status\":\"completed\",\"output\":[],\"usage\":{{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}}}}\n\n"
    )
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

struct CliEnv {
    home: PathBuf,
    workspace: PathBuf,
    config: PathBuf,
}

fn write_credentials(home: &Path, provider: &str, value: &str) {
    let mut store = CredentialStoreV1::empty();
    upsert_credential(&mut store, provider, value.to_owned(), 1_700_000_000_000)
        .expect("upsert credential");
    save_store(&credentials_path(home), &store).expect("save credentials");
}

fn write_config(path: &Path, base_url: &str, protocol: &str, extra_llm: &str) {
    let toml = format!(
        r#"
[llm]
provider = "openai"
protocol = "{protocol}"
model = "gpt-5.6-sol"
max_output_tokens = 256
{extra_llm}

[turn]
max_steps = 6
max_attempts = 3

[tools]
shell_enabled = true

[providers.openai]
base_url = "{base_url}"
"#
    );
    std::fs::write(path, toml).expect("write config");
}

#[cfg(unix)]
fn make_home_private(home: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(not(unix))]
fn make_home_private(_home: &Path) {}

fn cli_env() -> CliEnv {
    let temp = tempfile::tempdir().expect("tempdir").keep();
    let home = temp.join("home");
    let workspace = temp.join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    make_home_private(&home);
    std::fs::create_dir_all(&workspace).unwrap();
    let config = temp.join("praana.config.toml");
    CliEnv {
        home,
        workspace,
        config,
    }
}

fn run_cli(env: &CliEnv, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_praana"))
        .args(args)
        .current_dir(&env.workspace)
        .env("PRAANA_HOME", &env.home)
        .env("PRAANA_NO_UPDATE_CHECK", "1")
        .stdin(Stdio::null())
        .output()
        .expect("spawn praana")
}

fn run_cli_with_config(env: &CliEnv, prompt: &str) -> Output {
    let config = env.config.to_str().expect("config path utf8").to_owned();
    let prompt = prompt.to_owned();
    run_cli(env, &["run", "--config", &config, &prompt])
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn exit_code(output: &Output) -> i32 {
    output.status.code().expect("process exited with a code")
}

fn resume_id_line(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|line| {
        line.strip_prefix("Resume ID: ")
            .map(|id| id.trim().to_owned())
    })
}

fn assert_resume_id(output: &Output) -> String {
    let id = resume_id_line(&stderr(output)).expect("stderr carries exactly one resume ID line");
    assert_eq!(id.len(), 12, "resume id is the 12-char selector: {id}");
    let count = stderr(output)
        .lines()
        .filter(|line| line.starts_with("Resume ID: "))
        .count();
    assert_eq!(count, 1, "resume id is printed exactly once");
    id
}

fn assert_no_resume_id(output: &Output) {
    assert!(
        !stderr(output).contains("Resume ID: "),
        "no resume id on stderr: {}",
        stderr(output)
    );
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

#[test]
fn run_without_prompt_exits_2_with_usage_on_stderr() {
    let env = cli_env();
    let output = run_cli(&env, &["run"]);
    assert_eq!(exit_code(&output), 2);
    assert_eq!(stdout(&output), "", "usage never reaches stdout");
    assert!(
        stderr(&output).to_lowercase().contains("usage"),
        "stderr carries usage: {}",
        stderr(&output)
    );
    assert_no_resume_id(&output);
}

#[test]
fn unknown_subcommand_exits_2() {
    let env = cli_env();
    let output = run_cli(&env, &["frobnicate"]);
    assert_eq!(exit_code(&output), 2);
    assert_eq!(stdout(&output), "");
    assert_no_resume_id(&output);
}

#[test]
fn unknown_flag_exits_2_without_running() {
    let env = cli_env();
    // `--prompt` is a documented must-reject option; `--max-steps` is a valid
    // run override per the handoff grammar.
    let output = run_cli(&env, &["run", "--prompt", "hello"]);
    assert_eq!(exit_code(&output), 2);
    assert_eq!(stdout(&output), "");
    assert_no_resume_id(&output);
}

#[test]
fn duplicate_flag_exits_2() {
    let env = cli_env();
    let output = run_cli(
        &env,
        &[
            "--config",
            "/tmp/a.toml",
            "--config",
            "/tmp/b.toml",
            "run",
            "hello",
        ],
    );
    assert_eq!(exit_code(&output), 2);
    assert_eq!(stdout(&output), "");
    assert_no_resume_id(&output);
}

#[test]
fn exact_help_prints_usage_to_stdout_and_exits_0() {
    let env = cli_env();
    let output = run_cli(&env, &["--help"]);
    assert_eq!(exit_code(&output), 0);
    let text = stdout(&output);
    assert!(text.contains("Usage:"), "help usage line: {text}");
    assert!(text.contains("run"), "help lists run: {text}");
    assert!(text.contains("resume"), "help lists resume: {text}");
}

#[test]
fn exact_version_prints_package_version_and_exits_0() {
    let env = cli_env();
    let output = run_cli(&env, &["--version"]);
    assert_eq!(exit_code(&output), 0);
    assert!(
        stdout(&output).contains(env!("CARGO_PKG_VERSION")),
        "--version includes the praana-cli package version: {:?}",
        stdout(&output)
    );
}

#[test]
fn subcommand_help_prints_usage_to_stdout_and_exits_0() {
    let env = cli_env();
    let output = run_cli(&env, &["resume", "--help"]);
    assert_eq!(
        exit_code(&output),
        0,
        "help is an accepted informational form on run and resume"
    );
    let text = stdout(&output);
    assert!(text.contains("Usage:"), "help usage line: {text}");
    assert_no_resume_id(&output);
    assert!(
        !env.home.join("sessions").exists(),
        "informational forms create no session"
    );
}

// ---------------------------------------------------------------------------
// run: process results
// ---------------------------------------------------------------------------

#[test]
fn run_commits_and_streams_accepted_text_to_stdout_with_resume_id() {
    let env = cli_env();
    write_credentials(&env.home, "openai", "p3d-cli-key");
    let server = spawn_server(|_index| sse_response(200, &responses_text_body("hello from cli")));
    write_config(&env.config, &server.base_url(), "openai-responses-v1", "");

    let output = run_cli_with_config(&env, "say hello");
    assert_eq!(exit_code(&output), 0, "stderr: {}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "hello from cli\n",
        "accepted block text plus the LF rule; nothing else"
    );
    let id = assert_resume_id(&output);
    assert!(!stderr(&output).contains("E_"), "no diagnostics on success");
    assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    let recorded = server.recorded.lock().unwrap();
    assert!(
        recorded[0].starts_with("POST /v1/responses HTTP/1.1"),
        "responses protocol posts to /v1/responses: {:?}",
        recorded[0].lines().next()
    );
    assert!(
        recorded[0].contains("\"gpt-5.6-sol\""),
        "request body carries the configured model"
    );
    let _ = id;
}

#[test]
fn stdout_lf_rule_across_two_accepted_steps() {
    let env = cli_env();
    write_credentials(&env.home, "openai", "p3d-cli-key");
    let server = spawn_server(move |index| {
        let body = if index == 0 {
            chat_text_then_tool_body()
        } else {
            chat_final_body("beta\\n")
        };
        sse_response(200, &body)
    });
    write_config(&env.config, &server.base_url(), "openai-chat-v1", "");

    let output = run_cli_with_config(&env, "run the cycle");
    assert_eq!(exit_code(&output), 0, "stderr: {}", stderr(&output));
    assert_eq!(
        stdout(&output),
        "alpha\nbeta\n",
        "LF is appended after a block only when the last emitted byte is not LF"
    );
    assert_resume_id(&output);
}

#[test]
fn provider_failure_exits_1_with_transport_diagnostic_and_resume_id() {
    let env = cli_env();
    write_credentials(&env.home, "openai", "p3d-cli-key");
    let server = spawn_server(|_index| sse_response(500, "{\"error\":{\"message\":\"down\"}}"));
    write_config(&env.config, &server.base_url(), "openai-responses-v1", "");

    let output = run_cli_with_config(&env, "hello");
    assert_eq!(exit_code(&output), 1, "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), "", "no stdout on failure");
    assert!(
        stderr(&output).contains("E_PROVIDER_STREAM: transport"),
        "diagnostic line on stderr: {}",
        stderr(&output)
    );
    assert_resume_id(&output);
    assert!(server.hits.load(Ordering::SeqCst) >= 1);
}

#[test]
fn missing_credential_exits_1_with_auth_diagnostic_zero_sends_and_resume_id() {
    let env = cli_env();
    // No credentials.json and an unlikely env fallback for this provider.
    let server = spawn_server(|_index| sse_response(200, &chat_text_body("never")));
    let toml = format!(
        r#"
[llm]
provider = "openrouter"
protocol = "openai-chat-v1"
model = "mystery-model"
context_window = 128000
max_output_tokens = 256

[turn]
max_steps = 4
max_attempts = 3

[tools]
shell_enabled = true

[providers.openrouter]
base_url = "{base}"
"#,
        base = server.base_url()
    );
    std::fs::write(&env.config, toml).unwrap();

    let config = env.config.to_str().unwrap().to_owned();
    let output = run_cli_strings(
        &env,
        &["run".into(), "--config".into(), config, "hello".into()],
    );
    assert_eq!(exit_code(&output), 1, "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), "", "empty stdout");
    assert!(
        stderr(&output).contains("E_PROVIDER_AUTH: authentication"),
        "diagnostic: {}",
        stderr(&output)
    );
    assert_resume_id(&output);
    assert_eq!(
        server.hits.load(Ordering::SeqCst),
        0,
        "zero HTTP sends without a credential"
    );
}

fn run_cli_strings(env: &CliEnv, args: &[String]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_praana"))
        .args(args)
        .current_dir(&env.workspace)
        .env("PRAANA_HOME", &env.home)
        .env("PRAANA_NO_UPDATE_CHECK", "1")
        .stdin(Stdio::null())
        .output()
        .expect("spawn praana")
}

/// Spawns `praana` with the ambient provider-key env vars removed, so a key
/// on the test runner's machine can never satisfy (or leak into) the child.
fn run_cli_no_ambient_keys(env: &CliEnv, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_praana"))
        .args(args)
        .current_dir(&env.workspace)
        .env("PRAANA_HOME", &env.home)
        .env("PRAANA_NO_UPDATE_CHECK", "1")
        .env_remove("OPENAI_API_KEY")
        .env_remove("OPENROUTER_API_KEY")
        .stdin(Stdio::null())
        .output()
        .expect("spawn praana")
}

/// Like [`run_cli_no_ambient_keys`], then pins a single provider key so the
/// child deterministically sees exactly this credential.
fn run_cli_with_key(env: &CliEnv, args: &[&str], key: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_praana"))
        .args(args)
        .current_dir(&env.workspace)
        .env("PRAANA_HOME", &env.home)
        .env("PRAANA_NO_UPDATE_CHECK", "1")
        .env_remove("OPENROUTER_API_KEY")
        .env("OPENAI_API_KEY", key)
        .stdin(Stdio::null())
        .output()
        .expect("spawn praana")
}

fn write_compactor_config(path: &Path, base_url: &str) {
    let toml = format!(
        r#"
[llm]
provider = "openai"
protocol = "openai-responses-v1"
model = "gpt-5.6-sol"
max_output_tokens = 256

[turn]
max_steps = 6
max_attempts = 3

[tools]
shell_enabled = true

[history]
compactor_provider = "openai"
compactor_model = "gpt-5.6-sol"

[providers.openai]
base_url = "{base_url}"
"#
    );
    std::fs::write(path, toml).expect("write compactor config");
}

#[test]
fn complete_compactor_pair_without_credential_exits_2_before_session_creation() {
    let env = cli_env();
    // Complete pair, no store credential, and the child env is cleared of any
    // ambient provider key. The base_url is a closed loopback port: the gate
    // must reject before anything can touch the network.
    write_compactor_config(&env.config, "http://127.0.0.1:1/v1");

    let config = env.config.to_str().expect("config path utf8").to_owned();
    let output = run_cli_no_ambient_keys(&env, &["run", "--config", &config, "hello"]);
    assert_eq!(exit_code(&output), 2, "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), "", "no stdout on gate rejection");
    assert!(
        stderr(&output).contains("CONFIG_COMPACTOR_REQUIRED"),
        "diagnostic carries the canonical code: {}",
        stderr(&output)
    );
    assert!(
        !stderr(&output).contains("CONFIG_FEATURE_NOT_IMPLEMENTED"),
        "complete pair is no longer a feature-gate rejection: {}",
        stderr(&output)
    );
    assert_no_resume_id(&output);
    assert!(
        !env.home.join("sessions").exists(),
        "no session directory may be created when the gate rejects"
    );
}

#[test]
fn complete_compactor_pair_with_key_passes_gate_and_runs_against_fake_server() {
    let env = cli_env();
    let server = spawn_server(|_index| sse_response(200, &responses_text_body("hello from cli")));
    write_compactor_config(&env.config, &server.base_url());

    let config = env.config.to_str().expect("config path utf8").to_owned();
    let output = run_cli_with_key(
        &env,
        &["run", "--config", &config, "say hello"],
        "p3d-cli-key",
    );
    assert_eq!(exit_code(&output), 0, "stderr: {}", stderr(&output));
    assert!(
        !stderr(&output).contains("CONFIG_COMPACTOR_REQUIRED"),
        "valid key must pass the gate: {}",
        stderr(&output)
    );
    assert!(
        !stderr(&output).contains("CONFIG_FEATURE_NOT_IMPLEMENTED"),
        "stderr: {}",
        stderr(&output)
    );
    assert_eq!(stdout(&output), "hello from cli\n");
    assert_resume_id(&output);
    // The only HTTP interaction is with the loopback fake server — never the
    // real OpenAI endpoint.
    assert_eq!(server.hits.load(Ordering::SeqCst), 1);
    let recorded = server.recorded.lock().unwrap();
    assert!(
        recorded[0].starts_with("POST /v1/responses HTTP/1.1"),
        "responses protocol posts to /v1/responses: {:?}",
        recorded[0].lines().next()
    );
}

#[test]
fn admission_reject_exits_2_with_context_length_diagnostic_and_resume_id() {
    let env = cli_env();
    write_credentials(&env.home, "openai", "p3d-cli-key");
    let server = spawn_server(|_index| sse_response(200, &chat_text_body("never")));
    write_config(
        &env.config,
        &server.base_url(),
        "openai-responses-v1",
        // Smallest config-valid window; the 12k-char prompt is still far
        // beyond it, so admission rejects with no send.
        "context_window = 2048\n",
    );

    let huge = "p".repeat(12_000);
    let config = env.config.to_str().unwrap().to_owned();
    let output = run_cli_strings(&env, &["run".into(), "--config".into(), config, huge]);
    assert_eq!(exit_code(&output), 2, "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), "", "no stdout on reject");
    assert!(
        stderr(&output).contains("E_ACTIVE_TURN_TOO_LARGE: context_length"),
        "diagnostic: {}",
        stderr(&output)
    );
    assert_resume_id(&output);
    assert_eq!(
        server.hits.load(Ordering::SeqCst),
        0,
        "rejected before any send"
    );
}

// ---------------------------------------------------------------------------
// resume: selector lookup and ready sessions
// ---------------------------------------------------------------------------

fn first_session_id(home: &Path) -> String {
    let sessions = home.join("sessions");
    let mut ids: Vec<String> = std::fs::read_dir(sessions)
        .expect("sessions dir")
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let meta = entry.path().join("meta.json");
            let text = std::fs::read_to_string(meta).ok()?;
            let marker = "\"session_id\":\"";
            let start = text.find(marker)? + marker.len();
            let end = start + text[start..].find('"')?;
            Some(text[start..end].to_owned())
        })
        .collect();
    ids.sort();
    assert_eq!(ids.len(), 1, "exactly one session");
    ids.pop().unwrap()
}

#[test]
fn resume_ready_session_exits_0_with_id_and_empty_stdout() {
    let env = cli_env();
    write_credentials(&env.home, "openai", "p3d-cli-key");
    let server = spawn_server(|_index| sse_response(200, &chat_text_body("first turn text")));
    write_config(&env.config, &server.base_url(), "openai-chat-v1", "");

    let created = run_cli_with_config(&env, "first turn");
    assert_eq!(exit_code(&created), 0, "stderr: {}", stderr(&created));
    assert_eq!(stdout(&created), "first turn text\n");
    let created_id = assert_resume_id(&created);
    drop(created);

    let session_id = first_session_id(&env.home);
    assert!(
        session_id.starts_with(&created_id),
        "printed selector derives from the session id"
    );

    let resumed = run_cli(
        &env,
        &[
            "resume",
            "--config",
            env.config.to_str().unwrap(),
            &session_id,
        ],
    );
    assert_eq!(exit_code(&resumed), 0, "stderr: {}", stderr(&resumed));
    assert_eq!(
        stdout(&resumed),
        "",
        "a ready resumed session writes no stdout"
    );
    assert_eq!(assert_resume_id(&resumed), created_id);
}

// A real first CLI run supplies the immutable creation snapshot and a closed
// source turn. Append only the next turn's durable admission prefix, modelling
// a process exit before its first assistant attempt. `resume` has no prompt
// argument, so it must continue this active step-zero turn.
fn append_pending_turn(env: &CliEnv) -> (String, PathBuf) {
    use praana_core::history::event_log::EventLogStore;
    use praana_core::id::{IdGenerator, MonotonicUlidGenerator};
    use praana_core::protocol::events::EventEnvelope;
    use praana_core::protocol::id::{EventId, MessageId, TurnId};

    let sid = first_session_id(&env.home);
    let dir = env.home.join("sessions").join(&sid);
    let mut log = EventLogStore::open(&dir, &sid).unwrap();
    let events = log.events().unwrap();
    let mut prefix: Vec<serde_json::Value> = events
        .iter()
        .filter_map(|event| {
            let value = serde_json::to_value(event).unwrap();
            matches!(
                value["event"]["kind"].as_str(),
                Some("user_message_accepted" | "turn_started")
            )
            .then_some(value)
        })
        .collect();
    assert_eq!(prefix.len(), 2);
    let ids = MonotonicUlidGenerator::system();
    let turn: TurnId = ids.next_id().unwrap();
    let message: MessageId = ids.next_id().unwrap();
    for event in &mut prefix {
        let id: EventId = ids.next_id().unwrap();
        event["event_id"] = serde_json::json!(id.to_string());
        event["turn_id"] = serde_json::json!(turn.to_string());
        event["sequence"] = serde_json::json!(log.current_sequence() + 1);
        match event["event"]["kind"].as_str().unwrap() {
            "user_message_accepted" => {
                event["event"]["data"]["message"]["turn_id"] = serde_json::json!(turn.to_string());
                event["event"]["data"]["message"]["message_id"] =
                    serde_json::json!(message.to_string());
            }
            "turn_started" => {
                event["event"]["data"]["turn_index"] = serde_json::json!(2);
                event["event"]["data"]["user_message_id"] = serde_json::json!(message.to_string());
            }
            _ => unreachable!(),
        }
        let envelope: EventEnvelope = serde_json::from_value(event.clone()).unwrap();
        log.append_event(&envelope).unwrap();
    }
    (sid, dir)
}

fn write_live_compactor_config(
    env: &CliEnv,
    assistant: &FakeServer,
    compactor: &FakeServer,
    pair: bool,
    compact_at: f64,
) {
    let pair = if pair {
        "compactor_provider = \"openai\"\ncompactor_model = \"gpt-5.6-sol\""
    } else {
        ""
    };
    std::fs::write(
        &env.config,
        format!(
            r#"
[llm]
provider = "openrouter"
protocol = "openai-chat-v1"
model = "openai/gpt-5.6-sol"
max_output_tokens = 256
min_output_tokens = 16
context_window = 65536
[history]
compact_at = {compact_at}
compact_clear_at = 0.1
{pair}
[providers.openrouter]
base_url = "{}"
[providers.openai]
base_url = "{}"
"#,
            assistant.base_url(),
            compactor.base_url()
        ),
    )
    .unwrap();
}

fn live_cli_fixture(pair: bool, compact_at: f64) -> (CliEnv, FakeServer, FakeServer) {
    let env = cli_env();
    write_credentials(&env.home, "openrouter", "assistant-key");
    let mut store =
        praana_core::credentials::store::load_store(&credentials_path(&env.home)).unwrap();
    upsert_credential(
        &mut store,
        "openai",
        "compactor-key".into(),
        1_700_000_000_000,
    )
    .unwrap();
    save_store(&credentials_path(&env.home), &store).unwrap();
    let assistant = spawn_server(|_| sse_response(200, &chat_text_body("assistant answer")));
    let compactor = spawn_server(|_| {
        let candidate =
            include_str!("../../praana-core/tests/fixtures/compaction_v1/candidate_empty.json");
        let escaped = serde_json::to_string(candidate.trim()).unwrap();
        // responses_text_body expects JSON-string contents rather than quotes.
        sse_response(200, &responses_text_body(&escaped[1..escaped.len() - 1]))
    });
    write_live_compactor_config(&env, &assistant, &compactor, pair, compact_at);
    (env, assistant, compactor)
}

#[test]
fn cli_resume_installs_frozen_compactor_before_assistant() {
    let (env, assistant, compactor) = live_cli_fixture(true, 0.4);
    let prompt = "first closed source ".repeat(1200);
    let first = run_cli_no_ambient_keys(
        &env,
        &["run", "--config", env.config.to_str().unwrap(), &prompt],
    );
    assert_eq!(exit_code(&first), 0, "{}", stderr(&first));
    assert_eq!(compactor.hits.load(Ordering::SeqCst), 0);
    let (sid, dir) = append_pending_turn(&env);
    let snapshot = std::fs::read(dir.join("config.snapshot.json")).unwrap();
    // Loaded configuration must neither disable the frozen pair nor run a
    // creation gate. The frozen endpoints and thresholds remain authoritative.
    write_live_compactor_config(&env, &assistant, &compactor, false, 0.9);
    let resumed = run_cli_no_ambient_keys(
        &env,
        &["resume", "--config", env.config.to_str().unwrap(), &sid],
    );
    assert_eq!(exit_code(&resumed), 0, "{}", stderr(&resumed));
    let events = std::fs::read_to_string(dir.join("events.jsonl")).unwrap();
    assert_eq!(
        compactor.hits.load(Ordering::SeqCst),
        1,
        "frozen compactor must send; {}",
        stderr(&resumed)
    );
    assert_eq!(assistant.hits.load(Ordering::SeqCst), 2);
    let compacted = events.find("\"kind\":\"history_compacted\"").unwrap();
    let last_assistant = events.rfind("\"type\":\"assistant_step\"").unwrap();
    assert!(
        compacted < last_assistant,
        "compaction activates before assistant start"
    );
    assert_eq!(
        std::fs::read(dir.join("config.snapshot.json")).unwrap(),
        snapshot
    );
    assert!(compactor.recorded.lock().unwrap()[0].starts_with("POST /v1/responses "));
    assert!(assistant.recorded.lock().unwrap()[1].starts_with("POST /v1/chat/completions "));
}

#[test]
fn cli_resume_frozen_empty_pair_never_installs_or_rewrites() {
    let (env, assistant, compactor) = live_cli_fixture(false, 0.4);
    let first = run_cli_no_ambient_keys(
        &env,
        &[
            "run",
            "--config",
            env.config.to_str().unwrap(),
            &"first closed source ".repeat(1200),
        ],
    );
    assert_eq!(exit_code(&first), 0, "{}", stderr(&first));
    let (sid, dir) = append_pending_turn(&env);
    let snapshot = std::fs::read(dir.join("config.snapshot.json")).unwrap();
    write_live_compactor_config(&env, &assistant, &compactor, true, 0.4);
    let resumed = run_cli_no_ambient_keys(
        &env,
        &["resume", "--config", env.config.to_str().unwrap(), &sid],
    );
    assert_eq!(exit_code(&resumed), 0, "{}", stderr(&resumed));
    assert_eq!(compactor.hits.load(Ordering::SeqCst), 0);
    assert_eq!(assistant.hits.load(Ordering::SeqCst), 2);
    assert_eq!(
        std::fs::read(dir.join("config.snapshot.json")).unwrap(),
        snapshot
    );
    assert!(!std::fs::read_to_string(dir.join("events.jsonl"))
        .unwrap()
        .contains("history_compacted"));
}

#[test]
fn cli_resume_missing_compactor_credential_stops_before_any_request() {
    let (env, assistant, compactor) = live_cli_fixture(true, 0.9);
    let first = run_cli_no_ambient_keys(
        &env,
        &[
            "run",
            "--config",
            env.config.to_str().unwrap(),
            "small source",
        ],
    );
    assert_eq!(exit_code(&first), 0, "{}", stderr(&first));
    let (sid, dir) = append_pending_turn(&env);
    // Preserve the assistant credential; only the compactor loses capability.
    write_credentials(&env.home, "openrouter", "assistant-key");
    let before = std::fs::read(dir.join("events.jsonl")).unwrap();
    let resumed = run_cli_no_ambient_keys(
        &env,
        &["resume", "--config", env.config.to_str().unwrap(), &sid],
    );
    assert_ne!(
        exit_code(&resumed),
        0,
        "missing compactor must stop admission"
    );
    assert!(
        stderr(&resumed).contains("E_COMPACTION_UNAVAILABLE"),
        "{}",
        stderr(&resumed)
    );
    assert!(!stderr(&resumed).contains("CONFIG_COMPACTOR_REQUIRED"));
    assert_eq!(compactor.hits.load(Ordering::SeqCst), 0);
    assert_eq!(
        assistant.hits.load(Ordering::SeqCst),
        1,
        "zero resumed assistant requests"
    );
    assert_eq!(std::fs::read(dir.join("events.jsonl")).unwrap(), before);
}

#[test]
fn resume_unknown_selector_exits_2_with_session_not_found() {
    let env = cli_env();
    let output = run_cli(&env, &["resume", "01ABCDEFGHJK"]);
    assert_eq!(exit_code(&output), 2, "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), "");
    assert!(
        stderr(&output).contains("SessionNotFound"),
        "diagnostic: {}",
        stderr(&output)
    );
    assert_no_resume_id(&output);
}

#[test]
fn resume_ambiguous_selector_exits_2_and_lists_sorted_session_ids() {
    let env = cli_env();
    let id_a = "01ABCDEFGHJK0AAAAAAAAAAAAAA";
    let id_b = "01ABCDEFGHJK0BBBBBBBBBBBBBB";
    for id in [id_a, id_b] {
        let dir = env.home.join("sessions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("meta.json"),
            format!("{{\"session_id\":\"{id}\"}}"),
        )
        .unwrap();
    }

    let output = run_cli(&env, &["resume", "01ABCDEFGHJK"]);
    assert_eq!(exit_code(&output), 2, "stderr: {}", stderr(&output));
    assert_eq!(stdout(&output), "");
    let text = stderr(&output);
    assert!(
        text.contains("ResumeSelectorAmbiguous"),
        "diagnostic: {text}"
    );
    let pos_a = text.find(id_a).expect("id_a listed");
    let pos_b = text.find(id_b).expect("id_b listed");
    assert!(pos_a < pos_b, "full ids listed in sorted order: {text}");
    assert_no_resume_id(&output);
}

#[test]
fn resume_invalid_selector_length_exits_2() {
    let env = cli_env();
    let output = run_cli(&env, &["resume", "abc"]);
    assert_eq!(exit_code(&output), 2);
    assert_eq!(stdout(&output), "");
    assert_no_resume_id(&output);
}

#[test]
fn resume_with_changed_config_warns_with_key_names_only() {
    let env = cli_env();
    write_credentials(&env.home, "openai", "p3d-cli-key");
    let server = spawn_server(|_index| sse_response(200, &chat_text_body("turn one")));
    write_config(&env.config, &server.base_url(), "openai-chat-v1", "");

    let created = run_cli_with_config(&env, "turn one");
    assert_eq!(exit_code(&created), 0, "stderr: {}", stderr(&created));
    let created_id = assert_resume_id(&created);
    drop(created);

    // Change a config value between create and resume.
    let changed = std::fs::read_to_string(&env.config)
        .unwrap()
        .replace("max_output_tokens = 256", "max_output_tokens = 512");
    std::fs::write(&env.config, changed).unwrap();

    let session_id = first_session_id(&env.home);
    let resumed = run_cli(
        &env,
        &[
            "resume",
            "--config",
            env.config.to_str().unwrap(),
            &session_id,
        ],
    );
    assert_eq!(exit_code(&resumed), 0, "stderr: {}", stderr(&resumed));
    assert_eq!(stdout(&resumed), "", "ready session stays quiet");
    let text = stderr(&resumed);
    assert!(
        text.contains("configuration changed since create"),
        "changed-config warning: {text}"
    );
    assert!(text.contains("max_output_tokens"), "key names only: {text}");
    assert_eq!(assert_resume_id(&resumed), created_id);
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod signals {
    use super::*;

    fn spawn_run_blocked(env: &CliEnv) -> std::process::Child {
        let config = env.config.to_str().unwrap().to_owned();
        Command::new(env!("CARGO_BIN_EXE_praana"))
            .args(["run", "--config", &config, "block forever"])
            .current_dir(&env.workspace)
            .env("PRAANA_HOME", &env.home)
            .env("PRAANA_NO_UPDATE_CHECK", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn praana run")
    }

    fn wait_for_send(server: &FakeServer) {
        for _ in 0..300 {
            if server.hits.load(Ordering::SeqCst) >= 1 {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("provider send never landed");
    }

    #[test]
    fn sigint_during_stream_exits_130_with_resume_id_and_no_stdout() {
        let env = cli_env();
        write_credentials(&env.home, "openai", "p3d-cli-key");
        // Content-length far beyond the single delta keeps the stream open.
        let server = spawn_holding_server(
            |_index| {
                let first = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n";
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 10000000\r\nconnection: close\r\n\r\n{first}"
                )
                .into_bytes()
            },
            Duration::from_secs(60),
        );
        write_config(&env.config, &server.base_url(), "openai-chat-v1", "");

        let child = spawn_run_blocked(&env);
        wait_for_send(&server);
        std::thread::sleep(Duration::from_millis(200));
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGINT);
        }
        let output = child.wait_with_output().expect("wait");
        assert_eq!(exit_code(&output), 130, "stderr: {}", stderr(&output));
        assert_eq!(
            stdout(&output),
            "",
            "signal row publishes no partial output"
        );
        assert_resume_id(&output);
        assert!(!stderr(&output).contains("E_ACTIVE_TURN_TOO_LARGE"));
    }

    #[test]
    fn sigterm_during_stream_exits_143_with_resume_id_and_no_stdout() {
        let env = cli_env();
        write_credentials(&env.home, "openai", "p3d-cli-key");
        let server = spawn_holding_server(
            |_index| {
                let first = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n";
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 10000000\r\nconnection: close\r\n\r\n{first}"
                )
                .into_bytes()
            },
            Duration::from_secs(60),
        );
        write_config(&env.config, &server.base_url(), "openai-chat-v1", "");

        let child = spawn_run_blocked(&env);
        wait_for_send(&server);
        std::thread::sleep(Duration::from_millis(200));
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        let output = child.wait_with_output().expect("wait");
        assert_eq!(exit_code(&output), 143, "stderr: {}", stderr(&output));
        assert_eq!(stdout(&output), "");
        assert_resume_id(&output);
    }
}

// ---------------------------------------------------------------------------
// Windows fail-closed smoke (wired into rust-v2-crash-matrix.yml)
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[test]
fn windows_run_fails_closed_before_durable_session() {
    let env = cli_env();
    let output = run_cli(&env, &["run", "hello"]);
    assert_ne!(exit_code(&output), 0, "durable creation stays fail-closed");
    assert_eq!(exit_code(&output), 1, "create failure exits irrecoverable");
    assert_eq!(
        stdout(&output),
        "",
        "no stdout before durable session start"
    );
    assert_no_resume_id(&output);
    let sessions = env.home.join("sessions");
    if sessions.exists() {
        for entry in std::fs::read_dir(&sessions).unwrap().flatten() {
            let dir = entry.path();
            assert!(
                !dir.join("events.jsonl").exists(),
                "no durable history is created"
            );
            assert!(
                !dir.join("meta.json").exists(),
                "no session meta is committed"
            );
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_resume_fails_closed_before_session_lock() {
    let env = cli_env();
    // Canonical 26-character session id under the effective session.root, so
    // selector lookup resolves the session and the run reaches the Windows
    // fail-closed guard instead of the selector-validation exit 2.
    let id = "01ABCDEFGHJK0AAAAAAAAAAAAA";
    assert_eq!(id.len(), 26, "fixture id must be a canonical session id");
    let dir = env.home.join("sessions").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("meta.json"),
        format!("{{\"session_id\":\"{id}\"}}"),
    )
    .unwrap();

    let output = run_cli(&env, &["resume", id]);
    assert_ne!(exit_code(&output), 0, "resume stays fail-closed on Windows");
    assert_eq!(
        exit_code(&output),
        1,
        "fail-closed resume exits irrecoverable: {}",
        stderr(&output)
    );
    assert_eq!(stdout(&output), "");
    assert_no_resume_id(&output);
    assert!(
        !dir.join("session.lock").exists(),
        "fail-closed resume returns before the session lock"
    );
    assert!(
        !dir.join("events.jsonl").exists(),
        "fail-closed resume appends no events"
    );
}
