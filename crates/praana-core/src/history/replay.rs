//! Pure schema-2 event replay and integrity validation.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::protocol::constants::EVENT_SCHEMA_VERSION;
use crate::protocol::errors::{HistoryError, HistoryResult};
use crate::protocol::events::*;
use crate::protocol::hashes::{
    calculate_accepted_messages_hash, calculate_result_messages_hash, calculate_sha256,
    calculate_source_hash, calculate_tool_arguments_hash,
};
use crate::protocol::id::*;
use crate::protocol::json::{check_raw_duplicate_keys_and_depth, serialize_canonical};
use crate::protocol::messages::{
    AssistantBlock, AssistantMessage, ConversationMessage, FinishReason, ToolCall, UserBlock,
    UserMessage,
};
use crate::protocol::models::{ModelSelection, ProviderUsage};
use crate::protocol::state_graph::*;
use crate::protocol::tool_result::ToolResultMessage;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttemptStatus {
    Open,
    Failed,
    Accepted,
}

#[derive(Clone, Debug)]
pub struct AttemptReplay {
    pub id: AttemptId,
    pub turn_id: Option<TurnId>,
    pub purpose: ProviderAttemptPurpose,
    pub status: AttemptStatus,
    pub started_event_id: EventId,
    pub observable_delta_emitted: bool,
    pub attempt_number: u32,
    pub usage: ProviderUsage,
}

#[derive(Clone, Debug)]
pub struct StepReplay {
    pub purpose: AssistantStepPurpose,
    pub message: AssistantMessage,
    pub attempt_id: AttemptId,
    pub accept_event_id: EventId,
}

#[derive(Clone, Debug)]
pub struct ExecutionReplay {
    pub execution_id: ToolExecutionId,
    pub batch_id: ToolBatchId,
    pub step_id: StepId,
    pub call_id: ToolCallId,
    pub call_index: u32,
    pub tool_name: String,
    pub mutability: Option<ToolMutability>,
    pub started_event_id: Option<EventId>,
    pub finish_event_id: Option<EventId>,
    pub result: Option<ToolResultMessage>,
}

#[derive(Clone, Debug)]
pub struct BatchReplay {
    pub id: ToolBatchId,
    pub turn_id: TurnId,
    pub attempt_id: AttemptId,
    pub step_id: StepId,
    pub calls: Vec<ToolCall>,
    pub executions: HashMap<ToolCallId, ExecutionReplay>,
    pub completed: Option<ToolBatchCompleted>,
}

#[derive(Clone, Debug)]
pub enum TurnTerminal {
    Committed(TurnCommitted),
    Interrupted(TurnInterrupted, EventId),
}

#[derive(Clone, Debug)]
pub struct TurnReplay {
    pub id: TurnId,
    pub user: UserMessage,
    pub started: Option<TurnStarted>,
    pub start_sequence: u64,
    pub steps: BTreeMap<u32, StepReplay>,
    pub batches: HashMap<StepId, BatchReplay>,
    pub terminal: Option<TurnTerminal>,
}

#[derive(Clone, Default)]
pub struct EventReplayer {
    session_id: Option<SessionId>,
    current_sequence: u64,
    seen_event_ids: HashSet<EventId>,
    known_event_sequences: HashMap<EventId, u64>,
    seen_local_ids: HashSet<String>,
    seen_tool_call_ids: HashSet<ToolCallId>,
    pub turns: BTreeMap<u64, TurnReplay>,
    turn_by_id: HashMap<TurnId, u64>,
    message_ids: HashSet<MessageId>,
    recovery_notices: HashMap<RecoveryNoticeId, crate::protocol::recovery::RecoveryNotice>,
    pub attempts: HashMap<AttemptId, AttemptReplay>,
    step_owner: HashMap<StepId, TurnId>,
    execution_owner: HashMap<ToolExecutionId, (TurnId, StepId, ToolCallId)>,
    pub state: StateGraphV1,
    pub reset_epoch: u32,
    pub compaction_epoch: u32,
    pub compacted_turn_ids: Vec<TurnId>,
    pub active_handoff: Option<crate::protocol::compaction::HistoricalHandoffV1>,
    session_started: Option<SessionStarted>,
    current_model: Option<ModelSelection>,
    current_toolset_hash: Option<Sha256Digest>,
    current_max_steps: Option<u32>,
    snapshot_max_steps: Option<u32>,
}

impl EventReplayer {
    pub fn new() -> Self {
        Self {
            state: StateGraphV1 {
                schema_version: 1,
                ..StateGraphV1::default()
            },
            ..Self::default()
        }
    }

    pub fn current_sequence(&self) -> u64 {
        self.current_sequence
    }

    pub fn session_id(&self) -> Option<SessionId> {
        self.session_id
    }

    pub fn active_turn_id(&self) -> Option<TurnId> {
        self.turns
            .values()
            .find(|turn| turn.terminal.is_none())
            .map(|turn| turn.id)
    }

    /// Settings captured by session replay for a recovery-authored `turn_started`.
    pub fn replay_turn_settings(&self) -> Option<(ModelSelection, Sha256Digest, u32)> {
        Some((
            self.current_model.clone()?,
            self.current_toolset_hash.clone()?,
            self.current_max_steps.or(self.snapshot_max_steps)?,
        ))
    }

    pub fn current_model(&self) -> Option<&ModelSelection> {
        self.current_model.as_ref()
    }

    pub fn set_snapshot_max_steps(&mut self, max_steps: u32) {
        self.snapshot_max_steps = Some(max_steps);
    }

    pub fn turn_index(&self, turn_id: TurnId) -> Option<u64> {
        self.turn_by_id.get(&turn_id).copied()
    }

    pub fn process_event(
        &mut self,
        envelope: &EventEnvelope,
        line: Option<usize>,
        raw_lines: Option<&[String]>,
    ) -> HistoryResult<()> {
        let seq = Some(envelope.sequence);
        if envelope.schema_version != EVENT_SCHEMA_VERSION {
            return Err(HistoryError::new(
                "E_SCHEMA_VERSION_UNSUPPORTED",
                seq,
                line,
                false,
            ));
        }
        let expected = self.current_sequence + 1;
        if envelope.sequence != expected {
            let code = if envelope.sequence < expected {
                "E_JSONL_SEQUENCE_DUPLICATE"
            } else {
                "E_JSONL_SEQUENCE_GAP"
            };
            return Err(HistoryError::new(code, seq, line, false));
        }
        if envelope.sequence == 1 && !matches!(envelope.event, CanonicalEvent::SessionStarted(_)) {
            return Err(HistoryError::new("E_SESSION_NOT_STARTED", seq, line, false));
        }
        if envelope.sequence > 1 && matches!(envelope.event, CanonicalEvent::SessionStarted(_)) {
            return Err(HistoryError::new(
                "E_EVENT_TRANSITION_INVALID",
                seq,
                line,
                false,
            ));
        }
        if let Some(session_id) = self.session_id {
            if session_id != envelope.session_id {
                return Err(HistoryError::new("E_SESSION_ID_MISMATCH", seq, line, false));
            }
        } else {
            self.session_id = Some(envelope.session_id);
        }
        if self.seen_event_ids.contains(&envelope.event_id) {
            return Err(HistoryError::new("E_EVENT_ID_DUPLICATE", seq, line, false));
        }
        self.validate_context(envelope, line)?;

        let mut next = self.clone();
        next.apply_event(envelope, line, raw_lines)?;
        next.seen_event_ids.insert(envelope.event_id);
        next.known_event_sequences
            .insert(envelope.event_id, envelope.sequence);
        next.current_sequence = envelope.sequence;
        next.state.applied_through_sequence = envelope.sequence;
        *self = next;
        Ok(())
    }

