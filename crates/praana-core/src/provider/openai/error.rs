//! Stable OpenAI/OpenRouter adapter errors. Secrets never enter messages.

use crate::protocol::errors::{ErrorClass, ProtocolError};

pub const FIXTURE_BUILD_VERSION: &str = "0.0.0-test";
pub const REDACTED: &str = "[REDACTED]";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderErrorCode {
    CanonicalRequestInvalid,
    UnsupportedProtocol,
    UnsupportedOption,
    UnsupportedContent,
    UnsupportedOutputItem,
    ProviderEmptyResponse,
    ToolCallIdMissing,
    BaseUrlInvalid,
    HeaderInvalid,
    HeaderForbidden,
    AuthMissing,
    RequestAdmissionDenied,
    RequestAdmissionLoop,
    ContextOverflow,
    RequestSerializeFailed,
    ProviderBadRequest,
    ProviderAuthFailed,
    ProviderPermissionDenied,
    ProviderNotFound,
    ProviderConflict,
    ProviderPayloadTooLarge,
    ProviderRateLimited,
    ProviderUnavailable,
    ProviderServerError,
    ProviderContextLength,
    ProviderContentFilter,
    ProviderResponseFailed,
    TransportError,
    ProviderTimeout,
    StreamInvalidUtf8,
    SseFrameTooLarge,
    StreamInvalidJson,
    ProtocolViolation,
    ToolArgumentsInvalid,
    StreamTruncated,
    ContinuationUnavailable,
    ContinuationIncompatible,
    ContinuationIdRejected,
    Aborted,
    AdmissionContextWindowUnknown,
    AdmissionArithmeticOverflow,
    CompactionProfileInvalid,
    PersistenceFailed,
}

