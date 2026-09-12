use praana_core::history::replay::EventReplayer;
use praana_core::protocol::compaction::HistoricalHandoffV1;
use praana_core::protocol::constants::*;
use praana_core::protocol::continuation::*;
use praana_core::protocol::errors::{ErrorClass, ProtocolError};
use praana_core::protocol::events::*;
use praana_core::protocol::hashes::*;
use praana_core::protocol::id::*;
use praana_core::protocol::json::*;
use praana_core::protocol::messages::{
    AssistantBlock, ConversationMessage, RefusalBlock, ToolCall, UserBlock,
};
use praana_core::protocol::models::*;
use praana_core::protocol::recovery::RecoveryNotice;
use praana_core::protocol::state_graph::StateGraphV1;
use praana_core::protocol::tool_result::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureProjection {
    reset_epoch: u32,
    through_sequence: u64,
    active_handoff: Option<HistoricalHandoffV1>,
    messages: Vec<ConversationMessage>,
    current_state: StateGraphV1,
    active_turn: Option<TurnId>,
    pending_recovery: Vec<RecoveryNotice>,
    active_continuation: Option<ProviderContinuation>,
    compacted_turn_ids: Vec<TurnId>,
}

fn event_kind_name(event: &CanonicalEvent) -> &'static str {
    match event {
        CanonicalEvent::SessionStarted(_) => "session_started",
        CanonicalEvent::UserMessageAccepted(_) => "user_message_accepted",
        CanonicalEvent::TurnStarted(_) => "turn_started",
        CanonicalEvent::AssistantAttemptStarted(_) => "assistant_attempt_started",
        CanonicalEvent::AssistantAttemptFailed(_) => "assistant_attempt_failed",
        CanonicalEvent::AssistantStepAccepted(_) => "assistant_step_accepted",
        CanonicalEvent::AttemptSuperseded(_) => "attempt_superseded",
        CanonicalEvent::ToolExecutionStarted(_) => "tool_execution_started",
        CanonicalEvent::ToolExecutionFinished(_) => "tool_execution_finished",
        CanonicalEvent::ToolBatchCompleted(_) => "tool_batch_completed",
        CanonicalEvent::TurnCommitted(_) => "turn_committed",
        CanonicalEvent::TurnInterrupted(_) => "turn_interrupted",
        CanonicalEvent::StateChanged(_) => "state_changed",
        CanonicalEvent::HistoryCompacted(_) => "history_compacted",
        CanonicalEvent::ModelChanged(_) => "model_changed",
        CanonicalEvent::ResetBoundary(_) => "reset_boundary",
        CanonicalEvent::SystemNote(_) => "system_note",
    }
}

#[test]
fn event_round_trip_all_kinds() {
    let mut seen = HashSet::new();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protocol_v2");
    for entry in fs::read_dir(&root).unwrap() {
        let path = entry.unwrap().path();
        if !path.is_dir() {
            continue;
        }
        let events_path = path.join("events.jsonl");
        if !events_path.exists() {
            continue;
        }
        let Ok(events) =
            praana_core::history::event_log::EventLogStore::read_events_from_path(&events_path)
        else {
            continue;
        };
        for event in events {
            let serialized = serialize_event_compact(&event).unwrap();
            let deserialized: EventEnvelope = deserialize_event_strict(&serialized).unwrap();
            assert_eq!(event, deserialized);
            seen.insert(event_kind_name(&event.event));
        }
    }
    seen.insert(event_kind_name(&CanonicalEvent::SystemNote(SystemNote {
        code: "E_TEST".into(),
        level: NoteLevel::Info,
        audience: NoteAudience::Audit,
        message: "note".into(),
        references: Vec::new(),
        details: BTreeMap::new(),
    })));
    let expected = [
        "session_started",
        "user_message_accepted",
        "turn_started",
        "assistant_attempt_started",
        "assistant_attempt_failed",
        "assistant_step_accepted",
        "attempt_superseded",
        "tool_execution_started",
        "tool_execution_finished",
        "tool_batch_completed",
        "turn_committed",
        "turn_interrupted",
        "state_changed",
        "history_compacted",
        "model_changed",
        "reset_boundary",
        "system_note",
    ];
    for kind in expected {
        assert!(
            seen.contains(kind),
            "missing round-trip coverage for {kind}"
        );
    }
    assert_eq!(seen.len(), 17);
}

