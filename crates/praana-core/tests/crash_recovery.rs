//! Fresh-process abort/recovery matrix for the P3 headless loop.
//!
//! The provider assembles every scripted response through the OpenAI chat
//! streaming adapter. Tool IDs, names, and JSON arguments arrive in separate,
//! interleaved stream fragments. The mutating shell writes an independent
//! workspace ledger, while provider invocations use a second ledger.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use praana_core::clock::{Clock, ThreadSleeper};
use praana_core::config::build_defaults;
use praana_core::id::{IdGenerationError, MonotonicUlidGenerator, RandomSource};
use praana_core::protocol::events::{CanonicalEvent, EventEnvelope};
use praana_core::protocol::hashes::calculate_result_messages_hash;
use praana_core::protocol::messages::FinishReason;
use praana_core::protocol::models::ProviderUsage;
use praana_core::provider::openai::parse_chat_stream;
use praana_core::turn::{
    AdmittedRequest, AssistantDraft, DraftCall, HeadlessLoop, LoopConfig, LoopFault,
    PreparedRequest, ProviderOutput, ScriptedStep, StepProvider, TurnError,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

const AWS_CANARY: &str = "AKIACCCCCCCCCCCCCCCC";

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

fn config_with_seed(root: PathBuf, seed: u128) -> LoopConfig {
    let mut effective = build_defaults(PathBuf::from("/praana-home").as_path());
    effective.llm.context_window = 128_000;
    effective.llm.provider = "scripted".into();
    effective.llm.protocol = "scripted-v1".into();
    effective.llm.model = "fake".into();
    effective.history.safety_margin_min_tokens = 0;
    effective.history.safety_margin_ratio = 0.0;
    effective.history.artifact_inline_tokens = 1;
    effective.history.artifact_batch_inline_tokens = 1;
    effective.tools.shell_enabled = true;
    effective.tools.max_parallel_calls = 1;
    effective.turn.max_steps = 6;
    effective.turn.max_attempts = 3;
    LoopConfig {
        session_dir: root.join("session"),
        workspace: root.join("work"),
        config: effective,
        clock: Arc::new(FixedClock(1_700_000_000_000)),
        ids: Arc::new(MonotonicUlidGenerator::new(
            Arc::new(FixedClock(1_700_000_000_000)),
            Arc::new(ThreadSleeper),
            Box::new(SeqRandom(seed)),
        )),
        fault: LoopFault::None,
    }
}

fn config(root: PathBuf) -> LoopConfig {
    config_with_seed(root, 1)
}

fn resume_config(root: PathBuf) -> LoopConfig {
    // Production uses entropy. Fresh subprocesses offset this deterministic
    // source so newly appended event IDs cannot collide with the seed process.
    config_with_seed(root, (std::process::id() as u128) * 1_000_000 + 1_000)
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

fn args(value: Value) -> serde_json::Map<String, Value> {
    value.as_object().cloned().unwrap()
}

fn standard_steps() -> Vec<ScriptedStep> {
    #[cfg(windows)]
    let ledger_command = "echo hit>>ledger.log";
    #[cfg(not(windows))]
    let ledger_command = "printf 'hit\\n' >> ledger.log";
    #[cfg(windows)]
    let big_command = format!("echo {}", "a".repeat(5000));
    #[cfg(not(windows))]
    let big_command = "yes a | head -c 5000".to_owned();
    vec![
        ScriptedStep {
            text: None,
            calls: vec![
                DraftCall {
                    call_id: "call-ledger".into(),
                    name: "shell".into(),
                    arguments: args(json!({
                        "command": ledger_command,
                        "timeout_ms": 5000
                    })),
                },
                DraftCall {
                    call_id: "call-ledger-peer".into(),
                    name: "read_file".into(),
                    arguments: args(json!({"path": "a.txt"})),
                },
            ],
            finish: FinishReason::ToolUse,
            usage: usage(3),
        },
        ScriptedStep {
            text: None,
            calls: vec![DraftCall {
                call_id: "call-big".into(),
                name: "shell".into(),
                arguments: args(json!({
                    "command": big_command,
                    "timeout_ms": 5000
                })),
            }],
            finish: FinishReason::ToolUse,
            usage: usage(3),
        },
        ScriptedStep {
            text: None,
            calls: vec![
                DraftCall {
                    call_id: "call-a".into(),
                    name: "read_file".into(),
                    arguments: args(json!({"path": "a.txt"})),
                },
                DraftCall {
                    call_id: "call-b".into(),
                    name: "read_file".into(),
                    arguments: args(json!({"path": "b.txt"})),
                },
            ],
            finish: FinishReason::ToolUse,
            usage: usage(2),
        },
        ScriptedStep {
            text: Some("done".into()),
            calls: Vec::new(),
            finish: FinishReason::Stop,
            usage: usage(1),
        },
    ]
}

fn marked_steps() -> Vec<ScriptedStep> {
    vec![
        ScriptedStep {
            text: None,
            calls: vec![DraftCall {
                call_id: "call-marked".into(),
                name: "shell".into(),
                arguments: args(json!({
                    "command": format!(
                        "TOKEN={AWS_CANARY}; printf 'marked\\n' >> marked-ledger.log"
                    ),
                    "timeout_ms": 5000
                })),
            }],
            finish: FinishReason::ToolUse,
            usage: usage(2),
        },
        ScriptedStep {
            text: Some("done".into()),
            calls: Vec::new(),
            finish: FinishReason::Stop,
            usage: usage(1),
        },
    ]
}

fn mixed_marked_steps() -> Vec<ScriptedStep> {
    #[cfg(windows)]
    let ledger_command = "echo hit>>ledger.log";
    #[cfg(not(windows))]
    let ledger_command = "printf 'hit\\n' >> ledger.log";
    let mut steps = marked_steps();
    steps[0].calls.insert(
        0,
        DraftCall {
            call_id: "call-safe".into(),
            name: "shell".into(),
            arguments: args(json!({"command": ledger_command, "timeout_ms": 5000})),
        },
    );
    steps
}

fn scenario_steps(scenario: &str) -> Vec<ScriptedStep> {
    match scenario {
        "batch-edit-validation" => vec![
            ScriptedStep {
                text: None,
                calls: vec![DraftCall {
                    call_id: "read-before-edit".into(),
                    name: "read_file".into(),
                    arguments: args(json!({"path": "a.txt"})),
                }],
                finish: FinishReason::ToolUse,
                usage: usage(1),
            },
            ScriptedStep {
                text: None,
                calls: vec![DraftCall {
                    call_id: "batch-edit-validation".into(),
                    name: "batch_edit".into(),
                    arguments: args(json!({"edits": [
                        {"path": "a.txt", "old_text": "A", "new_text": "B"},
                        {"path": "a.txt", "old_text": "B", "new_text": "C"}
                    ]})),
                }],
                finish: FinishReason::ToolUse,
                usage: usage(1),
            },
        ],
        "marked" => marked_steps(),
        "mixed-marked" => mixed_marked_steps(),
        "standard" | "fragment-crash" => standard_steps(),
        other => panic!("unknown scenario {other}"),
    }
}

#[test]
fn crash_during_batch_edit_validation_leaves_workspace_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let point = "batch_edit.after_validation_stage@1";
    let output = spawn_child(
        root.path(),
        "child_seed_and_crash",
        "seed-and-crash",
        "batch-edit-validation",
        Some(point),
        false,
    );
    assert_abort(&output, point);
    let work = root.path().join("work");
    assert_eq!(std::fs::read(work.join("a.txt")).unwrap(), b"A");
    assert_eq!(std::fs::read(work.join("b.txt")).unwrap(), b"B");
    assert_eq!(
        std::fs::read_to_string(work.join("provider.log")).unwrap(),
        "0\n1\n"
    );
    let names: BTreeSet<_> = std::fs::read_dir(&work)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        names,
        BTreeSet::from(["a.txt".into(), "b.txt".into(), "provider.log".into()])
    );
}

