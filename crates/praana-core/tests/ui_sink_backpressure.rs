//! P1C focused test: event priority, coalescing, and bounded sink behavior.
//!
//! Covers exact priority/coalescing/sensitivity mapping, latest-only
//! replacement in the older queue position, adjacent appendable merges within
//! the 16,384-byte bound, no critical loss, the 2,000 ms critical deadline
//! under paused Tokio time with atomic detach, and `NullUiSink`.

use std::sync::Arc;
use std::time::Duration;

use praana_core::protocol::id::{
    AttemptId, EventId, SessionId, StepId, ToolBatchId, ToolExecutionId, TurnId,
};
use praana_core::ui_contract::event::{
    coalesce_key, durability_requirement, priority, sensitivity, AssistantDeltaDto,
    AssistantVisibleBlockKind, AttemptStartedDto, ToolBatchStartedDto, ToolCallProgressDto,
    ToolProgressPhase, TurnStartedDto, UiCoalesceKey, UiDurabilityRef, UiEventPriority,
    UiSensitivity, UsageUpdatedDto,
};
use praana_core::ui_contract::ids::{AssistantBlockId, OperationId};
use praana_core::ui_contract::result::ContextStatusDto;
use praana_core::ui_contract::sink::{
    ChannelUiSink, NullUiSink, UiEventSink, UiSinkError, APPEND_MERGE_MAX_BYTES,
    CRITICAL_WAIT_TIMEOUT, SINK_QUEUE_BYTES, SINK_QUEUE_RECORDS,
};
use praana_core::ui_contract::transcript::TextContentDto;
use praana_core::ui_contract::{
    validate_ui_event, ActiveModelDto, ReasoningStateDto, UiEvent, UiEventRecord, UsageDto,
};

fn session() -> SessionId {
    SessionId(ulid::Ulid::generate())
}

fn turn() -> TurnId {
    TurnId(ulid::Ulid::generate())
}

fn attempt() -> AttemptId {
    AttemptId(ulid::Ulid::generate())
}

fn operation() -> OperationId {
    OperationId(ulid::Ulid::generate())
}

fn boot() -> praana_core::ui_contract::result::BootStatusDto {
    let component = |label: &str| praana_core::ui_contract::result::ComponentStatusDto {
        state: praana_core::ui_contract::result::ComponentState::Available,
        label: label.to_string(),
        detail: None,
    };
    praana_core::ui_contract::result::BootStatusDto {
        native: component("Native addon"),
        search: component("Native search"),
        lsp: component("Language servers"),
        memory: component("Cognitive memory"),
        provider: component("Provider registry"),
        history: component("History store"),
        skills: component("Skills catalog"),
        discovered_skill_count: 0,
    }
}

fn active_model() -> ActiveModelDto {
    ActiveModelDto {
        provider: "openai".parse().unwrap(),
        model_id: "gpt-5".parse().unwrap(),
        display_name: "GPT-5".to_string(),
        protocol: praana_core::ui_contract::catalog::ProviderProtocol::OpenAiResponses,
        reasoning_effort: praana_core::ui_contract::catalog::ReasoningEffort::Medium,
        context_window_tokens: 400_000,
        boundary_canonical_sequence: None,
    }
}

fn reasoning() -> ReasoningStateDto {
    ReasoningStateDto {
        requested: praana_core::ui_contract::catalog::ReasoningEffort::Medium,
        effective: praana_core::ui_contract::catalog::ReasoningEffort::Medium,
        supported: vec![praana_core::ui_contract::catalog::ReasoningEffort::Medium],
        boundary_canonical_sequence: None,
    }
}

fn session_status_record(session_id: SessionId, sequence: u64) -> UiEventRecord {
    UiEventRecord {
        ui_contract_schema_version: 1,
        session_id: Some(session_id),
        turn_id: None,
        attempt_id: None,
        operation_id: None,
        durability: UiDurabilityRef::CanonicalSnapshot {
            canonical_through_sequence: sequence,
        },
        event: UiEvent::SessionStatus(praana_core::ui_contract::event::SessionStatusDto {
            boot: boot(),
            active_model: active_model(),
            reasoning: reasoning(),
            turn_active: false,
        }),
    }
}

