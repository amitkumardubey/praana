//! Read-only git status and diff. No mutating git subcommands.

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::dto::*;
use super::files::validation;
use crate::process::{supervise, SuperviseRequest};
use crate::tools::contract::TypedTool;
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::{
    ToolExecutionContext, ToolIdempotency, ToolInspectContext, ToolIntent, ToolMutation,
};
use crate::tools::ToolCapabilities;

pub struct GitStatusTool;
pub struct GitDiffTool;

fn git_intent() -> ToolIntent {
    ToolIntent {
        mutation: ToolMutation::ReadOnly,
        path_accesses: vec![super::files::access(
            ".",
            crate::tools::intent::PathAccessMode::Read,
        )],
        command: None,
        risk_facts: Vec::new(),
        timeout_ms: 30_000,
        idempotency: ToolIdempotency::ReadOnly,
        planned: Vec::new(),
    }
}

async fn git(
    context: &ToolExecutionContext,
    args: &[String],
    cancel: CancellationToken,
) -> Result<(Vec<u8>, i32), ToolError> {
    let mut argv = vec!["git".to_owned()];
    argv.extend(args.iter().cloned());
    let output = supervise(SuperviseRequest {
        command: String::new(),
        argv: Some(argv),
        cwd: context.cwd.clone(),
        env: std::env::vars().collect(),
        timeout: context.timeout,
        cancel,
        session_id: context.session_id.to_string(),
        stdout_limit: 8 * 1024 * 1024,
        stderr_limit: 8 * 1024 * 1024,
        process_slots: context.process_slots.clone(),
    })
    .await?;
    if output.timed_out {
        return Err(ToolError::new(ToolErrorCode::ToolTimedOut, "timed out"));
    }
    if output.cancelled {
        return Err(ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"));
    }
    if output.truncated {
        return Err(ToolError::new(
            ToolErrorCode::ToolProcessOutputLimit,
            "process output limit",
        ));
    }
    let code = output.exit_code.unwrap_or(1);
    if code != 0 && args.first().map(String::as_str) != Some("diff") {
        return Err(ToolError::new(
            ToolErrorCode::ToolProcessExitNonzero,
            "git command failed",
        ));
    }
    Ok((output.stdout, code))
}

fn remainder_after(record: &str, fields: usize) -> Option<&str> {
    let mut rest = record;
    for _ in 0..fields {
        let (_, tail) = rest.split_once(' ')?;
        rest = tail;
    }
    Some(rest)
}

fn xy_field(record: &str) -> &str {
    record.split(' ').nth(1).unwrap_or("  ")
}

fn parse_status(bytes: &[u8]) -> Result<GitStatusOutput, ToolError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ToolError::new(ToolErrorCode::ToolUnsupported, "unsupported encoding"))?;
    let records: Vec<&str> = text
        .split('\0')
        .filter(|record| !record.is_empty())
        .collect();
    let mut branch = None;
    let mut entries = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if let Some(name) = record.strip_prefix("# branch.head ") {
            branch = Some(name.to_owned());
            index += 1;
            continue;
        }
        if record.starts_with('#') {
            index += 1;
            continue;
        }
        if let Some(path) = record
            .strip_prefix("? ")
            .or_else(|| record.strip_prefix("! "))
        {
            let mark = if record.starts_with('?') { "?" } else { "!" };
            entries.push(GitStatusEntryDto {
                path: path.to_owned(),
                original_path: None,
                index: mark.to_owned(),
                worktree: mark.to_owned(),
            });
            index += 1;
            continue;
        }
        if record.starts_with('1') || record.starts_with('u') {
            let prefix = if record.starts_with('u') { 10 } else { 8 };
            let Some(path) = remainder_after(record, prefix) else {
                index += 1;
                continue;
            };
            let xy = xy_field(record);
            entries.push(GitStatusEntryDto {
                path: path.to_owned(),
                original_path: None,
                index: xy.chars().next().unwrap_or(' ').to_string(),
                worktree: xy.chars().nth(1).unwrap_or(' ').to_string(),
            });
            index += 1;
            continue;
        }
        if record.starts_with('2') {
            let Some(path) = remainder_after(record, 9) else {
                index += 1;
                continue;
            };
            let xy = xy_field(record);
            let original = records.get(index + 1).map(|item| (*item).to_owned());
            entries.push(GitStatusEntryDto {
                path: path.to_owned(),
                original_path: original,
                index: xy.chars().next().unwrap_or(' ').to_string(),
                worktree: xy.chars().nth(1).unwrap_or(' ').to_string(),
            });
            index += 2;
            continue;
        }
        index += 1;
    }
    Ok(GitStatusOutput { branch, entries })
}

