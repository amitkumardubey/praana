//! Semantic core commands.
//!
//! Read-only commands carry no [`OperationId`]; every other command requires
//! one. Turn text is 1 through 262,144 UTF-8 bytes after CRLF/CR to LF
//! normalization with NUL rejected and no trim.

use serde::{Deserialize, Serialize};

use std::fmt;

use crate::protocol::id::{SessionId, TurnId};
use crate::ui_contract::ids::{
    ConfirmationId, ContentCursor, ModelCatalogCursor, OperationId, PathCompletionCursor,
    ResumeSelector, SessionLocator, SlashCatalogCursor, TranscriptCursor,
};
use crate::ui_contract::json_data::{ModelId, ProviderId, Sha256Digest};
use crate::ui_contract::setup::{AuthMethodDto, SetupFieldId, SetupValueDto};
use crate::ui_contract::transcript::{ContentRefDto, ContentSelectionDto, TranscriptDirection};
use std::collections::BTreeMap;

pub const MAX_TURN_TEXT_BYTES: usize = 262_144;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum CoreCommand {
    SessionCreate(SessionCreateCommand),
    SessionResume(SessionResumeCommand),
    SessionEnd(SessionEndCommand),
    SessionSnapshot(SessionSnapshotCommand),
    SessionClear(SessionClearCommand),
    SessionNew(SessionNewCommand),
    TurnSubmit(TurnSubmitCommand),
    TurnCancel(TurnCancelCommand),
    RiskResolve(RiskResolveCommand),
    SlashCatalog(SlashCatalogCommand),
    SlashExecute(SlashExecuteCommand),
    PathComplete(PathCompleteCommand),
    ModelCatalog(ModelCatalogCommand),
    ModelSelect(ModelSelectCommand),
    ReasoningSet(ReasoningSetCommand),
    SettingsPatch(SettingsPatchCommand),
    TranscriptPage(TranscriptPageCommand),
    ContentRead(ContentReadCommand),
    SetupStatus(SetupStatusCommand),
    SetupApply(SetupApplyCommand),
    AuthLogin(AuthLoginCommand),
    AuthLogout(AuthLogoutCommand),
    ConsentResolve(ConsentResolveCommand),
    RuntimePing(RuntimePingCommand),
    Shutdown(ShutdownCommand),
}

/// Manual `Debug` that never prints secret plaintext: secret-carrying
/// commands render as redacted placeholders.
impl fmt::Debug for CoreCommand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreCommand::SessionCreate(c) => f.debug_tuple("SessionCreate").field(c).finish(),
            CoreCommand::SessionResume(c) => f.debug_tuple("SessionResume").field(c).finish(),
            CoreCommand::SessionEnd(c) => f.debug_tuple("SessionEnd").field(c).finish(),
            CoreCommand::SessionSnapshot(c) => f.debug_tuple("SessionSnapshot").field(c).finish(),
            CoreCommand::SessionClear(c) => f.debug_tuple("SessionClear").field(c).finish(),
            CoreCommand::SessionNew(c) => f.debug_tuple("SessionNew").field(c).finish(),
            CoreCommand::TurnSubmit(c) => f.debug_tuple("TurnSubmit").field(c).finish(),
            CoreCommand::TurnCancel(c) => f.debug_tuple("TurnCancel").field(c).finish(),
            CoreCommand::RiskResolve(c) => f.debug_tuple("RiskResolve").field(c).finish(),
            CoreCommand::SlashCatalog(c) => f.debug_tuple("SlashCatalog").field(c).finish(),
            CoreCommand::SlashExecute(c) => f.debug_tuple("SlashExecute").field(c).finish(),
            CoreCommand::PathComplete(c) => f.debug_tuple("PathComplete").field(c).finish(),
            CoreCommand::ModelCatalog(c) => f.debug_tuple("ModelCatalog").field(c).finish(),
            CoreCommand::ModelSelect(c) => f.debug_tuple("ModelSelect").field(c).finish(),
            CoreCommand::ReasoningSet(c) => f.debug_tuple("ReasoningSet").field(c).finish(),
            CoreCommand::SettingsPatch(c) => f.debug_tuple("SettingsPatch").field(c).finish(),
            CoreCommand::TranscriptPage(c) => f.debug_tuple("TranscriptPage").field(c).finish(),
            CoreCommand::ContentRead(c) => f.debug_tuple("ContentRead").field(c).finish(),
            CoreCommand::SetupStatus(c) => f.debug_tuple("SetupStatus").field(c).finish(),
            CoreCommand::SetupApply(_) => f.write_str("SetupApply([REDACTED])"),
            CoreCommand::AuthLogin(_) => f.write_str("AuthLogin([REDACTED])"),
            CoreCommand::AuthLogout(c) => f.debug_tuple("AuthLogout").field(c).finish(),
            CoreCommand::ConsentResolve(c) => f.debug_tuple("ConsentResolve").field(c).finish(),
            CoreCommand::RuntimePing(c) => f.debug_tuple("RuntimePing").field(c).finish(),
            CoreCommand::Shutdown(c) => f.debug_tuple("Shutdown").field(c).finish(),
        }
    }
}

