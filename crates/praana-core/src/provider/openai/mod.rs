//! OpenAI Chat, OpenAI Responses, and OpenRouter Chat runtime.

mod attempt;
mod chat;
mod error;
mod responses;
mod sse;
mod usage;

pub use attempt::{
    admission_for_retry, crosses_emission, fail_open_attempt, resolve_provider_credential,
    run_pre_request, switch_model, terminal_wins, AttemptGate, CancellableSocket,
    PreRequestDecision,
};
pub use chat::{
    format_chat_body, parse_chat_frames, parse_chat_stream, ChatFormatInput, ChatProfileKind,
    ChatStreamOutcome, OpenAiAdapterEvent, ToolChoiceV1,
};
pub use error::{ProviderError, ProviderErrorCode, FIXTURE_BUILD_VERSION};
pub use responses::{
    continuation_for_scope, drop_incompatible_continuation, format_responses_body,
    parse_responses_frames, parse_responses_stream, ResponsesFormatInput, ResponsesStreamOutcome,
};
pub use sse::{parse_sse_bytes, SseFrame, SseParser, MAX_EVENT_DATA_BYTES, MAX_LINE_BYTES};
pub use usage::{usage_from_chat, usage_from_responses, OpenAiUsageAccumulator, UsageConversion};

use std::collections::BTreeMap;

use serde_json::Value;

use crate::history::event_log::EventLogStore;
use crate::protocol::events::{
    AssistantAttemptStarted, AssistantStepPurpose, CanonicalEvent, EventEnvelope,
    ProviderAttemptPurpose, SessionStarted, TurnStarted, UserMessageAccepted,
};
use crate::protocol::hashes::calculate_request_hash;
use crate::protocol::id::{AttemptId, EventId, MessageId, SessionId, Sha256Digest, StepId, TurnId};
use crate::protocol::messages::{TextBlock, UserBlock, UserMessage};
use crate::protocol::models::{AdmissionSnapshot, HistoryMode, ModelSelection, ReasoningEffort};
use crate::provider::profile::{
    profile_hash, ImageInputCapability, ModelCapabilityProfile, ReasoningAccounting,
};
use crate::system_context::InstructionSlotsV1;
use crate::token::{
    calculate_request_component_manifest, FramingProfileV1, GenericTokenEstimatorV1,
    RequestComponentKind, TokenEstimateV1, TokenEstimationContext, TokenEstimatorV1,
    TOKEN_ESTIMATOR_SCHEMA_VERSION,
};

pub const OPENROUTER_REFERER: &str = "https://github.com/amitkumardubey/praana";
pub const OPENROUTER_TITLE: &str = "PRAANA";

const PROTECTED_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "host",
    "content-length",
    "content-type",
    "accept",
    "user-agent",
    "http-referer",
    "x-title",
];

pub fn compile_instructions(slots: &InstructionSlotsV1) -> Result<String, ProviderError> {
    if slots.system_policy.is_empty() {
        return Err(ProviderError::new(
            ProviderErrorCode::CanonicalRequestInvalid,
            "openai",
            "openai-chat-v1",
            "system policy is missing",
        ));
    }
    let mut blocks = vec![
        render_block("SYSTEM_POLICY", &slots.system_policy),
        render_block("PROJECT_CONTEXT_DATA", &slots.project_context),
    ];
    if let Some(memory) = &slots.cross_session_memory {
        blocks.push(render_block("CROSS_SESSION_MEMORY_DATA", memory));
    }
    let handoff = slots.historical_handoff.as_deref().unwrap_or("");
    blocks.push(render_block("HISTORICAL_HANDOFF_DATA", handoff));
    blocks.push(render_block("CURRENT_STATE_DATA", &slots.current_state));
    Ok(blocks.join("\n\n"))
}

fn render_block(kind: &str, content: &str) -> String {
    let content = normalize_newlines(content);
    format!("[PRAANA:{kind}]\n{content}\n[/PRAANA:{kind}]")
}

pub fn normalize_newlines(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(ch);
        }
    }
    out
}

pub fn build_endpoint(base_url: &str, endpoint: &str) -> Result<String, ProviderError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let (scheme, rest) = trimmed.split_once("://").ok_or_else(url_err)?;
    if rest.contains('@') || rest.contains('?') || rest.contains('#') {
        return Err(url_err());
    }
    let authority = rest.split('/').next().unwrap_or("");
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split_once(']').map(|(host, _)| host).unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    let loopback = host == "localhost" || host == "127.0.0.1" || host == "::1";
    match scheme {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(url_err()),
    }
    let suffix = endpoint.trim_start_matches('/');
    Ok(format!("{trimmed}/{suffix}"))
}

fn url_err() -> ProviderError {
    ProviderError::new(
        ProviderErrorCode::BaseUrlInvalid,
        "openai",
        "openai-chat-v1",
        "base url is invalid",
    )
}

pub fn build_headers(
    provider: &str,
    build_version: &str,
    extra: &BTreeMap<String, String>,
    authorization: Option<&str>,
) -> Result<Vec<(String, String)>, ProviderError> {
    for (name, value) in extra {
        if !valid_header_token(name)
            || value
                .chars()
                .any(|ch| ch == '\r' || ch == '\n' || ch == '\0')
        {
            return Err(ProviderError::new(
                ProviderErrorCode::HeaderInvalid,
                provider,
                "openai-chat-v1",
                "header is invalid",
            ));
        }
        if PROTECTED_HEADERS
            .iter()
            .any(|protected| protected.eq_ignore_ascii_case(name))
        {
            return Err(ProviderError::new(
                ProviderErrorCode::HeaderForbidden,
                provider,
                "openai-chat-v1",
                "protected header override",
            ));
        }
    }
    let mut headers = vec![
        ("content-type".into(), "application/json".into()),
        ("accept".into(), "text/event-stream".into()),
        ("user-agent".into(), format!("praana/{build_version}")),
    ];
    if provider == "openrouter" {
        headers.push(("http-referer".into(), OPENROUTER_REFERER.into()));
        headers.push(("x-title".into(), OPENROUTER_TITLE.into()));
    }
    if let Some(token) = authorization {
        headers.push(("authorization".into(), format!("Bearer {token}")));
    }
    for (name, value) in extra {
        headers.push((name.to_ascii_lowercase(), value.clone()));
    }
    Ok(headers)
}