    fn error(&self, code: &str, envelope: &EventEnvelope, line: Option<usize>) -> HistoryError {
        HistoryError::new(code, Some(envelope.sequence), line, false)
    }

    fn validate_context(&self, e: &EventEnvelope, line: Option<usize>) -> HistoryResult<()> {
        let valid = match &e.event {
            CanonicalEvent::SessionStarted(_) | CanonicalEvent::ResetBoundary(_) => {
                e.turn_id.is_none() && e.attempt_id.is_none()
            }
            CanonicalEvent::UserMessageAccepted(_)
            | CanonicalEvent::TurnStarted(_)
            | CanonicalEvent::TurnCommitted(_)
            | CanonicalEvent::TurnInterrupted(_) => e.turn_id.is_some() && e.attempt_id.is_none(),
            CanonicalEvent::AssistantAttemptStarted(v) => match v.purpose {
                ProviderAttemptPurpose::AssistantStep(_) => {
                    e.turn_id.is_some() && e.attempt_id.is_some()
                }
                ProviderAttemptPurpose::Compaction(_) => {
                    e.turn_id.is_none() && e.attempt_id.is_some()
                }
            },
            CanonicalEvent::AssistantAttemptFailed(v) => match v.purpose {
                ProviderAttemptPurpose::AssistantStep(_) => {
                    e.turn_id.is_some() && e.attempt_id.is_some()
                }
                ProviderAttemptPurpose::Compaction(_) => {
                    e.turn_id.is_none() && e.attempt_id.is_some()
                }
            },
            CanonicalEvent::AssistantStepAccepted(_) => {
                e.turn_id.is_some() && e.attempt_id.is_some()
            }
            CanonicalEvent::AttemptSuperseded(v) => match v.purpose {
                ProviderAttemptPurpose::AssistantStep(_) => {
                    e.turn_id.is_some() && e.attempt_id.is_none()
                }
                ProviderAttemptPurpose::Compaction(_) => {
                    e.turn_id.is_none() && e.attempt_id.is_none()
                }
            },
            CanonicalEvent::ToolExecutionStarted(_)
            | CanonicalEvent::ToolExecutionFinished(_)
            | CanonicalEvent::ToolBatchCompleted(_) => {
                e.turn_id.is_some() && e.attempt_id.is_some()
            }
            CanonicalEvent::HistoryCompacted(_) => e.turn_id.is_none() && e.attempt_id.is_some(),
            CanonicalEvent::ModelChanged(_) => e.attempt_id.is_none(),
            CanonicalEvent::StateChanged(v) => {
                let caused_by_tool = v.source.tool_call_id.is_some();
                if caused_by_tool {
                    e.turn_id.is_some() && e.attempt_id.is_some()
                } else {
                    e.turn_id.is_none() && e.attempt_id.is_none()
                }
            }
            CanonicalEvent::SystemNote(_) => true,
        };
        if valid {
            Ok(())
        } else {
            Err(self.error("E_EVENT_CONTEXT_INVALID", e, line))
        }
    }