impl CoreCommand {
    /// Semantic variant name used by the mapping inventory.
    pub fn kind_name(&self) -> &'static str {
        match self {
            CoreCommand::SessionCreate(_) => "CoreCommand::SessionCreate",
            CoreCommand::SessionResume(_) => "CoreCommand::SessionResume",
            CoreCommand::SessionEnd(_) => "CoreCommand::SessionEnd",
            CoreCommand::SessionSnapshot(_) => "CoreCommand::SessionSnapshot",
            CoreCommand::SessionClear(_) => "CoreCommand::SessionClear",
            CoreCommand::SessionNew(_) => "CoreCommand::SessionNew",
            CoreCommand::TurnSubmit(_) => "CoreCommand::TurnSubmit",
            CoreCommand::TurnCancel(_) => "CoreCommand::TurnCancel",
            CoreCommand::RiskResolve(_) => "CoreCommand::RiskResolve",
            CoreCommand::SlashCatalog(_) => "CoreCommand::SlashCatalog",
            CoreCommand::SlashExecute(_) => "CoreCommand::SlashExecute",
            CoreCommand::PathComplete(_) => "CoreCommand::PathComplete",
            CoreCommand::ModelCatalog(_) => "CoreCommand::ModelCatalog",
            CoreCommand::ModelSelect(_) => "CoreCommand::ModelSelect",
            CoreCommand::ReasoningSet(_) => "CoreCommand::ReasoningSet",
            CoreCommand::SettingsPatch(_) => "CoreCommand::SettingsPatch",
            CoreCommand::TranscriptPage(_) => "CoreCommand::TranscriptPage",
            CoreCommand::ContentRead(_) => "CoreCommand::ContentRead",
            CoreCommand::SetupStatus(_) => "CoreCommand::SetupStatus",
            CoreCommand::SetupApply(_) => "CoreCommand::SetupApply",
            CoreCommand::AuthLogin(_) => "CoreCommand::AuthLogin",
            CoreCommand::AuthLogout(_) => "CoreCommand::AuthLogout",
            CoreCommand::ConsentResolve(_) => "CoreCommand::ConsentResolve",
            CoreCommand::RuntimePing(_) => "CoreCommand::RuntimePing",
            CoreCommand::Shutdown(_) => "CoreCommand::Shutdown",
        }
    }

    /// Operation ID for mutating commands; `None` for read-only commands.
    pub fn operation_id(&self) -> Option<OperationId> {
        match self {
            CoreCommand::SessionCreate(c) => Some(c.operation_id),
            CoreCommand::SessionResume(c) => Some(c.operation_id),
            CoreCommand::SessionEnd(c) => Some(c.operation_id),
            CoreCommand::SessionSnapshot(_) => None,
            CoreCommand::SessionClear(c) => Some(c.operation_id),
            CoreCommand::SessionNew(c) => Some(c.operation_id),
            CoreCommand::TurnSubmit(c) => Some(c.operation_id),
            CoreCommand::TurnCancel(c) => Some(c.operation_id),
            CoreCommand::RiskResolve(c) => Some(c.operation_id),
            CoreCommand::SlashCatalog(_) => None,
            CoreCommand::SlashExecute(c) => Some(c.operation_id),
            CoreCommand::PathComplete(_) => None,
            CoreCommand::ModelCatalog(_) => None,
            CoreCommand::ModelSelect(c) => Some(c.operation_id),
            CoreCommand::ReasoningSet(c) => Some(c.operation_id),
            CoreCommand::SettingsPatch(c) => Some(c.operation_id),
            CoreCommand::TranscriptPage(_) => None,
            CoreCommand::ContentRead(_) => None,
            CoreCommand::SetupStatus(_) => None,
            CoreCommand::SetupApply(c) => Some(c.operation_id),
            CoreCommand::AuthLogin(c) => Some(c.operation_id),
            CoreCommand::AuthLogout(c) => Some(c.operation_id),
            CoreCommand::ConsentResolve(c) => Some(c.operation_id),
            CoreCommand::RuntimePing(_) => None,
            CoreCommand::Shutdown(c) => Some(c.operation_id),
        }
    }

    /// Canonical operation kind string used for request hashing.
    pub fn operation_kind_str(&self) -> &'static str {
        match self {
            CoreCommand::SessionCreate(_) => "session_create",
            CoreCommand::SessionResume(_) => "session_resume",
            CoreCommand::SessionEnd(_) => "session_end",
            CoreCommand::SessionSnapshot(_) => "session_snapshot",
            CoreCommand::SessionClear(_) => "session_clear",
            CoreCommand::SessionNew(_) => "session_new",
            CoreCommand::TurnSubmit(_) => "turn_submit",
            CoreCommand::TurnCancel(_) => "turn_cancel",
            CoreCommand::RiskResolve(_) => "risk_resolve",
            CoreCommand::SlashCatalog(_) => "slash_catalog",
            CoreCommand::SlashExecute(_) => "slash_execute",
            CoreCommand::PathComplete(_) => "path_complete",
            CoreCommand::ModelCatalog(_) => "model_catalog",
            CoreCommand::ModelSelect(_) => "model_select",
            CoreCommand::ReasoningSet(_) => "reasoning_set",
            CoreCommand::SettingsPatch(_) => "settings_patch",
            CoreCommand::TranscriptPage(_) => "transcript_page",
            CoreCommand::ContentRead(_) => "content_read",
            CoreCommand::SetupStatus(_) => "setup_status",
            CoreCommand::SetupApply(_) => "setup_apply",
            CoreCommand::AuthLogin(_) => "auth_login",
            CoreCommand::AuthLogout(_) => "auth_logout",
            CoreCommand::ConsentResolve(_) => "consent_resolve",
            CoreCommand::RuntimePing(_) => "runtime_ping",
            CoreCommand::Shutdown(_) => "shutdown",
        }
    }
}

