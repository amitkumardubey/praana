//! File read, write, edit, and atomic batches.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::dto::*;
use crate::history::journal::{
    commit_write_journal_in_roots, prepare_write_journal_in_roots, retire_write_journal,
    rollback_write_journal_in_roots, JournalWrite,
};
use crate::protocol::id::Sha256Digest;
use crate::tools::contract::TypedTool;
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::{
    PathAccessIntent, PathAccessMode, PlannedChange, ToolExecutionContext, ToolIdempotency,
    ToolInspectContext, ToolIntent, ToolMutation,
};
use crate::tools::ToolCapabilities;

const FILE_LIMIT: u64 = 16 * 1024 * 1024;
const LINE_LIMIT: usize = 1024 * 1024;
const TEXT_LIMIT: usize = 4 * 1024 * 1024;
const EDIT_LIMIT: usize = 1024 * 1024;

pub struct ReadFileTool;
pub struct WriteFileTool;
pub struct EditFileTool;
pub struct BatchWriteTool;
pub struct BatchEditTool;

pub(crate) fn validation(message: &str) -> ToolError {
    ToolError::new(ToolErrorCode::ToolValidationFailed, message)
}

fn display_path(path: &str) -> String {
    path.trim_start_matches("./").to_owned()
}

fn check_path(path: &str) -> Result<(), ToolError> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err(validation("path is empty, too long, or contains NUL"));
    }
    Ok(())
}

fn check_text(text: &str, limit: usize, label: &str) -> Result<(), ToolError> {
    if text.len() > limit || text.contains('\0') {
        return Err(validation(label));
    }
    Ok(())
}

fn check_range(range: &LineRangeRequest) -> Result<(), ToolError> {
    if range.start_line == 0 {
        return Err(validation("start_line is one-based"));
    }
    if let Some(max_lines) = range.max_lines {
        if !(1..=10_000).contains(&max_lines) {
            return Err(validation("max_lines must be 1..=10000"));
        }
    }
    Ok(())
}

pub(crate) fn access(path: &str, mode: PathAccessMode) -> PathAccessIntent {
    PathAccessIntent {
        requested: path.to_owned(),
        normalized_absolute: PathBuf::new(),
        mode,
    }
}

fn file_intent(
    mutation: ToolMutation,
    idempotency: ToolIdempotency,
    paths: Vec<PathAccessIntent>,
    planned: Vec<PlannedChange>,
) -> ToolIntent {
    ToolIntent {
        mutation,
        path_accesses: paths,
        command: None,
        risk_facts: Vec::new(),
        timeout_ms: 60_000,
        idempotency,
        planned,
    }
}

pub fn digest(bytes: &[u8]) -> Sha256Digest {
    Sha256Digest::digest_bytes(bytes)
}

fn modified_at_ms(path: &Path) -> Option<i64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_millis() as i64)
}

pub fn identity(path: &str, absolute: &Path, bytes: &[u8]) -> FileIdentityDto {
    FileIdentityDto {
        path: display_path(path),
        sha256: digest(bytes),
        byte_count: bytes.len() as u64,
        modified_at_ms: modified_at_ms(absolute),
    }
}

fn changed_file(path: &str, before: Option<Sha256Digest>, after: &[u8]) -> ChangedFileDto {
    ChangedFileDto {
        path: display_path(path),
        before_sha256: before,
        after_sha256: digest(after),
        bytes_written: after.len() as u64,
    }
}

fn read_bytes(path: &Path) -> Result<Vec<u8>, ToolError> {
    let bytes = super::confine::read_regular(path, FILE_LIMIT)?;
    if bytes.len() as u64 > FILE_LIMIT || bytes.contains(&0) || std::str::from_utf8(&bytes).is_err()
    {
        return Err(ToolError::new(
            ToolErrorCode::ToolUnsupported,
            "unsupported encoding",
        ));
    }
    Ok(bytes)
}

