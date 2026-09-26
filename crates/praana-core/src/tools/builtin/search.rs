//! Gitignore-aware search and path finding. Invalid regex is rejected.
//! Native grep is not used: it rewrites invalid patterns into literals.

use std::path::Path;

use async_trait::async_trait;
use globset::{Glob, GlobSetBuilder};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use tokio_util::sync::CancellationToken;

use super::dto::*;
use super::files::validation;
use crate::tools::contract::TypedTool;
use crate::tools::error::{ToolError, ToolErrorCode};
use crate::tools::intent::{
    ToolExecutionContext, ToolIdempotency, ToolInspectContext, ToolIntent, ToolMutation,
};
use crate::tools::ToolCapabilities;

pub struct SearchCodeTool;
pub struct FindFilesTool;

fn read_intent(path: &str) -> ToolIntent {
    ToolIntent {
        mutation: ToolMutation::ReadOnly,
        path_accesses: vec![super::files::access(
            path,
            crate::tools::intent::PathAccessMode::Read,
        )],
        command: None,
        risk_facts: Vec::new(),
        timeout_ms: 60_000,
        idempotency: ToolIdempotency::ReadOnly,
        planned: Vec::new(),
    }
}

fn check_globs(globs: &[String]) -> Result<(), ToolError> {
    if globs.len() > 32 {
        return Err(validation("too many globs"));
    }
    for glob in globs {
        if glob.is_empty() || glob.len() > 512 || glob.contains('\0') {
            return Err(validation("glob is empty, too long, or contains NUL"));
        }
        Glob::new(glob).map_err(|_| validation("invalid glob"))?;
    }
    Ok(())
}

fn compile_pattern(pattern: &str, case_insensitive: bool) -> Result<regex::Regex, ToolError> {
    if pattern.is_empty() || pattern.len() > 4096 || pattern.contains('\0') {
        return Err(validation("pattern is empty, too long, or contains NUL"));
    }
    RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .build()
        .map_err(|_| validation("invalid regex"))
}

fn relative_display(root: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.to_string_lossy().replace('\\', "/")
}

fn globset(globs: &[String]) -> Result<Option<globset::GlobSet>, ToolError> {
    if globs.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for glob in globs {
        builder.add(Glob::new(glob).map_err(|_| validation("invalid glob"))?);
    }
    builder
        .build()
        .map(Some)
        .map_err(|_| validation("invalid glob"))
}

#[async_trait]
impl TypedTool for SearchCodeTool {
    type Input = SearchCodeInput;
    type Output = SearchCodeOutput;
    const NAME: &'static str = "search_code";
    const ORDER: u16 = 500;
    const DESCRIPTION: &'static str =
        "Search project text with a bounded regex and gitignore-aware traversal.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::READ_FILES
    }

    fn inspect(
        &self,
        input: &SearchCodeInput,
        _: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        compile_pattern(&input.pattern, input.case_insensitive)?;
        if input.path.is_empty() || input.path.len() > 4096 {
            return Err(validation("path is empty or too long"));
        }
        check_globs(&input.include_globs)?;
        check_globs(&input.exclude_globs)?;
        if input.context_lines > 5 {
            return Err(validation("context_lines must be 0..=5"));
        }
        if !(1..=1000).contains(&input.max_results) {
            return Err(validation("max_results must be 1..=1000"));
        }
        Ok(read_intent(&input.path))
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: SearchCodeInput,
        cancel: CancellationToken,
    ) -> Result<SearchCodeOutput, ToolError> {
        let root = context
            .path_for(&input.path)
            .ok_or_else(|| ToolError::new(ToolErrorCode::ToolInternal, "path was not normalized"))?
            .to_path_buf();
        tokio::task::spawn_blocking(move || search_files(&root, &input, &cancel))
            .await
            .map_err(|_| ToolError::new(ToolErrorCode::ToolIoFailed, "search task failed"))?
    }
}

