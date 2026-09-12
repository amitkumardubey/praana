//! Tool results, executions, and batches.

use serde::{Deserialize, Serialize};

use crate::protocol::id::*;
use crate::protocol::json::{deserialize_bounded_u64, deserialize_optional_bounded_u64};
use crate::protocol::messages::deserialize_tool_name;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolResultStatus {
    Success,
    Error,
    Cancelled,
    Blocked,
    Uncertain,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "storage",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
// Inline vs artifact result shapes are spec-mandated; the size difference is
// inherent to the DTO, not a boxing opportunity.
#[allow(clippy::large_enum_variant)]
pub enum ToolResultContent {
    Inline(InlineToolResult),
    Artifact(ArtifactToolResult),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InlineToolResult {
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactToolResult {
    pub preview: String,
    pub reference: ArtifactRef,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRef {
    pub artifact_id: ArtifactId,
    pub sha256: Sha256Digest,
    #[serde(deserialize_with = "deserialize_media_type")]
    pub media_type: String,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub byte_count: u64,
    #[serde(deserialize_with = "deserialize_optional_bounded_u64")]
    pub line_count: Option<u64>,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub estimated_tokens: u64,
    pub token_estimator_schema_version: u32,
    pub estimator_id: String,
    pub token_input_sha256: Sha256Digest,
    pub retrieval: ArtifactRetrieval,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRetrieval {
    pub tool: String,
    #[serde(serialize_with = "crate::protocol::json::serialize_canonical_json_map")]
    pub arguments: serde_json::Map<String, serde_json::Value>,
}

pub fn validate_mime_type(s: &str) -> Result<(), &'static str> {
    if s.is_empty() || s.contains(';') || s.contains(' ') {
        return Err("E_EVENT_SCHEMA_INVALID");
    }
    let parts: Vec<&str> = s.split('/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err("E_EVENT_SCHEMA_INVALID");
    }
    for part in parts {
        for b in part.bytes() {
            if !matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-')
            {
                return Err("E_EVENT_SCHEMA_INVALID");
            }
        }
    }
    Ok(())
}

pub fn deserialize_media_type<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    if s == "application/vnd.praana.tool-result+json;version=1" {
        return Ok(s);
    }
    validate_mime_type(&s).map_err(serde::de::Error::custom)?;
    Ok(s)
}

pub fn deserialize_image_media_type<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    validate_mime_type(&s).map_err(serde::de::Error::custom)?;
    Ok(s)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResultBody {
    #[serde(deserialize_with = "deserialize_media_type")]
    pub media_type: String,
    pub content: ToolResultContent,
    pub sha256: Sha256Digest,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub byte_count: u64,
    #[serde(deserialize_with = "deserialize_optional_bounded_u64")]
    pub line_count: Option<u64>,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub estimated_tokens: u64,
    pub token_estimator_schema_version: u32,
    pub estimator_id: String,
    pub token_input_sha256: Sha256Digest,
    pub redacted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResultMessage {
    pub message_id: MessageId,
    pub turn_id: TurnId,
    pub step_id: StepId,
    pub batch_id: ToolBatchId,
    pub execution_id: ToolExecutionId,
    pub call_id: ToolCallId,
    #[serde(deserialize_with = "deserialize_tool_name")]
    pub tool_name: String,
    pub status: ToolResultStatus,
    pub body: ToolResultBody,
    pub recovered: bool,
}
