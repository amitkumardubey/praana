//! Phase 3 artifact substrate. Expected red until `history::{db,artifact,preview,journal,spool}` exist.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use praana_core::clock::Clock;
use praana_core::history::artifact::{
    plan_storage, policy_from_session, ArtifactCrashPoint, ArtifactPolicy, ArtifactStore, PlanItem,
    PublishInput, StagedCommits, StorageClass,
};
use praana_core::history::db::HistoryDatabase;
use praana_core::history::event_log::{write_new_session_meta, EventLogStore};
use praana_core::history::journal::{
    commit_write_journal, prepare_write_journal, reconcile_write_journal, retire_write_journal,
    rollback_write_journal, JournalWrite,
};
use praana_core::history::preview::{render_preview, ArtifactContentType, PreviewRequest};
use praana_core::history::recovery::SessionRecoveryEngine;
use praana_core::history::spool::{
    append_stderr, append_stdout, create_shell_spool, finalize_shell_spool, reconcile_shell_spool,
    record_shell_process, ShellProcessIdentity,
};
use praana_core::hooks::redact;
use praana_core::protocol::errors::HistoryError;
use praana_core::protocol::events::CanonicalEvent;
use praana_core::protocol::id::*;
use praana_core::protocol::recovery::RecoveryKind;
use praana_core::protocol::tool_result::ToolResultStatus;
use praana_core::token::{GenericTokenEstimatorV1, TokenEstimationContext, TokenEstimatorV1};
use praana_core::tools::result::{canonical_tool_result_bytes, ToolResultDto};
use praana_core::tools::{FinishedCall, ResultCommit};
use serde_json::json;

fn fixture_history() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/history_v1")
}

fn protocol_fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/protocol_v2")
        .join(name)
}

