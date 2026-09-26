//! Scripted fake-provider headless turns. No network.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use praana_core::clock::Clock;
use praana_core::config::build_defaults;
use praana_core::id::{IdGenerationError, MonotonicUlidGenerator, RandomSource};
use praana_core::protocol::events::InterruptionReason;
use praana_core::protocol::messages::FinishReason;
use praana_core::protocol::models::ProviderUsage;
use praana_core::turn::{
    AdmittedRequest, AssistantDraft, DraftCall, HeadlessLoop, LoopConfig, LoopFault,
    PreparedRequest, ProviderOutput, ScriptedStep, StepProvider, TurnError,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

struct FixedClock(i64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

struct SeqRandom(u128);

impl RandomSource for SeqRandom {
    fn next_random_80(&mut self) -> Result<u128, IdGenerationError> {
        self.0 += 1;
        Ok(self.0)
    }
}

struct ScriptedProvider {
    dir: PathBuf,
    steps: Mutex<std::collections::VecDeque<ScriptedStep>>,
    sends: AtomicUsize,
    saw_attempt: AtomicBool,
}

impl ScriptedProvider {
    fn new(dir: PathBuf, steps: Vec<ScriptedStep>) -> Self {
        Self {
            dir,
            steps: Mutex::new(steps.into()),
            sends: AtomicUsize::new(0),
            saw_attempt: AtomicBool::new(true),
        }
    }
}

#[async_trait]
impl StepProvider for ScriptedProvider {
    fn prepare(&self, step_index: u32) -> Result<PreparedRequest, TurnError> {
        Ok(PreparedRequest {
            request_body: json!({"scripted": true, "step": step_index}),
            component_bytes: std::array::from_fn(|_| Vec::new()),
        })
    }

    async fn complete(
        &self,
        step_index: u32,
        admitted: &AdmittedRequest,
        _cancel: &CancellationToken,
    ) -> Result<ProviderOutput, TurnError> {
        if admitted.body()["step"] != json!(step_index) {
            return Err(TurnError::Failed(
                "provider send was not the admitted request".into(),
            ));
        }
        let authorization = admitted.authorize_send(admitted.body())?;
        let text = fs::read_to_string(self.dir.join("events.jsonl")).unwrap_or_default();
        let starts = text.matches("\"assistant_attempt_started\"").count();
        if starts < self.sends.load(Ordering::SeqCst) + 1 {
            self.saw_attempt.store(false, Ordering::SeqCst);
        }
        self.sends.fetch_add(1, Ordering::SeqCst);
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("scripted step");
        Ok(ProviderOutput {
            draft: AssistantDraft {
                text: step.text,
                calls: step.calls,
                finish_reason: step.finish,
                usage: step.usage,
            },
            authorization,
        })
    }
}

fn config(root: &std::path::Path, max_steps: u32) -> LoopConfig {
    let mut effective = build_defaults(PathBuf::from("/praana-home").as_path());
    effective.turn.max_steps = max_steps;
    effective.turn.max_attempts = 3;
    effective.llm.context_window = 128_000;
    effective.llm.provider = "scripted".into();
    effective.llm.protocol = "scripted-v1".into();
    effective.llm.model = "fake".into();
    effective.llm.min_output_tokens = 16;
    effective.llm.max_output_tokens = 256;
    effective.history.artifact_inline_tokens = 1;
    effective.history.artifact_batch_inline_tokens = 1;
    effective.history.safety_margin_min_tokens = 0;
    effective.history.safety_margin_ratio = 0.0;
    effective.tools.shell_enabled = true;
    effective.tools.max_parallel_calls = 2;
    LoopConfig {
        session_dir: root.join("session"),
        workspace: root.join("work"),
        config: effective,
        clock: Arc::new(FixedClock(1_700_000_000_000)),
        ids: Arc::new(MonotonicUlidGenerator::new(
            Arc::new(FixedClock(1_700_000_000_000)),
            Arc::new(praana_core::clock::ThreadSleeper),
            Box::new(SeqRandom(1)),
        )),
        fault: LoopFault::None,
    }
}

fn usage(n: u64) -> ProviderUsage {
    ProviderUsage {
        input_tokens: n,
        output_tokens: 1,
        reasoning_tokens: 0,
        total_tokens: n + 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
    }
}

fn tool_step(id: &str, name: &str, args: Value) -> ScriptedStep {
    let mut arguments = serde_json::Map::new();
    if let Value::Object(map) = args {
        arguments = map;
    }
    ScriptedStep {
        text: None,
        calls: vec![DraftCall {
            call_id: id.into(),
            name: name.into(),
            arguments,
        }],
        finish: FinishReason::ToolUse,
        usage: usage(3),
    }
}

#[tokio::test]
async fn fake_provider_multi_step_tool_turn() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let mut cfg = config(dir.path(), 4);
    let provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![
            tool_step(
                "call-write",
                "write_file",
                json!({"path": "out.txt", "content": "hello"}),
            ),
            tool_step("call-read", "read_file", json!({"path": "out.txt"})),
            ScriptedStep {
                text: Some("done".into()),
                calls: Vec::new(),
                finish: FinishReason::Stop,
                usage: usage(4),
            },
        ],
    );
    let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
    cfg.fault = LoopFault::None;
    let report = loop_.run_turn("write then read", &provider).await.unwrap();
    assert!(report.interruption.is_none());
    assert_eq!(provider.sends.load(Ordering::SeqCst), 3);
    assert!(provider.saw_attempt.load(Ordering::SeqCst));
    assert!(report.admission_count >= 3);
    let kinds = loop_.event_kinds().unwrap();
    let expected = [
        "session_started",
        "user_message_accepted",
        "turn_started",
        "assistant_attempt_started",
        "assistant_step_accepted",
        "tool_execution_started",
        "tool_execution_finished",
        "tool_batch_completed",
        "assistant_attempt_started",
        "assistant_step_accepted",
        "tool_execution_started",
        "tool_execution_finished",
        "tool_batch_completed",
        "assistant_attempt_started",
        "assistant_step_accepted",
        "turn_committed",
    ];
    assert_eq!(kinds, expected);
    assert_eq!(
        fs::read_to_string(dir.path().join("work/out.txt")).unwrap(),
        "hello"
    );
    let text = fs::read_to_string(cfg.session_dir.join("events.jsonl")).unwrap();
    assert_eq!(text.matches("\"user_message_accepted\"").count(), 1);
    assert_eq!(text.matches("\"turn_committed\"").count(), 1);
}

