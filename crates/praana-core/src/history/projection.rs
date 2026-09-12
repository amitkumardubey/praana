//! Pure accepted-conversation projection for schema-2 history.

use serde::{Deserialize, Serialize};

use crate::history::replay::{accepted_messages, EventReplayer, TurnTerminal};
use crate::protocol::compaction::{render_historical_handoff, HistoricalHandoffV1};
use crate::protocol::continuation::ProviderContinuation;
use crate::protocol::errors::HistoryError;
use crate::protocol::events::{CanonicalEvent, EventEnvelope, InterruptionReason};
use crate::protocol::hashes::derive_recovery_notice_id;
use crate::protocol::id::TurnId;
use crate::protocol::messages::ConversationMessage;
use crate::protocol::recovery::{RecoveryKind, RecoveryNotice};
use crate::protocol::state_graph::StateGraphV1;

pub type ProjectedMessage = ConversationMessage;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConversationProjection {
    pub reset_epoch: u32,
    pub through_sequence: u64,
    pub active_handoff: Option<HistoricalHandoffV1>,
    pub messages: Vec<ConversationMessage>,
    pub current_state: StateGraphV1,
    pub active_turn: Option<TurnId>,
    pub pending_recovery: Vec<RecoveryNotice>,
    pub active_continuation: Option<ProviderContinuation>,
    pub compacted_turn_ids: Vec<TurnId>,
}

impl ConversationProjection {
    pub fn project(events: &[EventEnvelope]) -> Result<Self, HistoryError> {
        Self::project_with_context(events, None, &[] as &[RecoveryNotice])
    }

    pub fn project_with_context(
        events: &[EventEnvelope],
        raw_lines: Option<&[String]>,
        extra_notices: &[RecoveryNotice],
    ) -> Result<Self, HistoryError> {
        let mut replay = EventReplayer::new();
        for (index, event) in events.iter().enumerate() {
            replay.process_event(event, Some(index + 1), raw_lines)?;
        }

        let active_turn = replay.active_turn_id();
        let mut messages = Vec::new();
        let mut pending_recovery: Vec<RecoveryNotice> = Vec::new();

        for notice in extra_notices {
            if !pending_recovery
                .iter()
                .any(|existing| existing.notice_id == notice.notice_id)
            {
                pending_recovery.push(notice.clone());
            }
        }

        let mut active_continuation = None;

        for turn in replay.turns.values() {
            if replay.compacted_turn_ids.contains(&turn.id) {
                continue;
            }
            let visible = turn.terminal.is_some() || Some(turn.id) == active_turn;
            if !visible {
                continue;
            }
            messages.extend(accepted_messages(turn, false, None, None)?);
            if let Some(TurnTerminal::Interrupted(interruption, event_id)) = &turn.terminal {
                let reason = interruption_reason_slug(&interruption.reason);
                let event_key = event_id.to_string();
                pending_recovery.push(RecoveryNotice {
                    notice_id: derive_recovery_notice_id(
                        "turn_interrupted",
                        &[event_key.as_str()],
                    ),
                    kind: RecoveryKind::TurnInterrupted,
                    source_event_ids: vec![*event_id],
                    message: format!(
                        "The prior turn ended without an accepted terminal assistant response: {reason}."
                    ),
                    required_action: "Reconfirm the current goal and continue only from durable accepted messages and tool results.".to_owned(),
                });
            }
            if Some(turn.id) == active_turn {
                if let Some(last_step) = turn.steps.values().next_back() {
                    if matches!(
                        last_step.message.finish_reason,
                        crate::protocol::messages::FinishReason::ToolUse
                    ) {
                        active_continuation = last_step.message.continuation.clone();
                    }
                }
            }
        }

        let last_reset_sequence = events
            .iter()
            .rev()
            .find_map(|candidate| match candidate.event {
                CanonicalEvent::ResetBoundary(_) => Some(candidate.sequence),
                _ => None,
            })
            .unwrap_or(0);

        for event in events {
            if let CanonicalEvent::ModelChanged(change) = &event.event {
                if event.sequence <= last_reset_sequence {
                    continue;
                }
                // §13.2: project until the first turn commits under the new model.
                let committed_under_new_model = events.iter().any(|later| {
                    later.sequence > event.sequence
                        && matches!(later.event, CanonicalEvent::TurnCommitted(_))
                });
                if committed_under_new_model {
                    continue;
                }
                let event_key = event.event_id.to_string();
                pending_recovery.push(RecoveryNotice {
                    notice_id: derive_recovery_notice_id("model_changed", &[event_key.as_str()]),
                    kind: RecoveryKind::ModelChanged,
                    source_event_ids: vec![event.event_id],
                    message: render_historical_handoff(&change.handoff)?,
                    required_action: "Use the target provider, model, reasoning effort, and listed tool set for subsequent work.".to_owned(),
                });
            }
        }

        let mut compacted_turn_ids: Vec<_> = replay.compacted_turn_ids.iter().copied().collect();
        compacted_turn_ids.sort();
        Ok(Self {
            reset_epoch: replay.reset_epoch,
            through_sequence: replay.current_sequence(),
            active_handoff: replay.active_handoff,
            messages,
            current_state: replay.state,
            active_turn,
            pending_recovery,
            active_continuation,
            compacted_turn_ids,
        })
    }
}

pub fn interruption_reason_slug(reason: &InterruptionReason) -> &'static str {
    match reason {
        InterruptionReason::UserAbort => "user_abort",
        InterruptionReason::ProviderFailure => "provider_failure",
        InterruptionReason::StepLimit => "step_limit",
        InterruptionReason::ActiveTurnTooLarge => "active_turn_too_large",
        InterruptionReason::IncompatibleContinuation => "incompatible_continuation",
        InterruptionReason::ToolRuntimePoisoned => "tool_runtime_poisoned",
        InterruptionReason::SessionShutdown => "session_shutdown",
    }
}