fn push_sse(bytes: &mut Vec<u8>, value: Value) {
    bytes.extend_from_slice(b"data: ");
    bytes.extend_from_slice(serde_json::to_string(&value).unwrap().as_bytes());
    bytes.extend_from_slice(b"\n\n");
}

/// Route a complete logical step through the real fragmented tool-call parser.
fn fragmented_step(step: &ScriptedStep) -> ScriptedStep {
    let mut stream = Vec::new();
    if step.calls.is_empty() {
        for fragment in ["do", "ne"] {
            push_sse(
                &mut stream,
                json!({"choices":[{"delta":{"content":fragment},"finish_reason":null}]}),
            );
        }
        push_sse(
            &mut stream,
            json!({"choices":[{"delta":{},"finish_reason":"stop"}]}),
        );
    } else {
        let encoded: Vec<String> = step
            .calls
            .iter()
            .map(|call| serde_json::to_string(&call.arguments).unwrap())
            .collect();
        let split: Vec<Vec<&str>> = encoded
            .iter()
            .map(|raw| {
                let first = (raw.len() / 3).max(1);
                let second = ((raw.len() * 2) / 3).max(first).min(raw.len());
                vec![&raw[..first], &raw[first..second], &raw[second..]]
            })
            .collect();
        for (index, call) in step.calls.iter().enumerate() {
            push_sse(
                &mut stream,
                json!({"choices":[{"delta":{"tool_calls":[{
                    "index": index,
                    "id": call.call_id,
                    "function":{"name":call.name,"arguments":split[index][0]}
                }]},"finish_reason":null}]}),
            );
        }
        // Interleave the remaining argument fragments for parallel calls.
        for fragment_index in [1usize, 2] {
            for (index, fragments) in split.iter().enumerate() {
                if fragments[fragment_index].is_empty() {
                    continue;
                }
                push_sse(
                    &mut stream,
                    json!({"choices":[{"delta":{"tool_calls":[{
                        "index": index,
                        "function":{"arguments":fragments[fragment_index]}
                    }]},"finish_reason":null}]}),
                );
            }
        }
        push_sse(
            &mut stream,
            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
        );
    }
    stream.extend_from_slice(b"data: [DONE]\n\n");
    let parsed = parse_chat_stream(&stream).expect("fragmented fake stream");
    let calls = parsed
        .tool_calls
        .into_iter()
        .map(|call| DraftCall {
            call_id: call.call_id.to_string(),
            name: call.name,
            arguments: call.arguments,
        })
        .collect();
    ScriptedStep {
        text: step.text.clone(),
        calls,
        finish: parsed.finish_reason,
        usage: step.usage.clone(),
    }
}

struct FragmentedScenarioProvider {
    root: PathBuf,
    scenario: String,
}

impl FragmentedScenarioProvider {
    fn new(root: PathBuf, scenario: &str) -> Self {
        Self {
            root,
            scenario: scenario.to_owned(),
        }
    }
}