fn valid_header_token(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|byte| {
            matches!(byte, b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z')
        })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdmissionEstimate {
    pub token_estimator_schema_version: u32,
    pub estimator_id: String,
    pub estimated_input_sha256: Sha256Digest,
    pub system_tokens: u64,
    pub tool_schema_tokens: u64,
    pub memory_bootstrap_tokens: u64,
    pub handoff_tokens: u64,
    pub retained_message_tokens: u64,
    pub state_graph_tokens: u64,
    pub active_tool_cycle_tokens: u64,
    pub continuation_tokens: u64,
    pub provider_framing_tokens: u64,
    pub total_input_tokens: u64,
    pub output_reserve_tokens: u64,
    pub reasoning_reserve_tokens: u64,
    pub safety_margin_tokens: u64,
    pub usable_input_tokens: u64,
    pub fill_ppm: u64,
    pub admitted: bool,
    pub request_hash: Sha256Digest,
    pub estimator_health_alert: Option<&'static str>,
    pub snapshot: AdmissionSnapshot,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AdmissionDecision {
    Admit(AdmissionEstimate),
    ReduceOutput {
        new_max_output_tokens: u64,
        estimate: AdmissionEstimate,
    },
    Reject {
        code: ProviderErrorCode,
        estimated_input: u64,
        reserve: u64,
        context_window: u64,
    },
}

pub struct AdmissionRequest<'a> {
    pub profile: Option<&'a ModelCapabilityProfile>,
    pub configured_context_window: u64,
    pub unsafe_increase: bool,
    pub requested_max_output: u64,
    pub configured_min_output: u64,
    pub reasoning_reserve_tokens: u64,
    pub safety_margin_min_tokens: u64,
    pub safety_margin_ratio: f64,
    pub calibration_margin: u64,
    pub component_bytes: [Vec<u8>; 9],
    pub framing: FramingProfileV1,
    pub image_count: u64,
    pub request_body: &'a Value,
    pub estimate_reused_from: Option<crate::protocol::id::AttemptId>,
}

pub fn admit(request: &AdmissionRequest<'_>) -> Result<AdmissionDecision, ProviderError> {
    let window = resolve_window(request)?;
    let (min_output, max_output, reasoning) = match request.profile {
        Some(profile) => (
            request.configured_min_output.max(profile.min_output_tokens),
            profile.max_output_tokens,
            &profile.reasoning_accounting,
        ),
        None => (
            request.configured_min_output,
            request
                .requested_max_output
                .max(request.configured_min_output),
            &ReasoningAccounting::IncludedInOutputLimit,
        ),
    };
    if min_output > max_output {
        return Err(ProviderError::new(
            ProviderErrorCode::CompactionProfileInvalid,
            "openai",
            "openai-chat-v1",
            "profile output range is empty",
        ));
    }
    let rout = request.requested_max_output.clamp(min_output, max_output);
    let rreason = reasoning_reserve(reasoning, request.reasoning_reserve_tokens)?;
    let margin_capped = {
        let (margin, capped) = safety_margin(
            window,
            request.safety_margin_min_tokens,
            request.safety_margin_ratio,
            request.calibration_margin,
        )?;
        (margin, capped)
    };
    let margin = margin_capped.0;
    let margin_capped = margin_capped.1;
    let mut framing = request.framing.clone();
    if let Some(profile) = request.profile {
        if let ImageInputCapability::Supported { occupancy } = &profile.image_input {
            framing.additional_tokens =
                occupancy
                    .image_contribution(request.image_count)
                    .map_err(|_| {
                        ProviderError::new(
                            ProviderErrorCode::AdmissionArithmeticOverflow,
                            "openai",
                            "openai-chat-v1",
                            "image occupancy overflow",
                        )
                    })?;
        }
    }
    let parts = components_from_wire(request.request_body)
        .unwrap_or_else(|| request.component_bytes.clone());
    let estimates = estimate_components(&parts, &framing)?;
    let (manifest, digest, total) =
        calculate_request_component_manifest(&estimates).map_err(|_| {
            ProviderError::new(
                ProviderErrorCode::AdmissionArithmeticOverflow,
                "openai",
                "openai-chat-v1",
                "component manifest overflow",
            )
        })?;
    let _ = manifest;
    let request_hash = calculate_request_hash(request.request_body).map_err(|_| {
        ProviderError::new(
            ProviderErrorCode::RequestSerializeFailed,
            "openai",
            "openai-chat-v1",
            "request hash failed",
        )
    })?;
    let profile_digest = match request.profile {
        Some(profile) => profile_hash(profile).map_err(|_| {
            ProviderError::new(
                ProviderErrorCode::RequestSerializeFailed,
                "openai",
                "openai-chat-v1",
                "profile hash failed",
            )
        })?,
        None => Sha256Digest::digest_bytes(b"unknown-window"),
    };
    let decision = decide(
        window,
        total,
        rout,
        rreason,
        margin,
        &estimates,
        &digest,
        &profile_digest,
        request.estimate_reused_from,
    )?;
    let alert = margin_capped.then_some("estimator-health");
    if let AdmissionDecision::Reject { .. } = &decision {
        if rout > min_output {
            let reduced = min_output;
            let mut reduced_request_note = decision.clone();
            if let AdmissionDecision::Admit(estimate)
            | AdmissionDecision::ReduceOutput { estimate, .. } = &mut reduced_request_note
            {
                estimate.output_reserve_tokens = reduced;
            }
            let retry = decide(
                window,
                total,
                reduced,
                rreason,
                margin,
                &estimates,
                &digest,
                &profile_digest,
                request.estimate_reused_from,
            )?;
            if let AdmissionDecision::Admit(estimate) = retry {
                return Ok(stamp(
                    AdmissionDecision::ReduceOutput {
                        new_max_output_tokens: reduced,
                        estimate,
                    },
                    request_hash,
                    alert,
                ));
            }
        }
    }
    Ok(stamp(decision, request_hash, alert))
}

#[allow(clippy::too_many_arguments)]
fn decide(
    window: u64,
    total: u64,
    rout: u64,
    rreason: u64,
    margin: u64,
    estimates: &[TokenEstimateV1],
    digest: &Sha256Digest,
    profile_digest: &Sha256Digest,
    reused: Option<crate::protocol::id::AttemptId>,
) -> Result<AdmissionDecision, ProviderError> {
    let usable = window
        .checked_sub(rout)
        .and_then(|value| value.checked_sub(rreason))
        .and_then(|value| value.checked_sub(margin))
        .ok_or_else(|| {
            ProviderError::new(
                ProviderErrorCode::AdmissionArithmeticOverflow,
                "openai",
                "openai-chat-v1",
                "usable input underflow",
            )
        })?;
    let fill = fill_ppm(total, usable)?;
    let protocol_ok = total
        .checked_add(rout)
        .and_then(|value| value.checked_add(rreason))
        .is_some_and(|sum| sum <= window);
    let admitted = usable > 0 && total <= usable && protocol_ok;
    let estimate = AdmissionEstimate {
        token_estimator_schema_version: TOKEN_ESTIMATOR_SCHEMA_VERSION,
        estimator_id: estimates
            .first()
            .map(|item| item.estimator_id.clone())
            .unwrap_or_default(),
        estimated_input_sha256: digest.clone(),
        system_tokens: component_total(estimates, 0),
        tool_schema_tokens: component_total(estimates, 1),
        memory_bootstrap_tokens: component_total(estimates, 2),
        handoff_tokens: component_total(estimates, 3),
        retained_message_tokens: component_total(estimates, 4),
        state_graph_tokens: component_total(estimates, 5),
        active_tool_cycle_tokens: component_total(estimates, 6),
        continuation_tokens: component_total(estimates, 7),
        provider_framing_tokens: component_total(estimates, 8),
        total_input_tokens: total,
        output_reserve_tokens: rout,
        reasoning_reserve_tokens: rreason,
        safety_margin_tokens: margin,
        usable_input_tokens: usable,
        fill_ppm: fill,
        admitted,
        request_hash: Sha256Digest::digest_bytes(b""),
        estimator_health_alert: None,
        snapshot: AdmissionSnapshot {
            token_estimator_schema_version: TOKEN_ESTIMATOR_SCHEMA_VERSION,
            estimator_id: estimates
                .first()
                .map(|item| item.estimator_id.clone())
                .unwrap_or_default(),
            estimated_input_sha256: digest.clone(),
            context_window_tokens: window,
            estimated_input_tokens: total,
            resolved_output_tokens: rout,
            requested_reasoning_tokens: rreason,
            safety_margin_tokens: margin,
            projected_fill_millionths: u32::try_from(fill).unwrap_or(u32::MAX),
            capability_profile_hash: profile_digest.clone(),
            estimate_reused_from_attempt_id: reused,
        },
    };
    if admitted {
        Ok(AdmissionDecision::Admit(estimate))
    } else {
        Ok(AdmissionDecision::Reject {
            code: ProviderErrorCode::ContextOverflow,
            estimated_input: total,
            reserve: rout.saturating_add(rreason).saturating_add(margin),
            context_window: window,
        })
    }
}

fn stamp(
    decision: AdmissionDecision,
    request_hash: Sha256Digest,
    alert: Option<&'static str>,
) -> AdmissionDecision {
    match decision {
        AdmissionDecision::Admit(mut estimate) => {
            estimate.request_hash = request_hash;
            estimate.estimator_health_alert = alert;
            AdmissionDecision::Admit(estimate)
        }
        AdmissionDecision::ReduceOutput {
            new_max_output_tokens,
            mut estimate,
        } => {
            estimate.request_hash = request_hash;
            estimate.estimator_health_alert = alert;
            AdmissionDecision::ReduceOutput {
                new_max_output_tokens,
                estimate,
            }
        }
        other => other,
    }
}

fn components_from_wire(body: &Value) -> Option<[Vec<u8>; 9]> {
    let object = body.as_object()?;
    if !object.contains_key("messages")
        && !object.contains_key("input")
        && !object.contains_key("instructions")
        && !object.contains_key("tools")
    {
        return None;
    }
    let mut parts: [Vec<u8>; 9] = std::array::from_fn(|_| Vec::new());
    if let Some(instructions) = object.get("instructions").and_then(Value::as_str) {
        parts[0] = instructions.as_bytes().to_vec();
    }
    if let Some(messages) = object.get("messages").and_then(Value::as_array) {
        let mut index = 0;
        if messages
            .first()
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            == Some("system")
        {
            parts[0] = serde_json::to_vec(&messages[0]).unwrap_or_default();
            index = 1;
        }
        for message in messages.iter().skip(index) {
            let slot = if message.get("role").and_then(Value::as_str) == Some("tool") {
                6
            } else {
                4
            };
            parts[slot].extend(serde_json::to_vec(message).unwrap_or_default());
        }
    }
    if let Some(input) = object.get("input").and_then(Value::as_array) {
        for item in input {
            let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
            let slot = if kind == "reasoning" || kind == "function_call" {
                7
            } else if kind == "function_call_output" {
                6
            } else {
                4
            };
            parts[slot].extend(serde_json::to_vec(item).unwrap_or_default());
        }
    }
    if let Some(tools) = object.get("tools") {
        parts[1] = serde_json::to_vec(tools).unwrap_or_default();
    }
    Some(parts)
}

fn component_total(estimates: &[TokenEstimateV1], index: usize) -> u64 {
    estimates
        .get(index)
        .map(|item| item.total_tokens)
        .unwrap_or(0)
}

fn estimate_components(
    parts: &[Vec<u8>; 9],
    framing: &FramingProfileV1,
) -> Result<Vec<TokenEstimateV1>, ProviderError> {
    let kinds = [
        RequestComponentKind::System,
        RequestComponentKind::ToolSchema,
        RequestComponentKind::MemoryBootstrap,
        RequestComponentKind::Handoff,
        RequestComponentKind::RetainedMessages,
        RequestComponentKind::StateGraph,
        RequestComponentKind::ActiveToolCycle,
        RequestComponentKind::Continuation,
        RequestComponentKind::ProviderFraming,
    ];
    let estimator = GenericTokenEstimatorV1;
    let zero = FramingProfileV1 {
        framing_profile_schema_version: framing.framing_profile_schema_version,
        framing_profile_id: framing.framing_profile_id.clone(),
        fixed_tokens: 0,
        per_item_tokens: 0,
        item_count: 0,
        additional_tokens: 0,
    };
    let mut estimates = Vec::with_capacity(9);
    for (index, kind) in kinds.iter().enumerate() {
        let profile = if *kind == RequestComponentKind::ProviderFraming {
            framing
        } else {
            &zero
        };
        let context = TokenEstimationContext::ProviderRequestComponent { component: *kind };
        estimates.push(
            estimator
                .estimate(context, &parts[index], profile)
                .map_err(|_| {
                    ProviderError::new(
                        ProviderErrorCode::AdmissionArithmeticOverflow,
                        "openai",
                        "openai-chat-v1",
                        "estimate failed",
                    )
                })?,
        );
    }
    Ok(estimates)
}

fn resolve_window(request: &AdmissionRequest<'_>) -> Result<u64, ProviderError> {
    match request.profile {
        Some(profile) => {
            let mut window = profile.context_window_tokens;
            if request.configured_context_window > 0
                && (request.configured_context_window < window || request.unsafe_increase)
            {
                window = request.configured_context_window;
            }
            if window == 0 {
                return Err(ProviderError::new(
                    ProviderErrorCode::AdmissionContextWindowUnknown,
                    "openai",
                    "openai-chat-v1",
                    "context window is unknown",
                ));
            }
            Ok(window)
        }
        None => {
            if request.configured_context_window == 0 {
                Err(ProviderError::new(
                    ProviderErrorCode::AdmissionContextWindowUnknown,
                    "openai",
                    "openai-chat-v1",
                    "context window is unknown",
                ))
            } else {
                Ok(request.configured_context_window)
            }
        }
    }
}

fn reasoning_reserve(
    accounting: &ReasoningAccounting,
    configured: u64,
) -> Result<u64, ProviderError> {
    Ok(match accounting {
        ReasoningAccounting::IncludedInOutputLimit => 0,
        ReasoningAccounting::SeparateWindow {
            default_reserve_tokens,
        } => {
            if configured > 0 {
                configured
            } else {
                *default_reserve_tokens
            }
        }
        ReasoningAccounting::Unknown {
            conservative_reserve_tokens,
        } => configured.max(*conservative_reserve_tokens),
    })
}

fn safety_margin(
    window: u64,
    min_tokens: u64,
    ratio: f64,
    calibration: u64,
) -> Result<(u64, bool), ProviderError> {
    let ratio_tokens = (ratio * window as f64).ceil() as u64;
    let mut margin = min_tokens.max(ratio_tokens).max(calibration);
    let cap = window / 10;
    let capped = margin > cap;
    if capped {
        margin = cap;
    }
    Ok((margin, capped))
}

fn fill_ppm(input: u64, usable: u64) -> Result<u64, ProviderError> {
    let denominator = usable.max(1);
    let product = input.checked_mul(1_000_000).ok_or_else(|| {
        ProviderError::new(
            ProviderErrorCode::AdmissionArithmeticOverflow,
            "openai",
            "openai-chat-v1",
            "fill overflow",
        )
    })?;
    Ok(product.div_ceil(denominator))
}

pub fn redact_header_log(headers: &[(String, String)]) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(name, value)| {
            let secret = matches!(
                name.to_ascii_lowercase().as_str(),
                "authorization" | "proxy-authorization" | "cookie" | "set-cookie"
            );
            (
                name.clone(),
                if secret {
                    error::REDACTED.to_owned()
                } else {
                    value.clone()
                },
            )
        })
        .collect()
}