impl ProviderErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CanonicalRequestInvalid => "canonical_request_invalid",
            Self::UnsupportedProtocol => "unsupported_protocol",
            Self::UnsupportedOption => "unsupported_option",
            Self::UnsupportedContent => "unsupported_content",
            Self::UnsupportedOutputItem => "unsupported_output_item",
            Self::ProviderEmptyResponse => "provider_empty_response",
            Self::ToolCallIdMissing => "tool_call_id_missing",
            Self::BaseUrlInvalid => "base_url_invalid",
            Self::HeaderInvalid => "header_invalid",
            Self::HeaderForbidden => "header_forbidden",
            Self::AuthMissing => "auth_missing",
            Self::RequestAdmissionDenied => "request_admission_denied",
            Self::RequestAdmissionLoop => "request_admission_loop",
            Self::ContextOverflow => "context_overflow",
            Self::RequestSerializeFailed => "request_serialize_failed",
            Self::ProviderBadRequest => "provider_bad_request",
            Self::ProviderAuthFailed => "provider_auth_failed",
            Self::ProviderPermissionDenied => "provider_permission_denied",
            Self::ProviderNotFound => "provider_not_found",
            Self::ProviderConflict => "provider_conflict",
            Self::ProviderPayloadTooLarge => "provider_payload_too_large",
            Self::ProviderRateLimited => "provider_rate_limited",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::ProviderServerError => "provider_server_error",
            Self::ProviderContextLength => "provider_context_length",
            Self::ProviderContentFilter => "provider_content_filter",
            Self::ProviderResponseFailed => "provider_response_failed",
            Self::TransportError => "transport_error",
            Self::ProviderTimeout => "provider_timeout",
            Self::StreamInvalidUtf8 => "stream_invalid_utf8",
            Self::SseFrameTooLarge => "sse_frame_too_large",
            Self::StreamInvalidJson => "stream_invalid_json",
            Self::ProtocolViolation => "protocol_violation",
            Self::ToolArgumentsInvalid => "tool_arguments_invalid",
            Self::StreamTruncated => "stream_truncated",
            Self::ContinuationUnavailable => "continuation_unavailable",
            Self::ContinuationIncompatible => "continuation_incompatible",
            Self::ContinuationIdRejected => "continuation_id_rejected",
            Self::Aborted => "aborted",
            Self::AdmissionContextWindowUnknown => "ADMISSION_CONTEXT_WINDOW_UNKNOWN",
            Self::AdmissionArithmeticOverflow => "ADMISSION_ARITHMETIC_OVERFLOW",
            Self::CompactionProfileInvalid => "COMPACTION_PROFILE_INVALID",
            Self::PersistenceFailed => "persistence_failed",
        }
    }

    pub fn generic_retry_before_emission(self) -> bool {
        matches!(
            self,
            Self::ProviderRateLimited
                | Self::ProviderUnavailable
                | Self::TransportError
                | Self::ProviderTimeout
                | Self::StreamInvalidUtf8
                | Self::StreamTruncated
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderError {
    pub code: ProviderErrorCode,
    pub safe_message: String,
    pub provider: String,
    pub protocol: String,
    pub http_status: Option<u16>,
    pub request_id: Option<String>,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
}

impl ProviderError {
    pub fn new(
        code: ProviderErrorCode,
        provider: impl Into<String>,
        protocol: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            retryable: code.generic_retry_before_emission(),
            code,
            safe_message: sanitize_message(&message.into(), &[]),
            provider: provider.into(),
            protocol: protocol.into(),
            http_status: None,
            request_id: None,
            retry_after_ms: None,
        }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.http_status = Some(status);
        self
    }

    pub fn with_retry_after(mut self, ms: Option<u64>) -> Self {
        self.retry_after_ms = ms;
        self
    }

    pub fn with_request_id(mut self, id: Option<String>) -> Self {
        self.request_id = id.and_then(|value| sanitize_request_id(&value));
        self
    }

    pub fn redact_secrets(mut self, secrets: &[&str]) -> Self {
        self.safe_message = sanitize_message(&self.safe_message, secrets);
        self
    }

    pub fn to_protocol_error(&self) -> Option<ProtocolError> {
        let (code, class) = match self.code {
            ProviderErrorCode::ToolCallIdMissing => {
                ("E_TOOL_CALL_ID_MISSING", ErrorClass::InvalidProviderOutput)
            }
            ProviderErrorCode::UnsupportedOutputItem | ProviderErrorCode::ProviderEmptyResponse => {
                (
                    "E_PROVIDER_OUTPUT_UNSUPPORTED",
                    ErrorClass::InvalidProviderOutput,
                )
            }
            ProviderErrorCode::ProviderContentFilter => (
                "E_PROVIDER_CONTENT_FILTER",
                ErrorClass::InvalidProviderOutput,
            ),
            ProviderErrorCode::ContinuationUnavailable => {
                ("E_CONTINUATION_MISSING", ErrorClass::InvalidProviderOutput)
            }
            ProviderErrorCode::ContinuationIncompatible => {
                ("E_CONTINUATION_INCOMPATIBLE", ErrorClass::InvalidRequest)
            }
            ProviderErrorCode::ProviderContextLength => {
                ("E_PROVIDER_CONTEXT_LENGTH", ErrorClass::ContextLength)
            }
            ProviderErrorCode::ProviderRateLimited => {
                ("E_PROVIDER_RATE_LIMIT", ErrorClass::RateLimit)
            }
            ProviderErrorCode::AuthMissing
            | ProviderErrorCode::ProviderAuthFailed
            | ProviderErrorCode::ProviderPermissionDenied => {
                ("E_PROVIDER_AUTH", ErrorClass::Authentication)
            }
            ProviderErrorCode::ProviderTimeout => ("E_PROVIDER_TIMEOUT", ErrorClass::Timeout),
            ProviderErrorCode::TransportError
            | ProviderErrorCode::ProviderUnavailable
            | ProviderErrorCode::ProviderServerError => {
                ("E_PROVIDER_STREAM", ErrorClass::Transport)
            }
            ProviderErrorCode::StreamInvalidUtf8
            | ProviderErrorCode::SseFrameTooLarge
            | ProviderErrorCode::StreamInvalidJson
            | ProviderErrorCode::ProtocolViolation
            | ProviderErrorCode::StreamTruncated
            | ProviderErrorCode::ProviderResponseFailed => {
                ("E_PROVIDER_STREAM", ErrorClass::InvalidProviderOutput)
            }
            ProviderErrorCode::CanonicalRequestInvalid
            | ProviderErrorCode::UnsupportedProtocol
            | ProviderErrorCode::UnsupportedOption
            | ProviderErrorCode::UnsupportedContent
            | ProviderErrorCode::BaseUrlInvalid
            | ProviderErrorCode::HeaderInvalid
            | ProviderErrorCode::HeaderForbidden
            | ProviderErrorCode::RequestSerializeFailed
            | ProviderErrorCode::ProviderBadRequest
            | ProviderErrorCode::ProviderNotFound
            | ProviderErrorCode::ProviderConflict
            | ProviderErrorCode::ProviderPayloadTooLarge => {
                ("E_PROVIDER_REQUEST_INVALID", ErrorClass::InvalidRequest)
            }
            ProviderErrorCode::RequestAdmissionDenied => {
                ("E_PROVIDER_REQUEST_INVALID", ErrorClass::Policy)
            }
            ProviderErrorCode::RequestAdmissionLoop => {
                ("E_ADMISSION_ACCOUNTING", ErrorClass::Internal)
            }
            ProviderErrorCode::ContextOverflow => {
                ("E_ACTIVE_TURN_TOO_LARGE", ErrorClass::ContextLength)
            }
            ProviderErrorCode::ToolArgumentsInvalid => (
                "E_TOOL_ARGUMENTS_INVALID",
                ErrorClass::InvalidProviderOutput,
            ),
            ProviderErrorCode::ContinuationIdRejected => {
                ("E_CONTINUATION_INCOMPATIBLE", ErrorClass::InvalidRequest)
            }
            ProviderErrorCode::Aborted => ("E_PROVIDER_CANCELLED", ErrorClass::Cancelled),
            ProviderErrorCode::AdmissionContextWindowUnknown
            | ProviderErrorCode::AdmissionArithmeticOverflow
            | ProviderErrorCode::CompactionProfileInvalid
            | ProviderErrorCode::PersistenceFailed => return None,
        };
        Some(ProtocolError {
            code: code.to_owned(),
            class,
            message: self.safe_message.clone(),
            retryable: self.retryable,
            http_status: self.http_status,
            retry_after_ms: self.retry_after_ms,
        })
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.safe_message)
    }
}

