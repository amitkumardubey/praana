//! OpenAI Responses conversion, stream mapping, and local continuation replay.

use serde_json::{Map, Value};

use crate::protocol::continuation::{
    continuation_compatible, OpenAiAssistantPhase, OpenAiItemStatus, OpenAiMessageRole,
    OpenAiOutputText, OpenAiReasoningSummaryPart, OpenAiRefusal, OpenAiResponseContentPart,
    OpenAiResponseFunctionCallItem, OpenAiResponseMessageItem, OpenAiResponseOutputItem,
    OpenAiResponseReasoningItem, OpenAiResponsesContinuation, ProviderContinuation,
};
use crate::protocol::id::{ProviderItemId, ProviderResponseId, ToolCallId};
use crate::protocol::messages::{
    AssistantBlock, AssistantMessage, AssistantPhase, ConversationMessage, FinishReason,
    ImageBlock, ImageSource, TextBlock, ToolCall, UserBlock, UserMessage,
};
use crate::protocol::models::{ModelSelection, ReasoningEffort};
use crate::protocol::tool_result::ToolResultMessage;
use crate::provider::profile::ReasoningContextCapability;
use crate::tools::ToolCatalog;

use super::chat::{
    effort_wire, serialize_tool_output, validate_schema, validate_tool_groups, ChatProfileKind,
    OpenAiAdapterEvent, ToolChoiceV1,
};
use super::error::{ProviderError, ProviderErrorCode};
use super::sse::{parse_sse_bytes, SseFrame};
use super::usage::{usage_from_responses, OpenAiUsageAccumulator, UsageConversion};

#[derive(Clone, Debug)]
pub struct ResponsesFormatInput<'a> {
    pub model: &'a str,
    pub instructions: &'a str,
    pub messages: &'a [ConversationMessage],
    pub tools: &'a ToolCatalog,
    pub tool_choice: ToolChoiceV1,
    pub parallel_tools: bool,
    pub resolved_max_output_tokens: u64,
    pub temperature_milli: Option<u32>,
    pub temperature_with_reasoning: bool,
    pub reasoning: ReasoningEffort,
    pub reasoning_context: ReasoningContextCapability,
    pub image_input_supported: bool,
    pub continuation: Option<&'a OpenAiResponsesContinuation>,
    pub target: &'a ModelSelection,
    pub internal_compaction_control: Option<&'a str>,
    pub compaction_schema: Option<&'a Value>,
    pub replay_policy: &'a str,
}

pub fn format_responses_body(input: &ResponsesFormatInput<'_>) -> Result<Value, ProviderError> {
    if input.temperature_milli.is_some()
        && !matches!(input.reasoning, ReasoningEffort::Off)
        && !input.temperature_with_reasoning
    {
        return Err(rerr(
            ProviderErrorCode::UnsupportedOption,
            "temperature is unsupported with reasoning",
        ));
    }
    if matches!(input.tool_choice, ToolChoiceV1::Named) {
        return Err(rerr(
            ProviderErrorCode::UnsupportedOption,
            "named tool choice is deferred",
        ));
    }
    validate_tool_groups(input.messages).map_err(|_| {
        rerr(
            ProviderErrorCode::CanonicalRequestInvalid,
            "incomplete tool group",
        )
    })?;
    let active_call_ids = input
        .continuation
        .map(active_continuation_call_ids)
        .unwrap_or_default();
    let mut items = Vec::new();
    let mut image_count = 0usize;
    for message in input.messages {
        match message {
            ConversationMessage::User(user) => items.push(map_user(input, user, &mut image_count)?),
            ConversationMessage::Assistant(assistant) => {
                items.extend(map_assistant(assistant, &active_call_ids)?);
            }
            ConversationMessage::ToolResult(result) => {
                if !active_call_ids.iter().any(|id| id == &result.call_id) {
                    items.push(map_function_output(result)?);
                }
            }
        }
    }
    if let Some(continuation) = input.continuation {
        items.extend(replay_continuation(input, continuation)?);
    }
    if let Some(control) = input.internal_compaction_control {
        items.push(serde_json::json!({
            "type": "message",
            "role": "user",
            "content": [{
                "type": "input_text",
                "text": format!("[PRAANA:INTERNAL_COMPACTION_CONTROL]\n{control}\n[/PRAANA:INTERNAL_COMPACTION_CONTROL]\n")
            }]
        }));
    }
    let mut body = Map::new();
    body.insert("model".into(), Value::String(input.model.to_owned()));
    body.insert("input".into(), Value::Array(items));
    body.insert("stream".into(), Value::Bool(true));
    body.insert("store".into(), Value::Bool(false));
    body.insert(
        "instructions".into(),
        Value::String(input.instructions.to_owned()),
    );
    body.insert(
        "max_output_tokens".into(),
        Value::Number(input.resolved_max_output_tokens.into()),
    );
    if !input.tools.descriptors().is_empty() {
        let mut tools = Vec::new();
        for descriptor in input.tools.descriptors() {
            validate_schema(ChatProfileKind::OpenAi, &descriptor.input_schema).map_err(retarget)?;
            tools.push(serde_json::json!({
                "type": "function",
                "name": descriptor.name.as_str(),
                "description": descriptor.description,
                "parameters": descriptor.input_schema,
                "strict": descriptor.strict,
            }));
        }
        body.insert("tools".into(), Value::Array(tools));
        let choice = match input.tool_choice {
            ToolChoiceV1::Auto => "auto",
            ToolChoiceV1::None => "none",
            ToolChoiceV1::Required => "required",
            ToolChoiceV1::Named => "auto",
        };
        body.insert("tool_choice".into(), Value::String(choice.into()));
        if input.parallel_tools {
            body.insert("parallel_tool_calls".into(), Value::Bool(true));
        }
    }
    if let Some(milli) = input.temperature_milli {
        let number = serde_json::Number::from_f64(milli as f64 / 1000.0).ok_or_else(|| {
            rerr(
                ProviderErrorCode::UnsupportedOption,
                "non-finite temperature",
            )
        })?;
        body.insert("temperature".into(), Value::Number(number));
    }
    if !matches!(input.reasoning, ReasoningEffort::Off) {
        let mut reasoning = Map::new();
        reasoning.insert(
            "effort".into(),
            Value::String(effort_wire(&input.reasoning).into()),
        );
        reasoning.insert("summary".into(), Value::String("auto".into()));
        if matches!(
            input.reasoning_context,
            ReasoningContextCapability::CurrentTurn | ReasoningContextCapability::AllTurns
        ) {
            reasoning.insert("context".into(), Value::String("current_turn".into()));
        }
        body.insert("reasoning".into(), Value::Object(reasoning));
    }
    if let Some(schema) = input.compaction_schema {
        body.insert(
            "text".into(),
            serde_json::json!({
                "format": {
                    "type": "json_schema",
                    "name": "praana_compaction_candidate_v1",
                    "strict": true,
                    "schema": schema
                }
            }),
        );
    }
    if body.contains_key("previous_response_id") {
        return Err(rerr(
            ProviderErrorCode::CanonicalRequestInvalid,
            "previous_response_id is forbidden",
        ));
    }
    Ok(Value::Object(body))
}

