//! State tool service: normalize, validate, append, and apply (StateGraph §11, §14).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::clock::Clock;
use crate::history::db::HistoryDatabase;
use crate::history::event_log::{read_cursor_hmac_key, EventLogStore};
use crate::id::{IdGenerator, MonotonicUlidGenerator};
use crate::protocol::constants::EVENT_SCHEMA_VERSION;
use crate::protocol::events::{CanonicalEvent, EventEnvelope};
use crate::protocol::id::{AttemptId, EventId, StateId, StateMutationId, ToolCallId, TurnId};
use crate::protocol::messages::AssistantBlock;
use crate::protocol::state_graph::*;
use crate::redaction::redact_text_v1;
use crate::tools::error::{ToolError, ToolErrorCode};

use super::apply::{apply_state_changed, normalize_text, tag_matches};
use super::checkpoint::{load_checkpoint, write_checkpoint, CheckpointFault};
use super::list::{list_page, ListQuery, StateListToolOutput};
use super::replay::{replay_state, replay_state_from_checkpoint};
use super::StateServiceError;

const TITLE_MAX: usize = 256;
const SHORT_MAX: usize = 512;
const MEDIUM_MAX: usize = 1024;
const LONG_MAX: usize = 4096;
const NOTE_MAX: usize = 8192;

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateMutationObjectDto {
    pub id: StateId,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateMutationToolOutput {
    pub event_id: EventId,
    pub sequence: u64,
    pub affected: Vec<StateMutationObjectDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateObjectViewDto {
    pub id: StateId,
    pub kind: StateKind,
    pub tier: StateTier,
    pub lifecycle: ObjectLifecycle,
    pub focused: bool,
    pub revision: u64,
    pub created_sequence: u64,
    pub updated_sequence: u64,
    pub source_sequence: u64,
    pub value: StateValueV1,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateObjectToolOutput {
    pub mutation: StateMutationToolOutput,
    pub object: StateObjectViewDto,
}

pub struct StateWriteContext<'a> {
    pub log: &'a mut EventLogStore,
    pub ids: &'a MonotonicUlidGenerator,
    pub clock: &'a dyn Clock,
    pub turn_id: TurnId,
    pub attempt_id: AttemptId,
    pub call_id: ToolCallId,
    pub cancelled: bool,
    pub active_max_tokens: u64,
}

pub struct StateService {
    graph: StateGraphV1,
    db: HistoryDatabase,
    session_dir: PathBuf,
    checkpoint_due: bool,
}

impl StateService {
    pub fn open(log: &EventLogStore) -> Result<Self, StateServiceError> {
        let db = HistoryDatabase::open(&log.session_dir().join("history.db"))
            .map_err(|_| persistence())?;
        let graph = match load_checkpoint(&db, log) {
            Ok(Some(graph)) => {
                let through = graph.applied_through_sequence;
                match replay_state_from_checkpoint(log, graph, through) {
                    // §7 step 7: a hash-valid checkpoint can still disagree with
                    // the current replayer. Discard it instead of serving it.
                    Ok(graph) if graph == *log.state_graph() => graph,
                    Ok(_) | Err(_) => {
                        eprintln!("state checkpoint restore failed");
                        full_replay_checkpoint(log, &db)?
                    }
                }
            }
            Ok(None) => full_replay_checkpoint(log, &db)?,
            Err(_) => {
                eprintln!("state checkpoint restore failed");
                full_replay_checkpoint(log, &db)?
            }
        };
        Ok(Self {
            graph,
            db,
            session_dir: log.session_dir().to_path_buf(),
            checkpoint_due: false,
        })
    }

    pub fn graph(&self) -> &StateGraphV1 {
        &self.graph
    }

    pub fn checkpoint_due(&self) -> bool {
        self.checkpoint_due
    }

    pub fn persist_checkpoint(&mut self, log: &EventLogStore) {
        if !self.checkpoint_due {
            return;
        }
        if self.catch_up(log).is_err() {
            eprintln!("state checkpoint write failed");
            return;
        }
        let stamp = log
            .events_slice()
            .last()
            .map(|event| event.timestamp_ms)
            .unwrap_or(0);
        if write_checkpoint(&self.db, log, &self.graph, stamp).is_ok() {
            self.checkpoint_due = false;
        }
    }

    pub fn create_task(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        title: &str,
        description: Option<String>,
    ) -> Result<StateMutationToolOutput, ToolError> {
        let title = prepare_required(title, TITLE_MAX)?;
        let description = prepare_optional(description, LONG_MAX)?;
        let state_id = fresh_state_id(ctx)?;
        self.commit(
            ctx,
            vec![StateOperationV1::Create {
                state_id,
                tier: StateTier::Active,
                value: StateValueV1::Task(TaskStateV1 {
                    title,
                    description,
                    status: TaskStatus::Todo,
                    blocker: None,
                }),
            }],
        )
    }

    pub fn complete_task(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        id: StateId,
    ) -> Result<StateMutationToolOutput, ToolError> {
        self.catch_up(ctx.log).map_err(|e| e.to_tool_error())?;
        let object = require(&self.graph, id, Some(StateKind::Task))?;
        let StateValueV1::Task(task) = &object.value else {
            return Err(kind_error(id, object.revision));
        };
        match task.status {
            TaskStatus::Done => {
                return Err(StateServiceError::new(
                    "STATE_NO_CHANGE",
                    "state mutation has no effect",
                )
                .with_target(id, None, Some(object.revision))
                .to_tool_error());
            }
            TaskStatus::Cancelled => {
                return Err(StateServiceError::new(
                    "STATE_INVALID_TRANSITION",
                    "state transition is invalid",
                )
                .with_target(id, None, Some(object.revision))
                .to_tool_error());
            }
            _ => {}
        }
        let revision = object.revision;
        self.commit(
            ctx,
            vec![
                StateOperationV1::UpdateTask {
                    state_id: id,
                    expected_revision: revision,
                    patch: TaskPatchV1 {
                        title: None,
                        description: OptionalStringPatch::Keep,
                        status: Some(TaskStatus::Done),
                        blocker: OptionalStringPatch::Clear,
                    },
                    touch: true,
                },
                StateOperationV1::SetTier {
                    state_id: id,
                    expected_revision: revision + 1,
                    tier: StateTier::Soft,
                    touch: true,
                },
            ],
        )
    }

    pub fn retract(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        id: StateId,
        reason: &str,
    ) -> Result<StateMutationToolOutput, ToolError> {
        let reason = prepare_required(reason, MEDIUM_MAX)?;
        self.catch_up(ctx.log).map_err(|e| e.to_tool_error())?;
        let object = require(&self.graph, id, None)?;
        let revision = object.revision;
        self.commit(
            ctx,
            vec![StateOperationV1::Retract {
                state_id: id,
                expected_revision: revision,
                reason,
            }],
        )
    }

    pub fn add_constraint(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        text: &str,
        strength: ConstraintStrength,
    ) -> Result<StateMutationToolOutput, ToolError> {
        let text = prepare_required(text, LONG_MAX)?;
        let state_id = fresh_state_id(ctx)?;
        self.commit(
            ctx,
            vec![StateOperationV1::Create {
                state_id,
                tier: StateTier::Active,
                value: StateValueV1::Constraint(ConstraintStateV1 {
                    text,
                    strength,
                    status: ConstraintStatus::Active,
                    status_reason: None,
                }),
            }],
        )
    }

    pub fn decide(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        summary: &str,
        rationale: &str,
        supersedes_id: Option<StateId>,
    ) -> Result<StateMutationToolOutput, ToolError> {
        let summary = prepare_required(summary, SHORT_MAX)?;
        let rationale = prepare_required(rationale, LONG_MAX)?;
        self.catch_up(ctx.log).map_err(|e| e.to_tool_error())?;
        let superseded = if let Some(id) = supersedes_id {
            let object = require(&self.graph, id, Some(StateKind::Decision))?;
            let StateValueV1::Decision(decision) = &object.value else {
                return Err(kind_error(id, object.revision));
            };
            if !matches!(decision.status, DecisionStatus::Active) {
                return Err(StateServiceError::new(
                    "STATE_INVALID_TRANSITION",
                    "state transition is invalid",
                )
                .with_target(id, Some(object.revision), Some(object.revision))
                .to_tool_error());
            }
            Some((id, object.revision))
        } else {
            None
        };
        let state_id = fresh_state_id(ctx)?;
        let mut operations = vec![StateOperationV1::Create {
            state_id,
            tier: StateTier::Active,
            value: StateValueV1::Decision(DecisionStateV1 {
                summary,
                rationale,
                status: DecisionStatus::Active,
            }),
        }];
        if let Some((id, revision)) = superseded {
            operations.push(StateOperationV1::SupersedeDecision {
                state_id: id,
                expected_revision: revision,
                by_state_id: state_id,
                touch: true,
            });
        }
        self.commit(ctx, operations)
    }

    pub fn add_note(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        text: &str,
        tags: Vec<String>,
    ) -> Result<StateMutationToolOutput, ToolError> {
        let text = prepare_required(text, NOTE_MAX)?;
        let tags = prepare_tags(tags)?;
        let state_id = fresh_state_id(ctx)?;
        self.commit(
            ctx,
            vec![StateOperationV1::Create {
                state_id,
                tier: StateTier::Active,
                value: StateValueV1::Note(NoteStateV1 { text, tags }),
            }],
        )
    }

    pub fn set_tier(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        id: StateId,
        tier: StateTier,
    ) -> Result<StateMutationToolOutput, ToolError> {
        self.catch_up(ctx.log).map_err(|e| e.to_tool_error())?;
        let revision = require(&self.graph, id, None)?.revision;
        self.commit(
            ctx,
            vec![StateOperationV1::SetTier {
                state_id: id,
                expected_revision: revision,
                tier,
                touch: true,
            }],
        )
    }

    pub fn hydrate(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        id: StateId,
    ) -> Result<StateObjectToolOutput, ToolError> {
        let mutation = self.set_tier(ctx, id, StateTier::Active)?;
        Ok(StateObjectToolOutput {
            object: object_view(&self.graph, id),
            mutation,
        })
    }

    pub fn focus_task(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        id: StateId,
    ) -> Result<StateObjectToolOutput, ToolError> {
        self.catch_up(ctx.log).map_err(|e| e.to_tool_error())?;
        let object = require(&self.graph, id, None)?;
        let revision = object.revision;
        let operations = if object.tier == StateTier::Active {
            vec![
                StateOperationV1::Touch {
                    state_id: id,
                    expected_revision: revision,
                },
                StateOperationV1::SetFocus {
                    patch: FocusPatchV1::Set(id),
                },
            ]
        } else {
            vec![
                StateOperationV1::SetTier {
                    state_id: id,
                    expected_revision: revision,
                    tier: StateTier::Active,
                    touch: true,
                },
                StateOperationV1::SetFocus {
                    patch: FocusPatchV1::Set(id),
                },
            ]
        };
        let mutation = self.commit(ctx, operations)?;
        Ok(StateObjectToolOutput {
            object: object_view(&self.graph, id),
            mutation,
        })
    }

    pub fn list(
        &mut self,
        log: &EventLogStore,
        query: ListQuery,
        session_id: crate::protocol::id::SessionId,
        cancelled: bool,
    ) -> Result<StateListToolOutput, ToolError> {
        if cancelled {
            return Err(StateServiceError::new("STATE_CANCELLED", "cancelled").to_tool_error());
        }
        self.catch_up(log).map_err(|e| e.to_tool_error())?;
        let key = read_cursor_hmac_key(&self.session_dir).map_err(|_| {
            if query.cursor.is_some() {
                StateServiceError::new("STATE_CURSOR_STALE", "state cursor is stale")
                    .to_tool_error()
            } else {
                persistence().to_tool_error()
            }
        })?;
        list_page(&self.graph, &query, &session_id, &key).map_err(|error| error.to_tool_error())
    }

    /// Append one validated `StateChanged`. Explicit revisions are not rebased.
    pub fn commit_operations(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        operations: Vec<StateOperationV1>,
    ) -> Result<StateMutationToolOutput, ToolError> {
        self.commit(ctx, operations)
    }

    fn commit(
        &mut self,
        ctx: &mut StateWriteContext<'_>,
        operations: Vec<StateOperationV1>,
    ) -> Result<StateMutationToolOutput, ToolError> {
        self.catch_up(ctx.log).map_err(|e| e.to_tool_error())?;
        if ctx.cancelled {
            return Err(StateServiceError::new("STATE_CANCELLED", "cancelled").to_tool_error());
        }
        let expected = ctx.log.current_sequence();
        let (source_event, source_sequence) = assistant_source(ctx.log, &ctx.call_id)?;
        let mutation_id = ctx.ids.next_id::<StateMutationId>().map_err(|_| {
            ToolError::new(ToolErrorCode::ToolInternal, "state id generation failed")
        })?;
        let event_id = ctx.ids.next_id::<EventId>().map_err(|_| {
            ToolError::new(ToolErrorCode::ToolInternal, "state id generation failed")
        })?;
        let changed = StateChangedV1 {
            state_schema_version: 1,
            mutation_id,
            expected_graph_sequence: expected,
            reason: StateChangeReason::ExplicitTool,
            source: StateSourceV1 {
                source_kind: StateSourceKind::StateToolCall,
                event_id: source_event,
                sequence: source_sequence,
                turn_id: Some(ctx.turn_id),
                attempt_id: Some(ctx.attempt_id),
                tool_call_id: Some(ctx.call_id.clone()),
                artifact_id: None,
                summary_segment_id: None,
            },
            automation: None,
            operations,
        };
        let envelope = EventEnvelope {
            schema_version: EVENT_SCHEMA_VERSION,
            event_id,
            session_id: *ctx.log.session_id(),
            sequence: expected + 1,
            timestamp_ms: ctx.clock.now_ms(),
            turn_id: Some(ctx.turn_id),
            attempt_id: Some(ctx.attempt_id),
            event: CanonicalEvent::StateChanged(changed.clone()),
        };
        let before = self.graph.clone();
        let mut trial = self.graph.clone();
        apply_state_changed(&mut trial, &envelope, &changed)
            .map_err(|error| error.to_tool_error())?;

        let limit = ctx.active_max_tokens;
        let before_tail = super::render::render_state_tail(&before);
        let after_tail = super::render::render_state_tail(&trial);
        let before_tokens = super::render::estimate_tail(&before_tail)
            .map_err(|_| persistence().to_tool_error())?
            .total_tokens;
        let after_tokens = super::render::estimate_tail(&after_tail)
            .map_err(|_| persistence().to_tool_error())?
            .total_tokens;
        if after_tokens > limit && after_tokens > before_tokens {
            let (largest_id, largest_tokens) = super::render::largest_object_line(&trial)
                .unwrap_or_else(|| {
                    (
                        StateId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
                        0,
                    )
                });
            let message = format!(
                "state tail {after_tokens} tokens exceeds limit {limit}; largest object {largest_id} {largest_tokens} tokens"
            );
            return Err(StateServiceError {
                state_code: "STATE_ACTIVE_BUDGET_EXCEEDED".to_owned(),
                message,
                state_id: Some(largest_id),
                expected_revision: None,
                actual_revision: None,
            }
            .to_tool_error());
        }

        if ctx.cancelled {
            return Err(StateServiceError::new("STATE_CANCELLED", "cancelled").to_tool_error());
        }
        if ctx.log.current_sequence() != expected {
            return Err(StateServiceError::new(
                "STATE_GRAPH_SEQUENCE_CONFLICT",
                "state graph sequence conflict",
            )
            .to_tool_error());
        }
        ctx.log
            .append_event(&envelope)
            .map_err(|error| match error.code() {
                "E_EVENT_DURABILITY_UNCERTAIN" => persistence().to_tool_error(),
                _ => StateServiceError::new(
                    "STATE_PROJECTION_INTEGRITY",
                    "state projection is invalid",
                )
                .to_tool_error(),
            })?;
        #[cfg(feature = "failpoints")]
        crate::crash_point::hit("state.after_state_changed_before_finish");
        self.graph = trial;
        self.checkpoint_due = true;
        Ok(StateMutationToolOutput {
            event_id,
            sequence: envelope.sequence,
            affected: affected(&before, &self.graph),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn commit_origin(
        &mut self,
        log: &mut EventLogStore,
        ids: &MonotonicUlidGenerator,
        clock: &dyn Clock,
        cancelled: &dyn Fn() -> bool, // live; never a snapshot
        active_max_tokens: u64,
        reason: StateChangeReason,
        source: StateSourceV1,
        automation: Option<StateAutomationV1>,
        operations: Vec<StateOperationV1>,
    ) -> Result<StateMutationToolOutput, StateServiceError> {
        self.catch_up(log)?;
        if cancelled() {
            return Err(StateServiceError::new("STATE_CANCELLED", "cancelled"));
        }
        #[cfg(feature = "failpoints")]
        if let Some(code) = INJECT_COMMIT_ORIGIN_ERROR.with(|flag| flag.take()) {
            return Err(StateServiceError::new(code, "injected commit origin error"));
        }
        let expected = log.current_sequence();
        let mutation_id = ids
            .next_id::<StateMutationId>()
            .map_err(|_| persistence())?;
        let event_id = ids.next_id::<EventId>().map_err(|_| persistence())?;
        let changed = StateChangedV1 {
            state_schema_version: 1,
            mutation_id,
            expected_graph_sequence: expected,
            reason,
            source,
            automation,
            operations,
        };
        let envelope = EventEnvelope {
            schema_version: EVENT_SCHEMA_VERSION,
            event_id,
            session_id: *log.session_id(),
            sequence: expected + 1,
            timestamp_ms: clock.now_ms(),
            turn_id: None,
            attempt_id: None,
            event: CanonicalEvent::StateChanged(changed.clone()),
        };
        let before = self.graph.clone();
        let mut trial = self.graph.clone();
        apply_state_changed(&mut trial, &envelope, &changed)?;

        let limit = active_max_tokens;
        let before_tail = super::render::render_state_tail(&before);
        let after_tail = super::render::render_state_tail(&trial);
        let before_tokens = super::render::estimate_tail(&before_tail)
            .map_err(|_| {
                StateServiceError::new(
                    "STATE_PROJECTION_INTEGRITY",
                    "failed to estimate before tail",
                )
            })?
            .total_tokens;
        let after_tokens = super::render::estimate_tail(&after_tail)
            .map_err(|_| {
                StateServiceError::new(
                    "STATE_PROJECTION_INTEGRITY",
                    "failed to estimate after tail",
                )
            })?
            .total_tokens;
        if after_tokens > limit && after_tokens > before_tokens {
            let (largest_id, largest_tokens) = super::render::largest_object_line(&trial)
                .unwrap_or_else(|| {
                    (
                        StateId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
                        0,
                    )
                });
            let message = format!(
                "state tail {after_tokens} tokens exceeds limit {limit}; largest object {largest_id} {largest_tokens} tokens"
            );
            return Err(StateServiceError {
                state_code: "STATE_ACTIVE_BUDGET_EXCEEDED".to_owned(),
                message,
                state_id: Some(largest_id),
                expected_revision: None,
                actual_revision: None,
            });
        }

        if cancelled() {
            return Err(StateServiceError::new("STATE_CANCELLED", "cancelled"));
        }
        if log.current_sequence() != expected {
            return Err(StateServiceError::new(
                "STATE_GRAPH_SEQUENCE_CONFLICT",
                "state graph sequence conflict",
            ));
        }
        if cancelled() {
            return Err(StateServiceError::new("STATE_CANCELLED", "cancelled"));
        }
        log.append_event(&envelope)
            .map_err(|error| match error.code() {
                "E_EVENT_DURABILITY_UNCERTAIN" => persistence(),
                _ => StateServiceError::new(
                    "STATE_PROJECTION_INTEGRITY",
                    "state projection is invalid",
                ),
            })?;
        self.graph = trial;
        self.checkpoint_due = true;
        Ok(StateMutationToolOutput {
            event_id,
            sequence: envelope.sequence,
            affected: affected(&before, &self.graph),
        })
    }

    pub fn catch_up(&mut self, log: &EventLogStore) -> Result<(), StateServiceError> {
        let through = self.graph.applied_through_sequence;
        let head = log.current_sequence();
        if through == head {
            return Ok(());
        }
        if through > head {
            return Err(StateServiceError::new(
                "STATE_PROJECTION_INTEGRITY",
                "state projection is invalid",
            ));
        }
        // The replayer is already current. Copying it avoids cloning the log.
        self.graph = log.state_graph().clone();
        Ok(())
    }
}

fn full_replay_checkpoint(
    log: &EventLogStore,
    db: &HistoryDatabase,
) -> Result<StateGraphV1, StateServiceError> {
    let graph = replay_state(log)?;
    let stamp = log
        .events_slice()
        .last()
        .map(|event| event.timestamp_ms)
        .unwrap_or(0);
    let _ = write_checkpoint(db, log, &graph, stamp);
    Ok(graph)
}

fn fresh_state_id(ctx: &StateWriteContext<'_>) -> Result<StateId, ToolError> {
    ctx.ids
        .next_id::<StateId>()
        .map_err(|_| ToolError::new(ToolErrorCode::ToolInternal, "state id generation failed"))
}

fn require(
    graph: &StateGraphV1,
    id: StateId,
    kind: Option<StateKind>,
) -> Result<&StateObjectV1, ToolError> {
    let Some(object) = graph.objects.iter().find(|object| object.state_id == id) else {
        return Err(
            StateServiceError::new("STATE_NOT_FOUND", "state object was not found")
                .with_target(id, None, None)
                .to_tool_error(),
        );
    };
    if object.lifecycle != ObjectLifecycle::Current {
        return Err(
            StateServiceError::new("STATE_RETRACTED", "state object is retracted")
                .with_target(id, None, Some(object.revision))
                .to_tool_error(),
        );
    }
    if let Some(kind) = kind {
        if value_kind(&object.value) != kind {
            return Err(kind_error(id, object.revision));
        }
    }
    Ok(object)
}

fn kind_error(id: StateId, revision: u64) -> ToolError {
    StateServiceError::new("STATE_KIND_MISMATCH", "state kind does not match")
        .with_target(id, Some(revision), Some(revision))
        .to_tool_error()
}

fn assistant_source(
    log: &EventLogStore,
    call_id: &ToolCallId,
) -> Result<(EventId, u64), ToolError> {
    for event in log.events_slice().iter().rev() {
        let CanonicalEvent::AssistantStepAccepted(step) = &event.event else {
            continue;
        };
        let found = step.message.blocks.iter().any(
            |block| matches!(block, AssistantBlock::ToolCall(call) if call.call_id == *call_id),
        );
        if found {
            return Ok((event.event_id, event.sequence));
        }
    }
    Err(StateServiceError::new("STATE_INVALID_SOURCE", "state source is invalid").to_tool_error())
}

fn affected(before: &StateGraphV1, after: &StateGraphV1) -> Vec<StateMutationObjectDto> {
    let mut rows: Vec<StateMutationObjectDto> = after
        .objects
        .iter()
        .filter(|object| {
            before
                .objects
                .iter()
                .find(|prior| prior.state_id == object.state_id)
                .map(|prior| prior.revision != object.revision)
                .unwrap_or(true)
        })
        .map(|object| StateMutationObjectDto {
            id: object.state_id,
            revision: object.revision,
        })
        .collect();
    rows.sort_by_key(|row| row.id);
    rows
}

fn object_view(graph: &StateGraphV1, id: StateId) -> StateObjectViewDto {
    let object = graph
        .objects
        .iter()
        .find(|object| object.state_id == id)
        .expect("committed object");
    StateObjectViewDto {
        id,
        kind: value_kind(&object.value),
        tier: object.tier.clone(),
        lifecycle: object.lifecycle.clone(),
        focused: graph
            .focus
            .as_ref()
            .is_some_and(|focus| focus.state_id == id),
        revision: object.revision,
        created_sequence: object.created_sequence,
        updated_sequence: object.updated_sequence,
        source_sequence: object.source.sequence,
        value: object.value.clone(),
    }
}

fn value_kind(value: &StateValueV1) -> StateKind {
    match value {
        StateValueV1::Task(_) => StateKind::Task,
        StateValueV1::Decision(_) => StateKind::Decision,
        StateValueV1::Constraint(_) => StateKind::Constraint,
        StateValueV1::Note(_) => StateKind::Note,
        StateValueV1::Error(_) => StateKind::Error,
    }
}

fn prepare_required(text: &str, max: usize) -> Result<String, ToolError> {
    let redacted = redact_state_text(text)?;
    let normalized = normalize_text(&redacted.text);
    if normalized.is_empty() || normalized.len() > max {
        return Err(
            StateServiceError::new("STATE_FIELD_LIMIT", "state field limit").to_tool_error(),
        );
    }
    Ok(normalized)
}

fn prepare_optional(text: Option<String>, max: usize) -> Result<Option<String>, ToolError> {
    let Some(text) = text else {
        return Ok(None);
    };
    let redacted = redact_state_text(&text)?;
    let normalized = normalize_text(&redacted.text);
    if normalized.is_empty() {
        return Ok(None);
    }
    if normalized.len() > max {
        return Err(
            StateServiceError::new("STATE_FIELD_LIMIT", "state field limit").to_tool_error(),
        );
    }
    Ok(Some(normalized))
}

fn prepare_tags(mut tags: Vec<String>) -> Result<Vec<String>, ToolError> {
    tags.sort();
    tags.dedup();
    if tags.len() > 16 {
        return Err(
            StateServiceError::new("STATE_FIELD_LIMIT", "state field limit").to_tool_error(),
        );
    }
    for tag in &tags {
        // §4.7 redacts before the pattern check. A pattern-valid tag that
        // redaction would change (the `sk-…` canary) fails the inequality.
        // Redacted text also fails `tag_matches`, so a secret that is not a
        // valid tag is still `STATE_FIELD_LIMIT`.
        let redacted = redact_state_text(tag)?;
        if redacted.text != *tag || !tag_matches(tag) {
            return Err(
                StateServiceError::new("STATE_FIELD_LIMIT", "state field limit").to_tool_error(),
            );
        }
    }
    Ok(tags)
}

fn redact_state_text(text: &str) -> Result<crate::redaction::RedactedText, ToolError> {
    #[cfg(feature = "failpoints")]
    if FAIL_NEXT_REDACTION.with(|flag| flag.replace(false)) {
        return Err(redaction_error());
    }
    redact_text_v1(text).map_err(|_| redaction_error())
}

fn redaction_error() -> ToolError {
    ToolError::new(ToolErrorCode::ToolRedactionFailed, "redaction failed")
}

#[cfg(feature = "failpoints")]
thread_local! {
    static FAIL_NEXT_REDACTION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Test-only: the next state-text redaction fails with `TOOL_REDACTION_FAILED`.
#[cfg(feature = "failpoints")]
pub fn fail_next_state_redaction() {
    FAIL_NEXT_REDACTION.with(|flag| flag.set(true));
}

#[cfg(feature = "failpoints")]
thread_local! {
    static INJECT_COMMIT_ORIGIN_ERROR: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
}

/// Test-only: force the next `commit_origin` to fail with the specified state code.
#[cfg(feature = "failpoints")]
pub fn inject_commit_origin_error(code: &'static str) {
    INJECT_COMMIT_ORIGIN_ERROR.with(|flag| flag.set(Some(code)));
}

/// Test-only: reset any pending commit_origin error injection.
#[cfg(feature = "failpoints")]
pub fn reset_commit_origin_injection() {
    INJECT_COMMIT_ORIGIN_ERROR.with(|flag| flag.set(None));
}

fn persistence() -> StateServiceError {
    StateServiceError::new("STATE_PERSISTENCE", "state persistence failed")
}

impl From<CheckpointFault> for StateServiceError {
    fn from(fault: CheckpointFault) -> Self {
        let _ = fault;
        StateServiceError::new("STATE_PROJECTION_INTEGRITY", "state projection is invalid")
    }
}
