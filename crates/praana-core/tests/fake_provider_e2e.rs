//! Scripted fake-provider headless turns. No network.

use std::fs;
#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use praana_core::clock::Clock;
use praana_core::config::build_defaults;
use praana_core::id::{IdGenerationError, IdGenerator, MonotonicUlidGenerator, RandomSource};
use praana_core::protocol::events::InterruptionReason;
use praana_core::protocol::messages::FinishReason;
use praana_core::protocol::models::ProviderUsage;
use praana_core::turn::{
    AdmittedRequest, AssistantDraft, DraftCall, HeadlessLoop, LoopConfig, LoopFault,
    PreparedRequest, ProviderOutput, ScriptedStep, StepProvider, TurnError,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
fn assert_spawned_child_stopped(pid_file: &Path) {
    let pid = fs::read_to_string(pid_file).expect("shell recorded its child pid");
    let pid = pid.trim();
    let output = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "spawned sleep child {pid} survived cancellation: {state}"
    );
}

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
    assert!(text.contains("E_TOOL_SIDE_EFFECT_UNCERTAIN"));
    let uncertain = text
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|event| {
            event["event"]["kind"] == "tool_execution_finished"
                && event["event"]["data"]["result"]["status"] == json!("uncertain")
        })
        .expect("exact uncertain finish with stable code");
    assert_eq!(
        uncertain["event"]["data"]["result"]["recovered"],
        json!(true)
    );
    let rendered = serde_json::to_string(&uncertain).unwrap();
    assert!(rendered.contains("E_TOOL_SIDE_EFFECT_UNCERTAIN"));
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
            json!({"command": "sleep 30 & echo $! > spawned-child.pid; wait", "timeout_ms": 8000}),
        )],
    );
    let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
    let token = loop_.cancellation_token();
    let events = cfg.session_dir.join("events.jsonl");
    let child_pid = cfg.workspace.join("spawned-child.pid");
    let watcher = tokio::spawn(async move {
        for _ in 0..200 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let text = fs::read_to_string(&events).unwrap_or_default();
            if text.contains("\"tool_execution_started\"") && child_pid.exists() {
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
    #[cfg(unix)]
    assert_spawned_child_stopped(&cfg.workspace.join("spawned-child.pid"));
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
    sleep_args.insert(
        "command".into(),
        json!("sleep 30 & echo $! > queued-child.pid; wait"),
    );
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
    let child_pid = work.join("queued-child.pid");
    let watcher = tokio::spawn(async move {
        for _ in 0..200 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let text = fs::read_to_string(&events).unwrap_or_default();
            if text.matches("\"tool_execution_started\"").count() == 1 && child_pid.exists() {
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
    #[cfg(unix)]
    assert_spawned_child_stopped(&work.join("queued-child.pid"));
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

struct CrashingProvider;

#[async_trait]
impl StepProvider for CrashingProvider {
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
        Err(TurnError::InjectedCrash)
    }
}

fn attempt_starts(text: &str) -> Vec<Value> {
    text.lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| event["event"]["kind"] == "assistant_attempt_started")
        .collect()
}

#[tokio::test]
async fn lost_attempt_budget_exhaustion_refuses_fresh_attempt() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let mut cfg = config(dir.path(), 3);
    cfg.config.turn.max_attempts = 1;
    let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
    let crashed = loop_
        .run_turn("crash", &CrashingProvider)
        .await
        .unwrap_err();
    assert!(matches!(crashed, TurnError::InjectedCrash));
    drop(loop_);
    let resume_provider = ScriptedProvider::new(cfg.session_dir.clone(), Vec::new());
    let mut resumed = HeadlessLoop::resume(cfg.clone()).unwrap();
    let report = resumed.continue_turn(&resume_provider).await.unwrap();
    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ProviderFailure)
    );
    assert_eq!(resume_provider.sends.load(Ordering::SeqCst), 0);
    let text = fs::read_to_string(cfg.session_dir.join("events.jsonl")).unwrap();
    assert!(text.contains("E_ATTEMPT_LOST"));
    let starts = attempt_starts(&text);
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0]["event"]["data"]["attempt_number"], json!(1));
    assert!(starts[0]["event"]["data"]["retry_of"].is_null());
    assert!(!text.contains("\"assistant_step_accepted\""));
}

#[tokio::test]
async fn lost_attempt_within_budget_starts_bounded_retry_with_linkage() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let cfg = config(dir.path(), 3);
    let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
    let crashed = loop_
        .run_turn("crash", &CrashingProvider)
        .await
        .unwrap_err();
    assert!(matches!(crashed, TurnError::InjectedCrash));
    drop(loop_);
    let resume_provider = ScriptedProvider::new(
        cfg.session_dir.clone(),
        vec![ScriptedStep {
            text: Some("recovered".into()),
            calls: Vec::new(),
            finish: FinishReason::Stop,
            usage: usage(1),
        }],
    );
    let mut resumed = HeadlessLoop::resume(cfg.clone()).unwrap();
    let report = resumed.continue_turn(&resume_provider).await.unwrap();
    assert!(report.interruption.is_none());
    assert_eq!(resume_provider.sends.load(Ordering::SeqCst), 1);
    let text = fs::read_to_string(cfg.session_dir.join("events.jsonl")).unwrap();
    assert!(text.contains("E_ATTEMPT_LOST"));
    let starts = attempt_starts(&text);
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[0]["event"]["data"]["attempt_number"], json!(1));
    assert!(starts[0]["event"]["data"]["retry_of"].is_null());
    assert_eq!(starts[1]["event"]["data"]["attempt_number"], json!(2));
    let first_id = starts[0]["attempt_id"].as_str().unwrap().to_owned();
    assert_eq!(starts[1]["event"]["data"]["retry_of"], json!(first_id));
    let events: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let accepted = events
        .iter()
        .find(|event| event["event"]["kind"] == "assistant_step_accepted")
        .unwrap();
    let superseded = events
        .iter()
        .find(|event| event["event"]["kind"] == "attempt_superseded")
        .unwrap();
    assert_eq!(
        superseded["event"]["data"]["superseded_attempt_id"],
        json!(first_id)
    );
    assert_eq!(
        superseded["event"]["data"]["replacement_attempt_id"],
        starts[1]["attempt_id"]
    );
    assert_eq!(
        superseded["event"]["data"]["replacement_accept_event_id"],
        accepted["event_id"]
    );
    assert_eq!(
        superseded["sequence"].as_u64().unwrap(),
        accepted["sequence"].as_u64().unwrap() + 1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["event"]["kind"] == "attempt_superseded")
            .count(),
        1
    );
    assert!(text.contains("\"turn_committed\""));
}

