//! Tool results, executions, and batches.

use serde::{Deserialize, Serialize};

use crate::protocol::id::*;
use crate::protocol::json::{deserialize_bounded_u64, deserialize_optional_bounded_u64};

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
    pub arguments: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResultBody {
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
    pub tool_name: String,
    pub status: ToolResultStatus,
    pub body: ToolResultBody,
    pub recovered: bool,
}