fn existing_bytes(path: &Path) -> Result<Option<Vec<u8>>, ToolError> {
    match super::confine::read_regular(path, FILE_LIMIT) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.code() == ToolErrorCode::ToolPathNotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn lines_of(text: &str) -> Result<Vec<&str>, ToolError> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, ch) in text.char_indices() {
        if ch == '\n' {
            let line = &text[start..=index];
            if line.len() > LINE_LIMIT {
                return Err(validation("line exceeds 1 MiB"));
            }
            lines.push(line);
            start = index + ch.len_utf8();
        }
    }
    if start < text.len() {
        let line = &text[start..];
        if line.len() > LINE_LIMIT {
            return Err(validation("line exceeds 1 MiB"));
        }
        lines.push(line);
    }
    Ok(lines)
}

pub fn apply_edit(text: &str, old: &str, new: &str) -> Result<String, ToolError> {
    if old.is_empty() || old.len() > EDIT_LIMIT {
        return Err(validation("old_text must be 1..=1 MiB"));
    }
    if new.len() > EDIT_LIMIT || new.contains('\0') || old.contains('\0') {
        return Err(validation("edit text is too large or contains NUL"));
    }
    let matches = text.matches(old).count();
    if matches == 0 {
        return Err(validation("old_text was not found"));
    }
    if matches != 1 {
        return Err(validation("old_text is not unique"));
    }
    Ok(text.replacen(old, new, 1))
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    super::confine::replace_file(path, bytes)
}

fn resolved<'a>(context: &'a ToolExecutionContext, requested: &str) -> Result<&'a Path, ToolError> {
    context
        .path_for(requested)
        .ok_or_else(|| ToolError::new(ToolErrorCode::ToolInternal, "path was not normalized"))
}

#[async_trait]
impl TypedTool for ReadFileTool {
    type Input = ReadFileInput;
    type Output = ReadFileOutput;
    const NAME: &'static str = "read_file";
    const ORDER: u16 = 400;
    const DESCRIPTION: &'static str =
        "Read a bounded UTF-8 line range from one file. Returns exact text and an immutable file identity.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::READ_FILES
    }

    fn inspect(
        &self,
        input: &ReadFileInput,
        _: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        check_path(&input.path)?;
        check_range(&input.range)?;
        Ok(file_intent(
            ToolMutation::ReadOnly,
            ToolIdempotency::ReadOnly,
            vec![access(&input.path, PathAccessMode::Read)],
            Vec::new(),
        ))
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: ReadFileInput,
        _: CancellationToken,
    ) -> Result<ReadFileOutput, ToolError> {
        let path = resolved(&context, &input.path)?.to_path_buf();
        let bytes = read_bytes(&path)?;
        let text = std::str::from_utf8(&bytes).expect("utf-8 checked");
        let lines = lines_of(text)?;
        let total = lines.len() as u64;
        let max_lines = input.range.max_lines.unwrap_or(2000) as u64;
        if lines.is_empty() {
            return Ok(ReadFileOutput {
                file: identity(&input.path, &path, &bytes),
                encoding: TextEncodingDto::Utf8,
                start_line: 1,
                end_line: 0,
                total_lines: 0,
                content: String::new(),
                eof: true,
            });
        }
        let start_index = input.range.start_line.saturating_sub(1);
        let selected = if start_index >= total {
            &[][..]
        } else {
            let end = ((start_index + max_lines) as usize).min(lines.len());
            &lines[start_index as usize..end]
        };
        let end_line = if selected.is_empty() {
            input.range.start_line.saturating_sub(1)
        } else {
            input.range.start_line + selected.len() as u64 - 1
        };
        Ok(ReadFileOutput {
            file: identity(&input.path, &path, &bytes),
            encoding: TextEncodingDto::Utf8,
            start_line: input.range.start_line,
            end_line,
            total_lines: total,
            content: selected.concat(),
            eof: end_line >= total || selected.is_empty(),
        })
    }
}