async fn assert_failed_artifact_resume(
    corrupt: impl FnOnce(&rusqlite::Connection),
    expected_code: &str,
) {
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
    let mut loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
    loop_.run_turn("print a lot", &provider).await.unwrap();
    drop(loop_);

    let events_path = cfg.session_dir.join("events.jsonl");
    let before = fs::read(&events_path).unwrap();
    assert!(String::from_utf8_lossy(&before).contains("\"storage\":\"artifact\""));
    let conn = rusqlite::Connection::open(cfg.session_dir.join("history.db")).unwrap();
    corrupt(&conn);
    drop(conn);

    // This is the headless caller shape: provider assembly/continuation occurs
    // only after resume succeeds. The spy proves failed recovery crosses
    // neither the provider nor tool-execution boundary.
    let spy = ScriptedProvider::new(cfg.session_dir.clone(), Vec::new());
    let err = match HeadlessLoop::resume(cfg.clone()) {
        Ok(mut resumed) => match resumed.continue_turn(&spy).await {
            Ok(_) => panic!("corrupt artifact recovery unexpectedly continued"),
            Err(err) => err,
        },
        Err(err) => err,
    };
    assert!(
        err.to_string().contains(expected_code),
        "stable refusal {expected_code}, got: {err}"
    );
    assert_eq!(spy.sends.load(Ordering::SeqCst), 0);
    assert_eq!(before, fs::read(&events_path).unwrap());
    assert!(!dir.path().join("work/refusal-probe").exists());
}

#[tokio::test]
async fn missing_artifact_resume_refuses_without_provider_or_tool_action() {
    assert_failed_artifact_resume(
        |conn| {
            conn.execute("DELETE FROM artifacts", []).unwrap();
            conn.execute("DELETE FROM artifact_blobs", []).unwrap();
        },
        "E_ARTIFACT_MISSING",
    )
    .await;
}

#[tokio::test]
async fn hash_mismatched_artifact_resume_refuses_without_provider_or_tool_action() {
    assert_failed_artifact_resume(
        |conn| {
            conn.execute("UPDATE artifact_blobs SET canonical_result = x'00'", [])
                .unwrap();
        },
        "E_ARTIFACT_HASH_MISMATCH",
    )
    .await;
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

#[tokio::test]
async fn request_time_guard_active_turn_too_large() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let mut cfg = config(dir.path(), 5);
    // Limit is 10 tokens so active tail (at least 38 tokens) exceeds it
    cfg.config.state.active_max_tokens = 10;

    // Create session and append a raw StateChanged event with a task
    let loop_ = HeadlessLoop::create(cfg.clone()).unwrap();
    let meta: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(cfg.session_dir.join("meta.json")).unwrap())
            .unwrap();
    let session_id = praana_core::protocol::id::SessionId::from_str_canonical(
        meta["session_id"].as_str().unwrap(),
    )
    .unwrap();
    drop(loop_);

    let mut log = praana_core::history::event_log::EventLogStore::create_or_open(
        &cfg.session_dir,
        &session_id.as_str(),
    )
    .unwrap();
    let (first_event_id, first_seq) = {
        let events = log.events().unwrap();
        (events[0].event_id, events[0].sequence)
    };
    let task_id =
        praana_core::protocol::id::StateId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FA1")
            .unwrap();
    let event_id =
        praana_core::protocol::id::EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FA2")
            .unwrap();
    log.append_event(&praana_core::protocol::events::EventEnvelope {
        schema_version: praana_core::protocol::constants::EVENT_SCHEMA_VERSION,
        event_id,
        session_id,
        sequence: log.current_sequence() + 1,
        timestamp_ms: 1_700_000_000_100,
        turn_id: None,
        attempt_id: None,
        event: praana_core::protocol::events::CanonicalEvent::StateChanged(
            praana_core::protocol::state_graph::StateChangedV1 {
                state_schema_version: 1,
                mutation_id: praana_core::protocol::id::StateMutationId::from_str_canonical(
                    "01ARZ3NDEKTSV4RRFFQ69G5FA3",
                )
                .unwrap(),
                expected_graph_sequence: first_seq,
                reason: praana_core::protocol::state_graph::StateChangeReason::ExplicitTool,
                source: praana_core::protocol::state_graph::StateSourceV1 {
                    source_kind: praana_core::protocol::state_graph::StateSourceKind::System,
                    event_id: first_event_id,
                    sequence: first_seq,
                    turn_id: None,
                    attempt_id: None,
                    tool_call_id: None,
                    artifact_id: None,
                    summary_segment_id: None,
                },
                automation: None,
                operations: vec![
                    praana_core::protocol::state_graph::StateOperationV1::Create {
                        state_id: task_id,
                        tier: praana_core::protocol::state_graph::StateTier::Active,
                        value: praana_core::protocol::state_graph::StateValueV1::Task(
                            praana_core::protocol::state_graph::TaskStateV1 {
                                title: "large active task title".into(),
                                description: None,
                                status: praana_core::protocol::state_graph::TaskStatus::Todo,
                                blocker: None,
                            },
                        ),
                    },
                ],
            },
        ),
    })
    .unwrap();
    drop(log);

    let provider = ScriptedProvider::new(cfg.session_dir.clone(), vec![]);
    let mut resumed = HeadlessLoop::resume(cfg.clone()).unwrap();
    let report = resumed.run_turn("hello", &provider).await.unwrap();
    drop(resumed);

    assert_eq!(
        report.interruption,
        Some(InterruptionReason::ActiveTurnTooLarge)
    );
    assert_eq!(provider.sends.load(Ordering::SeqCst), 0, "no provider call");

    let diag = report.diagnostic.expect("diagnostic present");
    assert_eq!(diag.code, "E_ACTIVE_TURN_TOO_LARGE");
    assert_eq!(
        diag.class,
        praana_core::protocol::errors::ErrorClass::ContextLength
    );
    assert!(!diag.retryable);

    let store = praana_core::history::event_log::EventLogStore::open(
        &cfg.session_dir,
        &session_id.as_str(),
    )
    .unwrap();
    let graph = praana_core::state::replay_state(&store).unwrap();
    let r = praana_core::state::render_state_tail(&graph);
    let after_tokens = praana_core::state::estimate_tail(&r).unwrap().total_tokens;
    let (largest_id, largest_tokens) = praana_core::state::largest_object_line(&graph).unwrap();
    let expected_msg = format!(
        "state tail {after_tokens} tokens exceeds limit 10; largest object {largest_id} {largest_tokens} tokens"
    );
    assert_eq!(diag.message, expected_msg);
    assert_eq!(largest_id, task_id);
    assert!(after_tokens > 10);
    assert!(largest_tokens > 0);

    let event_kinds: Vec<String> = fs::read_to_string(cfg.session_dir.join("events.jsonl"))
        .unwrap()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let v = serde_json::from_str::<serde_json::Value>(line).unwrap();
            v.pointer("/event/kind")
                .and_then(serde_json::Value::as_str)
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(
        event_kinds,
        vec![
            "session_started",
            "state_changed",
            "user_message_accepted",
            "turn_started",
            "turn_interrupted",
        ],
        "only turn interruption events appended; no assistant_attempt_started and no extra state_changed"
    );
}

