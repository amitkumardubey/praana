//! Phase 3 built-in tools. Schemas, confinement, search bounds, and shell supervision.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use praana_core::clock::SystemClock;
use praana_core::config::types::{CircuitConfig, RiskConfig, ToolsConfig};
use praana_core::history::artifact::{ArtifactPolicy, ArtifactStore};
use praana_core::history::event_log::{
    write_new_session_meta, EventLogStore, EMPTY_PROJECT_CONTEXT_SOURCE_SHA256,
};
use praana_core::id::MonotonicUlidGenerator;
use praana_core::protocol::events::CanonicalEvent;
use praana_core::protocol::hashes::calculate_result_messages_hash;
use praana_core::protocol::id::{
    AttemptId, SessionId, Sha256Digest, StepId, ToolBatchId, ToolCallId, TurnId,
};
use praana_core::protocol::tool_result::ToolResultStatus;
use praana_core::tools::builtin::register_phase3;
use praana_core::tools::{
    BatchOrigin, DurableBatchOutcome, DurableSession, ProviderToolCall, ToolBatchRequest,
    ToolCallOrigin, ToolErrorCode, ToolName, ToolRuntime,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn tools_config(shell: bool) -> ToolsConfig {
    ToolsConfig {
        allowed_paths: Vec::new(),
        default_timeout_ms: 60_000,
        max_parallel_calls: 4,
        max_spawned_processes: 4,
        shell_enabled: shell,
        shell_max_timeout_ms: 600_000,
        shell_timeout_ms: 30_000,
    }
}

fn runtime(root: &Path, shell: bool) -> ToolRuntime {
    runtime_with_config(root, tools_config(shell), RiskConfig { allow: Vec::new() })
}

fn runtime_with_config(root: &Path, config: ToolsConfig, risk: RiskConfig) -> ToolRuntime {
    let registry = register_phase3(&config).expect("phase 3 registry");
    let rt = ToolRuntime::new(
        registry,
        config,
        risk,
        CircuitConfig {
            loop_threshold: 3,
            max_tokens: 0,
            max_wall_ms: 0,
        },
    );
    rt.set_workspace(root.to_path_buf());
    rt.set_session(root.join(".session"), session_id());
    rt
}

fn session_id() -> SessionId {
    SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap()
}

fn call(name: &str, id: &str, ordinal: u32, args: Value) -> ProviderToolCall {
    ProviderToolCall {
        tool_call_id: ToolCallId::from_str_canonical(id).unwrap(),
        tool_name: ToolName::new(name).unwrap(),
        arguments: args,
        provider_ordinal: ordinal,
    }
}

fn batch(calls: Vec<ProviderToolCall>) -> ToolBatchRequest {
    ToolBatchRequest {
        batch_id: ToolBatchId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB1").unwrap(),
        session_id: session_id(),
        turn_id: TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB2").unwrap(),
        attempt_id: AttemptId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB3").unwrap(),
        calls,
        origin: ToolCallOrigin::HeadlessCommand,
    }
}

async fn run(
    rt: &ToolRuntime,
    calls: Vec<ProviderToolCall>,
) -> Vec<praana_core::tools::FinishedCall> {
    rt.execute_batch(
        batch(calls),
        BatchOrigin::HeadlessCommand,
        CancellationToken::new(),
    )
    .await
    .expect("batch")
    .results
}

fn aws() -> String {
    "AKIA".to_owned() + &"C".repeat(16)
}

const PHASE3: &[(&str, u16)] = &[
    ("read_file", 400),
    ("write_file", 410),
    ("edit_file", 420),
    ("batch_write", 430),
    ("batch_edit", 440),
    ("search_code", 500),
    ("find_files", 510),
    ("run_tests", 600),
    ("git_status", 700),
    ("git_diff", 710),
    ("shell", 1100),
];

#[test]
fn descriptors_are_strict_ordered_and_match_committed_schemas() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("schemas/tools/v1");
    if std::env::var_os("PRAANA_WRITE_TOOL_SCHEMAS").is_some() {
        praana_core::tools::builtin::write_schema_snapshots(&root).unwrap();
    }
    let registry = register_phase3(&tools_config(true)).unwrap();
    let descriptors = registry.catalog().descriptors();
    let available: Vec<_> = PHASE3
        .iter()
        .filter(|(name, _)| {
            !cfg!(windows)
                || !matches!(
                    *name,
                    "write_file" | "edit_file" | "batch_write" | "batch_edit"
                )
        })
        .collect();
    assert_eq!(descriptors.len(), available.len());
    for (descriptor, (name, order)) in descriptors.iter().zip(available) {
        assert_eq!(descriptor.name.as_str(), *name);
        assert_eq!(descriptor.order, *order);
        assert!(descriptor.strict);
        assert!(!descriptor.description.is_empty());
        assert_eq!(
            descriptor.input_schema["type"],
            json!("object"),
            "{name} input schema"
        );
        assert_eq!(
            descriptor.input_schema["additionalProperties"],
            json!(false)
        );
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("schemas/tools/v1");
        let input: Value = serde_json::from_str(
            &fs::read_to_string(root.join(format!("{order}-{name}-input.json"))).unwrap(),
        )
        .unwrap();
        let output: Value = serde_json::from_str(
            &fs::read_to_string(root.join(format!("{order}-{name}-output.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(descriptor.input_schema, input, "{name} input snapshot");
        assert_eq!(descriptor.output_schema, output, "{name} output snapshot");
    }
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("schemas/tools/v1/manifest.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["catalog_schema_version"], json!(1));
    assert_eq!(manifest["tools"].as_array().unwrap().len(), PHASE3.len());
}

#[cfg(windows)]
#[test]
fn windows_catalog_omits_unsupported_writes_but_keeps_schema_fixtures() {
    let registry = register_phase3(&tools_config(true)).unwrap();
    let names: Vec<_> = registry
        .catalog()
        .descriptors()
        .iter()
        .map(|descriptor| descriptor.name.as_str())
        .collect();
    for unavailable in ["write_file", "edit_file", "batch_write", "batch_edit"] {
        assert!(
            !names.contains(&unavailable),
            "{unavailable} was advertised"
        );
        assert!(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!(
                "schemas/tools/v1/{}-{unavailable}-input.json",
                PHASE3
                    .iter()
                    .find(|(name, _)| *name == unavailable)
                    .unwrap()
                    .1
            ))
            .exists());
    }
    assert!(names.contains(&"read_file"));
    assert!(names.contains(&"search_code"));
}

#[test]
fn catalog_order_is_stable_when_shell_is_disabled() {
    let enabled = register_phase3(&tools_config(true)).unwrap();
    let disabled = register_phase3(&tools_config(false)).unwrap();
    let names = |reg: &praana_core::tools::ToolRegistry| {
        reg.catalog()
            .descriptors()
            .iter()
            .map(|d| (d.order, d.name.as_str().to_owned()))
            .collect::<Vec<_>>()
    };
    let on = names(&enabled);
    let off = names(&disabled);
    assert!(on.iter().any(|(_, name)| name == "shell"));
    assert!(off.iter().all(|(_, name)| name != "shell"));
    assert_eq!(
        off,
        on.into_iter()
            .filter(|(_, name)| name != "shell")
            .collect::<Vec<_>>()
    );
    let forward = praana_core::tools::ToolRegistry::try_from_erased(
        praana_core::tools::builtin::phase3_tools(&tools_config(true)).unwrap(),
    )
    .unwrap();
    let mut reversed = praana_core::tools::builtin::phase3_tools(&tools_config(true)).unwrap();
    reversed.reverse();
    let backward = praana_core::tools::ToolRegistry::try_from_erased(reversed).unwrap();
    assert_eq!(forward.catalog_hash(), backward.catalog_hash());
}

#[tokio::test]
async fn provider_ordinal_ordering_without_a_durable_session() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("first.txt"), b"first").unwrap();
    fs::write(dir.path().join("second.txt"), b"second").unwrap();
    let rt = runtime(dir.path(), false);
    let results = run(
        &rt,
        vec![
            call("read_file", "second", 1, json!({"path": "second.txt"})),
            call("read_file", "first", 0, json!({"path": "first.txt"})),
        ],
    )
    .await;
    assert_eq!(
        results
            .iter()
            .map(|result| result.dto.meta.tool_call_id.as_str())
            .collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert!(results
        .iter()
        .all(|result| result.status == ToolResultStatus::Success));
}

#[tokio::test]
async fn durable_batch_completion_uses_provider_ordinals_not_input_vector_order() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("work");
    let session = dir.path().join("session");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&session).unwrap();
    fs::write(workspace.join("a.txt"), "alpha").unwrap();
    fs::write(workspace.join("b.txt"), "beta").unwrap();
    // A valid accepted two-call step; the runtime receives its calls in the
    // reverse order from their provider ordinals.
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/protocol_v2/03_parallel_results_finish_out_of_order/events.jsonl");
    let prefix = fs::read_to_string(fixture)
        .unwrap()
        .lines()
        .take(5)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(session.join("events.jsonl"), prefix).unwrap();
    write_new_session_meta(
        &session,
        &session_id(),
        &Sha256Digest::from_hex_str(EMPTY_PROJECT_CONTEXT_SOURCE_SHA256).unwrap(),
    )
    .unwrap();
    let mut log = EventLogStore::open(&session, &session_id().to_string()).unwrap();
    let clock = Arc::new(SystemClock);
    let artifacts = ArtifactStore::open(
        &session.join("history.db"),
        ArtifactPolicy::defaults(),
        clock.clone(),
    )
    .unwrap();
    let ids = MonotonicUlidGenerator::system();
    let registry = register_phase3(&tools_config(false)).unwrap();
    let rt = ToolRuntime::new(
        registry,
        tools_config(false),
        RiskConfig { allow: Vec::new() },
        CircuitConfig {
            loop_threshold: 3,
            max_tokens: 0,
            max_wall_ms: 0,
        },
    );
    rt.set_workspace(workspace);
    rt.set_session(session, session_id());
    let request = ToolBatchRequest {
        batch_id: ToolBatchId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB7").unwrap(),
        session_id: session_id(),
        turn_id: TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAY").unwrap(),
        attempt_id: AttemptId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB2").unwrap(),
        calls: vec![
            call("read_file", "call_002", 1, json!({"path": "b.txt"})),
            call("read_file", "call_001", 0, json!({"path": "a.txt"})),
        ],
        origin: ToolCallOrigin::Model,
    };
    let mut durable = DurableSession {
        log: &mut log,
        artifacts: &artifacts,
        ids: &ids,
        clock: clock.as_ref(),
        session_id: session_id(),
        step_id: StepId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB3").unwrap(),
        fault_after_body: false,
        recovery_cancelled_calls: Default::default(),
    };
    let DurableBatchOutcome::Finished(batch) = rt
        .execute_durable_batch(
            request,
            BatchOrigin::Model,
            CancellationToken::new(),
            &mut durable,
        )
        .await
        .unwrap()
    else {
        panic!("unexpected injected crash")
    };
    assert_eq!(
        batch
            .results
            .iter()
            .map(|result| result.dto.meta.tool_call_id.as_str())
            .collect::<Vec<_>>(),
        vec!["call_001", "call_002"]
    );
    let events = log.events().unwrap();
    let completed = events
        .iter()
        .find_map(|event| match &event.event {
            CanonicalEvent::ToolBatchCompleted(completed) => Some(completed),
            _ => None,
        })
        .expect("durable completion");
    assert_eq!(
        completed
            .call_ids
            .iter()
            .map(|id| id.as_str())
            .collect::<Vec<_>>(),
        vec!["call_001", "call_002"]
    );
    let finishes = completed
        .result_event_ids
        .iter()
        .map(|id| {
            let event = events.iter().find(|event| event.event_id == *id).unwrap();
            let CanonicalEvent::ToolExecutionFinished(finish) = &event.event else {
                panic!("not a finish")
            };
            finish
        })
        .collect::<Vec<_>>();
    assert_eq!(
        finishes
            .iter()
            .map(|finish| finish.call_id.as_str())
            .collect::<Vec<_>>(),
        vec!["call_001", "call_002"]
    );
    assert_eq!(
        completed.result_messages_hash,
        calculate_result_messages_hash(
            &finishes
                .iter()
                .map(|finish| finish.result.clone())
                .collect::<Vec<_>>()
        )
        .unwrap()
    );
}

#[tokio::test]
async fn read_write_and_edit_success_and_error_shapes() {
    let dir = tempfile::tempdir().unwrap();
    let rt = runtime(dir.path(), false);
    let wrote = run(
        &rt,
        vec![call(
            "write_file",
            "w1",
            0,
            json!({"path": "note.txt", "content": "alpha beta alpha"}),
        )],
    )
    .await;
    assert!(wrote[0].dto.ok, "{:?}", wrote[0].dto.error);
    let data = wrote[0].dto.data.clone().unwrap();
    assert_eq!(data["changed"], json!(true));
    assert!(data["file"]["after_sha256"].is_string());
    assert_eq!(data["file"]["path"], json!("note.txt"));

    let read = run(
        &rt,
        vec![call("read_file", "r1", 0, json!({"path": "note.txt"}))],
    )
    .await;
    assert!(read[0].dto.ok, "{:?}", read[0].dto.error);
    let data = read[0].dto.data.clone().unwrap();
    assert_eq!(data["content"], json!("alpha beta alpha"));
    assert_eq!(data["encoding"], json!("utf8"));
    assert_eq!(data["start_line"], json!(1));
    assert_eq!(data["eof"], json!(true));

    let edited = run(
        &rt,
        vec![call(
            "edit_file",
            "e1",
            0,
            json!({"path": "note.txt", "old_text": "beta", "new_text": "gamma"}),
        )],
    )
    .await;
    assert!(edited[0].dto.ok, "{:?}", edited[0].dto.error);
    assert_eq!(
        edited[0].dto.data.clone().unwrap()["replacements"],
        json!(1)
    );

    let missing = run(
        &rt,
        vec![call(
            "read_file",
            "r-miss",
            0,
            json!({"path": "missing.txt"}),
        )],
    )
    .await;
    assert_eq!(
        missing[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolPathNotFound
    );
    assert!(!missing[0].execution_started);

    let ambiguous = run(
        &rt,
        vec![call(
            "edit_file",
            "e-amb",
            0,
            json!({"path": "note.txt", "old_text": "a", "new_text": "b"}),
        )],
    )
    .await;
    assert_eq!(
        ambiguous[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolValidationFailed
    );
    assert!(!ambiguous[0].execution_started);
    assert_eq!(
        fs::read_to_string(dir.path().join("note.txt")).unwrap(),
        "alpha gamma alpha"
    );
}

#[tokio::test]
async fn path_confinement_rejects_escape_and_honors_allowed_roots() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("ws");
    let outside = root.path().join("outside");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "nope").unwrap();
    fs::create_dir(dir.join("sub")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, dir.join("sub").join("link")).unwrap();
    let sibling = outside.file_name().unwrap().to_string_lossy();
    let rt = runtime(&dir, false);
    let cases = [
        (
            "abs",
            outside.join("secret.txt").to_string_lossy().into_owned(),
        ),
        ("trav", format!("../{sibling}/secret.txt")),
        ("alias", "sub/link/secret.txt".to_owned()),
    ];
    for (id, path) in cases {
        let finished = run(&rt, vec![call("read_file", id, 0, json!({"path": path}))]).await;
        assert_eq!(
            finished[0].dto.error.as_ref().unwrap().code,
            ToolErrorCode::ToolPathOutsideWorkspace,
            "{id}"
        );
        assert_eq!(rt.locks().held_count(), 0);
    }

    let mut config = tools_config(false);
    config.allowed_paths = vec![outside.to_string_lossy().into_owned()];
    let registry = register_phase3(&config).unwrap();
    let allowed = ToolRuntime::new(
        registry,
        config,
        RiskConfig { allow: Vec::new() },
        CircuitConfig {
            loop_threshold: 3,
            max_tokens: 0,
            max_wall_ms: 0,
        },
    );
    allowed.set_workspace(dir.clone());
    let finished = allowed
        .execute_batch(
            batch(vec![call(
                "read_file",
                "allowed",
                0,
                json!({"path": outside.join("secret.txt")}),
            )]),
            BatchOrigin::HeadlessCommand,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        finished.results[0].dto.ok,
        "{:?}",
        finished.results[0].dto.error
    );
}

#[tokio::test]
async fn allowed_root_write_outside_cwd_requires_headless_risk_allowance() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("cwd");
    let outside = root.path().join("outside");
    fs::create_dir_all(&cwd).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let mut config = tools_config(false);
    config.allowed_paths = vec![outside.to_string_lossy().into_owned()];

    let denied = runtime_with_config(&cwd, config.clone(), RiskConfig { allow: Vec::new() });
    let denied_result = run(
        &denied,
        vec![call(
            "write_file",
            "outside-denied",
            0,
            json!({"path": outside.join("denied.txt"), "content": "blocked"}),
        )],
    )
    .await;
    assert_eq!(
        denied_result[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolRiskHeadlessDenied
    );
    assert!(!outside.join("denied.txt").exists());

    let allowed = runtime_with_config(
        &cwd,
        config,
        RiskConfig {
            allow: vec!["write_outside_cwd".to_owned()],
        },
    );
    let allowed_result = run(
        &allowed,
        vec![call(
            "write_file",
            "outside-allowed",
            0,
            json!({"path": outside.join("allowed.txt"), "content": "written"}),
        )],
    )
    .await;
    assert!(
        allowed_result[0].dto.ok,
        "{:?}",
        allowed_result[0].dto.error
    );
    assert_eq!(
        fs::read_to_string(outside.join("allowed.txt")).unwrap(),
        "written"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn write_file_replaces_existing_target_above_read_limit() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("large.txt");
    let old = vec![b'x'; 16 * 1024 * 1024 + 1];
    fs::write(&target, &old).unwrap();
    let hash = Sha256Digest::digest_bytes(&old);
    let rt = runtime(dir.path(), false);
    let first = run(
        &rt,
        vec![call(
            "write_file",
            "large-write",
            0,
            json!({"path": "large.txt", "content": "new", "expected_sha256": hash}),
        )],
    )
    .await;
    assert_eq!(first[0].status, ToolResultStatus::Success);
    assert_eq!(fs::read(&target).unwrap(), b"new");
}

#[cfg(unix)]
#[tokio::test]
async fn batch_write_commits_when_session_root_is_reached_through_a_symlink() {
    // Regression: macOS TMPDIR often spells /var as a symlink to
    // /private/var. Journal payload paths (staged/before-image files) are
    // session_dir-relative, and the confine layer's handle-anchored opens
    // walk from the filesystem root, rejecting a symlinked path component.
    // set_session must canonicalize so this class of failure cannot recur
    // on any platform whose temp root (or a caller-supplied session_dir)
    // contains a symlink component.
    let dir = tempfile::tempdir().unwrap();
    let real_root = dir.path().join("real-session-root");
    fs::create_dir_all(&real_root).unwrap();
    let link_root = dir.path().join("linked-session-root");
    std::os::unix::fs::symlink(&real_root, &link_root).unwrap();
    let workspace = dir.path().join("work");
    fs::create_dir_all(&workspace).unwrap();
    let target = workspace.join("existing.txt");
    fs::write(&target, "before").unwrap();
    let rt = runtime(&workspace, false);
    rt.set_session(link_root.join(".session"), session_id());
    let result = run(
        &rt,
        vec![call(
            "batch_write",
            "through-symlinked-session",
            0,
            json!({"writes": [{"path": "existing.txt", "content": "after"}]}),
        )],
    )
    .await;
    assert_eq!(
        result[0].status,
        ToolResultStatus::Success,
        "{:?}",
        result[0].dto.error
    );
    assert_eq!(fs::read(&target).unwrap(), b"after");
}

#[cfg(unix)]
#[tokio::test]
async fn batch_write_replaces_existing_target_above_read_limit() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("large.txt");
    let old = vec![b'x'; 16 * 1024 * 1024 + 1];
    fs::write(&target, &old).unwrap();
    let hash = Sha256Digest::digest_bytes(&old);
    let rt = runtime(dir.path(), false);
    let first = run(
        &rt,
        vec![call(
            "batch_write",
            "large-batch",
            0,
            json!({"writes": [
                {"path": "large.txt", "content": "new", "expected_sha256": hash},
                {"path": "peer.txt", "content": "peer"}
            ]}),
        )],
    )
    .await;
    assert_eq!(first[0].status, ToolResultStatus::Success);
    assert_eq!(fs::read(&target).unwrap(), b"new");
    assert_eq!(fs::read(dir.path().join("peer.txt")).unwrap(), b"peer");
}

#[cfg(unix)]
#[tokio::test]
async fn edit_file_replaces_existing_target_above_read_limit() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("large_edit.txt");
    fs::write(&target, b"before").unwrap();
    let rt = runtime(dir.path(), false);
    // Register the read while the file is small; the read_file ceiling is
    // owner-mandated for read_file only (decision 3), not for edit targets.
    let read = run(
        &rt,
        vec![call(
            "read_file",
            "r-large-edit",
            0,
            json!({"path": "large_edit.txt"}),
        )],
    )
    .await;
    assert!(read[0].dto.ok, "{:?}", read[0].dto.error);
    // Grow the target past the read_file ceiling before editing it. The
    // marker is unique against the filler so apply_edit's uniqueness check
    // still holds at this size.
    let mut grown = vec![b'x'; 16 * 1024 * 1024 + 1];
    grown.extend_from_slice(b"TARGET_MARKER");
    fs::write(&target, &grown).unwrap();
    let edited = run(
        &rt,
        vec![call(
            "edit_file",
            "e-large",
            0,
            json!({"path": "large_edit.txt", "old_text": "TARGET_MARKER", "new_text": "EDITED_MARKER"}),
        )],
    )
    .await;
    assert_eq!(
        edited[0].status,
        ToolResultStatus::Success,
        "{:?}",
        edited[0].dto.error
    );
    let after = fs::read(&target).unwrap();
    assert!(after.ends_with(b"EDITED_MARKER"));
    assert!(after.len() as u64 > 16 * 1024 * 1024);
}

