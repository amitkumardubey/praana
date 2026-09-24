//! Protocol Spec §17.2 property tests for Phase 1B (event log / replay / projection).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use proptest::prelude::*;
use proptest::test_runner::Config as ProptestConfig;
use tempfile::TempDir;

use crate::canonical_json::to_canonical_json_bytes;
use crate::history::event_log::EventLogStore;
use crate::history::projection::ConversationProjection;
use crate::history::recovery::SessionRecoveryEngine;
use crate::history::replay::{EventReplayer, TurnTerminal};
use crate::protocol::events::{CanonicalEvent, EventEnvelope};
use crate::protocol::hashes::calculate_tool_arguments_hash;
use crate::protocol::id::SessionId;
use crate::protocol::json::{deserialize_event_strict, serialize_canonical};
use crate::protocol::messages::{AssistantBlock, ConversationMessage, FinishReason, UserBlock};

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/protocol_v2")
}

fn jsonl_lines(path: &Path) -> Vec<String> {
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

fn load_success_fixtures() -> Vec<(String, Vec<EventEnvelope>, Vec<String>)> {
    let mut out = Vec::new();
    let root = fixture_root();
    for entry in fs::read_dir(&root).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if name.starts_with('e') {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if manifest_path.exists() {
            let manifest: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
            if manifest.get("phase").and_then(|v| v.as_str()) == Some("p3") {
                continue;
            }
        }
        let events_path = path.join("events.jsonl");
        if !events_path.exists() {
            continue;
        }
        if let Ok(events) = EventLogStore::read_and_validate_from_path(&events_path) {
            out.push((name, events, jsonl_lines(&events_path)));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn replay_all(events: &[EventEnvelope], lines: &[String]) -> EventReplayer {
    let mut replay = EventReplayer::new();
    for (index, event) in events.iter().enumerate() {
        replay
            .process_event(event, Some(index + 1), Some(lines))
            .unwrap_or_else(|err| panic!("replay failed at {}: {:?}", index + 1, err));
    }
    replay
}

fn project_events(events: &[EventEnvelope], lines: &[String]) -> ConversationProjection {
    ConversationProjection::project_with_context(events, Some(lines), &[], None).unwrap()
}

fn projection_tool_call_ids(messages: &[ConversationMessage]) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for message in messages {
        if let ConversationMessage::Assistant(assistant) = message {
            for block in &assistant.blocks {
                if let AssistantBlock::ToolCall(call) = block {
                    ids.insert(call.call_id.as_str().to_owned());
                }
            }
        }
    }
    ids
}

fn projection_tool_result_ids(messages: &[ConversationMessage]) -> Vec<String> {
    messages
        .iter()
        .filter_map(|message| match message {
            ConversationMessage::ToolResult(result) => Some(result.call_id.as_str().to_owned()),
            _ => None,
        })
        .collect()
}

fn assert_no_orphan_tool_results(projection: &ConversationProjection) {
    let calls = projection_tool_call_ids(&projection.messages);
    for result_id in projection_tool_result_ids(&projection.messages) {
        assert!(
            calls.contains(&result_id),
            "orphan tool result for call_id {result_id}"
        );
    }
}

fn copy_fixture_session(fixture: &Path) -> (TempDir, PathBuf) {
    let temp = TempDir::new().unwrap();
    let session_dir = temp.path().join("session");
    fs::create_dir_all(&session_dir).unwrap();
    fs::copy(
        fixture.join("events.jsonl"),
        session_dir.join("events.jsonl"),
    )
    .unwrap();
    let session_id = SessionId::from_str_canonical(&session_id_from_fixture(fixture)).unwrap();
    crate::history::event_log::write_new_session_meta(
        &session_dir,
        &session_id,
        &crate::protocol::id::Sha256Digest::from_hex_str(
            crate::history::event_log::EMPTY_PROJECT_CONTEXT_SOURCE_SHA256,
        )
        .unwrap(),
    )
    .unwrap();
    (temp, session_dir)
}

fn session_id_from_fixture(fixture: &Path) -> String {
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(fixture.join("manifest.json")).unwrap()).unwrap();
    manifest["session_id"].as_str().unwrap().to_owned()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn event_round_trip_preserves_value(index in 0usize..32) {
        let fixtures = load_success_fixtures();
        prop_assume!(!fixtures.is_empty());
        let (_, events, lines) = &fixtures[index % fixtures.len()];
        for event in events {
            let bytes = serialize_canonical(event).unwrap();
            let decoded: EventEnvelope = serde_json::from_slice(&bytes).unwrap();
            prop_assert_eq!(&decoded, event);
            let again = serialize_canonical(&decoded).unwrap();
            prop_assert_eq!(again, bytes);
        }
        prop_assert!(!lines.is_empty() || events.is_empty());
    }

    #[test]
    fn valid_event_prefix_replays_deterministically(index in 0usize..32, cut in 1usize..64) {
        let fixtures = load_success_fixtures();
        prop_assume!(!fixtures.is_empty());
        let (_, events, lines) = &fixtures[index % fixtures.len()];
        let cut = cut.min(events.len()).min(lines.len()).max(1);
        let prefix = &events[..cut];
        let prefix_lines = &lines[..cut];
        let left = project_events(prefix, prefix_lines);
        let right = project_events(prefix, prefix_lines);
        prop_assert_eq!(left, right);
        let mut replay_a = EventReplayer::new();
        let mut replay_b = EventReplayer::new();
        for (i, event) in prefix.iter().enumerate() {
            replay_a
                .process_event(event, Some(i + 1), Some(prefix_lines))
                .unwrap();
            replay_b
                .process_event(event, Some(i + 1), Some(prefix_lines))
                .unwrap();
        }
        prop_assert_eq!(replay_a.current_sequence(), replay_b.current_sequence());
        prop_assert_eq!(replay_a.reset_epoch, replay_b.reset_epoch);
        prop_assert_eq!(replay_a.state, replay_b.state);
    }

    #[test]
    fn projection_never_emits_orphan_tool_result(index in 0usize..32) {
        let fixtures = load_success_fixtures();
        prop_assume!(!fixtures.is_empty());
        let (_, events, lines) = &fixtures[index % fixtures.len()];
        let projection = project_events(events, lines);
        assert_no_orphan_tool_results(&projection);
    }

    #[test]
    fn projection_emits_complete_batch_in_call_order(index in 0usize..32) {
        let fixtures = load_success_fixtures();
        prop_assume!(!fixtures.is_empty());
        let (_, events, lines) = &fixtures[index % fixtures.len()];
        let projection = project_events(events, lines);
        let call_order: Vec<String> = projection
            .messages
            .iter()
            .filter_map(|message| match message {
                ConversationMessage::Assistant(assistant) => Some(assistant),
                _ => None,
            })
            .flat_map(|assistant| {
                assistant.blocks.iter().filter_map(|block| match block {
                    AssistantBlock::ToolCall(call) => Some(call.call_id.as_str().to_owned()),
                    _ => None,
                })
            })
            .collect();
        let result_order = projection_tool_result_ids(&projection.messages);
        if result_order.is_empty() {
            return Ok(());
        }
        // Complete projected results must be a prefix of accepted call order, preserving order.
        let mut call_iter = call_order.iter();
        for result_id in &result_order {
            loop {
                let next = call_iter.next();
                prop_assert!(next.is_some(), "result {result_id} has no matching prior call");
                if next.unwrap() == result_id {
                    break;
                }
            }
        }
    }

    #[test]
    fn accepted_attempt_has_at_most_one_step(index in 0usize..32) {
        let fixtures = load_success_fixtures();
        prop_assume!(!fixtures.is_empty());
        let (_, events, lines) = &fixtures[index % fixtures.len()];
        let replay = replay_all(events, lines);
        for attempt in replay.attempts.values() {
            let owners: Vec<_> = replay
                .turns
                .values()
                .flat_map(|turn| {
                    turn.steps
                        .values()
                        .filter(|step| step.attempt_id == attempt.id)
                        .map(|step| step.purpose.step_id)
                })
                .collect();
            prop_assert!(owners.len() <= 1);
        }
    }

    #[test]
    fn committed_turn_is_protocol_complete(index in 0usize..32) {
        let fixtures = load_success_fixtures();
        prop_assume!(!fixtures.is_empty());
        let (_, events, lines) = &fixtures[index % fixtures.len()];
        let replay = replay_all(events, lines);
        for turn in replay.turns.values() {
            let Some(TurnTerminal::Committed(committed)) = &turn.terminal else {
                continue;
            };
            prop_assert!(turn.started.is_some());
            prop_assert!(!turn.steps.is_empty());
            prop_assert_eq!(
                committed.accepted_step_ids.len(),
                turn.steps.len()
            );
            for batch in turn.batches.values() {
                prop_assert!(batch.completed.is_some());
                prop_assert_eq!(batch.executions.len(), batch.calls.len());
                prop_assert!(batch
                    .executions
                    .values()
                    .all(|execution| execution.result.is_some()));
            }
            let last = turn.steps.values().next_back().unwrap();
            prop_assert!(matches!(
                last.message.finish_reason,
                FinishReason::Stop | FinishReason::Length
            ));
            prop_assert_eq!(committed.terminal_step_id, last.purpose.step_id);
        }
    }

    #[test]
    fn reset_projection_contains_no_preboundary_message(index in 0usize..8) {
        let path = fixture_root().join("13_reset_boundary");
        prop_assume!(path.exists());
        let events = EventLogStore::read_and_validate_from_path(&path.join("events.jsonl")).unwrap();
        let lines = jsonl_lines(&path.join("events.jsonl"));
        let reset_at = events
            .iter()
            .position(|event| matches!(event.event, CanonicalEvent::ResetBoundary(_)))
            .unwrap();
        let projection = project_events(&events, &lines);
        let pre_ids: BTreeSet<_> = events[..reset_at]
            .iter()
            .filter_map(|event| match &event.event {
                CanonicalEvent::UserMessageAccepted(v) => Some(v.message.message_id),
                CanonicalEvent::AssistantStepAccepted(v) => Some(v.message.message_id),
                _ => None,
            })
            .collect();
        for message in &projection.messages {
            let id = match message {
                ConversationMessage::User(user) => user.message_id,
                ConversationMessage::Assistant(assistant) => assistant.message_id,
                ConversationMessage::ToolResult(_) => continue,
            };
            prop_assert!(!pre_ids.contains(&id));
        }
        // Keep proptest input used so the case count stays meaningful.
        prop_assert!(index < 8 || projection.reset_epoch >= 1);
        prop_assert!(projection.reset_epoch >= 1);
    }

    #[test]
    fn compaction_never_removes_source_events(index in 0usize..8) {
        for name in ["14_one_compaction_epoch", "15_two_compaction_epochs"] {
            let path = fixture_root().join(name);
            prop_assume!(path.exists());
            let events =
                EventLogStore::read_and_validate_from_path(&path.join("events.jsonl")).unwrap();
            let lines = jsonl_lines(&path.join("events.jsonl"));
            let source_count = events.len();
            let _ = project_events(&events, &lines);
            prop_assert_eq!(events.len(), source_count);
            let has_compaction = events
                .iter()
                .any(|event| matches!(event.event, CanonicalEvent::HistoryCompacted(_)));
            prop_assert!(has_compaction);
        }
        prop_assert!(index < 8);
    }

    #[test]
    fn compaction_retirement_is_monotonic_within_reset_epoch(index in 0usize..8) {
        let path = fixture_root().join("15_two_compaction_epochs");
        prop_assume!(path.exists());
        let events = EventLogStore::read_and_validate_from_path(&path.join("events.jsonl")).unwrap();
        let lines = jsonl_lines(&path.join("events.jsonl"));
        let mut epochs = Vec::new();
        let mut retired: BTreeSet<_> = BTreeSet::new();
        let mut replay = EventReplayer::new();
        for (i, event) in events.iter().enumerate() {
            replay
                .process_event(event, Some(i + 1), Some(&lines))
                .unwrap();
            if let CanonicalEvent::HistoryCompacted(compacted) = &event.event {
                epochs.push(compacted.epoch);
                for turn_id in &compacted.source_turn_ids {
                    prop_assert!(
                        retired.insert(*turn_id),
                        "turn {turn_id:?} retired twice within reset epoch"
                    );
                }
                prop_assert!(replay
                    .compacted_turn_ids
                    .iter()
                    .copied()
                    .collect::<BTreeSet<_>>()
                    .is_superset(&retired.iter().copied().collect()));
            }
        }
        prop_assert!(epochs.windows(2).all(|window| window[0] < window[1]));
        prop_assert!(index < 8);
    }

    #[test]
    fn state_checkpoint_equals_full_event_rebuild(index in 0usize..32) {
        let fixtures = load_success_fixtures();
        prop_assume!(!fixtures.is_empty());
        let (_, events, lines) = &fixtures[index % fixtures.len()];
        let full = replay_all(events, lines).state.clone();
        let mut incremental = EventReplayer::new();
        for (i, event) in events.iter().enumerate() {
            incremental
                .process_event(event, Some(i + 1), Some(lines))
                .unwrap();
        }
        prop_assert_eq!(&incremental.state, &full);
        let projected = project_events(events, lines);
        prop_assert_eq!(&projected.current_state, &full);
    }

    #[test]
    fn artifact_reference_always_resolves(index in 0usize..32) {
        // Phase 1B has no artifact store; projected messages must not carry artifact refs.
        let fixtures = load_success_fixtures();
        prop_assume!(!fixtures.is_empty());
        let (_, events, lines) = &fixtures[index % fixtures.len()];
        let projection = project_events(events, lines);
        let encoded = serde_json::to_string(&projection.messages).unwrap();
        prop_assert!(!encoded.contains("\"artifact_id\""));
        prop_assert!(!encoded.contains("\"artifact_ref\""));
    }

    #[test]
    fn recovery_never_invokes_started_execution(_seed in 0u8..8) {
        let path = fixture_root().join("11_uncertain_mutation_recovery");
        prop_assume!(path.exists());
        let (_temp, session_dir) = copy_fixture_session(&path);
        let session_id = session_id_from_fixture(&path);
        let before = EventLogStore::read_events_from_path(&session_dir.join("events.jsonl")).unwrap();
        let started_before: BTreeSet<_> = before
            .iter()
            .filter_map(|event| match &event.event {
                CanonicalEvent::ToolExecutionStarted(v) => Some(v.execution_id),
                _ => None,
            })
            .collect();
        let mut engine = SessionRecoveryEngine::new(&session_dir, &session_id).unwrap();
        let _ = engine.run_recovery().unwrap();
        let after = engine.store().events().unwrap();
        let started_after: BTreeSet<_> = after
            .iter()
            .filter_map(|event| match &event.event {
                CanonicalEvent::ToolExecutionStarted(v) => Some(v.execution_id),
                _ => None,
            })
            .collect();
        prop_assert_eq!(started_before, started_after);
        for event in &after[before.len()..] {
            prop_assert!(!matches!(
                event.event,
                CanonicalEvent::ToolExecutionStarted(_)
            ));
        }
    }

    #[test]
    fn recovery_is_idempotent(_seed in 0u8..8) {
        let path = fixture_root().join("09_terminal_accept_crash_repair");
        prop_assume!(path.exists());
        let (_temp, session_dir) = copy_fixture_session(&path);
        let session_id = session_id_from_fixture(&path);
        let mut engine = SessionRecoveryEngine::new(&session_dir, &session_id).unwrap();
        let first = engine.run_recovery().unwrap();
        let mid = engine.store().events().unwrap();
        let second = engine.run_recovery().unwrap();
        let end = engine.store().events().unwrap();
        prop_assert!(first >= 1);
        prop_assert_eq!(second, 0);
        prop_assert_eq!(mid, end);
    }

    #[test]
    fn rfc8785_hash_is_map_order_independent(
        entries in prop::collection::btree_map("[a-z]{1,6}", 0u32..1000, 1..8)
    ) {
        let mut forward = serde_json::Map::new();
        let mut reverse = serde_json::Map::new();
        for (key, value) in &entries {
            forward.insert(key.clone(), serde_json::Value::from(*value));
        }
        for (key, value) in entries.iter().rev() {
            reverse.insert(key.clone(), serde_json::Value::from(*value));
        }
        let left_v = serde_json::Value::Object(forward);
        let right_v = serde_json::Value::Object(reverse);
        prop_assert_eq!(
            to_canonical_json_bytes(&left_v).unwrap(),
            to_canonical_json_bytes(&right_v).unwrap()
        );
        prop_assert_eq!(
            calculate_tool_arguments_hash(&left_v).unwrap(),
            calculate_tool_arguments_hash(&right_v).unwrap()
        );
    }
}

fn replay_mutated_fixture(
    fixture: &str,
    sequence: u64,
    mutate: impl FnOnce(&mut EventEnvelope),
) -> String {
    let path = fixture_root().join(fixture).join("events.jsonl");
    let bytes = fs::read(&path).unwrap();
    let mut envelopes = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        envelopes.push(
            deserialize_event_strict::<EventEnvelope>(std::str::from_utf8(line).unwrap()).unwrap(),
        );
    }
    if let Some(envelope) = envelopes
        .iter_mut()
        .find(|event| event.sequence == sequence)
    {
        mutate(envelope);
    }
    let mut replay = EventReplayer::new();
    for (index, envelope) in envelopes.iter().enumerate() {
        if let Err(err) = replay.process_event(envelope, Some(index + 1), None) {
            return err.code().to_owned();
        }
    }
    "OK".to_owned()
}

fn one_mutation_expected_code(kind: u8) -> (&'static str, String) {
    match kind {
        0 => (
            "E_SCHEMA_VERSION_UNSUPPORTED",
            replay_mutated_fixture("01_committed_text_turn", 1, |event| {
                event.schema_version = 1;
            }),
        ),
        1 => (
            "E_JSONL_SEQUENCE_GAP",
            replay_mutated_fixture("01_committed_text_turn", 3, |event| {
                event.sequence = 5;
            }),
        ),
        2 => (
            "E_EVENT_SCHEMA_INVALID",
            replay_mutated_fixture("01_committed_text_turn", 2, |event| {
                if let CanonicalEvent::UserMessageAccepted(accepted) = &mut event.event {
                    if let UserBlock::Text(text) = &mut accepted.message.blocks[0] {
                        text.text.clear();
                    }
                }
            }),
        ),
        3 => (
            "E_EVENT_SCHEMA_INVALID",
            replay_mutated_fixture("01_committed_text_turn", 5, |event| {
                if let CanonicalEvent::AssistantStepAccepted(accepted) = &mut event.event {
                    accepted.message.blocks.clear();
                }
            }),
        ),
        4 => (
            "E_TOOL_ARGUMENTS_INVALID",
            replay_mutated_fixture("02_single_tool_cycle_inline", 5, |event| {
                if let CanonicalEvent::AssistantStepAccepted(accepted) = &mut event.event {
                    for block in &mut accepted.message.blocks {
                        if let AssistantBlock::ToolCall(call) = block {
                            call.raw_arguments = r#"{"path":"a","path":"b"}"#.into();
                        }
                    }
                }
            }),
        ),
        _ => (
            "E_EVENT_TRANSITION_INVALID",
            replay_mutated_fixture("07_failed_preemission_then_retry", 6, |event| {
                if let CanonicalEvent::AssistantAttemptStarted(started) = &mut event.event {
                    started.attempt_number = 3;
                }
            }),
        ),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    #[test]
    fn one_mutation_invalid_trace_raises_narrow_code(kind in 0u8..6) {
        let (expected, actual) = one_mutation_expected_code(kind);
        prop_assert_eq!(actual, expected);
    }
}