struct ReduceOutputTestProvider {
    prepares: AtomicUsize,
    seen_tails: Mutex<Vec<String>>,
    reserve_tokens: std::sync::atomic::AtomicU64,
}

#[async_trait]
impl StepProvider for ReduceOutputTestProvider {
    fn prepare_admitted(
        &self,
        _step_index: u32,
        ctx: &praana_core::turn::PrepareContext<'_>,
    ) -> Result<praana_core::turn::PreparedStep, TurnError> {
        self.prepares.fetch_add(1, Ordering::SeqCst);
        self.seen_tails
            .lock()
            .unwrap()
            .push(ctx.state_tail.to_owned());
        let reserve = self.reserve_tokens.load(Ordering::SeqCst);
        let resolved_max_output_tokens = if reserve > 0 { reserve } else { 200 };
        let profile = praana_core::provider::profile::ModelCapabilityProfile {
            profile_version: "test-v1".into(),
            profile_source_sha256: praana_core::protocol::id::Sha256Digest::digest_bytes(
                b"test-profile",
            ),
            catalog_cache_sha256: None,
            provider: "synthetic".into(),
            protocol: "openai-chat-v1".into(),
            model_pattern: "synthetic".into(),
            model_revision: None,
            context_window_tokens: 220,
            max_output_tokens: 500,
            min_output_tokens: 50,
            reasoning_accounting:
                praana_core::provider::profile::ReasoningAccounting::IncludedInOutputLimit,
            reasoning_context:
                praana_core::provider::profile::ReasoningContextCapability::Unsupported,
            tokenizer: praana_core::provider::profile::TokenizerCapability::ConservativeGeneric {
                estimator_id: "praana-generic-unicode-15.1-v1".into(),
            },
            framing_profile_id: "adapter-estimate:generic:default:v1".into(),
            reasoning_efforts: vec![],
            parallel_tools: true,
            strict_json_schema: true,
            temperature_with_reasoning: false,
            image_input: praana_core::provider::profile::ImageInputCapability::Unsupported,
            endpoint_fingerprint: praana_core::protocol::id::Sha256Digest::digest_bytes(b"test"),
            self_compaction: praana_core::provider::profile::SelfCompactionCapability::Unvalidated,
            continuation_after_internal_request: false,
        };
        Ok(praana_core::turn::PreparedStep {
            request: PreparedRequest {
                request_body: json!({
                    "messages": [
                        {"role": "system", "content": "system prompt"},
                        {"role": "user", "content": "hi"}
                    ]
                }),
                component_bytes: std::array::from_fn(|_| Vec::new()),
            },
            profile: Some(profile),
            image_count: 0,
            resolved_max_output_tokens: Some(resolved_max_output_tokens),
            state_tail_offset: None,
        })
    }

    fn set_output_reserve(&self, tokens: u64) {
        self.reserve_tokens.store(tokens, Ordering::SeqCst);
    }

    async fn complete_step(
        &self,
        _step_index: u32,
        admitted: &AdmittedRequest,
        _cancel: &CancellationToken,
    ) -> Result<praana_core::turn::StepOutcome, TurnError> {
        let auth = admitted
            .authorize_send(admitted.body())
            .map_err(|e| praana_core::turn::TurnError::Failed(e.to_string()))?;
        Ok(praana_core::turn::StepOutcome {
            draft: AssistantDraft {
                text: Some("done".into()),
                calls: vec![],
                finish_reason: FinishReason::Stop,
                usage: usage(10),
            },
            blocks: None,
            continuation: None,
            phase: None,
            authorization: auth,
        })
    }
}

#[tokio::test]
async fn reduced_output_reprepare_reuses_state_tail() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let cfg = config(dir.path(), 5);

    let provider = ReduceOutputTestProvider {
        prepares: AtomicUsize::new(0),
        seen_tails: Mutex::new(Vec::new()),
        reserve_tokens: std::sync::atomic::AtomicU64::new(0),
    };
    let mut loop_ = HeadlessLoop::create(cfg).unwrap();
    let report = loop_.run_turn("hello", &provider).await.unwrap();

    assert!(report.interruption.is_none());
    assert_eq!(
        provider.prepares.load(Ordering::SeqCst),
        2,
        "first prepare reduced output, second prepare admitted"
    );
    let tails = provider.seen_tails.lock().unwrap();
    assert_eq!(tails.len(), 2);
    assert_eq!(
        tails[0], tails[1],
        "reduced output re-prepare reuses the same state tail R"
    );
}

fn get_session_id(session_dir: &std::path::Path) -> praana_core::protocol::id::SessionId {
    let meta: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(session_dir.join("meta.json")).unwrap()).unwrap();
    praana_core::protocol::id::SessionId::from_str_canonical(meta["session_id"].as_str().unwrap())
        .unwrap()
}