fn replay_continuation(
    input: &ResponsesFormatInput<'_>,
    continuation: &OpenAiResponsesContinuation,
) -> Result<Vec<Value>, ProviderError> {
    let wrapped = ProviderContinuation::OpenAiResponses(continuation.clone());
    if !continuation_compatible(&wrapped, input.target) || input.replay_policy != "active" {
        return Err(rerr(
            ProviderErrorCode::ContinuationIncompatible,
            "continuation scope mismatch",
        ));
    }
    let mut items = Vec::new();
    let mut calls = Vec::new();
    for item in &continuation.output_items {
        match item {
            OpenAiResponseOutputItem::Reasoning(reasoning) => {
                if reasoning
                    .encrypted_content
                    .as_ref()
                    .map(|value| value.is_empty())
                    .unwrap_or(true)
                    && continuation
                        .output_items
                        .iter()
                        .any(|item| matches!(item, OpenAiResponseOutputItem::FunctionCall(_)))
                {
                    return Err(rerr(
                        ProviderErrorCode::ContinuationUnavailable,
                        "encrypted reasoning is required",
                    ));
                }
                items.push(reasoning_wire(reasoning));
            }
            OpenAiResponseOutputItem::Message(message) => items.push(message_wire(message)?),
            OpenAiResponseOutputItem::FunctionCall(call) => {
                calls.push(call.clone());
                items.push(function_call_wire(call));
            }
        }
    }
    for call in calls {
        if let Some(result) = input.messages.iter().find_map(|message| match message {
            ConversationMessage::ToolResult(result) if result.call_id == call.call_id => {
                Some(result)
            }
            _ => None,
        }) {
            items.push(map_function_output(result)?);
        }
    }
    Ok(items)
}

fn reasoning_wire(item: &OpenAiResponseReasoningItem) -> Value {
    let mut value = Map::new();
    value.insert("type".into(), Value::String("reasoning".into()));
    if let Some(id) = &item.id {
        value.insert("id".into(), Value::String(id.as_str().to_owned()));
    }
    value.insert(
        "summary".into(),
        Value::Array(
            item.summary
                .iter()
                .map(|part| serde_json::json!({"type": "summary_text", "text": part.text}))
                .collect(),
        ),
    );
    if let Some(encrypted) = &item.encrypted_content {
        value.insert("encrypted_content".into(), Value::String(encrypted.clone()));
    }
    Value::Object(value)
}