#[tokio::test]
async fn fake_provider_parallel_fragmented_tools() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    fs::create_dir_all(&work).unwrap();
    fs::write(work.join("a.txt"), "A").unwrap();
    fs::write(work.join("b.txt"), "B").unwrap();
    let cfg = config(dir.path(), 3);
    let mut arguments_a = serde_json::Map::new();
    arguments_a.insert("path".into(), json!("a.txt"));
    let mut arguments_b = serde_json::Map::new();
    arguments_b.insert("path".into(), json!("b.txt"));
    let provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![
            ScriptedStep {
                text: None,
                calls: vec![
                    DraftCall {
                        call_id: "call-a".into(),
                        name: "read_file".into(),
                        arguments: arguments_a,
                    },
                    DraftCall {
                        call_id: "call-b".into(),
                        name: "read_file".into(),
                        arguments: arguments_b,
                    },
                ],
                finish: FinishReason::ToolUse,
                usage: usage(2),
            },
            ScriptedStep {
                text: Some("both".into()),
                calls: Vec::new(),
                finish: FinishReason::Stop,
                usage: usage(2),
            },
        ],
    );
    let mut loop_ = HeadlessLoop::create(cfg).unwrap();
    loop_.run_turn("read both", &provider).await.unwrap();
    let text = fs::read_to_string(loop_.session_dir().join("events.jsonl")).unwrap();
    let a = text.find("call-a").unwrap();
    let b = text.find("call-b").unwrap();
    assert!(a < b, "provider order is call-a then call-b");
    assert_eq!(text.matches("\"tool_execution_finished\"").count(), 2);
}

#[tokio::test]
async fn step_limit_interrupts_with_the_owner_message() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let cfg = config(dir.path(), 1);
    let provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![tool_step(
            "call-write",
            "write_file",
            json!({"path": "out.txt", "content": "x"}),
        )],
    );
    let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
    let report = loop_.run_turn("one step", &provider).await.unwrap();
    assert_eq!(report.interruption, Some(InterruptionReason::StepLimit));
    let text = fs::read_to_string(cfg.session_dir.join("events.jsonl")).unwrap();
    assert!(text.contains("Turn stopped after reaching the configured assistant step limit."));
    assert!(!text.contains("\"turn_committed\""));
}

