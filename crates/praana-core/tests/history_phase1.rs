use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

use praana_core::history::event_log::*;
use praana_core::history::projection::*;
use praana_core::history::recovery::*;
use praana_core::protocol::compaction::render_historical_handoff;
use praana_core::protocol::errors::HistoryError;
use praana_core::protocol::events::*;
use praana_core::protocol::hashes::{
    calculate_prefix_hash, calculate_sha256, calculate_source_hash,
};
use praana_core::protocol::id::*;
use praana_core::protocol::json::serialize_event_compact;
use praana_core::protocol::models::*;
use praana_core::protocol::recovery::RecoveryKind;
use praana_core::token::GENERIC_ESTIMATOR_ID;

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protocol_v2")
}

fn jsonl_lines(path: &std::path::Path) -> Vec<String> {
    let bytes = fs::read(path).unwrap();
    let mut lines = Vec::new();
    let mut start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            lines.push(String::from_utf8(bytes[start..=index].to_vec()).unwrap());
            start = index + 1;
        }
    }
    lines
}

fn project_path(events_path: &std::path::Path) -> ConversationProjection {
    let events = EventLogStore::read_and_validate_from_path(events_path).unwrap();
    let lines = jsonl_lines(events_path);
    ConversationProjection::project_with_context(&events, Some(&lines), &[]).unwrap()
}

fn fixture_session_id() -> SessionId {
    SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap()
}

fn write_fixture_meta(session_dir: &std::path::Path, session_id: &str) {
    write_new_session_meta(
        session_dir,
        &SessionId::from_str_canonical(session_id).unwrap(),
    )
    .unwrap();
}

#[test]
fn committed_text_turn_projects_exactly() {
    let dir = fixture_root().join("01_committed_text_turn");
    let events_path = dir.join("events.jsonl");
    let expected_path = dir.join("expected_projection.json");

    let projection = project_path(&events_path);

    let expected_json = fs::read_to_string(expected_path).unwrap();
    let expected_proj: ConversationProjection = serde_json::from_str(&expected_json).unwrap();

    assert_eq!(projection, expected_proj);
}

#[test]
fn failed_partial_attempt_is_excluded() {
    let dir = fixture_root().join("07_failed_preemission_then_retry");
    let projection = project_path(&dir.join("events.jsonl"));
    assert_eq!(projection.messages.len(), 2); // user, assistant A2
}

#[test]
fn supersession_does_not_remove_audit_attempt() {
    let dir = fixture_root().join("07_failed_preemission_then_retry");
    let events = EventLogStore::read_events_from_path(&dir.join("events.jsonl")).unwrap();
    assert_eq!(events.len(), 9);
    assert!(events
        .iter()
        .any(|e| matches!(e.event, CanonicalEvent::AssistantAttemptFailed(_))));
    assert!(events
        .iter()
        .any(|e| matches!(e.event, CanonicalEvent::AttemptSuperseded(_))));
}

#[test]
fn tool_results_project_in_call_order() {
    let dir = fixture_root().join("03_parallel_results_finish_out_of_order");
    let projection = project_path(&dir.join("events.jsonl"));

    assert_eq!(projection.messages.len(), 5);
    // User, Assistant A1, ToolResult C1, ToolResult C2, Assistant A2
    if let ProjectedMessage::ToolResult(ref r1) = projection.messages[2] {
        assert_eq!(r1.call_id.as_str(), "call_001");
    } else {
        panic!("expected tool result 1");
    }
    if let ProjectedMessage::ToolResult(ref r2) = projection.messages[3] {
        assert_eq!(r2.call_id.as_str(), "call_002");
    } else {
        panic!("expected tool result 2");
    }
}

#[test]
fn incomplete_tool_batch_is_not_visible() {
    let dir = fixture_root().join("11_uncertain_mutation_recovery");
    let projection = project_path(&dir.join("events.jsonl"));
    // Mid-cycle before batch complete: only the accepted user message is visible.
    // The tool-using assistant step and its incomplete batch are excluded together.
    assert_eq!(projection.messages.len(), 1);
}

#[test]
fn reset_clears_visible_projection_and_state() {
    let dir = fixture_root().join("13_reset_boundary");
    let projection = project_path(&dir.join("events.jsonl"));
    assert_eq!(projection.reset_epoch, 1);
    assert_eq!(projection.messages.len(), 2);
}

#[test]
fn latest_handoff_replaces_older_handoff() {
    let dir = fixture_root().join("15_two_compaction_epochs");
    let projection = project_path(&dir.join("events.jsonl"));
    assert!(projection.active_handoff.is_some());
    assert_eq!(projection.active_handoff.as_ref().unwrap().epoch, 2);
}