#[async_trait]
impl StepProvider for FragmentedScenarioProvider {
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
        let authorization = admitted.authorize_send(admitted.body())?;
        let mut ledger = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join("work").join("provider.log"))
            .unwrap();
        writeln!(ledger, "{step_index}").unwrap();
        ledger.sync_all().unwrap();
        if self.scenario == "fragment-crash"
            && step_index == 0
            && std::env::var("PRAANA_CRASH_POINT").as_deref()
                == Ok("provider.after_first_tool_argument_fragment@1")
        {
            // Feed one incomplete tool-argument frame through the real adapter
            // before dying. The transport audit file is deliberately outside
            // canonical History; recovery must not promote it to acceptance.
            let mut partial_stream = Vec::new();
            push_sse(
                &mut partial_stream,
                json!({"choices":[{"delta":{"tool_calls":[{
                    "index": 0,
                    "id": "call-ledger",
                    "function":{"name":"shell","arguments":"{\\\"command\\\":\\\"printf"}
                }]},"finish_reason":null}]}),
            );
            assert!(parse_chat_stream(&partial_stream).is_err());
            let mut fragments = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.root.join("work/provider-fragments.log"))
                .unwrap();
            writeln!(fragments, "call-ledger:{{\"command\":\"printf").unwrap();
            fragments.sync_all().unwrap();
            std::process::abort();
        }
        let steps = scenario_steps(&self.scenario);
        let step = fragmented_step(
            steps
                .get(step_index as usize)
                .unwrap_or_else(|| panic!("missing scripted step {step_index}")),
        );
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

fn setup_work(root: &Path) {
    let work = root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(work.join("a.txt"), "A").unwrap();
    std::fs::write(work.join("b.txt"), "B").unwrap();
}

fn line_count(path: &Path) -> usize {
    std::fs::read_to_string(path)
        .map(|text| text.lines().count())
        .unwrap_or(0)
}

fn read_envelopes(root: &Path) -> Vec<EventEnvelope> {
    let text = std::fs::read_to_string(root.join("session/events.jsonl")).unwrap();
    text.lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn arm_from_env() {
    if let Ok(point) = std::env::var("PRAANA_CRASH_POINT") {
        praana_core::arm_test_failpoint(&point).expect("arm one child failpoint");
    }
}

#[cfg(windows)]
#[test]
fn child_panics_instead_of_aborting() {
    if std::env::var("PRAANA_CRASH_ROOT").is_ok() {
        panic!("ordinary test failure, not a process abort");
    }
}

#[cfg(windows)]
#[test]
fn child_aborts_now() {
    if std::env::var_os("PRAANA_CRASH_ROOT").is_some() {
        std::process::abort();
    }
}

#[cfg(windows)]
#[test]
fn windows_abort_identity_accepts_real_abort() {
    let root = tempfile::tempdir().unwrap();
    let output = spawn_child(
        root.path(),
        "child_aborts_now",
        "none",
        "standard",
        None,
        false,
    );
    assert_abort(&output, "real Windows abort without History initialization");
}

#[cfg(windows)]
#[test]
fn windows_abort_identity_rejects_regular_panic() {
    let root = tempfile::tempdir().unwrap();
    let output = spawn_child(
        root.path(),
        "child_panics_instead_of_aborting",
        "none",
        "standard",
        None,
        false,
    );
    assert_eq!(output.status.code(), Some(101));
    assert_ne!(
        output.status.code().map(|code| code as u32),
        Some(0xC000_0409)
    );
}

#[test]
fn child_no_environment_arming() {
    let Ok(root) = std::env::var("PRAANA_CRASH_ROOT") else {
        return;
    };
    // Intentionally do not call arm_from_env().
    HeadlessLoop::create(config(PathBuf::from(root))).unwrap();
}

#[test]
fn child_aborts_after_session_started_write() {
    let Ok(root) = std::env::var("PRAANA_CRASH_ROOT") else {
        return;
    };
    arm_from_env();
    let _ = HeadlessLoop::create(config(PathBuf::from(root)));
}

#[test]
fn child_resumes_session_started_prefix() {
    let Ok(root) = std::env::var("PRAANA_CRASH_ROOT") else {
        return;
    };
    HeadlessLoop::resume(resume_config(PathBuf::from(root)))
        .expect("valid durable session_started prefix must resume");
}

#[test]
fn child_seed_and_crash() {
    let Ok(root) = std::env::var("PRAANA_CRASH_ROOT") else {
        return;
    };
    if std::env::var("PRAANA_CRASH_MODE").as_deref() != Ok("seed-and-crash") {
        return;
    }
    arm_from_env();
    let scenario = std::env::var("PRAANA_SCENARIO").unwrap();
    let root = PathBuf::from(root);
    setup_work(&root);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let mut loop_ = HeadlessLoop::create(config(root.clone())).unwrap();
        let provider = FragmentedScenarioProvider::new(root, &scenario);
        let _ = loop_.run_turn("matrix turn", &provider).await;
    });
}

#[test]
fn child_resume_and_finish() {
    let Ok(root) = std::env::var("PRAANA_CRASH_ROOT") else {
        return;
    };
    if std::env::var("PRAANA_CRASH_MODE").as_deref() != Ok("resume-and-finish") {
        return;
    }
    arm_from_env();
    let expect_active = std::env::var("PRAANA_EXPECT_ACTIVE").as_deref() == Ok("1");
    let scenario = std::env::var("PRAANA_SCENARIO").unwrap();
    let root = PathBuf::from(root);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        let mut loop_ = HeadlessLoop::resume(resume_config(root.clone())).unwrap();
        let provider = FragmentedScenarioProvider::new(root, &scenario);
        match (expect_active, loop_.continue_turn(&provider).await) {
            (true, Ok(_)) => {}
            (true, Err(err)) => panic!("active recovery did not finish: {err}"),
            (false, Err(err)) if err.to_string().contains("no active turn") => {}
            (false, Ok(_)) => panic!("terminal recovery unexpectedly had active work"),
            (false, Err(err)) => panic!("terminal recovery failed: {err}"),
        }
    });
}