pub fn reasoning_allowed(profile: &ModelCapabilityProfile, effort: ReasoningEffort) -> bool {
    effort == ReasoningEffort::Off || profile.reasoning_efforts.iter().any(|item| item == &effort)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptExchange {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub trait ProviderTransport {
    fn exchange(
        &mut self,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> Result<AttemptExchange, ProviderError>;
}

pub struct RetryPolicy {
    pub max_attempts: u32,
    pub retry_wall_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            retry_wall_ms: 60_000,
        }
    }
}

pub struct RetryOutcome {
    pub attempts: u32,
    pub exchange: Option<AttemptExchange>,
    pub error: Option<ProviderError>,
}

#[allow(clippy::too_many_arguments)]
pub fn run_with_retry<T, C, R, S>(
    ledger: &mut RetryLedger,
    transport: &mut T,
    url: &str,
    headers: &[(String, String)],
    body: &[u8],
    policy: &RetryPolicy,
    mut aborted: impl FnMut() -> bool,
    mut clock_ms: C,
    mut rng: R,
    mut sleeper: S,
    mut before_send: impl FnMut(u32) -> Result<(), ProviderError>,
) -> RetryOutcome
where
    T: ProviderTransport,
    C: FnMut() -> i64,
    R: FnMut(u64) -> u64,
    S: FnMut(u64),
{
    let mut spent_ms = 0u64;
    let mut last_error = None;
    for attempt in 1..=policy.max_attempts {
        if aborted() {
            return RetryOutcome {
                attempts: attempt - 1,
                exchange: None,
                error: Some(ProviderError::new(
                    ProviderErrorCode::Aborted,
                    "openai",
                    "openai-chat-v1",
                    "aborted",
                )),
            };
        }
        if let Err(error) = ledger.begin(attempt, body) {
            return RetryOutcome {
                attempts: attempt.saturating_sub(1),
                exchange: None,
                error: Some(error),
            };
        }
        if let Err(error) = before_send(attempt) {
            return RetryOutcome {
                attempts: attempt.saturating_sub(1),
                exchange: None,
                error: Some(error),
            };
        }
        match transport.exchange(url, headers, body) {
            Ok(exchange) => {
                let code = classify_http(exchange.status, &exchange.body);
                let retryable =
                    code.generic_retry_before_emission() && !body_crossed_emission(&exchange.body);
                if !retryable || attempt == policy.max_attempts {
                    if (200..300).contains(&exchange.status) {
                        return RetryOutcome {
                            attempts: attempt,
                            exchange: Some(exchange),
                            error: None,
                        };
                    }
                    return RetryOutcome {
                        attempts: attempt,
                        exchange: None,
                        error: Some(http_error(
                            code,
                            exchange.status,
                            &exchange.headers,
                            &exchange.body,
                        )),
                    };
                }
                let now = clock_ms();
                let delay = retry_delay_ms(attempt, &exchange.headers, now, &mut rng).min(30_000);
                if spent_ms.saturating_add(delay) > policy.retry_wall_ms {
                    return RetryOutcome {
                        attempts: attempt,
                        exchange: None,
                        error: Some(http_error(
                            code,
                            exchange.status,
                            &exchange.headers,
                            &exchange.body,
                        )),
                    };
                }
                if aborted() {
                    return RetryOutcome {
                        attempts: attempt,
                        exchange: None,
                        error: Some(ProviderError::new(
                            ProviderErrorCode::Aborted,
                            "openai",
                            "openai-chat-v1",
                            "aborted",
                        )),
                    };
                }
                let failure = http_error(code, exchange.status, &exchange.headers, &exchange.body);
                if let Err(error) = ledger.fail_current(&failure) {
                    return RetryOutcome {
                        attempts: attempt,
                        exchange: None,
                        error: Some(error),
                    };
                }
                let start = clock_ms();
                sleeper(delay);
                let _ = start;
                spent_ms = spent_ms.saturating_add(delay);
                last_error = Some(failure);
            }
            Err(error) => {
                if !error.retryable
                    || error.code == ProviderErrorCode::StreamInvalidUtf8
                    || attempt == policy.max_attempts
                {
                    return RetryOutcome {
                        attempts: attempt,
                        exchange: None,
                        error: Some(error),
                    };
                }
                let now = clock_ms();
                let delay = retry_delay_ms(attempt, &[], now, &mut rng);
                if spent_ms.saturating_add(delay) > policy.retry_wall_ms {
                    return RetryOutcome {
                        attempts: attempt,
                        exchange: None,
                        error: Some(error),
                    };
                }
                if aborted() {
                    return RetryOutcome {
                        attempts: attempt,
                        exchange: None,
                        error: Some(ProviderError::new(
                            ProviderErrorCode::Aborted,
                            "openai",
                            "openai-chat-v1",
                            "aborted",
                        )),
                    };
                }
                if let Err(persist) = ledger.fail_current(&error) {
                    return RetryOutcome {
                        attempts: attempt,
                        exchange: None,
                        error: Some(persist),
                    };
                }
                sleeper(delay);
                spent_ms = spent_ms.saturating_add(delay);
                last_error = Some(error);
            }
        }
    }
    RetryOutcome {
        attempts: policy.max_attempts,
        exchange: None,
        error: last_error,
    }
}

fn classify_http(status: u16, body: &[u8]) -> ProviderErrorCode {
    let Ok(text) = std::str::from_utf8(body) else {
        return ProviderErrorCode::StreamInvalidUtf8;
    };
    if status == 400 || status == 422 {
        let lower = text.to_ascii_lowercase();
        if lower.contains("context_length")
            || lower.contains("context length")
            || lower.contains("maximum context")
        {
            return ProviderErrorCode::ProviderContextLength;
        }
    }
    error::http_status_code(status)
}

fn http_error(
    code: ProviderErrorCode,
    status: u16,
    headers: &[(String, String)],
    body: &[u8],
) -> ProviderError {
    let retry_after = headers.iter().find_map(|(name, value)| {
        if name.eq_ignore_ascii_case("retry-after-ms") {
            value.parse().ok()
        } else if name.eq_ignore_ascii_case("retry-after") {
            value
                .parse::<u64>()
                .ok()
                .map(|seconds| seconds.saturating_mul(1000))
        } else {
            None
        }
    });
    let message = std::str::from_utf8(body).unwrap_or("invalid utf-8");
    ProviderError::new(code, "openai", "openai-chat-v1", message)
        .with_status(status)
        .with_retry_after(retry_after)
}

pub fn retry_delay_ms(
    retry_number: u32,
    headers: &[(String, String)],
    now_ms: i64,
    rng: &mut impl FnMut(u64) -> u64,
) -> u64 {
    if let Some(ms) = headers.iter().find_map(|(name, value)| {
        if name.eq_ignore_ascii_case("retry-after-ms") {
            value.parse::<u64>().ok()
        } else if name.eq_ignore_ascii_case("retry-after") {
            value
                .parse::<u64>()
                .ok()
                .map(|seconds| seconds.saturating_mul(1000))
                .or_else(|| http_date_delay_ms(value, now_ms))
        } else {
            None
        }
    }) {
        return ms.min(30_000);
    }
    let exponent = retry_number.saturating_sub(1).min(16);
    let cap = (500u64.saturating_mul(1u64 << exponent)).min(8_000);
    rng(cap)
}

fn http_date_delay_ms(value: &str, now_ms: i64) -> Option<u64> {
    let rest = value.split_once(',')?.1.trim();
    let mut parts = rest.split_whitespace();
    let day: u32 = parts.next()?.parse().ok()?;
    let month = month_index(parts.next()?)?;
    let year: i64 = parts.next()?.parse().ok()?;
    let mut hms = parts.next()?.split(':');
    let hour: u32 = hms.next()?.parse().ok()?;
    let minute: u32 = hms.next()?.parse().ok()?;
    let second: u32 = hms.next()?.parse().ok()?;
    let when = civil_unix_ms(year, month, day, hour, minute, second)?;
    Some(when.saturating_sub(now_ms).max(0) as u64)
}

fn month_index(name: &str) -> Option<u32> {
    Some(match name {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    })
}

fn civil_unix_ms(
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
) -> Option<i64> {
    if !(1..=12).contains(&month) || day == 0 || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + u64::from(doy);
    let days = era * 146097 + doe as i64 - 719468;
    days.checked_mul(86_400)?
        .checked_add(i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second))?
        .checked_mul(1_000)
}