/// Exhaustive command-kind inventory beside the enum (no reflection).
pub const ALL_COMMAND_KINDS: &[&str] = &[
    "CoreCommand::SessionCreate",
    "CoreCommand::SessionResume",
    "CoreCommand::SessionEnd",
    "CoreCommand::SessionSnapshot",
    "CoreCommand::SessionClear",
    "CoreCommand::SessionNew",
    "CoreCommand::TurnSubmit",
    "CoreCommand::TurnCancel",
    "CoreCommand::RiskResolve",
    "CoreCommand::SlashCatalog",
    "CoreCommand::SlashExecute",
    "CoreCommand::PathComplete",
    "CoreCommand::ModelCatalog",
    "CoreCommand::ModelSelect",
    "CoreCommand::ReasoningSet",
    "CoreCommand::SettingsPatch",
    "CoreCommand::TranscriptPage",
    "CoreCommand::ContentRead",
    "CoreCommand::SetupStatus",
    "CoreCommand::SetupApply",
    "CoreCommand::AuthLogin",
    "CoreCommand::AuthLogout",
    "CoreCommand::ConsentResolve",
    "CoreCommand::RuntimePing",
    "CoreCommand::Shutdown",
];

/// Normative IPC dotted name for each semantic command variant.
pub fn command_wire_name(command: &CoreCommand) -> &'static str {
    match command {
        CoreCommand::SessionCreate(_) => "session.create",
        CoreCommand::SessionResume(_) => "session.resume",
        CoreCommand::SessionEnd(_) => "session.end",
        CoreCommand::SessionSnapshot(_) => "session.snapshot",
        CoreCommand::SessionClear(_) => "session.clear",
        CoreCommand::SessionNew(_) => "session.new",
        CoreCommand::TurnSubmit(_) => "turn.submit",
        CoreCommand::TurnCancel(_) => "turn.cancel",
        CoreCommand::RiskResolve(_) => "risk.resolve",
        CoreCommand::SlashCatalog(_) => "slash.catalog",
        CoreCommand::SlashExecute(_) => "slash.execute",
        CoreCommand::PathComplete(_) => "path.complete",
        CoreCommand::ModelCatalog(_) => "catalog.models",
        CoreCommand::ModelSelect(_) => "model.select",
        CoreCommand::ReasoningSet(_) => "reasoning.set",
        CoreCommand::SettingsPatch(_) => "settings.patch",
        CoreCommand::TranscriptPage(_) => "transcript.page",
        CoreCommand::ContentRead(_) => "content.read",
        CoreCommand::SetupStatus(_) => "setup.status",
        CoreCommand::SetupApply(_) => "setup.apply",
        CoreCommand::AuthLogin(_) => "auth.login",
        CoreCommand::AuthLogout(_) => "auth.logout",
        CoreCommand::ConsentResolve(_) => "consent.resolve",
        CoreCommand::RuntimePing(_) => "runtime.ping",
        CoreCommand::Shutdown(_) => "runtime.shutdown",
    }
}