fn seed_soft_note(
    log: &mut praana_core::history::event_log::EventLogStore,
    session_id: praana_core::protocol::id::SessionId,
    state_id_str: &str,
    content: &str,
    ids: &praana_core::id::MonotonicUlidGenerator,
) -> praana_core::protocol::id::StateId {
    let events = log.events().unwrap();
    let first_seq = events[0].sequence;
    let first_event_id = events[0].event_id;
    let note_id = praana_core::protocol::id::StateId::from_str_canonical(state_id_str).unwrap();
    let event_id: praana_core::protocol::id::EventId = ids.next_id().unwrap();
    let mutation_id: praana_core::protocol::id::StateMutationId = ids.next_id().unwrap();
    log.append_event(&praana_core::protocol::events::EventEnvelope {
        schema_version: praana_core::protocol::constants::EVENT_SCHEMA_VERSION,
        event_id,
        session_id,
        sequence: log.current_sequence() + 1,
        timestamp_ms: 1_700_000_000_100,
        turn_id: None,
        attempt_id: None,
        event: praana_core::protocol::events::CanonicalEvent::StateChanged(
            praana_core::protocol::state_graph::StateChangedV1 {
                state_schema_version: 1,
                mutation_id,
                expected_graph_sequence: log.current_sequence(),
                reason: praana_core::protocol::state_graph::StateChangeReason::System,
                source: praana_core::protocol::state_graph::StateSourceV1 {
                    source_kind: praana_core::protocol::state_graph::StateSourceKind::System,
                    event_id: first_event_id,
                    sequence: first_seq,
                    turn_id: None,
                    attempt_id: None,
                    tool_call_id: None,
                    artifact_id: None,
                    summary_segment_id: None,
                },
                automation: None,
                operations: vec![
                    praana_core::protocol::state_graph::StateOperationV1::Create {
                        state_id: note_id,
                        tier: praana_core::protocol::state_graph::StateTier::Soft,
                        value: praana_core::protocol::state_graph::StateValueV1::Note(
                            praana_core::protocol::state_graph::NoteStateV1 {
                                text: content.into(),
                                tags: Vec::new(),
                            },
                        ),
                    },
                ],
            },
        ),
    })
    .unwrap();
    note_id
}

struct TailTrackingProvider {
    tails: Mutex<Vec<String>>,
    steps: Mutex<std::collections::VecDeque<ScriptedStep>>,
    fail_first_complete: AtomicBool,
}

#[async_trait]
impl StepProvider for TailTrackingProvider {
    fn prepare(&self, step_index: u32) -> Result<PreparedRequest, TurnError> {
        Ok(PreparedRequest {
            request_body: json!({"scripted": true, "step": step_index}),
            component_bytes: std::array::from_fn(|_| Vec::new()),
        })
    }

    fn prepare_admitted(
        &self,
        step_index: u32,
        ctx: &praana_core::turn::PrepareContext<'_>,
    ) -> Result<praana_core::turn::PreparedStep, TurnError> {
        self.tails.lock().unwrap().push(ctx.state_tail.to_owned());
        Ok(praana_core::turn::PreparedStep {
            request: PreparedRequest {
                request_body: json!({"scripted": true, "step": step_index}),
                component_bytes: std::array::from_fn(|_| Vec::new()),
            },
            profile: None,
            image_count: 0,
            resolved_max_output_tokens: None,
            state_tail_offset: None,
        })
    }

    async fn complete(
        &self,
        _step_index: u32,
        admitted: &AdmittedRequest,
        _cancel: &CancellationToken,
    ) -> Result<ProviderOutput, TurnError> {
        let authorization = admitted.authorize_send(admitted.body())?;
        if self.fail_first_complete.swap(false, Ordering::SeqCst) {
            return Err(TurnError::Provider(Box::new(
                praana_core::turn::ProviderFailure {
                    error: praana_core::protocol::errors::ProtocolError {
                        code: "E_TRANSPORT".into(),
                        class: praana_core::protocol::errors::ErrorClass::Transport,
                        message: "temporary retryable network glitch".into(),
                        retryable: true,
                        http_status: None,
                        retry_after_ms: Some(10),
                    },
                    emission_crossed: false,
                    observable_delta: false,
                    partial_blocks: vec![],
                    provider_response_id: None,
                    usage: usage(1),
                    may_have_completed: false,
                    cancelled: false,
                    retry_after_ms: Some(10),
                },
            )));
        }
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

#[tokio::test]
async fn auto_hydrate_placement_and_idempotency_multi_step_and_retry() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    fs::create_dir_all(&work).unwrap();
    fs::write(work.join("out.txt"), "hello world").unwrap();
    let cfg = config(dir.path(), 5);

    // Initialize session and write SessionStarted
    let loop_init = HeadlessLoop::create(cfg.clone()).unwrap();
    drop(loop_init);
    let session_id = get_session_id(&cfg.session_dir);

    // Seed soft note matching query
    let mut log = praana_core::history::event_log::EventLogStore::open(
        &cfg.session_dir,
        &session_id.as_str(),
    )
    .unwrap();
    let note_id = seed_soft_note(
        &mut log,
        session_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        "quantum algorithm optimization",
        &cfg.ids,
    );
    drop(log);

    let provider = TailTrackingProvider {
        tails: Mutex::new(Vec::new()),
        steps: Mutex::new(
            vec![
                tool_step("c1", "read_file", json!({"path": "out.txt"})),
                ScriptedStep {
                    text: Some("done".into()),
                    calls: Vec::new(),
                    finish: FinishReason::Stop,
                    usage: usage(1),
                },
            ]
            .into(),
        ),
        fail_first_complete: AtomicBool::new(true),
    };

    let mut loop_ = HeadlessLoop::resume(cfg.clone()).unwrap();
    let report = loop_
        .run_turn("quantum algorithm query", &provider)
        .await
        .unwrap();

    assert!(report.interruption.is_none());

    // Check tails:
    // Tails captured:
    // 0: step 0 attempt 1 (before failure)
    // 1: step 0 attempt 2 (retry)
    // 2: step 1 attempt 1
    let tails = provider.tails.lock().unwrap();
    assert_eq!(tails.len(), 3, "attempt 1, retry attempt 2, and step 1");
    for (i, tail) in tails.iter().enumerate() {
        assert!(
            tail.contains(&note_id.as_str()),
            "tail at {i} must carry promoted note: {tail}"
        );
    }

    // Verify event log: exactly one AutoHydrate StateChanged event
    let events = fs::read_to_string(cfg.session_dir.join("events.jsonl")).unwrap();
    let mut auto_hydrate_events = 0;
    for line in events.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line).unwrap();
        if v.pointer("/event/kind") == Some(&json!("state_changed"))
            && v.pointer("/event/data/reason") == Some(&json!("auto_hydrate"))
        {
            auto_hydrate_events += 1;
        }
    }
    assert_eq!(
        auto_hydrate_events, 1,
        "later steps and retries never re-evaluate auto-hydrate"
    );
}

