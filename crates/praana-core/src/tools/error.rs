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
