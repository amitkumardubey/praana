//! StateGraph V1 types, objects, values, and operations.

use serde::{Deserialize, Serialize};

use crate::protocol::id::*;
use crate::protocol::json::{deserialize_bounded_u64, deserialize_sequence, deserialize_timestamp};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum StateTier {
    Active,
    Soft,
    Hard,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ObjectLifecycle {
    Current,
    Retracted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum StateKind {
    Task,
    Decision,
    Constraint,
    Note,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum StateChangeReason {
    ExplicitTool,
    AutoHydrate,
    AutoIdleTier,
    TurnRecovery,
    System,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateSourceV1 {
    pub source_kind: StateSourceKind,
    pub event_id: EventId,
    #[serde(deserialize_with = "deserialize_sequence")]
    pub sequence: u64,
    pub turn_id: Option<TurnId>,
    pub attempt_id: Option<AttemptId>,
    pub tool_call_id: Option<ToolCallId>,
    pub artifact_id: Option<ArtifactId>,
    pub summary_segment_id: Option<SummarySegmentId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum StateSourceKind {
    UserMessage,
    AssistantStep,
    ToolResult,
    StateToolCall,
    CompactionSummary,
    Recovery,
    System,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum TaskStatus {
    Todo,
    InProgress,
    Blocked,
    Done,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskStateV1 {
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub blocker: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum DecisionStatus {
    Active,
    Superseded { by_state_id: StateId },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionStateV1 {
    pub summary: String,
    pub rationale: String,
    pub status: DecisionStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ConstraintStrength {
    Soft,
    Hard,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ConstraintStatus {
    Active,
    Satisfied,
    Waived,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConstraintStateV1 {
    pub text: String,
    pub strength: ConstraintStrength,
    pub status: ConstraintStatus,
    pub status_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteStateV1 {
    pub text: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ErrorSeverity {
    Info,
    Warning,
    Error,
    Fatal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ErrorStatus {
    Open,
    Resolved,
    Ignored,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorStateV1 {
    pub fingerprint: String,
    pub message: String,
    pub code: Option<String>,
    pub severity: ErrorSeverity,
    pub status: ErrorStatus,
    pub tool_name: Option<String>,
    pub command_label: Option<String>,
    pub resolution: Option<String>,
    pub occurrence_count: u32,
    pub last_observed_event_id: EventId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum StateValueV1 {
    Task(TaskStateV1),
    Decision(DecisionStateV1),
    Constraint(ConstraintStateV1),
    Note(NoteStateV1),
    Error(ErrorStateV1),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateObjectV1 {
    pub state_id: StateId,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub revision: u64,
    pub tier: StateTier,
    pub lifecycle: ObjectLifecycle,
    pub value: StateValueV1,
    #[serde(deserialize_with = "deserialize_timestamp")]
    pub created_at_ms: i64,
    #[serde(deserialize_with = "deserialize_sequence")]
    pub created_sequence: u64,
    #[serde(deserialize_with = "deserialize_timestamp")]
    pub updated_at_ms: i64,
    #[serde(deserialize_with = "deserialize_sequence")]
    pub updated_sequence: u64,
    #[serde(deserialize_with = "deserialize_timestamp")]
    pub last_touched_at_ms: i64,
    #[serde(deserialize_with = "deserialize_sequence")]
    pub last_touched_sequence: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub last_touched_turn_ordinal: u64,
    pub source: StateSourceV1,
    pub retracted_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FocusV1 {
    pub state_id: StateId,
    #[serde(deserialize_with = "deserialize_timestamp")]
    pub set_at_ms: i64,
    #[serde(deserialize_with = "deserialize_sequence")]
    pub set_sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct StateGraphV1 {
    pub schema_version: u32,
    pub reset_epoch: u32,
    #[serde(deserialize_with = "deserialize_sequence")]
    pub applied_through_sequence: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub committed_turn_ordinal: u64,
    pub focus: Option<FocusV1>,
    pub objects: Vec<StateObjectV1>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskPatchV1 {
    pub title: Option<String>,
    pub description: OptionalStringPatch,
    pub status: Option<TaskStatus>,
    pub blocker: OptionalStringPatch,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConstraintPatchV1 {
    pub text: Option<String>,
    pub strength: Option<ConstraintStrength>,
    pub status: Option<ConstraintStatus>,
    pub status_reason: OptionalStringPatch,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorPatchV1 {
    pub message: Option<String>,
    pub code: OptionalStringPatch,
    pub severity: Option<ErrorSeverity>,
    pub status: Option<ErrorStatus>,
    pub tool_name: OptionalStringPatch,
    pub command_label: OptionalStringPatch,
    pub resolution: OptionalStringPatch,
    pub occurrence_count: Option<u32>,
    pub last_observed_event_id: Option<EventId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "action",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum OptionalStringPatch {
    Keep,
    Set(String),
    Clear,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "action",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum FocusPatchV1 {
    Set(StateId),
    Clear,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ReopenTaskStatus {
    Todo,
    InProgress,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum StateOperationV1 {
    Create {
        state_id: StateId,
        tier: StateTier,
        value: StateValueV1,
    },
    UpdateTask {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        patch: TaskPatchV1,
        touch: bool,
    },
    ReopenTask {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        status: ReopenTaskStatus,
        touch: bool,
    },
    UpdateDecision {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        summary: Option<String>,
        rationale: Option<String>,
        touch: bool,
    },
    SupersedeDecision {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        by_state_id: StateId,
        touch: bool,
    },
    UpdateConstraint {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        patch: ConstraintPatchV1,
        touch: bool,
    },
    ReactivateConstraint {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        touch: bool,
    },
    UpdateNote {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        text: Option<String>,
        tags: Option<Vec<String>>,
        touch: bool,
    },
    UpdateError {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        patch: ErrorPatchV1,
        touch: bool,
    },
    ReopenError {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        touch: bool,
    },
    SetTier {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        tier: StateTier,
        touch: bool,
    },
    SetFocus {
        patch: FocusPatchV1,
    },
    Touch {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
    },
    Retract {
        state_id: StateId,
        #[serde(deserialize_with = "deserialize_bounded_u64")]
        expected_revision: u64,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateAutomationV1 {
    pub policy_version: String,
    pub trigger_event_id: EventId,
    pub candidate_count: u32,
    pub selected_count: u32,
    pub scores_millis: Vec<AutomationScoreV1>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutomationScoreV1 {
    pub state_id: StateId,
    pub score_millis: u32,
    pub signal: AutomationSignal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomationSignal {
    ExactIdentifier,
    Phrase,
    LexicalOverlap,
    IdleSoft,
    IdleHard,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StateChangedV1 {
    pub state_schema_version: u32,
    pub mutation_id: StateMutationId,
    #[serde(deserialize_with = "deserialize_sequence")]
    pub expected_graph_sequence: u64,
    pub reason: StateChangeReason,
    pub source: StateSourceV1,
    pub automation: Option<StateAutomationV1>,
    pub operations: Vec<StateOperationV1>,
}