#[tokio::test]
async fn auto_hydrate_off_switches_disabled_and_max_zero() {
    for off_mode in ["disabled", "max_zero"] {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("work")).unwrap();
        let mut cfg = config(dir.path(), 3);
        if off_mode == "disabled" {
            cfg.config.state.auto_hydrate = false;
            cfg.config.state.auto_hydrate_max = 5;
        } else {
            cfg.config.state.auto_hydrate = true;
            cfg.config.state.auto_hydrate_max = 0;
        }

        let loop_init = HeadlessLoop::create(cfg.clone()).unwrap();
        drop(loop_init);
        let session_id = get_session_id(&cfg.session_dir);

        let mut log = praana_core::history::event_log::EventLogStore::open(
            &cfg.session_dir,
            &session_id.as_str(),
        )
        .unwrap();
        let note_id = seed_soft_note(
            &mut log,
            session_id,
            "01ARZ3NDEKTSV4RRFFQ69G5FA1",
            "quantum algorithm optimization",
            &cfg.ids,
        );
        drop(log);

        let provider = TailTrackingProvider {
            tails: Mutex::new(Vec::new()),
            steps: Mutex::new(
                vec![ScriptedStep {
                    text: Some("done".into()),
                    calls: Vec::new(),
                    finish: FinishReason::Stop,
                    usage: usage(1),
                }]
                .into(),
            ),
            fail_first_complete: AtomicBool::new(false),
        };

        let mut loop_ = HeadlessLoop::resume(cfg.clone()).unwrap();
        let report = loop_
            .run_turn("quantum algorithm query", &provider)
            .await
            .unwrap();

        assert!(report.interruption.is_none());
        let tails = provider.tails.lock().unwrap();
        assert_eq!(tails.len(), 1);
        assert!(
            !tails[0].contains(&note_id.as_str()),
            "off switch {off_mode} must not promote soft object"
        );

        let events = fs::read_to_string(cfg.session_dir.join("events.jsonl")).unwrap();
        let auto_hydrate_events = events
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter(|l| {
                let v: Value = serde_json::from_str(l).unwrap();
                v.pointer("/event/kind") == Some(&json!("state_changed"))
                    && v.pointer("/event/data/reason") == Some(&json!("auto_hydrate"))
            })
            .count();
        assert_eq!(
            auto_hydrate_events, 0,
            "off switch {off_mode} must emit no auto_hydrate event"
        );
    }
}