struct FixedClock(AtomicI64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

fn clock(ms: i64) -> Arc<dyn Clock> {
    Arc::new(FixedClock(AtomicI64::new(ms)))
}

fn policy() -> ArtifactPolicy {
    let raw = fs::read_to_string(fixture_history().join("policy_defaults.json")).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    ArtifactPolicy {
        inline_tokens: value["artifact_inline_tokens"].as_u64().unwrap(),
        batch_inline_tokens: value["artifact_batch_inline_tokens"].as_u64().unwrap(),
        preview_tokens: value["artifact_preview_tokens"].as_u64().unwrap(),
        orphan_retention_days: value["orphan_retention_days"].as_u64().unwrap() as u32,
    }
}

fn ulid(suffix: &str) -> String {
    let mut id = String::from("01ARZ3NDEKTSV4RRFFQ69G5F");
    id.push_str(suffix);
    assert_eq!(id.len(), 26, "{id}");
    id
}

fn canonical_ascii(n: usize) -> Vec<u8> {
    let text = "a".repeat(n);
    let value = json!({"data": {"text": text}, "ok": true});
    praana_core::canonical_json::to_canonical_json_bytes(&value).unwrap()
}

fn tokens_of(bytes: &[u8]) -> u64 {
    GenericTokenEstimatorV1
        .estimate(
            TokenEstimationContext::ArtifactResult,
            bytes,
            &praana_core::token::FramingProfileV1 {
                framing_profile_schema_version: 1,
                framing_profile_id: "history-zero-v1".into(),
                fixed_tokens: 0,
                per_item_tokens: 0,
                item_count: 0,
                additional_tokens: 0,
            },
        )
        .unwrap()
        .total_tokens
}

fn bytes_for_tokens(target: u64) -> Vec<u8> {
    let mut lo = 0usize;
    let mut hi = 80_000usize;
    while lo < hi {
        let mid = (lo + hi) / 2;
        if tokens_of(&canonical_ascii(mid)) < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let bytes = canonical_ascii(lo);
    assert_eq!(tokens_of(&bytes), target, "token target {target}");
    bytes
}

#[cfg(unix)]
fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
}

fn open_db(dir: &Path) -> HistoryDatabase {
    HistoryDatabase::open(&dir.join("history.db")).unwrap()
}

#[test]
fn schema_matches_owner_and_rejects_version_mismatch() {
    let temp = tempfile::TempDir::new().unwrap();
    let db = open_db(temp.path());
    let mut names = db.table_names().unwrap();
    names.sort();
    let expected: Vec<String> = serde_json::from_str(
        &fs::read_to_string(fixture_history().join("schema_tables.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(names, expected);
    let columns = db.column_names("artifacts").unwrap();
    assert_eq!(columns[0], "artifact_id");
    assert!(columns.contains(&"preview_json".to_string()));
    assert!(columns.contains(&"preview_input_sha256".to_string()));
    assert!(
        columns.contains(&"token_estimator_id".to_string())
            || db
                .column_names("artifact_blobs")
                .unwrap()
                .contains(&"token_estimator_id".to_string())
    );
    assert_eq!(db.user_version().unwrap(), 1);
    assert_eq!(db.application_id().unwrap(), 1_347_567_937);
    assert_eq!(
        db.schema_meta("history_schema_version").unwrap().as_deref(),
        Some("1")
    );
    assert_eq!(
        db.schema_meta("event_schema_version").unwrap().as_deref(),
        Some("2")
    );
    drop(db);

    let mismatch = temp.path().join("other.db");
    {
        let conn = rusqlite::Connection::open(&mismatch).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
    }
    let err = HistoryDatabase::open(&mismatch).unwrap_err();
    assert_eq!(err.code(), "HISTORY_SCHEMA_UNSUPPORTED");
}

#[test]
fn pragmas_and_private_modes_are_enforced() {
    let temp = tempfile::TempDir::new().unwrap();
    let db = open_db(temp.path());
    let pragmas = db.pragma_snapshot().unwrap();
    assert_eq!(pragmas.journal_mode.to_lowercase(), "wal");
    assert_eq!(pragmas.synchronous, 2);
    assert_eq!(pragmas.foreign_keys, 1);
    assert_eq!(pragmas.busy_timeout, 5000);
    #[cfg(unix)]
    {
        assert_eq!(mode_of(&temp.path().join("history.db")), 0o600);
        let wal = temp.path().join("history.db-wal");
        if wal.exists() {
            assert_eq!(mode_of(&wal), 0o600);
        }
    }
}

#[cfg(unix)]
#[test]
fn symlink_database_spool_and_journal_paths_are_rejected() {
    let temp = tempfile::TempDir::new().unwrap();
    let real = temp.path().join("real.db");
    fs::write(&real, []).unwrap();
    let link = temp.path().join("link.db");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let err = HistoryDatabase::open(&link).unwrap_err();
    assert_eq!(err.code(), "HISTORY_INSECURE_PERMISSIONS");

    let spool_link = temp.path().join("spools");
    let spool_real = temp.path().join("spool-real");
    fs::create_dir(&spool_real).unwrap();
    std::os::unix::fs::symlink(&spool_real, &spool_link).unwrap();
    let exec = ToolExecutionId::from_str_canonical(&ulid("SP")).unwrap();
    let err = create_shell_spool(
        temp.path(),
        &SessionId::from_str_canonical(&ulid("SS")).unwrap(),
        &exec,
        &ToolBatchId::from_str_canonical(&ulid("SB")).unwrap(),
        &ToolCallId::from_str_canonical("call_spool").unwrap(),
    )
    .unwrap_err();
    assert_eq!(err.code(), "HISTORY_INSECURE_PERMISSIONS");

    let target = temp.path().join("target.txt");
    fs::write(&target, b"old").unwrap();
    let target_link = temp.path().join("target-link.txt");
    std::os::unix::fs::symlink(&target, &target_link).unwrap();
    let err = prepare_write_journal(
        temp.path(),
        temp.path(),
        &SessionId::from_str_canonical(&ulid("JS")).unwrap(),
        &ToolExecutionId::from_str_canonical(&ulid("JE")).unwrap(),
        &ToolBatchId::from_str_canonical(&ulid("JB")).unwrap(),
        &ToolCallId::from_str_canonical("call_journal").unwrap(),
        &[JournalWrite {
            ordinal: 0,
            target_path: target_link,
            new_bytes: b"new".to_vec(),
        }],
    )
    .unwrap_err();
    assert_eq!(err.code(), "HISTORY_INSECURE_PERMISSIONS");
}

#[test]
fn inline_threshold_includes_equality_and_excludes_above() {
    let limits = policy();
    let below = bytes_for_tokens(limits.inline_tokens - 1);
    let equal = bytes_for_tokens(limits.inline_tokens);
    let above = bytes_for_tokens(limits.inline_tokens + 1);
    let items = [
        PlanItem {
            call_index: 0,
            total_tokens: tokens_of(&below),
            binary: false,
            tool_name: "read_file".into(),
        },
        PlanItem {
            call_index: 1,
            total_tokens: tokens_of(&equal),
            binary: false,
            tool_name: "read_file".into(),
        },
        PlanItem {
            call_index: 2,
            total_tokens: tokens_of(&above),
            binary: false,
            tool_name: "read_file".into(),
        },
    ];
    // Plan each result alone so the batch sum cannot hide the per-result rule.
    assert_eq!(
        plan_storage(&items[0..1], &limits).unwrap(),
        vec![StorageClass::Inline]
    );
    assert_eq!(
        plan_storage(&items[1..2], &limits).unwrap(),
        vec![StorageClass::Inline]
    );
    assert_eq!(
        plan_storage(&items[2..3], &limits).unwrap(),
        vec![StorageClass::Artifact]
    );
}

#[test]
fn batch_budget_follows_provider_order_not_completion_order() {
    let limits = policy();
    // Completion order is the reverse of call_index. Provider order is 0, 1, 2.
    let reversed = vec![
        PlanItem {
            call_index: 2,
            total_tokens: 300,
            binary: false,
            tool_name: "read_file".into(),
        },
        PlanItem {
            call_index: 1,
            total_tokens: 700,
            binary: false,
            tool_name: "read_file".into(),
        },
        PlanItem {
            call_index: 0,
            total_tokens: 700,
            binary: false,
            tool_name: "read_file".into(),
        },
    ];
    let decided = plan_storage(&reversed, &limits).unwrap();
    assert_eq!(
        decided,
        vec![
            StorageClass::Artifact,
            StorageClass::Inline,
            StorageClass::Inline
        ]
    );

    let below = vec![
        PlanItem {
            call_index: 1,
            total_tokens: 800,
            binary: false,
            tool_name: "read_file".into(),
        },
        PlanItem {
            call_index: 0,
            total_tokens: 799,
            binary: false,
            tool_name: "read_file".into(),
        },
    ];
    assert_eq!(
        plan_storage(&below, &limits).unwrap(),
        vec![StorageClass::Inline, StorageClass::Inline]
    );

    let equal = vec![
        PlanItem {
            call_index: 1,
            total_tokens: 800,
            binary: false,
            tool_name: "read_file".into(),
        },
        PlanItem {
            call_index: 0,
            total_tokens: 800,
            binary: false,
            tool_name: "read_file".into(),
        },
    ];
    assert_eq!(
        plan_storage(&equal, &limits).unwrap(),
        vec![StorageClass::Inline, StorageClass::Inline]
    );

    let above = vec![
        PlanItem {
            call_index: 2,
            total_tokens: 1,
            binary: false,
            tool_name: "read_file".into(),
        },
        PlanItem {
            call_index: 0,
            total_tokens: 800,
            binary: false,
            tool_name: "read_file".into(),
        },
        PlanItem {
            call_index: 1,
            total_tokens: 800,
            binary: false,
            tool_name: "read_file".into(),
        },
    ];
    assert_eq!(
        plan_storage(&above, &limits).unwrap(),
        vec![
            StorageClass::Artifact,
            StorageClass::Inline,
            StorageClass::Inline
        ]
    );
}

#[test]
fn batch_sum_uses_checked_arithmetic() {
    let mut limits = policy();
    limits.inline_tokens = u64::MAX;
    limits.batch_inline_tokens = u64::MAX;
    let err = plan_storage(
        &[
            PlanItem {
                call_index: 0,
                total_tokens: u64::MAX,
                binary: false,
                tool_name: "read_file".into(),
            },
            PlanItem {
                call_index: 1,
                total_tokens: 1,
                binary: false,
                tool_name: "read_file".into(),
            },
        ],
        &limits,
    )
    .unwrap_err();
    assert!(err.to_string().to_lowercase().contains("overflow"));
}

#[test]
fn binary_results_are_never_inlined() {
    let limits = policy();
    let decided = plan_storage(
        &[PlanItem {
            call_index: 0,
            total_tokens: 1,
            binary: true,
            tool_name: "read_file".into(),
        }],
        &limits,
    )
    .unwrap();
    assert_eq!(decided, vec![StorageClass::Artifact]);
}

#[test]
fn retrieve_artifact_is_not_a_new_source_artifact() {
    let limits = policy();
    let decided = plan_storage(
        &[PlanItem {
            call_index: 0,
            total_tokens: limits.inline_tokens + 50,
            binary: false,
            tool_name: "retrieve_artifact".into(),
        }],
        &limits,
    )
    .unwrap();
    assert_eq!(decided, vec![StorageClass::Inline]);
}

#[test]
fn preview_is_bounded_deterministic_and_utf8_safe() {
    let limits = policy();
    let artifact_id = ArtifactId::from_str_canonical(&ulid("PV")).unwrap();
    let body = "alpha\nbeta\n".repeat(40);
    let canonical_bytes = canonical_ascii(32);
    let request = PreviewRequest {
        artifact_id,
        tool_call_id: ToolCallId::from_str_canonical("call_preview").unwrap(),
        sha256: Sha256Digest::digest_bytes(&canonical_bytes),
        tool_name: "read_file".into(),
        label: Some("notes".into()),
        content_type: ArtifactContentType::Text,
        canonical_bytes,
        text_view: body.clone(),
        byte_count: 32,
        line_count: 80,
        estimated_tokens: 8,
        is_error: false,
        exit_code: None,
        redaction_applied: false,
        redaction_count: 0,
        redaction_kinds: Vec::new(),
        preview_token_limit: limits.preview_tokens,
    };
    let first = render_preview(&request).unwrap();
    let second = render_preview(&request).unwrap();
    assert_eq!(first.preview_text, second.preview_text);
    assert!(first.preview_text.contains("retrieve_artifact"));
    assert!(first.preview_text.contains(&artifact_id.to_string()));
    assert!(first.estimated_preview_tokens <= limits.preview_tokens);
    assert!(std::str::from_utf8(first.preview_text.as_bytes()).is_ok());

    let mut huge = String::new();
    for _ in 0..20 {
        huge.push('你');
    }
    huge.push('\n');
    let mut tight = request.clone();
    tight.text_view = huge;
    tight.line_count = 1;
    tight.preview_token_limit = limits.preview_tokens;
    let rendered = render_preview(&tight).unwrap();
    assert!(std::str::from_utf8(rendered.preview_text.as_bytes()).is_ok());
    assert!(rendered.estimated_preview_tokens <= limits.preview_tokens);
}

#[test]
fn referencing_event_is_not_durable_before_artifact_bytes() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, session) = session_with_fixture_start(temp.path());
    let before = fs::read(temp.path().join("session").join("events.jsonl")).unwrap();
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1_700_000_000_000),
    )
    .unwrap();
    let input = publish_input_for_start(&session, &bytes_for_tokens(policy().inline_tokens + 5));
    let err = store
        .publish_batch(
            &mut log,
            &[input],
            Some(ArtifactCrashPoint::AfterCommitBeforeEvent),
        )
        .unwrap_err();
    assert_eq!(err.code(), "HISTORY_IO");
    let after = fs::read(temp.path().join("session").join("events.jsonl")).unwrap();
    assert_eq!(before, after);
    assert!(store.artifact_row_count().unwrap() >= 1);
    assert!(store.blob_row_count().unwrap() >= 1);
}