    fn apply_event(
        &mut self,
        e: &EventEnvelope,
        line: Option<usize>,
        raw_lines: Option<&[String]>,
    ) -> HistoryResult<()> {
        match &e.event {
            CanonicalEvent::SessionStarted(v) => {
                if e.sequence != 1 || !self.turns.is_empty() {
                    return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                }
                self.session_started = Some(v.clone());
                self.current_model = Some(v.initial_model.clone());
                self.current_toolset_hash = Some(v.initial_toolset_hash.clone());
            }
            CanonicalEvent::UserMessageAccepted(v) => {
                if self.active_turn_id().is_some() {
                    return Err(self.error("E_TURN_ALREADY_ACTIVE", e, line));
                }
                validate_user_message(&v.message).map_err(|code| self.error(code, e, line))?;
                let turn_id = e.turn_id.unwrap();
                if v.message.turn_id != turn_id {
                    return Err(self.error("E_EVENT_CONTEXT_INVALID", e, line));
                }
                self.introduce(&turn_id.to_string(), e, line)?;
                self.introduce(&v.message.message_id.to_string(), e, line)?;
                if !self.message_ids.insert(v.message.message_id) {
                    return Err(self.error("E_REFERENCE_DUPLICATE", e, line));
                }
                let ordinal = self
                    .turns
                    .keys()
                    .next_back()
                    .copied()
                    .unwrap_or(self.state.committed_turn_ordinal)
                    + 1;
                self.turn_by_id.insert(turn_id, ordinal);
                self.turns.insert(
                    ordinal,
                    TurnReplay {
                        id: turn_id,
                        user: v.message.clone(),
                        started: None,
                        start_sequence: e.sequence,
                        steps: BTreeMap::new(),
                        batches: HashMap::new(),
                        terminal: None,
                    },
                );
            }
            CanonicalEvent::TurnStarted(v) => {
                let turn_id = e.turn_id.unwrap();
                let ordinal = self.turn_by_id.get(&turn_id).copied();
                let turn = self.turn_mut(turn_id, e, line)?;
                if turn.terminal.is_some() {
                    return Err(self.error("E_TURN_ALREADY_TERMINAL", e, line));
                }
                if turn.started.is_some()
                    || turn.user.message_id != v.user_message_id
                    || ordinal != Some(v.turn_index)
                {
                    return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                }
                turn.started = Some(v.clone());
                self.current_model = Some(v.model.clone());
                self.current_toolset_hash = Some(v.toolset_hash.clone());
                self.current_max_steps = Some(v.max_steps);
            }
            CanonicalEvent::AssistantAttemptStarted(v) => {
                let attempt_id = e.attempt_id.unwrap();
                if self.attempts.contains_key(&attempt_id) {
                    return Err(self.error("E_REFERENCE_DUPLICATE", e, line));
                }
                let purpose_attempts: Vec<&AttemptReplay> = self
                    .attempts
                    .values()
                    .filter(|attempt| attempt.purpose == v.purpose)
                    .collect();
                let expected_number = purpose_attempts.len() as u32 + 1;
                if v.attempt_number != expected_number {
                    return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                }
                if let Some(retry) = v.retry_of {
                    let prior = self
                        .attempts
                        .get(&retry)
                        .ok_or_else(|| self.error("E_REFERENCE_UNKNOWN", e, line))?;
                    match prior.status {
                        AttemptStatus::Accepted => {
                            return Err(self.error("E_PROVIDER_RETRY_AFTER_ACCEPTANCE", e, line))
                        }
                        AttemptStatus::Open => {
                            return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line))
                        }
                        AttemptStatus::Failed if prior.observable_delta_emitted => {
                            return Err(self.error("E_PROVIDER_RETRY_AFTER_EMISSION", e, line))
                        }
                        AttemptStatus::Failed => {}
                    }
                    if prior.purpose != v.purpose {
                        return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                    }
                    let immediate = purpose_attempts.iter().max_by_key(|attempt| {
                        (attempt.attempt_number, attempt.started_event_id.to_string())
                    });
                    match immediate {
                        Some(previous)
                            if previous.id == retry
                                && previous.attempt_number + 1 == v.attempt_number => {}
                        _ => return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line)),
                    }
                } else if expected_number != 1 {
                    // Fixture e18 starts a second attempt without retry_of after
                    // acceptance so the later accept raises E_STEP_ALREADY_ACCEPTED.
                    let prior_accepted = purpose_attempts
                        .iter()
                        .any(|attempt| attempt.status == AttemptStatus::Accepted);
                    if !prior_accepted {
                        return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                    }
                }
                match &v.purpose {
                    ProviderAttemptPurpose::AssistantStep(purpose) => {
                        let turn_id = e.turn_id.unwrap();
                        let turn = self.turn(turn_id, e, line)?;
                        if turn.started.is_none() || turn.terminal.is_some() {
                            return Err(self.error(
                                if turn.terminal.is_some() {
                                    "E_TURN_ALREADY_TERMINAL"
                                } else {
                                    "E_EVENT_TRANSITION_INVALID"
                                },
                                e,
                                line,
                            ));
                        }
                        if turn.batches.values().any(|batch| batch.completed.is_none()) {
                            return Err(self.error("E_TOOL_BATCH_INCOMPLETE", e, line));
                        }
                        if let Some(owner) = self.step_owner.get(&purpose.step_id) {
                            if *owner != turn_id {
                                return Err(self.error("E_REFERENCE_DUPLICATE", e, line));
                            }
                            // Step ID already introduced. Failed attempts may retry.
                            // A second attempt without retry_of after acceptance is
                            // allowed to start so the subsequent accept raises
                            // E_STEP_ALREADY_ACCEPTED (fixture e18).
                            let known = self.attempts.values().any(|a| {
                                a.purpose == v.purpose
                                    && matches!(
                                        a.status,
                                        AttemptStatus::Failed | AttemptStatus::Accepted
                                    )
                            });
                            if !known {
                                return Err(self.error("E_REFERENCE_DUPLICATE", e, line));
                            }
                        } else {
                            let expected = turn.steps.len() as u32;
                            if purpose.step_index != expected {
                                return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                            }
                            self.step_owner.insert(purpose.step_id, turn_id);
                            self.introduce(&purpose.step_id.to_string(), e, line)?;
                        }
                    }
                    ProviderAttemptPurpose::Compaction(purpose) => {
                        if self
                            .seen_local_ids
                            .contains(&purpose.compaction_id.to_string())
                        {
                            let retry_exists = self.attempts.values().any(|a| {
                                a.purpose == v.purpose && a.status == AttemptStatus::Failed
                            });
                            if !retry_exists {
                                return Err(self.error("E_REFERENCE_DUPLICATE", e, line));
                            }
                        } else {
                            self.introduce(&purpose.compaction_id.to_string(), e, line)?;
                        }
                    }
                }
                for notice in &v.recovery_notices {
                    if let Some(existing) = self.recovery_notices.get(&notice.notice_id) {
                        if existing != notice {
                            return Err(self.error("E_REFERENCE_DUPLICATE", e, line));
                        }
                    } else {
                        self.introduce(&notice.notice_id.to_string(), e, line)?;
                        self.recovery_notices
                            .insert(notice.notice_id, notice.clone());
                    }
                    for source in &notice.source_event_ids {
                        self.require_event(*source, e, line)?;
                    }
                }
                self.introduce(&attempt_id.to_string(), e, line)?;
                self.attempts.insert(
                    attempt_id,
                    AttemptReplay {
                        id: attempt_id,
                        turn_id: e.turn_id,
                        purpose: v.purpose.clone(),
                        status: AttemptStatus::Open,
                        started_event_id: e.event_id,
                        observable_delta_emitted: false,
                        attempt_number: v.attempt_number,
                        usage: ProviderUsage::default(),
                    },
                );
            }
            CanonicalEvent::AssistantAttemptFailed(v) => {
                let attempt_id = e.attempt_id.unwrap();
                if !self.attempts.contains_key(&attempt_id) {
                    return Err(self.error("E_REFERENCE_UNKNOWN", e, line));
                }
                let attempt = self.attempts.get_mut(&attempt_id).unwrap();
                if attempt.status != AttemptStatus::Open {
                    return Err(self.error("E_ATTEMPT_ALREADY_TERMINAL", e, line));
                }
                if attempt.purpose != v.purpose || attempt.turn_id != e.turn_id {
                    return Err(self.error("E_EVENT_CONTEXT_INVALID", e, line));
                }
                attempt.status = AttemptStatus::Failed;
                attempt.observable_delta_emitted = v.observable_delta_emitted;
                attempt.usage = v.usage.clone();
            }
            CanonicalEvent::AssistantStepAccepted(v) => {
                let attempt_id = e.attempt_id.unwrap();
                let attempt = self
                    .attempts
                    .get(&attempt_id)
                    .ok_or_else(|| self.error("E_REFERENCE_UNKNOWN", e, line))?
                    .clone();
                if attempt.status != AttemptStatus::Open {
                    return Err(self.error("E_ATTEMPT_ALREADY_TERMINAL", e, line));
                }
                if attempt.purpose != ProviderAttemptPurpose::AssistantStep(v.purpose.clone())
                    || v.message.turn_id != e.turn_id.unwrap()
                    || v.message.step_id != v.purpose.step_id
                {
                    return Err(self.error("E_EVENT_CONTEXT_INVALID", e, line));
                }
                let calls = validate_assistant_message(&v.message)
                    .map_err(|code| self.error(code, e, line))?;
                if self
                    .turn(e.turn_id.unwrap(), e, line)?
                    .steps
                    .contains_key(&v.purpose.step_index)
                {
                    return Err(self.error("E_STEP_ALREADY_ACCEPTED", e, line));
                }
                for call in calls {
                    if !self.seen_tool_call_ids.insert(call.call_id.clone()) {
                        return Err(self.error("E_TOOL_CALL_ID_REUSED", e, line));
                    }
                }
                self.introduce(&v.message.message_id.to_string(), e, line)?;
                self.message_ids.insert(v.message.message_id);
                let accepted = self.attempts.get_mut(&attempt_id).unwrap();
                accepted.status = AttemptStatus::Accepted;
                accepted.usage = v.message.usage.clone();
                self.turn_mut(e.turn_id.unwrap(), e, line)?.steps.insert(
                    v.purpose.step_index,
                    StepReplay {
                        purpose: v.purpose.clone(),
                        message: v.message.clone(),
                        attempt_id,
                        accept_event_id: e.event_id,
                    },
                );
            }
            CanonicalEvent::AttemptSuperseded(v) => {
                let old = self
                    .attempts
                    .get(&v.superseded_attempt_id)
                    .ok_or_else(|| self.error("E_REFERENCE_UNKNOWN", e, line))?;
                let replacement = self
                    .attempts
                    .get(&v.replacement_attempt_id)
                    .ok_or_else(|| self.error("E_REFERENCE_UNKNOWN", e, line))?;
                if old.status != AttemptStatus::Failed
                    || replacement.status != AttemptStatus::Accepted
                    || old.purpose != v.purpose
                    || replacement.purpose != v.purpose
                {
                    return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                }
                self.require_event(v.replacement_accept_event_id, e, line)?;
            }
            CanonicalEvent::ToolExecutionStarted(v) => self.apply_tool_start(e, v, line)?,
            CanonicalEvent::ToolExecutionFinished(v) => self.apply_tool_finish(e, v, line)?,
            CanonicalEvent::ToolBatchCompleted(v) => self.apply_batch_complete(e, v, line)?,
            CanonicalEvent::TurnCommitted(v) => self.apply_turn_commit(e, v, line)?,
            CanonicalEvent::TurnInterrupted(v) => {
                if let Some(step_id) = v.last_accepted_step_id {
                    if !self.step_owner.contains_key(&step_id) {
                        return Err(self.error("E_REFERENCE_UNKNOWN", e, line));
                    }
                }
                if let Some(attempt_id) = v.failed_attempt_id {
                    if !self.attempts.contains_key(&attempt_id) {
                        return Err(self.error("E_REFERENCE_UNKNOWN", e, line));
                    }
                }
                if v.uncertain_execution_ids
                    .iter()
                    .any(|id| !self.execution_owner.contains_key(id))
                {
                    return Err(self.error("E_REFERENCE_UNKNOWN", e, line));
                }
                let turn = self.turn_mut(e.turn_id.unwrap(), e, line)?;
                if turn.terminal.is_some() {
                    return Err(self.error("E_TURN_ALREADY_TERMINAL", e, line));
                }
                if turn.user.message_id != v.user_message_id
                    || turn.started.as_ref().map(|s| s.turn_index) != Some(v.turn_index)
                {
                    return Err(self.error("E_EVENT_CONTEXT_INVALID", e, line));
                }
                turn.terminal = Some(TurnTerminal::Interrupted(v.clone(), e.event_id));
            }
            CanonicalEvent::StateChanged(v) => self.apply_state_changed(e, v, line)?,
            CanonicalEvent::HistoryCompacted(v) => {
                // Compaction may run while an active turn waits on a complete
                // tool cycle (fixture 18). Source turns must still be closed and
                // must not include the active turn (e25).
                if v.reset_epoch != self.reset_epoch || v.epoch != self.compaction_epoch + 1 {
                    return Err(self.error("E_COMPACTION_EPOCH_INVALID", e, line));
                }
                if let Some(active) = self.active_turn_id() {
                    if v.source_turn_ids.contains(&active) {
                        return Err(self.error("E_COMPACTION_RANGE_INVALID", e, line));
                    }
                }
                if v.source_start_sequence == 0
                    || v.source_start_sequence > v.source_end_sequence
                    || v.source_end_sequence >= e.sequence
                    || v.source_turn_ids.iter().any(|id| {
                        self.compacted_turn_ids.contains(id)
                            || self
                                .turn_by_id
                                .get(id)
                                .and_then(|idx| self.turns.get(idx))
                                .is_none_or(|t| {
                                    !matches!(
                                        t.terminal,
                                        Some(TurnTerminal::Committed(_))
                                            | Some(TurnTerminal::Interrupted(_, _))
                                    )
                                })
                    })
                {
                    return Err(self.error("E_COMPACTION_RANGE_INVALID", e, line));
                }
                if let Some(lines) = raw_lines {
                    let start = v.source_start_sequence as usize - 1;
                    let end = v.source_end_sequence as usize;
                    if end > lines.len()
                        || calculate_source_hash(&lines[start..end]) != v.source_hash
                    {
                        return Err(self.error("E_COMPACTION_SOURCE_HASH_MISMATCH", e, line));
                    }
                } else {
                    return Err(self.error("E_COMPACTION_SOURCE_HASH_MISMATCH", e, line));
                }
                if calculate_sha256(&serialize_canonical(&v.segment)?) != v.segment_hash
                    || calculate_sha256(&serialize_canonical(&v.handoff)?) != v.handoff_hash
                {
                    return Err(self.error("E_COMPACTION_SOURCE_HASH_MISMATCH", e, line));
                }
                let attempt_id = e.attempt_id.unwrap();
                if !self.attempts.contains_key(&attempt_id) {
                    return Err(self.error("E_REFERENCE_UNKNOWN", e, line));
                }
                let attempt = self.attempts.get_mut(&attempt_id).unwrap();
                if attempt.status != AttemptStatus::Open
                    || attempt.purpose
                        != ProviderAttemptPurpose::Compaction(CompactionPurpose {
                            compaction_id: v.compaction_id,
                            epoch: v.epoch,
                        })
                    || attempt.started_event_id != v.attempt_started_event_id
                {
                    return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                }
                attempt.status = AttemptStatus::Accepted;
                self.compaction_epoch = v.epoch;
                self.compacted_turn_ids
                    .extend(v.source_turn_ids.iter().copied());
                self.active_handoff = Some(v.handoff.clone());
            }
            CanonicalEvent::ModelChanged(v) => {
                // §5.10: ConfigReload and Retained are reserved and rejected
                // by the initial implementation.
                if v.reason == ModelChangeReason::ConfigReload
                    || v.continuation_disposition == ContinuationDisposition::Retained
                {
                    return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                }
                if let Some(active_turn_id) = self.active_turn_id() {
                    if !self.provider_fallback_allowed(e, v, active_turn_id) {
                        return Err(self.error("E_MODEL_CHANGE_DURING_TURN", e, line));
                    }
                } else if e.turn_id.is_some() {
                    return Err(self.error("E_EVENT_CONTEXT_INVALID", e, line));
                }
                self.current_model = Some(v.to.clone());
                self.current_toolset_hash = Some(v.toolset_hash.clone());
            }
            CanonicalEvent::ResetBoundary(v) => {
                if self.active_turn_id().is_some() {
                    return Err(self.error("E_RESET_DURING_TURN", e, line));
                }
                // §13.1: schema 2 requires clears_state and a successor epoch.
                if !v.clears_state {
                    return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                }
                if v.reset_epoch != self.reset_epoch + 1 {
                    return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
                }
                if let Some(turn_id) = v.previous_turn_id {
                    if !self.turn_by_id.contains_key(&turn_id) {
                        return Err(self.error("E_REFERENCE_UNKNOWN", e, line));
                    }
                }
                self.reset_epoch = v.reset_epoch;
                self.compaction_epoch = 0;
                self.compacted_turn_ids.clear();
                self.active_handoff = None;
                self.turns.clear();
                self.turn_by_id.clear();
                self.state = StateGraphV1 {
                    schema_version: 1,
                    reset_epoch: v.reset_epoch,
                    applied_through_sequence: e.sequence,
                    ..StateGraphV1::default()
                };
            }
            CanonicalEvent::SystemNote(v) => {
                for id in &v.references {
                    self.require_event(*id, e, line)?;
                }
            }
        }
        Ok(())
    }

    /// §12.2: model_changed is normally illegal during a turn; one narrow
    /// provider_fallback exception is allowed when the turn has no accepted
    /// step, every attempt failed, and no tool execution exists.
    fn provider_fallback_allowed(
        &self,
        e: &EventEnvelope,
        v: &ModelChanged,
        active_turn_id: TurnId,
    ) -> bool {
        if v.reason != ModelChangeReason::ProviderFallback {
            return false;
        }
        if e.turn_id != Some(active_turn_id) || e.attempt_id.is_some() {
            return false;
        }
        let Some(turn) = self
            .turn_by_id
            .get(&active_turn_id)
            .and_then(|index| self.turns.get(index))
        else {
            return false;
        };
        if !turn.steps.is_empty() {
            return false;
        }
        if !turn.batches.is_empty() {
            return false;
        }
        let turn_attempts: Vec<_> = self
            .attempts
            .values()
            .filter(|attempt| attempt.turn_id == Some(active_turn_id))
            .collect();
        !turn_attempts.is_empty()
            && turn_attempts
                .iter()
                .all(|attempt| attempt.status == AttemptStatus::Failed)
    }

    fn apply_tool_start(
        &mut self,
        e: &EventEnvelope,
        v: &ToolExecutionStarted,
        line: Option<usize>,
    ) -> HistoryResult<()> {
        if self.execution_owner.contains_key(&v.execution_id) {
            return Err(self.error("E_TOOL_EXECUTION_ALREADY_TERMINAL", e, line));
        }
        let (step, calls) = self.accepted_tool_step(e, v.step_id, line)?;
        let call = calls
            .get(v.call_index as usize)
            .filter(|call| call.call_id == v.call_id && call.name == v.tool_name)
            .ok_or_else(|| self.error("E_TOOL_RESULT_CALL_MISMATCH", e, line))?;
        let arguments = serde_json::Value::Object(call.arguments.clone());
        if calculate_tool_arguments_hash(&arguments)? != v.arguments_hash {
            return Err(self.error("E_TOOL_RESULT_CALL_MISMATCH", e, line));
        }
        let turn_id = e.turn_id.unwrap();
        let attempt_id = e.attempt_id.unwrap();
        if step.attempt_id != attempt_id {
            return Err(self.error("E_EVENT_CONTEXT_INVALID", e, line));
        }
        let batch =
            self.ensure_batch(turn_id, attempt_id, v.step_id, v.batch_id, calls, e, line)?;
        if batch.executions.contains_key(&v.call_id) {
            return Err(self.error("E_TOOL_RESULT_DUPLICATE", e, line));
        }
        batch.executions.insert(
            v.call_id.clone(),
            ExecutionReplay {
                execution_id: v.execution_id,
                batch_id: v.batch_id,
                step_id: v.step_id,
                call_id: v.call_id.clone(),
                call_index: v.call_index,
                tool_name: v.tool_name.clone(),
                mutability: Some(v.mutability.clone()),
                started_event_id: Some(e.event_id),
                finish_event_id: None,
                result: None,
            },
        );
        self.execution_owner
            .insert(v.execution_id, (turn_id, v.step_id, v.call_id.clone()));
        self.introduce(&v.execution_id.to_string(), e, line)?;
        Ok(())
    }

    fn apply_tool_finish(
        &mut self,
        e: &EventEnvelope,
        v: &ToolExecutionFinished,
        line: Option<usize>,
    ) -> HistoryResult<()> {
        let (step, calls) = self.accepted_tool_step(e, v.step_id, line)?;
        calls
            .get(v.call_index as usize)
            .filter(|call| call.call_id == v.call_id && call.name == v.result.tool_name)
            .ok_or_else(|| self.error("E_TOOL_RESULT_CALL_MISMATCH", e, line))?;
        if step.attempt_id != e.attempt_id.unwrap()
            || v.result.turn_id != e.turn_id.unwrap()
            || v.result.step_id != v.step_id
            || v.result.batch_id != v.batch_id
            || v.result.execution_id != v.execution_id
            || v.result.call_id != v.call_id
        {
            return Err(self.error("E_TOOL_RESULT_CALL_MISMATCH", e, line));
        }
        if let crate::protocol::tool_result::ToolResultContent::Inline(inline) =
            &v.result.body.content
        {
            let bytes = inline.text.as_bytes();
            if v.result.body.byte_count != bytes.len() as u64
                || v.result.body.sha256 != calculate_sha256(bytes)
            {
                return Err(self.error("E_ARTIFACT_HASH_MISMATCH", e, line));
            }
        }
        let turn_id = e.turn_id.unwrap();
        let attempt_id = e.attempt_id.unwrap();
        if let Some(start) = v.started_event_id {
            self.require_event(start, e, line)?;
        }
        let execution_already_owned = self.execution_owner.contains_key(&v.execution_id);
        let batch =
            self.ensure_batch(turn_id, attempt_id, v.step_id, v.batch_id, calls, e, line)?;
        if batch.completed.is_some() {
            return Err(self.error("E_TOOL_BATCH_ALREADY_COMPLETE", e, line));
        }
        if let Some(exec) = batch.executions.get_mut(&v.call_id) {
            if exec.finish_event_id.is_some() {
                return Err(self.error("E_TOOL_RESULT_DUPLICATE", e, line));
            }
            if exec.execution_id != v.execution_id
                || exec.call_index != v.call_index
                || v.started_event_id != exec.started_event_id
            {
                return Err(self.error("E_TOOL_RESULT_CALL_MISMATCH", e, line));
            }
            exec.finish_event_id = Some(e.event_id);
            exec.result = Some(v.result.clone());
        } else {
            if v.started_event_id.is_some() || execution_already_owned {
                return Err(self.error("E_TOOL_RESULT_CALL_MISMATCH", e, line));
            }
            batch.executions.insert(
                v.call_id.clone(),
                ExecutionReplay {
                    execution_id: v.execution_id,
                    batch_id: v.batch_id,
                    step_id: v.step_id,
                    call_id: v.call_id.clone(),
                    call_index: v.call_index,
                    tool_name: v.result.tool_name.clone(),
                    mutability: None,
                    started_event_id: None,
                    finish_event_id: Some(e.event_id),
                    result: Some(v.result.clone()),
                },
            );
            self.execution_owner
                .insert(v.execution_id, (turn_id, v.step_id, v.call_id.clone()));
            self.introduce(&v.execution_id.to_string(), e, line)?;
        }
        self.introduce(&v.result.message_id.to_string(), e, line)?;
        self.message_ids.insert(v.result.message_id);
        Ok(())
    }

    fn apply_batch_complete(
        &mut self,
        e: &EventEnvelope,
        v: &ToolBatchCompleted,
        line: Option<usize>,
    ) -> HistoryResult<()> {
        let turn_id = e.turn_id.unwrap();
        let batch_snapshot = self
            .turn(turn_id, e, line)?
            .batches
            .get(&v.step_id)
            .cloned()
            .ok_or_else(|| self.error("E_REFERENCE_UNKNOWN", e, line))?;
        let batch = &batch_snapshot;
        if batch.id != v.batch_id {
            return Err(self.error("E_TOOL_RESULT_CALL_MISMATCH", e, line));
        }
        if batch.completed.is_some() {
            return Err(self.error("E_TOOL_BATCH_ALREADY_COMPLETE", e, line));
        }
        let expected_calls: Vec<_> = batch.calls.iter().map(|c| c.call_id.clone()).collect();
        if v.call_ids != expected_calls || batch.executions.len() != batch.calls.len() {
            return Err(self.error("E_TOOL_BATCH_INCOMPLETE", e, line));
        }
        // Forward references in result_event_ids are E_REFERENCE_UNKNOWN (e29)
        // before call-order mismatch checks.
        for id in &v.result_event_ids {
            self.require_event(*id, e, line)?;
        }
        let mut results = Vec::new();
        let mut event_ids = Vec::new();
        for call in &batch.calls {
            let execution = batch
                .executions
                .get(&call.call_id)
                .ok_or_else(|| self.error("E_TOOL_BATCH_INCOMPLETE", e, line))?;
            results.push(
                execution
                    .result
                    .clone()
                    .ok_or_else(|| self.error("E_TOOL_BATCH_INCOMPLETE", e, line))?,
            );
            event_ids.push(
                execution
                    .finish_event_id
                    .ok_or_else(|| self.error("E_TOOL_BATCH_INCOMPLETE", e, line))?,
            );
        }
        if event_ids != v.result_event_ids {
            return Err(self.error("E_TOOL_RESULT_CALL_MISMATCH", e, line));
        }
        if calculate_result_messages_hash(&results)? != v.result_messages_hash {
            return Err(self.error("E_TOOL_RESULT_CALL_MISMATCH", e, line));
        }
        self.turn_mut(turn_id, e, line)?
            .batches
            .get_mut(&v.step_id)
            .unwrap()
            .completed = Some(v.clone());
        Ok(())
    }

    fn apply_turn_commit(
        &mut self,
        e: &EventEnvelope,
        v: &TurnCommitted,
        line: Option<usize>,
    ) -> HistoryResult<()> {
        let turn = self.turn(e.turn_id.unwrap(), e, line)?;
        if turn.terminal.is_some() {
            return Err(self.error("E_TURN_ALREADY_TERMINAL", e, line));
        }
        if turn.user.message_id != v.user_message_id
            || turn.started.as_ref().map(|s| s.turn_index) != Some(v.turn_index)
        {
            return Err(self.error("E_EVENT_CONTEXT_INVALID", e, line));
        }
        let accepted_step_ids: Vec<_> = turn
            .steps
            .values()
            .map(|step| step.purpose.step_id)
            .collect();
        let completed_batch_ids: Vec<_> = turn
            .steps
            .values()
            .filter_map(|step| {
                turn.batches
                    .get(&step.purpose.step_id)
                    .and_then(|batch| batch.completed.as_ref())
                    .map(|batch| batch.batch_id)
            })
            .collect();
        if accepted_step_ids != v.accepted_step_ids
            || completed_batch_ids != v.completed_batch_ids
            || accepted_step_ids.last().copied() != Some(v.terminal_step_id)
        {
            return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
        }
        if turn.batches.values().any(|batch| batch.completed.is_none()) {
            return Err(self.error("E_TOOL_BATCH_INCOMPLETE", e, line));
        }
        let messages = accepted_messages(turn, true, Some(e.sequence), line)?;
        if calculate_accepted_messages_hash(&messages)? != v.accepted_messages_hash {
            return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
        }
        let terminal = turn
            .steps
            .values()
            .next_back()
            .ok_or_else(|| self.error("E_EVENT_TRANSITION_INVALID", e, line))?;
        if matches!(terminal.message.finish_reason, FinishReason::ToolUse) {
            return Err(self.error("E_TOOL_BATCH_INCOMPLETE", e, line));
        }
        self.turn_mut(e.turn_id.unwrap(), e, line)?.terminal =
            Some(TurnTerminal::Committed(v.clone()));
        self.state.committed_turn_ordinal = self.state.committed_turn_ordinal.saturating_add(1);
        Ok(())
    }

    fn apply_state_changed(
        &mut self,
        e: &EventEnvelope,
        v: &StateChangedV1,
        line: Option<usize>,
    ) -> HistoryResult<()> {
        if v.state_schema_version != 1
            || v.expected_graph_sequence != self.current_sequence
            || v.source.sequence >= e.sequence
            || self.known_event_sequences.get(&v.source.event_id).copied()
                != Some(v.source.sequence)
        {
            return Err(self.error("STATE_PROJECTION_INTEGRITY", e, line));
        }
        if self.seen_local_ids.contains(&v.mutation_id.to_string()) {
            return Err(self.error("E_REFERENCE_DUPLICATE", e, line));
        }
        let mut graph = self.state.clone();
        for operation in &v.operations {
            if let StateOperationV1::Create { state_id, .. } = operation {
                if self.seen_local_ids.contains(&state_id.to_string()) {
                    return Err(self.error("E_REFERENCE_DUPLICATE", e, line));
                }
            }
        }
        for operation in &v.operations {
            apply_state_operation(&mut graph, operation, v, e)
                .map_err(|_| self.error("STATE_PROJECTION_INTEGRITY", e, line))?;
        }
        graph.objects.sort_by_key(|object| object.state_id);
        graph.applied_through_sequence = e.sequence;
        for operation in &v.operations {
            if let StateOperationV1::Create { state_id, .. } = operation {
                self.seen_local_ids.insert(state_id.to_string());
            }
        }
        self.state = graph;
        self.introduce(&v.mutation_id.to_string(), e, line)?;
        Ok(())
    }

    fn accepted_tool_step(
        &self,
        e: &EventEnvelope,
        step_id: StepId,
        line: Option<usize>,
    ) -> HistoryResult<(StepReplay, Vec<ToolCall>)> {
        let turn = self.turn(e.turn_id.unwrap(), e, line)?;
        if turn.terminal.is_some() {
            return Err(self.error("E_TURN_ALREADY_TERMINAL", e, line));
        }
        let step = turn
            .steps
            .values()
            .find(|step| step.purpose.step_id == step_id)
            .ok_or_else(|| self.error("E_REFERENCE_UNKNOWN", e, line))?
            .clone();
        let calls =
            validate_assistant_message(&step.message).map_err(|code| self.error(code, e, line))?;
        if !matches!(step.message.finish_reason, FinishReason::ToolUse) {
            return Err(self.error("E_EVENT_TRANSITION_INVALID", e, line));
        }
        Ok((step, calls))
    }

    #[allow(clippy::too_many_arguments)]
    fn ensure_batch(
        &mut self,
        turn_id: TurnId,
        attempt_id: AttemptId,
        step_id: StepId,
        batch_id: ToolBatchId,
        calls: Vec<ToolCall>,
        e: &EventEnvelope,
        line: Option<usize>,
    ) -> HistoryResult<&mut BatchReplay> {
        let index = self
            .turn_by_id
            .get(&turn_id)
            .copied()
            .ok_or_else(|| self.error("E_REFERENCE_UNKNOWN", e, line))?;
        let needs_insert = !self
            .turns
            .get(&index)
            .is_some_and(|turn| turn.batches.contains_key(&step_id));
        if needs_insert {
            if self.seen_local_ids.contains(&batch_id.to_string()) {
                return Err(self.error("E_REFERENCE_DUPLICATE", e, line));
            }
            self.seen_local_ids.insert(batch_id.to_string());
            self.turns.get_mut(&index).unwrap().batches.insert(
                step_id,
                BatchReplay {
                    id: batch_id,
                    turn_id,
                    attempt_id,
                    step_id,
                    calls,
                    executions: HashMap::new(),
                    completed: None,
                },
            );
        }
        let batch = self
            .turns
            .get_mut(&index)
            .unwrap()
            .batches
            .get_mut(&step_id)
            .unwrap();
        if batch.id != batch_id || batch.attempt_id != attempt_id {
            return Err(HistoryError::new(
                "E_TOOL_RESULT_CALL_MISMATCH",
                Some(e.sequence),
                line,
                false,
            ));
        }
        Ok(batch)
    }

    fn turn(
        &self,
        id: TurnId,
        e: &EventEnvelope,
        line: Option<usize>,
    ) -> HistoryResult<&TurnReplay> {
        self.turn_by_id
            .get(&id)
            .and_then(|index| self.turns.get(index))
            .ok_or_else(|| self.error("E_REFERENCE_UNKNOWN", e, line))
    }

    fn turn_mut(
        &mut self,
        id: TurnId,
        e: &EventEnvelope,
        line: Option<usize>,
    ) -> HistoryResult<&mut TurnReplay> {
        let index = self
            .turn_by_id
            .get(&id)
            .copied()
            .ok_or_else(|| self.error("E_REFERENCE_UNKNOWN", e, line))?;
        self.turns
            .get_mut(&index)
            .ok_or_else(|| HistoryError::new("E_REFERENCE_UNKNOWN", Some(e.sequence), line, false))
    }

    fn introduce(&mut self, id: &str, e: &EventEnvelope, line: Option<usize>) -> HistoryResult<()> {
        if !self.seen_local_ids.insert(id.to_owned()) {
            return Err(self.error("E_REFERENCE_DUPLICATE", e, line));
        }
        Ok(())
    }

    fn require_event(
        &self,
        id: EventId,
        e: &EventEnvelope,
        line: Option<usize>,
    ) -> HistoryResult<()> {
        if self.seen_event_ids.contains(&id) {
            Ok(())
        } else {
            Err(self.error("E_REFERENCE_UNKNOWN", e, line))
        }
    }
}

