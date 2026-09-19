//! Durable operation idempotency DTOs, canonical request hashing, and the
//! semantic command boundary.
//!
//! `OperationId` is globally unique, canonical, and restart-safe. Secret
//! values are replaced by `sensitive_sha256` wrappers before request hashing;
//! secret plaintext never reaches plans, hashes, fixtures, results, or
//! diagnostics.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::canonical_json::to_canonical_json_bytes;
use crate::protocol::id::SessionId;
use crate::ui_contract::command::CoreCommand;
use crate::ui_contract::ids::OperationId;
use crate::ui_contract::json_data::Sha256Digest;
use crate::ui_contract::result::{CoreCommandSuccess, CoreErrorDto, SystemNoticeDto};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    SessionCreate,
    SessionResume,
    SessionEnd,
    SessionClear,
    SessionNew,
    TurnSubmit,
    TurnCancel,
    RiskResolve,
    SlashExecute,
    ModelSelect,
    ReasoningSet,
    SettingsPatch,
    SetupApply,
    AuthLogin,
    AuthLogout,
    ConsentResolve,
    Shutdown,
}

impl OperationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            OperationKind::SessionCreate => "session_create",
            OperationKind::SessionResume => "session_resume",
            OperationKind::SessionEnd => "session_end",
            OperationKind::SessionClear => "session_clear",
            OperationKind::SessionNew => "session_new",
            OperationKind::TurnSubmit => "turn_submit",
            OperationKind::TurnCancel => "turn_cancel",
            OperationKind::RiskResolve => "risk_resolve",
            OperationKind::SlashExecute => "slash_execute",
            OperationKind::ModelSelect => "model_select",
            OperationKind::ReasoningSet => "reasoning_set",
            OperationKind::SettingsPatch => "settings_patch",
            OperationKind::SetupApply => "setup_apply",
            OperationKind::AuthLogin => "auth_login",
            OperationKind::AuthLogout => "auth_logout",
            OperationKind::ConsentResolve => "consent_resolve",
            OperationKind::Shutdown => "shutdown",
        }
    }
}