#[test]
fn successful_fixture_events_deserialize_as_normative_dtos() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protocol_v2");
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap();
        if !path.is_dir() || name.starts_with('e') {
            continue;
        }

        let bytes = fs::read(path.join("events.jsonl")).unwrap();
        let mut lines: Vec<&[u8]> = bytes.split(|byte| *byte == b'\n').collect();
        if bytes.ends_with(b"\n") {
            lines.pop();
        }
        if name == "19_truncated_final_line" {
            lines.pop();
        }

        for (index, line) in lines.into_iter().enumerate() {
            let text = std::str::from_utf8(line).unwrap();
            let event = deserialize_event_strict::<EventEnvelope>(text).unwrap_or_else(|error| {
                panic!("{name} line {} failed DTO decode: {error}", index + 1)
            });
            assert_eq!(
                serialize_event_compact(&event).unwrap(),
                text,
                "{name} line {} is not canonical DTO field order",
                index + 1
            );
        }
    }
}

#[test]
fn successful_fixture_expectations_deserialize_as_owner_dtos() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protocol_v2");
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_str().unwrap();
        if !path.is_dir() || name.starts_with('e') {
            continue;
        }

        let bytes = fs::read(path.join("expected_projection.json")).unwrap();
        let expected: FixtureProjection = serde_json::from_slice(&bytes)
            .unwrap_or_else(|error| panic!("{name} expectation failed DTO decode: {error}"));
        assert_eq!(
            serde_json::to_string(&expected).unwrap().as_bytes(),
            bytes.strip_suffix(b"\n").unwrap_or(&bytes),
            "{name} expectation is not canonical DTO field order"
        );
        let _ = (
            expected.reset_epoch,
            expected.through_sequence,
            expected.active_handoff,
            expected.messages,
            expected.current_state,
            expected.active_turn,
            expected.pending_recovery,
            expected.active_continuation,
            expected.compacted_turn_ids,
        );
    }
}