#[async_trait]
impl TypedTool for GitStatusTool {
    type Input = GitStatusInput;
    type Output = GitStatusOutput;
    const NAME: &'static str = "git_status";
    const ORDER: u16 = 700;
    const DESCRIPTION: &'static str =
        "Return porcelain-v2 repository status as stable structured paths.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::GIT_READ
    }

    fn inspect(&self, _: &GitStatusInput, _: &ToolInspectContext) -> Result<ToolIntent, ToolError> {
        Ok(git_intent())
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: GitStatusInput,
        cancel: CancellationToken,
    ) -> Result<GitStatusOutput, ToolError> {
        let mut args = vec![
            "status".into(),
            "--porcelain=v2".into(),
            "-z".into(),
            "--branch".into(),
        ];
        if input.include_untracked {
            args.push("--untracked-files=all".into());
        }
        let (stdout, _) = git(&context, &args, cancel).await?;
        parse_status(&stdout)
    }
}

#[async_trait]
impl TypedTool for GitDiffTool {
    type Input = GitDiffInput;
    type Output = GitDiffOutput;
    const NAME: &'static str = "git_diff";
    const ORDER: u16 = 710;
    const DESCRIPTION: &'static str =
        "Return a bounded git diff for selected paths or staging area; large output becomes an artifact.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::GIT_READ
    }

    fn inspect(
        &self,
        input: &GitDiffInput,
        _: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        if input.paths.len() > 100 {
            return Err(validation("too many diff paths"));
        }
        for path in &input.paths {
            if path.is_empty() || path.len() > 4096 || path.contains('\0') {
                return Err(validation("diff path is empty, too long, or contains NUL"));
            }
        }
        if let Some(base) = &input.base {
            if base.is_empty()
                || base.len() > 256
                || !base.is_ascii()
                || base.starts_with('-')
                || base.contains('\0')
            {
                return Err(validation("diff base is invalid"));
            }
        }
        if input.context_lines > 100 {
            return Err(validation("context_lines must be 0..=100"));
        }
        Ok(git_intent())
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: GitDiffInput,
        cancel: CancellationToken,
    ) -> Result<GitDiffOutput, ToolError> {
        let mut command = vec![
            "git".into(),
            "diff".into(),
            "--no-ext-diff".into(),
            format!("-U{}", input.context_lines),
        ];
        if input.staged {
            command.push("--cached".into());
        }
        if let Some(base) = &input.base {
            command.push(base.clone());
        }
        command.push("--".into());
        command.extend(input.paths.iter().cloned());
        let output = supervise(SuperviseRequest {
            command: String::new(),
            argv: Some(command.clone()),
            cwd: context.cwd.clone(),
            env: std::env::vars().collect(),
            timeout: context.timeout,
            cancel,
            session_id: context.session_id.to_string(),
            stdout_limit: 8 * 1024 * 1024,
            stderr_limit: 8 * 1024 * 1024,
            process_slots: context.process_slots.clone(),
        })
        .await?;
        if output.timed_out {
            return Err(ToolError::new(ToolErrorCode::ToolTimedOut, "timed out"));
        }
        if output.cancelled {
            return Err(ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"));
        }
        let diff = std::str::from_utf8(&output.stdout)
            .map_err(|_| {
                ToolError::new(
                    ToolErrorCode::ToolUnsupported,
                    "binary output is not inlined",
                )
            })?
            .to_owned();
        Ok(GitDiffOutput {
            command,
            exit_code: output.exit_code.unwrap_or(1),
            diff,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::parse_status;

    #[test]
    fn porcelain_keeps_spaces_and_rename_paths() {
        let bytes = b"1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa my file.txt\0\
2 R. N... 100644 100644 100644 bbbbbbb bbbbbbb R100 renamed file.txt\0\
old file.txt\0";
        let parsed = parse_status(bytes).unwrap();
        assert_eq!(parsed.entries[0].path, "my file.txt");
        assert_eq!(parsed.entries[1].path, "renamed file.txt");
        assert_eq!(
            parsed.entries[1].original_path.as_deref(),
            Some("old file.txt")
        );
    }
}