fn message_wire(item: &OpenAiResponseMessageItem) -> Result<Value, ProviderError> {
    let mut content = Vec::new();
    for part in &item.content {
        match part {
            OpenAiResponseContentPart::OutputText(text) => {
                content.push(serde_json::json!({
                    "type": "output_text",
                    "text": text.text,
                    "annotations": text.annotations,
                }));
            }
            OpenAiResponseContentPart::Refusal(refusal) => {
                content.push(serde_json::json!({"type": "refusal", "refusal": refusal.refusal}));
            }
        }
    }
    let mut value = Map::new();
    value.insert("type".into(), Value::String("message".into()));
    value.insert("role".into(), Value::String("assistant".into()));
    if let Some(phase) = &item.phase {
        value.insert(
            "phase".into(),
            Value::String(
                match phase {
                    OpenAiAssistantPhase::Commentary => "commentary",
                    OpenAiAssistantPhase::FinalAnswer => "final_answer",
                }
                .into(),
            ),
        );
    }
    if let Some(id) = &item.id {
        value.insert("id".into(), Value::String(id.as_str().to_owned()));
    }
    value.insert("content".into(), Value::Array(content));
    Ok(Value::Object(value))
}

fn function_call_wire(call: &OpenAiResponseFunctionCallItem) -> Value {
    let mut value = Map::new();
    value.insert("type".into(), Value::String("function_call".into()));
    value.insert(
        "call_id".into(),
        Value::String(call.call_id.as_str().to_owned()),
    );
    value.insert("name".into(), Value::String(call.name.clone()));
    value.insert("arguments".into(), Value::String(call.arguments.clone()));
    if let Some(id) = &call.id {
        value.insert("id".into(), Value::String(id.as_str().to_owned()));
    }
    Value::Object(value)
}

fn map_user(
    input: &ResponsesFormatInput<'_>,
    user: &UserMessage,
    image_count: &mut usize,
) -> Result<Value, ProviderError> {
    let mut content = Vec::new();
    for block in &user.blocks {
        match block {
            UserBlock::Text(TextBlock { text }) if !text.is_empty() => {
                content.push(serde_json::json!({"type": "input_text", "text": text}));
            }
            UserBlock::Text(_) => {}
            UserBlock::Image(image) => content.push(map_image(input, image, image_count)?),
            UserBlock::ArtifactRef(_) => {
                return Err(rerr(
                    ProviderErrorCode::UnsupportedContent,
                    "files are unsupported",
                ));
            }
        }
    }
    if content.is_empty() {
        return Err(rerr(
            ProviderErrorCode::CanonicalRequestInvalid,
            "empty user message",
        ));
    }
    Ok(serde_json::json!({"type": "message", "role": "user", "content": content}))
}

fn map_image(
    input: &ResponsesFormatInput<'_>,
    image: &ImageBlock,
    image_count: &mut usize,
) -> Result<Value, ProviderError> {
    if !input.image_input_supported {
        return Err(rerr(
            ProviderErrorCode::UnsupportedContent,
            "image input is unsupported",
        ));
    }
    if !matches!(
        image.media_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return Err(rerr(
            ProviderErrorCode::UnsupportedContent,
            "unsupported image media type",
        ));
    }
    let ImageSource::InlineBase64(inline) = &image.source else {
        return Err(rerr(
            ProviderErrorCode::UnsupportedContent,
            "remote image urls are rejected",
        ));
    };
    if inline.data.contains("://") {
        return Err(rerr(
            ProviderErrorCode::UnsupportedContent,
            "remote image urls are rejected",
        ));
    }
    let decoded = super::chat::base64_decode(&inline.data).map_err(|_| {
        rerr(
            ProviderErrorCode::CanonicalRequestInvalid,
            "image base64 is invalid",
        )
    })?;
    if decoded.len() > super::chat::MAX_IMAGE_BYTES || inline.byte_count as usize != decoded.len() {
        return Err(rerr(
            ProviderErrorCode::CanonicalRequestInvalid,
            "image exceeds 20 MiB",
        ));
    }
    *image_count += 1;
    if *image_count > super::chat::MAX_IMAGES {
        return Err(rerr(
            ProviderErrorCode::CanonicalRequestInvalid,
            "image count exceeds 10",
        ));
    }
    Ok(serde_json::json!({
        "type": "input_image",
        "image_url": format!("data:{};base64,{}", image.media_type, inline.data)
    }))
}

fn active_continuation_call_ids(
    continuation: &OpenAiResponsesContinuation,
) -> Vec<crate::protocol::id::ToolCallId> {
    continuation
        .output_items
        .iter()
        .filter_map(|item| match item {
            OpenAiResponseOutputItem::FunctionCall(call) => Some(call.call_id.clone()),
            _ => None,
        })
        .collect()
}