#[cfg(unix)]
#[tokio::test]
async fn batch_edit_replaces_existing_target_above_read_limit() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("large_batch_edit.txt");
    fs::write(&target, b"before").unwrap();
    let rt = runtime(dir.path(), false);
    let read = run(
        &rt,
        vec![call(
            "read_file",
            "r-large-batch-edit",
            0,
            json!({"path": "large_batch_edit.txt"}),
        )],
    )
    .await;
    assert!(read[0].dto.ok, "{:?}", read[0].dto.error);
    let mut grown = vec![b'y'; 16 * 1024 * 1024 + 1];
    grown.extend_from_slice(b"BATCH_MARKER");
    fs::write(&target, &grown).unwrap();
    let edited = run(
        &rt,
        vec![call(
            "batch_edit",
            "be-large",
            0,
            json!({"edits": [{"path": "large_batch_edit.txt", "old_text": "BATCH_MARKER", "new_text": "BATCH_EDITED"}]}),
        )],
    )
    .await;
    assert_eq!(
        edited[0].status,
        ToolResultStatus::Success,
        "{:?}",
        edited[0].dto.error
    );
    let after = fs::read(&target).unwrap();
    assert!(after.ends_with(b"BATCH_EDITED"));
    assert!(after.len() as u64 > 16 * 1024 * 1024);
}