fn context_record(session_id: SessionId) -> UiEventRecord {
    UiEventRecord {
        ui_contract_schema_version: 1,
        session_id: Some(session_id),
        turn_id: None,
        attempt_id: None,
        operation_id: None,
        durability: UiDurabilityRef::Ephemeral,
        event: UiEvent::ContextUpdated(ContextStatusDto {
            window_tokens: 200_000,
            occupied_tokens: 40_000,
            available_tokens: 160_000,
            occupied_percent_milli: 20_000,
            compact_at_percent_milli: 70_000,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            compaction_epoch: 0,
            pressure: praana_core::ui_contract::result::ComponentState::Available,
        }),
    }
}

fn turn_started_record(session_id: SessionId, turn_id: TurnId) -> UiEventRecord {
    UiEventRecord {
        ui_contract_schema_version: 1,
        session_id: Some(session_id),
        turn_id: Some(turn_id),
        attempt_id: None,
        operation_id: Some(operation()),
        durability: UiDurabilityRef::CanonicalEvent {
            event_id: EventId(ulid::Ulid::generate()),
            canonical_sequence: 10,
        },
        event: UiEvent::TurnStarted(TurnStartedDto {
            turn_id,
            user_message_id: praana_core::protocol::id::MessageId(ulid::Ulid::generate()),
            user_text: TextContentDto {
                preview: "hi".to_string(),
                complete: true,
                sha256: "8ab0993c9ce620c300627a416be784d469277093446b9e96fd52a1006e89119f"
                    .parse()
                    .unwrap(),
                detail_ref: None,
            },
            turn_index: 1,
        }),
    }
}

fn attempt_started_record(
    session_id: SessionId,
    turn_id: TurnId,
    attempt_id: AttemptId,
) -> UiEventRecord {
    UiEventRecord {
        ui_contract_schema_version: 1,
        session_id: Some(session_id),
        turn_id: Some(turn_id),
        attempt_id: Some(attempt_id),
        operation_id: None,
        durability: UiDurabilityRef::CanonicalEvent {
            event_id: EventId(ulid::Ulid::generate()),
            canonical_sequence: 11,
        },
        event: UiEvent::AttemptStarted(AttemptStartedDto {
            attempt_id,
            attempt_number: 1,
            provider: "openai".parse().unwrap(),
            model_id: "gpt-5".parse().unwrap(),
            retry_of: None,
        }),
    }
}

fn delta_record(
    session_id: SessionId,
    turn_id: TurnId,
    attempt_id: AttemptId,
    block: AssistantBlockId,
    first: u64,
    last: u64,
    text: &str,
) -> UiEventRecord {
    UiEventRecord {
        ui_contract_schema_version: 1,
        session_id: Some(session_id),
        turn_id: Some(turn_id),
        attempt_id: Some(attempt_id),
        operation_id: None,
        durability: UiDurabilityRef::Ephemeral,
        event: UiEvent::AssistantDelta(AssistantDeltaDto {
            block_id: block,
            block_kind: AssistantVisibleBlockKind::Text,
            first_chunk_index: first,
            last_chunk_index: last,
            text: text.to_string(),
        }),
    }
}

fn usage_record(
    session_id: SessionId,
    turn_id: TurnId,
    attempt_id: AttemptId,
    total: u64,
) -> UiEventRecord {
    UiEventRecord {
        ui_contract_schema_version: 1,
        session_id: Some(session_id),
        turn_id: Some(turn_id),
        attempt_id: Some(attempt_id),
        operation_id: None,
        durability: UiDurabilityRef::Ephemeral,
        event: UiEvent::UsageUpdated(UsageUpdatedDto {
            attempt_id,
            cumulative: UsageDto {
                total_tokens: total,
                ..Default::default()
            },
        }),
    }
}

fn progress_record(
    session_id: SessionId,
    turn_id: TurnId,
    attempt_id: AttemptId,
    execution: ToolExecutionId,
    elapsed_ms: u64,
) -> UiEventRecord {
    UiEventRecord {
        ui_contract_schema_version: 1,
        session_id: Some(session_id),
        turn_id: Some(turn_id),
        attempt_id: Some(attempt_id),
        operation_id: None,
        durability: UiDurabilityRef::Ephemeral,
        event: UiEvent::ToolCallProgress(ToolCallProgressDto {
            execution_id: execution,
            phase: ToolProgressPhase::Running,
            elapsed_ms,
            stdout_bytes: 0,
            stderr_bytes: 0,
        }),
    }
}