#[test]
fn child_resume_idempotently() {
    let Ok(root) = std::env::var("PRAANA_CRASH_ROOT") else {
        return;
    };
    if std::env::var("PRAANA_CRASH_MODE").as_deref() != Ok("resume-idempotently") {
        return;
    }
    HeadlessLoop::resume(resume_config(PathBuf::from(root))).unwrap();
}

fn spawn_child(
    root: &Path,
    test: &str,
    mode: &str,
    scenario: &str,
    point: Option<&str>,
    expect_active: bool,
) -> std::process::Output {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test])
        .env("PRAANA_CRASH_ROOT", root)
        .env("PRAANA_CRASH_MODE", mode)
        .env("PRAANA_SCENARIO", scenario)
        .env(
            "PRAANA_EXPECT_ACTIVE",
            if expect_active { "1" } else { "0" },
        );
    match point {
        Some(point) => {
            command.env("PRAANA_CRASH_POINT", point);
        }
        None => {
            command.env_remove("PRAANA_CRASH_POINT");
        }
    }
    command.output().unwrap()
}

fn assert_abort(output: &std::process::Output, point: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            output.status.signal(),
            Some(libc::SIGABRT),
            "child at {point} must abort; stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(windows)]
    {
        // Rust std::process::abort uses __fastfail(FAST_FAIL_FATAL_APP_EXIT)
        // on Windows (NTSTATUS STATUS_STACK_BUFFER_OVERRUN). An ordinary
        // test panic/failed assertion exits 101 instead and must not pass.
        const FAST_FAIL_EXIT: u32 = 0xC000_0409;
        assert_eq!(
            output.status.code().map(|code| code as u32),
            Some(FAST_FAIL_EXIT),
            "child at {point} did not fast-fail; stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(not(any(unix, windows)))]
    compile_error!("crash matrix requires a platform-specific abort identity check");
}

#[derive(Clone, Copy)]
struct ExpectedCall {
    id: &'static str,
    status: &'static str,
    started: bool,
    recovered: bool,
}

const NORMAL: &[ExpectedCall] = &[
    ExpectedCall {
        id: "call-ledger",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-ledger-peer",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-big",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-a",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-b",
        status: "success",
        started: true,
        recovered: false,
    },
];

const MUTATION_UNCERTAIN: &[ExpectedCall] = &[
    ExpectedCall {
        id: "call-ledger",
        status: "uncertain",
        started: true,
        recovered: true,
    },
    ExpectedCall {
        id: "call-ledger-peer",
        status: "skipped",
        started: false,
        recovered: false,
    },
    ExpectedCall {
        id: "call-big",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-a",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-b",
        status: "success",
        started: true,
        recovered: false,
    },
];

const BOTH_STARTED_UNCERTAIN: &[ExpectedCall] = &[
    ExpectedCall {
        id: "call-ledger",
        status: "uncertain",
        started: true,
        recovered: true,
    },
    ExpectedCall {
        id: "call-ledger-peer",
        status: "uncertain",
        started: true,
        recovered: true,
    },
    ExpectedCall {
        id: "call-big",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-a",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-b",
        status: "success",
        started: true,
        recovered: false,
    },
];

const FIRST_FINISHED_SECOND_UNCERTAIN: &[ExpectedCall] = &[
    ExpectedCall {
        id: "call-ledger",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-ledger-peer",
        status: "uncertain",
        started: true,
        recovered: true,
    },
    ExpectedCall {
        id: "call-big",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-a",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-b",
        status: "success",
        started: true,
        recovered: false,
    },
];

const FIRST_RECOVERED_SECOND_UNCERTAIN: &[ExpectedCall] = &[
    ExpectedCall {
        id: "call-ledger",
        status: "success",
        started: true,
        recovered: true,
    },
    ExpectedCall {
        id: "call-ledger-peer",
        status: "uncertain",
        started: true,
        recovered: true,
    },
    ExpectedCall {
        id: "call-big",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-a",
        status: "success",
        started: true,
        recovered: false,
    },
    ExpectedCall {
        id: "call-b",
        status: "success",
        started: true,
        recovered: false,
    },
];

const MARKED_CANCELLED: &[ExpectedCall] = &[ExpectedCall {
    id: "call-marked",
    status: "cancelled",
    started: false,
    recovered: false,
}];

const MIXED_MARKED: &[ExpectedCall] = &[
    ExpectedCall {
        id: "call-safe",
        status: "success",
        started: true,
        recovered: false,
    },
    MARKED_CANCELLED[0],
];

fn assert_exact_final_state(root: &Path, scenario: &str, expected: &[ExpectedCall], ledger: usize) {
    assert_eq!(line_count(&root.join("work/ledger.log")), ledger);
    assert_eq!(
        line_count(&root.join("work/marked-ledger.log")),
        0,
        "marked durable arguments must never execute"
    );
    let expected_provider_steps = match scenario {
        "marked" | "mixed-marked" => vec!["0", "1"],
        "fragment-crash" => vec!["0", "0", "1", "2", "3"],
        _ => vec!["0", "1", "2", "3"],
    };
    let provider_steps: Vec<_> = std::fs::read_to_string(root.join("work/provider.log"))
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(provider_steps, expected_provider_steps);

    let events = read_envelopes(root);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.event, CanonicalEvent::SessionStarted(_)))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.event, CanonicalEvent::TurnCommitted(_)))
            .count(),
        1
    );
    assert!(!events
        .iter()
        .any(|event| matches!(event.event, CanonicalEvent::TurnInterrupted(_))));

    let mut accepted_calls = BTreeSet::new();
    for event in &events {
        if let CanonicalEvent::AssistantStepAccepted(accepted) = &event.event {
            for block in &accepted.message.blocks {
                if let praana_core::protocol::messages::AssistantBlock::ToolCall(call) = block {
                    assert!(accepted_calls.insert(call.call_id.to_string()));
                    if call.call_id.as_str() == "call-marked" {
                        assert!(call.raw_arguments.contains("[REDACTED:aws-access-key]"));
                        assert!(!call.raw_arguments.contains(AWS_CANARY));
                    }
                }
            }
        }
    }
    assert_eq!(
        accepted_calls,
        expected.iter().map(|item| item.id.to_owned()).collect()
    );

    let starts: BTreeMap<_, _> = events
        .iter()
        .filter_map(|event| match &event.event {
            CanonicalEvent::ToolExecutionStarted(start) => Some((
                start.call_id.to_string(),
                (event.event_id, start.execution_id),
            )),
            _ => None,
        })
        .collect();
    let finishes: BTreeMap<_, _> = events
        .iter()
        .filter_map(|event| match &event.event {
            CanonicalEvent::ToolExecutionFinished(finish) => {
                Some((finish.call_id.to_string(), (event.event_id, finish)))
            }
            _ => None,
        })
        .collect();
    assert_eq!(finishes.len(), expected.len());
    for item in expected {
        let (_, finish) = finishes.get(item.id).expect("exact call finish");
        assert_eq!(
            serde_json::to_value(&finish.result.status).unwrap(),
            json!(item.status),
            "status for {}",
            item.id
        );
        assert_eq!(
            finish.result.recovered, item.recovered,
            "recovered for {}",
            item.id
        );
        assert_eq!(
            finish.started_event_id.is_some(),
            item.started,
            "start for {}",
            item.id
        );
        match (item.started, starts.get(item.id)) {
            (true, Some((event_id, execution_id))) => {
                assert_eq!(finish.started_event_id, Some(*event_id));
                assert_eq!(finish.execution_id, *execution_id);
            }
            (false, None) => {}
            _ => panic!("unexpected start identity for {}", item.id),
        }
    }

    let finish_by_id: BTreeMap<_, _> = finishes
        .values()
        .map(|(event_id, finish)| (*event_id, finish))
        .collect();
    let batches: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.event {
            CanonicalEvent::ToolBatchCompleted(batch) => Some(batch),
            _ => None,
        })
        .collect();
    let expected_batches = if matches!(scenario, "marked" | "mixed-marked") {
        1
    } else {
        3
    };
    assert_eq!(batches.len(), expected_batches);
    for batch in batches {
        assert_eq!(batch.call_ids.len(), batch.result_event_ids.len());
        let results: Vec<_> = batch
            .result_event_ids
            .iter()
            .map(|id| finish_by_id.get(id).unwrap().result.clone())
            .collect();
        assert_eq!(
            calculate_result_messages_hash(&results).unwrap(),
            batch.result_messages_hash
        );
        let result_calls: Vec<_> = results
            .iter()
            .map(|result| result.call_id.clone())
            .collect();
        assert_eq!(result_calls, batch.call_ids);
    }

    let store = praana_core::history::artifact::ArtifactStore::open(
        &root.join("session/history.db"),
        praana_core::history::artifact::policy_from_session(&root.join("session")),
        Arc::new(FixedClock(1_700_000_000_000)),
    )
    .unwrap();
    store.verify_references(&events).unwrap();
}