fn split_plain(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, ch) in text.char_indices() {
        if ch == '\n' {
            let end = index;
            lines.push(&text[start..end]);
            start = index + ch.len_utf8();
        }
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

#[async_trait]
impl TypedTool for FindFilesTool {
    type Input = FindFilesInput;
    type Output = FindFilesOutput;
    const NAME: &'static str = "find_files";
    const ORDER: u16 = 510;
    const DESCRIPTION: &'static str =
        "Find project file paths by glob or fuzzy subsequence without reading file bodies.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::READ_FILES
    }

    fn inspect(
        &self,
        input: &FindFilesInput,
        _: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        if input.query.is_empty() || input.query.len() > 1024 || input.query.contains('\0') {
            return Err(validation("query is empty, too long, or contains NUL"));
        }
        if !(1..=1000).contains(&input.max_results) {
            return Err(validation("max_results must be 1..=1000"));
        }
        if matches!(input.mode, Some(FindMode::Glob)) {
            Glob::new(&input.query).map_err(|_| validation("invalid glob"))?;
        }
        Ok(read_intent(&input.path))
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: FindFilesInput,
        cancel: CancellationToken,
    ) -> Result<FindFilesOutput, ToolError> {
        let root = context
            .path_for(&input.path)
            .ok_or_else(|| ToolError::new(ToolErrorCode::ToolInternal, "path was not normalized"))?
            .to_path_buf();
        tokio::task::spawn_blocking(move || find_paths(&root, &input, &cancel))
            .await
            .map_err(|_| ToolError::new(ToolErrorCode::ToolIoFailed, "search task failed"))?
    }
}

fn search_files(
    root: &Path,
    input: &SearchCodeInput,
    cancel: &CancellationToken,
) -> Result<SearchCodeOutput, ToolError> {
    let regex = compile_pattern(&input.pattern, input.case_insensitive)?;
    let include = globset(&input.include_globs)?;
    let exclude = globset(&input.exclude_globs)?;
    let mut matches = Vec::new();
    let mut truncated = false;
    let mut scanned = 0u64;
    let limit = input.max_results.max(1) as usize;
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .build();
    for entry in walker.flatten() {
        if cancel.is_cancelled() {
            return Err(ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"));
        }
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
        let display = relative_display(root, path);
        if let Some(include) = &include {
            if !include.is_match(&display) {
                continue;
            }
        }
        if let Some(exclude) = &exclude {
            if exclude.is_match(&display) {
                continue;
            }
        }
        let meta = match std::fs::metadata(path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.len() > 16 * 1024 * 1024 {
            continue;
        }
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        if bytes.contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        scanned += 1;
        let lines = split_plain(text);
        for (index, line) in lines.iter().enumerate() {
            if index % 256 == 0 && cancel.is_cancelled() {
                return Err(ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"));
            }
            if let Some(found) = regex.find(line) {
                let context = input.context_lines as usize;
                let before = lines[index.saturating_sub(context)..index]
                    .iter()
                    .map(|item| (*item).to_owned())
                    .collect();
                let after_end = (index + 1 + context).min(lines.len());
                let after = lines[index + 1..after_end]
                    .iter()
                    .map(|item| (*item).to_owned())
                    .collect();
                retain_match(
                    &mut matches,
                    &mut truncated,
                    limit,
                    SearchMatchDto {
                        path: display.clone(),
                        line: index as u64 + 1,
                        column: found.start() as u64 + 1,
                        text: (*line).to_owned(),
                        before,
                        after,
                    },
                );
            }
        }
    }
    matches.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.line.cmp(&right.line))
            .then(left.column.cmp(&right.column))
    });
    Ok(SearchCodeOutput {
        matches,
        truncated,
        scanned_files: scanned,
    })
}

fn retain_match(
    kept: &mut Vec<SearchMatchDto>,
    truncated: &mut bool,
    limit: usize,
    item: SearchMatchDto,
) {
    if kept.len() < limit {
        kept.push(item);
        return;
    }
    *truncated = true;
    let Some((index, path, line, column)) = kept
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| {
            left.path
                .cmp(&right.path)
                .then(left.line.cmp(&right.line))
                .then(left.column.cmp(&right.column))
        })
        .map(|(index, worst)| (index, worst.path.clone(), worst.line, worst.column))
    else {
        return;
    };
    let better = (item.path.as_str(), item.line, item.column) < (path.as_str(), line, column);
    if better {
        kept[index] = item;
    }
}