fn map_assistant(
    assistant: &AssistantMessage,
    suppressed_call_ids: &[crate::protocol::id::ToolCallId],
) -> Result<Vec<Value>, ProviderError> {
    let active_cycle = assistant.blocks.iter().any(|block| match block {
        AssistantBlock::ToolCall(call) => suppressed_call_ids.iter().any(|id| id == &call.call_id),
        _ => false,
    });
    if active_cycle {
        return Ok(Vec::new());
    }
    let mut content = Vec::new();
    let mut calls = Vec::new();
    for block in &assistant.blocks {
        match block {
            AssistantBlock::Text(TextBlock { text }) if !text.is_empty() => {
                content.push(
                    serde_json::json!({"type": "output_text", "text": text, "annotations": []}),
                );
            }
            AssistantBlock::Text(_) | AssistantBlock::ReasoningSummary(_) => {}
            AssistantBlock::Refusal(block) => {
                content.push(serde_json::json!({"type": "refusal", "refusal": block.text}));
            }
            AssistantBlock::ToolCall(call) => calls.push(call),
            AssistantBlock::Image(_) => {
                return Err(rerr(
                    ProviderErrorCode::UnsupportedContent,
                    "assistant images are unsupported",
                ));
            }
        }
    }
    let mut items = Vec::new();
    if !content.is_empty() {
        let mut message = Map::new();
        message.insert("type".into(), Value::String("message".into()));
        message.insert("role".into(), Value::String("assistant".into()));
        if let Some(phase) = &assistant.phase {
            message.insert(
                "phase".into(),
                Value::String(
                    match phase {
                        AssistantPhase::Commentary => "commentary",
                        AssistantPhase::FinalAnswer => "final_answer",
                    }
                    .into(),
                ),
            );
        }
        message.insert("content".into(), Value::Array(content));
        items.push(Value::Object(message));
    }
    for call in calls {
        items.push(serde_json::json!({
            "type": "function_call",
            "call_id": call.call_id.as_str(),
            "name": call.name,
            "arguments": call.raw_arguments,
        }));
    }
    Ok(items)
}