fn resume_twice_and_assert(
    root: &tempfile::TempDir,
    scenario: &str,
    expect_active: bool,
    expected: &[ExpectedCall],
    ledger: usize,
) {
    let first = spawn_child(
        root.path(),
        "child_resume_and_finish",
        "resume-and-finish",
        scenario,
        None,
        expect_active,
    );
    assert!(
        first.status.success(),
        "first fresh-process resume failed: {}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert_exact_final_state(root.path(), scenario, expected, ledger);
    let after_first = std::fs::read(root.path().join("session/events.jsonl")).unwrap();

    let second = spawn_child(
        root.path(),
        "child_resume_idempotently",
        "resume-idempotently",
        scenario,
        None,
        false,
    );
    assert!(
        second.status.success(),
        "second fresh-process resume failed: {}",
        String::from_utf8_lossy(&second.stderr)
    );
    let after_second = std::fs::read(root.path().join("session/events.jsonl")).unwrap();
    assert_eq!(after_first, after_second, "second recovery appended events");
    assert_exact_final_state(root.path(), scenario, expected, ledger);
}

fn crash_boundary(point: &str, expected: &[ExpectedCall], ledger: usize, expect_active: bool) {
    let root = tempfile::tempdir().unwrap();
    let output = spawn_child(
        root.path(),
        "child_seed_and_crash",
        "seed-and-crash",
        "standard",
        Some(point),
        false,
    );
    assert_abort(&output, point);
    resume_twice_and_assert(&root, "standard", expect_active, expected, ledger);
}

#[test]
fn environment_alone_cannot_arm_failpoints() {
    let root = tempfile::tempdir().unwrap();
    let output = spawn_child(
        root.path(),
        "child_no_environment_arming",
        "none",
        "standard",
        Some("event.after_fsync:session_started:1@1"),
        false,
    );
    assert!(
        output.status.success(),
        "environment unexpectedly armed abort"
    );
}

#[test]
fn crash_after_event_write_before_fsync_is_a_real_process_abort() {
    let root = tempfile::tempdir().unwrap();
    let point = "event.write_before_fsync:session_started:1@1";
    let output = spawn_child(
        root.path(),
        "child_aborts_after_session_started_write",
        "none",
        "standard",
        Some(point),
        false,
    );
    assert_abort(&output, point);
    for _ in 0..2 {
        let resumed = spawn_child(
            root.path(),
            "child_resumes_session_started_prefix",
            "none",
            "standard",
            None,
            false,
        );
        assert!(resumed.status.success());
    }
    let events = read_envelopes(root.path());
    assert_eq!(events.len(), 1);
    assert!(matches!(events[0].event, CanonicalEvent::SessionStarted(_)));
}

#[test]
fn crash_after_attempt_started_write_before_fsync() {
    crash_boundary(
        "event.write_before_fsync:assistant_attempt_started:4@1",
        NORMAL,
        1,
        true,
    );
}

#[test]
fn crash_after_attempt_started_durable_before_provider() {
    crash_boundary(
        "turn.after_assistant_attempt_started:step0:attempt1@1",
        NORMAL,
        1,
        true,
    );
}

#[test]
fn crash_during_fragmented_provider_output_never_accepts_partial() {
    let root = tempfile::tempdir().unwrap();
    let point = "provider.after_first_tool_argument_fragment@1";
    let output = spawn_child(
        root.path(),
        "child_seed_and_crash",
        "seed-and-crash",
        "fragment-crash",
        Some(point),
        false,
    );
    assert_abort(&output, point);
    assert_eq!(
        std::fs::read_to_string(root.path().join("work/provider-fragments.log")).unwrap(),
        "call-ledger:{\"command\":\"printf\n"
    );
    let crashed = read_envelopes(root.path());
    assert!(crashed
        .iter()
        .any(|event| matches!(event.event, CanonicalEvent::AssistantAttemptStarted(_))));
    assert!(!crashed
        .iter()
        .any(|event| matches!(event.event, CanonicalEvent::AssistantStepAccepted(_))));
    resume_twice_and_assert(&root, "fragment-crash", true, NORMAL, 1);
    let recovered = read_envelopes(root.path());
    assert_eq!(
        recovered
            .iter()
            .filter(|event| matches!(event.event, CanonicalEvent::AssistantAttemptFailed(_)))
            .count(),
        1
    );
}

#[test]
fn replacement_acceptance_crash_repairs_supersession_once_in_fresh_process() {
    let root = tempfile::tempdir().unwrap();
    let first_point = "turn.after_assistant_attempt_started:step0:attempt1@1";
    let seed = spawn_child(
        root.path(),
        "child_seed_and_crash",
        "seed-and-crash",
        "standard",
        Some(first_point),
        false,
    );
    assert_abort(&seed, first_point);
    let accept_point = "turn.after_assistant_step_accepted:step0@1";
    let replacement = spawn_child(
        root.path(),
        "child_resume_and_finish",
        "resume-and-finish",
        "standard",
        Some(accept_point),
        true,
    );
    assert_abort(&replacement, accept_point);
    let prefix = read_envelopes(root.path());
    assert!(prefix
        .iter()
        .any(|event| matches!(event.event, CanonicalEvent::AssistantAttemptFailed(_))));
    assert_eq!(
        prefix
            .iter()
            .filter(|event| matches!(event.event, CanonicalEvent::AttemptSuperseded(_)))
            .count(),
        0
    );
    for _ in 0..2 {
        let repaired = spawn_child(
            root.path(),
            "child_resumes_session_started_prefix",
            "none",
            "standard",
            None,
            false,
        );
        assert!(
            repaired.status.success(),
            "{}",
            String::from_utf8_lossy(&repaired.stderr)
        );
    }
    let after = read_envelopes(root.path());
    let (position, relation) = after
        .iter()
        .enumerate()
        .find_map(|(index, event)| match &event.event {
            CanonicalEvent::AttemptSuperseded(relation) => Some((index, relation)),
            _ => None,
        })
        .expect("missing supersession repair");
    assert_eq!(
        after
            .iter()
            .filter(|event| matches!(event.event, CanonicalEvent::AttemptSuperseded(_)))
            .count(),
        1
    );
    assert_eq!(
        relation.replacement_accept_event_id,
        after[position - 1].event_id
    );
    assert!(matches!(
        after[position - 1].event,
        CanonicalEvent::AssistantStepAccepted(_)
    ));
    resume_twice_and_assert(&root, "standard", true, NORMAL, 1);
}

#[test]
fn crash_during_supersession_repair_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let first_point = "turn.after_assistant_attempt_started:step0:attempt1@1";
    let seed = spawn_child(
        root.path(),
        "child_seed_and_crash",
        "seed-and-crash",
        "standard",
        Some(first_point),
        false,
    );
    assert_abort(&seed, first_point);
    let accept_point = "turn.after_assistant_step_accepted:step0@1";
    let replacement = spawn_child(
        root.path(),
        "child_resume_and_finish",
        "resume-and-finish",
        "standard",
        Some(accept_point),
        true,
    );
    assert_abort(&replacement, accept_point);
    let repair_point = "recovery.after_append:attempt_superseded@1";
    let repair = spawn_child(
        root.path(),
        "child_resume_and_finish",
        "resume-and-finish",
        "standard",
        Some(repair_point),
        true,
    );
    assert_abort(&repair, repair_point);
    assert_eq!(
        read_envelopes(root.path())
            .iter()
            .filter(|event| matches!(event.event, CanonicalEvent::AttemptSuperseded(_)))
            .count(),
        1
    );
    resume_twice_and_assert(&root, "standard", true, NORMAL, 1);
    assert_eq!(
        read_envelopes(root.path())
            .iter()
            .filter(|event| matches!(event.event, CanonicalEvent::AttemptSuperseded(_)))
            .count(),
        1
    );
}