#[test]
fn compacted_state_events_still_rebuild_state() {
    let dir = fixture_root().join("17_state_rebuild_and_focus");
    let projection = project_path(&dir.join("events.jsonl"));
    assert_eq!(projection.current_state.objects.len(), 2);
    assert!(projection.current_state.focus.is_some());
}

#[test]
fn model_switch_drops_incompatible_continuation() {
    let dir = fixture_root().join("16_model_switch_boundary");
    let projection = project_path(&dir.join("events.jsonl"));
    assert!(projection.active_continuation.is_none());
    assert_eq!(projection.pending_recovery.len(), 1);
}

#[test]
fn active_responses_continuation_is_retained() {
    let dir = fixture_root().join("05_responses_reasoning_active_cycle");
    let projection = project_path(&dir.join("events.jsonl"));
    assert!(projection.active_continuation.is_some());
}

#[test]
fn committed_reasoning_continuation_is_not_replayed() {
    let dir = fixture_root().join("06_responses_reasoning_cycle_closed");
    let projection = project_path(&dir.join("events.jsonl"));
    assert!(projection.active_continuation.is_none());
}

#[test]
fn run_all_successful_projection_fixtures() {
    let root = fixture_root();
    for entry in fs::read_dir(&root).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap().to_str().unwrap();
            if !name.starts_with('e') {
                let events_path = path.join("events.jsonl");
                let expected_path = path.join("expected_projection.json");
                let manifest_path = path.join("manifest.json");
                if events_path.exists() && expected_path.exists() {
                    let manifest_json = fs::read_to_string(&manifest_path).unwrap();
                    let manifest: serde_json::Value = serde_json::from_str(&manifest_json).unwrap();
                    // Artifact ownership is Phase 3; skip those fixtures here.
                    if manifest.get("phase").and_then(|v| v.as_str()) == Some("p3") {
                        continue;
                    }
                    let session_id = manifest["session_id"].as_str().unwrap();

                    let temp_dir = TempDir::new().unwrap();
                    let session_dir = temp_dir.path().join("session");
                    fs::create_dir_all(&session_dir).unwrap();
                    let temp_events_path = session_dir.join("events.jsonl");
                    fs::copy(&events_path, &temp_events_path).unwrap();
                    write_fixture_meta(&session_dir, session_id);

                    let engine = SessionRecoveryEngine::new(&session_dir, session_id)
                        .unwrap_or_else(|e| {
                            panic!("Failed opening session for fixture {}: {:?}", name, e)
                        });

                    if name == "19_truncated_final_line" {
                        assert!(
                            engine.store().quarantined_tail().is_some(),
                            "Fixture 19 must quarantine tail"
                        );
                    }

                    let projection = engine
                        .projection()
                        .unwrap_or_else(|e| panic!("Failed projecting fixture {}: {:?}", name, e));
                    let expected_json = fs::read_to_string(&expected_path).unwrap();
                    let expected_proj: ConversationProjection =
                        serde_json::from_str(&expected_json).unwrap();
                    assert_eq!(
                        projection, expected_proj,
                        "Projection mismatch in fixture {}",
                        name
                    );
                }
            }
        }
    }
}

#[test]
fn run_all_rejection_fixtures() {
    let root = fixture_root();
    for entry in fs::read_dir(&root).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap().to_str().unwrap();
            if name.starts_with('e') {
                let events_path = path.join("events.jsonl");
                let expected_path = path.join("expected_error.json");
                let manifest_path = path.join("manifest.json");
                if events_path.exists() && expected_path.exists() {
                    if manifest_path.exists() {
                        let manifest_json = fs::read_to_string(&manifest_path).unwrap();
                        let manifest: serde_json::Value =
                            serde_json::from_str(&manifest_json).unwrap();
                        // Artifact ownership is Phase 3; skip those fixtures here.
                        if manifest.get("phase").and_then(|v| v.as_str()) == Some("p3") {
                            continue;
                        }
                    }
                    let expected_err_str = fs::read_to_string(&expected_path).unwrap();
                    let expected_err: serde_json::Value =
                        serde_json::from_str(&expected_err_str).unwrap();
                    let expected_code = expected_err["code"].as_str().unwrap();

                    let res = EventLogStore::read_and_validate_from_path(&events_path);
                    assert!(
                        res.is_err(),
                        "Fixture {} was expected to fail with {}",
                        name,
                        expected_code
                    );
                    let err = res.unwrap_err();
                    assert_eq!(
                        err.code(),
                        expected_code,
                        "Fixture {} error code mismatch",
                        name
                    );
                    // expected_error.json is the exact HistoryError shape
                    // (§16.2): code, failing sequence, line, recoverability.
                    let expected_full: HistoryError = serde_json::from_str(&expected_err_str)
                        .unwrap_or_else(|e| {
                            panic!("Fixture {} expected_error.json invalid: {e}", name)
                        });
                    assert_eq!(err, expected_full, "Fixture {} full error mismatch", name);
                }
            }
        }
    }
}