#[tokio::test]
async fn crash_restart_does_not_rerun_the_tool_body() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    fs::create_dir_all(&work).unwrap();
    let mut cfg = config(dir.path(), 4);
    cfg.fault = LoopFault::AfterToolBodyBeforeFinish;
    let provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![tool_step(
            "call-sh",
            "shell",
            json!({"command": "printf 'x\\n' >> counter", "timeout_ms": 5000}),
        )],
    );
    let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
    let crashed = loop_.run_turn("count", &provider).await.unwrap_err();
    assert!(matches!(crashed, TurnError::InjectedCrash));
    drop(loop_);
    let lines = fs::read_to_string(work.join("counter"))
        .unwrap()
        .lines()
        .count();
    assert_eq!(lines, 1);
    cfg.fault = LoopFault::None;
    let resume_provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![ScriptedStep {
            text: Some("recovered".into()),
            calls: Vec::new(),
            finish: FinishReason::Stop,
            usage: usage(1),
        }],
    );
    let mut resumed = HeadlessLoop::resume(cfg).unwrap();
    resumed.continue_turn(&resume_provider).await.unwrap();
    let lines = fs::read_to_string(work.join("counter"))
        .unwrap()
        .lines()
        .count();
    assert_eq!(lines, 1);
    let text = fs::read_to_string(resumed.session_dir().join("events.jsonl")).unwrap();
    assert_eq!(text.matches("\"user_message_accepted\"").count(), 1);
    assert!(text.contains("E_TOOL_SIDE_EFFECT_UNCERTAIN") || text.contains("uncertain"));
}

#[tokio::test]
async fn large_shell_output_is_an_artifact_with_a_bounded_preview() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let cfg = config(dir.path(), 3);
    let provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![
            tool_step(
                "call-sh",
                "shell",
                json!({"command": "yes a | head -c 5000", "timeout_ms": 5000}),
            ),
            ScriptedStep {
                text: Some("done".into()),
                calls: Vec::new(),
                finish: FinishReason::Stop,
                usage: usage(1),
            },
        ],
    );
    let mut loop_ = HeadlessLoop::create(cfg).unwrap();
    loop_.run_turn("print a lot", &provider).await.unwrap();
    let text = fs::read_to_string(loop_.session_dir().join("events.jsonl")).unwrap();
    let finish = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|event| event["event"]["kind"] == "tool_execution_finished")
        .unwrap();
    let content = &finish["event"]["data"]["result"]["body"]["content"];
    assert_eq!(content["storage"], "artifact");
    let preview = content["data"]["preview"].as_str().unwrap();
    assert!(preview.len() < 5000, "preview len {}", preview.len());
    assert!(!preview.contains(&"a".repeat(4000)));
}

#[tokio::test]
async fn cancellation_mid_turn_interrupts_and_releases_locks() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let cfg = config(dir.path(), 4);
    let provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![tool_step(
            "call-sh",
            "shell",
            json!({"command": "sleep 30", "timeout_ms": 8000}),
        )],
    );
    let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
    let token = loop_.cancellation_token();
    let events = cfg.session_dir.join("events.jsonl");
    let watcher = tokio::spawn(async move {
        for _ in 0..200 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let text = fs::read_to_string(&events).unwrap_or_default();
            if text.contains("\"tool_execution_started\"") {
                token.cancel();
                return;
            }
        }
    });
    let report = loop_.run_turn("sleep", &provider).await.unwrap();
    watcher.abort();
    assert_eq!(report.interruption, Some(InterruptionReason::UserAbort));
    let text = fs::read_to_string(loop_.session_dir().join("events.jsonl")).unwrap();
    assert!(text.contains("Turn aborted by user before commit."));
    assert!(!text.contains("\"turn_committed\""));
    assert_eq!(loop_.held_locks(), 0);
    let listed = std::process::Command::new("pgrep")
        .args(["-f", "sleep 30"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&listed.stdout);
    assert!(stdout.trim().is_empty(), "sleep 30 still running: {stdout}");
}