#[test]
fn crash_after_accepted_step_runs_unstarted_calls_once() {
    crash_boundary(
        "turn.after_assistant_step_accepted:step0@1",
        NORMAL,
        1,
        true,
    );
}

#[test]
fn crash_after_accepted_marked_step_cancels_without_starting_body() {
    let root = tempfile::tempdir().unwrap();
    let point = "turn.after_assistant_step_accepted:step0@1";
    let output = spawn_child(
        root.path(),
        "child_seed_and_crash",
        "seed-and-crash",
        "marked",
        Some(point),
        false,
    );
    assert_abort(&output, point);
    resume_twice_and_assert(&root, "marked", true, MARKED_CANCELLED, 0);
}

#[test]
fn crash_after_accepted_mixed_step_replays_safe_peer_and_cancels_marked_call() {
    for crash_during_recovery in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let point = "turn.after_assistant_step_accepted:step0@1";
        let seed = spawn_child(
            root.path(),
            "child_seed_and_crash",
            "seed-and-crash",
            "mixed-marked",
            Some(point),
            false,
        );
        assert_abort(&seed, point);
        if crash_during_recovery {
            // The safe peer finishes durably before the marked peer is
            // cancelled. A second recovery must not rerun the safe body.
            let finish_point = "event.after_fsync:tool_execution_finished:7@1";
            let recovery = spawn_child(
                root.path(),
                "child_resume_and_finish",
                "resume-and-finish",
                "mixed-marked",
                Some(finish_point),
                true,
            );
            assert_abort(&recovery, finish_point);
            assert_eq!(line_count(&root.path().join("work/ledger.log")), 1);
            assert_eq!(line_count(&root.path().join("work/marked-ledger.log")), 0);
        }
        resume_twice_and_assert(&root, "mixed-marked", true, MIXED_MARKED, 1);
    }
}

