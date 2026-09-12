//! Idempotent startup recovery over the longest valid durable event prefix.

use std::path::Path;
use std::sync::Arc;

use crate::clock::{Clock, SystemClock};
use crate::history::event_log::EventLogStore;
use crate::history::replay::{accepted_messages, AttemptStatus, EventReplayer};
use crate::id::{IdGenerator, MonotonicUlidGenerator};
use crate::protocol::errors::{ErrorClass, HistoryError, HistoryResult, ProtocolError};
use crate::protocol::events::*;
use crate::protocol::hashes::{
    calculate_accepted_messages_hash, calculate_result_messages_hash, calculate_sha256,
    calculate_source_hash, derive_recovery_notice_id,
};
use crate::protocol::id::*;
use crate::protocol::messages::FinishReason;
use crate::protocol::models::ProviderUsage;
use crate::protocol::recovery::{RecoveryKind, RecoveryNotice};
use crate::protocol::tool_result::*;
use crate::token::{
    FramingProfileV1, GenericTokenEstimatorV1, TokenEstimationContext, TokenEstimatorV1,
    GENERIC_ESTIMATOR_ID,
};

pub fn truncated_log_tail_notice(sha: &str) -> RecoveryNotice {
    truncated_tail_notice(sha)
}

pub struct SessionRecoveryEngine {
    store: EventLogStore,
    ids: MonotonicUlidGenerator,
    clock: Arc<dyn Clock>,
    pending_notices: Vec<RecoveryNotice>,
}

impl SessionRecoveryEngine {
    pub fn new(session_dir: &Path, expected_session_id: &str) -> HistoryResult<Self> {
        let store = EventLogStore::create_or_open(session_dir, expected_session_id)?;
        let mut pending_notices = Vec::new();
        if let Some(sha) = store.quarantined_tail() {
            pending_notices.push(truncated_tail_notice(sha));
        }
        Ok(Self {
            store,
            ids: MonotonicUlidGenerator::system(),
            clock: Arc::new(SystemClock),
            pending_notices,
        })
    }

    pub fn with_runtime(
        store: EventLogStore,
        ids: MonotonicUlidGenerator,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let pending_notices = store
            .quarantined_tail()
            .map(truncated_tail_notice)
            .into_iter()
            .collect();
        Self {
            store,
            ids,
            clock,
            pending_notices,
        }
    }

    pub fn pending_notices(&self) -> &[RecoveryNotice] {
        &self.pending_notices
    }

    pub fn take_pending_notices(&mut self) -> Vec<RecoveryNotice> {
        std::mem::take(&mut self.pending_notices)
    }

    pub fn store(&self) -> &EventLogStore {
        &self.store
    }

    pub fn projection(&self) -> HistoryResult<crate::history::projection::ConversationProjection> {
        let events = self.store.events()?;
        crate::history::projection::ConversationProjection::project_with_context(
            &events,
            Some(self.store.raw_lines()),
            self.pending_notices(),
        )
    }