#[test]
fn append_fsyncs_before_acknowledgement() {
    let temp_dir = TempDir::new().unwrap();
    let session_dir = temp_dir.path().join("session_01");
    let mut store =
        EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();

    let event = EventEnvelope {
        schema_version: 2,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAW").unwrap(),
        session_id: SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
        sequence: 1,
        timestamp_ms: 1788134400000,
        turn_id: None,
        attempt_id: None,
        event: CanonicalEvent::SessionStarted(SessionStarted {
            cwd: "/workspace".into(),
            agent: "praana".into(),
            config_schema_version: 1,
            config_digest_sha256: Sha256Digest::from_hex_str(
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            )
            .unwrap(),
            history_mode: HistoryMode::Append,
            projection_version: ProjectionId::from_str_canonical(
                praana_core::protocol::constants::PROJECTION_VERSION,
            )
            .unwrap(),
            compaction_policy_version: "rust-v2-compaction-1".into(),
            artifact_policy_version: "rust-v2-artifact-1".into(),
            token_estimator_schema_version: 1,
            unicode_utility_version: "praana-unicode-15.1-v1".into(),
            system_context_schema_version: 1,
            provider_registry_schema_version: 1,
            builtin_tool_catalog_schema_version: 1,
            redaction_version: "praana-redaction-v1".into(),
            ui_contract_schema_version: 1,
            initial_model: ModelSelection {
                provider: "openai".into(),
                protocol: "openai-responses-v1".into(),
                model: "gpt-5".into(),
                model_revision: Some("2026-08-01".into()),
                model_family: "gpt-5".into(),
                endpoint_fingerprint: Sha256Digest::from_hex_str(
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                )
                .unwrap(),
                reasoning_effort: ReasoningEffort::Medium,
            },
            initial_toolset_hash: Sha256Digest::from_hex_str(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            )
            .unwrap(),
        }),
    };

    store.append_event(&event).unwrap();
    assert_eq!(store.current_sequence(), 1);
}

#[test]
fn session_lock_prevents_concurrent_writers() {
    let temp_dir = TempDir::new().unwrap();
    let session_dir = temp_dir.path().join("session_02");
    let _store1 =
        EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();

    let store2_res = EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert!(store2_res.is_err());
    // History-domain code; the protocol boundary maps it to E_SESSION_LOCKED.
    assert_eq!(store2_res.unwrap_err().code(), "HISTORY_SESSION_LOCKED");
}