fn map_function_output(result: &ToolResultMessage) -> Result<Value, ProviderError> {
    Ok(serde_json::json!({
        "type": "function_call_output",
        "call_id": result.call_id.as_str(),
        "output": serialize_tool_output(ChatProfileKind::OpenAi, result).map_err(retarget)?,
    }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResponsesStreamOutcome {
    pub events: Vec<OpenAiAdapterEvent>,
    pub usage: UsageConversion,
    pub finish_reason: FinishReason,
    pub continuation: Option<OpenAiResponsesContinuation>,
    pub tool_calls: Vec<ToolCall>,
    pub response_id: Option<String>,
    pub clear_continuation: bool,
    pub usage_telemetry: Vec<&'static str>,
}

struct ItemState {
    kind: String,
    id: Option<String>,
    call_id: Option<String>,
    name: Option<String>,
    text: String,
    refusal: String,
    arguments: String,
    summary: String,
    encrypted: Option<String>,
    phase: Option<String>,
    started: bool,
}

pub fn parse_responses_stream(
    bytes: &[u8],
    scope_model: &ModelSelection,
) -> Result<ResponsesStreamOutcome, ProviderError> {
    let frames =
        parse_sse_bytes(bytes).map_err(|failure| rerr(failure.code, failure.code.as_str()))?;
    parse_responses_frames(&frames, scope_model)
}

pub fn parse_responses_frames(
    frames: &[SseFrame],
    scope_model: &ModelSelection,
) -> Result<ResponsesStreamOutcome, ProviderError> {
    let mut items: Vec<Option<ItemState>> = Vec::new();
    let mut usage = OpenAiUsageAccumulator::default();
    let mut events = Vec::new();
    let mut response_id: Option<String> = None;
    let mut model_name: Option<String> = None;
    let mut terminal = false;
    let mut failed: Option<ProviderError> = None;
    let mut finish = FinishReason::Stop;
    let mut incomplete_reason: Option<String> = None;
    for frame in frames {
        if frame.data.is_empty() || frame.data == "[DONE]" {
            if frame.data == "[DONE]" && !terminal {
                return Err(rerr(
                    ProviderErrorCode::StreamTruncated,
                    "done before terminal event",
                ));
            }
            continue;
        }
        let value: Value = serde_json::from_str(&frame.data).map_err(|_| {
            rerr(
                ProviderErrorCode::StreamInvalidJson,
                "responses frame is not json",
            )
        })?;
        if !value.is_object() {
            return Err(rerr(
                ProviderErrorCode::ProtocolViolation,
                "responses frame is not an object",
            ));
        }
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if let Some(event_name) = &frame.event {
            if event_name != kind {
                return Err(rerr(
                    ProviderErrorCode::ProtocolViolation,
                    "sse event mismatches json type",
                ));
            }
        }
        match kind {
            "response.created"
            | "response.in_progress"
            | "response.output_item.added"
            | "response.output_text.delta"
            | "response.output_text.done"
            | "response.refusal.delta"
            | "response.refusal.done"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.output_item.done"
            | "response.completed"
            | "response.incomplete"
            | "response.failed"
            | "error" => {}
            _ => continue,
        }
        if kind == "error" || kind == "response.failed" {
            failed = Some(map_nested_error(value.get("response").unwrap_or(&value)));
            break;
        }
        if let Some(response) = value.get("response") {
            capture_identity(response, &mut response_id, &mut model_name)?;
            if let Some(raw_usage) = response.get("usage") {
                usage
                    .observe(&usage_from_responses(raw_usage))
                    .map_err(|code| rerr(code, "usage decreased"))?;
            }
        }
        if kind == "response.created" {
            events.push(OpenAiAdapterEvent::ResponseMetadata {
                response_id: response_id.clone(),
                model: model_name.clone(),
            });
        }
        if kind == "response.output_item.added" {
            let index = output_index(&value)?;
            let item = value
                .get("item")
                .ok_or_else(|| rerr(ProviderErrorCode::ProtocolViolation, "missing item"))?;
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
            if !matches!(item_type, "message" | "reasoning" | "function_call") {
                if item.get("content").is_some() || item.get("arguments").is_some() {
                    return Err(rerr(
                        ProviderErrorCode::UnsupportedOutputItem,
                        "unsupported visible output",
                    ));
                }
                continue;
            }
            ensure_index(&mut items, index)?;
            if items[index].is_some() {
                return Err(rerr(
                    ProviderErrorCode::ProtocolViolation,
                    "output index reused",
                ));
            }
            let mut state = ItemState {
                kind: item_type.to_owned(),
                id: item.get("id").and_then(Value::as_str).map(str::to_owned),
                call_id: item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                name: item.get("name").and_then(Value::as_str).map(str::to_owned),
                text: String::new(),
                refusal: String::new(),
                arguments: item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                summary: String::new(),
                encrypted: None,
                phase: item.get("phase").and_then(Value::as_str).map(str::to_owned),
                started: false,
            };
            if item_type == "function_call" {
                let call_id = state
                    .call_id
                    .clone()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        rerr(
                            ProviderErrorCode::ToolCallIdMissing,
                            "function call id missing",
                        )
                    })?;
                let name = state
                    .name
                    .clone()
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| {
                        rerr(
                            ProviderErrorCode::ProtocolViolation,
                            "function name missing",
                        )
                    })?;
                state.started = true;
                events.push(OpenAiAdapterEvent::ToolCallStarted {
                    output_index: index as u32,
                    call_id,
                    name,
                });
                if !state.arguments.is_empty() {
                    events.push(OpenAiAdapterEvent::ToolCallArgumentsDelta {
                        output_index: index as u32,
                        call_id: state.call_id.clone().unwrap_or_default(),
                        delta: state.arguments.clone(),
                    });
                }
            }
            events.push(OpenAiAdapterEvent::OutputItemStarted {
                output_index: index as u32,
                item_kind: item_type.to_owned(),
            });
            items[index] = Some(state);
        }
        if kind.ends_with(".delta") {
            let index = output_index(&value)?;
            let delta = value.get("delta").and_then(Value::as_str).unwrap_or("");
            ensure_index(&mut items, index)?;
            if items[index].is_none() {
                let item_kind = if kind.contains("reasoning") {
                    "reasoning"
                } else if kind.contains("function_call") {
                    "function_call"
                } else {
                    "message"
                };
                items[index] = Some(ItemState {
                    kind: item_kind.to_owned(),
                    id: None,
                    call_id: None,
                    name: None,
                    text: String::new(),
                    refusal: String::new(),
                    arguments: String::new(),
                    summary: String::new(),
                    encrypted: None,
                    phase: None,
                    started: true,
                });
            }
            let state = items[index].as_mut().ok_or_else(|| {
                rerr(
                    ProviderErrorCode::ProtocolViolation,
                    "delta for unknown index",
                )
            })?;
            if let Some(call_id) = value.get("call_id").and_then(Value::as_str) {
                if state.call_id.as_deref() != Some(call_id) {
                    return Err(rerr(
                        ProviderErrorCode::ProtocolViolation,
                        "call id mismatch",
                    ));
                }
            }
            if delta.is_empty() {
                continue;
            }
            match kind {
                "response.output_text.delta" => {
                    state.text.push_str(delta);
                    events.push(OpenAiAdapterEvent::TextDelta {
                        output_index: index as u32,
                        delta: delta.to_owned(),
                        refusal: false,
                    });
                }
                "response.refusal.delta" => {
                    state.refusal.push_str(delta);
                    events.push(OpenAiAdapterEvent::TextDelta {
                        output_index: index as u32,
                        delta: delta.to_owned(),
                        refusal: true,
                    });
                }
                "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                    state.summary.push_str(delta);
                    events.push(OpenAiAdapterEvent::ReasoningDelta {
                        output_index: index as u32,
                        delta: delta.to_owned(),
                    });
                }
                "response.function_call_arguments.delta" => {
                    state.arguments.push_str(delta);
                    events.push(OpenAiAdapterEvent::ToolCallArgumentsDelta {
                        output_index: index as u32,
                        call_id: state.call_id.clone().unwrap_or_default(),
                        delta: delta.to_owned(),
                    });
                }
                _ => {}
            }
        }
        if kind.ends_with(".done") && kind != "response.output_item.done" {
            let index = output_index(&value).ok();
            if let Some(index) = index {
                if let Some(state) = items.get(index).and_then(Option::as_ref) {
                    if let Some(full) = value
                        .get("text")
                        .and_then(Value::as_str)
                        .or_else(|| value.get("arguments").and_then(Value::as_str))
                    {
                        let accumulated = if kind.contains("arguments") {
                            state.arguments.as_str()
                        } else if kind.contains("reasoning") {
                            state.summary.as_str()
                        } else if kind.contains("refusal") {
                            state.refusal.as_str()
                        } else {
                            state.text.as_str()
                        };
                        if full != accumulated {
                            return Err(rerr(
                                ProviderErrorCode::ProtocolViolation,
                                "done bytes mismatch",
                            ));
                        }
                    }
                }
            }
        }
        if kind == "response.output_item.done" {
            let index = output_index(&value)?;
            let item = value.get("item").cloned().unwrap_or(Value::Null);
            let state = items
                .get_mut(index)
                .and_then(Option::as_mut)
                .ok_or_else(|| {
                    rerr(
                        ProviderErrorCode::ProtocolViolation,
                        "done for unknown index",
                    )
                })?;
            if let Some(encrypted) = item.get("encrypted_content").and_then(Value::as_str) {
                if !encrypted.is_empty() {
                    state.encrypted = Some(encrypted.to_owned());
                }
            }
            if state.kind == "function_call" {
                if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                    if !state.arguments.is_empty() && arguments != state.arguments {
                        return Err(rerr(
                            ProviderErrorCode::ProtocolViolation,
                            "argument done mismatch",
                        ));
                    }
                    if state.arguments.is_empty() {
                        state.arguments = arguments.to_owned();
                    }
                }
            }
            events.push(OpenAiAdapterEvent::OutputItemCompleted {
                output_index: index as u32,
            });
        }
        if kind == "response.completed" || kind == "response.incomplete" {
            let response = value.get("response").unwrap_or(&value);
            if let Some(output) = response.get("output").and_then(Value::as_array) {
                verify_terminal_output(output, &items)?;
            }
            if kind == "response.incomplete"
                || response.get("status").and_then(Value::as_str) == Some("incomplete")
            {
                incomplete_reason = response
                    .pointer("/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                finish = FinishReason::Length;
            }
            terminal = true;
        }
    }
    if let Some(error) = failed {
        return Err(error);
    }
    if !terminal {
        return Err(rerr(
            ProviderErrorCode::StreamTruncated,
            "eof before terminal event",
        ));
    }
    if let Some(reason) = incomplete_reason.as_deref() {
        if reason.contains("content_filter") || reason.contains("safety") {
            return Err(rerr(
                ProviderErrorCode::ProviderContentFilter,
                "content filter",
            ));
        }
        if reason != "max_output_tokens" && reason != "length" {
            let incomplete_call = items
                .iter()
                .flatten()
                .any(|item| item.kind == "function_call");
            if incomplete_call {
                return Err(rerr(
                    ProviderErrorCode::ToolArgumentsInvalid,
                    "incomplete tool arguments",
                ));
            }
            return Err(rerr(
                ProviderErrorCode::UnsupportedOutputItem,
                "unsupported incomplete reason",
            ));
        }
    }
    let mut output_items = Vec::new();
    let mut tool_calls = Vec::new();
    let mut blocks_present = false;
    for (index, slot) in items.iter().enumerate() {
        let Some(state) = slot else { continue };
        match state.kind.as_str() {
            "message" => {
                let mut content = Vec::new();
                if !state.text.is_empty() {
                    blocks_present = true;
                    content.push(OpenAiResponseContentPart::OutputText(OpenAiOutputText {
                        text: state.text.clone(),
                        annotations: Vec::new(),
                    }));
                }
                if !state.refusal.is_empty() {
                    blocks_present = true;
                    content.push(OpenAiResponseContentPart::Refusal(OpenAiRefusal {
                        refusal: state.refusal.clone(),
                    }));
                }
                output_items.push(OpenAiResponseOutputItem::Message(
                    OpenAiResponseMessageItem {
                        id: optional_item_id(state.id.as_deref())?,
                        status: OpenAiItemStatus::Completed,
                        role: OpenAiMessageRole::Assistant,
                        phase: match state.phase.as_deref() {
                            Some("commentary") => Some(OpenAiAssistantPhase::Commentary),
                            Some("final_answer") => Some(OpenAiAssistantPhase::FinalAnswer),
                            Some(_) => {
                                return Err(rerr(
                                    ProviderErrorCode::ProtocolViolation,
                                    "unknown phase",
                                ))
                            }
                            None => None,
                        },
                        content,
                    },
                ));
            }
            "reasoning" => {
                if !state.summary.is_empty() {
                    blocks_present = true;
                }
                output_items.push(OpenAiResponseOutputItem::Reasoning(
                    OpenAiResponseReasoningItem {
                        id: optional_item_id(state.id.as_deref())?,
                        status: OpenAiItemStatus::Completed,
                        summary: if state.summary.is_empty() {
                            Vec::new()
                        } else {
                            vec![OpenAiReasoningSummaryPart {
                                text: state.summary.clone(),
                            }]
                        },
                        encrypted_content: state.encrypted.clone(),
                    },
                ));
            }
            "function_call" => {
                let call_id = state
                    .call_id
                    .clone()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        rerr(
                            ProviderErrorCode::ToolCallIdMissing,
                            "function call id missing",
                        )
                    })?;
                let parsed: Value = serde_json::from_str(&state.arguments).map_err(|_| {
                    rerr(
                        ProviderErrorCode::ToolArgumentsInvalid,
                        "malformed arguments",
                    )
                })?;
                let Some(object) = parsed.as_object().cloned() else {
                    return Err(rerr(
                        ProviderErrorCode::ToolArgumentsInvalid,
                        "arguments are not an object",
                    ));
                };
                if incomplete_reason.is_some() {
                    return Err(rerr(
                        ProviderErrorCode::ToolArgumentsInvalid,
                        "incomplete tool arguments",
                    ));
                }
                let Some(name) = state.name.clone().filter(|name| !name.is_empty()) else {
                    return Err(rerr(
                        ProviderErrorCode::ProtocolViolation,
                        "function name missing",
                    ));
                };
                let call = ToolCall {
                    call_id: ToolCallId::from_str_canonical(&call_id).map_err(|_| {
                        rerr(
                            ProviderErrorCode::ToolCallIdMissing,
                            "function call id missing",
                        )
                    })?,
                    name,
                    arguments: object,
                    raw_arguments: state.arguments.clone(),
                };
                events.push(OpenAiAdapterEvent::ToolCallCompleted {
                    output_index: index as u32,
                    call: call.clone(),
                });
                tool_calls.push(call.clone());
                blocks_present = true;
                output_items.push(OpenAiResponseOutputItem::FunctionCall(
                    OpenAiResponseFunctionCallItem {
                        id: optional_item_id(state.id.as_deref())?,
                        status: OpenAiItemStatus::Completed,
                        call_id: call.call_id.clone(),
                        name: call.name.clone(),
                        arguments: call.raw_arguments.clone(),
                    },
                ));
                if state.encrypted.is_none()
                    && items
                        .iter()
                        .flatten()
                        .any(|item| item.kind == "reasoning" && item.encrypted.is_none())
                {
                    return Err(rerr(
                        ProviderErrorCode::ContinuationUnavailable,
                        "encrypted reasoning is required",
                    ));
                }
            }
            _ => {}
        }
    }
    if !blocks_present {
        return Err(rerr(
            ProviderErrorCode::ProviderEmptyResponse,
            "empty completion",
        ));
    }
    let needs_encrypted = tool_calls
        .iter()
        .any(|_| items.iter().flatten().any(|item| item.kind == "reasoning"));
    if needs_encrypted
        && items.iter().flatten().any(|item| {
            item.kind == "reasoning"
                && item
                    .encrypted
                    .as_ref()
                    .map(|v| v.is_empty())
                    .unwrap_or(true)
        })
    {
        return Err(rerr(
            ProviderErrorCode::ContinuationUnavailable,
            "encrypted reasoning is required",
        ));
    }
    let converted = usage.into_protocol_usage();
    events.push(OpenAiAdapterEvent::Usage(converted.usage.clone()));
    events.push(OpenAiAdapterEvent::Completed {
        finish_reason: finish.clone(),
    });
    let continuation = Some(OpenAiResponsesContinuation {
        scope: crate::protocol::continuation::ContinuationScope {
            provider: scope_model.provider.clone(),
            protocol: scope_model.protocol.clone(),
            model: scope_model.model.clone(),
            model_revision: scope_model.model_revision.clone(),
            endpoint_fingerprint: scope_model.endpoint_fingerprint.clone(),
        },
        response_id: response_id
            .as_deref()
            .and_then(|id| ProviderResponseId::from_str_canonical(id).ok()),
        output_items,
    });
    let clear_continuation = tool_calls.is_empty();
    Ok(ResponsesStreamOutcome {
        events,
        usage_telemetry: converted.telemetry_names(),
        usage: converted,
        finish_reason: finish,
        continuation,
        tool_calls,
        response_id,
        clear_continuation,
    })
}