    pub fn run_recovery(&mut self) -> HistoryResult<usize> {
        let mut appended = 0usize;
        loop {
            let events = self.store.events()?;
            let replay = replay(&events, self.store.raw_lines())?;

            if let Some(attempt) = replay
                .attempts
                .values()
                .filter(|attempt| attempt.status == AttemptStatus::Open)
                .min_by_key(|attempt| {
                    events
                        .iter()
                        .position(|event| event.event_id == attempt.started_event_id)
                        .unwrap_or(usize::MAX)
                })
            {
                let event = self.envelope(
                    attempt.turn_id,
                    Some(attempt.id),
                    CanonicalEvent::AssistantAttemptFailed(AssistantAttemptFailed {
                        purpose: attempt.purpose.clone(),
                        error: ProtocolError {
                            code: "E_ATTEMPT_LOST".to_owned(),
                            class: ErrorClass::ProcessCrash,
                            message: "The provider attempt was open when the process stopped."
                                .to_owned(),
                            retryable: true,
                            http_status: None,
                            retry_after_ms: None,
                        },
                        partial_output: PartialAssistantOutput {
                            blocks: Vec::new(),
                            provider_response_id: None,
                        },
                        observable_delta_emitted: false,
                        provider_may_have_completed: true,
                        usage: ProviderUsage::default(),
                    }),
                )?;
                self.store.append_event(&event)?;
                self.push_notice(attempt_lost_notice(attempt.started_event_id));
                appended += 1;
                continue;
            }

            if let Some(repair) = next_tool_repair(&replay) {
                match repair {
                    ToolRepair::Uncertain {
                        turn_id,
                        attempt_id,
                        batch_id,
                        step_id,
                        execution,
                    } => {
                        let text = "{\"code\":\"E_TOOL_SIDE_EFFECT_UNCERTAIN\",\"error\":\"The process stopped after this tool was marked started. Its side effects are unknown. Do not repeat the mutation until state has been inspected.\",\"ok\":false}";
                        let event = self.tool_finish(
                            turn_id,
                            attempt_id,
                            batch_id,
                            step_id,
                            execution.execution_id,
                            execution.call_id.clone(),
                            execution.call_index,
                            execution.tool_name.clone(),
                            Some(execution.started_event_id.expect("started execution")),
                            ToolResultStatus::Uncertain,
                            text,
                        )?;
                        self.store.append_event(&event)?;
                        self.push_notice(tool_uncertain_notice(
                            execution.started_event_id.expect("started execution"),
                            &execution.tool_name,
                            &execution.call_id,
                        ));
                    }
                    ToolRepair::Skip {
                        turn_id,
                        attempt_id,
                        batch_id,
                        step_id,
                        call,
                        call_index,
                    } => {
                        let execution_id = self.next_id()?;
                        let text = "{\"code\":\"E_TOOL_SKIPPED_UNCERTAIN_PEER\",\"error\":\"Skipped because another call in the parallel batch has uncertain side effects.\",\"ok\":false}";
                        let event = self.tool_finish(
                            turn_id,
                            attempt_id,
                            batch_id,
                            step_id,
                            execution_id,
                            call.call_id,
                            call_index,
                            call.name,
                            None,
                            ToolResultStatus::Skipped,
                            text,
                        )?;
                        self.store.append_event(&event)?;
                    }
                }
                appended += 1;
                continue;
            }

            if let Some((turn_id, attempt_id, batch)) = replay
                .turns
                .values()
                .flat_map(|turn| {
                    turn.batches.values().filter_map(move |batch| {
                        (batch.completed.is_none()
                            && batch.executions.len() == batch.calls.len()
                            && batch
                                .executions
                                .values()
                                .all(|execution| execution.result.is_some()))
                        .then_some((turn.id, batch.attempt_id, batch))
                    })
                })
                .next()
            {
                let mut results = Vec::new();
                let mut finish_ids = Vec::new();
                for call in &batch.calls {
                    let execution = &batch.executions[&call.call_id];
                    results.push(execution.result.clone().unwrap());
                    finish_ids.push(execution.finish_event_id.unwrap());
                }
                let event = self.envelope(
                    Some(turn_id),
                    Some(attempt_id),
                    CanonicalEvent::ToolBatchCompleted(ToolBatchCompleted {
                        batch_id: batch.id,
                        step_id: batch.step_id,
                        call_ids: batch
                            .calls
                            .iter()
                            .map(|call| call.call_id.clone())
                            .collect(),
                        result_event_ids: finish_ids,
                        result_messages_hash: calculate_result_messages_hash(&results)?,
                    }),
                )?;
                self.store.append_event(&event)?;
                appended += 1;
                continue;
            }

            if let Some(turn) = replay.turns.values().find(|turn| {
                turn.terminal.is_none()
                    && turn.steps.values().next_back().is_some_and(|step| {
                        matches!(
                            step.message.finish_reason,
                            FinishReason::Stop | FinishReason::Length
                        )
                    })
            }) {
                let terminal = turn.steps.values().next_back().unwrap();
                let messages = accepted_messages(turn, true, None, None)?;
                let usage = sum_attempt_usage(&replay, turn.id);
                let event = self.envelope(
                    Some(turn.id),
                    None,
                    CanonicalEvent::TurnCommitted(TurnCommitted {
                        turn_index: turn.started.as_ref().unwrap().turn_index,
                        user_message_id: turn.user.message_id,
                        terminal_step_id: terminal.purpose.step_id,
                        accepted_step_ids: turn
                            .steps
                            .values()
                            .map(|step| step.purpose.step_id)
                            .collect(),
                        completed_batch_ids: turn
                            .steps
                            .values()
                            .filter_map(|step| {
                                turn.batches
                                    .get(&step.purpose.step_id)
                                    .and_then(|batch| batch.completed.as_ref())
                                    .map(|batch| batch.batch_id)
                            })
                            .collect(),
                        outcome: match terminal.message.finish_reason {
                            FinishReason::Length => TurnOutcome::Length,
                            _ => TurnOutcome::Stop,
                        },
                        accepted_messages_hash: calculate_accepted_messages_hash(&messages)?,
                        usage,
                        recovery_notice_ids_presented: presented_notice_ids(&events, turn.id),
                    }),
                )?;
                self.store.append_event(&event)?;
                appended += 1;
                continue;
            }

            if let Some(turn) = replay
                .turns
                .values()
                .find(|turn| turn.terminal.is_none() && turn.started.is_none())
            {
                let (model, toolset_hash, max_steps) = replay
                    .replay_turn_settings()
                    .ok_or_else(|| HistoryError::new("E_SESSION_NOT_STARTED", None, None, false))?;
                let turn_index = replay.turn_index(turn.id).ok_or_else(|| {
                    HistoryError::new("E_EVENT_TRANSITION_INVALID", None, None, false)
                })?;
                let event = self.envelope(
                    Some(turn.id),
                    None,
                    CanonicalEvent::TurnStarted(TurnStarted {
                        turn_index,
                        user_message_id: turn.user.message_id,
                        model,
                        toolset_hash,
                        max_steps,
                    }),
                )?;
                self.store.append_event(&event)?;
                appended += 1;
                continue;
            }
            break;
        }
        Ok(appended)
    }