#[cfg(unix)]
#[tokio::test]
async fn edit_file_detects_hash_mismatch_on_a_target_above_read_limit() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("large_edit_hash.txt");
    fs::write(&target, b"before").unwrap();
    let rt = runtime(dir.path(), false);
    let read = run(
        &rt,
        vec![call(
            "read_file",
            "r-hash",
            0,
            json!({"path": "large_edit_hash.txt"}),
        )],
    )
    .await;
    assert!(read[0].dto.ok, "{:?}", read[0].dto.error);
    let mut grown = vec![b'z'; 16 * 1024 * 1024 + 1];
    grown.extend_from_slice(b"HASH_MARKER");
    fs::write(&target, &grown).unwrap();
    let stale_hash = Sha256Digest::digest_bytes(b"before");
    let edited = run(
        &rt,
        vec![call(
            "edit_file",
            "e-hash",
            0,
            json!({"path": "large_edit_hash.txt", "old_text": "HASH_MARKER", "new_text": "X", "expected_sha256": stale_hash}),
        )],
    )
    .await;
    assert_eq!(
        edited[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolValidationFailed
    );
    assert_eq!(fs::metadata(&target).unwrap().len(), grown.len() as u64);
}

#[tokio::test]
async fn batch_write_honors_an_allowed_root_after_risk_approval() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("cwd");
    let outside = root.path().join("outside");
    fs::create_dir_all(&cwd).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let mut config = tools_config(false);
    config.allowed_paths = vec![outside.to_string_lossy().into_owned()];
    let rt = runtime_with_config(
        &cwd,
        config,
        RiskConfig {
            allow: vec!["write_outside_cwd".to_owned()],
        },
    );
    let result = run(
        &rt,
        vec![call(
            "batch_write",
            "outside-batch",
            0,
            json!({"writes": [{
                "path": outside.join("batch.txt"),
                "content": "written",
                "create_parents": false
            }]}),
        )],
    )
    .await;
    assert!(result[0].dto.ok, "{:?}", result[0].dto.error);
    assert_eq!(
        fs::read_to_string(outside.join("batch.txt")).unwrap(),
        "written"
    );
}