pub fn body_crossed_emission(body: &[u8]) -> bool {
    if std::str::from_utf8(body).is_err() {
        return true;
    }
    if let Ok(frames) = parse_sse_bytes(body) {
        if frames
            .iter()
            .any(|frame| json_crossed_emission(&frame.data))
        {
            return true;
        }
    }
    std::str::from_utf8(body).is_ok_and(json_crossed_emission)
}

fn json_crossed_emission(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    payload_events(&value).iter().any(crosses_emission)
}

fn payload_events(value: &Value) -> Vec<OpenAiAdapterEvent> {
    let mut events = Vec::new();
    collect_delta(value, &mut events);
    if let Some(choices) = value.get("choices").and_then(Value::as_array) {
        for choice in choices {
            let delta = choice.get("delta").unwrap_or(choice);
            collect_delta(delta, &mut events);
        }
    }
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    if let Some(delta) = value.get("delta").and_then(Value::as_str) {
        if kind.contains("output_text.delta") || kind.contains("refusal.delta") {
            events.push(OpenAiAdapterEvent::TextDelta {
                output_index: 0,
                delta: delta.to_owned(),
                refusal: kind.contains("refusal"),
            });
        } else if kind.contains("reasoning") && kind.contains("delta") {
            events.push(OpenAiAdapterEvent::ReasoningDelta {
                output_index: 0,
                delta: delta.to_owned(),
            });
        } else if kind.contains("function_call_arguments") {
            events.push(OpenAiAdapterEvent::ToolCallArgumentsDelta {
                output_index: 0,
                call_id: String::new(),
                delta: delta.to_owned(),
            });
        }
    }
    events
}