fn tool_batch_started_record(
    session_id: SessionId,
    turn_id: TurnId,
    attempt_id: AttemptId,
) -> UiEventRecord {
    UiEventRecord {
        ui_contract_schema_version: 1,
        session_id: Some(session_id),
        turn_id: Some(turn_id),
        attempt_id: Some(attempt_id),
        operation_id: None,
        durability: UiDurabilityRef::CanonicalSnapshot {
            canonical_through_sequence: 12,
        },
        event: UiEvent::ToolBatchStarted(ToolBatchStartedDto {
            batch_id: ToolBatchId(ulid::Ulid::generate()),
            step_id: StepId(ulid::Ulid::generate()),
            call_ids: vec![],
        }),
    }
}

#[test]
fn sink_capacities_match_spec() {
    assert_eq!(SINK_QUEUE_RECORDS, 1_024);
    assert_eq!(SINK_QUEUE_BYTES, 8 * 1024 * 1024);
    assert_eq!(CRITICAL_WAIT_TIMEOUT, Duration::from_millis(2_000));
    assert_eq!(APPEND_MERGE_MAX_BYTES, 16_384);
}

#[test]
fn priority_mapping_matches_section_7() {
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    let critical: &[UiEvent] = &[
        turn_started_record(session_id, turn_id).event,
        attempt_started_record(session_id, turn_id, attempt_id).event,
        tool_batch_started_record(session_id, turn_id, attempt_id).event,
    ];
    for event in critical {
        assert_eq!(
            priority(event),
            UiEventPriority::Critical,
            "{}",
            event.kind_name()
        );
    }
    assert_eq!(
        priority(&session_status_record(session_id, 1).event),
        UiEventPriority::LatestOnly
    );
    assert_eq!(
        priority(&context_record(session_id).event),
        UiEventPriority::LatestOnly
    );
    assert_eq!(
        priority(&usage_record(session_id, turn_id, attempt_id, 1).event),
        UiEventPriority::LatestOnly
    );
    assert_eq!(
        priority(
            &progress_record(
                session_id,
                turn_id,
                attempt_id,
                ToolExecutionId(ulid::Ulid::generate()),
                1
            )
            .event
        ),
        UiEventPriority::LatestOnly
    );
    assert_eq!(
        priority(
            &delta_record(
                session_id,
                turn_id,
                attempt_id,
                AssistantBlockId(ulid::Ulid::generate()),
                0,
                0,
                "a"
            )
            .event
        ),
        UiEventPriority::Appendable
    );
}

#[test]
fn coalesce_keys_match_section_7() {
    let session_id = session();
    let other_session = session();
    let turn_id = turn();
    let attempt_id = attempt();
    let block = AssistantBlockId(ulid::Ulid::generate());
    let execution = ToolExecutionId(ulid::Ulid::generate());

    assert_eq!(
        coalesce_key(&session_status_record(session_id, 1)),
        Some(UiCoalesceKey::SessionStatus(session_id))
    );
    assert_eq!(
        coalesce_key(&context_record(session_id)),
        Some(UiCoalesceKey::Context(session_id))
    );
    assert_eq!(
        coalesce_key(&usage_record(session_id, turn_id, attempt_id, 1)),
        Some(UiCoalesceKey::AttemptUsage(attempt_id))
    );
    assert_eq!(
        coalesce_key(&delta_record(
            session_id, turn_id, attempt_id, block, 0, 0, "a"
        )),
        Some(UiCoalesceKey::AssistantBlock(attempt_id, block))
    );
    assert_eq!(
        coalesce_key(&progress_record(
            session_id, turn_id, attempt_id, execution, 1
        )),
        Some(UiCoalesceKey::ToolProgress(execution))
    );
    // Critical events never coalesce.
    assert_eq!(
        coalesce_key(&turn_started_record(session_id, turn_id)),
        None
    );
    assert_eq!(
        coalesce_key(&tool_batch_started_record(session_id, turn_id, attempt_id)),
        None
    );
    // Keys are scoped: same tool execution in another session still shares
    // the execution key, while session keys differ.
    assert_ne!(
        coalesce_key(&context_record(session_id)),
        coalesce_key(&context_record(other_session))
    );
}

