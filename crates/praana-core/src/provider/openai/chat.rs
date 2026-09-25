//! OpenAI and OpenRouter Chat Completions conversion.

use serde_json::{Map, Value};

use crate::protocol::messages::{
    AssistantBlock, AssistantMessage, ConversationMessage, FinishReason, ImageBlock, ImageSource,
    TextBlock, ToolCall, UserBlock, UserMessage,
};
use crate::protocol::models::{ProviderUsage, ReasoningEffort};
use crate::protocol::tool_result::{ToolResultContent, ToolResultMessage};
use crate::tools::{ToolCatalog, ToolDescriptor};

use super::error::{ProviderError, ProviderErrorCode};
use super::sse::{parse_sse_bytes, SseFrame};
use super::usage::{usage_from_chat, OpenAiUsageAccumulator, UsageConversion};

pub(super) const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
pub(super) const MAX_IMAGES: usize = 10;
const MAX_TOOL_CALL_INDEX: u64 = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolChoiceV1 {
    Auto,
    None,
    Required,
    Named,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatProfileKind {
    OpenAi,
    OpenRouter,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChatFormatInput<'a> {
    pub profile: ChatProfileKind,
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
    pub image_input_supported: bool,
    pub internal_compaction_control: Option<&'a str>,
    pub compaction_schema: Option<&'a Value>,
}

pub fn format_chat_body(input: &ChatFormatInput<'_>) -> Result<Value, ProviderError> {
    validate_reasoning_temperature(
        &input.reasoning,
        input.temperature_milli,
        input.temperature_with_reasoning,
        input.profile,
    )?;
    if matches!(input.tool_choice, ToolChoiceV1::Named) {
        return Err(err(
            input.profile,
            ProviderErrorCode::UnsupportedOption,
            "named tool choice is deferred",
        ));
    }
    let mut messages = Vec::new();
    messages.push(serde_json::json!({
        "role": "system",
        "content": input.instructions,
    }));
    let mut image_count = 0usize;
    for message in input.messages {
        match message {
            ConversationMessage::User(user) => {
                messages.push(map_user(input, user, &mut image_count)?);
            }
            ConversationMessage::Assistant(assistant) => {
                messages.push(map_assistant(input.profile, assistant)?);
            }
            ConversationMessage::ToolResult(result) => {
                messages.push(map_tool_result(input.profile, result)?);
            }
        }
    }
    if let Some(control) = input.internal_compaction_control {
        messages.push(serde_json::json!({
            "role": "user",
            "content": format!("[PRAANA:INTERNAL_COMPACTION_CONTROL]\n{control}\n[/PRAANA:INTERNAL_COMPACTION_CONTROL]\n"),
        }));
    }
    validate_tool_groups(input.messages)
        .map_err(|code| err(input.profile, code, "incomplete tool group"))?;
    let mut body = Map::new();
    body.insert("model".into(), Value::String(input.model.to_owned()));
    body.insert("messages".into(), Value::Array(messages));
    body.insert("stream".into(), Value::Bool(true));
    body.insert(
        "stream_options".into(),
        serde_json::json!({"include_usage": true}),
    );
    let max_field = match input.profile {
        ChatProfileKind::OpenAi => "max_completion_tokens",
        ChatProfileKind::OpenRouter => "max_tokens",
    };
    body.insert(
        max_field.into(),
        Value::Number(input.resolved_max_output_tokens.into()),
    );
    if !input.tools.descriptors().is_empty() {
        let tools = input
            .tools
            .descriptors()
            .iter()
            .map(|descriptor| map_tool(input.profile, descriptor))
            .collect::<Result<Vec<_>, _>>()?;
        body.insert("tools".into(), Value::Array(tools));
        body.insert(
            "tool_choice".into(),
            Value::String(choice_wire(input.tool_choice).to_owned()),
        );
        if input.parallel_tools {
            body.insert("parallel_tool_calls".into(), Value::Bool(true));
        }
    }
    if let Some(milli) = input.temperature_milli {
        body.insert(
            "temperature".into(),
            serde_json::Number::from_f64(milli as f64 / 1000.0)
                .map(Value::Number)
                .ok_or_else(|| {
                    err(
                        input.profile,
                        ProviderErrorCode::UnsupportedOption,
                        "non-finite temperature",
                    )
                })?,
        );
    }
    if !matches!(input.reasoning, ReasoningEffort::Off) {
        match input.profile {
            ChatProfileKind::OpenAi => {
                body.insert(
                    "reasoning_effort".into(),
                    Value::String(effort_wire(&input.reasoning).to_owned()),
                );
            }
            ChatProfileKind::OpenRouter => {
                body.insert(
                    "reasoning".into(),
                    serde_json::json!({
                        "effort": effort_wire(&input.reasoning),
                        "exclude": false
                    }),
                );
            }
        }
    }
    if let Some(schema) = input.compaction_schema {
        body.insert(
            "response_format".into(),
            serde_json::json!({
                "type": "json_schema",
                "json_schema": {
                    "name": "praana_compaction_candidate_v1",
                    "strict": true,
                    "schema": schema
                }
            }),
        );
    }
    Ok(Value::Object(body))
}

fn map_user(
    input: &ChatFormatInput<'_>,
    user: &UserMessage,
    image_count: &mut usize,
) -> Result<Value, ProviderError> {
    let mut parts = Vec::new();
    let mut saw_image = false;
    for block in &user.blocks {
        match block {
            UserBlock::Text(TextBlock { text }) => {
                if !text.is_empty() {
                    parts.push(serde_json::json!({"type": "text", "text": text}));
                }
            }
            UserBlock::Image(image) => {
                saw_image = true;
                parts.push(map_image(input, image, image_count)?);
            }
            UserBlock::ArtifactRef(_) => {
                return Err(err(
                    input.profile,
                    ProviderErrorCode::UnsupportedContent,
                    "artifact refs are not wire images",
                ));
            }
        }
    }
    if parts.is_empty() {
        return Err(err(
            input.profile,
            ProviderErrorCode::CanonicalRequestInvalid,
            "empty user message",
        ));
    }
    if !saw_image && parts.len() == 1 {
        if let Some(text) = parts[0].get("text").and_then(Value::as_str) {
            return Ok(serde_json::json!({"role": "user", "content": text}));
        }
    }
    Ok(serde_json::json!({"role": "user", "content": parts}))
}

fn map_image(
    input: &ChatFormatInput<'_>,
    image: &ImageBlock,
    image_count: &mut usize,
) -> Result<Value, ProviderError> {
    if !input.image_input_supported {
        return Err(err(
            input.profile,
            ProviderErrorCode::UnsupportedContent,
            "image input is unsupported",
        ));
    }
    if !matches!(
        image.media_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return Err(err(
            input.profile,
            ProviderErrorCode::UnsupportedContent,
            "unsupported image media type",
        ));
    }
    let ImageSource::InlineBase64(inline) = &image.source else {
        return Err(err(
            input.profile,
            ProviderErrorCode::UnsupportedContent,
            "remote image urls are rejected",
        ));
    };
    if inline.data.contains("://") {
        return Err(err(
            input.profile,
            ProviderErrorCode::UnsupportedContent,
            "remote image urls are rejected",
        ));
    }
    let decoded = base64_decode(&inline.data).map_err(|_| {
        err(
            input.profile,
            ProviderErrorCode::CanonicalRequestInvalid,
            "image base64 is invalid",
        )
    })?;
    if decoded.len() > MAX_IMAGE_BYTES || inline.byte_count as usize != decoded.len() {
        return Err(err(
            input.profile,
            ProviderErrorCode::CanonicalRequestInvalid,
            "image exceeds 20 MiB",
        ));
    }
    *image_count += 1;
    if *image_count > MAX_IMAGES {
        return Err(err(
            input.profile,
            ProviderErrorCode::CanonicalRequestInvalid,
            "image count exceeds 10",
        ));
    }
    let url = format!("data:{};base64,{}", image.media_type, inline.data);
    Ok(serde_json::json!({"type": "image_url", "image_url": {"url": url}}))
}

fn map_assistant(
    profile: ChatProfileKind,
    assistant: &AssistantMessage,
) -> Result<Value, ProviderError> {
    let mut text = String::new();
    let mut refusal: Option<&str> = None;
    let mut calls = Vec::new();
    let mut saw_call = false;
    let mut saw_refusal = false;
    for block in &assistant.blocks {
        match block {
            AssistantBlock::Text(TextBlock { text: part }) => {
                if saw_call || saw_refusal {
                    return Err(err(
                        profile,
                        ProviderErrorCode::CanonicalRequestInvalid,
                        "text after tool or refusal",
                    ));
                }
                text.push_str(part);
            }
            AssistantBlock::ReasoningSummary(_) => {}
            AssistantBlock::Refusal(block) => {
                if saw_call || saw_refusal || block.text.is_empty() {
                    return Err(err(
                        profile,
                        ProviderErrorCode::CanonicalRequestInvalid,
                        "invalid refusal placement",
                    ));
                }
                saw_refusal = true;
                refusal = Some(block.text.as_str());
            }
            AssistantBlock::ToolCall(call) => {
                if saw_refusal {
                    return Err(err(
                        profile,
                        ProviderErrorCode::CanonicalRequestInvalid,
                        "tool call after refusal",
                    ));
                }
                saw_call = true;
                calls.push(map_call(profile, call)?);
            }
            AssistantBlock::Image(_) => {
                return Err(err(
                    profile,
                    ProviderErrorCode::UnsupportedContent,
                    "assistant images are unsupported",
                ));
            }
        }
    }
    let mut value = Map::new();
    value.insert("role".into(), Value::String("assistant".into()));
    if text.is_empty() {
        value.insert("content".into(), Value::Null);
    } else {
        value.insert("content".into(), Value::String(text));
    }
    if let Some(refusal) = refusal {
        value.insert("refusal".into(), Value::String(refusal.to_owned()));
    }
    if !calls.is_empty() {
        value.insert("tool_calls".into(), Value::Array(calls));
    }
    Ok(Value::Object(value))
}

fn map_call(profile: ChatProfileKind, call: &ToolCall) -> Result<Value, ProviderError> {
    let parsed: Value = serde_json::from_str(&call.raw_arguments).map_err(|_| {
        err(
            profile,
            ProviderErrorCode::CanonicalRequestInvalid,
            "raw arguments are not json",
        )
    })?;
    let Some(object) = parsed.as_object() else {
        return Err(err(
            profile,
            ProviderErrorCode::CanonicalRequestInvalid,
            "raw arguments are not an object",
        ));
    };
    if object != &call.arguments {
        return Err(err(
            profile,
            ProviderErrorCode::CanonicalRequestInvalid,
            "raw arguments do not match canonical arguments",
        ));
    }
    Ok(serde_json::json!({
        "id": call.call_id.as_str(),
        "type": "function",
        "function": {
            "name": call.name,
            "arguments": call.raw_arguments,
        }
    }))
}

fn map_tool_result(
    profile: ChatProfileKind,
    result: &ToolResultMessage,
) -> Result<Value, ProviderError> {
    Ok(serde_json::json!({
        "role": "tool",
        "tool_call_id": result.call_id.as_str(),
        "content": serialize_tool_output(profile, result)?,
    }))
}

pub fn serialize_tool_output(
    profile: ChatProfileKind,
    result: &ToolResultMessage,
) -> Result<String, ProviderError> {
    let text = match &result.body.content {
        ToolResultContent::Inline(inline) => inline.text.clone(),
        ToolResultContent::Artifact(artifact) => artifact.preview.clone(),
    };
    let status = match result.status {
        crate::protocol::tool_result::ToolResultStatus::Success => "success",
        crate::protocol::tool_result::ToolResultStatus::Error => "error",
        crate::protocol::tool_result::ToolResultStatus::Cancelled => "cancelled",
        crate::protocol::tool_result::ToolResultStatus::Blocked => "blocked",
        crate::protocol::tool_result::ToolResultStatus::Uncertain => "uncertain",
        crate::protocol::tool_result::ToolResultStatus::Skipped => "skipped",
    };
    let value = serde_json::json!({"status": status, "text": text});
    crate::protocol::json::serialize_canonical_string(&value).map_err(|_| {
        err(
            profile,
            ProviderErrorCode::RequestSerializeFailed,
            "tool output serialization failed",
        )
    })
}

fn map_tool(profile: ChatProfileKind, descriptor: &ToolDescriptor) -> Result<Value, ProviderError> {
    validate_schema(profile, &descriptor.input_schema)?;
    if descriptor.description.is_empty() || descriptor.description.len() > 4096 {
        return Err(err(
            profile,
            ProviderErrorCode::CanonicalRequestInvalid,
            "tool description is invalid",
        ));
    }
    Ok(serde_json::json!({
        "type": "function",
        "function": {
            "name": descriptor.name.as_str(),
            "description": descriptor.description,
            "parameters": descriptor.input_schema,
            "strict": descriptor.strict,
        }
    }))
}

pub fn validate_schema(profile: ChatProfileKind, schema: &Value) -> Result<(), ProviderError> {
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return Err(err(
            profile,
            ProviderErrorCode::CanonicalRequestInvalid,
            "tool schema root must be an object",
        ));
    }
    validate_schema_node(profile, schema)
}

