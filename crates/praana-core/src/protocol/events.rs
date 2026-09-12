//! Canonical event envelope and exact schema-2 payloads.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::protocol::compaction::{HistoricalHandoffV1, HistoryCompactedV1};
use crate::protocol::errors::ProtocolError;
use crate::protocol::id::*;
use crate::protocol::json::{deserialize_bounded_u64, deserialize_sequence, deserialize_timestamp};
use crate::protocol::messages::*;
use crate::protocol::models::*;
use crate::protocol::recovery::RecoveryNotice;
use crate::protocol::state_graph::StateChangedV1;
use crate::protocol::tool_result::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionStarted {
    pub cwd: String,
    pub agent: String,
    pub config_schema_version: u32,
    pub config_digest_sha256: Sha256Digest,
    pub history_mode: HistoryMode,
    pub projection_version: ProjectionId,
    pub compaction_policy_version: String,
    pub artifact_policy_version: String,
    pub token_estimator_schema_version: u32,
    pub unicode_utility_version: String,
    pub system_context_schema_version: u32,
    pub provider_registry_schema_version: u32,
    pub builtin_tool_catalog_schema_version: u32,
    pub redaction_version: String,
    pub ui_contract_schema_version: u32,
    pub initial_model: ModelSelection,
    pub initial_toolset_hash: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserMessageAccepted {
    pub message: UserMessage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnStarted {
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub turn_index: u64,
    pub user_message_id: MessageId,
    pub model: ModelSelection,
    pub toolset_hash: Sha256Digest,
    pub max_steps: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ProviderAttemptPurpose {
    AssistantStep(AssistantStepPurpose),
    Compaction(CompactionPurpose),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantStepPurpose {
    pub step_id: StepId,
    pub step_index: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactionPurpose {
    pub compaction_id: CompactionId,
    pub epoch: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialAssistantOutput {
    pub blocks: Vec<PartialAssistantBlock>,
    pub provider_response_id: Option<ProviderResponseId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum PartialAssistantBlock {
    Text(TextBlock),
    ReasoningSummary(ReasoningSummaryBlock),
    ToolCallFragment(PartialToolCall),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialToolCall {
    pub call_id: Option<ToolCallId>,
    pub name: Option<String>,
    pub raw_arguments: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantAttemptStarted {
    pub purpose: ProviderAttemptPurpose,
    pub attempt_number: u32,
    pub model: ModelSelection,
    pub request_hash: Sha256Digest,
    pub admission: AdmissionSnapshot,
    pub retry_of: Option<AttemptId>,
    pub emergency_context_retry: bool,
    pub recovery_notices: Vec<RecoveryNotice>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantAttemptFailed {
    pub purpose: ProviderAttemptPurpose,
    pub error: ProtocolError,
    pub partial_output: PartialAssistantOutput,
    pub observable_delta_emitted: bool,
    pub provider_may_have_completed: bool,
    pub usage: ProviderUsage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantStepAccepted {
    pub purpose: AssistantStepPurpose,
    pub message: AssistantMessage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum SupersessionReason {
    Retry,
    EmergencyContextRetry,
    ProviderFallback,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptSuperseded {
    pub purpose: ProviderAttemptPurpose,
    pub superseded_attempt_id: AttemptId,
    pub replacement_attempt_id: AttemptId,
    pub replacement_accept_event_id: EventId,
    pub reason: SupersessionReason,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolMutability {
    ReadOnly,
    Mutating,
    Outward,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolExecutionStarted {
    pub batch_id: ToolBatchId,
    pub execution_id: ToolExecutionId,
    pub step_id: StepId,
    pub call_id: ToolCallId,
    pub call_index: u32,
    pub tool_name: String,
    pub arguments_hash: Sha256Digest,
    pub mutability: ToolMutability,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolExecutionFinished {
    pub batch_id: ToolBatchId,
    pub execution_id: ToolExecutionId,
    pub step_id: StepId,
    pub call_id: ToolCallId,
    pub call_index: u32,
    pub started_event_id: Option<EventId>,
    pub result: ToolResultMessage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolBatchCompleted {
    pub batch_id: ToolBatchId,
    pub step_id: StepId,
    pub call_ids: Vec<ToolCallId>,
    pub result_event_ids: Vec<EventId>,
    pub result_messages_hash: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum TurnOutcome {
    Stop,
    Length,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnCommitted {
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub turn_index: u64,
    pub user_message_id: MessageId,
    pub terminal_step_id: StepId,
    pub accepted_step_ids: Vec<StepId>,
    pub completed_batch_ids: Vec<ToolBatchId>,
    pub outcome: TurnOutcome,
    pub accepted_messages_hash: Sha256Digest,
    pub usage: ProviderUsage,
    pub recovery_notice_ids_presented: Vec<RecoveryNoticeId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum InterruptionReason {
    UserAbort,
    ProviderFailure,
    StepLimit,
    ActiveTurnTooLarge,
    IncompatibleContinuation,
    ToolRuntimePoisoned,
    SessionShutdown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnInterrupted {
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub turn_index: u64,
    pub user_message_id: MessageId,
    pub reason: InterruptionReason,
    pub last_accepted_step_id: Option<StepId>,
    pub failed_attempt_id: Option<AttemptId>,
    pub uncertain_execution_ids: Vec<ToolExecutionId>,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InterruptedTurnCapsuleV1 {
    pub capsule_schema_version: u32,
    pub turn_id: TurnId,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub turn_index: u64,
    pub user_message_id: MessageId,
    pub accepted_step_ids: Vec<StepId>,
    pub completed_batch_ids: Vec<ToolBatchId>,
    pub reason: InterruptionReason,
    pub failed_attempt_id: Option<AttemptId>,
    pub uncertain_execution_ids: Vec<ToolExecutionId>,
    pub interruption_event_id: EventId,
    #[serde(deserialize_with = "deserialize_sequence")]
    pub source_start_sequence: u64,
    #[serde(deserialize_with = "deserialize_sequence")]
    pub source_end_sequence: u64,
    pub source_hash: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ModelChangeReason {
    UserSelection,
    ProviderFallback,
    ReasoningEffortChange,
    ConfigReload,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ContinuationDisposition {
    None,
    Retained,
    DroppedIncompatible,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelChanged {
    pub from: ModelSelection,
    pub to: ModelSelection,
    pub reason: ModelChangeReason,
    pub continuation_disposition: ContinuationDisposition,
    pub handoff: HistoricalHandoffV1,
    pub toolset_hash: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetBoundary {
    pub reset_epoch: u32,
    pub command: String,
    pub reason: Option<String>,
    pub clears_state: bool,
    pub previous_turn_id: Option<TurnId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum NoteLevel {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum NoteAudience {
    Audit,
    User,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemNote {
    pub code: String,
    pub level: NoteLevel,
    pub audience: NoteAudience,
    pub message: String,
    pub references: Vec<EventId>,
    pub details: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
// Protocol DTOs mirror the normative spec shapes; boxing variants solely for
// enum niche size would diverge from the owned owner-spec payloads.
#[allow(clippy::large_enum_variant)]
pub enum CanonicalEvent {
    SessionStarted(SessionStarted),
    UserMessageAccepted(UserMessageAccepted),
    TurnStarted(TurnStarted),
    AssistantAttemptStarted(AssistantAttemptStarted),
    AssistantAttemptFailed(AssistantAttemptFailed),
    AssistantStepAccepted(AssistantStepAccepted),
    AttemptSuperseded(AttemptSuperseded),
    ToolExecutionStarted(ToolExecutionStarted),
    ToolExecutionFinished(ToolExecutionFinished),
    ToolBatchCompleted(ToolBatchCompleted),
    TurnCommitted(TurnCommitted),
    TurnInterrupted(TurnInterrupted),
    StateChanged(StateChangedV1),
    HistoryCompacted(HistoryCompactedV1),
    ModelChanged(ModelChanged),
    ResetBoundary(ResetBoundary),
    SystemNote(SystemNote),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventEnvelope {
    pub schema_version: u32,
    pub event_id: EventId,
    pub session_id: SessionId,
    #[serde(deserialize_with = "deserialize_sequence")]
    pub sequence: u64,
    #[serde(deserialize_with = "deserialize_timestamp")]
    pub timestamp_ms: i64,
    pub turn_id: Option<TurnId>,
    pub attempt_id: Option<AttemptId>,
    pub event: CanonicalEvent,
}