#[test]
fn sensitivity_mapping_matches_section_7() {
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    assert_eq!(
        sensitivity(&session_status_record(session_id, 1).event),
        UiSensitivity::LocalMetadata
    );
    assert_eq!(
        sensitivity(&context_record(session_id).event),
        UiSensitivity::Public
    );
    assert_eq!(
        sensitivity(&turn_started_record(session_id, turn_id).event),
        UiSensitivity::Redacted
    );
    assert_eq!(
        sensitivity(
            &delta_record(
                session_id,
                turn_id,
                attempt_id,
                AssistantBlockId(ulid::Ulid::generate()),
                0,
                0,
                "a"
            )
            .event
        ),
        UiSensitivity::Redacted
    );
    assert_eq!(
        sensitivity(&tool_batch_started_record(session_id, turn_id, attempt_id).event),
        UiSensitivity::Public
    );
}

#[test]
fn durability_requirements_match_section_7() {
    use praana_core::ui_contract::event::UiDurabilityRequirement as D;
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    assert_eq!(
        durability_requirement(&session_status_record(session_id, 1).event),
        D::CanonicalSnapshot
    );
    assert_eq!(
        durability_requirement(&context_record(session_id).event),
        D::Ephemeral
    );
    assert_eq!(
        durability_requirement(&turn_started_record(session_id, turn_id).event),
        D::CanonicalEvent
    );
    assert_eq!(
        durability_requirement(
            &delta_record(
                session_id,
                turn_id,
                attempt_id,
                AssistantBlockId(ulid::Ulid::generate()),
                0,
                0,
                "a"
            )
            .event
        ),
        D::Ephemeral
    );
    assert_eq!(
        durability_requirement(&usage_record(session_id, turn_id, attempt_id, 1).event),
        D::Ephemeral
    );
}

#[tokio::test]
async fn latest_only_replacement_keeps_older_position() {
    let sink = ChannelUiSink::new();
    let session_id = session();
    let turn_id = turn();
    sink.emit(session_status_record(session_id, 50))
        .await
        .unwrap();
    sink.emit(turn_started_record(session_id, turn_id))
        .await
        .unwrap();
    // Newer payload replaces the older queued record in place.
    sink.emit(session_status_record(session_id, 51))
        .await
        .unwrap();
    let (len, _) = sink.queue_stats().await;
    assert_eq!(len, 2);
    let first = sink.try_recv().await.expect("first record");
    assert_eq!(first.event.kind_name(), "UiEvent::SessionStatus");
    match first.event {
        UiEvent::SessionStatus(_) => {}
        other => panic!("expected session_status, got {}", other.kind_name()),
    }
    // The replacement carries the newer durability sequence.
    match first.durability {
        UiDurabilityRef::CanonicalSnapshot {
            canonical_through_sequence,
        } => assert_eq!(canonical_through_sequence, 51),
        other => panic!("unexpected durability {other:?}"),
    }
    let second = sink.try_recv().await.expect("second record");
    assert_eq!(second.event.kind_name(), "UiEvent::TurnStarted");
    let (coalesced, dropped) = sink.counters().await;
    assert_eq!(coalesced, 1);
    assert_eq!(dropped, 0);
}

#[tokio::test]
async fn appendable_merges_only_adjacent_ranges_within_bound() {
    let sink = ChannelUiSink::new();
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    let block = AssistantBlockId(ulid::Ulid::generate());
    sink.emit(delta_record(
        session_id, turn_id, attempt_id, block, 0, 3, "Check",
    ))
    .await
    .unwrap();
    // Adjacent range merges into one queued record.
    sink.emit(delta_record(
        session_id, turn_id, attempt_id, block, 4, 6, " it",
    ))
    .await
    .unwrap();
    let (len, _) = sink.queue_stats().await;
    assert_eq!(len, 1);
    // Non-adjacent range for the same key stays a separate record.
    sink.emit(delta_record(
        session_id, turn_id, attempt_id, block, 9, 9, "!",
    ))
    .await
    .unwrap();
    let (len, _) = sink.queue_stats().await;
    assert_eq!(len, 2);
    let first = sink.try_recv().await.unwrap();
    match first.event {
        UiEvent::AssistantDelta(delta) => {
            assert_eq!(delta.text, "Check it");
            assert_eq!(delta.first_chunk_index, 0);
            assert_eq!(delta.last_chunk_index, 6);
        }
        other => panic!("expected delta, got {}", other.kind_name()),
    }
    // Merges past the 16,384-byte bound are rejected as separate records.
    let sink = ChannelUiSink::new();
    let big = "x".repeat(APPEND_MERGE_MAX_BYTES);
    sink.emit(delta_record(
        session_id, turn_id, attempt_id, block, 0, 0, &big,
    ))
    .await
    .unwrap();
    sink.emit(delta_record(
        session_id, turn_id, attempt_id, block, 1, 1, "y",
    ))
    .await
    .unwrap();
    let (len, _) = sink.queue_stats().await;
    assert_eq!(len, 2);
}