#[tokio::test]
async fn search_honors_ignore_rules_and_result_caps() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(".gitignore"), "secret.txt\n").unwrap();
    fs::write(dir.path().join("secret.txt"), "NEEDLE hidden\n").unwrap();
    fs::write(dir.path().join("visible.txt"), "NEEDLE one\nNEEDLE two\n").unwrap();
    let rt = runtime(dir.path(), false);
    let capped = run(
        &rt,
        vec![call(
            "search_code",
            "s1",
            0,
            json!({"pattern": "NEEDLE", "max_results": 1, "context_lines": 0}),
        )],
    )
    .await;
    assert!(capped[0].dto.ok, "{:?}", capped[0].dto.error);
    let data = capped[0].dto.data.clone().unwrap();
    assert_eq!(data["matches"].as_array().unwrap().len(), 1);
    assert_eq!(data["truncated"], json!(true));
    assert!(data["matches"][0]["path"]
        .as_str()
        .unwrap()
        .ends_with("visible.txt"));

    let bad = run(
        &rt,
        vec![call(
            "search_code",
            "s-bad",
            0,
            json!({"pattern": "(?=needle)"}),
        )],
    )
    .await;
    assert_eq!(
        bad[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolValidationFailed
    );

    let found = run(
        &rt,
        vec![call(
            "find_files",
            "f1",
            0,
            json!({"query": "visible", "mode": "fuzzy", "max_results": 10}),
        )],
    )
    .await;
    assert!(found[0].dto.ok, "{:?}", found[0].dto.error);
    let paths = found[0].dto.data.clone().unwrap();
    let rendered = paths.to_string();
    assert!(rendered.contains("visible.txt"));
    assert!(!rendered.contains("secret.txt"));
}