#[test]
fn persisted_estimate_identity_is_not_rewritten() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, session) = session_with_fixture_start(temp.path());
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1_700_000_000_000),
    )
    .unwrap();
    let bytes = bytes_for_tokens(policy().inline_tokens + 5);
    let input = publish_input_for_start(&session, &bytes);
    let artifact_id = input.artifact_id;
    store.publish_batch(&mut log, &[input], None).unwrap();
    let persisted = store.persisted_estimate(&artifact_id).unwrap();
    assert_eq!(
        persisted.estimator_id,
        praana_core::token::GENERIC_ESTIMATOR_ID
    );
    assert_eq!(persisted.token_count, tokens_of(&bytes));
    assert_eq!(
        persisted.input_sha256,
        Sha256Digest::digest_bytes(&bytes).to_string()
    );
    let again = store.persisted_estimate(&artifact_id).unwrap();
    assert_eq!(again, persisted);
}

#[test]
fn crash_boundaries_recover_without_rerunning_a_tool() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, session) = session_with_fixture_start(temp.path());
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1_700_000_000_000),
    )
    .unwrap();
    let input = publish_input_for_start(&session, &bytes_for_tokens(policy().inline_tokens + 8));
    let reserved_finish = input.finish_event_id;
    store
        .publish_batch(
            &mut log,
            &[input],
            Some(ArtifactCrashPoint::AfterCommitBeforeEvent),
        )
        .unwrap_err();
    drop(log);
    drop(store);
    let mut engine =
        SessionRecoveryEngine::new(&temp.path().join("session"), "01ARZ3NDEKTSV4RRFFQ69G5FAV")
            .unwrap();
    let started_before = start_ids(engine.store().events().unwrap());
    let appended = engine.run_recovery().unwrap();
    assert!(appended >= 1);
    let events = engine.store().events().unwrap();
    assert_eq!(start_ids(events.clone()), started_before);
    let recovered = events.iter().find_map(|event| match &event.event {
        CanonicalEvent::ToolExecutionFinished(finished) if finished.result.recovered => {
            Some(finished)
        }
        _ => None,
    });
    let recovered = recovered.expect("recovered finish");
    assert_eq!(recovered.result.status, ToolResultStatus::Success);
    assert!(matches!(
        recovered.result.body.content,
        praana_core::protocol::tool_result::ToolResultContent::Artifact(_)
    ));
    assert!(events.iter().any(|event| event.event_id == reserved_finish));
    assert!(engine
        .pending_notices()
        .iter()
        .any(|notice| notice.kind == RecoveryKind::ToolResultRecovered));
    assert_eq!(engine.run_recovery().unwrap(), 0);
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1_700_000_000_000),
    )
    .unwrap();
    assert!(store.artifact_row_count().unwrap() >= 1);
}