#[tokio::test]
async fn tool_argument_canary_is_absent_from_canonical_events() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let canary = "AKIA".to_owned() + &"C".repeat(16);
    let cfg = config(dir.path(), 3);
    let provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![
            tool_step(
                "call-write",
                "write_file",
                json!({"path": "out.txt", "content": canary}),
            ),
            ScriptedStep {
                text: Some("done".into()),
                calls: Vec::new(),
                finish: FinishReason::Stop,
                usage: usage(1),
            },
        ],
    );
    let mut loop_ = HeadlessLoop::create(cfg).unwrap();
    loop_.run_turn("write a canary", &provider).await.unwrap();
    let events = fs::read_to_string(loop_.session_dir().join("events.jsonl")).unwrap();
    assert!(!events.contains(&canary));
    assert!(events.contains("[REDACTED:aws-access-key]"));
    assert_eq!(
        fs::read_to_string(dir.path().join("work").join("out.txt")).unwrap(),
        canary
    );
}

#[tokio::test]
async fn provider_error_canary_is_absent_from_the_event_log() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let canary = "AKIA".to_owned() + &"C".repeat(16);
    let cfg = config(dir.path(), 2);
    let provider = LeakyProvider {
        canary: canary.clone(),
    };
    let mut loop_ = HeadlessLoop::create(cfg).unwrap();
    let report = loop_.run_turn("fail", &provider).await.unwrap();
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ProviderFailure)
    );
    let events = fs::read_to_string(loop_.session_dir().join("events.jsonl")).unwrap();
    assert!(!events.contains(&canary));
    assert!(events.contains("[REDACTED:aws-access-key]"));
}

#[tokio::test]
async fn provider_send_must_match_the_admitted_body() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let cfg = config(dir.path(), 2);
    let provider = DisagreeingProvider;
    let mut loop_ = HeadlessLoop::create(cfg).unwrap();
    let report = loop_.run_turn("send", &provider).await.unwrap();
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ProviderFailure)
    );
    let events = fs::read_to_string(loop_.session_dir().join("events.jsonl")).unwrap();
    assert!(!events.contains("not-the-admitted-body"));
    assert!(!events.contains("\"assistant_step_accepted\""));
}

#[tokio::test]
async fn empty_component_bytes_cannot_hide_a_large_request() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let mut cfg = config(dir.path(), 2);
    // Above the output reserve so a small body still admits, below the padded body.
    cfg.config.llm.context_window = 400;
    let provider = LargeBodyProvider {
        completes: AtomicUsize::new(0),
    };
    let mut loop_ = HeadlessLoop::create(cfg).unwrap();
    let report = loop_.run_turn("large", &provider).await.unwrap();
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ActiveTurnTooLarge)
    );
    assert_eq!(provider.completes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn small_binary_shell_output_is_a_binary_artifact() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let mut cfg = config(dir.path(), 3);
    cfg.config.history.artifact_inline_tokens = 100_000;
    cfg.config.history.artifact_batch_inline_tokens = 100_000;
    let provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![
            tool_step(
                "call-bin",
                "shell",
                json!({"command": "printf '\\377'", "timeout_ms": 5000}),
            ),
            ScriptedStep {
                text: Some("done".into()),
                calls: Vec::new(),
                finish: FinishReason::Stop,
                usage: usage(1),
            },
        ],
    );
    let mut loop_ = HeadlessLoop::create(cfg).unwrap();
    loop_.run_turn("binary", &provider).await.unwrap();
    let events = fs::read_to_string(loop_.session_dir().join("events.jsonl")).unwrap();
    let finish = events
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|event| event["event"]["kind"] == "tool_execution_finished")
        .unwrap();
    let rendered = serde_json::to_string(&finish).unwrap();
    assert!(rendered.contains("\"storage\":\"artifact\""), "{rendered}");
    assert!(!rendered.contains("/w=="), "{rendered}");
    let store = praana_core::history::artifact::ArtifactStore::open(
        &loop_.session_dir().join("history.db"),
        praana_core::history::artifact::policy_from_session(loop_.session_dir()),
        Arc::new(FixedClock(1_700_000_000_000)),
    )
    .unwrap();
    assert!(store.artifact_row_count().unwrap() >= 1);
}