#[tokio::test]
async fn search_reports_every_same_line_match_with_a_match_cap() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("visible.txt"), "foo foo foo\n").unwrap();
    let rt = runtime(dir.path(), false);
    let results = run(
        &rt,
        vec![call(
            "search_code",
            "same-line",
            0,
            json!({"pattern": "foo", "max_results": 2, "context_lines": 0}),
        )],
    )
    .await;
    assert!(results[0].dto.ok, "{:?}", results[0].dto.error);
    let data = results[0].dto.data.as_ref().unwrap();
    assert_eq!(data["truncated"], json!(true));
    let matches = data["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0]["line"], json!(1));
    assert_eq!(matches[0]["column"], json!(1));
    assert_eq!(matches[1]["column"], json!(5));
}

#[cfg(all(feature = "failpoints", unix))]
#[tokio::test]
async fn batch_rollback_conflict_poison_preserves_journal_and_external_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.txt");
    let b = dir.path().join("b.txt");
    fs::write(&a, "before-a").unwrap();
    fs::write(&b, "before-b").unwrap();
    let rt = runtime(dir.path(), false);
    let a_changed = a.clone();
    let b_changed = b.clone();
    praana_core::history::journal::set_test_after_first_entry_hook(a.clone(), move || {
        // Earlier replacement conflicts with rollback; later target conflicts
        // with commit. Neither externally written byte sequence may be lost.
        fs::write(&a_changed, "external-a").unwrap();
        fs::write(&b_changed, "external-b").unwrap();
    });
    let result = run(
        &rt,
        vec![call(
            "batch_write",
            "conflicted-batch",
            0,
            json!({"writes": [
                {"path": "a.txt", "content": "after-a"},
                {"path": "b.txt", "content": "after-b"}
            ]}),
        )],
    )
    .await;
    assert_eq!(result[0].status, ToolResultStatus::Uncertain);
    assert_eq!(
        result[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolInternal
    );
    assert_eq!(fs::read_to_string(&a).unwrap(), "external-a");
    assert_eq!(fs::read_to_string(&b).unwrap(), "external-b");
    let journals = dir.path().join(".session/journals");
    assert_eq!(
        fs::read_dir(&journals).unwrap().count(),
        2,
        "journal and before-image must survive"
    );
    assert!(
        rt.execute_batch(
            batch(vec![call(
                "write_file",
                "must-not-run",
                0,
                json!({"path": "c.txt", "content": "bad"})
            )]),
            BatchOrigin::HeadlessCommand,
            CancellationToken::new(),
        )
        .await
        .is_err(),
        "poisoned session accepted a new batch"
    );
    assert!(!dir.path().join("c.txt").exists());
}