#[tokio::test]
async fn auto_hydrate_cancellation_at_every_checkpoint_and_loop_abort() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let mut loop_cfg = config(dir.path(), 5);
    loop_cfg.config.state.auto_hydrate = true;
    loop_cfg.config.state.auto_hydrate_max = 5;
    let session_dir = loop_cfg.session_dir.clone();
    let workspace = loop_cfg.workspace.clone();

    let loop_init = HeadlessLoop::create(loop_cfg.clone()).unwrap();
    drop(loop_init);
    let session_id = get_session_id(&session_dir);

    let mut log =
        praana_core::history::event_log::EventLogStore::open(&session_dir, &session_id.as_str())
            .unwrap();
    seed_soft_note(
        &mut log,
        session_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        "alpha quantum algorithm",
        &loop_cfg.ids,
    );
    seed_soft_note(
        &mut log,
        session_id,
        "01ARZ3NDEKTSV4RRFFQ69G5FA2",
        "beta quantum algorithm",
        &loop_cfg.ids,
    );

    // Append a UMA event so we have a valid trigger
    let turn_id: praana_core::protocol::id::TurnId = loop_cfg.ids.next_id().unwrap();
    let message_id: praana_core::protocol::id::MessageId = loop_cfg.ids.next_id().unwrap();
    let uma_event_id: praana_core::protocol::id::EventId = loop_cfg.ids.next_id().unwrap();
    let uma = praana_core::protocol::events::EventEnvelope {
        schema_version: praana_core::protocol::constants::EVENT_SCHEMA_VERSION,
        event_id: uma_event_id,
        session_id,
        sequence: log.current_sequence() + 1,
        timestamp_ms: 1_700_000_000_200,
        turn_id: Some(turn_id),
        attempt_id: None,
        event: praana_core::protocol::events::CanonicalEvent::UserMessageAccepted(
            praana_core::protocol::events::UserMessageAccepted {
                message: praana_core::protocol::messages::UserMessage {
                    message_id,
                    turn_id,
                    blocks: vec![praana_core::protocol::messages::UserBlock::Text(
                        praana_core::protocol::messages::TextBlock {
                            text: "quantum algorithm query".into(),
                        },
                    )],
                },
            },
        ),
    };
    log.append_event(&uma).unwrap();

    let tools = praana_core::tools::builtin::production_tools(&loop_cfg.config.tools).unwrap();
    let registry = praana_core::tools::ToolRegistry::try_from_erased(tools).unwrap();
    let runtime = praana_core::tools::ToolRuntime::new(
        registry,
        loop_cfg.config.tools.clone(),
        loop_cfg.config.risk.clone(),
        loop_cfg.config.circuit.clone(),
    );
    runtime.set_workspace(workspace);
    runtime.set_session(session_dir.clone(), session_id);
    runtime.set_headless(true);
    runtime.set_state_active_max_tokens(loop_cfg.config.state.active_max_tokens);
    runtime.open_state(&log).unwrap();

    // 1. Measure total cancellation check calls until completion
    let call_count = AtomicUsize::new(0);
    let outcome = runtime
        .auto_hydrate(
            &mut log,
            &loop_cfg.ids,
            &*loop_cfg.clock,
            &|| {
                call_count.fetch_add(1, Ordering::SeqCst);
                false
            },
            &uma,
            &loop_cfg.config.state,
        )
        .unwrap();
    assert_eq!(outcome.selected_count, 2);
    let total_checks = call_count.load(Ordering::SeqCst);
    assert!(total_checks >= 5, "at least 5 cancellation checks");
    drop(log);

    // 2. For every N from 1 to total_checks, test that turning cancelled on the Nth call produces STATE_CANCELLED and NO event
    for n in 1..=total_checks {
        let dir_n = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir_n.path().join("work")).unwrap();
        let mut cfg_n = config(dir_n.path(), 5);
        cfg_n.config.state.auto_hydrate = true;
        cfg_n.config.state.auto_hydrate_max = 5;
        let sdir = cfg_n.session_dir.clone();
        let wdir = cfg_n.workspace.clone();

        let l_init = HeadlessLoop::create(cfg_n.clone()).unwrap();
        drop(l_init);
        let sid = get_session_id(&sdir);

        let mut l_log =
            praana_core::history::event_log::EventLogStore::open(&sdir, &sid.as_str()).unwrap();
        seed_soft_note(
            &mut l_log,
            sid,
            "01ARZ3NDEKTSV4RRFFQ69G5FA1",
            "alpha quantum algorithm",
            &cfg_n.ids,
        );
        seed_soft_note(
            &mut l_log,
            sid,
            "01ARZ3NDEKTSV4RRFFQ69G5FA2",
            "beta quantum algorithm",
            &cfg_n.ids,
        );

        let tid: praana_core::protocol::id::TurnId = cfg_n.ids.next_id().unwrap();
        let mid: praana_core::protocol::id::MessageId = cfg_n.ids.next_id().unwrap();
        let eid: praana_core::protocol::id::EventId = cfg_n.ids.next_id().unwrap();
        let trigger_uma = praana_core::protocol::events::EventEnvelope {
            schema_version: praana_core::protocol::constants::EVENT_SCHEMA_VERSION,
            event_id: eid,
            session_id: sid,
            sequence: l_log.current_sequence() + 1,
            timestamp_ms: 1_700_000_000_200,
            turn_id: Some(tid),
            attempt_id: None,
            event: praana_core::protocol::events::CanonicalEvent::UserMessageAccepted(
                praana_core::protocol::events::UserMessageAccepted {
                    message: praana_core::protocol::messages::UserMessage {
                        message_id: mid,
                        turn_id: tid,
                        blocks: vec![praana_core::protocol::messages::UserBlock::Text(
                            praana_core::protocol::messages::TextBlock {
                                text: "quantum algorithm query".into(),
                            },
                        )],
                    },
                },
            ),
        };
        l_log.append_event(&trigger_uma).unwrap();
        let seq_before = l_log.current_sequence();

        let t_tools = praana_core::tools::builtin::production_tools(&cfg_n.config.tools).unwrap();
        let t_reg = praana_core::tools::ToolRegistry::try_from_erased(t_tools).unwrap();
        let rt_n = praana_core::tools::ToolRuntime::new(
            t_reg,
            cfg_n.config.tools.clone(),
            cfg_n.config.risk.clone(),
            cfg_n.config.circuit.clone(),
        );
        rt_n.set_workspace(wdir);
        rt_n.set_session(sdir.clone(), sid);
        rt_n.set_headless(true);
        rt_n.set_state_active_max_tokens(cfg_n.config.state.active_max_tokens);
        rt_n.open_state(&l_log).unwrap();

        let cur_call = AtomicUsize::new(0);
        let res = rt_n.auto_hydrate(
            &mut l_log,
            &cfg_n.ids,
            &*cfg_n.clock,
            &|| {
                let c = cur_call.fetch_add(1, Ordering::SeqCst) + 1;
                c >= n
            },
            &trigger_uma,
            &cfg_n.config.state,
        );

        assert!(
            res.is_err(),
            "check {n}/{total_checks} must return Err(STATE_CANCELLED)"
        );
        assert_eq!(
            res.unwrap_err().state_code,
            "STATE_CANCELLED",
            "check {n}/{total_checks} must return STATE_CANCELLED"
        );
        assert_eq!(
            l_log.current_sequence(),
            seq_before,
            "check {n}/{total_checks} must append NO event"
        );
        drop(l_log);
    }

    // 3. Test through the loop: cancelled loop aborts with normal cancellation path and produces no auto-hydrate event
    let dir_loop = tempfile::tempdir().unwrap();
    let cfg_loop = config(dir_loop.path(), 3);
    let l_init = HeadlessLoop::create(cfg_loop.clone()).unwrap();
    drop(l_init);
    let sid = get_session_id(&cfg_loop.session_dir);

    let mut log_loop =
        praana_core::history::event_log::EventLogStore::open(&cfg_loop.session_dir, &sid.as_str())
            .unwrap();
    seed_soft_note(
        &mut log_loop,
        sid,
        "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        "quantum algorithm optimization",
        &cfg_loop.ids,
    );
    drop(log_loop);

    let provider = TailTrackingProvider {
        tails: Mutex::new(Vec::new()),
        steps: Mutex::new(
            vec![ScriptedStep {
                text: Some("done".into()),
                calls: Vec::new(),
                finish: FinishReason::Stop,
                usage: usage(1),
            }]
            .into(),
        ),
        fail_first_complete: AtomicBool::new(false),
    };

    let mut loop_ = HeadlessLoop::resume(cfg_loop.clone()).unwrap();
    loop_.cancellation_token().cancel();
    let report = loop_
        .run_turn("quantum algorithm query", &provider)
        .await
        .unwrap();

    assert_eq!(
        report.interruption,
        Some(InterruptionReason::UserAbort),
        "turn ends on normal cancellation path"
    );
    let events = fs::read_to_string(cfg_loop.session_dir.join("events.jsonl")).unwrap();
    assert!(
        !events.contains("\"reason\":\"auto_hydrate\""),
        "cancelled loop must produce no auto_hydrate event"
    );

    // 3b. Test cancellation DURING auto-hydrate evaluation through the loop:
    // loop interrupts with normal UserAbort and produces no auto_hydrate event
    struct CancellingClock {
        token: Arc<Mutex<Option<CancellationToken>>>,
        call_count: AtomicUsize,
    }
    impl Clock for CancellingClock {
        fn now_ms(&self) -> i64 {
            let count = self.call_count.fetch_add(1, Ordering::SeqCst);
            // open_turn uses calls 0 and 1 for TurnStarted and UserMessageAccepted.
            // Call 2 occurs inside commit_origin for StateChanged timestamp.
            if count >= 2 {
                if let Some(token) = self.token.lock().unwrap().as_ref() {
                    token.cancel();
                }
            }
            1_700_000_000_000 + count as i64
        }
    }

    let dir_eval = tempfile::tempdir().unwrap();
    let clock_token = Arc::new(Mutex::new(None));
    let mut cfg_eval = config(dir_eval.path(), 3);
    cfg_eval.clock = Arc::new(CancellingClock {
        token: clock_token.clone(),
        call_count: AtomicUsize::new(0),
    });
    let l_init = HeadlessLoop::create(cfg_eval.clone()).unwrap();
    drop(l_init);
    let sid = get_session_id(&cfg_eval.session_dir);

    let mut log_eval =
        praana_core::history::event_log::EventLogStore::open(&cfg_eval.session_dir, &sid.as_str())
            .unwrap();
    seed_soft_note(
        &mut log_eval,
        sid,
        "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        "quantum algorithm optimization",
        &cfg_eval.ids,
    );
    drop(log_eval);

    let mut loop_eval = HeadlessLoop::resume(cfg_eval.clone()).unwrap();
    *clock_token.lock().unwrap() = Some(loop_eval.cancellation_token());
    let report_eval = loop_eval
        .run_turn("quantum algorithm query", &provider)
        .await
        .unwrap();

    assert_eq!(
        report_eval.interruption,
        Some(InterruptionReason::UserAbort),
        "turn ends on normal cancellation path after cancellation during auto-hydrate evaluation"
    );
    let events_eval = fs::read_to_string(cfg_eval.session_dir.join("events.jsonl")).unwrap();
    assert!(
        !events_eval.contains("\"reason\":\"auto_hydrate\""),
        "cancellation during evaluation must produce no auto_hydrate event"
    );
}