#[tokio::test]
async fn queued_call_cancelled_before_the_semaphore_has_no_start() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    fs::create_dir_all(&work).unwrap();
    let mut cfg = config(dir.path(), 3);
    cfg.config.tools.max_parallel_calls = 1;
    let mut sleep_args = serde_json::Map::new();
    sleep_args.insert("command".into(), json!("sleep 30"));
    sleep_args.insert("timeout_ms".into(), json!(20000));
    let mut touch_args = serde_json::Map::new();
    touch_args.insert("command".into(), json!("touch queued-ran"));
    touch_args.insert("timeout_ms".into(), json!(5000));
    let provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![ScriptedStep {
            text: None,
            calls: vec![
                DraftCall {
                    call_id: "call-sleep".into(),
                    name: "shell".into(),
                    arguments: sleep_args,
                },
                DraftCall {
                    call_id: "call-touch".into(),
                    name: "shell".into(),
                    arguments: touch_args,
                },
            ],
            finish: FinishReason::ToolUse,
            usage: usage(1),
        }],
    );
    let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
    let token = loop_.cancellation_token();
    let events = cfg.session_dir.join("events.jsonl");
    let watcher = tokio::spawn(async move {
        for _ in 0..200 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let text = fs::read_to_string(&events).unwrap_or_default();
            if text.matches("\"tool_execution_started\"").count() == 1 {
                token.cancel();
                return;
            }
        }
    });
    let report = loop_.run_turn("queue", &provider).await.unwrap();
    watcher.abort();
    assert_eq!(report.interruption, Some(InterruptionReason::UserAbort));
    assert!(loop_.event_kinds().is_ok());
    assert!(!work.join("queued-ran").exists());
    let text = fs::read_to_string(loop_.session_dir().join("events.jsonl")).unwrap();
    assert_eq!(text.matches("\"tool_execution_started\"").count(), 1);
    let finishes: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| event["event"]["kind"] == "tool_execution_finished")
        .collect();
    assert_eq!(finishes.len(), 2, "{text}");
    assert!(finishes
        .iter()
        .any(|event| event["event"]["data"]["started_event_id"].is_null()));
    let listed = std::process::Command::new("pgrep")
        .args(["-f", "sleep 30"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&listed.stdout).trim().is_empty());
}

struct LeakyProvider {
    canary: String,
}

#[async_trait]
impl StepProvider for LeakyProvider {
    fn prepare(&self, step_index: u32) -> Result<PreparedRequest, TurnError> {
        Ok(PreparedRequest {
            request_body: json!({"scripted": true, "step": step_index}),
            component_bytes: std::array::from_fn(|_| Vec::new()),
        })
    }

    async fn complete(
        &self,
        _step_index: u32,
        _admitted: &AdmittedRequest,
        _cancel: &CancellationToken,
    ) -> Result<ProviderOutput, TurnError> {
        Err(TurnError::Failed(format!(
            "provider failed {}",
            self.canary
        )))
    }
}

struct DisagreeingProvider;

#[async_trait]
impl StepProvider for DisagreeingProvider {
    fn prepare(&self, step_index: u32) -> Result<PreparedRequest, TurnError> {
        Ok(PreparedRequest {
            request_body: json!({"scripted": true, "step": step_index}),
            component_bytes: std::array::from_fn(|_| Vec::new()),
        })
    }

    async fn complete(
        &self,
        _step_index: u32,
        admitted: &AdmittedRequest,
        _cancel: &CancellationToken,
    ) -> Result<ProviderOutput, TurnError> {
        let other = json!({"scripted": true, "body": "not-the-admitted-body"});
        admitted.authorize_send(&other)?;
        Err(TurnError::Failed("authorization should have failed".into()))
    }
}

struct LargeBodyProvider {
    completes: AtomicUsize,
}

#[async_trait]
impl StepProvider for LargeBodyProvider {
    fn prepare(&self, step_index: u32) -> Result<PreparedRequest, TurnError> {
        Ok(PreparedRequest {
            request_body: json!({
                "scripted": true,
                "step": step_index,
                "pad": "a".repeat(8_000),
            }),
            component_bytes: std::array::from_fn(|_| Vec::new()),
        })
    }

    async fn complete(
        &self,
        _step_index: u32,
        _admitted: &AdmittedRequest,
        _cancel: &CancellationToken,
    ) -> Result<ProviderOutput, TurnError> {
        self.completes.fetch_add(1, Ordering::SeqCst);
        Err(TurnError::Failed("complete was called".into()))
    }
}
