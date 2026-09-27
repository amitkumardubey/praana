//! Process-tree supervision. History spools stay in a later packet.

pub mod argv;
pub mod capture;
pub mod env;

#[cfg(unix)]
pub mod unix;

#[cfg(windows)]
pub mod windows;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::tools::error::{ToolError, ToolErrorCode};

#[derive(Clone, Debug)]
pub struct SuperviseRequest {
    pub command: String,
    /// Direct argv. When set, the child is the program itself rather than a shell.
    pub argv: Option<Vec<String>>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub timeout: Duration,
    pub cancel: CancellationToken,
    pub session_id: String,
    pub stdout_limit: usize,
    pub stderr_limit: usize,
    pub process_slots: Option<Arc<Semaphore>>,
}

#[derive(Clone, Debug)]
pub struct SuperviseOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub truncated: bool,
    pub group_id: Option<u32>,
    pub signal: Option<String>,
}

pub async fn supervise(request: SuperviseRequest) -> Result<SuperviseOutput, ToolError> {
    let env = env::sanitize_env(&request.env, &request.session_id);
    let request = SuperviseRequest {
        command: request.command,
        argv: request.argv,
        cwd: request.cwd,
        env,
        timeout: request.timeout,
        cancel: request.cancel,
        session_id: request.session_id,
        stdout_limit: request.stdout_limit,
        stderr_limit: request.stderr_limit,
        process_slots: request.process_slots.clone(),
    };
    let permit =
        match &request.process_slots {
            Some(slots) => Some(slots.clone().acquire_owned().await.map_err(|_| {
                ToolError::new(ToolErrorCode::ToolInternal, "process slots closed")
            })?),
            None => None,
        };
    let mut output = platform_supervise(request).await?;
    drop(permit);
    output.stdout = redact_captured(output.stdout)?;
    output.stderr = redact_captured(output.stderr)?;
    Ok(output)
}

async fn platform_supervise(request: SuperviseRequest) -> Result<SuperviseOutput, ToolError> {
    #[cfg(unix)]
    {
        unix::supervise(request).await
    }
    #[cfg(windows)]
    {
        windows::supervise(request).await
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = request;
        Err(ToolError::new(
            ToolErrorCode::ToolUnsupported,
            "process supervision is unavailable on this platform",
        ))
    }
}

fn redact_captured(bytes: Vec<u8>) -> Result<Vec<u8>, ToolError> {
    if bytes.is_empty() {
        return Ok(bytes);
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Ok(bytes);
    };
    let redacted = crate::redaction::redact_text_v1(text).map_err(|error| {
        let _ = error;
        ToolError::new(ToolErrorCode::ToolRedactionFailed, "redaction failed")
    })?;
    Ok(redacted.text.into_bytes())
}