#[test]
fn crash_after_first_tool_start_marks_mutation_uncertain_and_skips_peer() {
    crash_boundary(
        "runtime.after_tool_execution_started:0@1",
        MUTATION_UNCERTAIN,
        0,
        true,
    );
}

#[test]
fn crash_after_later_tool_start_preserves_first_result() {
    crash_boundary(
        "runtime.after_tool_execution_started:1@1",
        BOTH_STARTED_UNCERTAIN,
        1,
        true,
    );
}

#[test]
fn crash_after_tool_body_before_redaction() {
    crash_boundary(
        "runtime.after_tool_body_before_redaction@1",
        MUTATION_UNCERTAIN,
        1,
        true,
    );
}

#[test]
fn crash_after_redaction_before_artifact() {
    crash_boundary(
        "runtime.after_redaction_before_artifact@1",
        MUTATION_UNCERTAIN,
        1,
        true,
    );
}

#[test]
fn crash_after_artifact_blob_before_commit() {
    crash_boundary(
        "artifact.after_blob_insert_before_commit@1",
        BOTH_STARTED_UNCERTAIN,
        1,
        true,
    );
}

#[test]
fn crash_after_artifact_commit_before_event_recovers_exact_result() {
    crash_boundary(
        "artifact.after_commit_before_event@1",
        FIRST_RECOVERED_SECOND_UNCERTAIN,
        1,
        true,
    );
}

#[test]
fn crash_after_finish_event_write_before_fsync_preserves_exact_result() {
    crash_boundary(
        "event.write_before_fsync:tool_execution_finished:8@1",
        FIRST_FINISHED_SECOND_UNCERTAIN,
        1,
        true,
    );
}