fn find_paths(
    root: &Path,
    input: &FindFilesInput,
    cancel: &CancellationToken,
) -> Result<FindFilesOutput, ToolError> {
    let mode = input.mode.clone().unwrap_or(FindMode::Fuzzy);
    let glob = if matches!(mode, FindMode::Glob) {
        Some(
            Glob::new(&input.query)
                .map_err(|_| validation("invalid glob"))?
                .compile_matcher(),
        )
    } else {
        None
    };
    let mut found = Vec::new();
    let mut truncated = false;
    let limit = input.max_results.max(1) as usize;
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .build();
    for entry in walker.flatten() {
        if cancel.is_cancelled() {
            return Err(ToolError::new(ToolErrorCode::ToolCancelled, "cancelled"));
        }
        let path = entry.path();
        if path == root {
            continue;
        }
        let display = relative_display(root, path);
        let kind = entry.file_type().map(|kind| {
            if kind.is_symlink() {
                FoundPathKind::Symlink
            } else if kind.is_dir() {
                FoundPathKind::Directory
            } else if kind.is_file() {
                FoundPathKind::File
            } else {
                FoundPathKind::Other
            }
        });
        let Some(kind) = kind else { continue };
        let score = match mode {
            FindMode::Glob => {
                if glob
                    .as_ref()
                    .is_some_and(|matcher| matcher.is_match(&display))
                {
                    None
                } else {
                    continue;
                }
            }
            FindMode::Fuzzy => match fuzzy_score(&display, &input.query) {
                Some(score) => Some(score),
                None => continue,
            },
        };
        retain_path(
            &mut found,
            &mut truncated,
            limit,
            &mode,
            FoundPathDto {
                path: display,
                kind,
                score_milli: score,
            },
        );
    }
    match mode {
        FindMode::Fuzzy => found.sort_by(|left, right| {
            right
                .score_milli
                .cmp(&left.score_milli)
                .then(left.path.cmp(&right.path))
        }),
        FindMode::Glob => found.sort_by(|left, right| left.path.cmp(&right.path)),
    }
    Ok(FindFilesOutput {
        paths: found,
        truncated,
    })
}

fn retain_path(
    kept: &mut Vec<FoundPathDto>,
    truncated: &mut bool,
    limit: usize,
    mode: &FindMode,
    item: FoundPathDto,
) {
    if kept.len() < limit {
        kept.push(item);
        return;
    }
    *truncated = true;
    let worst = kept
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| match mode {
            FindMode::Fuzzy => left
                .score_milli
                .cmp(&right.score_milli)
                .reverse()
                .then(left.path.cmp(&right.path)),
            FindMode::Glob => left.path.cmp(&right.path),
        });
    let Some((index, _)) = worst else { return };
    let replace = match mode {
        FindMode::Fuzzy => {
            item.score_milli > kept[index].score_milli
                || (item.score_milli == kept[index].score_milli && item.path < kept[index].path)
        }
        FindMode::Glob => item.path < kept[index].path,
    };
    if replace {
        kept[index] = item;
    }
}

/// ASCII casefold subsequence. Each matched byte scores 10, plus 25 when it
/// starts a path component. An exact filename match adds 500. The result is
/// clamped to 1000.
fn fuzzy_score(path: &str, query: &str) -> Option<u32> {
    let path_bytes = path.to_ascii_lowercase();
    let query_bytes = query.to_ascii_lowercase();
    if query_bytes.is_empty() {
        return None;
    }
    let path_b = path_bytes.as_bytes();
    let query_b = query_bytes.as_bytes();
    let mut query_index = 0;
    let mut score = 0u32;
    for (index, byte) in path_b.iter().copied().enumerate() {
        if query_index < query_b.len() && byte == query_b[query_index] {
            score = score.saturating_add(10);
            let boundary = index == 0 || matches!(path_b[index - 1], b'/' | b'_' | b'-' | b'.');
            if boundary {
                score = score.saturating_add(25);
            }
            query_index += 1;
        }
    }
    if query_index != query_b.len() {
        return None;
    }
    let name = path_bytes.rsplit('/').next().unwrap_or(path_bytes.as_str());
    if name == query_bytes {
        score = score.saturating_add(500);
    }
    Some(score.min(1000))
}