#[test]
fn interrupted_blob_transactions_do_not_invent_a_finish() {
    for crash in [
        ArtifactCrashPoint::AfterBlobInsertBeforeCommit,
        ArtifactCrashPoint::AfterBlobCommitBeforeArtifactRow,
    ] {
        let temp = tempfile::TempDir::new().unwrap();
        let (mut log, session) = session_with_fixture_start(temp.path());
        let store = ArtifactStore::open(
            &temp.path().join("session").join("history.db"),
            policy(),
            clock(1_700_000_000_000),
        )
        .unwrap();
        let input =
            publish_input_for_start(&session, &bytes_for_tokens(policy().inline_tokens + 4));
        store
            .publish_batch(&mut log, &[input], Some(crash))
            .unwrap_err();
        let artifacts = store.artifact_row_count().unwrap();
        let blobs = store.blob_row_count().unwrap();
        if crash == ArtifactCrashPoint::AfterBlobInsertBeforeCommit {
            assert_eq!(artifacts, 0);
            assert_eq!(blobs, 0);
        } else {
            assert_eq!(artifacts, 0);
            assert!(blobs >= 1);
        }
        drop(log);
        drop(store);
        let mut engine =
            SessionRecoveryEngine::new(&temp.path().join("session"), "01ARZ3NDEKTSV4RRFFQ69G5FAV")
                .unwrap();
        let started = start_ids(engine.store().events().unwrap());
        engine.run_recovery().unwrap();
        let events = engine.store().events().unwrap();
        assert_eq!(start_ids(events.clone()), started);
        assert!(events.iter().any(|event| matches!(
            &event.event,
            CanonicalEvent::ToolExecutionFinished(finished)
                if finished.result.status == ToolResultStatus::Uncertain
        )));
        assert!(events.iter().all(|event| !matches!(
            &event.event,
            CanonicalEvent::ToolExecutionFinished(finished)
                if finished.result.recovered && finished.result.status == ToolResultStatus::Success
        )));
    }
}

#[test]
fn hash_mismatched_blob_cannot_prove_a_recovered_finish() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, session) = session_with_fixture_start(temp.path());
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1_700_000_000_000),
    )
    .unwrap();
    let input = publish_input_for_start(&session, &bytes_for_tokens(policy().inline_tokens + 6));
    store
        .publish_batch(
            &mut log,
            &[input],
            Some(ArtifactCrashPoint::AfterCommitBeforeEvent),
        )
        .unwrap_err();
    drop(log);
    drop(store);
    let db_path = temp.path().join("session").join("history.db");
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute("UPDATE artifact_blobs SET canonical_result = x'00'", [])
            .unwrap();
    }
    let mut engine =
        SessionRecoveryEngine::new(&temp.path().join("session"), "01ARZ3NDEKTSV4RRFFQ69G5FAV")
            .unwrap();
    let started = start_ids(engine.store().events().unwrap());
    engine.run_recovery().unwrap();
    let events = engine.store().events().unwrap();
    assert_eq!(start_ids(events.clone()), started);
    assert!(events.iter().any(|event| matches!(
        &event.event,
        CanonicalEvent::ToolExecutionFinished(finished)
            if finished.result.status == ToolResultStatus::Uncertain
    )));
    assert!(events.iter().all(|event| !matches!(
        &event.event,
        CanonicalEvent::ToolExecutionFinished(finished) if finished.result.recovered
            && finished.result.status == ToolResultStatus::Success
    )));
}

#[test]
fn orphan_retention_keeps_unclassified_rows_and_honors_the_clock() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, session) = session_with_fixture_start(temp.path());
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1_000),
    )
    .unwrap();
    let input = publish_input_for_start(&session, &bytes_for_tokens(policy().inline_tokens + 3));
    store
        .publish_batch(
            &mut log,
            &[input],
            Some(ArtifactCrashPoint::AfterCommitBeforeEvent),
        )
        .unwrap_err();
    let execution = session.execution_id;
    let event_ids = log
        .events()
        .unwrap()
        .into_iter()
        .map(|event| event.event_id)
        .collect::<Vec<_>>();
    assert_eq!(store.gc_classified_orphans(1_000, &event_ids).unwrap(), 0);
    assert!(store.artifact_row_count().unwrap() >= 1);
    assert_eq!(
        store
            .delete_expired_classified_orphans(999, &[execution], &event_ids)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .delete_expired_classified_orphans(1_000, &[execution], &event_ids)
            .unwrap(),
        0
    );
    let expired = 1_000 + 8 * 86_400_000;
    assert_eq!(
        store
            .delete_expired_classified_orphans(expired, &[execution], &event_ids)
            .unwrap(),
        1
    );
    assert_eq!(store.artifact_row_count().unwrap(), 0);
}