/// Exact command/result pairing from section 12: required success variant for
/// each command, as the success `type` tag.
pub fn expected_success_variant(command: &CoreCommand) -> &'static str {
    match command {
        CoreCommand::SessionCreate(_)
        | CoreCommand::SessionResume(_)
        | CoreCommand::SessionNew(_) => "session_opened",
        CoreCommand::SessionEnd(_) => "session_ended",
        CoreCommand::SessionSnapshot(_) => "session_snapshot",
        CoreCommand::SessionClear(_) => "session_cleared",
        CoreCommand::TurnSubmit(_) => "turn_submitted",
        CoreCommand::TurnCancel(_) => "turn_cancellation",
        CoreCommand::RiskResolve(_) => "risk_resolved",
        CoreCommand::SlashCatalog(_) => "slash_catalog",
        CoreCommand::SlashExecute(_) => "slash_executed",
        CoreCommand::PathComplete(_) => "path_completion",
        CoreCommand::ModelCatalog(_) => "model_catalog",
        CoreCommand::ModelSelect(_) => "model_selected",
        CoreCommand::ReasoningSet(_) => "reasoning_set",
        CoreCommand::SettingsPatch(_) => "settings_patched",
        CoreCommand::TranscriptPage(_) => "transcript_page",
        CoreCommand::ContentRead(_) => "content_read",
        CoreCommand::SetupStatus(_) => "setup_status",
        CoreCommand::SetupApply(_) => "setup_applied",
        CoreCommand::AuthLogin(_) => "auth_login",
        CoreCommand::AuthLogout(_) => "auth_logout",
        CoreCommand::ConsentResolve(_) => "consent_resolved",
        CoreCommand::RuntimePing(_) => "runtime_pong",
        CoreCommand::Shutdown(_) => "shutdown_admitted",
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionCreateCommand {
    pub operation_id: OperationId,
    pub cwd: String,
    pub config_path: Option<String>,
    pub incognito: bool,
    pub debug: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionResumeCommand {
    pub operation_id: OperationId,
    pub locator: SessionLocator,
    pub cwd: String,
    pub after_canonical_sequence: Option<u64>,
    pub debug: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionEndReason {
    Clean,
    Aborted,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionEndCommand {
    pub operation_id: OperationId,
    pub reason: SessionEndReason,
    pub memory_grace_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionSnapshotCommand {
    pub include_boot: bool,
    pub include_pending_confirmations: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionClearCommand {
    pub operation_id: OperationId,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionNewCommand {
    pub operation_id: OperationId,
    pub cwd: String,
    pub config_path: Option<String>,
    pub incognito: bool,
    pub debug: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnSubmitCommand {
    pub operation_id: OperationId,
    pub text: String,
    pub client_submitted_at_ms: i64,
}

impl TurnSubmitCommand {
    /// Normalize CRLF/CR to LF without trimming, then validate bounds.
    pub fn normalized_text(&self) -> Result<String, String> {
        let text = self.text.replace("\r\n", "\n").replace('\r', "\n");
        if text.contains('\0') {
            return Err("turn text contains NUL".to_string());
        }
        let len = text.len();
        if len == 0 || len > MAX_TURN_TEXT_BYTES {
            return Err(format!("turn text length {len} out of range"));
        }
        Ok(text)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnCancelReason {
    UserInterrupt,
    UiShutdown,
    SessionEnd,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnCancelCommand {
    pub operation_id: OperationId,
    pub turn_id: TurnId,
    pub reason: TurnCancelReason,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimePingCommand {}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShutdownReason {
    UiExit,
    Signal,
    ParentExit,
    FatalError,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShutdownCommand {
    pub operation_id: OperationId,
    pub reason: ShutdownReason,
    pub grace_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiskDecision {
    AllowOnce,
    Deny,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RiskResolveCommand {
    pub operation_id: OperationId,
    pub confirmation_id: ConfirmationId,
    pub decision: RiskDecision,
    pub argument_sha256: Sha256Digest,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SlashCatalogCommand {
    pub query: String,
    pub cursor: Option<SlashCatalogCursor>,
    pub limit: u16,
}

impl SlashCatalogCommand {
    pub fn validate(&self) -> Result<(), String> {
        if self.limit == 0 || self.limit > 200 {
            return Err(format!("slash limit {} out of range 1..=200", self.limit));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SlashExecuteCommand {
    pub operation_id: OperationId,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PathCompleteCommand {
    pub token: String,
    pub cursor: Option<PathCompletionCursor>,
    pub limit: u16,
}

impl PathCompleteCommand {
    pub fn validate(&self) -> Result<(), String> {
        if self.limit == 0 || self.limit > 100 {
            return Err(format!("path limit {} out of range 1..=100", self.limit));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelCatalogCommand {
    pub provider: Option<ProviderId>,
    pub query: String,
    pub cursor: Option<ModelCatalogCursor>,
    pub limit: u16,
    pub refresh: bool,
}

impl ModelCatalogCommand {
    pub fn validate(&self) -> Result<(), String> {
        if self.limit == 0 || self.limit > 200 {
            return Err(format!("model limit {} out of range 1..=200", self.limit));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelSelectCommand {
    pub operation_id: OperationId,
    pub provider: ProviderId,
    pub model_id: ModelId,
    pub reasoning_effort: crate::ui_contract::catalog::ReasoningEffort,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReasoningSetCommand {
    pub operation_id: OperationId,
    pub level: crate::ui_contract::catalog::ReasoningEffort,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SettingsPatchCommand {
    pub operation_id: OperationId,
    pub expected_revision: u64,
    pub changes: crate::ui_contract::settings::SettingsPatchDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TranscriptPageCommand {
    pub cursor: Option<TranscriptCursor>,
    pub direction: TranscriptDirection,
    pub limit_groups: u16,
}

impl TranscriptPageCommand {
    pub fn validate(&self) -> Result<(), String> {
        if self.limit_groups == 0 || self.limit_groups > 50 {
            return Err(format!(
                "group limit {} out of range 1..=50",
                self.limit_groups
            ));
        }
        match self.direction {
            TranscriptDirection::Tail => {
                if self.cursor.is_some() {
                    return Err("tail requires a null cursor".to_string());
                }
            }
            TranscriptDirection::Before | TranscriptDirection::After => {
                if self.cursor.is_none() {
                    return Err("before/after require a cursor".to_string());
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContentReadCommand {
    pub reference: ContentRefDto,
    pub selection: ContentSelectionDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupStatusCommand {}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetupApplyCommand {
    pub operation_id: OperationId,
    pub expected_revision: u64,
    pub provider: ProviderId,
    pub model_id: ModelId,
    pub values: BTreeMap<SetupFieldId, SetupValueDto>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthLoginCommand {
    pub operation_id: OperationId,
    pub provider: ProviderId,
    pub method: AuthMethodDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthLogoutCommand {
    pub operation_id: OperationId,
    pub provider: ProviderId,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConsentResolveCommand {
    pub operation_id: OperationId,
    pub consent_id: crate::ui_contract::ids::ConsentId,
    pub purpose: String,
    pub version: String,
    pub decision: crate::ui_contract::setup::ConsentChoice,
}

/// Resolve a 12-character selector against session manifests.
///
/// Returns zero/one match behavior; two or more matches is ambiguous and the
/// core never chooses the newest match.
pub fn resolve_resume_selector<'a>(
    selector: &ResumeSelector,
    manifests: &'a [SessionId],
) -> Result<&'a SessionId, SelectorResolutionError> {
    let mut matches: Vec<&'a SessionId> = manifests
        .iter()
        .filter(|id| id.to_string().starts_with(selector.as_str()))
        .collect();
    matches.sort_by_key(|a| a.to_string());
    match matches.len() {
        0 => Err(SelectorResolutionError::NotFound),
        1 => Ok(matches[0]),
        _ => Err(SelectorResolutionError::Ambiguous(
            matches.into_iter().cloned().collect(),
        )),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SelectorResolutionError {
    NotFound,
    Ambiguous(Vec<SessionId>),
}

/// Validate that an echoed content cursor is bound to its issuing session.
pub fn check_content_cursor_binding(
    issued_session: &SessionId,
    echo_session: &SessionId,
    _cursor: &ContentCursor,
) -> Result<(), String> {
    if issued_session != echo_session {
        return Err("cursor_invalid".to_string());
    }
    Ok(())
}