#[async_trait]
impl TypedTool for WriteFileTool {
    type Input = WriteFileInput;
    type Output = WriteFileOutput;
    const NAME: &'static str = "write_file";
    const ORDER: u16 = 410;
    const DESCRIPTION: &'static str =
        "Atomically create or replace one UTF-8 file after validation and risk checks.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::WRITE_FILES
    }

    fn inspect(
        &self,
        input: &WriteFileInput,
        _: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        check_path(&input.path)?;
        check_text(
            &input.content,
            TEXT_LIMIT,
            "content exceeds 4 MiB or contains NUL",
        )?;
        Ok(file_intent(
            ToolMutation::Workspace,
            ToolIdempotency::IdempotentWrite,
            vec![access(&input.path, PathAccessMode::Write)],
            vec![PlannedChange::Write {
                requested_path: input.path.clone(),
                expected_sha256: input
                    .expected_sha256
                    .as_ref()
                    .map(|digest| digest.as_str().to_owned()),
            }],
        ))
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: WriteFileInput,
        _: CancellationToken,
    ) -> Result<WriteFileOutput, ToolError> {
        let path = resolved(&context, &input.path)?.to_path_buf();
        if input.create_parents {
            if let Some(parent) = path.parent() {
                super::confine::ensure_dir(parent)?;
            }
        }
        write_one(
            &path,
            &input.path,
            input.content.as_bytes(),
            input.expected_sha256.as_ref(),
        )
    }
}

pub fn write_one(
    path: &Path,
    requested: &str,
    bytes: &[u8],
    expected: Option<&Sha256Digest>,
) -> Result<WriteFileOutput, ToolError> {
    let existing = existing_bytes(path)?;
    if existing.is_none() && expected.is_some() {
        return Err(validation("expected hash conflicts with a missing file"));
    }
    if let (Some(current), Some(expected)) = (existing.as_ref(), expected) {
        if digest(current) != *expected {
            return Err(validation("file changed"));
        }
    }
    let before = existing.as_ref().map(|current| digest(current));
    if existing.as_deref() == Some(bytes) {
        return Ok(WriteFileOutput {
            changed: false,
            file: changed_file(requested, before, bytes),
        });
    }
    atomic_replace(path, bytes)?;
    Ok(WriteFileOutput {
        changed: true,
        file: changed_file(requested, before, bytes),
    })
}

#[async_trait]
impl TypedTool for EditFileTool {
    type Input = EditFileInput;
    type Output = EditFileOutput;
    const NAME: &'static str = "edit_file";
    const ORDER: u16 = 420;
    const DESCRIPTION: &'static str =
        "Replace one exact unique UTF-8 string in a file using compare-and-swap identity.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::WRITE_FILES
    }

    fn inspect(
        &self,
        input: &EditFileInput,
        _: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        check_path(&input.path)?;
        if input.old_text.is_empty() || input.old_text.len() > EDIT_LIMIT {
            return Err(validation("old_text must be 1..=1 MiB"));
        }
        check_text(
            &input.new_text,
            EDIT_LIMIT,
            "new_text exceeds 1 MiB or contains NUL",
        )?;
        Ok(file_intent(
            ToolMutation::Workspace,
            ToolIdempotency::IdempotentWrite,
            vec![access(&input.path, PathAccessMode::Write)],
            vec![PlannedChange::Edit {
                requested_path: input.path.clone(),
                old_text: input.old_text.clone(),
                new_text: input.new_text.clone(),
                expected_sha256: input
                    .expected_sha256
                    .as_ref()
                    .map(|digest| digest.as_str().to_owned()),
            }],
        ))
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: EditFileInput,
        _: CancellationToken,
    ) -> Result<EditFileOutput, ToolError> {
        let path = resolved(&context, &input.path)?.to_path_buf();
        let before_bytes = read_bytes(&path)?;
        let before = digest(&before_bytes);
        if let Some(expected) = &input.expected_sha256 {
            if before != *expected {
                return Err(validation("file changed"));
            }
        }
        let text = std::str::from_utf8(&before_bytes).expect("utf-8 checked");
        let next = apply_edit(text, &input.old_text, &input.new_text)?;
        let next_bytes = next.into_bytes();
        atomic_replace(&path, &next_bytes)?;
        Ok(EditFileOutput {
            changed: true,
            replacements: 1,
            file: changed_file(&input.path, Some(before), &next_bytes),
        })
    }
}