fn verify_terminal_output(
    output: &[Value],
    items: &[Option<ItemState>],
) -> Result<(), ProviderError> {
    for (index, item) in output.iter().enumerate() {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        let state = items.get(index).and_then(Option::as_ref);
        let Some(state) = state else {
            return Err(rerr(
                ProviderErrorCode::ProtocolViolation,
                "terminal output mismatch",
            ));
        };
        if state.kind != kind {
            return Err(rerr(
                ProviderErrorCode::ProtocolViolation,
                "terminal output mismatch",
            ));
        }
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            if state.id.as_deref() != Some(id) && state.id.is_some() {
                return Err(rerr(
                    ProviderErrorCode::ProtocolViolation,
                    "terminal id mismatch",
                ));
            }
        }
        if let Some(name) = item.get("name").and_then(Value::as_str) {
            if state.name.as_deref() != Some(name) {
                return Err(rerr(
                    ProviderErrorCode::ProtocolViolation,
                    "terminal name mismatch",
                ));
            }
        }
        if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
            if arguments != state.arguments {
                return Err(rerr(
                    ProviderErrorCode::ProtocolViolation,
                    "terminal arguments mismatch",
                ));
            }
        }
    }
    Ok(())
}

fn capture_identity(
    response: &Value,
    response_id: &mut Option<String>,
    model_name: &mut Option<String>,
) -> Result<(), ProviderError> {
    if let Some(id) = response.get("id").and_then(Value::as_str) {
        if let Some(existing) = response_id {
            if existing != id {
                return Err(rerr(
                    ProviderErrorCode::ProtocolViolation,
                    "response id changed",
                ));
            }
        } else {
            *response_id = Some(id.to_owned());
        }
    }
    if let Some(model) = response.get("model").and_then(Value::as_str) {
        *model_name = Some(model.to_owned());
    }
    Ok(())
}

