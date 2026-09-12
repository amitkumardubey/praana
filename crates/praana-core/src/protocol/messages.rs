//! Canonical conversation messages and ordered content blocks.

use serde::{Deserialize, Serialize};

use crate::protocol::continuation::ProviderContinuation;
use crate::protocol::id::*;
use crate::protocol::json::deserialize_bounded_u64;
use crate::protocol::models::ProviderUsage;
use crate::protocol::tool_result::{ArtifactRef, ToolResultMessage};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "role",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ConversationMessage {
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolResult(ToolResultMessage),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserMessage {
    pub message_id: MessageId,
    pub turn_id: TurnId,
    pub blocks: Vec<UserBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum UserBlock {
    Text(TextBlock),
    Image(ImageBlock),
    ArtifactRef(ArtifactReferenceBlock),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum AssistantBlock {
    Text(TextBlock),
    ReasoningSummary(ReasoningSummaryBlock),
    Refusal(RefusalBlock),
    ToolCall(ToolCall),
    Image(ImageBlock),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantMessage {
    pub message_id: MessageId,
    pub turn_id: TurnId,
    pub step_id: StepId,
    pub provider: String,
    pub model: String,
    pub phase: Option<AssistantPhase>,
    pub blocks: Vec<AssistantBlock>,
    pub finish_reason: FinishReason,
    pub continuation: Option<ProviderContinuation>,
    pub usage: ProviderUsage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum AssistantPhase {
    Commentary,
    FinalAnswer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum FinishReason {
    Stop,
    ToolUse,
    Length,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextBlock {
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReasoningSummaryBlock {
    pub text: String,
    pub provider_item_id: Option<ProviderItemId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefusalBlock {
    pub text: String,
    pub provider_item_id: Option<ProviderItemId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub call_id: ToolCallId,
    pub name: String,
    pub arguments: serde_json::Map<String, serde_json::Value>,
    pub raw_arguments: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageBlock {
    pub media_type: String,
    pub source: ImageSource,
    pub alt_text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ImageSource {
    InlineBase64(InlineBase64Image),
    Artifact(ArtifactRef),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InlineBase64Image {
    pub data: String,
    pub sha256: Sha256Digest,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub byte_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReferenceBlock {
    pub reference: ArtifactRef,
    pub description: String,
}