fn batch_bounds(count: usize, total: usize) -> Result<(), ToolError> {
    if !(1..=100).contains(&count) {
        return Err(validation("batch must contain 1..=100 items"));
    }
    if total > FILE_LIMIT as usize {
        return Err(validation("batch input exceeds 16 MiB"));
    }
    Ok(())
}

#[async_trait]
impl TypedTool for BatchWriteTool {
    type Input = BatchWriteInput;
    type Output = BatchMutationOutput;
    const NAME: &'static str = "batch_write";
    const ORDER: u16 = 430;
    const DESCRIPTION: &'static str =
        "Atomically apply ordered writes to multiple files; all validation succeeds before any replacement.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::WRITE_FILES
    }

    fn inspect(
        &self,
        input: &BatchWriteInput,
        _: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        let total: usize = input.writes.iter().map(|write| write.content.len()).sum();
        batch_bounds(input.writes.len(), total)?;
        let mut seen = std::collections::BTreeSet::new();
        let mut paths = Vec::new();
        let mut planned = Vec::new();
        for write in &input.writes {
            check_path(&write.path)?;
            check_text(
                &write.content,
                TEXT_LIMIT,
                "content exceeds 4 MiB or contains NUL",
            )?;
            if !seen.insert(write.path.clone()) {
                return Err(validation("duplicate write path"));
            }
            paths.push(access(&write.path, PathAccessMode::Write));
            planned.push(PlannedChange::Write {
                requested_path: write.path.clone(),
                expected_sha256: write
                    .expected_sha256
                    .as_ref()
                    .map(|digest| digest.as_str().to_owned()),
            });
        }
        Ok(file_intent(
            ToolMutation::Workspace,
            ToolIdempotency::IdempotentWrite,
            paths,
            planned,
        ))
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: BatchWriteInput,
        _: CancellationToken,
    ) -> Result<BatchMutationOutput, ToolError> {
        let mut prepared = Vec::new();
        for write in input.writes {
            let path = resolved(&context, &write.path)?.to_path_buf();
            if write.create_parents {
                if let Some(parent) = path.parent() {
                    super::confine::ensure_dir(parent)?;
                }
            }
            let bytes = write.content.into_bytes();
            let existing = existing_bytes(&path)?;
            if existing.is_none() && write.expected_sha256.is_some() {
                return Err(validation("expected hash conflicts with a missing file"));
            }
            if let (Some(current), Some(expected)) =
                (existing.as_ref(), write.expected_sha256.as_ref())
            {
                if digest(current) != *expected {
                    return Err(validation("file changed"));
                }
            }
            let same = existing.as_deref() == Some(bytes.as_slice());
            prepared.push((
                write.path,
                path,
                existing.map(|current| digest(&current)),
                bytes,
                same,
            ));
        }
        let writes: Vec<JournalWrite> = prepared
            .iter()
            .enumerate()
            .filter(|(_, item)| !item.4)
            .map(|(ordinal, (_, path, _, bytes, _))| JournalWrite {
                ordinal: ordinal as u32,
                target_path: path.clone(),
                new_bytes: bytes.clone(),
            })
            .collect();
        if !writes.is_empty() {
            journal_replace(&context, &writes)?;
        }
        let mut changed = Vec::new();
        let mut unchanged_paths = Vec::new();
        for (requested, _, before, bytes, same) in prepared {
            if same {
                unchanged_paths.push(display_path(&requested));
            } else {
                changed.push(changed_file(&requested, before, &bytes));
            }
        }
        Ok(BatchMutationOutput {
            changed,
            unchanged_paths,
        })
    }
}