fn collect_delta(delta: &Value, events: &mut Vec<OpenAiAdapterEvent>) {
    let nested = delta.get("delta").unwrap_or(delta);
    if let Some(text) = nested.get("content").and_then(Value::as_str) {
        events.push(OpenAiAdapterEvent::TextDelta {
            output_index: 0,
            delta: text.to_owned(),
            refusal: false,
        });
    }
    if let Some(text) = nested.get("refusal").and_then(Value::as_str) {
        events.push(OpenAiAdapterEvent::TextDelta {
            output_index: 0,
            delta: text.to_owned(),
            refusal: true,
        });
    }
    if let Some(text) = nested
        .get("reasoning")
        .or_else(|| nested.get("reasoning_content"))
        .and_then(Value::as_str)
    {
        events.push(OpenAiAdapterEvent::ReasoningDelta {
            output_index: 0,
            delta: text.to_owned(),
        });
    }
    if nested.get("tool_calls").is_some() || delta.get("tool_calls").is_some() {
        events.push(OpenAiAdapterEvent::ToolCallStarted {
            output_index: 0,
            call_id: "call".into(),
            name: "tool".into(),
        });
    }
}

pub fn full_jitter_cap_ms(retry_number: u32) -> u64 {
    let exponent = retry_number.saturating_sub(1).min(16);
    (500u64.saturating_mul(1u64 << exponent)).min(8_000)
}