fn output_index(value: &Value) -> Result<usize, ProviderError> {
    value
        .get("output_index")
        .and_then(Value::as_u64)
        .map(|index| index as usize)
        .ok_or_else(|| rerr(ProviderErrorCode::ProtocolViolation, "output index missing"))
}

fn ensure_index(items: &mut Vec<Option<ItemState>>, index: usize) -> Result<(), ProviderError> {
    if index > 128 {
        return Err(rerr(
            ProviderErrorCode::ProtocolViolation,
            "output index too large",
        ));
    }
    if items.len() <= index {
        items.resize_with(index + 1, || None);
    }
    Ok(())
}

fn optional_item_id(id: Option<&str>) -> Result<Option<ProviderItemId>, ProviderError> {
    match id {
        Some(id) => ProviderItemId::from_str_canonical(id)
            .map(Some)
            .map_err(|_| rerr(ProviderErrorCode::ProtocolViolation, "invalid item id")),
        None => Ok(None),
    }
}

fn map_nested_error(value: &Value) -> ProviderError {
    let error = value.get("error").unwrap_or(value);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("provider response failed");
    let code = error.get("code").and_then(Value::as_str).unwrap_or("");
    let status = error
        .get("status")
        .and_then(Value::as_u64)
        .map(|status| status as u16);
    let mapped = classify_provider_error(status, code, message);
    let mut provider_error = rerr(mapped, message);
    if let Some(status) = status {
        provider_error.http_status = Some(status);
    }
    provider_error
}