#[cfg(windows)]
#[tokio::test]
async fn windows_mutating_builtins_fail_closed_before_side_effects() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "before").unwrap();
    let rt = runtime(dir.path(), false);
    for (name, arguments) in [
        ("write_file", json!({"path": "a.txt", "content": "changed"})),
        (
            "edit_file",
            json!({"path": "a.txt", "old_text": "before", "new_text": "changed"}),
        ),
        (
            "batch_write",
            json!({"writes": [{"path": "a.txt", "content": "changed"}, {"path": "b.txt", "content": "changed"}]}),
        ),
        (
            "batch_edit",
            json!({"edits": [{"path": "a.txt", "old_text": "before", "new_text": "changed"}]}),
        ),
    ] {
        let result = run(&rt, vec![call(name, name, 0, arguments)]).await;
        assert_eq!(
            result[0].dto.error.as_ref().unwrap().code,
            ToolErrorCode::ToolUnknown
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "before"
        );
        assert!(!dir.path().join("b.txt").exists());
    }
}

#[tokio::test]
async fn same_path_lock_conflict_does_not_wait() {
    let dir = tempfile::tempdir().unwrap();
    let rt = runtime(dir.path(), false);
    let started = Instant::now();
    let finished = run(
        &rt,
        vec![
            call(
                "write_file",
                "first",
                0,
                json!({"path": "a.txt", "content": "one"}),
            ),
            call(
                "write_file",
                "second",
                1,
                json!({"path": "a.txt", "content": "two"}),
            ),
        ],
    )
    .await;
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(finished[0].dto.ok, "{:?}", finished[0].dto.error);
    assert_eq!(
        finished[1].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolPathBusy
    );
    assert_eq!(finished[1].status, ToolResultStatus::Blocked);
    assert!(!finished[1].execution_started);
    assert_eq!(rt.locks().held_count(), 0);
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one");
}

#[cfg(unix)]
#[tokio::test]
async fn shell_timeout_cancel_binary_and_large_output() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".session")).unwrap();
    let mut config = tools_config(true);
    config.shell_timeout_ms = 30_000;
    let registry = register_phase3(&config).unwrap();
    let rt = ToolRuntime::new(
        registry,
        config.clone(),
        RiskConfig { allow: Vec::new() },
        CircuitConfig {
            loop_threshold: 3,
            max_tokens: 0,
            max_wall_ms: 0,
        },
    );
    rt.set_workspace(dir.path().to_path_buf());
    rt.set_session(dir.path().join(".session"), session_id());

    let timed = run(
        &rt,
        vec![call(
            "shell",
            "sh-timeout",
            0,
            json!({"command": "sleep 30", "timeout_ms": 4000}),
        )],
    )
    .await;
    assert_eq!(
        timed[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolTimedOut
    );
    assert!(timed[0].dto.meta.timed_out);
    assert_eq!(rt.locks().held_count(), 0);

    let token = CancellationToken::new();
    let rt2 = rt;
    let cancel = token.clone();
    let handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel.cancel();
    });
    let cancelled = rt2
        .execute_batch(
            batch(vec![call(
                "shell",
                "sh-cancel",
                0,
                json!({"command": "sleep 30", "timeout_ms": 20000}),
            )]),
            BatchOrigin::HeadlessCommand,
            token,
        )
        .await
        .unwrap();
    handle.await.unwrap();
    assert_eq!(
        cancelled.results[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolCancelled
    );
    assert_eq!(cancelled.results[0].status, ToolResultStatus::Cancelled);
    assert_eq!(rt2.locks().held_count(), 0);

    let binary = run(
        &rt2,
        vec![call(
            "shell",
            "sh-bin",
            0,
            json!({"command": "printf '\\377'", "timeout_ms": 5000}),
        )],
    )
    .await;
    let rendered = serde_json::to_string(&binary[0].dto).unwrap();
    assert!(!rendered.contains('\u{FFFD}'));
    assert!(!rendered.contains('\u{00ff}'));
    assert!(binary[0].canonical_bytes.iter().all(|byte| *byte != 0xff));
    assert!(rendered.contains("\"encoding\":\"base64\"") || rendered.contains("base64"));
    assert!(rendered.contains("/w=="));

    let denied = run(
        &rt2,
        vec![call(
            "shell",
            "sh-rm",
            0,
            json!({"command": "rm -rf ./scratch", "timeout_ms": 5000}),
        )],
    )
    .await;
    assert_eq!(
        denied[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolRiskHeadlessDenied
    );
    assert!(!denied[0].execution_started);
    assert_eq!(rt2.locks().held_count(), 0);

    let allowed_risk = RiskConfig {
        allow: vec!["rm".into()],
    };
    let allowed_rt = ToolRuntime::new(
        register_phase3(&config).unwrap(),
        config,
        allowed_risk,
        CircuitConfig {
            loop_threshold: 3,
            max_tokens: 0,
            max_wall_ms: 0,
        },
    );
    allowed_rt.set_workspace(dir.path().to_path_buf());
    allowed_rt.set_session(dir.path().join(".session"), session_id());
    let allowed = run(
        &allowed_rt,
        vec![call(
            "shell",
            "sh-rm-ok",
            0,
            json!({"command": "rm -rf ./scratch", "timeout_ms": 5000}),
        )],
    )
    .await;
    assert!(
        allowed[0].dto.error.as_ref().map(|e| e.code)
            != Some(ToolErrorCode::ToolRiskHeadlessDenied),
        "{:?}",
        allowed[0].dto.error
    );

    let secret = run(
        &rt2,
        vec![call(
            "shell",
            "sh-secret",
            0,
            json!({"command": format!("printf '%s' '{}'", aws()), "timeout_ms": 5000}),
        )],
    )
    .await;
    let bytes = String::from_utf8(secret[0].canonical_bytes.clone()).unwrap();
    assert!(!bytes.contains(&aws()));
    assert!(bytes.contains("[REDACTED:aws-access-key]"));
}

#[tokio::test]
async fn parallel_calls_pair_results_by_call_id() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.txt"), "A").unwrap();
    fs::write(dir.path().join("b.txt"), "B").unwrap();
    let rt = runtime(dir.path(), false);
    let finished = run(
        &rt,
        vec![
            call("read_file", "call-b", 1, json!({"path": "b.txt"})),
            call("read_file", "call-a", 0, json!({"path": "a.txt"})),
        ],
    )
    .await;
    assert_eq!(finished[0].dto.meta.tool_call_id.as_str(), "call-a");
    assert_eq!(finished[1].dto.meta.tool_call_id.as_str(), "call-b");
    assert_eq!(finished[0].dto.data.clone().unwrap()["content"], json!("A"));
    assert_eq!(finished[1].dto.data.clone().unwrap()["content"], json!("B"));
}