/// Blocking HTTP/1.1 POST used by local loopback tests and the retry transport.
pub fn http_exchange(
    url: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<AttemptExchange, ProviderError> {
    let rest = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let path = format!("/{path}");
    let socket = std::net::TcpStream::connect(authority).map_err(|_| {
        ProviderError::new(
            ProviderErrorCode::TransportError,
            "openai",
            "openai-chat-v1",
            "connect failed",
        )
    })?;
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .ok();
    socket
        .set_write_timeout(Some(std::time::Duration::from_secs(2)))
        .ok();
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    use std::io::{Read, Write};
    let mut stream = socket;
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(body))
        .and_then(|_| stream.flush())
        .map_err(|_| {
            ProviderError::new(
                ProviderErrorCode::TransportError,
                "openai",
                "openai-chat-v1",
                "upload failed",
            )
        })?;
    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    let limit = sse::MAX_UNDECODED_BYTES;
    loop {
        let read = stream.read(&mut buf).map_err(|_| {
            ProviderError::new(
                ProviderErrorCode::TransportError,
                "openai",
                "openai-chat-v1",
                "read failed",
            )
        })?;
        if read == 0 {
            break;
        }
        if raw.len().saturating_add(read) > limit {
            return Err(ProviderError::new(
                ProviderErrorCode::SseFrameTooLarge,
                "openai",
                "openai-chat-v1",
                "http body exceeds the sse buffer",
            ));
        }
        raw.extend_from_slice(&buf[..read]);
    }
    parse_http_response(&raw)
}