pub fn classify_provider_error(
    status: Option<u16>,
    code: &str,
    message: &str,
) -> ProviderErrorCode {
    let haystack = format!("{code} {message}").to_ascii_lowercase();
    if haystack.contains("context_length")
        || haystack.contains("maximum context")
        || haystack.contains("context length")
    {
        return ProviderErrorCode::ProviderContextLength;
    }
    if haystack.contains("content_filter") || haystack.contains("content filter") {
        return ProviderErrorCode::ProviderContentFilter;
    }
    status
        .map(super::error::http_status_code)
        .unwrap_or(ProviderErrorCode::ProviderResponseFailed)
}

fn rerr(code: ProviderErrorCode, message: &str) -> ProviderError {
    ProviderError::new(code, "openai", "openai-responses-v1", message)
}

fn retarget(mut error: ProviderError) -> ProviderError {
    error.protocol = "openai-responses-v1".into();
    error
}

pub fn continuation_for_scope(
    model: &ModelSelection,
    items: Vec<OpenAiResponseOutputItem>,
    response_id: Option<&str>,
) -> OpenAiResponsesContinuation {
    OpenAiResponsesContinuation {
        scope: crate::protocol::continuation::ContinuationScope {
            provider: model.provider.clone(),
            protocol: model.protocol.clone(),
            model: model.model.clone(),
            model_revision: model.model_revision.clone(),
            endpoint_fingerprint: model.endpoint_fingerprint.clone(),
        },
        response_id: response_id.and_then(|id| ProviderResponseId::from_str_canonical(id).ok()),
        output_items: items,
    }
}

pub fn drop_incompatible_continuation(
    continuation: Option<&OpenAiResponsesContinuation>,
    target: &ModelSelection,
    replay_policy: &str,
) -> Result<Option<OpenAiResponsesContinuation>, ProviderError> {
    let Some(continuation) = continuation else {
        return Ok(None);
    };
    let wrapped = ProviderContinuation::OpenAiResponses(continuation.clone());
    if continuation_compatible(&wrapped, target) && replay_policy == "active" {
        Ok(Some(continuation.clone()))
    } else if continuation_compatible(&wrapped, target) {
        Ok(None)
    } else {
        Err(rerr(
            ProviderErrorCode::ContinuationIncompatible,
            "continuation scope mismatch",
        ))
    }
}