#[test]
fn crash_after_every_event_fsync_boundary() {
    // Exhaustive for the 25-event P3 scenario, not just one of each kind.
    // Position 1 is a ready session without a turn and is resumed twice
    // without invoking a provider; P4A projection transactions, P7 pending
    // notifications, compaction/model-switch/reset/UI events are out of scope.
    const KINDS: [&str; 25] = [
        "session_started",
        "user_message_accepted",
        "turn_started",
        "assistant_attempt_started",
        "assistant_step_accepted",
        "tool_execution_started",
        "tool_execution_started",
        "tool_execution_finished",
        "tool_execution_finished",
        "tool_batch_completed",
        "assistant_attempt_started",
        "assistant_step_accepted",
        "tool_execution_started",
        "tool_execution_finished",
        "tool_batch_completed",
        "assistant_attempt_started",
        "assistant_step_accepted",
        "tool_execution_started",
        "tool_execution_started",
        "tool_execution_finished",
        "tool_execution_finished",
        "tool_batch_completed",
        "assistant_attempt_started",
        "assistant_step_accepted",
        "turn_committed",
    ];
    // First prove this is the entire scenario, not merely a curated prefix.
    let baseline = tempfile::tempdir().unwrap();
    let completed = spawn_child(
        baseline.path(),
        "child_seed_and_crash",
        "seed-and-crash",
        "standard",
        None,
        false,
    );
    assert!(
        completed.status.success(),
        "baseline scenario failed: {}",
        String::from_utf8_lossy(&completed.stderr)
    );
    let baseline_events = read_envelopes(baseline.path());
    let actual_kinds: Vec<_> = baseline_events
        .iter()
        .map(|event| {
            serde_json::to_value(&event.event).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(actual_kinds, KINDS, "every baseline fsync must be listed");
    assert_exact_final_state(baseline.path(), "standard", NORMAL, 1);

    for (index, kind) in KINDS.iter().enumerate() {
        let sequence = index + 1;
        let point = format!("event.after_fsync:{kind}:{sequence}@1");
        if sequence == 1 {
            let root = tempfile::tempdir().unwrap();
            let output = spawn_child(
                root.path(),
                "child_seed_and_crash",
                "seed-and-crash",
                "standard",
                Some(&point),
                false,
            );
            assert_abort(&output, &point);
            let prefix = std::fs::read(root.path().join("session/events.jsonl")).unwrap();
            for _ in 0..2 {
                let resumed = spawn_child(
                    root.path(),
                    "child_resumes_session_started_prefix",
                    "none",
                    "standard",
                    None,
                    false,
                );
                assert!(
                    resumed.status.success(),
                    "{point}: {}",
                    String::from_utf8_lossy(&resumed.stderr)
                );
                assert_eq!(
                    std::fs::read(root.path().join("session/events.jsonl")).unwrap(),
                    prefix
                );
            }
            assert_eq!(read_envelopes(root.path()).len(), 1);
            continue;
        }
        let mut expected = NORMAL.to_vec();
        let ledger = match sequence {
            6 => {
                expected = MUTATION_UNCERTAIN.to_vec();
                0
            }
            7 => {
                expected = BOTH_STARTED_UNCERTAIN.to_vec();
                1
            }
            8 => {
                expected = FIRST_FINISHED_SECOND_UNCERTAIN.to_vec();
                1
            }
            13 => {
                expected[2].status = "uncertain";
                expected[2].recovered = true;
                1
            }
            18 => {
                expected[3].status = "uncertain";
                expected[3].recovered = true;
                1
            }
            19 => {
                for item in &mut expected[3..] {
                    item.status = "uncertain";
                    item.recovered = true;
                }
                1
            }
            20 => {
                expected[4].status = "uncertain";
                expected[4].recovered = true;
                1
            }
            _ => 1,
        };
        let root = tempfile::tempdir().unwrap();
        let output = spawn_child(
            root.path(),
            "child_seed_and_crash",
            "seed-and-crash",
            "standard",
            Some(&point),
            false,
        );
        assert_abort(&output, &point);
        let crashed = read_envelopes(root.path());
        assert_eq!(
            crashed.len(),
            sequence,
            "{point}: unexpected durable prefix"
        );
        assert_eq!(crashed.last().unwrap().sequence as usize, sequence);
        let prefix = std::fs::read(root.path().join("session/events.jsonl")).unwrap();
        resume_twice_and_assert(&root, "standard", sequence < 24, &expected, ledger);
        assert!(
            std::fs::read(root.path().join("session/events.jsonl"))
                .unwrap()
                .starts_with(&prefix),
            "{point}: durable prefix changed"
        );
    }
}

#[test]
fn crash_after_batch_complete_write_before_fsync() {
    crash_boundary(
        "event.write_before_fsync:tool_batch_completed:10@1",
        NORMAL,
        1,
        true,
    );
}

#[test]
fn crash_after_batch_completed_runtime_boundary() {
    crash_boundary("runtime.after_tool_batch_completed@1", NORMAL, 1, true);
}

#[test]
fn crash_after_terminal_step_before_commit() {
    crash_boundary(
        "turn.after_assistant_step_accepted:step3@1",
        NORMAL,
        1,
        false,
    );
}

#[test]
fn crash_after_turn_committed() {
    crash_boundary("turn.after_turn_committed@1", NORMAL, 1, false);
}

#[test]
fn crash_during_recovery_is_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let seed = spawn_child(
        root.path(),
        "child_seed_and_crash",
        "seed-and-crash",
        "standard",
        Some("runtime.after_tool_execution_started:0@1"),
        false,
    );
    assert_abort(&seed, "seed tool start");
    let recovery = spawn_child(
        root.path(),
        "child_resume_and_finish",
        "resume-and-finish",
        "standard",
        Some("recovery.after_append:tool_uncertain@1"),
        true,
    );
    assert_abort(&recovery, "recovery tool uncertain");
    resume_twice_and_assert(&root, "standard", true, MUTATION_UNCERTAIN, 0);
}

#[test]
fn malformed_tail_recovers_exact_valid_prefix() {
    let root = tempfile::tempdir().unwrap();
    let seed = spawn_child(
        root.path(),
        "child_seed_and_crash",
        "seed-and-crash",
        "standard",
        Some("turn.after_assistant_attempt_started:step0:attempt1@1"),
        false,
    );
    assert_abort(&seed, "seed attempt start");
    let events_path = root.path().join("session/events.jsonl");
    let durable_prefix = std::fs::read(&events_path).unwrap();
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&events_path)
        .unwrap();
    file.write_all(b"{\"schema_version\":2,\"partial\":")
        .unwrap();
    file.sync_all().unwrap();
    drop(file);
    resume_twice_and_assert(&root, "standard", true, NORMAL, 1);
    let repaired = std::fs::read(&events_path).unwrap();
    assert!(repaired.starts_with(&durable_prefix));
    assert!(!String::from_utf8_lossy(&repaired).contains("\"partial\""));
}