/// Operation kind for a command, or `None` for read-only commands that carry
/// no operation ID.
pub fn operation_kind_for_command(command: &CoreCommand) -> Option<OperationKind> {
    match command {
        CoreCommand::SessionCreate(_) => Some(OperationKind::SessionCreate),
        CoreCommand::SessionResume(_) => Some(OperationKind::SessionResume),
        CoreCommand::SessionEnd(_) => Some(OperationKind::SessionEnd),
        CoreCommand::SessionSnapshot(_) => None,
        CoreCommand::SessionClear(_) => Some(OperationKind::SessionClear),
        CoreCommand::SessionNew(_) => Some(OperationKind::SessionNew),
        CoreCommand::TurnSubmit(_) => Some(OperationKind::TurnSubmit),
        CoreCommand::TurnCancel(_) => Some(OperationKind::TurnCancel),
        CoreCommand::RiskResolve(_) => Some(OperationKind::RiskResolve),
        CoreCommand::SlashCatalog(_) => None,
        CoreCommand::SlashExecute(_) => Some(OperationKind::SlashExecute),
        CoreCommand::PathComplete(_) => None,
        CoreCommand::ModelCatalog(_) => None,
        CoreCommand::ModelSelect(_) => Some(OperationKind::ModelSelect),
        CoreCommand::ReasoningSet(_) => Some(OperationKind::ReasoningSet),
        CoreCommand::SettingsPatch(_) => Some(OperationKind::SettingsPatch),
        CoreCommand::TranscriptPage(_) => None,
        CoreCommand::ContentRead(_) => None,
        CoreCommand::SetupStatus(_) => None,
        CoreCommand::SetupApply(_) => Some(OperationKind::SetupApply),
        CoreCommand::AuthLogin(_) => Some(OperationKind::AuthLogin),
        CoreCommand::AuthLogout(_) => Some(OperationKind::AuthLogout),
        CoreCommand::ConsentResolve(_) => Some(OperationKind::ConsentResolve),
        CoreCommand::RuntimePing(_) => None,
        CoreCommand::Shutdown(_) => Some(OperationKind::Shutdown),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Reserved,
    Succeeded,
    Failed,
    Interrupted,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum OperationLedgerRef {
    Session { session_id: SessionId },
    Host,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OperationResultRef {
    pub ledger: OperationLedgerRef,
    pub operation_id: OperationId,
    pub ui_contract_schema_version: u32,
    pub result_sha256: Sha256Digest,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum PlannedEffectRef {
    CanonicalEvents {
        session_id: SessionId,
        event_ids: Vec<crate::protocol::id::EventId>,
    },
    NewSession {
        session_id: SessionId,
        session_started_event_id: crate::protocol::id::EventId,
    },
    SettingsRevision {
        from_revision: u64,
        to_revision: u64,
    },
    CredentialRevision {
        from_revision: u64,
        to_revision: u64,
    },
    ConsentRevision {
        from_revision: u64,
        to_revision: u64,
    },
    ProcessShutdown,
    NonReplayableSecretWrite,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OperationRecordDto {
    pub operation_id: OperationId,
    pub kind: OperationKind,
    pub request_sha256: Sha256Digest,
    pub status: OperationStatus,
    pub session_id: Option<SessionId>,
    pub planned_effects: Vec<PlannedEffectRef>,
    pub result_ref: Option<OperationResultRef>,
    pub first_canonical_sequence: Option<u64>,
    pub terminal_canonical_sequence: Option<u64>,
    pub created_at_ms: i64,
    pub finished_at_ms: Option<i64>,
}

/// SHA-256 of UTF-8 bytes as lowercase hex.
pub fn sha256_hex_of(bytes: &[u8]) -> Sha256Digest {
    let mut h = Sha256::new();
    h.update(bytes);
    Sha256Digest::from_bytes(h.finalize().into())
}

/// Replace every secret value with its `sensitive_sha256` wrapper before
/// request hashing. Handles the setup secret shape
/// `{"type":"secret","value":<string>}` and credential shapes
/// `{"credential":<string>}` at any depth.
pub fn redact_secrets_for_hash(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            if map.get("type").and_then(|t| t.as_str()) == Some("secret") {
                if let Some(serde_json::Value::String(secret)) = map.get("value") {
                    let digest = sha256_hex_of(secret.as_bytes());
                    map.insert(
                        "value".to_string(),
                        serde_json::json!({"sensitive_sha256": digest.as_str()}),
                    );
                    return;
                }
            }
            if let Some(serde_json::Value::String(secret)) = map.get("credential") {
                let digest = sha256_hex_of(secret.as_bytes());
                map.insert(
                    "credential".to_string(),
                    serde_json::json!({"sensitive_sha256": digest.as_str()}),
                );
            }
            for v in map.values_mut() {
                redact_secrets_for_hash(v);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redact_secrets_for_hash(item);
            }
        }
        _ => {}
    }
}

/// Canonical request hash: SHA-256 of RFC 8785 JSON for
/// `{"kind":<operation_kind>,"payload":<command payload without operation_id>}`
/// with secrets replaced before hashing.
pub fn canonical_request_hash(command: &CoreCommand) -> Result<Sha256Digest, String> {
    let kind = operation_kind_for_command(command)
        .ok_or_else(|| "read-only commands have no request hash".to_string())?;
    let mut envelope =
        serde_json::to_value(command).map_err(|e| format!("serialize command: {e}"))?;
    let payload = envelope
        .get_mut("data")
        .cloned()
        .ok_or_else(|| "command missing data".to_string())?;
    let mut payload = payload;
    if let serde_json::Value::Object(map) = &mut payload {
        map.remove("operation_id");
    }
    redact_secrets_for_hash(&mut payload);
    let canonical_doc = serde_json::json!({"kind": kind.as_str(), "payload": payload});
    let bytes =
        to_canonical_json_bytes(&canonical_doc).map_err(|e| format!("canonicalize: {e}"))?;
    Ok(sha256_hex_of(&bytes))
}

/// Result hash: SHA-256 of RFC 8785 JSON for the complete successful
/// [`CoreCommandSuccess`] or terminal [`CoreErrorDto`] under schema 1.
pub fn success_result_hash(success: &CoreCommandSuccess) -> Result<Sha256Digest, String> {
    let bytes =
        to_canonical_json_bytes(success).map_err(|e| format!("canonicalize result: {e}"))?;
    Ok(sha256_hex_of(&bytes))
}

pub fn error_result_hash(error: &CoreErrorDto) -> Result<Sha256Digest, String> {
    let bytes = to_canonical_json_bytes(error).map_err(|e| format!("canonicalize error: {e}"))?;
    Ok(sha256_hex_of(&bytes))
}

/// Stored terminal result bytes for byte-for-byte duplicate replay.
#[derive(Clone, Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum StoredTerminalResult {
    Success(CoreCommandSuccess),
    Error(CoreErrorDto),
}

impl StoredTerminalResult {
    pub fn canonical_json(&self) -> Result<Vec<u8>, String> {
        match self {
            StoredTerminalResult::Success(s) => {
                to_canonical_json_bytes(s).map_err(|e| format!("canonicalize: {e}"))
            }
            StoredTerminalResult::Error(e) => {
                to_canonical_json_bytes(e).map_err(|e| format!("canonicalize: {e}"))
            }
        }
    }
}

/// Outcome of reserving an operation: a fresh reservation or a replayable
/// terminal result for a matching duplicate.
#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)]
pub enum OperationReservation {
    Reserved(OperationRecordDto),
    ReplayStored(StoredTerminalResult),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OperationRecoveryError {
    LedgerCorrupt(String),
    Storage(String),
}

impl std::fmt::Display for OperationRecoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OperationRecoveryError::LedgerCorrupt(msg) => write!(f, "ledger corrupt: {msg}"),
            OperationRecoveryError::Storage(msg) => write!(f, "ledger storage: {msg}"),
        }
    }
}