/// Admission runs first. Credentials are resolved only after an admit decision.
/// The attempt start is fsynced before `transport` is allowed to run.
#[allow(clippy::too_many_arguments)]
pub fn dispatch_after_admission<T, F>(
    store: &mut EventLogStore,
    decision: Result<AdmissionDecision, ProviderError>,
    model: &ModelSelection,
    turn_id: TurnId,
    step_id: crate::protocol::id::StepId,
    attempt_id: AttemptId,
    event_id: EventId,
    timestamp_ms: i64,
    attempt_number: u32,
    retry_of: Option<AttemptId>,
    request_body: &Value,
    resolve_credential: F,
    transport: &mut T,
    url: &str,
) -> Result<AttemptExchange, ProviderError>
where
    T: ProviderTransport,
    F: FnOnce() -> Result<String, ProviderError>,
{
    let reduced = matches!(decision, Ok(AdmissionDecision::ReduceOutput { .. }));
    let estimate = match decision {
        Ok(AdmissionDecision::Admit(estimate))
        | Ok(AdmissionDecision::ReduceOutput { estimate, .. }) => estimate,
        Ok(AdmissionDecision::Reject { code, .. }) => {
            return Err(ProviderError::new(
                code,
                &model.provider,
                &model.protocol,
                "admission rejected",
            ));
        }
        Err(error) => return Err(error),
    };
    let request_hash = calculate_request_hash(request_body).map_err(|_| {
        ProviderError::new(
            ProviderErrorCode::RequestSerializeFailed,
            &model.provider,
            &model.protocol,
            "request hash failed",
        )
    })?;
    if request_hash != estimate.request_hash
        || !serialized_output_matches(request_body, estimate.output_reserve_tokens, reduced)
    {
        return Err(ProviderError::new(
            ProviderErrorCode::RequestAdmissionDenied,
            &model.provider,
            &model.protocol,
            "request changed after admission",
        ));
    }
    let mut gate = AttemptGate::default();
    gate.note_admission(estimate.request_hash.clone());
    gate.allow_send(&request_hash)?;
    let credential = resolve_credential()?;
    let headers = build_headers(
        &model.provider,
        FIXTURE_BUILD_VERSION,
        &BTreeMap::new(),
        Some(&credential),
    )?;
    let envelope = EventEnvelope {
        schema_version: 2,
        event_id,
        session_id: *store.session_id(),
        sequence: store.current_sequence().saturating_add(1),
        timestamp_ms,
        turn_id: Some(turn_id),
        attempt_id: Some(attempt_id),
        event: CanonicalEvent::AssistantAttemptStarted(AssistantAttemptStarted {
            purpose: ProviderAttemptPurpose::AssistantStep(AssistantStepPurpose {
                step_id,
                step_index: 0,
            }),
            attempt_number,
            model: model.clone(),
            request_hash,
            admission: estimate.snapshot,
            retry_of,
            emergency_context_retry: false,
            recovery_notices: Vec::new(),
        }),
    };
    store.append_event(&envelope).map_err(|_| {
        ProviderError::new(
            ProviderErrorCode::PersistenceFailed,
            &model.provider,
            &model.protocol,
            "attempt start was not durable",
        )
    })?;
    transport.exchange(
        url,
        &headers,
        &serde_json::to_vec(request_body).unwrap_or_default(),
    )
}

pub fn rewind_on_abort(
    events: &mut Vec<OpenAiAdapterEvent>,
    calls: &mut Vec<crate::protocol::messages::ToolCall>,
) {
    events.clear();
    calls.clear();
}

fn parse_http_response(raw: &[u8]) -> Result<AttemptExchange, ProviderError> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| {
            ProviderError::new(
                ProviderErrorCode::TransportError,
                "openai",
                "openai-chat-v1",
                "truncated http response",
            )
        })?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| {
        ProviderError::new(
            ProviderErrorCode::StreamInvalidUtf8,
            "openai",
            "openai-chat-v1",
            "invalid utf-8",
        )
    })?;
    let body = raw[split + 4..].to_vec();
    if body.len() > sse::MAX_UNDECODED_BYTES {
        return Err(ProviderError::new(
            ProviderErrorCode::SseFrameTooLarge,
            "openai",
            "openai-chat-v1",
            "http body exceeds the sse buffer",
        ));
    }
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| {
            ProviderError::new(
                ProviderErrorCode::TransportError,
                "openai",
                "openai-chat-v1",
                "missing status",
            )
        })?;
    let mut headers = Vec::new();
    for line in head.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_owned(), value.trim().to_owned()));
        }
    }
    Ok(AttemptExchange {
        status,
        headers,
        body,
    })
}

fn serialized_output_matches(body: &Value, rout: u64, reduced: bool) -> bool {
    let found = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
        .or_else(|| body.get("max_output_tokens"))
        .and_then(Value::as_u64);
    match found {
        Some(value) => value == rout,
        None => !reduced,
    }
}

const RETRY_ATTEMPT_IDS: [&str; 3] = [
    "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    "01ARZ3NDEKTSV4RRFFQ69G5FB5",
    "01ARZ3NDEKTSV4RRFFQ69G5FC0",
];
const RETRY_START_IDS: [&str; 3] = [
    "01ARZ3NDEKTSV4RRFFQ69G5FB3",
    "01ARZ3NDEKTSV4RRFFQ69G5FB7",
    "01ARZ3NDEKTSV4RRFFQ69G5FC1",
];
const RETRY_FAIL_IDS: [&str; 3] = [
    "01ARZ3NDEKTSV4RRFFQ69G5FB4",
    "01ARZ3NDEKTSV4RRFFQ69G5FB8",
    "01ARZ3NDEKTSV4RRFFQ69G5FC2",
];

/// Owns the durable attempt log for `run_with_retry`.
/// Each `begin` admits the body and fsyncs `AssistantAttemptStarted` before the exchange.
pub struct RetryLedger {
    store: EventLogStore,
    model: ModelSelection,
    turn_id: TurnId,
    step_id: StepId,
    open_index: Option<usize>,
    previous: Option<AttemptId>,
}