#[test]
fn option_fields_serialize_as_null() {
    let session_id = SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let event_id = EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAW").unwrap();

    let envelope = EventEnvelope {
        schema_version: 2,
        event_id,
        session_id,
        sequence: 1,
        timestamp_ms: 100,
        turn_id: None,
        attempt_id: None,
        event: CanonicalEvent::SessionStarted(SessionStarted {
            cwd: "/workspace/praana".into(),
            agent: "praana".into(),
            config_schema_version: 1,
            config_digest_sha256: Sha256Digest::from_hex_str(
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            )
            .unwrap(),
            history_mode: HistoryMode::Append,
            projection_version: ProjectionId::from_str_canonical(PROJECTION_VERSION).unwrap(),
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

    let serialized = serialize_event_compact(&envelope).unwrap();
    assert!(serialized.contains(r#""turn_id":null"#));
    assert!(serialized.contains(r#""attempt_id":null"#));
}

#[test]
fn unknown_fields_are_rejected() {
    let json_str = r#"{"schema_version":2,"event_id":"01ARZ3NDEKTSV4RRFFQ69G5FAX","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","sequence":2,"timestamp_ms":1788134400010,"turn_id":null,"attempt_id":null,"actor":"user","event":{"kind":"user_message_accepted","data":{"message":{"message_id":"01ARZ3NDEKTSV4RRFFQ69G5FAZ","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","blocks":[{"type":"text","data":{"text":"hi"}}]}}}}"#;
    let res: Result<EventEnvelope, _> = deserialize_event_strict(json_str);
    assert!(res.is_err());
}

#[test]
fn duplicate_json_keys_are_rejected() {
    let json_str = r#"{"schema_version":2,"event_id":"01ARZ3NDEKTSV4RRFFQ69G5FAX","event_id":"01ARZ3NDEKTSV4RRFFQ69G5FAX","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","sequence":2,"timestamp_ms":1788134400010,"turn_id":null,"attempt_id":null,"event":{"kind":"user_message_accepted","data":{"message":{"message_id":"01ARZ3NDEKTSV4RRFFQ69G5FAZ","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","blocks":[{"type":"text","data":{"text":"hi"}}]}}}}"#;
    let res: Result<EventEnvelope, _> = deserialize_event_strict(json_str);
    assert!(res.is_err());
}

#[test]
fn ulid_newtypes_reject_noncanonical_text() {
    // Lowercase
    assert!(EventId::from_str_canonical("01arz3ndektsv4rrffq69g5fax").is_err());
    // Invalid characters I, L, O, U
    assert!(EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAI").is_err());
    assert!(EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAL").is_err());
    assert!(EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAO").is_err());
    assert!(EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAU").is_err());
    // Length not 26
    assert!(EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FA").is_err());
    assert!(EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAXXX").is_err());
}

#[test]
fn provider_tool_call_ids_are_opaque() {
    // Non-empty, up to 256 bytes, no control chars
    assert!(ToolCallId::from_str_canonical("call_001").is_ok());
    assert!(ToolCallId::from_str_canonical("").is_err());
    assert!(ToolCallId::from_str_canonical("call\x001").is_err());
    assert!(ToolCallId::from_str_canonical("call\n1").is_err());
    let long_id = "a".repeat(257);
    assert!(ToolCallId::from_str_canonical(&long_id).is_err());
}

#[test]
fn request_hash_excludes_headers_and_credentials() {
    let body = serde_json::json!({
        "model": "gpt-5",
        "messages": [{"role": "user", "content": "hello"}]
    });
    let h1 = calculate_request_hash(&body).unwrap();
    let body_same_keys_diff_order = serde_json::json!({
        "messages": [{"role": "user", "content": "hello"}],
        "model": "gpt-5"
    });
    let h2 = calculate_request_hash(&body_same_keys_diff_order).unwrap();
    assert_eq!(h1, h2);
}

#[test]
fn source_hash_includes_line_feeds() {
    let lines = vec![
        "{\"event\":\"a\"}\n".to_string(),
        "{\"event\":\"b\"}\n".to_string(),
    ];
    let h = calculate_source_hash(&lines);
    assert_eq!(
        h.to_string(),
        "69cbad9748d918b21eb19df30275d0f1fab56af5222a686ddc8f69e81f4ff0d5"
    );
}

#[test]
fn tool_arguments_use_rfc8785() {
    let args1 = serde_json::json!({"z": 1, "a": 2});
    let args2 = serde_json::json!({"a": 2, "z": 1});
    let h1 = calculate_tool_arguments_hash(&args1).unwrap();
    let h2 = calculate_tool_arguments_hash(&args2).unwrap();
    assert_eq!(h1, h2);
}

#[test]
fn recovery_notice_id_derivation_matches_crockford() {
    let kind = "attempt_lost";
    let keys = vec!["01ARZ3NDEKTSV4RRFFQ69G5FB1"];
    let id = derive_recovery_notice_id(kind, &keys);
    assert_eq!(id.to_string().len(), 26);
    assert!(RecoveryNoticeId::from_str_canonical(&id.to_string()).is_ok());
}

#[test]
fn projection_id_is_exact() {
    assert!(serde_json::from_str::<ProjectionId>(r#""rust-v2-projection-1""#).is_ok());
    assert!(serde_json::from_str::<ProjectionId>(r#""rust-v2-projection-2""#).is_err());
}

#[test]
fn provider_continuation_uses_normative_discriminant() {
    let continuation = ProviderContinuation::Gemini(GeminiContinuation {
        scope: ContinuationScope {
            provider: "google".into(),
            protocol: "gemini-v1".into(),
            model: "gemini".into(),
            model_revision: None,
            endpoint_fingerprint: Sha256Digest::from_hex_str(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .unwrap(),
        },
        thought_signatures_base64: Vec::new(),
    });
    let json = serde_json::to_string(&continuation).unwrap();
    assert!(json.contains(r#""provider_protocol":"gemini""#));
}

#[test]
fn protocol_error_serializes_optional_fields_as_null() {
    let error = ProtocolError {
        code: "E_PROVIDER".into(),
        class: ErrorClass::Transport,
        message: "failed".into(),
        retryable: true,
        http_status: None,
        retry_after_ms: None,
    };
    let json = serde_json::to_string(&error).unwrap();
    assert!(json.contains(r#""http_status":null"#));
    assert!(json.contains(r#""retry_after_ms":null"#));
}

#[test]
fn strict_decoder_reports_normative_boundary_errors() {
    let oversized = " ".repeat(MAX_EVENT_LINE_BYTES + 1);
    let error = deserialize_event_strict::<serde_json::Value>(&oversized).unwrap_err();
    assert_eq!(error.code(), "E_EVENT_TOO_LARGE");

    let unsupported = r#"{"schema_version":3}"#;
    let error = deserialize_event_strict::<serde_json::Value>(unsupported).unwrap_err();
    assert_eq!(error.code(), "E_SCHEMA_VERSION_UNSUPPORTED");

    let escaped_duplicate = r#"{"a":1,"\u0061":2}"#;
    let error = deserialize_event_strict::<serde_json::Value>(escaped_duplicate).unwrap_err();
    assert_eq!(error.code(), "E_EVENT_SCHEMA_INVALID");
}

#[test]
fn system_note_and_uncertain_finish_round_trip() {
    // Kinds with no golden fixture yet (§15.10): system_note envelopes and
    // recovery uncertain finishes must still be exact DTO round-trips.
    let session_id = SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let note = EventEnvelope {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FBC").unwrap(),
        session_id,
        sequence: 7,
        timestamp_ms: 1788134400020,
        turn_id: None,
        attempt_id: None,
        event: CanonicalEvent::SystemNote(SystemNote {
            code: "E_PROVIDER_STREAM".into(),
            level: NoteLevel::Warning,
            audience: NoteAudience::Audit,
            message: "provider failed".into(),
            references: vec![EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB1").unwrap()],
            details: BTreeMap::from([("retryable".to_owned(), serde_json::Value::Bool(false))]),
        }),
    };
    let serialized = serialize_event_compact(&note).unwrap();
    assert_eq!(
        deserialize_event_strict::<EventEnvelope>(&serialized).unwrap(),
        note
    );

    let text = "{\"code\":\"E_TOOL_SIDE_EFFECT_UNCERTAIN\",\"error\":\"The process stopped after this tool was marked started. Its side effects are unknown. Do not repeat the mutation until state has been inspected.\",\"ok\":false}";
    let sha = calculate_sha256(text.as_bytes());
    let finish = EventEnvelope {
        schema_version: EVENT_SCHEMA_VERSION,
        event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FBD").unwrap(),
        session_id,
        sequence: 8,
        timestamp_ms: 1788134400030,
        turn_id: Some(TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAY").unwrap()),
        attempt_id: Some(AttemptId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB2").unwrap()),
        event: CanonicalEvent::ToolExecutionFinished(ToolExecutionFinished {
            batch_id: ToolBatchId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB7").unwrap(),
            execution_id: ToolExecutionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB8")
                .unwrap(),
            step_id: StepId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB3").unwrap(),
            call_id: ToolCallId::from_str_canonical("call_001").unwrap(),
            call_index: 0,
            started_event_id: Some(
                EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB6").unwrap(),
            ),
            result: ToolResultMessage {
                message_id: MessageId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FBA").unwrap(),
                turn_id: TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAY").unwrap(),
                step_id: StepId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB3").unwrap(),
                batch_id: ToolBatchId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB7").unwrap(),
                execution_id: ToolExecutionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB8")
                    .unwrap(),
                call_id: ToolCallId::from_str_canonical("call_001").unwrap(),
                tool_name: "write_file".into(),
                status: ToolResultStatus::Uncertain,
                body: ToolResultBody {
                    media_type: praana_core::protocol::constants::TOOL_RESULT_MEDIA_TYPE.into(),
                    content: ToolResultContent::Inline(InlineToolResult {
                        text: text.to_owned(),
                    }),
                    sha256: sha.clone(),
                    byte_count: text.len() as u64,
                    line_count: None,
                    estimated_tokens: 0,
                    token_estimator_schema_version: 1,
                    estimator_id: praana_core::token::GENERIC_ESTIMATOR_ID.into(),
                    token_input_sha256: sha,
                    redacted: false,
                },
                recovered: true,
            },
        }),
    };
    let serialized = serialize_event_compact(&finish).unwrap();
    assert_eq!(
        deserialize_event_strict::<EventEnvelope>(&serialized).unwrap(),
        finish
    );
}

#[test]
fn hash_vectors_are_independently_pinned() {
    // Independent vectors (sha256sum over canonical bytes): a hash-domain
    // regression fails here instead of hiding behind a self-comparison.
    let lines = vec![
        "{\"event\":\"a\"}\n".to_string(),
        "{\"event\":\"b\"}\n".to_string(),
    ];
    assert_eq!(
        calculate_source_hash(&lines).to_string(),
        "69cbad9748d918b21eb19df30275d0f1fab56af5222a686ddc8f69e81f4ff0d5"
    );
    let args = serde_json::json!({"z": 1, "a": 2});
    assert_eq!(
        calculate_tool_arguments_hash(&args).unwrap().to_string(),
        "c2985c5ba6f7d2a55e768f92490ca09388e95bc4cccb9fdf11b15f4d42f93e73"
    );
}

#[test]
fn recovery_notice_ids_match_spec_domain() {
    // §4.3 vectors computed outside this implementation: kind plus source
    // keys only; truncated tails key on `tail:<sha256>`.
    assert_eq!(
        derive_recovery_notice_id("attempt_lost", &["01ARZ3NDEKTSV4RRFFQ69G5FB2"]).to_string(),
        "4D82XPCX5YEA4EQY88HTE8AHKK"
    );
    assert_eq!(
        derive_recovery_notice_id("turn_interrupted", &["01ARZ3NDEKTSV4RRFFQ69G5FB9"]).to_string(),
        "5VD3APWRSTYF0VTX27ZQQ69YB2"
    );
    assert_eq!(
        derive_recovery_notice_id(
            "truncated_log_tail",
            &["tail:fb8c3f332fa841a6cc872b3e4536b123a43502f3f9327242f80703ce82169b98"]
        )
        .to_string(),
        "4J18A47WDF5C71SMKHM40BEF4E"
    );
    assert_eq!(
        derive_recovery_notice_id(
            "tool_side_effect_uncertain",
            &["01ARZ3NDEKTSV4RRFFQ69G5FB6"]
        )
        .to_string(),
        "7VW993QRJZP7F3GK31DF74YQNY"
    );
    // The `tail:` prefix is load-bearing, not cosmetic.
    assert_ne!(
        derive_recovery_notice_id(
            "truncated_log_tail",
            &["tail:fb8c3f332fa841a6cc872b3e4536b123a43502f3f9327242f80703ce82169b98"]
        ),
        derive_recovery_notice_id(
            "truncated_log_tail",
            &["fb8c3f332fa841a6cc872b3e4536b123a43502f3f9327242f80703ce82169b98"]
        )
    );
}

fn replay_fixture_with_mutation(
    fixture: &str,
    sequence: u64,
    mutate: impl FnOnce(&mut EventEnvelope),
) -> Result<(), praana_core::protocol::errors::HistoryError> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protocol_v2");
    let bytes = fs::read(root.join(fixture).join("events.jsonl")).unwrap();
    let mut envelopes = Vec::new();
    for line in bytes.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        envelopes.push(
            deserialize_event_strict::<EventEnvelope>(std::str::from_utf8(line).unwrap()).unwrap(),
        );
    }
    if let Some(envelope) = envelopes.iter_mut().find(|e| e.sequence == sequence) {
        mutate(envelope);
    }
    let mut replay = EventReplayer::new();
    for (index, envelope) in envelopes.iter().enumerate() {
        replay.process_event(envelope, Some(index + 1), None)?;
    }
    Ok(())
}

#[test]
fn reserved_model_change_values_are_rejected() {
    // §5.10: ConfigReload and Retained are reserved in the initial
    // implementation. Fixture 21 is valid with `none`; flipping either enum
    // must fail replay.
    let retained = replay_fixture_with_mutation("21_provider_fallback_initial_attempt", 6, |e| {
        if let CanonicalEvent::ModelChanged(change) = &mut e.event {
            change.continuation_disposition = ContinuationDisposition::Retained;
        } else {
            panic!("sequence 6 must be model_changed");
        }
    });
    assert_eq!(retained.unwrap_err().code(), "E_EVENT_TRANSITION_INVALID");
    let reload = replay_fixture_with_mutation("21_provider_fallback_initial_attempt", 6, |e| {
        if let CanonicalEvent::ModelChanged(change) = &mut e.event {
            change.reason = ModelChangeReason::ConfigReload;
        } else {
            panic!("sequence 6 must be model_changed");
        }
    });
    assert_eq!(reload.unwrap_err().code(), "E_EVENT_TRANSITION_INVALID");
}

#[test]
fn empty_message_blocks_are_rejected() {
    let empty_user = replay_fixture_with_mutation("01_committed_text_turn", 2, |e| {
        if let CanonicalEvent::UserMessageAccepted(accepted) = &mut e.event {
            accepted.message.blocks.clear();
        } else {
            panic!("sequence 2 must be user_message_accepted");
        }
    });
    assert_eq!(empty_user.unwrap_err().code(), "E_EVENT_SCHEMA_INVALID");

    let empty_user_text = replay_fixture_with_mutation("01_committed_text_turn", 2, |e| {
        if let CanonicalEvent::UserMessageAccepted(accepted) = &mut e.event {
            match &mut accepted.message.blocks[0] {
                UserBlock::Text(text) => text.text.clear(),
                _ => panic!("fixture user block must be text"),
            }
        } else {
            panic!("sequence 2 must be user_message_accepted");
        }
    });
    assert_eq!(
        empty_user_text.unwrap_err().code(),
        "E_EVENT_SCHEMA_INVALID"
    );

    let empty_assistant_text = replay_fixture_with_mutation("01_committed_text_turn", 5, |e| {
        if let CanonicalEvent::AssistantStepAccepted(accepted) = &mut e.event {
            match &mut accepted.message.blocks[0] {
                AssistantBlock::Text(text) => text.text.clear(),
                _ => panic!("fixture assistant block must be text"),
            }
        } else {
            panic!("sequence 5 must be assistant_step_accepted");
        }
    });
    assert_eq!(
        empty_assistant_text.unwrap_err().code(),
        "E_EVENT_SCHEMA_INVALID"
    );

    let empty_assistant = replay_fixture_with_mutation("01_committed_text_turn", 5, |e| {
        if let CanonicalEvent::AssistantStepAccepted(accepted) = &mut e.event {
            accepted.message.blocks.clear();
        } else {
            panic!("sequence 5 must be assistant_step_accepted");
        }
    });
    assert_eq!(
        empty_assistant.unwrap_err().code(),
        "E_EVENT_SCHEMA_INVALID"
    );
}

#[test]
fn refusal_tool_call_steps_are_rejected() {
    // §5.3: a refusal never shares an accepted step with a tool call.
    let mixed = replay_fixture_with_mutation("02_single_tool_cycle_inline", 5, |e| {
        if let CanonicalEvent::AssistantStepAccepted(accepted) = &mut e.event {
            accepted
                .message
                .blocks
                .push(AssistantBlock::Refusal(RefusalBlock {
                    text: "I cannot do that.".into(),
                    provider_item_id: None,
                }));
        } else {
            panic!("sequence 5 must be assistant_step_accepted");
        }
    });
    assert_eq!(mixed.unwrap_err().code(), "E_EVENT_SCHEMA_INVALID");
}

#[test]
fn reset_requires_clears_state() {
    // §13.1: clears_state MUST be true in schema 2.
    let uncleared = replay_fixture_with_mutation("13_reset_boundary", 7, |e| {
        if let CanonicalEvent::ResetBoundary(reset) = &mut e.event {
            reset.clears_state = false;
        } else {
            panic!("sequence 7 must be reset_boundary");
        }
    });
    assert_eq!(uncleared.unwrap_err().code(), "E_EVENT_TRANSITION_INVALID");
}

#[test]
fn model_and_tool_name_bounds_are_enforced() {
    assert!(serde_json::from_str::<ModelSelection>(
        r#"{"provider":"","protocol":"openai-responses-v1","model":"gpt-5","model_revision":null,"model_family":"gpt-5","endpoint_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reasoning_effort":"medium"}"#
    )
    .is_err());
    let too_long = "a".repeat(257);
    let json = format!(
        r#"{{"provider":"{too_long}","protocol":"openai-responses-v1","model":"gpt-5","model_revision":null,"model_family":"gpt-5","endpoint_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","reasoning_effort":"medium"}}"#
    );
    assert!(serde_json::from_str::<ModelSelection>(&json).is_err());
    assert!(serde_json::from_str::<ToolCall>(
        r#"{"call_id":"call_001","name":"ReadFile","arguments":{},"raw_arguments":"{}"}"#
    )
    .is_err());
    assert!(serde_json::from_str::<ToolCall>(
        r#"{"call_id":"call_001","name":"read_file","arguments":{},"raw_arguments":"{}"}"#
    )
    .is_ok());
}

#[test]
fn raw_arguments_duplicate_keys_are_invalid() {
    let err = replay_fixture_with_mutation("02_single_tool_cycle_inline", 5, |e| {
        if let CanonicalEvent::AssistantStepAccepted(accepted) = &mut e.event {
            for block in &mut accepted.message.blocks {
                if let AssistantBlock::ToolCall(call) = block {
                    call.raw_arguments = r#"{"path":"a","path":"b"}"#.into();
                }
            }
        } else {
            panic!("sequence 5 must be assistant_step_accepted");
        }
    });
    assert_eq!(err.unwrap_err().code(), "E_TOOL_ARGUMENTS_INVALID");
}

#[test]
fn attempt_number_gaps_are_rejected() {
    let err = replay_fixture_with_mutation("07_failed_preemission_then_retry", 6, |e| {
        if let CanonicalEvent::AssistantAttemptStarted(started) = &mut e.event {
            started.attempt_number = 3;
        } else {
            panic!("sequence 6 must be assistant_attempt_started");
        }
    });
    assert_eq!(err.unwrap_err().code(), "E_EVENT_TRANSITION_INVALID");
}