#[tokio::test]
async fn auto_hydrate_controller_failure_durability_on_fsync() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("work")).unwrap();
    let cfg = config(dir.path(), 3);
    let l_init = HeadlessLoop::create(cfg.clone()).unwrap();
    drop(l_init);
    let sid = get_session_id(&cfg.session_dir);

    let mut log =
        praana_core::history::event_log::EventLogStore::open(&cfg.session_dir, &sid.as_str())
            .unwrap();
    seed_soft_note(
        &mut log,
        sid,
        "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        "quantum algorithm optimization",
        &cfg.ids,
    );
    drop(log);

    let provider = TailTrackingProvider {
        tails: Mutex::new(Vec::new()),
        steps: Mutex::new(
            vec![ScriptedStep {
                text: Some("done".into()),
                calls: Vec::new(),
                finish: FinishReason::Stop,
                usage: usage(1),
            }]
            .into(),
        ),
        fail_first_complete: AtomicBool::new(false),
    };

    let mut loop_ = HeadlessLoop::resume(cfg.clone()).unwrap();
    // 2 successful fsyncs for TurnStarted and UserMessageAccepted, then fail on StateChanged append
    praana_core::history::event_log::fail_after_n_successful_fsyncs(2);
    let err = loop_
        .run_turn("quantum algorithm query", &provider)
        .await
        .unwrap_err();
    praana_core::history::event_log::reset_fsync_injection();

    assert!(
        matches!(err, TurnError::Durability(_)),
        "STATE_PERSISTENCE/unhealthy-log must map to TurnError::Durability, got {err:?}"
    );

    let in_memory_kinds = loop_.event_kinds().unwrap();
    assert_eq!(
        in_memory_kinds.last().map(|s| s.as_str()),
        Some("turn_started"),
        "log must end right after TurnStarted, got: {in_memory_kinds:?}"
    );
    assert!(
        !in_memory_kinds
            .iter()
            .any(|k| k == "assistant_attempt_started"),
        "log must contain no AssistantAttemptStarted"
    );
    assert_eq!(
        in_memory_kinds
            .iter()
            .filter(|k| *k == "state_changed")
            .count(),
        1,
        "log must contain no auto_hydrate event"
    );

    drop(loop_);
    let durable_log =
        praana_core::history::event_log::EventLogStore::open(&cfg.session_dir, &sid.as_str())
            .unwrap();
    let events = durable_log.events().unwrap();
    assert!(
        !events.iter().any(|e| {
            matches!(
                e.event,
                praana_core::protocol::events::CanonicalEvent::AssistantAttemptStarted(_)
            )
        }),
        "disk log must contain no AssistantAttemptStarted"
    );
    let last = events.last().unwrap();
    assert!(
        matches!(
            &last.event,
            praana_core::protocol::events::CanonicalEvent::StateChanged(sc)
                if sc.reason == praana_core::protocol::state_graph::StateChangeReason::AutoHydrate
        ),
        "the event whose fsync failed must be the auto-hydrate StateChanged, got: {last:?}"
    );
}

