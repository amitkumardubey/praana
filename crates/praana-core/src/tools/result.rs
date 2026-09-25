//! Canonical tool-result DTO. History artifactization is a later packet.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::canonical_json::to_canonical_json_bytes;
use crate::protocol::id::ToolCallId;

use super::error::{code_name, ToolError, ToolErrorCode};
use super::ToolName;

pub const CANONICAL_RESULT_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolResultDto {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolErrorDto>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ToolWarningDto>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<Value>,
    pub meta: ToolResultMeta,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolErrorDto {
    pub code: ToolErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolWarningDto {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolResultMeta {
    pub tool_call_id: ToolCallId,
    pub tool_name: ToolName,
    pub duration_ms: u64,
    pub cancelled: bool,
    pub timed_out: bool,
    pub redacted: bool,
    pub truncated: bool,
}

impl ToolResultDto {
    pub fn failure(
        code: ToolErrorCode,
        message: impl Into<String>,
        retryable: bool,
        tool_name: &str,
        call_id: &str,
    ) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(ToolErrorDto {
                code,
                message: message.into(),
                retryable,
                details: None,
            }),
            warnings: Vec::new(),
            artifacts: Vec::new(),
            meta: ToolResultMeta {
                tool_call_id: ToolCallId::from_str_canonical(call_id).unwrap_or_else(|_| {
                    ToolCallId::from_str_canonical("invalid-call").expect("static call id")
                }),
                tool_name: ToolName::new(tool_name)
                    .unwrap_or_else(|_| ToolName::new("tool_internal").expect("static tool name")),
                duration_ms: 0,
                cancelled: code == ToolErrorCode::ToolCancelled,
                timed_out: code == ToolErrorCode::ToolTimedOut,
                redacted: false,
                truncated: false,
            },
        }
    }
}

pub fn canonical_tool_result_bytes(dto: &ToolResultDto) -> Result<Vec<u8>, ToolError> {
    let value = serde_json::to_value(dto).map_err(|_| {
        ToolError::new(
            ToolErrorCode::ToolSerializationFailed,
            "result serialization failed",
        )
    })?;
    reject_non_finite(&value)?;
    let bytes = to_canonical_json_bytes(&value).map_err(|_| {
        ToolError::new(
            ToolErrorCode::ToolSerializationFailed,
            "canonical serialization failed",
        )
    })?;
    if bytes.len() > CANONICAL_RESULT_LIMIT {
        return Err(ToolError::new(
            ToolErrorCode::ToolSerializationFailed,
            "canonical result exceeds 1 MiB",
        ));
    }
    if bytes.last() == Some(&b'\n') {
        return Err(ToolError::new(
            ToolErrorCode::ToolSerializationFailed,
            "canonical result has a trailing newline",
        ));
    }
    let _ = code_name(ToolErrorCode::ToolInternal);
    Ok(bytes)
}

fn reject_non_finite(value: &Value) -> Result<(), ToolError> {
    match value {
        Value::Number(number) => {
            if let Some(float) = number.as_f64() {
                if !float.is_finite() {
                    return Err(ToolError::new(
                        ToolErrorCode::ToolSerializationFailed,
                        "non-finite number",
                    ));
                }
            }
            Ok(())
        }
        Value::Array(items) => {
            for item in items {
                reject_non_finite(item)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for item in map.values() {
                reject_non_finite(item)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