pub fn accepted_messages(
    turn: &TurnReplay,
    require_complete: bool,
    seq: Option<u64>,
    line: Option<usize>,
) -> HistoryResult<Vec<ConversationMessage>> {
    // Provenance threads the caller's envelope position into every error so
    // fixtures can assert the exact failing sequence and line (§16.2).
    let incomplete = || HistoryError::new("E_TOOL_BATCH_INCOMPLETE", seq, line, false);
    let mut messages = vec![ConversationMessage::User(turn.user.clone())];
    for step in turn.steps.values() {
        if matches!(step.message.finish_reason, FinishReason::ToolUse) {
            let Some(batch) = turn.batches.get(&step.purpose.step_id) else {
                if require_complete {
                    return Err(incomplete());
                }
                break;
            };
            if batch.completed.is_none() {
                if require_complete {
                    return Err(incomplete());
                }
                break;
            }
            messages.push(ConversationMessage::Assistant(step.message.clone()));
            for call in &batch.calls {
                let result = batch
                    .executions
                    .get(&call.call_id)
                    .and_then(|execution| execution.result.clone())
                    .ok_or_else(&incomplete)?;
                messages.push(ConversationMessage::ToolResult(result));
            }
        } else {
            messages.push(ConversationMessage::Assistant(step.message.clone()));
        }
    }
    Ok(messages)
}