#[test]
fn missing_artifact_and_hash_mismatch_map_to_protocol_codes() {
    let missing = EventLogStore::read_and_validate_from_path(
        &protocol_fixture("e22_missing_artifact").join("events.jsonl"),
    );
    // Event bytes alone do not know the database. The artifact verifier does.
    let temp = tempfile::TempDir::new().unwrap();
    fs::create_dir_all(temp.path().join("session")).unwrap();
    fs::copy(
        protocol_fixture("e22_missing_artifact").join("events.jsonl"),
        temp.path().join("session").join("events.jsonl"),
    )
    .unwrap();
    write_new_session_meta(
        &temp.path().join("session"),
        &SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
        &Sha256Digest::from_hex_str(
            praana_core::history::event_log::EMPTY_PROJECT_CONTEXT_SOURCE_SHA256,
        )
        .unwrap(),
    )
    .unwrap();
    let log =
        EventLogStore::open(&temp.path().join("session"), "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1),
    )
    .unwrap();
    let err = store.verify_references(&log.events().unwrap()).unwrap_err();
    assert_eq!(err.code(), "E_ARTIFACT_MISSING");
    let _ = missing;

    let mismatch = EventLogStore::read_and_validate_from_path(
        &protocol_fixture("e23_artifact_hash_mismatch").join("events.jsonl"),
    )
    .unwrap_err();
    let expected: HistoryError = serde_json::from_str(
        &fs::read_to_string(
            protocol_fixture("e23_artifact_hash_mismatch").join("expected_error.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(mismatch, expected);
}

#[test]
fn secret_canary_never_reaches_durable_artifact_surfaces() {
    let canary = "sk-abcdefghijklmnopqrstuvwxyz";
    let mut dto = ToolResultDto::failure(
        praana_core::tools::error::ToolErrorCode::ToolInternal,
        "failed",
        false,
        "read_file",
        "call_001",
    );
    dto.ok = true;
    dto.error = None;
    dto.data = Some(json!({"text": canary}));
    redact::apply(&mut dto).unwrap();
    let bytes = canonical_tool_result_bytes(&dto).unwrap();
    assert!(!bytes
        .windows(canary.len())
        .any(|window| window == canary.as_bytes()));

    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, session) = session_with_fixture_start(temp.path());
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(5),
    )
    .unwrap();
    let mut input = publish_input_for_start(&session, &bytes);
    input.content_type = ArtifactContentType::Text;
    // Force an artifact even when the redacted body is small.
    input.force_binary = false;
    let outcome = store.publish_batch(&mut log, &[input], None).unwrap();
    let _ = outcome;
    let raw = fs::read(temp.path().join("session").join("history.db")).unwrap();
    assert!(!raw
        .windows(canary.len())
        .any(|window| window == canary.as_bytes()));
    let events = fs::read(temp.path().join("session").join("events.jsonl")).unwrap();
    assert!(!events
        .windows(canary.len())
        .any(|window| window == canary.as_bytes()));
}

#[test]
fn result_commit_stages_without_writing_events() {
    let staged = StagedCommits::default();
    let dto = ToolResultDto::failure(
        praana_core::tools::error::ToolErrorCode::ToolInternal,
        "failed",
        false,
        "read_file",
        "call_001",
    );
    let bytes = canonical_tool_result_bytes(&dto).unwrap();
    staged.commit(&FinishedCall {
        dto,
        canonical_bytes: bytes,
        execution_started: true,
        status: ToolResultStatus::Error,
    });
    assert_eq!(staged.len(), 1);
}

#[test]
fn journal_replaces_atomically_and_rolls_back_only_matching_bytes() {
    let temp = tempfile::TempDir::new().unwrap();
    let target = temp.path().join("file.txt");
    fs::write(&target, b"before").unwrap();
    let session = SessionId::from_str_canonical(&ulid("J1")).unwrap();
    let execution = ToolExecutionId::from_str_canonical(&ulid("J2")).unwrap();
    let batch = ToolBatchId::from_str_canonical(&ulid("J3")).unwrap();
    let call = ToolCallId::from_str_canonical("call_j").unwrap();
    prepare_write_journal(
        temp.path(),
        temp.path(),
        &session,
        &execution,
        &batch,
        &call,
        &[JournalWrite {
            ordinal: 1,
            target_path: target.clone(),
            new_bytes: b"after".to_vec(),
        }],
    )
    .unwrap();
    commit_write_journal(temp.path(), temp.path(), &execution).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"after");
    assert!(temp.path().read_dir().unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp")
    }));
    rollback_write_journal(temp.path(), temp.path(), &execution).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"before");
    retire_write_journal(temp.path(), &execution).unwrap();
    assert!(!temp
        .path()
        .join("journals")
        .join(format!("write-{execution}.json"))
        .exists());
}

#[test]
fn journal_conflict_does_not_overwrite_external_bytes() {
    let temp = tempfile::TempDir::new().unwrap();
    let target = temp.path().join("file.txt");
    fs::write(&target, b"before").unwrap();
    let execution = ToolExecutionId::from_str_canonical(&ulid("K2")).unwrap();
    prepare_write_journal(
        temp.path(),
        temp.path(),
        &SessionId::from_str_canonical(&ulid("K1")).unwrap(),
        &execution,
        &ToolBatchId::from_str_canonical(&ulid("K3")).unwrap(),
        &ToolCallId::from_str_canonical("call_k").unwrap(),
        &[JournalWrite {
            ordinal: 0,
            target_path: target.clone(),
            new_bytes: b"after".to_vec(),
        }],
    )
    .unwrap();
    commit_write_journal(temp.path(), temp.path(), &execution).unwrap();
    fs::write(&target, b"external").unwrap();
    let err = reconcile_write_journal(temp.path(), temp.path(), &execution).unwrap_err();
    assert_eq!(err.code(), "HISTORY_ROLLBACK_CONFLICT");
    assert_eq!(fs::read(&target).unwrap(), b"external");
}

