//! Structured error type for the pure native capability layer.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeErrorCode {
    InvalidArgument,
    UnsupportedLanguage,
    IoError,
    ParseError,
    Unavailable,
    Internal,
}

impl NativeErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            NativeErrorCode::InvalidArgument => "invalid_argument",
            NativeErrorCode::UnsupportedLanguage => "unsupported_language",
            NativeErrorCode::IoError => "io_error",
            NativeErrorCode::ParseError => "parse_error",
            NativeErrorCode::Unavailable => "unavailable",
            NativeErrorCode::Internal => "internal",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeError {
    pub code: NativeErrorCode,
    pub message: String,
}

impl NativeError {
    pub fn new(code: NativeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for NativeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for NativeError {}

pub type NativeResult<T> = Result<T, NativeError>;
