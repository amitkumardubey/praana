//! Exact UI event model: envelope, durability, payloads, priority,
//! sensitivity, coalescing, and validation.
//!
//! One serialized core dispatcher establishes semantic emission order. The
//! in-process channel's receive order is authoritative. Ephemeral deltas are
//! never accepted authority: `AssistantAccepted` reconciles provisional
//! blocks.

use serde::{Deserialize, Serialize};

use crate::protocol::id::{
    AttemptId, EventId, MessageId, SessionId, StepId, ToolBatchId, ToolExecutionId, TurnId,
};
use crate::ui_contract::catalog::{ActiveModelDto, ReasoningStateDto};
use crate::ui_contract::ids::{AssistantBlockId, AuthFlowId, ConfirmationId, OperationId};
use crate::ui_contract::json_data::{JsonData, ModelId, ProviderId, Sha256Digest, ToolName};
use crate::ui_contract::result::{
    ContextStatusDto, CoreErrorDto, SystemNoticeDto, TurnFooterDto, UsageDto,
};
use crate::ui_contract::transcript::TextContentDto;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UiEventRecord {
    pub ui_contract_schema_version: u32,
    pub session_id: Option<SessionId>,
    pub turn_id: Option<TurnId>,
    pub attempt_id: Option<AttemptId>,
    pub operation_id: Option<OperationId>,
    pub durability: UiDurabilityRef,
    pub event: UiEvent,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum UiDurabilityRef {
    Ephemeral,
    CanonicalEvent {
        event_id: EventId,
        canonical_sequence: u64,
    },
    CanonicalSnapshot {
        canonical_through_sequence: u64,
    },
    SettingsRevision {
        revision: u64,
        sha256: Sha256Digest,
    },
    CredentialRevision {
        revision: u64,
    },
    HostRevision {
        kind: HostRevisionKind,
        revision: u64,
        sha256: Sha256Digest,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostRevisionKind {
    SetupConfig,
    Consent,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum UiEvent {
    RuntimeReady(RuntimeReadyDto),
    RuntimeStopping(RuntimeStoppingDto),
    RuntimeStopped(RuntimeStoppedDto),
    RuntimeBackpressure(BackpressureDto),
    SystemNotice(SystemNoticeDto),
    SystemError(CoreErrorDto),
    SessionOpened(crate::ui_contract::result::SessionOpenResultDto),
    SessionStatus(SessionStatusDto),
    SessionCleared(crate::ui_contract::result::SessionClearedResultDto),
    SessionEnded(crate::ui_contract::result::SessionEpilogueDto),
    ModelChanged(ActiveModelDto),
    ReasoningChanged(ReasoningStateDto),
    SettingsChanged(crate::ui_contract::settings::EffectiveSettingsDto),
    ContextUpdated(ContextStatusDto),
    TurnStarted(TurnStartedDto),
    AttemptStarted(AttemptStartedDto),
    AssistantDelta(AssistantDeltaDto),
    AttemptRewind(AttemptRewindDto),
    AssistantAccepted(AssistantAcceptedDto),
    AttemptSuperseded(AttemptSupersededDto),
    UsageUpdated(UsageUpdatedDto),
    TurnCompleted(TurnCompletedDto),
    TurnInterrupted(TurnInterruptedDto),
    ToolBatchStarted(ToolBatchStartedDto),
    ToolCallPending(ToolCallPendingDto),
    RiskConfirmationRequested(RiskConfirmationDto),
    RiskConfirmationResolved(RiskConfirmationResolvedDto),
    ToolCallStarted(ToolCallStartedDto),
    ToolCallProgress(ToolCallProgressDto),
    ToolCallFinished(ToolCallFinishedDto),
    ToolBatchFinished(ToolBatchFinishedDto),
    SetupChanged(crate::ui_contract::setup::SetupStatusDto),
    AuthFlowUpdated(crate::ui_contract::setup::AuthFlowDto),
    AuthChanged(AuthChangedDto),
    ConsentRequested(crate::ui_contract::setup::ConsentRequestDto),
    ConsentResolved(crate::ui_contract::setup::ConsentResolvedResultDto),
}

impl UiEvent {
    pub fn kind_name(&self) -> &'static str {
        match self {
            UiEvent::RuntimeReady(_) => "UiEvent::RuntimeReady",
            UiEvent::RuntimeStopping(_) => "UiEvent::RuntimeStopping",
            UiEvent::RuntimeStopped(_) => "UiEvent::RuntimeStopped",
            UiEvent::RuntimeBackpressure(_) => "UiEvent::RuntimeBackpressure",
            UiEvent::SystemNotice(_) => "UiEvent::SystemNotice",
            UiEvent::SystemError(_) => "UiEvent::SystemError",
            UiEvent::SessionOpened(_) => "UiEvent::SessionOpened",
            UiEvent::SessionStatus(_) => "UiEvent::SessionStatus",
            UiEvent::SessionCleared(_) => "UiEvent::SessionCleared",
            UiEvent::SessionEnded(_) => "UiEvent::SessionEnded",
            UiEvent::ModelChanged(_) => "UiEvent::ModelChanged",
            UiEvent::ReasoningChanged(_) => "UiEvent::ReasoningChanged",
            UiEvent::SettingsChanged(_) => "UiEvent::SettingsChanged",
            UiEvent::ContextUpdated(_) => "UiEvent::ContextUpdated",
            UiEvent::TurnStarted(_) => "UiEvent::TurnStarted",
            UiEvent::AttemptStarted(_) => "UiEvent::AttemptStarted",
            UiEvent::AssistantDelta(_) => "UiEvent::AssistantDelta",
            UiEvent::AttemptRewind(_) => "UiEvent::AttemptRewind",
            UiEvent::AssistantAccepted(_) => "UiEvent::AssistantAccepted",
            UiEvent::AttemptSuperseded(_) => "UiEvent::AttemptSuperseded",
            UiEvent::UsageUpdated(_) => "UiEvent::UsageUpdated",
            UiEvent::TurnCompleted(_) => "UiEvent::TurnCompleted",
            UiEvent::TurnInterrupted(_) => "UiEvent::TurnInterrupted",
            UiEvent::ToolBatchStarted(_) => "UiEvent::ToolBatchStarted",
            UiEvent::ToolCallPending(_) => "UiEvent::ToolCallPending",
            UiEvent::RiskConfirmationRequested(_) => "UiEvent::RiskConfirmationRequested",
            UiEvent::RiskConfirmationResolved(_) => "UiEvent::RiskConfirmationResolved",
            UiEvent::ToolCallStarted(_) => "UiEvent::ToolCallStarted",
            UiEvent::ToolCallProgress(_) => "UiEvent::ToolCallProgress",
            UiEvent::ToolCallFinished(_) => "UiEvent::ToolCallFinished",
            UiEvent::ToolBatchFinished(_) => "UiEvent::ToolBatchFinished",
            UiEvent::SetupChanged(_) => "UiEvent::SetupChanged",
            UiEvent::AuthFlowUpdated(_) => "UiEvent::AuthFlowUpdated",
            UiEvent::AuthChanged(_) => "UiEvent::AuthChanged",
            UiEvent::ConsentRequested(_) => "UiEvent::ConsentRequested",
            UiEvent::ConsentResolved(_) => "UiEvent::ConsentResolved",
        }
    }
}

pub const ALL_EVENT_KINDS: &[&str] = &[
    "UiEvent::RuntimeReady",
    "UiEvent::RuntimeStopping",
    "UiEvent::RuntimeStopped",
    "UiEvent::RuntimeBackpressure",
    "UiEvent::SystemNotice",
    "UiEvent::SystemError",
    "UiEvent::SessionOpened",
    "UiEvent::SessionStatus",
    "UiEvent::SessionCleared",
    "UiEvent::SessionEnded",
    "UiEvent::ModelChanged",
    "UiEvent::ReasoningChanged",
    "UiEvent::SettingsChanged",
    "UiEvent::ContextUpdated",
    "UiEvent::TurnStarted",
    "UiEvent::AttemptStarted",
    "UiEvent::AssistantDelta",
    "UiEvent::AttemptRewind",
    "UiEvent::AssistantAccepted",
    "UiEvent::AttemptSuperseded",
    "UiEvent::UsageUpdated",
    "UiEvent::TurnCompleted",
    "UiEvent::TurnInterrupted",
    "UiEvent::ToolBatchStarted",
    "UiEvent::ToolCallPending",
    "UiEvent::RiskConfirmationRequested",
    "UiEvent::RiskConfirmationResolved",
    "UiEvent::ToolCallStarted",
    "UiEvent::ToolCallProgress",
    "UiEvent::ToolCallFinished",
    "UiEvent::ToolBatchFinished",
    "UiEvent::SetupChanged",
    "UiEvent::AuthFlowUpdated",
    "UiEvent::AuthChanged",
    "UiEvent::ConsentRequested",
    "UiEvent::ConsentResolved",
];

pub fn event_wire_name(event: &UiEvent) -> &'static str {
    match event {
        UiEvent::RuntimeReady(_) => "runtime.ready",
        UiEvent::RuntimeStopping(_) => "runtime.stopping",
        UiEvent::RuntimeStopped(_) => "runtime.stopped",
        UiEvent::RuntimeBackpressure(_) => "runtime.backpressure",
        UiEvent::SystemNotice(_) => "system.notice",
        UiEvent::SystemError(_) => "system.error",
        UiEvent::SessionOpened(_) => "session.opened",
        UiEvent::SessionStatus(_) => "session.status",
        UiEvent::SessionCleared(_) => "session.cleared",
        UiEvent::SessionEnded(_) => "session.ended",
        UiEvent::ModelChanged(_) => "model.changed",
        UiEvent::ReasoningChanged(_) => "reasoning.changed",
        UiEvent::SettingsChanged(_) => "settings.changed",
        UiEvent::ContextUpdated(_) => "context.updated",
        UiEvent::TurnStarted(_) => "turn.started",
        UiEvent::AttemptStarted(_) => "attempt.started",
        UiEvent::AssistantDelta(_) => "assistant.delta",
        UiEvent::AttemptRewind(_) => "attempt.rewind",
        UiEvent::AssistantAccepted(_) => "assistant.accepted",
        UiEvent::AttemptSuperseded(_) => "attempt.superseded",
        UiEvent::UsageUpdated(_) => "usage.updated",
        UiEvent::TurnCompleted(_) => "turn.completed",
        UiEvent::TurnInterrupted(_) => "turn.interrupted",
        UiEvent::ToolBatchStarted(_) => "tool.batch_started",
        UiEvent::ToolCallPending(_) => "tool.call_pending",
        UiEvent::RiskConfirmationRequested(_) => "risk.confirmation_requested",
        UiEvent::RiskConfirmationResolved(_) => "risk.confirmation_resolved",
        UiEvent::ToolCallStarted(_) => "tool.call_started",
        UiEvent::ToolCallProgress(_) => "tool.call_progress",
        UiEvent::ToolCallFinished(_) => "tool.call_finished",
        UiEvent::ToolBatchFinished(_) => "tool.batch_finished",
        UiEvent::SetupChanged(_) => "setup.changed",
        UiEvent::AuthFlowUpdated(_) => "auth.flow_updated",
        UiEvent::AuthChanged(_) => "auth.changed",
        UiEvent::ConsentRequested(_) => "consent.requested",
        UiEvent::ConsentResolved(_) => "consent.resolved",
    }
}

// Event payloads.

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeReadyDto {
    pub core_version: String,
    pub ui_contract_schema_version: u32,
    pub event_schema_version: u32,
    pub history_schema_version: u32,
    pub config_schema_version: u32,
    pub system_context_schema_version: u32,
    pub provider_registry_schema_version: u32,
    pub builtin_tool_catalog_schema_version: u32,
    pub redaction_version: String,
    pub features: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeStoppingDto {
    pub reason: crate::ui_contract::command::ShutdownReason,
    pub deadline_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeStoppedDto {
    pub clean: bool,
    pub exit_code: i32,
    pub final_canonical_sequence: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BackpressureDto {
    pub coalesced: u64,
    pub dropped_ephemeral: u64,
    pub blocked_ms: u64,
    pub queue_events: u32,
    pub queue_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionStatusDto {
    pub boot: crate::ui_contract::result::BootStatusDto,
    pub active_model: ActiveModelDto,
    pub reasoning: ReasoningStateDto,
    pub turn_active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnStartedDto {
    pub turn_id: TurnId,
    pub user_message_id: MessageId,
    pub user_text: TextContentDto,
    pub turn_index: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttemptStartedDto {
    pub attempt_id: AttemptId,
    pub attempt_number: u32,
    pub provider: ProviderId,
    pub model_id: ModelId,
    pub retry_of: Option<AttemptId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantVisibleBlockKind {
    Text,
    ReasoningSummary,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AssistantDeltaDto {
    pub block_id: AssistantBlockId,
    pub block_kind: AssistantVisibleBlockKind,
    pub first_chunk_index: u64,
    pub last_chunk_index: u64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RewindReason {
    Cancelled,
    Failed,
    Reconciliation,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttemptRewindDto {
    pub attempt_id: AttemptId,
    pub reason: RewindReason,
    pub discard_block_ids: Vec<AssistantBlockId>,
    pub replacement_attempt_id: Option<AttemptId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AcceptedAssistantBlockDto {
    pub block_id: AssistantBlockId,
    pub kind: AssistantVisibleBlockKind,
    pub content: TextContentDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AcceptedToolCallDto {
    pub call_id: crate::ui_contract::json_data::ToolCallId,
    pub tool_name: ToolName,
    pub call_index: u32,
    pub redacted_label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AssistantAcceptedDto {
    pub step_id: StepId,
    pub attempt_id: AttemptId,
    pub blocks: Vec<AcceptedAssistantBlockDto>,
    pub tool_calls: Vec<AcceptedToolCallDto>,
    pub finish_reason: AssistantFinishReasonDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantFinishReasonDto {
    Stop,
    Length,
    ToolCalls,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SupersessionReasonDto {
    Retry,
    EmergencyContextRetry,
    ProviderFallback,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttemptSupersededDto {
    pub old_attempt_id: AttemptId,
    pub replacement_attempt_id: AttemptId,
    pub reason: SupersessionReasonDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UsageUpdatedDto {
    pub attempt_id: AttemptId,
    pub cumulative: UsageDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnCompletedDto {
    pub footer: TurnFooterDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnInterruptedDto {
    pub turn_id: TurnId,
    pub reason: TurnInterruptionReasonDto,
    pub message: String,
    pub uncertain_execution_ids: Vec<ToolExecutionId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnInterruptionReasonDto {
    UserAbort,
    ProviderFailure,
    StepLimit,
    ActiveTurnTooLarge,
    IncompatibleContinuation,
    ToolRuntimePoisoned,
    SessionShutdown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolBatchStartedDto {
    pub batch_id: ToolBatchId,
    pub step_id: StepId,
    pub call_ids: Vec<crate::ui_contract::json_data::ToolCallId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolCallPendingDto {
    pub batch_id: ToolBatchId,
    pub call_id: crate::ui_contract::json_data::ToolCallId,
    pub call_index: u32,
    pub tool_name: ToolName,
    pub label: String,
    pub redacted_arguments: JsonData,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RiskConfirmationDto {
    pub confirmation_id: ConfirmationId,
    pub call_id: crate::ui_contract::json_data::ToolCallId,
    pub tool_name: ToolName,
    pub risk_class: RiskClassDto,
    pub title: String,
    pub detail: String,
    pub redacted_arguments: JsonData,
    pub argument_sha256: Sha256Digest,
    pub choices: Vec<crate::ui_contract::command::RiskDecision>,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiskClassDto {
    Rm,
    GitReset,
    GitForcePush,
    GitClean,
    GhIssueClose,
    GhPrMerge,
    PackageInstall,
    WriteOutsideCwd,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RiskConfirmationResolvedDto {
    pub confirmation_id: ConfirmationId,
    pub decision: crate::ui_contract::command::RiskDecision,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolCallStartedDto {
    pub batch_id: ToolBatchId,
    pub execution_id: ToolExecutionId,
    pub call_id: crate::ui_contract::json_data::ToolCallId,
    pub tool_name: ToolName,
    pub started_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolProgressPhase {
    Waiting,
    Running,
    PostProcessing,
    Persisting,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolCallProgressDto {
    pub execution_id: ToolExecutionId,
    pub phase: ToolProgressPhase,
    pub elapsed_ms: u64,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolCallFinishedDto {
    pub batch_id: ToolBatchId,
    pub execution_id: ToolExecutionId,
    pub call_id: crate::ui_contract::json_data::ToolCallId,
    pub tool_name: ToolName,
    pub status: crate::ui_contract::transcript::ToolDisplayStatus,
    pub summary: String,
    pub duration_ms: u64,
    pub error: Option<CoreErrorDto>,
    pub content_ref: Option<crate::ui_contract::transcript::ContentRefDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolBatchFinishedDto {
    pub batch_id: ToolBatchId,
    pub result_execution_ids: Vec<ToolExecutionId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthChangedDto {
    pub provider: ProviderId,
    pub state: crate::ui_contract::setup::AuthState,
    pub active_model: Option<ActiveModelDto>,
}

// Priority, coalescing, sensitivity, durability mapping.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiEventPriority {
    Critical,
    LatestOnly,
    Appendable,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum UiCoalesceKey {
    RuntimeBackpressure,
    SessionStatus(SessionId),
    Settings,
    Context(SessionId),
    AssistantBlock(AttemptId, AssistantBlockId),
    AttemptUsage(AttemptId),
    ToolProgress(ToolExecutionId),
    AuthFlow(AuthFlowId),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiSensitivity {
    Public,
    LocalMetadata,
    Redacted,
    SecretInput,
}

/// Durability requirement from the section 7 table. Conditional rows name both
/// outcomes explicitly.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiDurabilityRequirement {
    Ephemeral,
    CanonicalEvent,
    CanonicalSnapshot,
    SettingsRevision,
    CredentialRevision,
    HostSetupConfig,
    HostConsent,
    SnapshotOrEphemeral,
    SourceOrEphemeral,
    CanonicalOrEphemeral,
    HostConsentOrEphemeral,
}

pub fn priority(event: &UiEvent) -> UiEventPriority {
    use UiEvent as E;
    match event {
        E::RuntimeReady(_)
        | E::RuntimeStopping(_)
        | E::RuntimeStopped(_)
        | E::SystemNotice(_)
        | E::SystemError(_)
        | E::SessionOpened(_)
        | E::SessionCleared(_)
        | E::SessionEnded(_)
        | E::ModelChanged(_)
        | E::ReasoningChanged(_)
        | E::TurnStarted(_)
        | E::AttemptStarted(_)
        | E::AttemptRewind(_)
        | E::AssistantAccepted(_)
        | E::AttemptSuperseded(_)
        | E::TurnCompleted(_)
        | E::TurnInterrupted(_)
        | E::ToolBatchStarted(_)
        | E::ToolCallPending(_)
        | E::RiskConfirmationRequested(_)
        | E::RiskConfirmationResolved(_)
        | E::ToolCallStarted(_)
        | E::ToolCallFinished(_)
        | E::ToolBatchFinished(_)
        | E::SetupChanged(_)
        | E::AuthChanged(_)
        | E::ConsentRequested(_)
        | E::ConsentResolved(_) => UiEventPriority::Critical,
        E::RuntimeBackpressure(_)
        | E::SessionStatus(_)
        | E::SettingsChanged(_)
        | E::ContextUpdated(_)
        | E::UsageUpdated(_)
        | E::ToolCallProgress(_)
        | E::AuthFlowUpdated(_) => UiEventPriority::LatestOnly,
        E::AssistantDelta(_) => UiEventPriority::Appendable,
    }
}

pub fn coalesce_key(event: &UiEventRecord) -> Option<UiCoalesceKey> {
    match &event.event {
        UiEvent::RuntimeBackpressure(_) => Some(UiCoalesceKey::RuntimeBackpressure),
        UiEvent::SessionStatus(_) => event.session_id.map(UiCoalesceKey::SessionStatus),
        UiEvent::SettingsChanged(_) => Some(UiCoalesceKey::Settings),
        UiEvent::ContextUpdated(_) => event.session_id.map(UiCoalesceKey::Context),
        UiEvent::AssistantDelta(delta) => event
            .attempt_id
            .map(|attempt| UiCoalesceKey::AssistantBlock(attempt, delta.block_id)),
        UiEvent::UsageUpdated(usage) => Some(UiCoalesceKey::AttemptUsage(usage.attempt_id)),
        UiEvent::ToolCallProgress(progress) => {
            Some(UiCoalesceKey::ToolProgress(progress.execution_id))
        }
        UiEvent::AuthFlowUpdated(flow) => Some(UiCoalesceKey::AuthFlow(flow.flow_id)),
        _ => None,
    }
}

pub fn sensitivity(event: &UiEvent) -> UiSensitivity {
    use UiEvent as E;
    match event {
        E::RuntimeReady(_)
        | E::RuntimeStopping(_)
        | E::RuntimeStopped(_)
        | E::RuntimeBackpressure(_)
        | E::SessionCleared(_)
        | E::ModelChanged(_)
        | E::ReasoningChanged(_)
        | E::SettingsChanged(_)
        | E::ContextUpdated(_)
        | E::AttemptStarted(_)
        | E::AttemptRewind(_)
        | E::AttemptSuperseded(_)
        | E::UsageUpdated(_)
        | E::TurnCompleted(_)
        | E::ToolBatchStarted(_)
        | E::RiskConfirmationResolved(_)
        | E::ToolCallStarted(_)
        | E::ToolCallProgress(_)
        | E::ToolBatchFinished(_)
        | E::ConsentResolved(_) => UiSensitivity::Public,
        E::SessionOpened(_)
        | E::SessionStatus(_)
        | E::SessionEnded(_)
        | E::SetupChanged(_)
        | E::AuthFlowUpdated(_)
        | E::AuthChanged(_)
        | E::ConsentRequested(_) => UiSensitivity::LocalMetadata,
        E::SystemNotice(_)
        | E::SystemError(_)
        | E::TurnStarted(_)
        | E::AssistantDelta(_)
        | E::AssistantAccepted(_)
        | E::TurnInterrupted(_)
        | E::ToolCallPending(_)
        | E::RiskConfirmationRequested(_)
        | E::ToolCallFinished(_) => UiSensitivity::Redacted,
    }
}

pub fn durability_requirement(event: &UiEvent) -> UiDurabilityRequirement {
    use UiEvent as E;
    match event {
        E::RuntimeReady(_) | E::RuntimeStopping(_) | E::RuntimeBackpressure(_) => {
            UiDurabilityRequirement::Ephemeral
        }
        E::RuntimeStopped(_) => UiDurabilityRequirement::SnapshotOrEphemeral,
        E::SystemNotice(_) | E::SystemError(_) => UiDurabilityRequirement::SourceOrEphemeral,
        E::SessionOpened(_) | E::SessionEnded(_) => UiDurabilityRequirement::CanonicalSnapshot,
        E::SessionStatus(_) => UiDurabilityRequirement::CanonicalSnapshot,
        E::SessionCleared(_) => UiDurabilityRequirement::CanonicalEvent,
        E::ModelChanged(_)
        | E::ReasoningChanged(_)
        | E::TurnStarted(_)
        | E::AttemptStarted(_)
        | E::AssistantAccepted(_)
        | E::AttemptSuperseded(_)
        | E::TurnCompleted(_)
        | E::TurnInterrupted(_)
        | E::ToolCallStarted(_)
        | E::ToolCallFinished(_)
        | E::ToolBatchFinished(_) => UiDurabilityRequirement::CanonicalEvent,
        E::ToolBatchStarted(_) => UiDurabilityRequirement::CanonicalSnapshot,
        E::SettingsChanged(_) => UiDurabilityRequirement::SettingsRevision,
        E::ContextUpdated(_) => UiDurabilityRequirement::Ephemeral,
        E::AssistantDelta(_) => UiDurabilityRequirement::Ephemeral,
        E::AttemptRewind(_) => UiDurabilityRequirement::CanonicalOrEphemeral,
        E::UsageUpdated(_) => UiDurabilityRequirement::Ephemeral,
        E::ToolCallPending(_) => UiDurabilityRequirement::Ephemeral,
        E::RiskConfirmationRequested(_) | E::RiskConfirmationResolved(_) => {
            UiDurabilityRequirement::Ephemeral
        }
        E::ToolCallProgress(_) => UiDurabilityRequirement::Ephemeral,
        E::SetupChanged(_) => UiDurabilityRequirement::HostSetupConfig,
        E::AuthFlowUpdated(_) => UiDurabilityRequirement::Ephemeral,
        E::AuthChanged(_) => UiDurabilityRequirement::CredentialRevision,
        E::ConsentRequested(_) => UiDurabilityRequirement::Ephemeral,
        E::ConsentResolved(_) => UiDurabilityRequirement::HostConsentOrEphemeral,
    }
}

/// Exact envelope context validation from section 6.1, plus schema version,
/// durability structural rules, and the exact per-variant durability mapping
/// from section 7 (including the conditional rows).
pub fn validate_ui_event(
    record: &UiEventRecord,
) -> Result<(), crate::ui_contract::UiContractError> {
    use crate::ui_contract::UiContractError as E;
    if record.ui_contract_schema_version != crate::ui_contract::UI_CONTRACT_SCHEMA_VERSION {
        return Err(E::InvalidInput(
            "unsupported ui_contract_schema_version".to_string(),
        ));
    }
    let session = record.session_id;
    let turn = record.turn_id;
    let attempt = record.attempt_id;
    // turn_id only with session; attempt_id only with matching turn.
    if turn.is_some() && session.is_none() {
        return Err(E::InvalidInput("turn_id without session_id".to_string()));
    }
    if attempt.is_some() && turn.is_none() {
        return Err(E::InvalidInput("attempt_id without turn_id".to_string()));
    }
    let require_session = session.is_some();
    let forbid_turn = turn.is_none() && attempt.is_none();
    let forbid_attempt = attempt.is_none();
    match &record.event {
        UiEvent::RuntimeReady(_) | UiEvent::RuntimeBackpressure(_) => {
            if session.is_some() || turn.is_some() || attempt.is_some() {
                return Err(E::InvalidInput(
                    "runtime event must not carry context".to_string(),
                ));
            }
        }
        UiEvent::RuntimeStopping(_)
        | UiEvent::RuntimeStopped(_)
        | UiEvent::SystemNotice(_)
        | UiEvent::SystemError(_) => {}
        UiEvent::SessionOpened(_)
        | UiEvent::SessionStatus(_)
        | UiEvent::SessionCleared(_)
        | UiEvent::SessionEnded(_)
        | UiEvent::ReasoningChanged(_)
        | UiEvent::ContextUpdated(_) => {
            if !require_session || !forbid_turn {
                return Err(E::InvalidInput(
                    "session event context violation".to_string(),
                ));
            }
        }
        UiEvent::ModelChanged(_) => {
            if !require_session || attempt.is_some() {
                return Err(E::InvalidInput("model event context violation".to_string()));
            }
        }
        UiEvent::SettingsChanged(_) => {
            if !forbid_turn {
                return Err(E::InvalidInput(
                    "settings event context violation".to_string(),
                ));
            }
        }
        UiEvent::TurnStarted(payload) => {
            if !require_session || !forbid_attempt || turn != Some(payload.turn_id) {
                return Err(E::InvalidInput(
                    "turn_started context violation".to_string(),
                ));
            }
        }
        UiEvent::TurnCompleted(payload) => {
            if !require_session || !forbid_attempt || turn != Some(payload.footer.turn_id) {
                return Err(E::InvalidInput(
                    "turn_completed context violation".to_string(),
                ));
            }
        }
        UiEvent::TurnInterrupted(payload) => {
            if !require_session || turn != Some(payload.turn_id) {
                return Err(E::InvalidInput(
                    "turn_interrupted context violation".to_string(),
                ));
            }
            // A non-empty uncertain list names executions whose outcome is
            // unknown; the failed attempt must be identified in the envelope.
            if !payload.uncertain_execution_ids.is_empty() && attempt.is_none() {
                return Err(E::InvalidInput(
                    "turn_interrupted with uncertain executions requires attempt_id".to_string(),
                ));
            }
        }
        UiEvent::AttemptStarted(payload) => {
            if !require_session || turn.is_none() || attempt != Some(payload.attempt_id) {
                return Err(E::InvalidInput(
                    "attempt_started context violation".to_string(),
                ));
            }
        }
        UiEvent::AssistantDelta(_) => {
            if !require_session || turn.is_none() || attempt.is_none() {
                return Err(E::InvalidInput(
                    "assistant_delta context violation".to_string(),
                ));
            }
        }
        UiEvent::AttemptRewind(payload) => {
            if !require_session || turn.is_none() || attempt != Some(payload.attempt_id) {
                return Err(E::InvalidInput(
                    "attempt_rewind context violation".to_string(),
                ));
            }
        }
        UiEvent::AssistantAccepted(payload) => {
            if !require_session || turn.is_none() || attempt != Some(payload.attempt_id) {
                return Err(E::InvalidInput(
                    "assistant_accepted context violation".to_string(),
                ));
            }
        }
        UiEvent::AttemptSuperseded(payload) => {
            // Supersession uses the old attempt in the envelope.
            if !require_session || turn.is_none() || attempt != Some(payload.old_attempt_id) {
                return Err(E::InvalidInput(
                    "attempt_superseded context violation".to_string(),
                ));
            }
        }
        UiEvent::UsageUpdated(payload) => {
            if !require_session || turn.is_none() || attempt != Some(payload.attempt_id) {
                return Err(E::InvalidInput(
                    "usage_updated context violation".to_string(),
                ));
            }
        }
        UiEvent::ToolBatchStarted(_)
        | UiEvent::ToolCallPending(_)
        | UiEvent::RiskConfirmationRequested(_)
        | UiEvent::RiskConfirmationResolved(_)
        | UiEvent::ToolCallStarted(_)
        | UiEvent::ToolCallProgress(_)
        | UiEvent::ToolCallFinished(_)
        | UiEvent::ToolBatchFinished(_) => {
            if !require_session || turn.is_none() || attempt.is_none() {
                return Err(E::InvalidInput(
                    "tool/risk event context violation".to_string(),
                ));
            }
        }
        UiEvent::SetupChanged(_)
        | UiEvent::AuthFlowUpdated(_)
        | UiEvent::AuthChanged(_)
        | UiEvent::ConsentRequested(_)
        | UiEvent::ConsentResolved(_) => {
            if !forbid_turn {
                return Err(E::InvalidInput("host event context violation".to_string()));
            }
        }
    }
    // Durability structural rules.
    match &record.durability {
        UiDurabilityRef::Ephemeral => {}
        UiDurabilityRef::CanonicalEvent { .. } | UiDurabilityRef::CanonicalSnapshot { .. } => {
            if session.is_none() {
                return Err(E::InvalidInput(
                    "canonical durability without session".to_string(),
                ));
            }
        }
        UiDurabilityRef::SettingsRevision { .. }
        | UiDurabilityRef::CredentialRevision { .. }
        | UiDurabilityRef::HostRevision { .. } => {}
    }
    // Exact per-variant durability mapping from section 7.
    check_durability_mapping(record)?;
    // Operation scope: non-null exactly when the event directly notifies the
    // outcome of a durable UI operation. Later provider/tool descendants of
    // TurnSubmit (attempts, deltas, tool/risk progress, usage) use null.
    check_operation_scope(record)?;
    Ok(())
}

/// Direct result notifications of durable UI operations carry the originating
/// operation ID; every other event must leave it null.
///
/// `turn_completed` is a later TurnSubmit descendant. `turn_interrupted`
/// carries an ID only when it is the TurnCancel or shutdown command result
/// (`user_abort` / `session_shutdown`); provider-failure and other turn-machine
/// interruptions stay null.
fn requires_operation_id(event: &UiEvent) -> bool {
    match event {
        UiEvent::TurnCompleted(_) => false,
        UiEvent::TurnInterrupted(payload) => matches!(
            payload.reason,
            TurnInterruptionReasonDto::UserAbort | TurnInterruptionReasonDto::SessionShutdown
        ),
        UiEvent::SessionOpened(_)
        | UiEvent::SessionCleared(_)
        | UiEvent::SessionEnded(_)
        | UiEvent::TurnStarted(_)
        | UiEvent::ModelChanged(_)
        | UiEvent::ReasoningChanged(_)
        | UiEvent::SettingsChanged(_)
        | UiEvent::SetupChanged(_)
        | UiEvent::AuthChanged(_)
        | UiEvent::ConsentResolved(_)
        | UiEvent::RiskConfirmationResolved(_)
        | UiEvent::RuntimeStopping(_)
        | UiEvent::RuntimeStopped(_) => true,
        _ => false,
    }
}

fn check_operation_scope(
    record: &UiEventRecord,
) -> Result<(), crate::ui_contract::UiContractError> {
    use crate::ui_contract::UiContractError as E;
    let want = requires_operation_id(&record.event);
    if want != record.operation_id.is_some() {
        return Err(E::InvalidInput(
            "operation_id must be non-null exactly for direct command results".to_string(),
        ));
    }
    Ok(())
}

/// Enforce the section 7 durability table for one record, including the
/// conditional rows (runtime stopped, system notice/error source, rewind
/// reason, persisted consent).
fn check_durability_mapping(
    record: &UiEventRecord,
) -> Result<(), crate::ui_contract::UiContractError> {
    use crate::ui_contract::UiContractError as E;
    use UiDurabilityRef as D;
    let mismatch = |want: &str| E::InvalidInput(format!("durability mismatch: want {want}"));
    let durability = &record.durability;
    let is_ephemeral = matches!(durability, D::Ephemeral);
    let is_canonical_event = matches!(durability, D::CanonicalEvent { .. });
    let is_canonical_snapshot = matches!(durability, D::CanonicalSnapshot { .. });
    match &record.event {
        UiEvent::RuntimeReady(_)
        | UiEvent::RuntimeStopping(_)
        | UiEvent::RuntimeBackpressure(_) => {
            if !is_ephemeral {
                return Err(mismatch("ephemeral"));
            }
        }
        UiEvent::RuntimeStopped(_) => {
            if record.session_id.is_none() && !is_ephemeral {
                return Err(mismatch("ephemeral without a session"));
            }
            if record.session_id.is_some() && !is_canonical_snapshot {
                return Err(mismatch("canonical_snapshot with a session"));
            }
        }
        UiEvent::SystemNotice(_) | UiEvent::SystemError(_) => {
            // Source durability when a source session is present, otherwise
            // ephemeral.
            if record.session_id.is_none() && !is_ephemeral {
                return Err(mismatch("ephemeral without a source"));
            }
            if record.session_id.is_some() && is_ephemeral {
                return Err(mismatch("source durability with a source"));
            }
        }
        UiEvent::SessionOpened(_) | UiEvent::SessionEnded(_) | UiEvent::SessionStatus(_) => {
            if !is_canonical_snapshot {
                return Err(mismatch("canonical_snapshot"));
            }
        }
        UiEvent::SessionCleared(_)
        | UiEvent::ModelChanged(_)
        | UiEvent::ReasoningChanged(_)
        | UiEvent::TurnStarted(_)
        | UiEvent::AttemptStarted(_)
        | UiEvent::AssistantAccepted(_)
        | UiEvent::AttemptSuperseded(_)
        | UiEvent::TurnCompleted(_)
        | UiEvent::TurnInterrupted(_)
        | UiEvent::ToolCallStarted(_)
        | UiEvent::ToolCallFinished(_)
        | UiEvent::ToolBatchFinished(_) => {
            if !is_canonical_event {
                return Err(mismatch("canonical_event"));
            }
        }
        UiEvent::ToolBatchStarted(_) => {
            if !is_canonical_snapshot {
                return Err(mismatch("canonical_snapshot"));
            }
        }
        UiEvent::SettingsChanged(_) => {
            if !matches!(durability, D::SettingsRevision { .. }) {
                return Err(mismatch("settings_revision"));
            }
        }
        UiEvent::ContextUpdated(_)
        | UiEvent::AssistantDelta(_)
        | UiEvent::UsageUpdated(_)
        | UiEvent::ToolCallPending(_)
        | UiEvent::RiskConfirmationRequested(_)
        | UiEvent::RiskConfirmationResolved(_)
        | UiEvent::ToolCallProgress(_)
        | UiEvent::AuthFlowUpdated(_)
        | UiEvent::ConsentRequested(_) => {
            if !is_ephemeral {
                return Err(mismatch("ephemeral"));
            }
        }
        UiEvent::AttemptRewind(payload) => match payload.reason {
            RewindReason::Failed | RewindReason::Cancelled => {
                if !is_canonical_event {
                    return Err(mismatch("canonical_event for a durable rewind"));
                }
            }
            RewindReason::Reconciliation => {
                if !is_ephemeral {
                    return Err(mismatch("ephemeral for reconciliation"));
                }
            }
        },
        UiEvent::SetupChanged(_) => {
            if !matches!(
                durability,
                D::HostRevision {
                    kind: HostRevisionKind::SetupConfig,
                    ..
                }
            ) {
                return Err(mismatch("host setup_config revision"));
            }
        }
        UiEvent::AuthChanged(_) => {
            if !matches!(durability, D::CredentialRevision { .. }) {
                return Err(mismatch("credential_revision"));
            }
        }
        UiEvent::ConsentResolved(payload) => {
            if payload.persisted {
                if !matches!(
                    durability,
                    D::HostRevision {
                        kind: HostRevisionKind::Consent,
                        ..
                    }
                ) {
                    return Err(mismatch("host consent revision when persisted"));
                }
            } else if !is_ephemeral {
                return Err(mismatch("ephemeral when not persisted"));
            }
        }
    }
    Ok(())
}
