//! Canonical provider errors and local history/replay/fixture errors.

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::protocol::json::deserialize_optional_bounded_u64;

/// Canonical provider/tool ProtocolError persisted inside attempt failure payloads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolError {
    pub code: String,
    pub class: ErrorClass,
    pub message: String,
    pub retryable: bool,
    pub http_status: Option<u16>,
    #[serde(deserialize_with = "deserialize_optional_bounded_u64")]
    pub retry_after_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ErrorClass {
    Transport,
    Timeout,
    RateLimit,
    Authentication,
    ContextLength,
    InvalidRequest,
    InvalidProviderOutput,
    Validation,
    Policy,
    NotFound,
    Conflict,
    Integrity,
    Persistence,
    Unavailable,
    Cancelled,
    ProcessCrash,
    Internal,
}

impl ProtocolError {
    pub fn provider(
        code: impl Into<String>,
        class: ErrorClass,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            code: code.into(),
            class,
            message: message.into(),
            retryable,
            http_status: None,
            retry_after_ms: None,
        }
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProtocolError {}

/// Local history/replay/fixture error with sequence/line provenance.
/// Exact shape of `expected_error.json` fixtures (Protocol Spec §16.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryError {
    pub code: String,
    pub sequence: Option<u64>,
    pub line: Option<usize>,
    pub recoverable: bool,
}

impl HistoryError {
    pub fn new(
        code: impl Into<String>,
        sequence: Option<u64>,
        line: Option<usize>,
        recoverable: bool,
    ) -> Self {
        Self {
            code: code.into(),
            sequence,
            line,
            recoverable,
        }
    }

    pub fn with_message(
        code: impl Into<String>,
        sequence: Option<u64>,
        line: Option<usize>,
        recoverable: bool,
        _message: impl Into<String>,
    ) -> Self {
        Self::new(code, sequence, line, recoverable)
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}

impl fmt::Display for HistoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} at sequence {:?}, line {:?}",
            self.code, self.sequence, self.line
        )
    }
}

impl std::error::Error for HistoryError {}

/// Alias retained for fixture JSON naming in docs.
pub type FixtureError = HistoryError;

pub type ProtocolResult<T> = Result<T, ProtocolError>;
pub type HistoryResult<T> = Result<T, HistoryError>;