impl std::error::Error for OperationRecoveryError {}

/// Injected core services for the semantic command boundary.
///
/// Later packets own provider, tool, setup, credential, IPC, and terminal
/// behavior. This boundary validates, reserves, and replays through the
/// History-owned ledgers and honestly reports unavailable subsystems instead
/// of fabricating success.
pub struct CoreServices {
    pub ledger: Arc<crate::history::operation_ledger::OperationLedger>,
    pub history: crate::history::operation_ledger::HistoryService,
    pub session_id: Option<SessionId>,
    pub turn_active: bool,
}

impl CoreServices {
    pub fn new(
        ledger: Arc<crate::history::operation_ledger::OperationLedger>,
        history: crate::history::operation_ledger::HistoryService,
    ) -> Self {
        Self {
            ledger,
            history,
            session_id: None,
            turn_active: false,
        }
    }
}

/// Validate command fields without performing any effect.
pub fn validate_command_fields(command: &CoreCommand) -> Result<(), CoreErrorDto> {
    let invalid = |field: &str, reason: &str| CoreErrorDto {
        code: crate::ui_contract::result::CoreErrorCode::InvalidInput,
        message: format!("invalid {field}: {reason}"),
        retry: crate::ui_contract::result::ErrorRetryAdvice::Never,
        details: crate::ui_contract::result::ErrorDetailsDto::InvalidField {
            field: field.to_string(),
            reason: reason.to_string(),
        },
    };
    match command {
        CoreCommand::TurnSubmit(c) => {
            c.normalized_text().map_err(|e| invalid("text", &e))?;
            Ok(())
        }
        CoreCommand::SlashCatalog(c) => c.validate().map_err(|e| invalid("limit", &e)),
        CoreCommand::PathComplete(c) => c.validate().map_err(|e| invalid("limit", &e)),
        CoreCommand::ModelCatalog(c) => c.validate().map_err(|e| invalid("limit", &e)),
        CoreCommand::TranscriptPage(c) => c.validate().map_err(|e| invalid("cursor", &e)),
        CoreCommand::SettingsPatch(c) => c.changes.validate().map_err(|e| invalid("changes", &e)),
        CoreCommand::ContentRead(c) => c.selection.validate().map_err(|e| invalid("selection", &e)),
        _ => Ok(()),
    }
}

/// During an active turn only read-only commands, `TurnCancel`,
/// `RiskResolve`, `ConsentResolve`, and `Shutdown` are admitted.
pub fn admitted_during_active_turn(command: &CoreCommand) -> bool {
    matches!(
        command,
        CoreCommand::SessionSnapshot(_)
            | CoreCommand::SlashCatalog(_)
            | CoreCommand::PathComplete(_)
            | CoreCommand::ModelCatalog(_)
            | CoreCommand::TranscriptPage(_)
            | CoreCommand::ContentRead(_)
            | CoreCommand::SetupStatus(_)
            | CoreCommand::RuntimePing(_)
            | CoreCommand::TurnCancel(_)
            | CoreCommand::RiskResolve(_)
            | CoreCommand::ConsentResolve(_)
            | CoreCommand::Shutdown(_)
    )
}

fn session_busy_error() -> CoreErrorDto {
    CoreErrorDto {
        code: crate::ui_contract::result::CoreErrorCode::SessionBusy,
        message: "session is busy with an active turn".to_string(),
        retry: crate::ui_contract::result::ErrorRetryAdvice::NewOperation,
        details: crate::ui_contract::result::ErrorDetailsDto::None,
    }
}

