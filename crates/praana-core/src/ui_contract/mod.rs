//! Permanent semantic contract between the Rust core and every UI.
//!
//! This module owns `CoreCommand`, `CoreCommandResult`, `UiEvent`, all DTOs
//! reachable from those types, UI-crossing ID rules, operation idempotency
//! semantics, event priority, sensitivity, coalescing, and command and event
//! names. It is UI-framework-neutral and transport-neutral: no semantic DTO
//! is duplicated under IPC or TUI.

pub mod catalog;
pub mod command;
pub mod event;
pub mod ids;
pub mod json_data;
pub mod operation;
pub mod result;
pub mod settings;
pub mod setup;
pub mod sink;
pub mod transcript;

pub use catalog::{
    ActiveModelDto, ModelAvailability, ModelCatalogPageDto, ModelCatalogSource, ModelDescriptorDto,
    PathCompletionDto, PathCompletionPageDto, PathEntryKind, ProviderProtocol, ReasoningEffort,
    ReasoningStateDto, SlashAction, SlashArgumentKind, SlashCatalogPageDto, SlashCommandDto,
    SlashDisplay, SlashHandoff, SlashResultDto,
};
pub use command::{
    check_content_cursor_binding, command_wire_name, expected_success_variant,
    resolve_resume_selector, AuthLoginCommand, AuthLogoutCommand, ConsentResolveCommand,
    ContentReadCommand, CoreCommand, ModelCatalogCommand, ModelSelectCommand, PathCompleteCommand,
    ReasoningSetCommand, RiskDecision, RiskResolveCommand, RuntimePingCommand, SessionClearCommand,
    SessionCreateCommand, SessionEndCommand, SessionEndReason, SessionNewCommand,
    SessionResumeCommand, SessionSnapshotCommand, SettingsPatchCommand, SetupApplyCommand,
    SetupStatusCommand, ShutdownCommand, ShutdownReason, SlashCatalogCommand, SlashExecuteCommand,
    TranscriptPageCommand, TurnCancelCommand, TurnCancelReason, TurnSubmitCommand,
    ALL_COMMAND_KINDS,
};
pub use event::{
    coalesce_key, durability_requirement, event_wire_name, priority, sensitivity,
    validate_ui_event, AcceptedAssistantBlockDto, AcceptedToolCallDto, AssistantAcceptedDto,
    AssistantDeltaDto, AssistantFinishReasonDto, AssistantVisibleBlockKind, AttemptRewindDto,
    AttemptStartedDto, AttemptSupersededDto, AuthChangedDto, BackpressureDto, RewindReason,
    RiskClassDto, RiskConfirmationDto, RiskConfirmationResolvedDto, RuntimeReadyDto,
    RuntimeStoppedDto, RuntimeStoppingDto, SessionStatusDto, SupersessionReasonDto,
    ToolBatchFinishedDto, ToolBatchStartedDto, ToolCallFinishedDto, ToolCallPendingDto,
    ToolCallProgressDto, ToolCallStartedDto, ToolProgressPhase, TurnCompletedDto,
    TurnInterruptedDto, TurnInterruptionReasonDto, TurnStartedDto, UiCoalesceKey, UiDurabilityRef,
    UiDurabilityRequirement, UiEvent, UiEventPriority, UiEventRecord, UiSensitivity,
    UsageUpdatedDto, ALL_EVENT_KINDS,
};
pub use ids::{
    AssistantBlockId, AuthFlowId, ConfirmationId, ConsentId, ContentCursor, ModelCatalogCursor,
    NoticeId, OperationId, PathCompletionCursor, ResumeSelector, SessionLocator,
    SlashCatalogCursor, TranscriptCursor, TranscriptEntryId, TranscriptGroupId,
};
pub use json_data::{JsonData, ModelId, ProviderId, Sha256Digest, ToolCallId, ToolName};
// Protocol-owned types reused directly by the UI contract.
pub use crate::protocol::id::ProjectionId;
pub use crate::protocol::models::HistoryMode;
pub use crate::protocol::state_graph::{
    ConstraintStatus, DecisionStatus, ErrorStatus, StateKind, StateTier, TaskStatus,
};
pub use operation::{
    canonical_request_hash, error_result_hash, execute_core_command, operation_kind_for_command,
    recover_reserved_operations, reserve_operation, success_result_hash, CoreServices,
    OperationKind, OperationLedgerRef, OperationRecordDto, OperationRecoveryError,
    OperationReservation, OperationResultRef, OperationStatus, PlannedEffectRef,
    StoredTerminalResult,
};
pub use result::{
    ActiveTurnPhase, ActiveTurnSnapshotDto, CancellationResultDto, CancellationState,
    ComponentState, ComponentStatusDto, ContextStatusDto, CoreCommandResult, CoreCommandSuccess,
    CoreErrorCode, CoreErrorDto, ErrorDetailsDto, ErrorRetryAdvice, MemoryEpilogueDto,
    NoticePersistence, NoticeTone, RuntimePongDto, SessionClearedResultDto, SessionEpilogueDto,
    SessionMetadataDto, SessionOpenResultDto, SessionSnapshotDto, ShutdownAdmittedDto,
    StateCountsDto, StateObjectSummaryDto, StateSnapshotDto, SystemNoticeDto,
    TurnCompletionOutcome, TurnFooterDto, TurnSubmittedDto, UsageDto,
};
pub use settings::{EffectiveSettingsDto, SettingsPatchDto, ThemeId, ToolIconMode};
pub use setup::{
    AuthFlowDto, AuthLoginResultDto, AuthLogoutResultDto, AuthMethodDto, AuthMethodKindDto,
    AuthState, ConsentChoice, ConsentRequestDto, ConsentResolvedResultDto, ProviderAuthStatusDto,
    SensitiveStringDto, SetupApplyResultDto, SetupChoiceDto, SetupFieldDto, SetupFieldId,
    SetupFieldKind, SetupProviderDto, SetupStatusDto, SetupValueDto,
};
pub use sink::{ChannelUiSink, NullUiSink, SinkBackpressureCounters, UiEventSink, UiSinkError};
pub use transcript::{
    check_cursor_session_binding, committed_entry_id, committed_group_id,
    derive_transcript_entry_id, memory_entry_allowed, provisional_entry_id, ContentEncoding,
    ContentMatchDto, ContentPageDto, ContentRefDto, ContentSelectionDto, MemoryTranscriptDto,
    TextContentDto, ToolDisplayStatus, TranscriptContentDto, TranscriptDirection,
    TranscriptEntryDto, TranscriptGroupDto, TranscriptPageDto, TranscriptRoleDto,
    TranscriptToolDto,
};