#[tokio::test]
async fn spool_is_private_bounded_and_removed_only_after_a_dead_owner() {
    let temp = tempfile::TempDir::new().unwrap();
    let session = SessionId::from_str_canonical(&ulid("S1")).unwrap();
    let execution = ToolExecutionId::from_str_canonical(&ulid("S2")).unwrap();
    create_shell_spool(
        temp.path(),
        &session,
        &execution,
        &ToolBatchId::from_str_canonical(&ulid("S3")).unwrap(),
        &ToolCallId::from_str_canonical("call_s").unwrap(),
    )
    .unwrap();
    append_stdout(temp.path(), &execution, b"hello-spool")
        .await
        .unwrap();
    append_stderr(temp.path(), &execution, b"err")
        .await
        .unwrap();
    let err = finalize_shell_spool(temp.path(), &execution).unwrap_err();
    assert_eq!(err.code(), "HISTORY_OPERATIONAL_RECOVERY_UNCERTAIN");
    record_shell_process(
        temp.path(),
        &execution,
        &ShellProcessIdentity {
            child_pid: 2_147_483_647,
            child_process_start_id: "dead-child".to_owned(),
            unix_process_group_id: Some(2_147_483_646),
            windows_job_nonce: None,
        },
    )
    .unwrap();
    finalize_shell_spool(temp.path(), &execution).unwrap();
    let stdout = temp
        .path()
        .join("spools")
        .join(execution.to_string())
        .join("stdout.raw");
    assert_eq!(fs::read(&stdout).unwrap(), b"hello-spool");
    #[cfg(unix)]
    {
        assert_eq!(mode_of(stdout.parent().unwrap()), 0o700);
        assert_eq!(mode_of(&stdout), 0o600);
    }
    let err = reconcile_shell_spool(temp.path(), &execution, false).unwrap_err();
    assert_eq!(err.code(), "HISTORY_OPERATIONAL_RECOVERY_UNCERTAIN");
    assert!(stdout.exists());
    {
        let file = fs::OpenOptions::new().write(true).open(&stdout).unwrap();
        file.set_len(64 * 1024 * 1024).unwrap();
    }
    let err = append_stdout(temp.path(), &execution, b"x")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "HISTORY_IO");
    assert!(!stdout.parent().unwrap().join("manifest.json.tmp").exists());
    let err = reconcile_shell_spool(temp.path(), &execution, true).unwrap_err();
    assert_eq!(err.code(), "HISTORY_OPERATIONAL_RECOVERY_UNCERTAIN");
    assert!(stdout.exists());
    let manifest_path = stdout.parent().unwrap().join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["owner_pid"] = json!(2_147_483_647u32);
    manifest["owner_process_start_id"] = json!("unverified");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let err = reconcile_shell_spool(temp.path(), &execution, true).unwrap_err();
    assert_eq!(err.code(), "HISTORY_OPERATIONAL_RECOVERY_UNCERTAIN");
    assert!(stdout.exists());
    manifest["owner_process_start_id"] = json!("dead-start");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    reconcile_shell_spool(temp.path(), &execution, true).unwrap();
    assert!(!stdout.exists());
}

#[test]
fn json_preview_records_member_spans_in_rfc8785_order() {
    let limits = policy();
    let value = json!({ "\u{FFFF}": 1, "😀": 2 });
    let canonical_bytes = praana_core::canonical_json::to_canonical_json_bytes(&value).unwrap();
    let text_view = String::from_utf8(canonical_bytes.clone()).unwrap();
    let artifact_id = ArtifactId::from_str_canonical(&ulid("JV")).unwrap();
    let request = PreviewRequest {
        artifact_id,
        tool_call_id: ToolCallId::from_str_canonical("call_json").unwrap(),
        sha256: Sha256Digest::digest_bytes(&canonical_bytes),
        tool_name: "read_file".into(),
        label: None,
        content_type: ArtifactContentType::Json,
        canonical_bytes,
        text_view,
        byte_count: 0,
        line_count: 1,
        estimated_tokens: 4,
        is_error: false,
        exit_code: None,
        redaction_applied: false,
        redaction_count: 0,
        redaction_kinds: Vec::new(),
        preview_token_limit: limits.preview_tokens.max(400),
    };
    let request = PreviewRequest {
        byte_count: request.canonical_bytes.len() as u64,
        ..request
    };
    let rendered = render_preview(&request).unwrap();
    let emoji = rendered.preview_text.find('😀').expect("emoji key");
    let other = rendered
        .preview_text
        .find('\u{FFFF}')
        .expect("noncharacter key");
    assert!(emoji < other);
    assert!(!rendered.preview_text.contains("[... "));
}

#[test]
fn recovery_policy_loads_the_creation_snapshot() {
    let temp = tempfile::TempDir::new().unwrap();
    let mut config = praana_core::history::event_log::history_creation_config();
    config.history.artifact_preview_tokens = 400;
    config.session.orphan_retention_days = 30;
    let mut bytes = config.to_canonical_json_bytes();
    bytes.push(b'\n');
    fs::write(temp.path().join("config.snapshot.json"), bytes).unwrap();
    let loaded = policy_from_session(temp.path());
    assert_eq!(loaded.preview_tokens, 400);
    assert_eq!(loaded.orphan_retention_days, 30);
    assert_eq!(loaded.inline_tokens, 800);
    assert_eq!(loaded.batch_inline_tokens, 1600);
}

#[test]
fn journal_rejects_a_target_outside_the_workspace() {
    let session = tempfile::TempDir::new().unwrap();
    let outside = tempfile::TempDir::new().unwrap();
    let target = outside.path().join("file.txt");
    fs::write(&target, b"before").unwrap();
    let err = prepare_write_journal(
        session.path(),
        session.path(),
        &SessionId::from_str_canonical(&ulid("W1")).unwrap(),
        &ToolExecutionId::from_str_canonical(&ulid("W2")).unwrap(),
        &ToolBatchId::from_str_canonical(&ulid("W3")).unwrap(),
        &ToolCallId::from_str_canonical("call_out").unwrap(),
        &[JournalWrite {
            ordinal: 0,
            target_path: target,
            new_bytes: b"after".to_vec(),
        }],
    )
    .unwrap_err();
    assert_eq!(err.code(), "HISTORY_INSECURE_PERMISSIONS");
}