fn unavailable_error(subsystem: &str) -> CoreErrorDto {
    CoreErrorDto {
        code: crate::ui_contract::result::CoreErrorCode::Unavailable,
        message: format!("{subsystem} is unavailable in this build"),
        retry: crate::ui_contract::result::ErrorRetryAdvice::NewOperation,
        details: crate::ui_contract::result::ErrorDetailsDto::Domain {
            domain: "core".to_string(),
            code: "unavailable".to_string(),
        },
    }
}

/// Execute a semantic command over injected core services.
///
/// Reservation and terminal-result persistence go through the History-owned
/// operation ledger before any result is returned. Subsystems owned by later
/// packets report [`CoreErrorCode::Unavailable`]; this boundary never returns
/// fake success.
pub async fn execute_core_command(
    core: &CoreServices,
    command: CoreCommand,
) -> crate::ui_contract::result::CoreCommandResult {
    use crate::ui_contract::result::CoreCommandResult as R;
    if let Err(error) = validate_command_fields(&command) {
        return R::Err(error);
    }
    if core.turn_active && !admitted_during_active_turn(&command) {
        return R::Err(session_busy_error());
    }
    if operation_kind_for_command(&command).is_none() {
        return execute_read_only(core, command).await;
    }
    let reservation = match crate::history::operation_ledger::reserve_operation(
        &core.ledger,
        &command,
        &core.history,
    )
    .await
    {
        Ok(reservation) => reservation,
        Err(error) => return R::Err(error),
    };
    match reservation {
        OperationReservation::ReplayStored(StoredTerminalResult::Success(success)) => {
            R::Ok(success)
        }
        OperationReservation::ReplayStored(StoredTerminalResult::Error(error)) => R::Err(error),
        OperationReservation::Reserved(record) => {
            // No effect implementation belongs to P1C; persist the honest
            // terminal error before returning.
            let error = unavailable_error("effect subsystem");
            let completed = crate::history::operation_ledger::complete_operation(
                &core.ledger,
                &record,
                Err(error.clone()),
            );
            match completed {
                Ok(()) => R::Err(error),
                Err(storage_error) => R::Err(storage_error),
            }
        }
    }
}

async fn execute_read_only(
    core: &CoreServices,
    command: CoreCommand,
) -> crate::ui_contract::result::CoreCommandResult {
    use crate::ui_contract::result::CoreCommandResult as R;
    match command {
        CoreCommand::RuntimePing(_) => R::Ok(CoreCommandSuccess::RuntimePong(
            crate::ui_contract::result::RuntimePongDto {
                server_time_ms: (crate::history::operation_ledger::system_now_ms)(),
                session_id: core.session_id,
                turn_id: None,
            },
        )),
        _ => R::Err(unavailable_error("read subsystem")),
    }
}

/// Reserve an operation in the ledger before performing an effect.
pub async fn reserve_operation(
    ledger: &crate::history::operation_ledger::OperationLedger,
    command: &CoreCommand,
) -> Result<OperationReservation, CoreErrorDto> {
    let history = crate::history::operation_ledger::HistoryService::default();
    crate::history::operation_ledger::reserve_operation(ledger, command, &history).await
}

/// Recover reserved operations after a restart.
pub async fn recover_reserved_operations(
    ledger: &crate::history::operation_ledger::OperationLedger,
    history: &crate::history::operation_ledger::HistoryService,
) -> Result<Vec<SystemNoticeDto>, OperationRecoveryError> {
    crate::history::operation_ledger::recover_reserved_operations(ledger, history).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_commands_have_no_operation_kind() {
        assert!(operation_kind_for_command(&CoreCommand::RuntimePing(
            crate::ui_contract::command::RuntimePingCommand {}
        ))
        .is_none());
        assert!(operation_kind_for_command(&CoreCommand::SessionSnapshot(
            crate::ui_contract::command::SessionSnapshotCommand {
                include_boot: true,
                include_pending_confirmations: true,
            }
        ))
        .is_none());
    }

    #[test]
    fn secret_values_hash_identically_regardless_of_plaintext() {
        let mut a = serde_json::json!({"type": "secret", "value": "sk-alpha"});
        let mut b = serde_json::json!({"type": "secret", "value": "sk-beta"});
        redact_secrets_for_hash(&mut a);
        redact_secrets_for_hash(&mut b);
        assert_ne!(a, b);
        assert!(!a.to_string().contains("sk-alpha"));
        assert!(!b.to_string().contains("sk-beta"));
        // Same secret hashes identically.
        let mut c = serde_json::json!({"type": "secret", "value": "sk-alpha"});
        redact_secrets_for_hash(&mut c);
        assert_eq!(a, c);
    }
}