/// UI contract schema version. Always 1 in this packet.
pub const UI_CONTRACT_SCHEMA_VERSION: u32 = 1;
/// Transcript projection schema version. Always 1 in this packet.
pub const TRANSCRIPT_PROJECTION_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UiContractError {
    InvalidUlid(String),
    UnknownVariant(String),
    UnknownField(String),
    OperationConflict(String),
    CursorInvalid,
    InvalidInput(String),
}

impl UiContractError {
    /// Fixture-style error code name.
    pub fn code_name(&self) -> &'static str {
        match self {
            UiContractError::InvalidUlid(_) => "invalid_ulid",
            UiContractError::UnknownVariant(_) => "unknown_variant",
            UiContractError::UnknownField(_) => "unknown_field",
            UiContractError::OperationConflict(_) => "operation_conflict",
            UiContractError::CursorInvalid => "cursor_invalid",
            UiContractError::InvalidInput(_) => "invalid_input",
        }
    }
}

impl std::fmt::Display for UiContractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UiContractError::InvalidUlid(msg) => write!(f, "invalid ULID: {msg}"),
            UiContractError::UnknownVariant(msg) => write!(f, "unknown variant: {msg}"),
            UiContractError::UnknownField(msg) => write!(f, "unknown field: {msg}"),
            UiContractError::OperationConflict(msg) => write!(f, "operation conflict: {msg}"),
            UiContractError::CursorInvalid => write!(f, "cursor invalid"),
            UiContractError::InvalidInput(msg) => write!(f, "invalid input: {msg}"),
        }
    }
}

impl std::error::Error for UiContractError {}