#[test]
fn rollback_restores_the_entry_replaced_before_next_entry_was_stored() {
    let temp = tempfile::TempDir::new().unwrap();
    let target = temp.path().join("file.txt");
    fs::write(&target, b"before").unwrap();
    let execution = ToolExecutionId::from_str_canonical(&ulid("G2")).unwrap();
    prepare_write_journal(
        temp.path(),
        temp.path(),
        &SessionId::from_str_canonical(&ulid("G1")).unwrap(),
        &execution,
        &ToolBatchId::from_str_canonical(&ulid("G3")).unwrap(),
        &ToolCallId::from_str_canonical("call_gap").unwrap(),
        &[JournalWrite {
            ordinal: 0,
            target_path: target.clone(),
            new_bytes: b"after".to_vec(),
        }],
    )
    .unwrap();
    commit_write_journal(temp.path(), temp.path(), &execution).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"after");
    let journal_path = temp
        .path()
        .join("journals")
        .join(format!("write-{execution}.json"));
    let mut journal: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
    journal["next_entry"] = json!(0);
    journal["phase"] = json!("committing");
    journal["entries"][0]["replacement_identity"] = serde_json::Value::Null;
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    rollback_write_journal(temp.path(), temp.path(), &execution).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"before");
}

#[test]
fn proved_orphan_keeps_the_committed_replacement() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, started) = session_with_fixture_start(temp.path());
    let session_dir = temp.path().join("session");
    let target = session_dir.join("replaced.txt");
    fs::write(&target, b"before").unwrap();
    prepare_write_journal(
        &session_dir,
        &session_dir,
        &SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
        &started.execution_id,
        &started.batch_id,
        &started.call_id,
        &[JournalWrite {
            ordinal: 0,
            target_path: target.clone(),
            new_bytes: b"after".to_vec(),
        }],
    )
    .unwrap();
    commit_write_journal(&session_dir, &session_dir, &started.execution_id).unwrap();
    let store = ArtifactStore::open(
        &session_dir.join("history.db"),
        policy(),
        clock(1_700_000_000_000),
    )
    .unwrap();
    let input = publish_input_for_start(&started, &bytes_for_tokens(policy().inline_tokens + 9));
    store
        .publish_batch(
            &mut log,
            &[input],
            Some(ArtifactCrashPoint::AfterCommitBeforeEvent),
        )
        .unwrap_err();
    drop(log);
    drop(store);
    let mut engine =
        SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    engine.run_recovery().unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"after");
    assert!(!session_dir
        .join("journals")
        .join(format!("write-{}.json", started.execution_id))
        .exists());
    assert!(engine.store().events().unwrap().iter().any(|event| {
        matches!(
            &event.event,
            CanonicalEvent::ToolExecutionFinished(finished)
                if finished.result.recovered && finished.result.status == ToolResultStatus::Success
        )
    }));
}

#[test]
fn retry_after_a_durable_artifact_appends_one_finish() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, started) = session_with_fixture_start(temp.path());
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1_700_000_000_000),
    )
    .unwrap();
    let input = publish_input_for_start(&started, &bytes_for_tokens(policy().inline_tokens + 7));
    let retry = input.clone();
    let again = input.clone();
    store
        .publish_batch(
            &mut log,
            &[input],
            Some(ArtifactCrashPoint::AfterCommitBeforeEvent),
        )
        .unwrap_err();
    store.publish_batch(&mut log, &[retry], None).unwrap();
    store.publish_batch(&mut log, &[again], None).unwrap();
    let finishes = log
        .events()
        .unwrap()
        .into_iter()
        .filter(|event| {
            matches!(
                &event.event,
                CanonicalEvent::ToolExecutionFinished(finished)
                    if finished.execution_id == started.execution_id
            )
        })
        .count();
    assert_eq!(finishes, 1);
}

#[test]
fn durable_blob_mismatch_opens_the_session_read_only() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, started) = session_with_fixture_start(temp.path());
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1_700_000_000_000),
    )
    .unwrap();
    let input = publish_input_for_start(&started, &bytes_for_tokens(policy().inline_tokens + 11));
    store.publish_batch(&mut log, &[input], None).unwrap();
    drop(log);
    drop(store);
    let db_path = temp.path().join("session").join("history.db");
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute("UPDATE artifact_blobs SET canonical_result = x'7b7d'", [])
            .unwrap();
    }
    let mut engine =
        SessionRecoveryEngine::new(&temp.path().join("session"), "01ARZ3NDEKTSV4RRFFQ69G5FAV")
            .unwrap();
    let err = engine.run_recovery().unwrap_err();
    assert_eq!(err.code(), "E_ARTIFACT_HASH_MISMATCH");
    assert!(engine.store().is_unhealthy());
}

#[test]
fn open_refuses_a_foreign_key_break() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, started) = session_with_fixture_start(temp.path());
    let db_path = temp.path().join("session").join("history.db");
    let store = ArtifactStore::open(&db_path, policy(), clock(1_700_000_000_000)).unwrap();
    let input = publish_input_for_start(&started, &bytes_for_tokens(policy().inline_tokens + 12));
    store.publish_batch(&mut log, &[input], None).unwrap();
    drop(log);
    drop(store);
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.pragma_update(None, "foreign_keys", false).unwrap();
        conn.execute("DELETE FROM artifact_blobs", []).unwrap();
    }
    let err = HistoryDatabase::open(&db_path).unwrap_err();
    assert_eq!(err.code(), "HISTORY_CANONICAL_DB_CORRUPT");
}