#[tokio::test]
async fn critical_events_are_never_coalesced_or_dropped() {
    let sink = ChannelUiSink::new();
    let session_id = session();
    for _ in 0..8 {
        let turn_id = turn();
        sink.emit(turn_started_record(session_id, turn_id))
            .await
            .unwrap();
    }
    let (len, _) = sink.queue_stats().await;
    assert_eq!(len, 8);
    for _ in 0..8 {
        let record = sink.try_recv().await.expect("critical record");
        assert_eq!(record.event.kind_name(), "UiEvent::TurnStarted");
    }
}

#[tokio::test]
async fn latest_only_and_appendable_never_wait_on_a_full_queue() {
    let sink = ChannelUiSink::new();
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    // Fill the queue with distinct latest-only keys (no replacement).
    for _ in 0..SINK_QUEUE_RECORDS {
        let execution = ToolExecutionId(ulid::Ulid::generate());
        sink.emit(progress_record(
            session_id, turn_id, attempt_id, execution, 1,
        ))
        .await
        .unwrap();
    }
    let (len, _) = sink.queue_stats().await;
    assert_eq!(len, SINK_QUEUE_RECORDS);
    // Real-clock guard: these must return without waiting for capacity.
    let done = tokio::time::timeout(
        Duration::from_millis(500),
        sink.emit(usage_record(session_id, turn_id, attempt_id, 9)),
    )
    .await
    .expect("latest-only emission must not wait");
    done.unwrap();
    let done = tokio::time::timeout(
        Duration::from_millis(500),
        sink.emit(delta_record(
            session_id,
            turn_id,
            attempt_id,
            AssistantBlockId(ulid::Ulid::generate()),
            0,
            0,
            "z",
        )),
    )
    .await
    .expect("appendable emission must not wait");
    done.unwrap();
}

#[tokio::test(start_paused = true)]
async fn critical_deadline_detaches_and_rejects_later_events() {
    let sink = Arc::new(ChannelUiSink::new());
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    for _ in 0..SINK_QUEUE_RECORDS {
        let execution = ToolExecutionId(ulid::Ulid::generate());
        sink.emit(progress_record(
            session_id, turn_id, attempt_id, execution, 1,
        ))
        .await
        .unwrap();
    }
    let waiter = {
        let sink = sink.clone();
        tokio::spawn(async move { sink.emit(turn_started_record(session_id, turn())).await })
    };
    tokio::task::yield_now().await;
    // The critical emission may wait at most 2,000 ms.
    tokio::time::advance(Duration::from_millis(2_100)).await;
    let result = waiter.await.expect("join");
    assert_eq!(result, Err(UiSinkError::CriticalDeadlineExceeded));
    assert!(sink.is_detached().await);
    // Later events are rejected as detached, and the receiver is closed.
    let err = sink
        .emit(turn_started_record(session_id, turn()))
        .await
        .expect_err("detached sink rejects emits");
    assert_eq!(err, UiSinkError::Detached);
    assert_eq!(sink.try_recv().await, None);
}

#[tokio::test]
async fn critical_emission_succeeds_once_capacity_frees() {
    let sink = Arc::new(ChannelUiSink::new());
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    for _ in 0..SINK_QUEUE_RECORDS {
        let execution = ToolExecutionId(ulid::Ulid::generate());
        sink.emit(progress_record(
            session_id, turn_id, attempt_id, execution, 1,
        ))
        .await
        .unwrap();
    }
    let waiter = {
        let sink = sink.clone();
        tokio::spawn(async move { sink.emit(turn_started_record(session_id, turn())).await })
    };
    // Free one slot; the waiting critical emission completes without loss.
    tokio::task::yield_now().await;
    sink.try_recv().await.expect("drain one");
    let result = tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .expect("critical emission completes")
        .expect("join");
    result.expect("critical admitted");
    assert!(!sink.is_detached().await);
}