    #[allow(clippy::too_many_arguments)]
    fn tool_finish(
        &self,
        turn_id: TurnId,
        attempt_id: AttemptId,
        batch_id: ToolBatchId,
        step_id: StepId,
        execution_id: ToolExecutionId,
        call_id: ToolCallId,
        call_index: u32,
        tool_name: String,
        started_event_id: Option<EventId>,
        status: ToolResultStatus,
        text: &str,
    ) -> HistoryResult<EventEnvelope> {
        let message_id = self.next_id()?;
        let recovered = status == ToolResultStatus::Uncertain;
        self.envelope(
            Some(turn_id),
            Some(attempt_id),
            CanonicalEvent::ToolExecutionFinished(ToolExecutionFinished {
                batch_id,
                execution_id,
                step_id,
                call_id: call_id.clone(),
                call_index,
                started_event_id,
                result: ToolResultMessage {
                    message_id,
                    turn_id,
                    step_id,
                    batch_id,
                    execution_id,
                    call_id,
                    tool_name,
                    status,
                    body: synthetic_tool_result_body(text)?,
                    recovered,
                },
            }),
        )
    }

    fn envelope(
        &self,
        turn_id: Option<TurnId>,
        attempt_id: Option<AttemptId>,
        event: CanonicalEvent,
    ) -> HistoryResult<EventEnvelope> {
        Ok(EventEnvelope {
            schema_version: crate::protocol::constants::EVENT_SCHEMA_VERSION,
            event_id: self.next_id()?,
            session_id: *self.store.session_id(),
            sequence: self.store.current_sequence() + 1,
            timestamp_ms: self.clock.now_ms(),
            turn_id,
            attempt_id,
            event,
        })
    }

    fn next_id<T: crate::id::ProtocolUlidId>(&self) -> HistoryResult<T> {
        self.ids
            .next_id()
            .map_err(|_| HistoryError::new("E_EVENT_DURABILITY_UNCERTAIN", None, None, false))
    }

    fn push_notice(&mut self, notice: RecoveryNotice) {
        if !self
            .pending_notices
            .iter()
            .any(|existing| existing.notice_id == notice.notice_id)
        {
            self.pending_notices.push(notice);
        }
    }
}

enum ToolRepair {
    Uncertain {
        turn_id: TurnId,
        attempt_id: AttemptId,
        batch_id: ToolBatchId,
        step_id: StepId,
        execution: Box<crate::history::replay::ExecutionReplay>,
    },
    Skip {
        turn_id: TurnId,
        attempt_id: AttemptId,
        batch_id: ToolBatchId,
        step_id: StepId,
        call: crate::protocol::messages::ToolCall,
        call_index: u32,
    },
}