#[test]
fn tool_result_dto_pointer_spans_and_null_line_count() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, started) = session_with_fixture_start(temp.path());
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1_700_000_000_000),
    )
    .unwrap();
    let mut dto = ToolResultDto::failure(
        praana_core::tools::error::ToolErrorCode::ToolInternal,
        "failed",
        false,
        "write_file",
        "call_001",
    );
    dto.ok = true;
    dto.error = None;
    dto.data = Some(json!({ "stdout": "abcd", "stderr": "ef" }));
    let bytes = canonical_tool_result_bytes(&dto).unwrap();
    let mut input = publish_input_for_start(&started, &bytes);
    input.force_binary = true;
    store.publish_batch(&mut log, &[input], None).unwrap();
    let finished = log
        .events()
        .unwrap()
        .into_iter()
        .find_map(|event| match event.event {
            CanonicalEvent::ToolExecutionFinished(finished) => Some(finished),
            _ => None,
        });
    let finished = finished.expect("finish");
    assert_eq!(finished.result.body.line_count, None);
    match finished.result.body.content {
        praana_core::protocol::tool_result::ToolResultContent::Artifact(artifact) => {
            assert_eq!(artifact.reference.line_count, None);
        }
        praana_core::protocol::tool_result::ToolResultContent::Inline(_) => {
            panic!("shell channels were stored inline");
        }
    }
    let db_path = temp.path().join("session").join("history.db");
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let row = conn
        .query_row(
            "SELECT default_json_pointer, stdout_start_byte, stdout_end_byte, stderr_start_byte, stderr_end_byte, result_line_count FROM artifacts",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(row.0, "");
    assert_eq!(row.1, Some(0));
    assert_eq!(row.2, Some(4));
    assert_eq!(row.3, Some(4));
    assert_eq!(row.4, Some(6));
    assert_eq!(row.5, Some(1));
}

#[test]
fn string_content_uses_the_data_pointer() {
    let temp = tempfile::TempDir::new().unwrap();
    let (mut log, started) = session_with_fixture_start(temp.path());
    let store = ArtifactStore::open(
        &temp.path().join("session").join("history.db"),
        policy(),
        clock(1_700_000_000_000),
    )
    .unwrap();
    let mut dto = ToolResultDto::failure(
        praana_core::tools::error::ToolErrorCode::ToolInternal,
        "failed",
        false,
        "write_file",
        "call_001",
    );
    dto.ok = true;
    dto.error = None;
    dto.data = Some(json!({ "content": "hello" }));
    let bytes = canonical_tool_result_bytes(&dto).unwrap();
    let mut input = publish_input_for_start(&started, &bytes);
    input.force_binary = true;
    store.publish_batch(&mut log, &[input], None).unwrap();
    drop(store);
    let pointer: String =
        rusqlite::Connection::open(temp.path().join("session").join("history.db"))
            .unwrap()
            .query_row("SELECT default_json_pointer FROM artifacts", [], |row| {
                row.get(0)
            })
            .unwrap();
    assert_eq!(pointer, "/data/content");
}

struct StartedSession {
    tool_name: String,
    call_id: ToolCallId,
    call_index: u32,
    execution_id: ToolExecutionId,
    batch_id: ToolBatchId,
    step_id: StepId,
    turn_id: TurnId,
    attempt_id: AttemptId,
    started_event_id: EventId,
}

fn session_with_fixture_start(root: &Path) -> (EventLogStore, StartedSession) {
    let session = root.join("session");
    fs::create_dir_all(&session).unwrap();
    fs::copy(
        protocol_fixture("12_orphan_artifact_recovery").join("events.jsonl"),
        session.join("events.jsonl"),
    )
    .unwrap();
    write_new_session_meta(
        &session,
        &SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
        &Sha256Digest::from_hex_str(
            praana_core::history::event_log::EMPTY_PROJECT_CONTEXT_SOURCE_SHA256,
        )
        .unwrap(),
    )
    .unwrap();
    let log = EventLogStore::open(&session, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let events = log.events().unwrap();
    let started = events.iter().find_map(|event| match &event.event {
        CanonicalEvent::ToolExecutionStarted(started) => Some(StartedSession {
            tool_name: started.tool_name.clone(),
            call_id: started.call_id.clone(),
            call_index: started.call_index,
            execution_id: started.execution_id,
            batch_id: started.batch_id,
            step_id: started.step_id,
            turn_id: event.turn_id.unwrap(),
            attempt_id: event.attempt_id.unwrap(),
            started_event_id: event.event_id,
        }),
        _ => None,
    });
    (log, started.expect("fixture start"))
}

fn publish_input_for_start(started: &StartedSession, bytes: &[u8]) -> PublishInput {
    PublishInput {
        artifact_id: ArtifactId::from_str_canonical(&ulid("A1")).unwrap(),
        finish_event_id: EventId::from_str_canonical(&ulid("A2")).unwrap(),
        result_message_id: MessageId::from_str_canonical(&ulid("A3")).unwrap(),
        canonical_bytes: bytes.to_vec(),
        content_type: ArtifactContentType::Text,
        tool_name: started.tool_name.clone(),
        call_id: started.call_id.clone(),
        call_index: started.call_index,
        execution_id: started.execution_id,
        batch_id: started.batch_id,
        step_id: started.step_id,
        turn_id: started.turn_id,
        attempt_id: started.attempt_id,
        execution_started: true,
        started_event_id: Some(started.started_event_id),
        status: ToolResultStatus::Success,
        label: None,
        normalized_path: None,
        exit_code: None,
        redacted: true,
        redaction_json: "{\"applied\":false,\"kinds\":[],\"replacement_count\":0}".into(),
        force_binary: false,
    }
}

fn start_ids(events: Vec<praana_core::protocol::events::EventEnvelope>) -> Vec<ToolExecutionId> {
    events
        .into_iter()
        .filter_map(|event| match event.event {
            CanonicalEvent::ToolExecutionStarted(started) => Some(started.execution_id),
            _ => None,
        })
        .collect()
}