#[tokio::test]
async fn batch_edit_is_atomic_and_duplicate_writes_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".session")).unwrap();
    fs::write(dir.path().join("a.txt"), "one").unwrap();
    let rt = runtime(dir.path(), false);
    let _ = run(
        &rt,
        vec![call("read_file", "ra", 0, json!({"path": "a.txt"}))],
    )
    .await;
    let dup = run(
        &rt,
        vec![call(
            "batch_write",
            "bw",
            0,
            json!({"writes": [
                {"path": "a.txt", "content": "x"},
                {"path": "a.txt", "content": "y"}
            ]}),
        )],
    )
    .await;
    assert_eq!(
        dup[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolValidationFailed
    );
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one");

    let edited = run(
        &rt,
        vec![call(
            "batch_edit",
            "be",
            0,
            json!({"edits": [
                {"path": "a.txt", "old_text": "one", "new_text": "two"},
                {"path": "a.txt", "old_text": "two", "new_text": "three"}
            ]}),
        )],
    )
    .await;
    assert!(edited[0].dto.ok, "{:?}", edited[0].dto.error);
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "three"
    );
}

#[tokio::test]
async fn batch_edit_leaves_every_path_unchanged_when_one_path_fails() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".session")).unwrap();
    fs::write(dir.path().join("a.txt"), "alpha").unwrap();
    fs::write(dir.path().join("b.txt"), "beta").unwrap();
    let rt = runtime(dir.path(), false);
    let _ = run(
        &rt,
        vec![
            call("read_file", "ra", 0, json!({"path": "a.txt"})),
            call("read_file", "rb", 1, json!({"path": "b.txt"})),
        ],
    )
    .await;
    // a.txt's edit would succeed on its own; b.txt's old_text is absent.
    // Cross-path atomicity (Built-in Catalog §3.2: journal all, then
    // replace all) means a.txt must stay untouched too.
    let result = run(
        &rt,
        vec![call(
            "batch_edit",
            "be-mixed",
            0,
            json!({"edits": [
                {"path": "a.txt", "old_text": "alpha", "new_text": "ALPHA"},
                {"path": "b.txt", "old_text": "missing", "new_text": "x"}
            ]}),
        )],
    )
    .await;
    assert_eq!(
        result[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolValidationFailed
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        "alpha"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("b.txt")).unwrap(),
        "beta"
    );
    // No scratch files leaked into either path's directory.
    let leftover = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .any(|entry| entry.file_name().to_string_lossy().contains(".praana-"));
    assert!(
        !leftover,
        "scratch file was not cleaned up after a failed batch_edit"
    );
}

#[tokio::test]
async fn batch_edit_chain_streams_a_target_above_the_read_limit() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".session")).unwrap();
    let target = dir.path().join("large_chain.txt");
    fs::write(&target, b"seed").unwrap();
    let rt = runtime(dir.path(), false);
    let _ = run(
        &rt,
        vec![call(
            "read_file",
            "r",
            0,
            json!({"path": "large_chain.txt"}),
        )],
    )
    .await;
    let mut grown = vec![b'q'; 16 * 1024 * 1024 + 1];
    grown.extend_from_slice(b"CHAIN_ONE");
    fs::write(&target, &grown).unwrap();
    let edited = run(
        &rt,
        vec![call(
            "batch_edit",
            "be-chain-large",
            0,
            json!({"edits": [
                {"path": "large_chain.txt", "old_text": "CHAIN_ONE", "new_text": "CHAIN_TWO"},
                {"path": "large_chain.txt", "old_text": "CHAIN_TWO", "new_text": "CHAIN_THREE"}
            ]}),
        )],
    )
    .await;
    assert_eq!(
        edited[0].status,
        ToolResultStatus::Success,
        "{:?}",
        edited[0].dto.error
    );
    let after = fs::read(&target).unwrap();
    assert!(after.ends_with(b"CHAIN_THREE"));
    assert!(after.len() as u64 > 16 * 1024 * 1024);
}

#[tokio::test]
async fn git_status_is_read_only() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    fs::create_dir(&repo).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init"])
        .current_dir(&repo)
        .status()
        .unwrap()
        .success());
    fs::write(repo.join("tracked.txt"), "hello\n").unwrap();
    let rt = runtime(&repo, false);
    let finished = run(
        &rt,
        vec![call(
            "git_status",
            "gs",
            0,
            json!({"include_untracked": true}),
        )],
    )
    .await;
    assert!(finished[0].dto.ok, "{:?}", finished[0].dto.error);
    let data = finished[0].dto.data.clone().unwrap();
    let rendered = data.to_string();
    assert!(rendered.contains("tracked.txt"));
    assert!(std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&repo)
        .output()
        .unwrap()
        .stdout
        .windows(b"tracked.txt".len())
        .any(|w| w == b"tracked.txt"));
}