#[async_trait]
impl TypedTool for BatchEditTool {
    type Input = BatchEditInput;
    type Output = BatchMutationOutput;
    const NAME: &'static str = "batch_edit";
    const ORDER: u16 = 440;
    const DESCRIPTION: &'static str =
        "Atomically apply ordered exact-string edits; edits to one file are simulated sequentially before writing.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::WRITE_FILES
    }

    fn inspect(
        &self,
        input: &BatchEditInput,
        _: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        let total: usize = input
            .edits
            .iter()
            .map(|edit| edit.old_text.len() + edit.new_text.len())
            .sum();
        batch_bounds(input.edits.len(), total)?;
        let mut paths = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        let mut planned = Vec::new();
        for edit in &input.edits {
            check_path(&edit.path)?;
            if edit.old_text.is_empty() || edit.old_text.len() > EDIT_LIMIT {
                return Err(validation("old_text must be 1..=1 MiB"));
            }
            check_text(
                &edit.new_text,
                EDIT_LIMIT,
                "new_text exceeds 1 MiB or contains NUL",
            )?;
            if seen.insert(edit.path.clone()) {
                paths.push(access(&edit.path, PathAccessMode::Write));
            }
            planned.push(PlannedChange::Edit {
                requested_path: edit.path.clone(),
                old_text: edit.old_text.clone(),
                new_text: edit.new_text.clone(),
                expected_sha256: edit
                    .expected_sha256
                    .as_ref()
                    .map(|digest| digest.as_str().to_owned()),
            });
        }
        Ok(file_intent(
            ToolMutation::Workspace,
            ToolIdempotency::IdempotentWrite,
            paths,
            planned,
        ))
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: BatchEditInput,
        _: CancellationToken,
    ) -> Result<BatchMutationOutput, ToolError> {
        let mut images: Vec<(String, PathBuf, Vec<u8>, Vec<u8>)> = Vec::new();
        for edit in input.edits {
            let path = resolved(&context, &edit.path)?.to_path_buf();
            if let Some(existing) = images.iter_mut().find(|item| item.1 == path) {
                let text = std::str::from_utf8(&existing.3).map_err(|_| {
                    ToolError::new(ToolErrorCode::ToolUnsupported, "unsupported encoding")
                })?;
                let next = apply_edit(text, &edit.old_text, &edit.new_text)?;
                existing.3 = next.into_bytes();
            } else {
                let original = read_bytes(&path)?;
                let text = std::str::from_utf8(&original).expect("utf-8 checked");
                let next = apply_edit(text, &edit.old_text, &edit.new_text)?;
                images.push((edit.path, path, original, next.into_bytes()));
            }
        }
        let changed_writes: Vec<JournalWrite> = images
            .iter()
            .enumerate()
            .filter(|(_, (_, _, original, next))| original != next)
            .map(|(ordinal, (_, path, _, next))| JournalWrite {
                ordinal: ordinal as u32,
                target_path: path.clone(),
                new_bytes: next.clone(),
            })
            .collect();
        if !changed_writes.is_empty() {
            journal_replace(&context, &changed_writes)?;
        }
        let mut changed = Vec::new();
        let mut unchanged_paths = Vec::new();
        for (requested, _, original, next) in images {
            if original == next {
                unchanged_paths.push(display_path(&requested));
            } else {
                changed.push(changed_file(&requested, Some(digest(&original)), &next));
            }
        }
        Ok(BatchMutationOutput {
            changed,
            unchanged_paths,
        })
    }
}

fn journal_replace(
    context: &ToolExecutionContext,
    writes: &[JournalWrite],
) -> Result<(), ToolError> {
    let map_err = |_| ToolError::new(ToolErrorCode::ToolIoFailed, "journal failed");
    prepare_write_journal_in_roots(
        &context.session_dir,
        &context.workspace_roots,
        &context.session_id,
        &context.execution_id,
        &context.batch_id,
        &context.call_id,
        writes,
    )
    .map_err(map_err)?;
    if let Err(error) = commit_write_journal_in_roots(
        &context.session_dir,
        &context.workspace_roots,
        &context.execution_id,
    ) {
        let _ = rollback_write_journal_in_roots(
            &context.session_dir,
            &context.workspace_roots,
            &context.execution_id,
        );
        let _ = retire_write_journal(&context.session_dir, &context.execution_id);
        let _ = error;
        return Err(ToolError::new(
            ToolErrorCode::ToolIoFailed,
            "journal commit failed",
        ));
    }
    let _ = retire_write_journal(&context.session_dir, &context.execution_id);
    Ok(())
}