fn validate_schema_node(profile: ChatProfileKind, value: &Value) -> Result<(), ProviderError> {
    match value {
        Value::Object(map) => {
            if map.contains_key("$ref") {
                return Err(err(
                    profile,
                    ProviderErrorCode::CanonicalRequestInvalid,
                    "$ref is unsupported",
                ));
            }
            for child in map.values() {
                validate_schema_node(profile, child)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for child in items {
                validate_schema_node(profile, child)?;
            }
            Ok(())
        }
        Value::Number(number) => {
            if number.as_f64().is_none_or(|item| !item.is_finite()) {
                return Err(err(
                    profile,
                    ProviderErrorCode::CanonicalRequestInvalid,
                    "schema number is non-finite",
                ));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

pub fn validate_tool_groups(messages: &[ConversationMessage]) -> Result<(), ProviderErrorCode> {
    let mut expected: Vec<String> = Vec::new();
    for message in messages {
        match message {
            ConversationMessage::Assistant(assistant) => {
                if !expected.is_empty() {
                    return Err(ProviderErrorCode::CanonicalRequestInvalid);
                }
                expected = assistant
                    .blocks
                    .iter()
                    .filter_map(|block| match block {
                        AssistantBlock::ToolCall(call) => Some(call.call_id.as_str().to_owned()),
                        _ => None,
                    })
                    .collect();
            }
            ConversationMessage::ToolResult(result) => {
                if expected.first().map(String::as_str) != Some(result.call_id.as_str()) {
                    return Err(ProviderErrorCode::CanonicalRequestInvalid);
                }
                expected.remove(0);
            }
            ConversationMessage::User(_) => {
                if !expected.is_empty() {
                    return Err(ProviderErrorCode::CanonicalRequestInvalid);
                }
            }
        }
    }
    if expected.is_empty() {
        Ok(())
    } else {
        Err(ProviderErrorCode::CanonicalRequestInvalid)
    }
}

fn choice_wire(choice: ToolChoiceV1) -> &'static str {
    match choice {
        ToolChoiceV1::Auto | ToolChoiceV1::Named => "auto",
        ToolChoiceV1::None => "none",
        ToolChoiceV1::Required => "required",
    }
}

pub fn effort_wire(effort: &ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Off => "off",
        ReasoningEffort::Minimal => "minimal",
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
    }
}

fn validate_reasoning_temperature(
    reasoning: &ReasoningEffort,
    temperature: Option<u32>,
    allowed: bool,
    profile: ChatProfileKind,
) -> Result<(), ProviderError> {
    if temperature.is_some() && *reasoning != ReasoningEffort::Off && !allowed {
        return Err(err(
            profile,
            ProviderErrorCode::UnsupportedOption,
            "temperature is unsupported with reasoning",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenAiAdapterEvent {
    ResponseMetadata {
        response_id: Option<String>,
        model: Option<String>,
    },
    OutputItemStarted {
        output_index: u32,
        item_kind: String,
    },
    TextDelta {
        output_index: u32,
        delta: String,
        refusal: bool,
    },
    ReasoningDelta {
        output_index: u32,
        delta: String,
    },
    ToolCallStarted {
        output_index: u32,
        call_id: String,
        name: String,
    },
    ToolCallArgumentsDelta {
        output_index: u32,
        call_id: String,
        delta: String,
    },
    ToolCallCompleted {
        output_index: u32,
        call: ToolCall,
    },
    OutputItemCompleted {
        output_index: u32,
    },
    Usage(ProviderUsage),
    Completed {
        finish_reason: FinishReason,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatStreamOutcome {
    pub events: Vec<OpenAiAdapterEvent>,
    pub usage: UsageConversion,
    pub finish_reason: FinishReason,
    pub tool_calls: Vec<ToolCall>,
    pub emitted: bool,
    pub usage_telemetry: Vec<&'static str>,
}

#[derive(Default)]
struct CallAcc {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    started: bool,
    buffered: String,
    completed: bool,
}

pub fn parse_chat_stream(bytes: &[u8]) -> Result<ChatStreamOutcome, ProviderError> {
    let frames = parse_sse_bytes(bytes)
        .map_err(|failure| err(ChatProfileKind::OpenAi, failure.code, failure.code.as_str()))?;
    parse_chat_frames(&frames)
}

pub fn parse_chat_frames(frames: &[SseFrame]) -> Result<ChatStreamOutcome, ProviderError> {
    let mut calls: Vec<CallAcc> = Vec::new();
    let mut usage = OpenAiUsageAccumulator::default();
    let mut saw_usage = false;
    let mut finish: Option<String> = None;
    let mut events = Vec::new();
    let mut text = String::new();
    let mut refusal = String::new();
    let mut reasoning = String::new();
    let mut saw_done = false;
    let mut emitted = false;
    for frame in frames {
        if frame.data.is_empty() {
            continue;
        }
        if frame.data == "[DONE]" {
            saw_done = true;
            break;
        }
        let value: Value = serde_json::from_str(&frame.data).map_err(|_| {
            err(
                ChatProfileKind::OpenAi,
                ProviderErrorCode::StreamInvalidJson,
                "chat frame is not json",
            )
        })?;
        if !value.is_object() {
            return Err(err(
                ChatProfileKind::OpenAi,
                ProviderErrorCode::ProtocolViolation,
                "chat frame is not an object",
            ));
        }
        if let Some(model) = value.get("model").and_then(Value::as_str) {
            events.push(OpenAiAdapterEvent::ResponseMetadata {
                response_id: value.get("id").and_then(Value::as_str).map(str::to_owned),
                model: Some(model.to_owned()),
            });
        }
        if let Some(raw_usage) = value.get("usage") {
            if !raw_usage.is_null() {
                usage
                    .observe(&usage_from_chat(raw_usage))
                    .map_err(|code| err(ChatProfileKind::OpenAi, code, "usage decreased"))?;
                saw_usage = true;
            }
        }
        let choices = value.get("choices").and_then(Value::as_array);
        let nonempty = choices
            .map(|items| items.iter().filter(|item| !choice_empty(item)).count())
            .unwrap_or(0);
        if nonempty > 1 {
            return Err(err(
                ChatProfileKind::OpenAi,
                ProviderErrorCode::ProtocolViolation,
                "multiple choices",
            ));
        }
        let Some(choice) = choices.and_then(|items| items.first()) else {
            continue;
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            finish = Some(reason.to_owned());
        }
        let Some(delta) = choice.get("delta") else {
            continue;
        };
        if let Some(content) = nonempty_string(delta, "content") {
            if calls.iter().any(|call| call.started) {
                return Err(err(
                    ChatProfileKind::OpenAi,
                    ProviderErrorCode::ProtocolViolation,
                    "text after tool call",
                ));
            }
            text.push_str(content);
            emitted = true;
            events.push(OpenAiAdapterEvent::TextDelta {
                output_index: 0,
                delta: content.to_owned(),
                refusal: false,
            });
        }
        if let Some(part) = nonempty_string(delta, "refusal") {
            if calls.iter().any(|call| call.started) {
                return Err(err(
                    ChatProfileKind::OpenAi,
                    ProviderErrorCode::ProtocolViolation,
                    "refusal after tool call",
                ));
            }
            refusal.push_str(part);
            emitted = true;
            events.push(OpenAiAdapterEvent::TextDelta {
                output_index: 0,
                delta: part.to_owned(),
                refusal: true,
            });
        }
        let reasoning_a = nonempty_string(delta, "reasoning");
        let reasoning_b = nonempty_string(delta, "reasoning_content");
        match (reasoning_a, reasoning_b) {
            (Some(left), Some(right)) if left != right => {
                return Err(err(
                    ChatProfileKind::OpenAi,
                    ProviderErrorCode::ProtocolViolation,
                    "distinct reasoning fields",
                ));
            }
            (Some(value), _) | (_, Some(value)) => {
                reasoning.push_str(value);
                emitted = true;
                events.push(OpenAiAdapterEvent::ReasoningDelta {
                    output_index: 0,
                    delta: value.to_owned(),
                });
            }
            _ => {}
        }
        if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in tool_calls {
                let index = call.get("index").and_then(Value::as_u64).ok_or_else(|| {
                    err(
                        ChatProfileKind::OpenAi,
                        ProviderErrorCode::ProtocolViolation,
                        "tool call index missing",
                    )
                })?;
                if index > MAX_TOOL_CALL_INDEX {
                    return Err(err(
                        ChatProfileKind::OpenAi,
                        ProviderErrorCode::ProtocolViolation,
                        "tool call index too large",
                    ));
                }
                let index = index as usize;
                if calls.len() <= index {
                    calls.resize_with(index + 1, CallAcc::default);
                }
                let acc = &mut calls[index];
                if acc.completed {
                    return Err(err(
                        ChatProfileKind::OpenAi,
                        ProviderErrorCode::ProtocolViolation,
                        "tool index reused",
                    ));
                }
                if let Some(id) = nonempty_string(call, "id") {
                    if let Some(existing) = &acc.id {
                        if existing != id {
                            return Err(err(
                                ChatProfileKind::OpenAi,
                                ProviderErrorCode::ProtocolViolation,
                                "conflicting call id",
                            ));
                        }
                    } else {
                        acc.id = Some(id.to_owned());
                    }
                }
                if let Some(function) = call.get("function") {
                    if let Some(name) = nonempty_string(function, "name") {
                        if let Some(existing) = &acc.name {
                            if existing != name {
                                return Err(err(
                                    ChatProfileKind::OpenAi,
                                    ProviderErrorCode::ProtocolViolation,
                                    "conflicting function name",
                                ));
                            }
                        } else {
                            acc.name = Some(name.to_owned());
                        }
                    }
                    if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                        if !arguments.is_empty() {
                            if acc.started {
                                events.push(OpenAiAdapterEvent::ToolCallArgumentsDelta {
                                    output_index: index as u32,
                                    call_id: acc.id.clone().unwrap_or_default(),
                                    delta: arguments.to_owned(),
                                });
                            } else {
                                acc.buffered.push_str(arguments);
                            }
                            acc.arguments.push_str(arguments);
                            emitted = true;
                        }
                    }
                }
                if !acc.started {
                    if let (Some(id), Some(name)) = (acc.id.clone(), acc.name.clone()) {
                        acc.started = true;
                        emitted = true;
                        events.push(OpenAiAdapterEvent::ToolCallStarted {
                            output_index: index as u32,
                            call_id: id.clone(),
                            name,
                        });
                        if !acc.buffered.is_empty() {
                            events.push(OpenAiAdapterEvent::ToolCallArgumentsDelta {
                                output_index: index as u32,
                                call_id: id,
                                delta: std::mem::take(&mut acc.buffered),
                            });
                        }
                    }
                }
            }
        }
    }
    if finish.is_none() {
        let code = if saw_done {
            ProviderErrorCode::ProviderEmptyResponse
        } else {
            ProviderErrorCode::StreamTruncated
        };
        return Err(err(ChatProfileKind::OpenAi, code, "missing finish reason"));
    }
    let reason = finish.unwrap();
    let mut tool_calls = Vec::new();
    if reason == "tool_calls" && calls.is_empty() {
        return Err(err(
            ChatProfileKind::OpenAi,
            ProviderErrorCode::ProtocolViolation,
            "tool_calls finish without a call",
        ));
    }
    for (index, acc) in calls.iter_mut().enumerate() {
        let id = acc.id.clone().filter(|id| !id.is_empty()).ok_or_else(|| {
            err(
                ChatProfileKind::OpenAi,
                ProviderErrorCode::ToolCallIdMissing,
                "tool call id missing",
            )
            .redact_secrets(&[])
        })?;
        let name = acc
            .name
            .clone()
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                err(
                    ChatProfileKind::OpenAi,
                    ProviderErrorCode::ProtocolViolation,
                    "tool name missing",
                )
            })?;
        let parsed: Value = serde_json::from_str(&acc.arguments).map_err(|_| {
            err(
                ChatProfileKind::OpenAi,
                ProviderErrorCode::ToolArgumentsInvalid,
                "tool arguments are malformed",
            )
        })?;
        let Some(object) = parsed.as_object().cloned() else {
            return Err(err(
                ChatProfileKind::OpenAi,
                ProviderErrorCode::ToolArgumentsInvalid,
                "tool arguments are not an object",
            ));
        };
        let call = ToolCall {
            call_id: crate::protocol::id::ToolCallId::from_str_canonical(&id).map_err(|_| {
                err(
                    ChatProfileKind::OpenAi,
                    ProviderErrorCode::ToolCallIdMissing,
                    "tool call id missing",
                )
            })?,
            name,
            arguments: object,
            raw_arguments: acc.arguments.clone(),
        };
        acc.completed = true;
        events.push(OpenAiAdapterEvent::ToolCallCompleted {
            output_index: index as u32,
            call: call.clone(),
        });
        tool_calls.push(call);
    }
    let finish_reason = match reason.as_str() {
        "stop" => FinishReason::Stop,
        "tool_calls" => FinishReason::ToolUse,
        "length" => FinishReason::Length,
        "content_filter" => {
            return Err(err(
                ChatProfileKind::OpenAi,
                ProviderErrorCode::ProviderContentFilter,
                "content filter",
            ));
        }
        _ => {
            return Err(err(
                ChatProfileKind::OpenAi,
                ProviderErrorCode::UnsupportedOutputItem,
                "unknown finish reason",
            ));
        }
    };
    if text.is_empty() && refusal.is_empty() && reasoning.is_empty() && tool_calls.is_empty() {
        return Err(err(
            ChatProfileKind::OpenAi,
            ProviderErrorCode::ProviderEmptyResponse,
            "empty completion",
        ));
    }
    let converted = if saw_usage {
        usage.into_protocol_usage()
    } else {
        OpenAiUsageAccumulator::default().into_protocol_usage()
    };
    events.push(OpenAiAdapterEvent::Usage(converted.usage.clone()));
    events.push(OpenAiAdapterEvent::Completed {
        finish_reason: finish_reason.clone(),
    });
    let _ = (saw_done, reasoning);
    Ok(ChatStreamOutcome {
        events,
        usage_telemetry: converted.telemetry_names(),
        usage: converted,
        finish_reason,
        tool_calls,
        emitted,
    })
}

fn choice_empty(choice: &Value) -> bool {
    choice.get("delta").is_none()
        && choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .is_none()
}

fn nonempty_string<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn err(profile: ChatProfileKind, code: ProviderErrorCode, message: &str) -> ProviderError {
    let provider = match profile {
        ChatProfileKind::OpenAi => "openai",
        ChatProfileKind::OpenRouter => "openrouter",
    };
    ProviderError::new(code, provider, "openai-chat-v1", message)
}

pub(super) fn base64_decode(input: &str) -> Result<Vec<u8>, ()> {
    fn val(byte: u8) -> Result<u8, ()> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(()),
        }
    }
    let bytes = input.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return Err(());
    }
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().rev().take_while(|byte| **byte == b'=').count();
        if pad > 2 {
            return Err(());
        }
        let a = val(chunk[0])?;
        let b = val(chunk[1])?;
        let c = if chunk[2] == b'=' { 0 } else { val(chunk[2])? };
        let d = if chunk[3] == b'=' { 0 } else { val(chunk[3])? };
        out.push((a << 2) | (b >> 4));
        if pad < 2 {
            out.push((b << 4) | (c >> 2));
        }
        if pad < 1 {
            out.push((c << 6) | d);
        }
    }
    Ok(out)
}
