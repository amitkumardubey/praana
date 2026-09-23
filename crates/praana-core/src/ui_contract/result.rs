//! Command results, errors, notices, usage, and session snapshots.
//!
//! History mode, projection version, and state summary statuses reuse the
//! protocol-owned types directly. `ComponentState` is exactly the five
//! specified variants.

use serde::{Deserialize, Serialize};

use crate::protocol::id::{EventId, ProjectionId, SessionId, TurnId};
use crate::protocol::models::HistoryMode;
use crate::protocol::state_graph::{ConstraintStatus, DecisionStatus, ErrorStatus, TaskStatus};
use crate::ui_contract::catalog::{ActiveModelDto, ReasoningStateDto};
use crate::ui_contract::ids::{ConfirmationId, NoticeId, ResumeSelector, TranscriptCursor};
use crate::ui_contract::json_data::Sha256Digest;
use crate::ui_contract::settings::EffectiveSettingsDto;
use crate::ui_contract::transcript::{ContentPageDto, TranscriptPageDto};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "status", content = "data", rename_all = "snake_case")]
pub enum CoreCommandResult {
    Ok(CoreCommandSuccess),
    Err(CoreErrorDto),
}

impl CoreCommandResult {
    /// Success `type` tag for command/result pairing checks.
    pub fn success_type(&self) -> &'static str {
        match self {
            CoreCommandResult::Ok(success) => match success {
                CoreCommandSuccess::SessionOpened(_) => "session_opened",
                CoreCommandSuccess::SessionEnded(_) => "session_ended",
                CoreCommandSuccess::SessionSnapshot(_) => "session_snapshot",
                CoreCommandSuccess::SessionCleared(_) => "session_cleared",
                CoreCommandSuccess::TurnSubmitted(_) => "turn_submitted",
                CoreCommandSuccess::TurnCancellation(_) => "turn_cancellation",
                CoreCommandSuccess::RiskResolved(_) => "risk_resolved",
                CoreCommandSuccess::SlashCatalog(_) => "slash_catalog",
                CoreCommandSuccess::SlashExecuted(_) => "slash_executed",
                CoreCommandSuccess::PathCompletion(_) => "path_completion",
                CoreCommandSuccess::ModelCatalog(_) => "model_catalog",
                CoreCommandSuccess::ModelSelected(_) => "model_selected",
                CoreCommandSuccess::ReasoningSet(_) => "reasoning_set",
                CoreCommandSuccess::SettingsPatched(_) => "settings_patched",
                CoreCommandSuccess::TranscriptPage(_) => "transcript_page",
                CoreCommandSuccess::ContentRead(_) => "content_read",
                CoreCommandSuccess::SetupStatus(_) => "setup_status",
                CoreCommandSuccess::SetupApplied(_) => "setup_applied",
                CoreCommandSuccess::AuthLogin(_) => "auth_login",
                CoreCommandSuccess::AuthLogout(_) => "auth_logout",
                CoreCommandSuccess::ConsentResolved(_) => "consent_resolved",
                CoreCommandSuccess::RuntimePong(_) => "runtime_pong",
                CoreCommandSuccess::ShutdownAdmitted(_) => "shutdown_admitted",
            },
            CoreCommandResult::Err(_) => "error",
        }
    }

    pub fn transcript_before_cursor(&self) -> Option<&TranscriptCursor> {
        match self {
            CoreCommandResult::Ok(CoreCommandSuccess::TranscriptPage(page)) => {
                page.before_cursor.as_ref()
            }
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum CoreCommandSuccess {
    SessionOpened(SessionOpenResultDto),
    SessionEnded(SessionEpilogueDto),
    SessionSnapshot(SessionSnapshotDto),
    SessionCleared(SessionClearedResultDto),
    TurnSubmitted(TurnSubmittedDto),
    TurnCancellation(CancellationResultDto),
    RiskResolved(RiskResolvedResultDto),
    SlashCatalog(crate::ui_contract::catalog::SlashCatalogPageDto),
    SlashExecuted(crate::ui_contract::catalog::SlashResultDto),
    PathCompletion(crate::ui_contract::catalog::PathCompletionPageDto),
    ModelCatalog(crate::ui_contract::catalog::ModelCatalogPageDto),
    ModelSelected(ActiveModelDto),
    ReasoningSet(ReasoningStateDto),
    SettingsPatched(EffectiveSettingsDto),
    TranscriptPage(TranscriptPageDto),
    ContentRead(ContentPageDto),
    SetupStatus(crate::ui_contract::setup::SetupStatusDto),
    SetupApplied(crate::ui_contract::setup::SetupApplyResultDto),
    AuthLogin(crate::ui_contract::setup::AuthLoginResultDto),
    AuthLogout(crate::ui_contract::setup::AuthLogoutResultDto),
    ConsentResolved(crate::ui_contract::setup::ConsentResolvedResultDto),
    RuntimePong(RuntimePongDto),
    ShutdownAdmitted(ShutdownAdmittedDto),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComponentState {
    Available,
    Disabled,
    Unavailable,
    Degraded,
    Starting,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ComponentStatusDto {
    pub state: ComponentState,
    pub label: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BootStatusDto {
    pub native: ComponentStatusDto,
    pub search: ComponentStatusDto,
    pub lsp: ComponentStatusDto,
    pub memory: ComponentStatusDto,
    pub provider: ComponentStatusDto,
    pub history: ComponentStatusDto,
    pub skills: ComponentStatusDto,
    pub discovered_skill_count: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum StateStatusSummaryDto {
    Task(TaskStatus),
    Decision(DecisionStatus),
    Constraint(ConstraintStatus),
    Note,
    Error(ErrorStatus),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateObjectSummaryDto {
    pub state_id: crate::protocol::id::StateId,
    pub kind: crate::protocol::state_graph::StateKind,
    pub tier: crate::protocol::state_graph::StateTier,
    pub status: StateStatusSummaryDto,
    pub label: String,
    pub focused: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateSnapshotDto {
    pub graph_sequence: u64,
    pub counts: StateCountsDto,
    pub objects: Vec<StateObjectSummaryDto>,
    pub truncated: bool,
}

impl StateSnapshotDto {
    /// Focused first, then active, soft, hard, each tier ordered by state ID,
    /// capped at 100 summaries. `truncated` is true exactly when more than 100
    /// current objects exist.
    pub fn validate_ordering(&self) -> Result<(), String> {
        if self.objects.len() > 100 {
            return Err("state snapshot exceeds 100 summaries".to_string());
        }
        // Focused first, then active, soft, and hard, each tier ordered by
        // StateId. Retracted objects never appear here.
        let mut last: Option<(bool, u8, String)> = None;
        for object in &self.objects {
            let tier_rank = match object.tier {
                crate::protocol::state_graph::StateTier::Active => 0,
                crate::protocol::state_graph::StateTier::Soft => 1,
                crate::protocol::state_graph::StateTier::Hard => 2,
            };
            // Focused sorts before unfocused within the same tier position:
            // compare (unfocused, tier, id) lexicographically.
            let key = (!object.focused, tier_rank, object.state_id.to_string());
            if let Some(previous) = &last {
                if key < *previous {
                    return Err("state snapshot ordering violation".to_string());
                }
            }
            last = Some(key);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateCountsDto {
    pub total: u64,
    pub tasks: u64,
    pub decisions: u64,
    pub constraints: u64,
    pub notes: u64,
    pub errors: u64,
    pub active: u64,
    pub soft: u64,
    pub hard: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionMetadataDto {
    pub session_id: SessionId,
    pub resume_selector: ResumeSelector,
    pub created_at_ms: i64,
    pub cwd_label: String,
    pub project_label: Option<String>,
    pub config_schema_version: u32,
    pub creation_config_digest_sha256: Sha256Digest,
    pub loaded_config_digest_sha256: Sha256Digest,
    pub runtime_config_digest_sha256: Sha256Digest,
    pub config_changed_since_create: bool,
    pub history_mode: HistoryMode,
    pub projection_version: ProjectionId,
    pub incognito: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SessionOpenResultDto {
    pub session_id: SessionId,
    pub resumed: bool,
    pub canonical_sequence: u64,
    pub metadata: SessionMetadataDto,
    pub active_model: ActiveModelDto,
    pub reasoning: ReasoningStateDto,
    pub settings: EffectiveSettingsDto,
    pub boot: BootStatusDto,
    pub transcript_tail_cursor: Option<TranscriptCursor>,
    pub recovery: Vec<SystemNoticeDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActiveTurnPhase {
    Admitted,
    Provider,
    Tools,
    Cancelling,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ActiveTurnSnapshotDto {
    pub turn_id: TurnId,
    pub attempt_id: Option<crate::protocol::id::AttemptId>,
    pub phase: ActiveTurnPhase,
    pub cancellation_requested: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SessionSnapshotDto {
    pub metadata: SessionMetadataDto,
    pub canonical_sequence: u64,
    pub active_model: ActiveModelDto,
    pub reasoning: ReasoningStateDto,
    pub settings: EffectiveSettingsDto,
    pub boot: Option<BootStatusDto>,
    pub active_turn: Option<ActiveTurnSnapshotDto>,
    pub pending_confirmation: Option<crate::ui_contract::event::RiskConfirmationDto>,
    pub transcript_before_cursor: Option<TranscriptCursor>,
    pub transcript_after_cursor: Option<TranscriptCursor>,
    pub context: ContextStatusDto,
    pub state: StateSnapshotDto,
    pub recovery: Vec<SystemNoticeDto>,
}

impl SessionSnapshotDto {
    /// Snapshot validation: state ordering (focused first, then tier order)
    /// and the 100-summary cap.
    pub fn validate(&self) -> Result<(), String> {
        self.state.validate_ordering()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionClearedResultDto {
    pub canonical_sequence: u64,
    pub reset_epoch: u64,
    pub transcript_tail_cursor: Option<TranscriptCursor>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnSubmittedDto {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub user_message_event_id: EventId,
    pub canonical_sequence: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CancellationState {
    Requested,
    AlreadyRequested,
    AlreadyFinished,
    NotFound,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CancellationResultDto {
    pub turn_id: TurnId,
    pub state: CancellationState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RiskResolvedResultDto {
    pub confirmation_id: ConfirmationId,
    pub accepted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemoryEpilogueDto {
    pub state: ComponentState,
    pub extracted: u32,
    pub stored: u32,
    pub skipped: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionEpilogueDto {
    pub session_id: SessionId,
    pub resume_selector: ResumeSelector,
    pub canonical_sequence: u64,
    pub committed_turns: u64,
    pub interrupted_turns: u64,
    pub state: StateSnapshotDto,
    pub memory: MemoryEpilogueDto,
    pub ended_at_ms: i64,
}

impl SessionEpilogueDto {
    /// Epilogue validation: state ordering (focused first, then tier order)
    /// and the 100-summary cap.
    pub fn validate(&self) -> Result<(), String> {
        self.state.validate_ordering()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimePongDto {
    pub server_time_ms: i64,
    pub session_id: Option<SessionId>,
    pub turn_id: Option<TurnId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShutdownAdmittedDto {
    pub deadline_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct UsageDto {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
    pub cost_microusd: Option<u64>,
    pub estimated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContextStatusDto {
    pub window_tokens: u64,
    pub occupied_tokens: u64,
    pub available_tokens: u64,
    pub occupied_percent_milli: u32,
    pub compact_at_percent_milli: u32,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub compaction_epoch: u64,
    pub pressure: ComponentState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoticeTone {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoticePersistence {
    Transient,
    UntilDismissed,
    Transcript,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SystemNoticeDto {
    pub notice_id: NoticeId,
    pub code: String,
    pub tone: NoticeTone,
    pub title: String,
    pub message: String,
    pub persistence: NoticePersistence,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoreErrorCode {
    InvalidInput,
    NotReady,
    SessionRequired,
    SessionBusy,
    SessionNotFound,
    ResumeSelectorAmbiguous,
    TurnNotFound,
    TurnAlreadyFinished,
    ConfirmationNotFound,
    ConfirmationExpired,
    ConsentNotFound,
    CursorInvalid,
    ContentNotFound,
    CatalogUnavailable,
    SettingsConflict,
    OperationConflict,
    OperationInterrupted,
    AuthenticationFailed,
    ProviderFailed,
    RateLimited,
    PermissionDenied,
    IntegrityFailed,
    Unavailable,
    Cancelled,
    Timeout,
    DurabilityFailed,
    Backpressure,
    Unsupported,
    Internal,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorRetryAdvice {
    Never,
    SameOperation,
    NewOperation,
    AfterDelay,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ErrorDetailsDto {
    None,
    InvalidField {
        field: String,
        reason: String,
    },
    CurrentRevision {
        revision: u64,
    },
    MatchingSessions {
        session_ids: Vec<SessionId>,
    },
    OperationConflict {
        existing_request_sha256: Sha256Digest,
    },
    Domain {
        domain: String,
        code: String,
    },
    RetryAfter {
        retry_after_ms: u64,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CoreErrorDto {
    pub code: CoreErrorCode,
    pub message: String,
    pub retry: ErrorRetryAdvice,
    pub details: ErrorDetailsDto,
}

impl CoreErrorDto {
    /// Messages are user-safe and at most 1,000 UTF-8 bytes.
    pub fn validate(&self) -> Result<(), String> {
        if self.message.len() > 1000 {
            return Err("error message exceeds 1,000 bytes".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnFooterDto {
    pub turn_id: TurnId,
    pub outcome: TurnCompletionOutcome,
    pub usage: UsageDto,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnCompletionOutcome {
    Stop,
    Length,
    Interrupted,
}