#[tokio::test]
async fn latest_only_replacement_cannot_exceed_byte_bound() {
    use praana_core::ui_contract::sink::SINK_QUEUE_BYTES;
    let sink = ChannelUiSink::new();
    let session_id = session();
    sink.emit(session_status_record(session_id, 50))
        .await
        .unwrap();
    // A replacement that would push the queue past 8 MiB is dropped; the old
    // record is kept and the bound still holds.
    let mut huge = session_status_record(session_id, 51);
    match &mut huge.event {
        UiEvent::SessionStatus(status) => {
            status.boot.native.label = "x".repeat(SINK_QUEUE_BYTES as usize);
        }
        _ => unreachable!(),
    }
    sink.emit(huge).await.unwrap();
    let (len, bytes) = sink.queue_stats().await;
    assert_eq!(len, 1);
    assert!(bytes <= SINK_QUEUE_BYTES);
    let (_, dropped) = sink.counters().await;
    assert!(dropped >= 1);
    let kept = sink.try_recv().await.unwrap();
    match kept.durability {
        praana_core::ui_contract::event::UiDurabilityRef::CanonicalSnapshot {
            canonical_through_sequence,
        } => assert_eq!(canonical_through_sequence, 50),
        _ => panic!("old record must be kept"),
    }
}

#[tokio::test]
async fn concurrent_critical_waits_share_one_slot_safely() {
    let sink = Arc::new(ChannelUiSink::new());
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    for _ in 0..SINK_QUEUE_RECORDS {
        let execution = ToolExecutionId(ulid::Ulid::generate());
        sink.emit(progress_record(
            session_id, turn_id, attempt_id, execution, 1,
        ))
        .await
        .unwrap();
    }
    // Two critical waiters race for capacity; both must be admitted without
    // exceeding 1,024 queued records.
    let first = {
        let sink = sink.clone();
        tokio::spawn(async move { sink.emit(turn_started_record(session_id, turn())).await })
    };
    let second = {
        let sink = sink.clone();
        tokio::spawn(async move { sink.emit(turn_started_record(session_id, turn())).await })
    };
    tokio::task::yield_now().await;
    sink.try_recv().await.expect("free one slot");
    sink.try_recv().await.expect("free another slot");
    let (first, second) = tokio::join!(first, second);
    first.expect("join").expect("first critical admitted");
    second.expect("join").expect("second critical admitted");
    let (len, _) = sink.queue_stats().await;
    assert!(len <= SINK_QUEUE_RECORDS);
    assert!(!sink.is_detached().await);
}

#[tokio::test]
async fn evicting_a_full_queue_counts_drops_not_coalescing() {
    let sink = ChannelUiSink::new();
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    for _ in 0..SINK_QUEUE_RECORDS {
        let execution = ToolExecutionId(ulid::Ulid::generate());
        sink.emit(progress_record(
            session_id, turn_id, attempt_id, execution, 1,
        ))
        .await
        .unwrap();
    }
    // A distinct latest-only key with no bounded slot evicts an older
    // non-critical record; the eviction counts as a drop.
    sink.emit(usage_record(session_id, turn_id, attempt_id, 7))
        .await
        .unwrap();
    let (len, _) = sink.queue_stats().await;
    assert_eq!(len, SINK_QUEUE_RECORDS);
    let (coalesced, dropped) = sink.counters().await;
    assert_eq!(coalesced, 0);
    assert!(dropped >= 1);
}