fn next_tool_repair(replay: &EventReplayer) -> Option<ToolRepair> {
    for turn in replay.turns.values() {
        for batch in turn.batches.values() {
            for call in &batch.calls {
                if let Some(execution) = batch.executions.get(&call.call_id) {
                    if execution.started_event_id.is_some() && execution.result.is_none() {
                        return Some(ToolRepair::Uncertain {
                            turn_id: turn.id,
                            attempt_id: batch.attempt_id,
                            batch_id: batch.id,
                            step_id: batch.step_id,
                            execution: Box::new(execution.clone()),
                        });
                    }
                }
            }
            let has_uncertain_side_effect = batch.executions.values().any(|execution| {
                execution.started_event_id.is_some()
                    && execution.result.as_ref().is_some_and(|result| {
                        result.status == ToolResultStatus::Uncertain
                            && matches!(
                                execution.mutability,
                                Some(ToolMutability::Mutating | ToolMutability::Outward)
                            )
                    })
            });
            if has_uncertain_side_effect {
                for (index, call) in batch.calls.iter().enumerate() {
                    if !batch.executions.contains_key(&call.call_id) {
                        return Some(ToolRepair::Skip {
                            turn_id: turn.id,
                            attempt_id: batch.attempt_id,
                            batch_id: batch.id,
                            step_id: batch.step_id,
                            call: call.clone(),
                            call_index: index as u32,
                        });
                    }
                }
            }
        }
    }
    None
}

fn replay(events: &[EventEnvelope], raw_lines: &[String]) -> HistoryResult<EventReplayer> {
    let mut replay = EventReplayer::new();
    for (index, event) in events.iter().enumerate() {
        replay.process_event(event, Some(index + 1), Some(raw_lines))?;
    }
    Ok(replay)
}

fn attempt_lost_notice(source: EventId) -> RecoveryNotice {
    let key = source.to_string();
    RecoveryNotice {
        notice_id: derive_recovery_notice_id("attempt_lost", &[key.as_str()]),
        kind: RecoveryKind::AttemptLost,
        source_event_ids: vec![source],
        message: "A provider attempt was in progress when the prior process stopped. No output from that attempt was accepted.".to_owned(),
        required_action: "Continue from durable accepted history; do not assume the lost attempt completed.".to_owned(),
    }
}

fn tool_uncertain_notice(source: EventId, tool: &str, call: &ToolCallId) -> RecoveryNotice {
    // §4.3: source keys are uppercase source event IDs in sequence order.
    // The start event alone identifies the uncertain execution.
    let source_key = source.to_string();
    RecoveryNotice {
        notice_id: derive_recovery_notice_id(
            "tool_side_effect_uncertain",
            &[source_key.as_str()],
        ),
        kind: RecoveryKind::ToolSideEffectUncertain,
        source_event_ids: vec![source],
        message: format!(
            "Tool {tool} for call {call} was marked started before the prior process stopped, but no durable result exists. Its side effects are unknown."
        ),
        required_action:
            "Inspect the affected state before repeating this tool or making a dependent mutation."
                .to_owned(),
    }
}

fn truncated_tail_notice(sha: &str) -> RecoveryNotice {
    // §4.3: the sole source key for a truncated tail is `tail:` followed by
    // the lowercase SHA-256 of the quarantined bytes.
    let key = format!("tail:{sha}");
    RecoveryNotice {
        notice_id: derive_recovery_notice_id("truncated_log_tail", &[key.as_str()]),
        kind: RecoveryKind::TruncatedLogTail,
        source_event_ids: Vec::new(),
        message: "An incomplete final event record from the prior process was quarantined. Earlier durable events remain valid.".to_owned(),
        required_action:
            "Continue from the reported durable state; do not assume the quarantined event occurred."
                .to_owned(),
    }
}

fn sum_attempt_usage(replay: &EventReplayer, turn_id: TurnId) -> ProviderUsage {
    let mut total = ProviderUsage::default();
    for attempt in replay.attempts.values() {
        if attempt.turn_id != Some(turn_id) {
            continue;
        }
        total.input_tokens = total
            .input_tokens
            .saturating_add(attempt.usage.input_tokens);
        total.output_tokens = total
            .output_tokens
            .saturating_add(attempt.usage.output_tokens);
        total.reasoning_tokens = total
            .reasoning_tokens
            .saturating_add(attempt.usage.reasoning_tokens);
        total.total_tokens = total
            .total_tokens
            .saturating_add(attempt.usage.total_tokens);
        total.cache_read_tokens = total
            .cache_read_tokens
            .saturating_add(attempt.usage.cache_read_tokens);
        total.cache_write_tokens = total
            .cache_write_tokens
            .saturating_add(attempt.usage.cache_write_tokens);
    }
    total
}

