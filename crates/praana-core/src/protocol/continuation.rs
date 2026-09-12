//! Provider continuation tokens and states.

use serde::{Deserialize, Serialize};

use crate::protocol::id::{ProviderItemId, ProviderResponseId, Sha256Digest, ToolCallId};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "provider_protocol",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ProviderContinuation {
    OpenAiResponses(OpenAiResponsesContinuation),
    Anthropic(AnthropicContinuation),
    Gemini(GeminiContinuation),
    Bedrock(BedrockContinuation),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContinuationScope {
    pub provider: String,
    pub protocol: String,
    pub model: String,
    pub model_revision: Option<String>,
    pub endpoint_fingerprint: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiResponsesContinuation {
    pub scope: ContinuationScope,
    pub response_id: Option<ProviderResponseId>,
    pub output_items: Vec<OpenAiResponseOutputItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum OpenAiResponseOutputItem {
    Message(OpenAiResponseMessageItem),
    Reasoning(OpenAiResponseReasoningItem),
    FunctionCall(OpenAiResponseFunctionCallItem),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiResponseMessageItem {
    pub id: Option<ProviderItemId>,
    pub status: OpenAiItemStatus,
    pub role: OpenAiMessageRole,
    pub phase: Option<OpenAiAssistantPhase>,
    pub content: Vec<OpenAiResponseContentPart>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum OpenAiAssistantPhase {
    Commentary,
    FinalAnswer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum OpenAiItemStatus {
    InProgress,
    Completed,
    Incomplete,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum OpenAiMessageRole {
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum OpenAiResponseContentPart {
    OutputText(OpenAiOutputText),
    Refusal(OpenAiRefusal),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiOutputText {
    pub text: String,
    pub annotations: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiRefusal {
    pub refusal: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiResponseReasoningItem {
    pub id: Option<ProviderItemId>,
    pub status: OpenAiItemStatus,
    pub summary: Vec<OpenAiReasoningSummaryPart>,
    pub encrypted_content: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiReasoningSummaryPart {
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiResponseFunctionCallItem {
    pub id: Option<ProviderItemId>,
    pub status: OpenAiItemStatus,
    pub call_id: ToolCallId,
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnthropicContinuation {
    pub scope: ContinuationScope,
    pub thinking_blocks: Vec<AnthropicThinkingBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnthropicThinkingBlock {
    pub thinking: String,
    pub signature: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GeminiContinuation {
    pub scope: ContinuationScope,
    pub thought_signatures_base64: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BedrockContinuation {
    pub scope: ContinuationScope,
    pub reasoning_blocks: Vec<BedrockReasoningBlock>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BedrockReasoningBlock {
    pub text: Option<String>,
    pub signature: Option<String>,
    pub redacted_content_base64: Option<String>,
}