#[test]
fn recovery_is_idempotent_after_each_repair_event() {
    let dir = fixture_root().join("09_terminal_accept_crash_repair");
    let temp_dir = TempDir::new().unwrap();
    let session_dir = temp_dir.path().join("session_rec");
    fs::create_dir_all(&session_dir).unwrap();
    fs::copy(dir.join("events.jsonl"), session_dir.join("events.jsonl")).unwrap();
    write_fixture_meta(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV");

    let mut engine =
        SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let recovered_count_1 = engine.run_recovery().unwrap();
    assert_eq!(recovered_count_1, 1);

    let recovered_count_2 = engine.run_recovery().unwrap();
    assert_eq!(recovered_count_2, 0);
}

fn copy_fixture_to_session(fixture: &str, session_name: &str) -> (TempDir, std::path::PathBuf) {
    let dir = fixture_root().join(fixture);
    let temp_dir = TempDir::new().unwrap();
    let session_dir = temp_dir.path().join(session_name);
    fs::create_dir_all(&session_dir).unwrap();
    fs::copy(dir.join("events.jsonl"), session_dir.join("events.jsonl")).unwrap();
    write_fixture_meta(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    (temp_dir, session_dir)
}

#[test]
fn valid_final_line_without_lf_is_repaired() {
    let (_temp, session_dir) = copy_fixture_to_session("20_valid_final_line_without_lf", "s20");
    let before = fs::read(session_dir.join("events.jsonl")).unwrap();
    assert!(!before.ends_with(b"\n"), "fixture 20 must lack trailing LF");

    let store = EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    assert!(store.quarantined_tail().is_none());

    // Repair appends exactly one LF byte and fsyncs; the event is accepted.
    let after = fs::read(session_dir.join("events.jsonl")).unwrap();
    assert_eq!(after, [before, vec![b'\n']].concat());
    let events = EventLogStore::read_and_validate_from_path(&session_dir.join("events.jsonl"))
        .expect("repaired log must validate");
    assert_eq!(events.len() as u64, store.current_sequence());
}

#[test]
fn malformed_final_line_is_quarantined() {
    let (_temp, session_dir) = copy_fixture_to_session("19_truncated_final_line", "s19");
    let before = fs::read(session_dir.join("events.jsonl")).unwrap();

    let store = EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let sha = store
        .quarantined_tail()
        .expect("fixture 19 tail must quarantine")
        .to_owned();

    // The quarantined bytes are the exact original tail; the sha names them.
    let nl_positions: Vec<usize> = before
        .iter()
        .enumerate()
        .filter_map(|(i, b)| (*b == b'\n').then_some(i))
        .collect();
    assert_eq!(nl_positions.len(), 6);
    let tail = &before[nl_positions[5] + 1..];
    assert!(!tail.is_empty());
    assert_eq!(calculate_sha256(tail).to_string(), sha);
    let persisted = fs::read(
        session_dir
            .join("quarantine")
            .join(format!("events-tail-{sha}.bin")),
    )
    .expect("quarantine file must exist");
    assert_eq!(persisted, tail);

    // Only the longest valid prefix remains, and it replays.
    let after = fs::read(session_dir.join("events.jsonl")).unwrap();
    assert_eq!(after, before[..nl_positions[5] + 1].to_vec());
    let events = EventLogStore::read_and_validate_from_path(&session_dir.join("events.jsonl"))
        .expect("valid prefix must replay");
    assert_eq!(events.len(), 6);
    assert_eq!(store.current_sequence(), 6);
}

#[test]
fn malformed_nonfinal_line_is_fatal() {
    let (_temp, session_dir) = copy_fixture_to_session("e09_nonfinal_malformed", "se09");
    let err =
        EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap_err();
    assert_eq!(err.code(), "E_JSONL_NON_FINAL_MALFORMED");
    assert_eq!(err.sequence, None);
    assert_eq!(err.line, Some(2));
}

#[test]
fn sequence_gap_is_fatal() {
    let (_temp, session_dir) = copy_fixture_to_session("e05_sequence_gap", "se05");
    let err =
        EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap_err();
    assert_eq!(err.code(), "E_JSONL_SEQUENCE_GAP");
    assert_eq!(err.sequence, Some(4));
    assert_eq!(err.line, Some(3));
}

#[test]
fn event_id_duplicate_is_fatal() {
    let (_temp, session_dir) = copy_fixture_to_session("e07_event_id_duplicate", "se07");
    let err =
        EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap_err();
    assert_eq!(err.code(), "E_EVENT_ID_DUPLICATE");
}

#[test]
fn schema_version_is_fatal_on_open() {
    // A complete schema-1 line is an integrity failure, never a quarantinable
    // tail: the old session must not be silently reopened as fresh (§4.4).
    let (_temp, session_dir) = copy_fixture_to_session("e01_schema_version_1", "se01");
    let err =
        EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap_err();
    assert_eq!(err.code(), "E_SCHEMA_VERSION_UNSUPPORTED");
    assert_eq!(err.sequence, Some(1));
    assert_eq!(err.line, Some(1));
}

#[test]
fn unknown_field_on_final_line_is_fatal_on_open() {
    let (_temp, session_dir) = copy_fixture_to_session("e02_unknown_event_field", "se02");
    let err =
        EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap_err();
    assert_eq!(err.code(), "E_EVENT_SCHEMA_INVALID");
    assert_eq!(err.sequence, Some(2));
    assert_eq!(err.line, Some(2));
}

#[test]
fn open_attempt_becomes_failed_lost_attempt() {
    // Truncate fixture 09 just after attempt_started: the attempt is open.
    let events = EventLogStore::read_and_validate_from_path(
        &fixture_root()
            .join("09_terminal_accept_crash_repair")
            .join("events.jsonl"),
    )
    .unwrap();
    assert_eq!(events.len(), 5);
    let temp_dir = TempDir::new().unwrap();
    let session_dir = temp_dir.path().join("s_open");
    fs::create_dir_all(&session_dir).unwrap();
    let mut bytes = Vec::new();
    for event in &events[..4] {
        bytes.extend_from_slice(serialize_event_compact(event).unwrap().as_bytes());
        bytes.push(b'\n');
    }
    fs::write(session_dir.join("events.jsonl"), &bytes).unwrap();
    write_fixture_meta(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV");

    let mut engine =
        SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    assert_eq!(engine.run_recovery().unwrap(), 1);

    let after = engine.store().events().unwrap();
    assert_eq!(after.len(), 5);
    match &after[4].event {
        CanonicalEvent::AssistantAttemptFailed(failed) => {
            assert_eq!(failed.error.code, "E_ATTEMPT_LOST");
            assert_eq!(
                failed.error.class,
                praana_core::protocol::errors::ErrorClass::ProcessCrash
            );
            assert!(failed.partial_output.blocks.is_empty());
            assert!(!failed.observable_delta_emitted);
        }
        other => panic!("expected lost-attempt failure, got {other:?}"),
    }
    assert!(engine
        .pending_notices()
        .iter()
        .any(|n| n.kind == RecoveryKind::AttemptLost));

    // Idempotent: a second pass appends nothing.
    assert_eq!(engine.run_recovery().unwrap(), 0);
}

#[test]
fn terminal_accepted_step_is_committed_once() {
    let (_temp, session_dir) =
        copy_fixture_to_session("09_terminal_accept_crash_repair", "s09_commit");
    let mut engine =
        SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    assert_eq!(engine.run_recovery().unwrap(), 1);

    let after = engine.store().events().unwrap();
    assert_eq!(after.len(), 6);
    assert!(
        matches!(&after[5].event, CanonicalEvent::TurnCommitted(_)),
        "recovery must append exactly one turn_committed"
    );
    assert_eq!(engine.run_recovery().unwrap(), 0);
}

#[test]
fn uncertain_mutating_tool_is_never_rerun() {
    let (_temp, session_dir) =
        copy_fixture_to_session("11_uncertain_mutation_recovery", "s11_uncertain");
    let before = EventLogStore::read_events_from_path(&session_dir.join("events.jsonl")).unwrap();
    let started_before: Vec<_> = before
        .iter()
        .filter_map(|e| match &e.event {
            CanonicalEvent::ToolExecutionStarted(s) => Some(s.execution_id),
            _ => None,
        })
        .collect();
    assert_eq!(started_before.len(), 1);

    let mut engine =
        SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    engine.run_recovery().unwrap();

    // Recovery appends finishes but never a new start for a started tool.
    let after = engine.store().events().unwrap();
    assert!(after.len() > before.len());
    let started_after: Vec<_> = after
        .iter()
        .filter_map(|e| match &e.event {
            CanonicalEvent::ToolExecutionStarted(s) => Some(s.execution_id),
            _ => None,
        })
        .collect();
    assert_eq!(started_before, started_after);
    for event in &after[before.len()..] {
        assert!(
            !matches!(&event.event, CanonicalEvent::ToolExecutionStarted(_)),
            "recovery must not rerun a started tool"
        );
    }
    // The started execution receives the synthetic uncertain finish.
    let uncertain = after[before.len()..].iter().find_map(|e| match &e.event {
        CanonicalEvent::ToolExecutionFinished(f)
            if f.started_event_id.is_some()
                && f.result.status
                    == praana_core::protocol::tool_result::ToolResultStatus::Uncertain =>
        {
            Some(f)
        }
        _ => None,
    });
    assert!(
        uncertain.is_some(),
        "missing uncertain finish for started call"
    );
    let uncertain = uncertain.unwrap();
    assert!(uncertain.result.recovered);
    assert_eq!(uncertain.result.body.media_type, "application/json");
    assert_eq!(uncertain.result.body.line_count, None);
    assert_eq!(uncertain.result.body.estimator_id, GENERIC_ESTIMATOR_ID);
    match &uncertain.result.body.content {
        praana_core::protocol::tool_result::ToolResultContent::Inline(inline) => {
            assert!(inline.text.contains("E_TOOL_SIDE_EFFECT_UNCERTAIN"));
        }
        other => panic!("expected inline body, got {other:?}"),
    }
    assert!(engine
        .pending_notices()
        .iter()
        .any(|n| n.kind == RecoveryKind::ToolSideEffectUncertain));
}

#[test]
fn uncertain_mutating_peer_skips_unstarted_calls() {
    let (_temp, session_dir) =
        copy_fixture_to_session("11_uncertain_mutation_recovery", "s11_skip");
    let mut engine =
        SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    engine.run_recovery().unwrap();

    // call_002 never started and its mutating peer is uncertain: it is
    // skipped with a null start, then the batch completes in call order.
    let after = engine.store().events().unwrap();
    let skipped = after
        .iter()
        .find_map(|e| match &e.event {
            CanonicalEvent::ToolExecutionFinished(f) if f.call_id.as_str() == "call_002" => Some(f),
            _ => None,
        })
        .expect("missing skipped finish for unstarted peer");
    assert_eq!(
        skipped.result.status,
        praana_core::protocol::tool_result::ToolResultStatus::Skipped
    );
    assert_eq!(skipped.started_event_id, None);
    assert!(!skipped.result.recovered);
    let batch = after.iter().find_map(|e| match &e.event {
        CanonicalEvent::ToolBatchCompleted(b) => Some(b),
        _ => None,
    });
    assert!(batch.is_some(), "batch must complete after skip repair");
}

#[test]
fn recovery_is_idempotent_across_restarts() {
    // A fresh engine (new process) over a recovered log appends nothing and
    // observes identical events.
    for fixture in [
        "09_terminal_accept_crash_repair",
        "11_uncertain_mutation_recovery",
    ] {
        let (_temp, session_dir) = copy_fixture_to_session(fixture, "s_restart");
        let mut first =
            SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        first.run_recovery().unwrap();
        let mid = first.store().events().unwrap();
        drop(first);

        let mut second =
            SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        assert_eq!(
            second.run_recovery().unwrap(),
            0,
            "fixture {fixture} must be stable across restarts"
        );
        assert_eq!(second.store().events().unwrap(), mid);
    }
}

#[test]
fn append_acknowledgement_persists_exact_bytes_and_prefix_hash() {
    // Acknowledgement happens only after write+flush+fsync: the durable bytes
    // must equal compact JSON plus LF, chained into the prefix hash.
    let temp_dir = TempDir::new().unwrap();
    let session_dir = temp_dir.path().join("s_ack");
    let mut store =
        EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let event = EventEnvelope {
        schema_version: 2,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAW").unwrap(),
        session_id: SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
        sequence: 1,
        timestamp_ms: 1788134400000,
        turn_id: None,
        attempt_id: None,
        event: CanonicalEvent::SessionStarted(SessionStarted {
            cwd: "/workspace".into(),
            agent: "praana".into(),
            config_schema_version: 1,
            config_digest_sha256: Sha256Digest::from_hex_str(
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            )
            .unwrap(),
            history_mode: HistoryMode::Append,
            projection_version: ProjectionId::from_str_canonical(
                praana_core::protocol::constants::PROJECTION_VERSION,
            )
            .unwrap(),
            compaction_policy_version: "rust-v2-compaction-1".into(),
            artifact_policy_version: "rust-v2-artifact-1".into(),
            token_estimator_schema_version: 1,
            unicode_utility_version: "praana-unicode-15.1-v1".into(),
            system_context_schema_version: 1,
            provider_registry_schema_version: 1,
            builtin_tool_catalog_schema_version: 1,
            redaction_version: "praana-redaction-v1".into(),
            ui_contract_schema_version: 1,
            initial_model: ModelSelection {
                provider: "openai".into(),
                protocol: "openai-responses-v1".into(),
                model: "gpt-5".into(),
                model_revision: Some("2026-08-01".into()),
                model_family: "gpt-5".into(),
                endpoint_fingerprint: Sha256Digest::from_hex_str(
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                )
                .unwrap(),
                reasoning_effort: ReasoningEffort::Medium,
            },
            initial_toolset_hash: Sha256Digest::from_hex_str(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            )
            .unwrap(),
        }),
    };
    store.append_event(&event).unwrap();

    let line = format!("{}\n", serialize_event_compact(&event).unwrap());
    assert_eq!(
        fs::read(session_dir.join("events.jsonl")).unwrap(),
        line.as_bytes()
    );
    assert_eq!(
        store.prefix_hash(),
        calculate_prefix_hash(&[0u8; 32], 1, line.as_bytes())
    );
}

#[test]
fn crash_after_user_message_appends_turn_started() {
    let events = EventLogStore::read_and_validate_from_path(
        &fixture_root()
            .join("01_committed_text_turn")
            .join("events.jsonl"),
    )
    .unwrap();
    let temp = TempDir::new().unwrap();
    let session_dir = temp.path().join("user_only");
    fs::create_dir_all(&session_dir).unwrap();
    let mut bytes = Vec::new();
    for event in &events[..2] {
        bytes.extend_from_slice(serialize_event_compact(event).unwrap().as_bytes());
        bytes.push(b'\n');
    }
    fs::write(session_dir.join("events.jsonl"), &bytes).unwrap();
    write_fixture_meta(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV");

    let mut engine =
        SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    assert_eq!(engine.run_recovery().unwrap(), 1);
    let after = engine.store().events().unwrap();
    match &after[2].event {
        CanonicalEvent::TurnStarted(started) => {
            assert_eq!(started.turn_index, 1);
            assert_eq!(started.max_steps, 25);
            assert_eq!(started.model.model, "gpt-5");
        }
        other => panic!("expected turn_started, got {other:?}"),
    }
    assert_eq!(
        after
            .iter()
            .filter(|event| matches!(event.event, CanonicalEvent::TurnStarted(_)))
            .count(),
        1
    );
    assert_eq!(engine.run_recovery().unwrap(), 0);
}

#[test]
fn committed_usage_sums_failed_and_accepted_attempts() {
    let mut events = EventLogStore::read_and_validate_from_path(
        &fixture_root()
            .join("07_failed_preemission_then_retry")
            .join("events.jsonl"),
    )
    .unwrap();
    for event in &mut events {
        if let CanonicalEvent::AssistantAttemptFailed(failed) = &mut event.event {
            failed.usage.input_tokens = 40;
            failed.usage.output_tokens = 7;
            failed.usage.total_tokens = 47;
        }
    }
    let prefix: Vec<_> = events
        .into_iter()
        .filter(|event| !matches!(event.event, CanonicalEvent::TurnCommitted(_)))
        .collect();
    let temp = TempDir::new().unwrap();
    let session_dir = temp.path().join("usage");
    fs::create_dir_all(&session_dir).unwrap();
    let mut bytes = Vec::new();
    for event in &prefix {
        bytes.extend_from_slice(serialize_event_compact(event).unwrap().as_bytes());
        bytes.push(b'\n');
    }
    fs::write(session_dir.join("events.jsonl"), &bytes).unwrap();
    write_fixture_meta(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV");

    let mut engine =
        SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    assert_eq!(engine.run_recovery().unwrap(), 1);
    let committed =
        engine
            .store()
            .events()
            .unwrap()
            .into_iter()
            .rev()
            .find_map(|event| match event.event {
                CanonicalEvent::TurnCommitted(committed) => Some(committed),
                _ => None,
            });
    let committed = committed.expect("recovery must commit the turn");
    assert_eq!(committed.usage.input_tokens, 1240);
    assert_eq!(committed.usage.output_tokens, 17);
    assert_eq!(committed.usage.total_tokens, 1257);
}

#[test]
fn compaction_without_raw_lines_is_source_hash_mismatch() {
    for name in ["14_one_compaction_epoch", "e26_compaction_hash_mismatch"] {
        let events =
            EventLogStore::read_events_from_path(&fixture_root().join(name).join("events.jsonl"))
                .unwrap();
        let err = ConversationProjection::project(&events).unwrap_err();
        assert_eq!(err.code(), "E_COMPACTION_SOURCE_HASH_MISMATCH", "{name}");
    }
    let path = fixture_root().join("14_one_compaction_epoch/events.jsonl");
    project_path(&path);
}

#[test]
fn interruption_capsule_hashes_durable_jsonl_slice() {
    let path = fixture_root().join("08_partial_emission_then_interruption/events.jsonl");
    let events = EventLogStore::read_and_validate_from_path(&path).unwrap();
    let lines = jsonl_lines(&path);
    let turn_id = TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAY").unwrap();
    let capsule = build_interrupted_turn_capsule(&events, &lines, turn_id).unwrap();
    assert_eq!(capsule.source_start_sequence, 2);
    assert_eq!(capsule.source_end_sequence, 6);
    let expected = calculate_source_hash(
        &lines[(capsule.source_start_sequence as usize - 1)..capsule.source_end_sequence as usize],
    );
    assert_eq!(capsule.source_hash, expected);
}

#[test]
fn truncated_tail_notice_reaches_projection() {
    let (_temp, session_dir) = copy_fixture_to_session("19_truncated_final_line", "s19_proj");
    let engine = SessionRecoveryEngine::new(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let sha = engine.store().quarantined_tail().unwrap().to_owned();
    let projection = engine.projection().unwrap();
    assert_eq!(
        projection.pending_recovery[0].kind,
        RecoveryKind::TruncatedLogTail
    );
    assert_eq!(
        projection.pending_recovery[0].notice_id,
        truncated_log_tail_notice(&sha).notice_id
    );
}

#[test]
fn model_changed_notice_uses_handoff_renderer() {
    let path = fixture_root().join("16_model_switch_boundary/events.jsonl");
    let events = EventLogStore::read_and_validate_from_path(&path).unwrap();
    let projection = project_path(&path);
    let CanonicalEvent::ModelChanged(change) = &events.last().unwrap().event else {
        panic!("fixture 16 must end with model_changed");
    };
    assert_eq!(
        projection.pending_recovery[0].message,
        render_historical_handoff(&change.handoff).unwrap()
    );
}

#[test]
fn create_writes_immutable_meta_json() {
    let temp = TempDir::new().unwrap();
    let session_dir = temp.path().join("meta");
    let _store = EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let path = session_dir.join("meta.json");
    let meta: SessionMetaV1 =
        serde_json::from_str(fs::read_to_string(&path).unwrap().trim_end()).unwrap();
    assert_eq!(meta.schema_version, 1);
    assert_eq!(meta.session_id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert_eq!(meta.event_schema_version, 2);
    assert_eq!(meta.agent_id, "praana");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn meta_mismatch_refuses_open() {
    let (_temp, session_dir) = copy_fixture_to_session("01_committed_text_turn", "mismatch");
    fs::write(session_dir.join("config.snapshot.json"), "{}\n").unwrap();
    let err =
        EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap_err();
    assert_eq!(err.code(), "HISTORY_META_MISMATCH");
}

#[test]
fn open_empty_existing_events_jsonl_is_session_not_started() {
    let temp = TempDir::new().unwrap();
    let session_dir = temp.path().join("empty");
    fs::create_dir_all(&session_dir).unwrap();
    fs::write(session_dir.join("events.jsonl"), b"").unwrap();
    let err = EventLogStore::open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap_err();
    assert_eq!(err.code(), "E_SESSION_NOT_STARTED");
}

#[cfg(unix)]
#[test]
fn unix_session_files_use_private_modes() {
    use std::os::unix::fs::PermissionsExt;
    let (_temp, session_dir) = copy_fixture_to_session("19_truncated_final_line", "s19_mode");
    let store = EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let mode = |path: &std::path::Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&session_dir), 0o700);
    assert_eq!(mode(&session_dir.join("events.jsonl")), 0o600);
    assert_eq!(mode(&session_dir.join("session.lock")), 0o600);
    assert_eq!(mode(&session_dir.join("meta.json")), 0o600);
    let sha = store.quarantined_tail().unwrap();
    assert_eq!(mode(&session_dir.join("quarantine")), 0o700);
    assert_eq!(
        mode(
            &session_dir
                .join("quarantine")
                .join(format!("events-tail-{sha}.bin"))
        ),
        0o600
    );
}

#[cfg(unix)]
#[test]
fn symlink_session_dir_is_rejected() {
    let temp = TempDir::new().unwrap();
    let real = temp.path().join("real");
    let link = temp.path().join("link");
    fs::create_dir_all(&real).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let err = EventLogStore::create_or_open(&link, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap_err();
    assert_eq!(err.code(), "HISTORY_INSECURE_PERMISSIONS");
}

#[test]
fn quarantine_persist_failure_keeps_prefix_and_blocks_append() {
    let dir = fixture_root().join("19_truncated_final_line");
    let temp = TempDir::new().unwrap();
    let session_dir = temp.path().join("ro");
    fs::create_dir_all(&session_dir).unwrap();
    fs::copy(dir.join("events.jsonl"), session_dir.join("events.jsonl")).unwrap();
    write_fixture_meta(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    fs::write(session_dir.join("quarantine"), b"not-a-directory").unwrap();
    let before = fs::metadata(session_dir.join("events.jsonl"))
        .unwrap()
        .len();
    let mut store =
        EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    assert!(store.is_unhealthy());
    assert_eq!(
        fs::metadata(session_dir.join("events.jsonl"))
            .unwrap()
            .len(),
        before
    );
    assert_eq!(store.events().unwrap().len(), 6);
    let next = EventEnvelope {
        schema_version: 2,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FBZ").unwrap(),
        session_id: fixture_session_id(),
        sequence: 7,
        timestamp_ms: 1788134400999,
        turn_id: None,
        attempt_id: None,
        event: CanonicalEvent::SystemNote(SystemNote {
            code: "E_TEST".into(),
            level: NoteLevel::Info,
            audience: NoteAudience::Audit,
            message: "nope".into(),
            references: Vec::new(),
            details: Default::default(),
        }),
    };
    let err = store.append_event(&next).unwrap_err();
    assert_eq!(err.code(), "E_EVENT_DURABILITY_UNCERTAIN");
}

#[test]
fn interruption_reason_slugs_are_explicit() {
    let cases = [
        (InterruptionReason::UserAbort, "user_abort"),
        (InterruptionReason::ProviderFailure, "provider_failure"),
        (InterruptionReason::StepLimit, "step_limit"),
        (
            InterruptionReason::ActiveTurnTooLarge,
            "active_turn_too_large",
        ),
        (
            InterruptionReason::IncompatibleContinuation,
            "incompatible_continuation",
        ),
        (
            InterruptionReason::ToolRuntimePoisoned,
            "tool_runtime_poisoned",
        ),
        (InterruptionReason::SessionShutdown, "session_shutdown"),
    ];
    for (reason, slug) in cases {
        assert_eq!(interruption_reason_slug(&reason), slug);
    }
}