impl std::error::Error for ProviderError {}

pub fn sanitize_message(input: &str, secrets: &[&str]) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        if ch == '\n' || ch == '\t' || ch == ' ' {
            out.push(' ');
        } else if ch.is_control() {
            continue;
        } else {
            out.push(ch);
        }
    }
    for secret in secrets {
        if !secret.is_empty() {
            while let Some(index) = out.find(secret) {
                out.replace_range(index..index + secret.len(), REDACTED);
            }
        }
    }
    let bytes = out.as_bytes();
    if bytes.len() <= 1024 {
        return out;
    }
    let mut end = 1024;
    while end > 0 && !out.is_char_boundary(end) {
        end -= 1;
    }
    out.truncate(end);
    out
}

pub fn sanitize_request_id(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 256 {
        return None;
    }
    if !value.is_ascii() || value.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return None;
    }
    Some(value.to_owned())
}

pub fn http_status_code(status: u16) -> ProviderErrorCode {
    match status {
        400 | 422 => ProviderErrorCode::ProviderBadRequest,
        401 => ProviderErrorCode::ProviderAuthFailed,
        403 => ProviderErrorCode::ProviderPermissionDenied,
        404 => ProviderErrorCode::ProviderNotFound,
        408 => ProviderErrorCode::ProviderTimeout,
        409 => ProviderErrorCode::ProviderConflict,
        413 => ProviderErrorCode::ProviderPayloadTooLarge,
        429 => ProviderErrorCode::ProviderRateLimited,
        500 | 502 | 503 | 504 => ProviderErrorCode::ProviderUnavailable,
        other if (500..600).contains(&other) => ProviderErrorCode::ProviderServerError,
        _ => ProviderErrorCode::ProviderBadRequest,
    }
}