fn validate_user_message(message: &UserMessage) -> Result<(), &'static str> {
    if message.blocks.is_empty() {
        return Err("E_EVENT_SCHEMA_INVALID");
    }
    let has_image_or_artifact = message
        .blocks
        .iter()
        .any(|block| matches!(block, UserBlock::Image(_) | UserBlock::ArtifactRef(_)));
    for block in &message.blocks {
        if let UserBlock::Text(text) = block {
            if text.text.is_empty() && !has_image_or_artifact {
                return Err("E_EVENT_SCHEMA_INVALID");
            }
        }
    }
    Ok(())
}

fn validate_assistant_message(message: &AssistantMessage) -> Result<Vec<ToolCall>, &'static str> {
    // §5.3: an accepted step always carries at least one block.
    if message.blocks.is_empty() {
        return Err("E_EVENT_SCHEMA_INVALID");
    }
    for block in &message.blocks {
        match block {
            AssistantBlock::Text(text) if text.text.is_empty() => {
                return Err("E_EVENT_SCHEMA_INVALID")
            }
            AssistantBlock::ReasoningSummary(text) if text.text.is_empty() => {
                return Err("E_EVENT_SCHEMA_INVALID")
            }
            AssistantBlock::Refusal(text) if text.text.is_empty() => {
                return Err("E_EVENT_SCHEMA_INVALID")
            }
            _ => {}
        }
    }
    let calls: Vec<_> = message
        .blocks
        .iter()
        .filter_map(|block| match block {
            AssistantBlock::ToolCall(call) => Some(call.clone()),
            _ => None,
        })
        .collect();
    // §5.3: a refusal is terminal portable content and never shares a step
    // with a tool call.
    let has_refusal = message
        .blocks
        .iter()
        .any(|block| matches!(block, AssistantBlock::Refusal(_)));
    if has_refusal && !calls.is_empty() {
        return Err("E_EVENT_SCHEMA_INVALID");
    }
    match message.finish_reason {
        FinishReason::ToolUse if calls.is_empty() => return Err("E_EVENT_SCHEMA_INVALID"),
        FinishReason::Stop | FinishReason::Length if !calls.is_empty() => {
            return Err("E_EVENT_SCHEMA_INVALID")
        }
        _ => {}
    }
    for call in &calls {
        check_raw_duplicate_keys_and_depth(&call.raw_arguments)
            .map_err(|_| "E_TOOL_ARGUMENTS_INVALID")?;
        let raw: serde_json::Value =
            serde_json::from_str(&call.raw_arguments).map_err(|_| "E_TOOL_ARGUMENTS_INVALID")?;
        if !raw.is_object() {
            return Err("E_TOOL_ARGUMENTS_INVALID");
        }
        let parsed = serialize_canonical(&raw).map_err(|_| "E_TOOL_ARGUMENTS_INVALID")?;
        let declared = serialize_canonical(&serde_json::Value::Object(call.arguments.clone()))
            .map_err(|_| "E_TOOL_ARGUMENTS_INVALID")?;
        if parsed != declared {
            return Err("E_TOOL_ARGUMENTS_INVALID");
        }
    }
    Ok(calls)
}