impl RetryLedger {
    pub fn open(dir: &std::path::Path) -> Result<Self, ProviderError> {
        let mut store =
            EventLogStore::create_or_open(dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").map_err(|_| {
                ProviderError::new(
                    ProviderErrorCode::PersistenceFailed,
                    "openai",
                    "openai-chat-v1",
                    "retry log was not durable",
                )
            })?;
        let session =
            SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").map_err(|_| {
                ProviderError::new(
                    ProviderErrorCode::CanonicalRequestInvalid,
                    "openai",
                    "openai-chat-v1",
                    "retry session id is invalid",
                )
            })?;
        let digest = Sha256Digest::digest_bytes(b"retry-ledger");
        let model = ModelSelection {
            provider: "openai".into(),
            protocol: "openai-chat-v1".into(),
            model: "gpt-5.6-sol".into(),
            model_revision: None,
            model_family: "gpt-5".into(),
            endpoint_fingerprint: digest.clone(),
            reasoning_effort: ReasoningEffort::Medium,
        };
        let turn_id = TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAX").unwrap();
        let message_id = MessageId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAY").unwrap();
        let step_id = StepId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB1").unwrap();
        store
            .append_event(&EventEnvelope {
                schema_version: 2,
                event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAW").unwrap(),
                session_id: session,
                sequence: 1,
                timestamp_ms: 1,
                turn_id: None,
                attempt_id: None,
                event: CanonicalEvent::SessionStarted(SessionStarted {
                    cwd: "/workspace".into(),
                    agent: "praana".into(),
                    config_schema_version: 1,
                    config_digest_sha256: digest.clone(),
                    history_mode: HistoryMode::Append,
                    projection_version: crate::protocol::id::ProjectionId::from_str_canonical(
                        crate::protocol::constants::PROJECTION_VERSION,
                    )
                    .unwrap(),
                    compaction_policy_version: "rust-v2-compaction-1".into(),
                    artifact_policy_version: "rust-v2-artifact-1".into(),
                    token_estimator_schema_version: 1,
                    unicode_utility_version: "praana-unicode-15.1-v1".into(),
                    system_context_schema_version: 1,
                    provider_registry_schema_version: 1,
                    builtin_tool_catalog_schema_version: 1,
                    redaction_version: "praana-redaction-v1".into(),
                    ui_contract_schema_version: 1,
                    initial_model: model.clone(),
                    initial_toolset_hash: digest.clone(),
                }),
            })
            .map_err(|_| persist_err())?;
        store
            .append_event(&EventEnvelope {
                schema_version: 2,
                event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAZ").unwrap(),
                session_id: session,
                sequence: 2,
                timestamp_ms: 2,
                turn_id: Some(turn_id),
                attempt_id: None,
                event: CanonicalEvent::UserMessageAccepted(UserMessageAccepted {
                    message: UserMessage {
                        message_id,
                        turn_id,
                        blocks: vec![UserBlock::Text(TextBlock { text: "hi".into() })],
                    },
                }),
            })
            .map_err(|_| persist_err())?;
        store
            .append_event(&EventEnvelope {
                schema_version: 2,
                event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FB0").unwrap(),
                session_id: session,
                sequence: 3,
                timestamp_ms: 3,
                turn_id: Some(turn_id),
                attempt_id: None,
                event: CanonicalEvent::TurnStarted(TurnStarted {
                    turn_index: 1,
                    user_message_id: message_id,
                    model: model.clone(),
                    toolset_hash: digest,
                    max_steps: 8,
                }),
            })
            .map_err(|_| persist_err())?;
        Ok(Self {
            store,
            model,
            turn_id,
            step_id,
            open_index: None,
            previous: None,
        })
    }

    pub fn begin(&mut self, attempt: u32, body: &[u8]) -> Result<(), ProviderError> {
        let index = usize::try_from(attempt)
            .ok()
            .and_then(|value| value.checked_sub(1))
            .filter(|index| *index < RETRY_ATTEMPT_IDS.len())
            .ok_or_else(|| {
                ProviderError::new(
                    ProviderErrorCode::RequestAdmissionDenied,
                    "openai",
                    "openai-chat-v1",
                    "retry attempt is out of range",
                )
            })?;
        let attempt_id = AttemptId::from_str_canonical(RETRY_ATTEMPT_IDS[index]).unwrap();
        let event_id = EventId::from_str_canonical(RETRY_START_IDS[index]).unwrap();
        let value = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
        let components: [Vec<u8>; 9] = std::array::from_fn(|_| Vec::new());
        let decision = admit(&AdmissionRequest {
            profile: None,
            configured_context_window: 128_000,
            unsafe_increase: false,
            requested_max_output: 16,
            configured_min_output: 16,
            reasoning_reserve_tokens: 0,
            safety_margin_min_tokens: 0,
            safety_margin_ratio: 0.0,
            calibration_margin: 0,
            component_bytes: components,
            framing: FramingProfileV1 {
                framing_profile_schema_version: 1,
                framing_profile_id: "adapter-estimate:generic:default:v1".into(),
                fixed_tokens: 0,
                per_item_tokens: 0,
                item_count: 0,
                additional_tokens: 0,
            },
            image_count: 0,
            request_body: &value,
            estimate_reused_from: None,
        })?;
        let estimate = match decision {
            AdmissionDecision::Admit(estimate)
            | AdmissionDecision::ReduceOutput { estimate, .. } => estimate,
            AdmissionDecision::Reject { code, .. } => {
                return Err(ProviderError::new(
                    code,
                    "openai",
                    "openai-chat-v1",
                    "retry admission rejected",
                ));
            }
        };
        let retry_of = if attempt == 1 { None } else { self.previous };
        self.store
            .append_event(&EventEnvelope {
                schema_version: 2,
                event_id,
                session_id: *self.store.session_id(),
                sequence: self.store.current_sequence().saturating_add(1),
                timestamp_ms: i64::from(attempt) + 3,
                turn_id: Some(self.turn_id),
                attempt_id: Some(attempt_id),
                event: CanonicalEvent::AssistantAttemptStarted(AssistantAttemptStarted {
                    purpose: ProviderAttemptPurpose::AssistantStep(AssistantStepPurpose {
                        step_id: self.step_id,
                        step_index: 0,
                    }),
                    attempt_number: attempt,
                    model: self.model.clone(),
                    request_hash: estimate.request_hash,
                    admission: estimate.snapshot,
                    retry_of,
                    emergency_context_retry: false,
                    recovery_notices: Vec::new(),
                }),
            })
            .map_err(|_| persist_err())?;
        self.open_index = Some(index);
        self.previous = Some(attempt_id);
        Ok(())
    }

    pub fn fail_current(&mut self, error: &ProviderError) -> Result<(), ProviderError> {
        let index = self.open_index.take().ok_or_else(persist_err)?;
        let attempt_id = AttemptId::from_str_canonical(RETRY_ATTEMPT_IDS[index]).unwrap();
        let event_id = EventId::from_str_canonical(RETRY_FAIL_IDS[index]).unwrap();
        fail_open_attempt(
            &mut self.store,
            event_id,
            self.turn_id,
            attempt_id,
            AssistantStepPurpose {
                step_id: self.step_id,
                step_index: 0,
            },
            error,
            &[],
            false,
            i64::from(index as u32) + 10,
        )?;
        self.previous = Some(attempt_id);
        Ok(())
    }
}

fn persist_err() -> ProviderError {
    ProviderError::new(
        ProviderErrorCode::PersistenceFailed,
        "openai",
        "openai-chat-v1",
        "retry attempt was not durable",
    )
}