#[tokio::test]
async fn appendable_merge_cannot_exceed_byte_bound() {
    use praana_core::ui_contract::sink::SINK_QUEUE_BYTES;
    let sink = ChannelUiSink::new();
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    // One small mergeable block, then distinct ~8 KiB blocks until the queue
    // sits within one record (~8.5 KiB) of the payload cap.
    let first_block = AssistantBlockId(ulid::Ulid::generate());
    sink.emit(delta_record(
        session_id,
        turn_id,
        attempt_id,
        first_block,
        0,
        0,
        &"q".repeat(100),
    ))
    .await
    .unwrap();
    let chunk = "q".repeat(8192);
    for _ in 1..SINK_QUEUE_RECORDS {
        let block = AssistantBlockId(ulid::Ulid::generate());
        sink.emit(delta_record(
            session_id, turn_id, attempt_id, block, 0, 0, &chunk,
        ))
        .await
        .unwrap();
        let (_, bytes) = sink.queue_stats().await;
        if SINK_QUEUE_BYTES - bytes < 9_000 {
            break;
        }
    }
    let (_, bytes) = sink.queue_stats().await;
    assert!(bytes <= SINK_QUEUE_BYTES);
    let remaining = SINK_QUEUE_BYTES - bytes;
    assert!(remaining < 9_000, "queue must sit near the cap");
    let (_, dropped_before) = sink.counters().await;
    // An adjacent delta whose text merge is legal (well under 16 KiB) but
    // whose byte growth exceeds the remaining budget is refused; the older
    // record is kept byte-for-byte.
    let growth = (remaining + 1_000) as usize;
    assert!(100 + growth <= 16_384);
    sink.emit(delta_record(
        session_id,
        turn_id,
        attempt_id,
        first_block,
        1,
        1,
        &"y".repeat(growth),
    ))
    .await
    .unwrap();
    let (len, bytes_after) = sink.queue_stats().await;
    assert!(bytes_after <= SINK_QUEUE_BYTES);
    assert_eq!(bytes_after, bytes, "refused merge must not grow the queue");
    assert!(len <= SINK_QUEUE_RECORDS);
    let (_, dropped_after) = sink.counters().await;
    assert!(dropped_after > dropped_before);
}

#[tokio::test]
async fn null_sink_accepts_immediately_and_retains_nothing() {
    let sink = NullUiSink;
    let session_id = session();
    sink.emit(session_status_record(session_id, 1))
        .await
        .unwrap();
    sink.emit(turn_started_record(session_id, turn()))
        .await
        .unwrap();
    sink.emit(context_record(session_id)).await.unwrap();
}

#[tokio::test]
async fn invalid_events_are_rejected_without_state_change() {
    let sink = ChannelUiSink::new();
    let mut record = session_status_record(session(), 1);
    record.session_id = None;
    let err = sink.emit(record).await.expect_err("invalid envelope");
    assert!(matches!(err, UiSinkError::InvalidEvent(_)));
    let (len, _) = sink.queue_stats().await;
    assert_eq!(len, 0);
    assert!(!sink.is_detached().await);
}

#[tokio::test]
async fn emission_preserves_relative_order_after_coalescing() {
    let sink = ChannelUiSink::new();
    let session_id = session();
    let turn_id = turn();
    let attempt_id = attempt();
    let block = AssistantBlockId(ulid::Ulid::generate());
    sink.emit(turn_started_record(session_id, turn_id))
        .await
        .unwrap();
    sink.emit(delta_record(
        session_id, turn_id, attempt_id, block, 0, 1, "ab",
    ))
    .await
    .unwrap();
    sink.emit(usage_record(session_id, turn_id, attempt_id, 5))
        .await
        .unwrap();
    sink.emit(delta_record(
        session_id, turn_id, attempt_id, block, 2, 3, "cd",
    ))
    .await
    .unwrap();
    sink.emit(usage_record(session_id, turn_id, attempt_id, 9))
        .await
        .unwrap();
    // Relative order: turn_started, merged delta, latest usage.
    let kinds: Vec<&str> = vec![
        sink.try_recv().await.unwrap().event.kind_name(),
        sink.try_recv().await.unwrap().event.kind_name(),
        sink.try_recv().await.unwrap().event.kind_name(),
    ];
    assert_eq!(
        kinds,
        vec![
            "UiEvent::TurnStarted",
            "UiEvent::AssistantDelta",
            "UiEvent::UsageUpdated"
        ]
    );
    // Validation is shared with the contract: every delivered record validates.
    let sink = ChannelUiSink::new();
    let record = context_record(session_id);
    validate_ui_event(&record).unwrap();
    sink.emit(record).await.unwrap();
    let _ = operation();
}