fn apply_state_operation(
    graph: &mut StateGraphV1,
    op: &StateOperationV1,
    event: &StateChangedV1,
    envelope: &EventEnvelope,
) -> Result<(), ()> {
    let touch = |object: &mut StateObjectV1| {
        object.last_touched_at_ms = envelope.timestamp_ms;
        object.last_touched_sequence = envelope.sequence;
        object.last_touched_turn_ordinal = graph.committed_turn_ordinal;
    };
    match op {
        StateOperationV1::Create {
            state_id,
            tier,
            value,
        } => {
            if graph.objects.iter().any(|o| o.state_id == *state_id) {
                return Err(());
            }
            graph.objects.push(StateObjectV1 {
                state_id: *state_id,
                revision: 1,
                tier: tier.clone(),
                lifecycle: ObjectLifecycle::Current,
                value: value.clone(),
                created_at_ms: envelope.timestamp_ms,
                created_sequence: envelope.sequence,
                updated_at_ms: envelope.timestamp_ms,
                updated_sequence: envelope.sequence,
                last_touched_at_ms: envelope.timestamp_ms,
                last_touched_sequence: envelope.sequence,
                last_touched_turn_ordinal: graph.committed_turn_ordinal,
                source: event.source.clone(),
                retracted_reason: None,
            });
        }
        StateOperationV1::SetFocus { patch } => match patch {
            FocusPatchV1::Clear => graph.focus = None,
            FocusPatchV1::Set(id) => {
                let object = graph
                    .objects
                    .iter()
                    .find(|o| o.state_id == *id && o.lifecycle == ObjectLifecycle::Current)
                    .ok_or(())?;
                if object.tier != StateTier::Active {
                    return Err(());
                }
                graph.focus = Some(FocusV1 {
                    state_id: *id,
                    set_at_ms: envelope.timestamp_ms,
                    set_sequence: envelope.sequence,
                });
            }
        },
        _ => {
            let (id, revision) = operation_target(op).ok_or(())?;
            let supersession_valid = match op {
                StateOperationV1::SupersedeDecision { by_state_id, .. } => {
                    id != *by_state_id
                        && graph.objects.iter().any(|candidate| {
                            candidate.state_id == *by_state_id
                                && candidate.lifecycle == ObjectLifecycle::Current
                                && matches!(candidate.value, StateValueV1::Decision(_))
                        })
                }
                _ => true,
            };
            if !supersession_valid {
                return Err(());
            }
            let object = graph
                .objects
                .iter_mut()
                .find(|o| o.state_id == id)
                .ok_or(())?;
            if object.lifecycle != ObjectLifecycle::Current || object.revision != revision {
                return Err(());
            }
            let should_touch;
            match op {
                StateOperationV1::UpdateTask { patch, touch, .. } => {
                    let StateValueV1::Task(value) = &mut object.value else {
                        return Err(());
                    };
                    if let Some(v) = &patch.title {
                        value.title = v.trim().to_owned();
                    }
                    apply_optional(&mut value.description, &patch.description);
                    if let Some(v) = &patch.status {
                        value.status = v.clone();
                    }
                    apply_optional(&mut value.blocker, &patch.blocker);
                    should_touch = *touch;
                }
                StateOperationV1::ReopenTask { status, touch, .. } => {
                    let StateValueV1::Task(value) = &mut object.value else {
                        return Err(());
                    };
                    value.status = match status {
                        ReopenTaskStatus::Todo => TaskStatus::Todo,
                        ReopenTaskStatus::InProgress => TaskStatus::InProgress,
                    };
                    value.blocker = None;
                    should_touch = *touch;
                }
                StateOperationV1::UpdateDecision {
                    summary,
                    rationale,
                    touch,
                    ..
                } => {
                    let StateValueV1::Decision(value) = &mut object.value else {
                        return Err(());
                    };
                    if let Some(v) = summary {
                        value.summary = v.trim().to_owned();
                    }
                    if let Some(v) = rationale {
                        value.rationale = v.trim().to_owned();
                    }
                    should_touch = *touch;
                }
                StateOperationV1::SupersedeDecision {
                    by_state_id, touch, ..
                } => {
                    let StateValueV1::Decision(value) = &mut object.value else {
                        return Err(());
                    };
                    value.status = DecisionStatus::Superseded {
                        by_state_id: *by_state_id,
                    };
                    should_touch = *touch;
                }
                StateOperationV1::UpdateConstraint { patch, touch, .. } => {
                    let StateValueV1::Constraint(value) = &mut object.value else {
                        return Err(());
                    };
                    if let Some(v) = &patch.text {
                        value.text = v.trim().to_owned();
                    }
                    if let Some(v) = &patch.strength {
                        value.strength = v.clone();
                    }
                    if let Some(v) = &patch.status {
                        value.status = v.clone();
                    }
                    apply_optional(&mut value.status_reason, &patch.status_reason);
                    should_touch = *touch;
                }
                StateOperationV1::ReactivateConstraint { touch, .. } => {
                    let StateValueV1::Constraint(value) = &mut object.value else {
                        return Err(());
                    };
                    value.status = ConstraintStatus::Active;
                    value.status_reason = None;
                    should_touch = *touch;
                }
                StateOperationV1::UpdateNote {
                    text, tags, touch, ..
                } => {
                    let StateValueV1::Note(value) = &mut object.value else {
                        return Err(());
                    };
                    if let Some(v) = text {
                        value.text = v.trim().to_owned();
                    }
                    if let Some(v) = tags {
                        value.tags = v.clone();
                    }
                    should_touch = *touch;
                }
                StateOperationV1::UpdateError { patch, touch, .. } => {
                    let StateValueV1::Error(value) = &mut object.value else {
                        return Err(());
                    };
                    if let Some(v) = &patch.message {
                        value.message = v.trim().to_owned();
                    }
                    apply_optional(&mut value.code, &patch.code);
                    if let Some(v) = &patch.severity {
                        value.severity = v.clone();
                    }
                    if let Some(v) = &patch.status {
                        value.status = v.clone();
                    }
                    apply_optional(&mut value.tool_name, &patch.tool_name);
                    apply_optional(&mut value.command_label, &patch.command_label);
                    apply_optional(&mut value.resolution, &patch.resolution);
                    if let Some(v) = patch.occurrence_count {
                        value.occurrence_count = v;
                    }
                    if let Some(v) = patch.last_observed_event_id {
                        value.last_observed_event_id = v;
                    }
                    should_touch = *touch;
                }
                StateOperationV1::ReopenError { touch, .. } => {
                    let StateValueV1::Error(value) = &mut object.value else {
                        return Err(());
                    };
                    value.status = ErrorStatus::Open;
                    value.resolution = None;
                    should_touch = *touch;
                }
                StateOperationV1::SetTier { tier, touch, .. } => {
                    object.tier = tier.clone();
                    should_touch = *touch;
                }
                StateOperationV1::Touch { .. } => should_touch = true,
                StateOperationV1::Retract { reason, .. } => {
                    object.lifecycle = ObjectLifecycle::Retracted;
                    object.retracted_reason = Some(reason.trim().to_owned());
                    if graph.focus.as_ref().is_some_and(|f| f.state_id == id) {
                        graph.focus = None;
                    }
                    should_touch = true;
                }
                StateOperationV1::Create { .. } | StateOperationV1::SetFocus { .. } => {
                    unreachable!()
                }
            }
            object.revision = object.revision.checked_add(1).ok_or(())?;
            object.updated_at_ms = envelope.timestamp_ms;
            object.updated_sequence = envelope.sequence;
            object.source = event.source.clone();
            if should_touch {
                touch(object);
            }
        }
    }
    Ok(())
}

fn operation_target(op: &StateOperationV1) -> Option<(StateId, u64)> {
    match op {
        StateOperationV1::UpdateTask {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::ReopenTask {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::UpdateDecision {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::SupersedeDecision {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::UpdateConstraint {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::ReactivateConstraint {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::UpdateNote {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::UpdateError {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::ReopenError {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::SetTier {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::Touch {
            state_id,
            expected_revision,
        }
        | StateOperationV1::Retract {
            state_id,
            expected_revision,
            ..
        } => Some((*state_id, *expected_revision)),
        _ => None,
    }
}

fn apply_optional(target: &mut Option<String>, patch: &OptionalStringPatch) {
    match patch {
        OptionalStringPatch::Keep => {}
        OptionalStringPatch::Set(value) => *target = Some(value.trim().to_owned()),
        OptionalStringPatch::Clear => *target = None,
    }
}
