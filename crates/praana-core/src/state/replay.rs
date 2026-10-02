//! State search rows and checkpoint-tail replay (StateGraph §6.1, §13.2).

use ulid::Ulid;

use crate::history::event_log::EventLogStore;
use crate::protocol::events::{CanonicalEvent, EventEnvelope};
use crate::protocol::id::{EventId, Sha256Digest, StateId};
use crate::protocol::state_graph::*;

use super::StateServiceError;

pub struct StateSearchRow {
    pub state_id: StateId,
    pub source_id: String,
    pub source_field: String,
    pub text: String,
}

pub fn state_source_id(event_id: &EventId, state_id: &StateId) -> String {
    let mut input = Vec::new();
    input.extend_from_slice(b"praana-state-document-v1");
    input.push(0);
    input.extend_from_slice(event_id.to_string().as_bytes());
    input.push(0);
    input.extend_from_slice(state_id.to_string().as_bytes());
    let digest = Sha256Digest::digest_bytes(&input);
    let hex = digest.as_str();
    let mut raw = [0u8; 16];
    for (index, slot) in raw.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).expect("hex digest");
    }
    Ulid::from(u128::from_be_bytes(raw)).to_string()
}

/// Rows derived from the event payload alone. The text is the field's final value.
pub fn state_search_rows(event_id: &EventId, event: &StateChangedV1) -> Vec<StateSearchRow> {
    let mut fields: Vec<(StateId, String, Option<String>)> = Vec::new();
    for operation in &event.operations {
        match operation {
            StateOperationV1::Create {
                state_id, value, ..
            } => {
                push_create(&mut fields, *state_id, value);
            }
            StateOperationV1::UpdateTask {
                state_id, patch, ..
            } => {
                if patch.title.is_some() {
                    note(
                        &mut fields,
                        *state_id,
                        "state.task.title",
                        patch.title.clone(),
                    );
                }
                if let OptionalStringPatch::Set(value) = &patch.description {
                    note(
                        &mut fields,
                        *state_id,
                        "state.task.description",
                        Some(value.clone()),
                    );
                }
                if let OptionalStringPatch::Clear = &patch.description {
                    note(&mut fields, *state_id, "state.task.description", None);
                }
                if let OptionalStringPatch::Set(value) = &patch.blocker {
                    note(
                        &mut fields,
                        *state_id,
                        "state.task.blocker",
                        Some(value.clone()),
                    );
                }
                if let OptionalStringPatch::Clear = &patch.blocker {
                    note(&mut fields, *state_id, "state.task.blocker", None);
                }
            }
            StateOperationV1::UpdateDecision {
                state_id,
                summary,
                rationale,
                ..
            } => {
                if summary.is_some() {
                    note(
                        &mut fields,
                        *state_id,
                        "state.decision.summary",
                        summary.clone(),
                    );
                }
                if rationale.is_some() {
                    note(
                        &mut fields,
                        *state_id,
                        "state.decision.rationale",
                        rationale.clone(),
                    );
                }
            }
            StateOperationV1::UpdateConstraint {
                state_id, patch, ..
            } => {
                if patch.text.is_some() {
                    note(
                        &mut fields,
                        *state_id,
                        "state.constraint.text",
                        patch.text.clone(),
                    );
                }
                if let OptionalStringPatch::Set(value) = &patch.status_reason {
                    note(
                        &mut fields,
                        *state_id,
                        "state.constraint.status_reason",
                        Some(value.clone()),
                    );
                }
                if let OptionalStringPatch::Clear = &patch.status_reason {
                    note(
                        &mut fields,
                        *state_id,
                        "state.constraint.status_reason",
                        None,
                    );
                }
            }
            StateOperationV1::UpdateNote {
                state_id,
                text,
                tags,
                ..
            } => {
                if text.is_some() {
                    note(&mut fields, *state_id, "state.note.text", text.clone());
                }
                if let Some(tags) = tags {
                    let joined = if tags.is_empty() {
                        None
                    } else {
                        Some(tags.join("\n"))
                    };
                    note(&mut fields, *state_id, "state.note.tags", joined);
                }
            }
            StateOperationV1::UpdateError {
                state_id, patch, ..
            } => {
                if patch.message.is_some() {
                    note(
                        &mut fields,
                        *state_id,
                        "state.error.message",
                        patch.message.clone(),
                    );
                }
                set_or_clear(&mut fields, *state_id, "state.error.code", &patch.code);
                set_or_clear(
                    &mut fields,
                    *state_id,
                    "state.error.command_label",
                    &patch.command_label,
                );
                set_or_clear(
                    &mut fields,
                    *state_id,
                    "state.error.resolution",
                    &patch.resolution,
                );
            }
            StateOperationV1::Retract {
                state_id, reason, ..
            } => {
                note(
                    &mut fields,
                    *state_id,
                    "state.retracted_reason",
                    Some(reason.clone()),
                );
            }
            _ => {}
        }
    }
    let mut rows: Vec<(StateId, String, String, Option<String>)> = Vec::new();
    for (state_id, source_field, text) in fields {
        if let Some(existing) = rows
            .iter_mut()
            .find(|row| row.0 == state_id && row.1 == source_field)
        {
            existing.3 = text;
            continue;
        }
        rows.push((
            state_id,
            source_field,
            state_source_id(event_id, &state_id),
            text,
        ));
    }
    rows.into_iter()
        .filter_map(|(state_id, source_field, source_id, text)| {
            let text = text.filter(|value| !value.is_empty())?;
            Some(StateSearchRow {
                state_id,
                source_id,
                source_field,
                text,
            })
        })
        .collect()
}

