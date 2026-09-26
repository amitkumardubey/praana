//! Non-interactive shell. Process trees are supervised by the P3A supervisor.

use std::path::PathBuf;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::dto::*;
use super::files::validation;
use crate::process::{supervise, SuperviseRequest};
use crate::protocol::id::Sha256Digest;
use crate::tools::contract::TypedTool;
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::{
    CommandIntent, PathAccessMode, ToolExecutionContext, ToolIdempotency, ToolInspectContext,
    ToolIntent, ToolMutation,
};
use crate::tools::shell_parse::classify;
use crate::tools::ToolCapabilities;

pub struct ShellTool;

const CAPTURE_LIMIT: usize = 8 * 1024 * 1024;

#[async_trait]
impl TypedTool for ShellTool {
    type Input = ShellInput;
    type Output = ShellOutput;
    const NAME: &'static str = "shell";
    const ORDER: u16 = 1100;
    const DESCRIPTION: &'static str =
        "Run one non-interactive shell command in a validated working directory with bounded output and process-tree cancellation.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::SPAWN_PROCESS | ToolCapabilities::NETWORK_POSSIBLE
    }

    fn inspect(
        &self,
        input: &ShellInput,
        context: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        if input.command.is_empty() || input.command.len() > 262_144 || input.command.contains('\0')
        {
            return Err(validation("command is empty, too long, or contains NUL"));
        }
        let class = classify(&input.command)?;
        let cwd = input.cwd.clone().unwrap_or_else(|| ".".to_owned());
        if cwd.is_empty() || cwd.len() > 4096 || cwd.contains('\0') {
            return Err(validation("cwd is empty, too long, or contains NUL"));
        }
        Ok(ToolIntent {
            mutation: ToolMutation::External,
            path_accesses: vec![super::files::access(&cwd, PathAccessMode::Read)],
            command: Some(CommandIntent {
                command: input.command.clone(),
                cwd: context.cwd.join(&cwd),
                read_equivalent: class.read_equivalent,
                test_command: class.test_command,
            }),
            risk_facts: class.facts,
            timeout_ms: input.timeout_ms.unwrap_or(0),
            idempotency: ToolIdempotency::NonIdempotent,
            planned: Vec::new(),
        })
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: ShellInput,
        cancel: CancellationToken,
    ) -> Result<ShellOutput, ToolError> {
        let cwd = context
            .path_for(input.cwd.as_deref().unwrap_or("."))
            .map(PathBuf::from)
            .unwrap_or_else(|| context.cwd.clone());
        let started = Instant::now();
        let output = match supervise(SuperviseRequest {
            command: input.command,
            argv: None,
            cwd,
            env: std::env::vars().collect(),
            timeout: context.timeout,
            cancel,
            session_id: context.session_id.to_string(),
            stdout_limit: CAPTURE_LIMIT,
            stderr_limit: CAPTURE_LIMIT,
            process_slots: context.process_slots.clone(),
        })
        .await
        {
            Ok(output) => output,
            Err(error) => return Err(error),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        let stdout = decode_stream(&output.stdout);
        let stderr = decode_stream(&output.stderr);
        if stdout.is_err() || stderr.is_err() || output.truncated {
            return Err(captured_error(&output, stdout, stderr, duration_ms));
        }
        let stdout = stdout.expect("utf-8");
        let stderr = stderr.expect("utf-8");
        if output.timed_out {
            return Err(
                ToolError::new(ToolErrorCode::ToolTimedOut, "timed out").with_details(shell_value(
                    ShellOutput {
                        exit_code: output.exit_code,
                        signal: output.signal.or_else(|| Some("SIGTERM".into())),
                        duration_ms,
                        stdout,
                        stderr,
                        timed_out: true,
                        cancelled: false,
                    },
                )),
            );
        }
        if output.cancelled {
            return Err(
                ToolError::new(ToolErrorCode::ToolCancelled, "cancelled").with_details(
                    shell_value(ShellOutput {
                        exit_code: output.exit_code,
                        signal: output.signal.or_else(|| Some("SIGTERM".into())),
                        duration_ms,
                        stdout,
                        stderr,
                        timed_out: false,
                        cancelled: true,
                    }),
                ),
            );
        }
        let body = ShellOutput {
            exit_code: output.exit_code,
            signal: output.signal,
            duration_ms,
            stdout,
            stderr,
            timed_out: false,
            cancelled: false,
        };
        if output.exit_code.unwrap_or(1) != 0 {
            return Err(ToolError::new(
                ToolErrorCode::ToolProcessExitNonzero,
                "process exited non-zero",
            )
            .with_details(shell_value(body)));
        }
        Ok(body)
    }
}

fn decode_stream(bytes: &[u8]) -> Result<String, Value> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(text.to_owned()),
        Err(_) => Err(binary_value(bytes)),
    }
}

fn captured_error(
    output: &crate::process::SuperviseOutput,
    stdout: Result<String, Value>,
    stderr: Result<String, Value>,
    duration_ms: u64,
) -> ToolError {
    let code = if output.truncated {
        ToolErrorCode::ToolProcessOutputLimit
    } else if stdout.is_err() || stderr.is_err() {
        ToolErrorCode::ToolUnsupported
    } else {
        ToolErrorCode::ToolProcessOutputLimit
    };
    let stdout_is_binary = stdout.is_err();
    let stderr_is_binary = stderr.is_err();
    let message = if stdout_is_binary || stderr_is_binary {
        "binary output is stored as base64"
    } else {
        "process output limit"
    };
    let stdout = match stdout {
        Ok(text) => Value::String(text),
        Err(binary) => binary,
    };
    let stderr = match stderr {
        Ok(text) => Value::String(text),
        Err(binary) => binary,
    };
    let mut error = ToolError::new(code, message).with_details(json!({
        "truncated": output.truncated,
        "exit_code": output.exit_code,
        "duration_ms": duration_ms,
        "stdout": stdout,
        "stderr": stderr,
    }));
    if stdout_is_binary || stderr_is_binary {
        error = error.mark_binary();
    }
    error
}

fn binary_value(bytes: &[u8]) -> Value {
    json!({
        "encoding": "base64",
        "data": base64_encode(bytes),
        "sha256": Sha256Digest::digest_bytes(bytes).as_str(),
        "byte_count": bytes.len(),
    })
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let chunk = u32::from_be_bytes([0, bytes[index], bytes[index + 1], bytes[index + 2]]);
        out.push(TABLE[((chunk >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 0x3f) as usize] as char);
        out.push(TABLE[((chunk >> 6) & 0x3f) as usize] as char);
        out.push(TABLE[(chunk & 0x3f) as usize] as char);
        index += 3;
    }
    if index < bytes.len() {
        let rest = bytes.len() - index;
        let b0 = bytes[index];
        let b1 = if rest == 2 { bytes[index + 1] } else { 0 };
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if rest == 2 {
            out.push(TABLE[((b1 & 0x0f) << 2) as usize] as char);
            out.push('=');
        } else {
            out.push('=');
            out.push('=');
        }
    }
    out
}

fn shell_value(output: ShellOutput) -> serde_json::Value {
    serde_json::to_value(output).unwrap_or(serde_json::Value::Null)
}
