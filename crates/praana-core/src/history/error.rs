//! History artifact substrate errors. Codes are the History or protocol strings
//! the owner names; messages never include secret material.

use std::fmt;

use crate::protocol::errors::HistoryError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactError {
    code: String,
    message: String,
}

impl ArtifactError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn into_history(self, sequence: Option<u64>, line: Option<usize>) -> HistoryError {
        let retryable = self.code == "HISTORY_SQLITE_BUSY";
        HistoryError::new(self.code, sequence, line, retryable)
    }
}

impl fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ArtifactError {}

pub(crate) fn insecure(detail: impl Into<String>) -> ArtifactError {
    ArtifactError::new("HISTORY_INSECURE_PERMISSIONS", detail.into())
}

pub(crate) fn io_err(detail: impl Into<String>) -> ArtifactError {
    ArtifactError::new("HISTORY_IO", detail.into())
}

pub(crate) fn schema_unsupported(detail: impl Into<String>) -> ArtifactError {
    ArtifactError::new("HISTORY_SCHEMA_UNSUPPORTED", detail.into())
}

pub(crate) fn map_ledger(err: crate::history::operation_ledger::LedgerError) -> ArtifactError {
    let text = err.to_string();
    if text.contains("HISTORY_INSECURE_PERMISSIONS") || text.contains("symlink") {
        insecure(text)
    } else if text.contains("HISTORY_SQLITE_PRAGMA_FAILED") {
        ArtifactError::new("HISTORY_SQLITE_PRAGMA_FAILED", text)
    } else {
        io_err(text)
    }
}