fn push_create(
    fields: &mut Vec<(StateId, String, Option<String>)>,
    state_id: StateId,
    value: &StateValueV1,
) {
    match value {
        StateValueV1::Task(value) => {
            note(
                fields,
                state_id,
                "state.task.title",
                Some(value.title.clone()),
            );
            note(
                fields,
                state_id,
                "state.task.description",
                value.description.clone(),
            );
            note(
                fields,
                state_id,
                "state.task.blocker",
                value.blocker.clone(),
            );
        }
        StateValueV1::Decision(value) => {
            note(
                fields,
                state_id,
                "state.decision.summary",
                Some(value.summary.clone()),
            );
            note(
                fields,
                state_id,
                "state.decision.rationale",
                Some(value.rationale.clone()),
            );
        }
        StateValueV1::Constraint(value) => {
            note(
                fields,
                state_id,
                "state.constraint.text",
                Some(value.text.clone()),
            );
            note(
                fields,
                state_id,
                "state.constraint.status_reason",
                value.status_reason.clone(),
            );
        }
        StateValueV1::Note(value) => {
            note(
                fields,
                state_id,
                "state.note.text",
                Some(value.text.clone()),
            );
            let joined = if value.tags.is_empty() {
                None
            } else {
                Some(value.tags.join("\n"))
            };
            note(fields, state_id, "state.note.tags", joined);
        }
        StateValueV1::Error(value) => {
            note(
                fields,
                state_id,
                "state.error.message",
                Some(value.message.clone()),
            );
            note(fields, state_id, "state.error.code", value.code.clone());
            note(
                fields,
                state_id,
                "state.error.command_label",
                value.command_label.clone(),
            );
            note(
                fields,
                state_id,
                "state.error.resolution",
                value.resolution.clone(),
            );
        }
    }
}

fn set_or_clear(
    fields: &mut Vec<(StateId, String, Option<String>)>,
    state_id: StateId,
    source_field: &str,
    patch: &OptionalStringPatch,
) {
    match patch {
        OptionalStringPatch::Keep => {}
        OptionalStringPatch::Set(value) => {
            note(fields, state_id, source_field, Some(value.clone()))
        }
        OptionalStringPatch::Clear => note(fields, state_id, source_field, None),
    }
}

fn note(
    fields: &mut Vec<(StateId, String, Option<String>)>,
    state_id: StateId,
    source_field: &str,
    text: Option<String>,
) {
    fields.push((state_id, source_field.to_owned(), text));
}

pub fn replay_state(log: &EventLogStore) -> Result<StateGraphV1, StateServiceError> {
    Ok(log.state_graph().clone())
}

/// Apply only events after `through` onto `checkpoint` (StateGraph §7 step 6, §14.1 step 4).
pub fn replay_state_from_checkpoint(
    log: &EventLogStore,
    checkpoint: StateGraphV1,
    through: u64,
) -> Result<StateGraphV1, StateServiceError> {
    if checkpoint.applied_through_sequence != through || through > log.current_sequence() {
        return Err(integrity());
    }
    let events = log.events_slice();
    if through > 0 && events.iter().all(|event| event.sequence != through) {
        return Err(integrity());
    }
    let mut graph = checkpoint;
    for event in events {
        if event.sequence <= through {
            continue;
        }
        project_logged_event(&mut graph, event).map_err(|_| integrity())?;
    }
    Ok(graph)
}

/// The one state consequence of a logged event. `EventReplayer` calls this
/// after its protocol checks, and checkpoint tail replay calls it directly.
pub fn project_logged_event(
    graph: &mut StateGraphV1,
    envelope: &EventEnvelope,
) -> Result<(), StateServiceError> {
    match &envelope.event {
        CanonicalEvent::StateChanged(event) => {
            super::apply::apply_state_changed(graph, envelope, event)?;
        }
        CanonicalEvent::TurnCommitted(_) => {
            graph.committed_turn_ordinal = graph.committed_turn_ordinal.saturating_add(1);
            graph.applied_through_sequence = envelope.sequence;
        }
        CanonicalEvent::ResetBoundary(boundary) if boundary.clears_state => {
            *graph = StateGraphV1 {
                schema_version: 1,
                reset_epoch: boundary.reset_epoch,
                applied_through_sequence: envelope.sequence,
                ..StateGraphV1::default()
            };
        }
        _ => graph.applied_through_sequence = envelope.sequence,
    }
    Ok(())
}

fn integrity() -> StateServiceError {
    StateServiceError::new("STATE_PROJECTION_INTEGRITY", "state projection is invalid")
}