#[tokio::test]
async fn auto_hydrate_placement_attempt_blocks_assistant_step_not_compaction() {
    use praana_core::protocol::constants::EVENT_SCHEMA_VERSION;
    use praana_core::protocol::events::{
        AssistantAttemptStarted, AssistantStepPurpose, CanonicalEvent, CompactionPurpose,
        EventEnvelope, ProviderAttemptPurpose, TurnStarted, UserMessageAccepted,
    };
    use praana_core::protocol::id::{
        AttemptId, CompactionId, EventId, MessageId, Sha256Digest, StepId, TurnId,
    };
    use praana_core::protocol::messages::{TextBlock, UserBlock, UserMessage};
    use praana_core::protocol::models::{AdmissionSnapshot, ModelSelection, ReasoningEffort};

    let test_model = ModelSelection {
        provider: "openai".into(),
        protocol: "openai-responses-v1".into(),
        model: "gpt-5".into(),
        model_revision: None,
        model_family: "gpt-5".into(),
        endpoint_fingerprint: Sha256Digest::digest_bytes(b"endpoint"),
        reasoning_effort: ReasoningEffort::Medium,
    };
    let test_admission = AdmissionSnapshot {
        token_estimator_schema_version: 1,
        estimator_id: "generic".into(),
        estimated_input_sha256: Sha256Digest::digest_bytes(b"input"),
        context_window_tokens: 128_000,
        estimated_input_tokens: 0,
        resolved_output_tokens: 0,
        requested_reasoning_tokens: 0,
        safety_margin_tokens: 0,
        projected_fill_millionths: 0,
        capability_profile_hash: Sha256Digest::digest_bytes(b"profile"),
        estimate_reused_from_attempt_id: None,
    };

    // Case 1: Compaction attempt (turn_id is None) does NOT block auto-hydrate
    let dir1 = tempfile::tempdir().unwrap();
    let cfg1 = config(dir1.path(), 3);
    let l1_init = HeadlessLoop::create(cfg1.clone()).unwrap();
    drop(l1_init);
    let sid1 = get_session_id(&cfg1.session_dir);

    let mut log1 =
        praana_core::history::event_log::EventLogStore::open(&cfg1.session_dir, &sid1.as_str())
            .unwrap();
    let note_id = seed_soft_note(
        &mut log1,
        sid1,
        "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        "quantum algorithm optimization",
        &cfg1.ids,
    );
    let turn1_id = TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FT1").unwrap();
    // Start turn with UserMessageAccepted, TurnStarted, and Compaction attempt
    log1.append_event(&EventEnvelope {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FE1").unwrap(),
        session_id: sid1,
        sequence: log1.current_sequence() + 1,
        timestamp_ms: 1_700_000_000_100,
        turn_id: Some(turn1_id),
        attempt_id: None,
        event: CanonicalEvent::UserMessageAccepted(UserMessageAccepted {
            message: UserMessage {
                message_id: MessageId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FM1").unwrap(),
                turn_id: turn1_id,
                blocks: vec![UserBlock::Text(TextBlock {
                    text: "quantum algorithm query".into(),
                })],
            },
        }),
    })
    .unwrap();
    log1.append_event(&EventEnvelope {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FE2").unwrap(),
        session_id: sid1,
        sequence: log1.current_sequence() + 1,
        timestamp_ms: 1_700_000_000_200,
        turn_id: Some(turn1_id),
        attempt_id: None,
        event: CanonicalEvent::TurnStarted(TurnStarted {
            turn_index: 1,
            user_message_id: MessageId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FM1").unwrap(),
            model: test_model.clone(),
            toolset_hash: Sha256Digest::digest_bytes(b"toolset"),
            max_steps: 10,
        }),
    })
    .unwrap();
    // Compaction attempt (null turn_id)
    let comp_attempt_id = AttemptId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB1").unwrap();
    log1.append_event(&EventEnvelope {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FE3").unwrap(),
        session_id: sid1,
        sequence: log1.current_sequence() + 1,
        timestamp_ms: 1_700_000_000_300,
        turn_id: None,
        attempt_id: Some(comp_attempt_id),
        event: CanonicalEvent::AssistantAttemptStarted(AssistantAttemptStarted {
            purpose: ProviderAttemptPurpose::Compaction(CompactionPurpose {
                compaction_id: CompactionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FC1")
                    .unwrap(),
                epoch: 1,
            }),
            attempt_number: 1,
            model: test_model.clone(),
            request_hash: Sha256Digest::digest_bytes(b"req1"),
            admission: test_admission.clone(),
            retry_of: None,
            emergency_context_retry: false,
            recovery_notices: vec![],
        }),
    })
    .unwrap();
    drop(log1);

    let provider1 = TailTrackingProvider {
        tails: Mutex::new(Vec::new()),
        steps: Mutex::new(
            vec![ScriptedStep {
                text: Some("done".into()),
                calls: Vec::new(),
                finish: FinishReason::Stop,
                usage: usage(1),
            }]
            .into(),
        ),
        fail_first_complete: AtomicBool::new(false),
    };

    let mut loop1 = HeadlessLoop::resume(cfg1.clone()).unwrap();
    let report1 = loop1.continue_turn(&provider1).await.unwrap();
    assert!(report1.interruption.is_none());
    let tails1 = provider1.tails.lock().unwrap().clone();
    assert_eq!(tails1.len(), 1);
    assert!(
        tails1[0].contains(&note_id.as_str()),
        "compaction attempt must NOT block auto-hydration; note must be in tail"
    );

    // Case 2: AssistantStep attempt for current turn DOES block auto-hydrate
    let dir2 = tempfile::tempdir().unwrap();
    let cfg2 = config(dir2.path(), 3);
    let l2_init = HeadlessLoop::create(cfg2.clone()).unwrap();
    drop(l2_init);
    let sid2 = get_session_id(&cfg2.session_dir);

    let mut log2 =
        praana_core::history::event_log::EventLogStore::open(&cfg2.session_dir, &sid2.as_str())
            .unwrap();
    let note2_id = seed_soft_note(
        &mut log2,
        sid2,
        "01ARZ3NDEKTSV4RRFFQ69G5FA1",
        "quantum algorithm optimization",
        &cfg2.ids,
    );
    let turn2_id = TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FT2").unwrap();
    log2.append_event(&EventEnvelope {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FE4").unwrap(),
        session_id: sid2,
        sequence: log2.current_sequence() + 1,
        timestamp_ms: 1_700_000_000_100,
        turn_id: Some(turn2_id),
        attempt_id: None,
        event: CanonicalEvent::UserMessageAccepted(UserMessageAccepted {
            message: UserMessage {
                message_id: MessageId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FM2").unwrap(),
                turn_id: turn2_id,
                blocks: vec![UserBlock::Text(TextBlock {
                    text: "quantum algorithm query".into(),
                })],
            },
        }),
    })
    .unwrap();
    log2.append_event(&EventEnvelope {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FE5").unwrap(),
        session_id: sid2,
        sequence: log2.current_sequence() + 1,
        timestamp_ms: 1_700_000_000_200,
        turn_id: Some(turn2_id),
        attempt_id: None,
        event: CanonicalEvent::TurnStarted(TurnStarted {
            turn_index: 1,
            user_message_id: MessageId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FM2").unwrap(),
            model: test_model.clone(),
            toolset_hash: Sha256Digest::digest_bytes(b"toolset"),
            max_steps: 10,
        }),
    })
    .unwrap();
    // AssistantStep attempt started for this turn
    let attempt_id2 = AttemptId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB2").unwrap();
    log2.append_event(&EventEnvelope {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FE6").unwrap(),
        session_id: sid2,
        sequence: log2.current_sequence() + 1,
        timestamp_ms: 1_700_000_000_300,
        turn_id: Some(turn2_id),
        attempt_id: Some(attempt_id2),
        event: CanonicalEvent::AssistantAttemptStarted(AssistantAttemptStarted {
            purpose: ProviderAttemptPurpose::AssistantStep(AssistantStepPurpose {
                step_id: StepId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FS1").unwrap(),
                step_index: 0,
            }),
            attempt_number: 1,
            model: test_model.clone(),
            request_hash: Sha256Digest::digest_bytes(b"req2"),
            admission: test_admission.clone(),
            retry_of: None,
            emergency_context_retry: false,
            recovery_notices: vec![],
        }),
    })
    .unwrap();
    drop(log2);

    let provider2 = TailTrackingProvider {
        tails: Mutex::new(Vec::new()),
        steps: Mutex::new(
            vec![ScriptedStep {
                text: Some("done".into()),
                calls: Vec::new(),
                finish: FinishReason::Stop,
                usage: usage(1),
            }]
            .into(),
        ),
        fail_first_complete: AtomicBool::new(false),
    };

    let mut loop2 = HeadlessLoop::resume(cfg2.clone()).unwrap();
    let report2 = loop2.continue_turn(&provider2).await.unwrap();
    assert!(report2.interruption.is_none());
    let tails2 = provider2.tails.lock().unwrap();
    assert_eq!(tails2.len(), 1);
    assert!(
        !tails2[0].contains(&note2_id.as_str()),
        "AssistantStep attempt must block auto-hydration; note must NOT be in tail"
    );
    let events2 = fs::read_to_string(cfg2.session_dir.join("events.jsonl")).unwrap();
    assert!(
        !events2.contains("\"reason\":\"auto_hydrate\""),
        "AssistantStep attempt must block auto_hydrate event emission"
    );
}