fn synthetic_tool_result_body(text: &str) -> HistoryResult<ToolResultBody> {
    let bytes = text.as_bytes();
    let sha = calculate_sha256(bytes);
    let estimate = GenericTokenEstimatorV1
        .estimate(
            TokenEstimationContext::ArtifactResult,
            bytes,
            &FramingProfileV1 {
                framing_profile_schema_version: 1,
                framing_profile_id: GENERIC_ESTIMATOR_ID.to_owned(),
                fixed_tokens: 0,
                per_item_tokens: 0,
                item_count: 0,
                additional_tokens: 0,
            },
        )
        .map_err(|_| HistoryError::new("E_EVENT_SCHEMA_INVALID", None, None, false))?;
    Ok(ToolResultBody {
        media_type: "application/json".to_owned(),
        content: ToolResultContent::Inline(InlineToolResult {
            text: text.to_owned(),
        }),
        sha256: sha.clone(),
        byte_count: bytes.len() as u64,
        line_count: None,
        estimated_tokens: estimate.total_tokens,
        token_estimator_schema_version: 1,
        estimator_id: GENERIC_ESTIMATOR_ID.to_owned(),
        token_input_sha256: sha,
        redacted: false,
    })
}

fn presented_notice_ids(events: &[EventEnvelope], turn_id: TurnId) -> Vec<RecoveryNoticeId> {
    let mut ids = Vec::new();
    for event in events {
        if event.turn_id == Some(turn_id) {
            if let CanonicalEvent::AssistantAttemptStarted(started) = &event.event {
                for notice in &started.recovery_notices {
                    if !ids.contains(&notice.notice_id) {
                        ids.push(notice.notice_id);
                    }
                }
            }
        }
    }
    ids
}

pub fn build_interrupted_turn_capsule(
    events: &[EventEnvelope],
    raw_lines: &[String],
    turn_id: TurnId,
) -> HistoryResult<InterruptedTurnCapsuleV1> {
    let replay = replay(events, raw_lines)?;
    let turn = replay
        .turns
        .values()
        .find(|turn| turn.id == turn_id)
        .ok_or_else(|| HistoryError::new("E_REFERENCE_UNKNOWN", None, None, false))?;
    let crate::history::replay::TurnTerminal::Interrupted(interruption, event_id) = turn
        .terminal
        .as_ref()
        .ok_or_else(|| HistoryError::new("E_EVENT_TRANSITION_INVALID", None, None, false))?
    else {
        return Err(HistoryError::new(
            "E_EVENT_TRANSITION_INVALID",
            None,
            None,
            false,
        ));
    };
    let source_end_sequence = events
        .iter()
        .find(|event| event.event_id == *event_id)
        .map(|event| event.sequence)
        .ok_or_else(|| HistoryError::new("E_REFERENCE_UNKNOWN", None, None, false))?;
    let source_start = turn.start_sequence;
    if source_start == 0
        || source_end_sequence == 0
        || source_end_sequence > raw_lines.len() as u64
        || source_start > source_end_sequence
    {
        return Err(HistoryError::new("E_REFERENCE_UNKNOWN", None, None, false));
    }
    let source_lines = &raw_lines[(source_start as usize - 1)..source_end_sequence as usize];
    Ok(InterruptedTurnCapsuleV1 {
        capsule_schema_version: 1,
        turn_id,
        turn_index: turn
            .started
            .as_ref()
            .ok_or_else(|| HistoryError::new("E_EVENT_TRANSITION_INVALID", None, None, false))?
            .turn_index,
        user_message_id: turn.user.message_id,
        accepted_step_ids: turn
            .steps
            .values()
            .map(|step| step.purpose.step_id)
            .collect(),
        completed_batch_ids: turn
            .batches
            .values()
            .filter_map(|batch| batch.completed.as_ref().map(|complete| complete.batch_id))
            .collect(),
        reason: interruption.reason.clone(),
        failed_attempt_id: interruption.failed_attempt_id,
        uncertain_execution_ids: interruption.uncertain_execution_ids.clone(),
        interruption_event_id: *event_id,
        source_start_sequence: source_start,
        source_end_sequence,
        source_hash: calculate_source_hash(source_lines),
    })
}