#[cfg(unix)]
#[tokio::test]
async fn write_does_not_follow_a_planted_temp_symlink_or_a_replaced_parent() {
    let root = tempfile::tempdir().unwrap();
    let ws = root.path().join("ws");
    let outside = root.path().join("outside");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let secret = outside.join("secret.txt");
    fs::write(&secret, "nope").unwrap();
    let predictable = ws.join(format!(".note.txt.praana-tmp-{}", std::process::id()));
    std::os::unix::fs::symlink(&secret, &predictable).unwrap();
    let rt = runtime(&ws, false);
    let written = run(
        &rt,
        vec![call(
            "write_file",
            "w-safe",
            0,
            json!({"path": "note.txt", "content": "inside"}),
        )],
    )
    .await;
    assert!(written[0].dto.ok, "{:?}", written[0].dto.error);
    assert_eq!(fs::read_to_string(&secret).unwrap(), "nope");
    assert_eq!(fs::read_to_string(ws.join("note.txt")).unwrap(), "inside");
    assert!(predictable
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());

    let sub = ws.join("sub");
    fs::create_dir(&sub).unwrap();
    fs::remove_dir(&sub).unwrap();
    std::os::unix::fs::symlink(&outside, &sub).unwrap();
    let raced = run(
        &rt,
        vec![call(
            "write_file",
            "w-race",
            0,
            json!({"path": "sub/child.txt", "content": "escaped", "create_parents": true}),
        )],
    )
    .await;
    assert!(raced[0].dto.error.is_some(), "replaced parent must fail");
    assert!(!outside.join("child.txt").exists());
    assert_eq!(fs::read_to_string(&secret).unwrap(), "nope");
}

#[cfg(unix)]
#[tokio::test]
async fn write_preserves_existing_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.txt");
    fs::write(&path, "old").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let rt = runtime(dir.path(), false);
    let written = run(
        &rt,
        vec![call(
            "write_file",
            "w-mode",
            0,
            json!({"path": "note.txt", "content": "new"}),
        )],
    )
    .await;
    assert!(written[0].dto.ok, "{:?}", written[0].dto.error);
    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert_eq!(fs::read_to_string(&path).unwrap(), "new");
}

#[tokio::test]
async fn compound_shell_destruction_is_denied_when_headless() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".session")).unwrap();
    fs::write(dir.path().join("doomed.txt"), "keep").unwrap();
    let rt = runtime(dir.path(), true);
    let denied = run(
        &rt,
        vec![call(
            "shell",
            "sh-compound",
            0,
            json!({"command": "echo ok; rm -rf doomed.txt", "timeout_ms": 5000}),
        )],
    )
    .await;
    assert_eq!(
        denied[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolRiskHeadlessDenied
    );
    assert!(!denied[0].execution_started);
    assert_eq!(
        fs::read_to_string(dir.path().join("doomed.txt")).unwrap(),
        "keep"
    );

    let nested = run(
        &rt,
        vec![call(
            "shell",
            "sh-nested",
            0,
            json!({"command": "bash -c 'echo ok; rm -rf doomed.txt'", "timeout_ms": 5000}),
        )],
    )
    .await;
    assert_eq!(
        nested[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolRiskHeadlessDenied
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("doomed.txt")).unwrap(),
        "keep"
    );
    let dynamic = run(
        &rt,
        vec![call(
            "shell",
            "sh-dynamic",
            0,
            json!({"command": "sh -c \"$script\"", "timeout_ms": 5000}),
        )],
    )
    .await;
    assert_eq!(
        dynamic[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolValidationFailed
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("doomed.txt")).unwrap(),
        "keep"
    );

    let opaque = run(
        &rt,
        vec![call(
            "shell",
            "sh-opaque",
            0,
            json!({"command": "echo $(<(", "timeout_ms": 5000}),
        )],
    )
    .await;
    assert_eq!(
        opaque[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolValidationFailed
    );
    assert!(!opaque[0].execution_started);
}

#[tokio::test]
async fn ambiguous_test_adapters_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("bun.lock"), "").unwrap();
    fs::write(dir.path().join("package-lock.json"), "").unwrap();
    let rt = runtime(dir.path(), false);
    let finished = run(&rt, vec![call("run_tests", "tests", 0, json!({}))]).await;
    assert_eq!(
        finished[0].dto.error.as_ref().unwrap().code,
        ToolErrorCode::ToolValidationFailed
    );
    let message = &finished[0].dto.error.as_ref().unwrap().message;
    assert!(message.contains("ambiguous"), "{message}");
}

#[tokio::test]
async fn git_status_preserves_paths_with_spaces() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    fs::create_dir(&repo).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init"])
        .current_dir(&repo)
        .status()
        .unwrap()
        .success());
    fs::write(repo.join("my file.txt"), "hello\n").unwrap();
    let git = |args: &[&str]| {
        assert!(
            std::process::Command::new("git")
                .args([
                    "-c",
                    "user.email=praana@example.com",
                    "-c",
                    "user.name=Praana"
                ])
                .args(args)
                .current_dir(&repo)
                .env("GIT_AUTHOR_NAME", "Praana")
                .env("GIT_AUTHOR_EMAIL", "praana@example.com")
                .env("GIT_COMMITTER_NAME", "Praana")
                .env("GIT_COMMITTER_EMAIL", "praana@example.com")
                .status()
                .unwrap()
                .success(),
            "{args:?}"
        );
    };
    git(&["add", "my file.txt"]);
    git(&["commit", "-m", "add"]);
    git(&["mv", "my file.txt", "renamed file.txt"]);
    let rt = runtime(&repo, false);
    let finished = run(
        &rt,
        vec![call(
            "git_status",
            "gs-space",
            0,
            json!({"include_untracked": true}),
        )],
    )
    .await;
    assert!(finished[0].dto.ok, "{:?}", finished[0].dto.error);
    let data = finished[0].dto.data.clone().unwrap();
    let rendered = data.to_string();
    assert!(rendered.contains("renamed file.txt"), "{rendered}");
    assert!(rendered.contains("my file.txt"), "{rendered}");
}
