//! Stable tool error codes. Protocol mapping follows Appendix A.

use serde::{Deserialize, Serialize};

use crate::protocol::errors::ErrorClass;
use crate::protocol::tool_result::ToolResultStatus;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ToolErrorCode {
    ToolUnknown,
    ToolInputTooLarge,
    ToolInvalidJson,
    ToolSchemaInvalid,
    ToolUnavailable,
    ToolUnsupported,
    ToolPlanBlocked,
    ToolValidationFailed,
    ToolPathNotFound,
    ToolPathOutsideWorkspace,
    ToolPathUnread,
    ToolPathBusy,
    ToolRiskDeclined,
    ToolRiskHeadlessDenied,
    ToolCircuitOpen,
    ToolCancelled,
    ToolTimedOut,
    ToolPanicked,
    ToolIoFailed,
    ToolProcessSpawnFailed,
    ToolProcessExitNonzero,
    ToolProcessOutputLimit,
    ToolSerializationFailed,
    ToolRedactionFailed,
    ToolArtifactFailed,
    ToolInternal,
    MemoryUnavailable,
    MemoryTimeout,
    MemoryCancelled,
    MemoryInvalidInput,
    MemoryNotFound,
    MemoryPluginFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolError {
    code: ToolErrorCode,
    message: String,
    details: Option<serde_json::Value>,
    binary: bool,
}

impl ToolError {
    pub fn new(code: ToolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: bound_message(&message.into()),
            details: None,
            binary: false,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn mark_binary(mut self) -> Self {
        self.binary = true;
        self
    }

    pub fn is_binary(&self) -> bool {
        self.binary
    }

    pub fn code(&self) -> ToolErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn details(&self) -> Option<&serde_json::Value> {
        self.details.as_ref()
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", code_name(self.code), self.message)
    }
}

impl std::error::Error for ToolError {}

fn bound_message(message: &str) -> String {
    let redacted = crate::redaction::redact_text_v1(message)
        .map(|out| out.text)
        .unwrap_or_else(|_| "redaction failed".to_owned());
    let mut out = String::new();
    for ch in redacted.chars() {
        if out.len() + ch.len_utf8() > 512 {
            break;
        }
        if ch == '\0' {
            continue;
        }
        out.push(ch);
    }
    out
}

pub struct MappedToolError {
    pub canonical_code: &'static str,
    pub class: ErrorClass,
    pub status: ToolResultStatus,
    pub retryable: bool,
}

pub fn map_tool_error(code: ToolErrorCode) -> MappedToolError {
    use ErrorClass as C;
    use ToolErrorCode as E;
    use ToolResultStatus as S;
    let (class, status, retryable) = match code {
        E::ToolUnknown
        | E::ToolInvalidJson
        | E::ToolSchemaInvalid
        | E::ToolInputTooLarge
        | E::ToolUnsupported => (C::Validation, S::Error, false),
        E::ToolUnavailable => (C::Unavailable, S::Error, true),
        E::ToolPlanBlocked
        | E::ToolRiskDeclined
        | E::ToolRiskHeadlessDenied
        | E::ToolCircuitOpen => (C::Policy, S::Blocked, false),
        E::ToolValidationFailed
        | E::ToolPathNotFound
        | E::ToolPathOutsideWorkspace
        | E::ToolPathUnread => (C::Validation, S::Error, false),
        E::ToolPathBusy => (C::Conflict, S::Blocked, true),
        E::ToolCancelled => (C::Cancelled, S::Cancelled, true),
        E::ToolTimedOut => (C::Timeout, S::Error, true),
        E::ToolPanicked => (C::ProcessCrash, S::Error, false),
        E::ToolIoFailed
        | E::ToolProcessSpawnFailed
        | E::ToolProcessExitNonzero
        | E::ToolProcessOutputLimit
        | E::ToolSerializationFailed
        | E::ToolArtifactFailed
        | E::ToolInternal => (C::Internal, S::Error, false),
        E::ToolRedactionFailed => (C::Integrity, S::Error, false),
        E::MemoryUnavailable => (C::Unavailable, S::Error, false),
        E::MemoryTimeout => (C::Timeout, S::Error, false),
        E::MemoryCancelled => (C::Cancelled, S::Cancelled, true),
        E::MemoryInvalidInput => (C::Validation, S::Error, false),
        E::MemoryNotFound => (C::NotFound, S::Error, false),
        E::MemoryPluginFailed => (C::Internal, S::Error, false),
    };
    MappedToolError {
        canonical_code: code_name(code),
        class,
        status,
        retryable,
    }
}

pub fn map_skipped_uncertain_peer() -> MappedToolError {
    MappedToolError {
        canonical_code: "E_TOOL_SKIPPED_UNCERTAIN_PEER",
        class: ErrorClass::Policy,
        status: ToolResultStatus::Skipped,
        retryable: false,
    }
}

pub fn map_side_effect_uncertain() -> MappedToolError {
    MappedToolError {
        canonical_code: "E_TOOL_SIDE_EFFECT_UNCERTAIN",
        class: ErrorClass::ProcessCrash,
        status: ToolResultStatus::Uncertain,
        retryable: false,
    }
}

/// Appendix A.4 canonical mapping, catalog §6.4 `ToolErrorCode`, and the
/// optional Appendix A.4 tool-surface class/status/retryability override.
type HistoryCodeRow = (
    &'static str,
    ToolErrorCode,
    Option<(ErrorClass, ToolResultStatus, bool)>,
);

/// History code → (canonical code, catalog §6.4 `ToolErrorCode`,
/// Appendix A.4 tool-surface override). The override is `Some` exactly when
/// Appendix A.4 assigns a status to the code when it is called as a tool;
/// every other code takes class/status/retryability from its `ToolErrorCode`
/// in Appendix A.3 (catalog §6.4).
fn history_code_row(history_code: &str) -> Option<HistoryCodeRow> {
    use ToolErrorCode as E;
    let row = match history_code {
        "HISTORY_ARTIFACT_NOT_FOUND" => (
            "E_ARTIFACT_NOT_FOUND",
            E::ToolValidationFailed,
            Some((ErrorClass::NotFound, ToolResultStatus::Error, false)),
        ),
        "HISTORY_SOURCE_NOT_FOUND" => (
            "E_HISTORY_SOURCE_NOT_FOUND",
            E::ToolValidationFailed,
            Some((ErrorClass::NotFound, ToolResultStatus::Error, false)),
        ),
        "HISTORY_SEARCH_QUERY"
        | "HISTORY_REGEX_INVALID"
        | "HISTORY_REGEX_UNSUPPORTED"
        | "HISTORY_ARTIFACT_RANGE"
        | "HISTORY_JSON_POINTER"
        | "HISTORY_SELECTOR_UNSUPPORTED" => (
            "E_HISTORY_QUERY_INVALID",
            E::ToolValidationFailed,
            Some((ErrorClass::Validation, ToolResultStatus::Error, false)),
        ),
        "HISTORY_ARTIFACT_TOO_LARGE" => (
            "E_HISTORY_RESULT_TOO_LARGE",
            E::ToolValidationFailed,
            Some((ErrorClass::Validation, ToolResultStatus::Error, true)),
        ),
        "HISTORY_PREVIEW_BOUND" => (
            "E_HISTORY_RESULT_TOO_LARGE",
            E::ToolInternal,
            Some((ErrorClass::Validation, ToolResultStatus::Error, false)),
        ),
        "HISTORY_SEARCH_CURSOR_STALE" => (
            "E_HISTORY_CURSOR_STALE",
            E::ToolValidationFailed,
            Some((ErrorClass::Conflict, ToolResultStatus::Error, true)),
        ),
        "HISTORY_ROLLBACK_CONFLICT" => (
            "E_TOOL_SIDE_EFFECT_UNCERTAIN",
            E::ToolInternal,
            Some((ErrorClass::Integrity, ToolResultStatus::Uncertain, false)),
        ),
        "HISTORY_OPERATIONAL_RECOVERY_UNCERTAIN" => (
            "E_TOOL_SIDE_EFFECT_UNCERTAIN",
            E::ToolInternal,
            Some((ErrorClass::ProcessCrash, ToolResultStatus::Uncertain, false)),
        ),
        "HISTORY_CANCELLED" => ("E_HISTORY_CANCELLED", E::ToolCancelled, None),
        "HISTORY_SESSION_LOCKED" => ("E_SESSION_LOCKED", E::ToolInternal, None),
        "HISTORY_SQLITE_BUSY" => ("E_HISTORY_BUSY", E::ToolUnavailable, None),
        "HISTORY_SQLITE_PRAGMA_FAILED" => ("E_HISTORY_UNAVAILABLE", E::ToolInternal, None),
        "HISTORY_EVENT_INTEGRITY"
        | "HISTORY_INSECURE_PERMISSIONS"
        | "HISTORY_META_MISMATCH"
        | "HISTORY_CANONICAL_DB_CORRUPT" => ("E_SESSION_INTEGRITY_FAILED", E::ToolInternal, None),
        "HISTORY_SCHEMA_UNSUPPORTED" => ("E_SCHEMA_VERSION_UNSUPPORTED", E::ToolInternal, None),
        "HISTORY_DANGLING_ARTIFACT" => ("E_ARTIFACT_MISSING", E::ToolInternal, None),
        "HISTORY_IO" => ("E_HISTORY_PERSISTENCE", E::ToolIoFailed, None),
        _ => return None,
    };
    Some(row)
}

/// Appendix A.4 canonical mapping for History codes on the tool surface,
/// with catalog §6.4 tool-surface class and retryability.
pub fn map_history_error(history_code: &str) -> MappedToolError {
    let Some((canonical, code, override_class)) = history_code_row(history_code) else {
        return map_tool_error(ToolErrorCode::ToolInternal);
    };
    if let Some((class, status, retryable)) = override_class {
        return MappedToolError {
            canonical_code: canonical,
            class,
            status,
            retryable,
        };
    }
    let base = map_tool_error(code);
    MappedToolError {
        canonical_code: canonical,
        class: base.class,
        status: base.status,
        retryable: base.retryable,
    }
}

/// Catalog §6.4 tool-surface mapping: a History code that Appendix A.4 marks
/// `error when called as a tool` keeps A.4's class, status, and retryability;
/// every other code (history or not) takes class/status/retryability from its
/// `ToolErrorCode`'s Appendix A.3 mapping. History codes carry their mapping
/// in `ToolErrorDto.details.history_code`.
pub fn map_result_error_surface(
    code: ToolErrorCode,
    details: Option<&serde_json::Value>,
) -> MappedToolError {
    if let Some(history_code) = details
        .and_then(|details| details.get("history_code"))
        .and_then(|value| value.as_str())
    {
        return map_history_error(history_code);
    }
    if let Some(state_code) = details
        .and_then(|details| details.get("state_code"))
        .and_then(|value| value.as_str())
    {
        return map_state_error(state_code);
    }
    map_tool_error(code)
}

/// Catalog §7.3 / Protocol Appendix A.6. `STATE_PERSISTENCE` is not retryable
/// on the tool surface.
pub fn map_state_error(state_code: &str) -> MappedToolError {
    use ErrorClass as C;
    use ToolResultStatus as S;
    let (class, status, retryable) = match state_code {
        "STATE_NOT_FOUND" => (C::NotFound, S::Error, false),
        "STATE_RETRACTED"
        | "STATE_KIND_MISMATCH"
        | "STATE_INVALID_TRANSITION"
        | "STATE_INVALID_SOURCE"
        | "STATE_DUPLICATE_ID"
        | "STATE_NO_CHANGE"
        | "STATE_FOCUS_INVALID"
        | "STATE_FIELD_LIMIT"
        | "STATE_OBJECT_LIMIT" => (C::Validation, S::Error, false),
        "STATE_REVISION_CONFLICT" | "STATE_GRAPH_SEQUENCE_CONFLICT" | "STATE_CURSOR_STALE" => {
            (C::Conflict, S::Error, true)
        }
        "STATE_ACTIVE_BUDGET_EXCEEDED" => (C::ContextLength, S::Error, true),
        "STATE_CANCELLED" => (C::Cancelled, S::Cancelled, true),
        "STATE_PERSISTENCE" => (C::Persistence, S::Error, false),
        "STATE_PROJECTION_INTEGRITY" => (C::Integrity, S::Error, false),
        _ => (C::Internal, S::Error, false),
    };
    MappedToolError {
        canonical_code: code_name(crate::state::outer_tool_code(state_code)),
        class,
        status,
        retryable,
    }
}

/// Catalog §6.4: `ToolErrorDto.details` is exactly
/// `{"canonical_code": <A.4 E_* code>, "history_code": <HISTORY_* code>}`.
pub fn history_tool_error(history_code: &str, message: impl Into<String>) -> ToolError {
    let mapped = map_history_error(history_code);
    let code = history_code_row(history_code)
        .map(|(_, code, _)| code)
        .unwrap_or(ToolErrorCode::ToolInternal);
    ToolError::new(code, message).with_details(serde_json::json!({
        "canonical_code": mapped.canonical_code,
        "history_code": history_code,
    }))
}

pub fn code_name(code: ToolErrorCode) -> &'static str {
    match code {
        ToolErrorCode::ToolUnknown => "TOOL_UNKNOWN",
        ToolErrorCode::ToolInputTooLarge => "TOOL_INPUT_TOO_LARGE",
        ToolErrorCode::ToolInvalidJson => "TOOL_INVALID_JSON",
        ToolErrorCode::ToolSchemaInvalid => "TOOL_SCHEMA_INVALID",
        ToolErrorCode::ToolUnavailable => "TOOL_UNAVAILABLE",
        ToolErrorCode::ToolUnsupported => "TOOL_UNSUPPORTED",
        ToolErrorCode::ToolPlanBlocked => "TOOL_PLAN_BLOCKED",
        ToolErrorCode::ToolValidationFailed => "TOOL_VALIDATION_FAILED",
        ToolErrorCode::ToolPathNotFound => "TOOL_PATH_NOT_FOUND",
        ToolErrorCode::ToolPathOutsideWorkspace => "TOOL_PATH_OUTSIDE_WORKSPACE",
        ToolErrorCode::ToolPathUnread => "TOOL_PATH_UNREAD",
        ToolErrorCode::ToolPathBusy => "TOOL_PATH_BUSY",
        ToolErrorCode::ToolRiskDeclined => "TOOL_RISK_DECLINED",
        ToolErrorCode::ToolRiskHeadlessDenied => "TOOL_RISK_HEADLESS_DENIED",
        ToolErrorCode::ToolCircuitOpen => "TOOL_CIRCUIT_OPEN",
        ToolErrorCode::ToolCancelled => "TOOL_CANCELLED",
        ToolErrorCode::ToolTimedOut => "TOOL_TIMED_OUT",
        ToolErrorCode::ToolPanicked => "TOOL_PANICKED",
        ToolErrorCode::ToolIoFailed => "TOOL_IO_FAILED",
        ToolErrorCode::ToolProcessSpawnFailed => "TOOL_PROCESS_SPAWN_FAILED",
        ToolErrorCode::ToolProcessExitNonzero => "TOOL_PROCESS_EXIT_NONZERO",
        ToolErrorCode::ToolProcessOutputLimit => "TOOL_PROCESS_OUTPUT_LIMIT",
        ToolErrorCode::ToolSerializationFailed => "TOOL_SERIALIZATION_FAILED",
        ToolErrorCode::ToolRedactionFailed => "TOOL_REDACTION_FAILED",
        ToolErrorCode::ToolArtifactFailed => "TOOL_ARTIFACT_FAILED",
        ToolErrorCode::ToolInternal => "TOOL_INTERNAL",
        ToolErrorCode::MemoryUnavailable => "MEMORY_UNAVAILABLE",
        ToolErrorCode::MemoryTimeout => "MEMORY_TIMEOUT",
        ToolErrorCode::MemoryCancelled => "MEMORY_CANCELLED",
        ToolErrorCode::MemoryInvalidInput => "MEMORY_INVALID_INPUT",
        ToolErrorCode::MemoryNotFound => "MEMORY_NOT_FOUND",
        ToolErrorCode::MemoryPluginFailed => "MEMORY_PLUGIN_FAILED",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_a4_rows_keep_class_status_and_retryability_on_the_tool_surface() {
        let error = history_tool_error("HISTORY_SEARCH_CURSOR_STALE", "stale");
        let mapped = map_result_error_surface(error.code(), error.details());
        assert_eq!(mapped.canonical_code, "E_HISTORY_CURSOR_STALE");
        assert_eq!(mapped.class, ErrorClass::Conflict);
        assert_eq!(mapped.status, ToolResultStatus::Error);
        assert!(mapped.retryable);
        assert!(!map_tool_error(ToolErrorCode::ToolValidationFailed).retryable);
    }

    #[test]
    fn non_history_errors_take_a3_class_from_their_tool_error_code() {
        let mapped = map_result_error_surface(ToolErrorCode::ToolValidationFailed, None);
        let base = map_tool_error(ToolErrorCode::ToolValidationFailed);
        assert_eq!(mapped.canonical_code, base.canonical_code);
        assert_eq!(mapped.class, base.class);
        assert_eq!(mapped.status, base.status);
        assert_eq!(mapped.retryable, base.retryable);
    }

    #[test]
    fn history_tool_error_details_are_exactly_the_catalog_keys() {
        let error = history_tool_error("HISTORY_ARTIFACT_NOT_FOUND", "missing");
        assert_eq!(
            error.details().unwrap(),
            &serde_json::json!({
                "canonical_code": "E_ARTIFACT_NOT_FOUND",
                "history_code": "HISTORY_ARTIFACT_NOT_FOUND",
            })
        );
    }
}
