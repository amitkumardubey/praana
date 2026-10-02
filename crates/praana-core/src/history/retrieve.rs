//! Artifact retrieval and session-source reads (History §10.1–§10.4).
//!
//! The text view computation is shared with the search projection so
//! `artifact.text_view` rows and retrieval render identical bytes.

use rusqlite::OptionalExtension;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use std::time::{SystemTime, UNIX_EPOCH};

use super::error::{map_sqlite, ArtifactError};
use crate::protocol::id::{ArtifactId, EventId, SearchResultId, Sha256Digest, TurnId};
use tokio_util::sync::CancellationToken;

pub const HISTORY_TOOL_RESULT_MAX_BYTES: usize = 65_536;
const FULL_RETRIEVAL_LIMIT: u64 = 256 * 1024;
const HARD_MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_REGEX_PATTERN_BYTES: usize = 4096;
const MAX_REGEX_CONTEXT: u32 = 20;
const MAX_REGEX_MATCHES: u32 = 1000;
const CANCEL_CHECK_INTERVAL: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetrieveArtifactRequest {
    pub artifact_id: ArtifactId,
    pub selector: Option<ArtifactSelector>,
    pub line_range: Option<InclusiveLineRange>,
    pub head_lines: Option<u32>,
    pub tail_lines: Option<u32>,
    pub regex: Option<RegexFilter>,
    pub json_pointer: Option<String>,
    pub byte_offset: Option<u64>,
    pub max_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactSelector {
    Default,
    CompleteResult,
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InclusiveLineRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RegexFilter {
    pub pattern: String,
    pub case_sensitive: bool,
    pub context_before: u32,
    pub context_after: u32,
    pub max_matches: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetrieveArtifactResponse {
    pub artifact_id: ArtifactId,
    pub sha256: Sha256Digest,
    pub selector: ArtifactSelector,
    pub content: ArtifactRetrievedContent,
    pub returned_bytes: u64,
    pub complete: bool,
    pub selected_line_start: Option<u64>,
    pub selected_line_end: Option<u64>,
    pub total_lines: Option<u64>,
    pub matches: Vec<ArtifactRegexMatch>,
    pub continuation: Option<RetrieveArtifactRequest>,
}

impl RetrieveArtifactResponse {
    pub fn byte_offset(&self) -> u64 {
        self.continuation
            .as_ref()
            .and_then(|c| c.byte_offset)
            .unwrap_or(0)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(
    tag = "encoding",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ArtifactRetrievedContent {
    Utf8(String),
    Base64(String),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRegexMatch {
    pub line: u64,
    pub start_column: u64,
    pub end_column: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadSessionSourceRequest {
    pub result_id: SearchResultId,
    pub byte_offset: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadSessionSourceResponse {
    pub result_id: SearchResultId,
    pub source_kind: SearchSourceKind,
    pub source_field: String,
    pub event_id: Option<EventId>,
    pub event_sequence: Option<u64>,
    pub turn_id: Option<TurnId>,
    pub content_sha256: Sha256Digest,
    pub text: String,
    pub byte_offset: u64,
    pub returned_bytes: u64,
    pub total_bytes: u64,
    pub start_line: u64,
    pub end_line: u64,
    pub total_lines: u64,
    pub complete: bool,
    pub continuation: Option<ReadSessionSourceRequest>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SearchSourceKind {
    Event,
    Artifact,
    SummarySegment,
    State,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextView {
    pub text: String,
    pub pointer: String,
    pub stdout: Option<(i64, i64)>,
    pub stderr: Option<(i64, i64)>,
}

pub fn compute_text_view(value: &Value) -> TextView {
    if let Some(data) = value.get("data").and_then(Value::as_object) {
        if let Some(view) = inspect_channels(data, true) {
            return view;
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(view) = inspect_channels(object, false) {
            return view;
        }
        if !object.is_empty() {
            return inspected_text("", &pretty_json(value), None, None);
        }
    }
    match value {
        Value::String(text) => inspected_text("", text, None, None),
        Value::Array(_) => inspected_text("", &pretty_json(value), None, None),
        _ => inspected_text("", "", None, None),
    }
}

fn inspect_channels(object: &serde_json::Map<String, Value>, under_data: bool) -> Option<TextView> {
    if let Some(content) = object.get("content").and_then(Value::as_str) {
        let pointer = if under_data {
            "/data/content"
        } else {
            "/content"
        };
        return Some(inspected_text(pointer, content, None, None));
    }
    let stdout = object.get("stdout").and_then(Value::as_str);
    let stderr = object.get("stderr").and_then(Value::as_str);
    if let (Some(stdout), Some(stderr)) = (stdout, stderr) {
        let text = format!("{stdout}{stderr}");
        let stdout_end = stdout.len() as i64;
        let stderr_end = text.len() as i64;
        return Some(inspected_text(
            "",
            &text,
            Some((0, stdout_end)),
            Some((stdout_end, stderr_end)),
        ));
    }
    if let Some(stdout) = stdout {
        if !stdout.is_empty() && stderr.unwrap_or("").is_empty() {
            let pointer = if under_data {
                "/data/stdout"
            } else {
                "/stdout"
            };
            return Some(inspected_text(pointer, stdout, None, None));
        }
    }
    None
}

fn inspected_text(
    pointer: &str,
    text: &str,
    stdout: Option<(i64, i64)>,
    stderr: Option<(i64, i64)>,
) -> TextView {
    TextView {
        text: text.to_owned(),
        pointer: pointer.to_owned(),
        stdout,
        stderr,
    }
}

fn pretty_json(value: &Value) -> String {
    let mut out = String::new();
    write_pretty(value, 0, &mut out);
    out
}

fn write_pretty(value: &Value, indent: usize, out: &mut String) {
    match value {
        Value::Object(map) => {
            out.push_str("{\n");
            let mut keys: Vec<_> = map.keys().cloned().collect();
            keys.sort();
            for (index, key) in keys.iter().enumerate() {
                pad(out, indent + 1);
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push_str(": ");
                write_pretty(&map[key], indent + 1, out);
                if index + 1 != keys.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            pad(out, indent);
            out.push('}');
        }
        Value::Array(items) => {
            out.push_str("[\n");
            for (index, item) in items.iter().enumerate() {
                pad(out, indent + 1);
                write_pretty(item, indent + 1, out);
                if index + 1 != items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            pad(out, indent);
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).unwrap_or_else(|_| "null".to_owned())),
    }
}

fn pad(out: &mut String, indent: usize) {
    for _ in 0..indent {
        out.push_str("  ");
    }
}

/// History §6.2: an empty text view has zero lines; otherwise the line count
/// is one plus the number of LF bytes.
pub fn line_count_of(text: &str) -> u64 {
    if text.is_empty() {
        0
    } else {
        1 + text.bytes().filter(|&b| b == b'\n').count() as u64
    }
}

/// Byte spans `(start, end_exclusive)` of each line, LF included: an LF belongs
/// to the line it terminates (§6.2, §10.1). Index `i` is line `i + 1`
/// (1-based). A trailing LF leaves a final empty line, matching the §6.2
/// count.
fn line_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0usize;
    for (index, &byte) in bytes.iter().enumerate() {
        if byte == b'\n' {
            spans.push((start, index + 1));
            start = index + 1;
        }
    }
    if start < bytes.len() {
        spans.push((start, bytes.len()));
    } else if !bytes.is_empty() {
        spans.push((bytes.len(), bytes.len()));
    }
    spans
}

/// 1-based line containing `offset`, or `None` when `offset` is not inside the
/// text (empty window / offset at end of view).
fn line_of_offset(spans: &[(usize, usize)], offset: usize) -> Option<u64> {
    spans
        .iter()
        .position(|&(start, end)| offset >= start && offset < end)
        .map(|index| index as u64 + 1)
}

fn resolve_json_pointer(value: &Value, pointer: &str) -> Option<Value> {
    if pointer.is_empty() {
        return Some(value.clone());
    }
    if !pointer.starts_with('/') {
        return None;
    }
    let mut current = value;
    for segment in pointer[1..].split('/') {
        let segment = segment.replace("~1", "/").replace("~0", "~");
        current = match current {
            Value::Object(map) => map.get(&segment)?,
            Value::Array(items) => {
                let index: usize = segment.parse().ok()?;
                items.get(index)?
            }
            _ => return None,
        };
    }
    Some(current.clone())
}

struct ArtifactRow {
    sha256: Sha256Digest,
    canonical_bytes: Vec<u8>,
    content_type: String,
}

fn load_artifact(
    conn: &rusqlite::Connection,
    artifact_id: &ArtifactId,
) -> Result<Option<ArtifactRow>, ArtifactError> {
    let result = conn
        .query_row(
            "SELECT a.result_sha256, b.canonical_result, a.content_type
             FROM artifacts a
             JOIN artifact_blobs b ON b.blob_id = a.blob_id
             WHERE a.artifact_id = ?1",
            [artifact_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(map_sqlite)?;
    let Some((sha256, canonical_bytes, content_type)) = result else {
        return Ok(None);
    };
    Ok(Some(ArtifactRow {
        sha256: parse_digest(&sha256, "artifact sha256")?,
        canonical_bytes,
        content_type,
    }))
}

fn invalid_id(what: &str) -> ArtifactError {
    ArtifactError::new(
        "HISTORY_EVENT_INTEGRITY",
        format!("indexed {what} is not a canonical ULID"),
    )
}

fn check_cancel(cancel: &CancellationToken) -> Result<(), ArtifactError> {
    if cancel.is_cancelled() {
        return Err(ArtifactError::new("HISTORY_CANCELLED", "caller cancelled"));
    }
    Ok(())
}

/// A stored digest that is not 64 lowercase hex characters is derived-data
/// corruption, never a substitute value (History §10.3, §13).
fn parse_digest(raw: &str, what: &str) -> Result<Sha256Digest, ArtifactError> {
    Sha256Digest::from_hex_str(raw).map_err(|_| {
        ArtifactError::new(
            "HISTORY_EVENT_INTEGRITY",
            format!("stored {what} is not a lowercase sha-256 digest"),
        )
    })
}

pub fn retrieve_artifact(
    conn: &rusqlite::Connection,
    request: &RetrieveArtifactRequest,
    cancel: &CancellationToken,
) -> Result<RetrieveArtifactResponse, ArtifactError> {
    let row = load_artifact(conn, &request.artifact_id)?
        .ok_or_else(|| ArtifactError::new("HISTORY_ARTIFACT_NOT_FOUND", "artifact not found"))?;
    let selector = request.selector.unwrap_or(ArtifactSelector::Default);
    let is_binary = row.content_type == "binary";

    if is_binary {
        // History §10.2: binary content permits only selector=complete_result
        // with optional max_bytes and byte_offset.
        if !matches!(selector, ArtifactSelector::CompleteResult) {
            return Err(ArtifactError::new(
                "HISTORY_SELECTOR_UNSUPPORTED",
                "binary content requires selector=complete_result",
            ));
        }
        if request.line_range.is_some()
            || request.head_lines.is_some()
            || request.tail_lines.is_some()
            || request.regex.is_some()
            || request.json_pointer.is_some()
        {
            return Err(ArtifactError::new(
                "HISTORY_SELECTOR_UNSUPPORTED",
                "selector is not valid for binary content",
            ));
        }
    }

    if request.json_pointer.is_some()
        && matches!(
            selector,
            ArtifactSelector::Stdout | ArtifactSelector::Stderr
        )
    {
        return Err(ArtifactError::new(
            "HISTORY_ARTIFACT_RANGE",
            "json_pointer cannot be combined with stdout/stderr",
        ));
    }

    let has_line_range = request.line_range.is_some();
    let has_head = request.head_lines.is_some();
    let has_tail = request.tail_lines.is_some();
    if has_line_range as u8 + has_head as u8 + has_tail as u8 > 1 {
        return Err(ArtifactError::new(
            "HISTORY_ARTIFACT_RANGE",
            "exactly one of line_range, head_lines, tail_lines",
        ));
    }
    if request.byte_offset.is_some() && (has_head || has_tail || request.regex.is_some()) {
        return Err(ArtifactError::new(
            "HISTORY_ARTIFACT_RANGE",
            "byte_offset cannot be combined with head_lines, tail_lines, or regex",
        ));
    }

    if let Some(regex) = &request.regex {
        if regex.pattern.len() > MAX_REGEX_PATTERN_BYTES {
            return Err(ArtifactError::new(
                "HISTORY_ARTIFACT_RANGE",
                "regex pattern exceeds 4096 bytes",
            ));
        }
        if regex.context_before > MAX_REGEX_CONTEXT || regex.context_after > MAX_REGEX_CONTEXT {
            return Err(ArtifactError::new(
                "HISTORY_ARTIFACT_RANGE",
                "regex context exceeds 20 lines",
            ));
        }
    }

    // History §12: cancellation is checked before the expensive decode and
    // before the scan, never by abandoning a transaction midway.
    check_cancel(cancel)?;
    let value: Value = serde_json::from_slice(&row.canonical_bytes)
        .map_err(|_| ArtifactError::new("HISTORY_IO", "canonical result is not json"))?;
    check_cancel(cancel)?;

    let selected_value = if let Some(pointer) = &request.json_pointer {
        resolve_json_pointer(&value, pointer).ok_or_else(|| {
            ArtifactError::new("HISTORY_JSON_POINTER", "json pointer does not resolve")
        })?
    } else {
        value.clone()
    };

    let view = match selector {
        ArtifactSelector::Stdout => {
            let text = extract_channel(&value, "stdout");
            TextView {
                text,
                pointer: "/stdout".to_owned(),
                stdout: None,
                stderr: None,
            }
        }
        ArtifactSelector::Stderr => {
            let text = extract_channel(&value, "stderr");
            TextView {
                text,
                pointer: "/stderr".to_owned(),
                stdout: None,
                stderr: None,
            }
        }
        ArtifactSelector::CompleteResult => compute_text_view(&selected_value),
        ArtifactSelector::Default => {
            if request.json_pointer.is_some() {
                compute_text_view(&selected_value)
            } else {
                compute_text_view(&value)
            }
        }
    };

    let total_lines = line_count_of(&view.text);
    let mut line_range = request.line_range.clone();
    if let Some(head) = request.head_lines {
        line_range = Some(InclusiveLineRange {
            start: 1,
            end: (head as u64).min(total_lines),
        });
    } else if let Some(tail) = request.tail_lines {
        let start = total_lines.saturating_sub(tail as u64) + 1;
        line_range = Some(InclusiveLineRange {
            start,
            end: total_lines,
        });
    }

    if let Some(range) = &line_range {
        if range.start == 0 || range.end < range.start || range.end > total_lines {
            return Err(ArtifactError::new(
                "HISTORY_ARTIFACT_RANGE",
                "line range is outside the view",
            ));
        }
    }

    if let Some(offset) = request.byte_offset {
        let view_len = view.text.len() as u64;
        if offset > view_len || (offset == view_len && view_len > 0) {
            return Err(ArtifactError::new(
                "HISTORY_ARTIFACT_RANGE",
                "byte offset is outside the view",
            ));
        }
        if !is_binary {
            let bytes = view.text.as_bytes();
            if offset < bytes.len() as u64 && !is_scalar_boundary(bytes, offset as usize) {
                return Err(ArtifactError::new(
                    "HISTORY_ARTIFACT_RANGE",
                    "byte offset is not a scalar boundary",
                ));
            }
            if let Some(range) = &line_range {
                // §10.1: with line_range the offset is a global view position
                // that must lie inside line line_range.start.
                let spans = line_spans(&view.text);
                let inside = spans
                    .get(range.start.saturating_sub(1) as usize)
                    .is_some_and(|&(start, end)| offset >= start as u64 && offset < end as u64);
                if !inside {
                    return Err(ArtifactError::new(
                        "HISTORY_ARTIFACT_RANGE",
                        "byte offset is not inside line line_range.start",
                    ));
                }
            }
        }
    }

    let max_bytes = request
        .max_bytes
        .unwrap_or(FULL_RETRIEVAL_LIMIT)
        .min(HARD_MAX_BYTES);

    let result = if let Some(regex) = &request.regex {
        retrieve_with_regex(
            &view.text,
            line_range.as_ref(),
            regex,
            max_bytes,
            selector,
            request.selector,
            request.json_pointer.clone(),
            &request.artifact_id,
            &row.sha256,
            is_binary,
            cancel,
        )?
    } else if line_range.is_some() || request.byte_offset.is_some() {
        retrieve_with_lines(
            &view.text,
            line_range.as_ref(),
            request.byte_offset,
            max_bytes,
            selector,
            request.selector,
            request.json_pointer.clone(),
            &request.artifact_id,
            &row.sha256,
            is_binary,
        )?
    } else {
        retrieve_unbounded(
            &view.text,
            max_bytes,
            selector,
            request.selector,
            request.json_pointer.clone(),
            &request.artifact_id,
            &row.sha256,
            is_binary,
        )?
    };

    write_access_telemetry(conn, &request.artifact_id, result.returned_bytes);

    Ok(result)
}

fn extract_channel(value: &Value, channel: &str) -> String {
    if let Some(data) = value.get("data").and_then(Value::as_object) {
        if let Some(text) = data.get(channel).and_then(Value::as_str) {
            return text.to_owned();
        }
    }
    if let Some(text) = value.get(channel).and_then(Value::as_str) {
        return text.to_owned();
    }
    String::new()
}

fn is_scalar_boundary(bytes: &[u8], index: usize) -> bool {
    index == 0 || index == bytes.len() || !is_utf_continuation(bytes[index])
}

fn is_utf_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

fn longest_scalar_prefix(text: &str, max_bytes: usize) -> &str {
    let mut end = text.len().min(max_bytes);
    while end > 0 && !is_scalar_boundary(text.as_bytes(), end) {
        end -= 1;
    }
    &text[..end]
}

#[allow(clippy::too_many_arguments)]
fn retrieve_unbounded(
    text: &str,
    max_bytes: u64,
    selector: ArtifactSelector,
    selector_request: Option<ArtifactSelector>,
    json_pointer: Option<String>,
    artifact_id: &ArtifactId,
    sha256: &Sha256Digest,
    is_binary: bool,
) -> Result<RetrieveArtifactResponse, ArtifactError> {
    let total_lines = line_count_of(text);
    let spans = line_spans(text);
    let bytes = text.as_bytes();
    // Binary content may cut at any byte count; UTF-8 cuts at a scalar boundary.
    let take = if is_binary {
        bytes.len().min(max_bytes as usize)
    } else {
        longest_scalar_prefix(text, max_bytes as usize).len()
    };
    let window = &bytes[..take];
    let complete = take == bytes.len();
    let continuation = if complete {
        None
    } else {
        Some(RetrieveArtifactRequest {
            artifact_id: *artifact_id,
            selector: selector_request,
            line_range: if is_binary {
                None
            } else {
                Some(InclusiveLineRange {
                    start: line_of_offset(&spans, take).unwrap_or(1),
                    end: total_lines,
                })
            },
            head_lines: None,
            tail_lines: None,
            regex: None,
            json_pointer,
            byte_offset: Some(take as u64),
            max_bytes: Some(max_bytes),
        })
    };
    Ok(build_response(
        artifact_id,
        sha256,
        selector,
        window,
        complete,
        if take == 0 {
            None
        } else {
            line_of_offset(&spans, 0)
        },
        if take == 0 {
            None
        } else {
            line_of_offset(&spans, take - 1)
        },
        Some(total_lines),
        Vec::new(),
        continuation,
        is_binary,
    ))
}

#[allow(clippy::too_many_arguments)]
fn retrieve_with_lines(
    text: &str,
    line_range: Option<&InclusiveLineRange>,
    byte_offset: Option<u64>,
    max_bytes: u64,
    selector: ArtifactSelector,
    selector_request: Option<ArtifactSelector>,
    json_pointer: Option<String>,
    artifact_id: &ArtifactId,
    sha256: &Sha256Digest,
    is_binary: bool,
) -> Result<RetrieveArtifactResponse, ArtifactError> {
    let total_lines = line_count_of(text);
    let spans = line_spans(text);

    if text.is_empty() {
        // Only reachable with byte_offset = 0 on an empty view.
        return Ok(build_response(
            artifact_id,
            sha256,
            selector,
            b"",
            true,
            None,
            None,
            Some(total_lines),
            Vec::new(),
            None,
            is_binary,
        ));
    }

    let range = line_range.cloned().unwrap_or(InclusiveLineRange {
        start: 1,
        end: total_lines,
    });
    let start_span = spans
        .get(range.start.saturating_sub(1) as usize)
        .copied()
        .unwrap_or((0, 0));

    if is_binary {
        // Binary content pages by raw bytes; no line or scalar constraints.
        let offset = byte_offset.unwrap_or(0) as usize;
        let selection = &text.as_bytes()[offset.min(text.len())..];
        let take = selection.len().min(max_bytes as usize);
        let window = &selection[..take];
        let complete = take == selection.len();
        let continuation = if complete {
            None
        } else {
            Some(RetrieveArtifactRequest {
                artifact_id: *artifact_id,
                selector: selector_request,
                line_range: None,
                head_lines: None,
                tail_lines: None,
                regex: None,
                json_pointer,
                byte_offset: Some((offset + take) as u64),
                max_bytes: Some(max_bytes),
            })
        };
        return Ok(build_response(
            artifact_id,
            sha256,
            selector,
            window,
            complete,
            None,
            None,
            Some(total_lines),
            Vec::new(),
            continuation,
            is_binary,
        ));
    }

    let mut selected: Vec<u8> = Vec::new();
    let mut continuation: Option<RetrieveArtifactRequest> = None;
    let selection_start;

    if let Some(offset) = byte_offset {
        let offset = offset as usize;
        selection_start = offset;
        if line_range.is_some() {
            // §10.1: with line_range the selection is
            // [byte_offset, end of line line_range.end]. It holds the rest of
            // the start line and then whole lines that fit.
            let remainder = &text[offset..start_span.1];
            let remainder_bytes = remainder.as_bytes();
            if remainder_bytes.len() > max_bytes as usize {
                // Start line's remainder alone does not fit: scalar prefix,
                // continuation keeps line_range unchanged + next byte offset.
                let prefix = longest_scalar_prefix(remainder, max_bytes as usize);
                selected.extend_from_slice(prefix.as_bytes());
                continuation = Some(RetrieveArtifactRequest {
                    artifact_id: *artifact_id,
                    selector: selector_request,
                    line_range: Some(range.clone()),
                    head_lines: None,
                    tail_lines: None,
                    regex: None,
                    json_pointer,
                    byte_offset: Some((offset + prefix.len()) as u64),
                    max_bytes: Some(max_bytes),
                });
            } else {
                selected.extend_from_slice(remainder_bytes);
                for line_no in (range.start + 1)..=range.end {
                    let span = spans.get((line_no - 1) as usize).copied().unwrap_or((0, 0));
                    let piece = &text[span.0..span.1];
                    let piece_bytes = piece.as_bytes();
                    if selected.len() + piece_bytes.len() > max_bytes as usize {
                        continuation = Some(RetrieveArtifactRequest {
                            artifact_id: *artifact_id,
                            selector: selector_request,
                            line_range: Some(InclusiveLineRange {
                                start: line_no,
                                end: range.end,
                            }),
                            head_lines: None,
                            tail_lines: None,
                            regex: None,
                            json_pointer,
                            byte_offset: None,
                            max_bytes: Some(max_bytes),
                        });
                        break;
                    }
                    selected.extend_from_slice(piece_bytes);
                }
            }
        } else {
            // §10.1: byte_offset-only selection is [byte_offset, end of view),
            // cut at the longest scalar-boundary prefix that fits.
            let selection = &text[offset..];
            let prefix = longest_scalar_prefix(selection, max_bytes as usize);
            selected.extend_from_slice(prefix.as_bytes());
            if prefix.len() < selection.len() {
                let next_byte = offset + prefix.len();
                continuation = Some(RetrieveArtifactRequest {
                    artifact_id: *artifact_id,
                    selector: selector_request,
                    line_range: Some(InclusiveLineRange {
                        start: line_of_offset(&spans, next_byte).unwrap_or(total_lines),
                        end: total_lines,
                    }),
                    head_lines: None,
                    tail_lines: None,
                    regex: None,
                    json_pointer,
                    byte_offset: Some(next_byte as u64),
                    max_bytes: Some(max_bytes),
                });
            }
        }
    } else {
        // Line-selected (or unselected default range): whole lines from
        // range.start; the start line may be cut at a scalar boundary when its
        // bytes alone do not fit (§10.1).
        selection_start = start_span.0;
        let mut first_line = true;
        for line_index in (range.start as usize)..=(range.end as usize) {
            let span = spans.get(line_index - 1).copied().unwrap_or((0, 0));
            let piece = &text[span.0..span.1];
            let piece_bytes = piece.as_bytes();
            if selected.len() + piece_bytes.len() > max_bytes as usize {
                if first_line {
                    // Start line alone does not fit: scalar prefix, continuation
                    // keeps line_range unchanged + next byte offset.
                    let prefix = longest_scalar_prefix(piece, max_bytes as usize);
                    selected.extend_from_slice(prefix.as_bytes());
                    continuation = Some(RetrieveArtifactRequest {
                        artifact_id: *artifact_id,
                        selector: selector_request,
                        line_range: Some(range.clone()),
                        head_lines: None,
                        tail_lines: None,
                        regex: None,
                        json_pointer,
                        byte_offset: Some((span.0 + prefix.len()) as u64),
                        max_bytes: Some(max_bytes),
                    });
                } else {
                    // Whole lines only: stop before the line that does not fit.
                    continuation = Some(RetrieveArtifactRequest {
                        artifact_id: *artifact_id,
                        selector: selector_request,
                        line_range: Some(InclusiveLineRange {
                            start: line_index as u64,
                            end: range.end,
                        }),
                        head_lines: None,
                        tail_lines: None,
                        regex: None,
                        json_pointer,
                        byte_offset: None,
                        max_bytes: Some(max_bytes),
                    });
                }
                break;
            }
            selected.extend_from_slice(piece_bytes);
            first_line = false;
        }
    }

    let complete = continuation.is_none();
    let selected_start = line_of_offset(&spans, selection_start);
    let selected_end = if selected.is_empty() {
        None
    } else {
        line_of_offset(&spans, selection_start + selected.len() - 1)
    };
    Ok(build_response(
        artifact_id,
        sha256,
        selector,
        &selected,
        complete,
        selected_start,
        selected_end,
        Some(total_lines),
        Vec::new(),
        continuation,
        is_binary,
    ))
}

#[allow(clippy::too_many_arguments)]
fn retrieve_with_regex(
    text: &str,
    line_range: Option<&InclusiveLineRange>,
    regex: &RegexFilter,
    max_bytes: u64,
    selector: ArtifactSelector,
    selector_request: Option<ArtifactSelector>,
    json_pointer: Option<String>,
    artifact_id: &ArtifactId,
    sha256: &Sha256Digest,
    is_binary: bool,
    cancel: &CancellationToken,
) -> Result<RetrieveArtifactResponse, ArtifactError> {
    let compiled = compile_regex(&regex.pattern, regex.case_sensitive)?;
    let lines: Vec<&str> = text.split('\n').collect();
    let total_lines = line_count_of(text);
    let range = line_range.cloned().unwrap_or(InclusiveLineRange {
        start: 1,
        end: total_lines,
    });
    // §10.1: matches are at most 1000 regardless of the requested cap.
    let match_cap = (regex.max_matches as usize).min(MAX_REGEX_MATCHES as usize);

    let mut matches = Vec::new();
    let mut groups: Vec<(u64, u64)> = Vec::new();
    for line_index in (range.start - 1) as usize..range.end as usize {
        // History §12: a cancellation token is checked before the scan and
        // while it runs, so a long document stops promptly.
        if line_index % CANCEL_CHECK_INTERVAL == 0 {
            check_cancel(cancel)?;
        }
        let line_text = lines.get(line_index).copied().unwrap_or("");
        for captures in compiled.captures_iter(line_text) {
            let m = captures.get(0).unwrap();
            let start_col = line_text[..m.start()].chars().count() as u64 + 1;
            let end_col = line_text[..m.end()].chars().count() as u64 + 1;
            matches.push(ArtifactRegexMatch {
                line: line_index as u64 + 1,
                start_column: start_col,
                end_column: end_col,
            });
            groups.push((line_index as u64 + 1, line_index as u64 + 1));
            if matches.len() >= match_cap {
                break;
            }
        }
        if matches.len() >= match_cap {
            break;
        }
    }
    let matches = matches
        .into_iter()
        .take(MAX_REGEX_MATCHES as usize)
        .collect();

    let merged = merge_context_groups(&groups, regex.context_before, regex.context_after, &range);

    let mut selected = String::new();
    let mut remaining = max_bytes as usize;
    let mut first_included: Option<u64> = None;
    let mut last_included: Option<u64> = None;
    let mut continuation: Option<RetrieveArtifactRequest> = None;

    for (group_index, (g_start, g_end)) in merged.iter().enumerate() {
        let mut group_text = String::new();
        for line_index in (*g_start - 1) as usize..(*g_end - 1) as usize + 1 {
            let line_text = lines.get(line_index).copied().unwrap_or("");
            if line_index + 1 < lines.len() {
                group_text.push_str(line_text);
                group_text.push('\n');
            } else {
                group_text.push_str(line_text);
            }
        }
        if group_text.len() > remaining {
            if group_index == 0 {
                // History §10.1: the caller retrieves the group with a
                // non-regex line_range request.
                return Err(ArtifactError::new(
                    "HISTORY_ARTIFACT_TOO_LARGE",
                    format!("regex group {g_start}..{g_end} does not fit"),
                )
                .with_details(serde_json::json!({
                    "line_start": g_start,
                    "line_end": g_end,
                })));
            }
            // §10.1: continuation resumes at the line after the last included
            // group and keeps the regex filter.
            let resume = last_included.map(|end| end + 1).unwrap_or(range.end);
            continuation = Some(RetrieveArtifactRequest {
                artifact_id: *artifact_id,
                selector: selector_request,
                line_range: Some(InclusiveLineRange {
                    start: resume,
                    end: range.end,
                }),
                head_lines: None,
                tail_lines: None,
                regex: Some(regex.clone()),
                json_pointer,
                byte_offset: None,
                max_bytes: Some(max_bytes),
            });
            break;
        }
        selected.push_str(&group_text);
        remaining -= group_text.len();
        first_included.get_or_insert(*g_start);
        last_included = Some(*g_end);
        check_cancel(cancel)?;
    }

    Ok(build_response(
        artifact_id,
        sha256,
        selector,
        selected.as_bytes(),
        continuation.is_none(),
        first_included,
        last_included,
        Some(total_lines),
        matches,
        continuation,
        is_binary,
    ))
}

fn compile_regex(pattern: &str, case_sensitive: bool) -> Result<regex::Regex, ArtifactError> {
    regex::RegexBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|err| {
            let msg = err.to_string();
            if msg.contains("look-around") || msg.contains("backreference") {
                ArtifactError::new(
                    "HISTORY_REGEX_UNSUPPORTED",
                    "regex requests unsupported semantics",
                )
            } else {
                ArtifactError::new("HISTORY_REGEX_INVALID", "regex cannot compile")
            }
        })
}

fn merge_context_groups(
    groups: &[(u64, u64)],
    context_before: u32,
    context_after: u32,
    range: &InclusiveLineRange,
) -> Vec<(u64, u64)> {
    if groups.is_empty() {
        return Vec::new();
    }
    let mut merged: Vec<(u64, u64)> = Vec::new();
    for &(start, end) in groups {
        // Line slicing applies before regex filtering (§10.1), so context
        // ranges stay inside the requested range.
        let expanded_start = start.saturating_sub(context_before as u64).max(range.start);
        let expanded_end = (end + context_after as u64).min(range.end);
        if let Some(last) = merged.last_mut() {
            if expanded_start <= last.1 + 1 {
                last.1 = last.1.max(expanded_end);
                continue;
            }
        }
        merged.push((expanded_start, expanded_end));
    }
    merged
}

#[allow(clippy::too_many_arguments)]
fn build_response(
    artifact_id: &ArtifactId,
    sha256: &Sha256Digest,
    selector: ArtifactSelector,
    window: &[u8],
    complete: bool,
    selected_line_start: Option<u64>,
    selected_line_end: Option<u64>,
    total_lines: Option<u64>,
    matches: Vec<ArtifactRegexMatch>,
    continuation: Option<RetrieveArtifactRequest>,
    is_binary: bool,
) -> RetrieveArtifactResponse {
    // §10.2: binary responses have null line fields and total; Base64 carries
    // exact decoded bytes and returned_bytes counts decoded bytes.
    let (selected_line_start, selected_line_end, total_lines) = if is_binary {
        (None, None, None)
    } else {
        (selected_line_start, selected_line_end, total_lines)
    };
    let content = if is_binary {
        ArtifactRetrievedContent::Base64(encode_base64(window))
    } else {
        ArtifactRetrievedContent::Utf8(
            std::str::from_utf8(window)
                .expect("utf-8 view windows are scalar aligned")
                .to_owned(),
        )
    };
    RetrieveArtifactResponse {
        artifact_id: *artifact_id,
        sha256: sha256.clone(),
        selector,
        content,
        returned_bytes: window.len() as u64,
        complete,
        selected_line_start,
        selected_line_end,
        total_lines,
        matches,
        continuation,
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let remaining = bytes.len() - index;
        let b0 = bytes[index];
        let b1 = if remaining > 1 { bytes[index + 1] } else { 0 };
        let b2 = if remaining > 2 { bytes[index + 2] } else { 0 };
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if remaining == 1 {
            out.push('=');
            out.push('=');
        } else {
            out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
            if remaining == 2 {
                out.push('=');
            } else {
                out.push(TABLE[(b2 & 0x3f) as usize] as char);
            }
        }
        index += 3;
    }
    out
}

/// History §10.2: access telemetry is written after successful retrieval and
/// is never part of the canonical response. Tool callers hold a read-only
/// connection (§12), where this non-authoritative write is a no-op; §2.1 allows
/// telemetry loss without semantic effect. A failure is never surfaced.
fn write_access_telemetry(
    conn: &rusqlite::Connection,
    artifact_id: &ArtifactId,
    returned_bytes: u64,
) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();
    let _ = conn.execute(
        "INSERT INTO artifact_access(artifact_id, access_kind, returned_bytes, occurred_at_ms)
         VALUES (?1, 'retrieved', ?2, ?3)
         ON CONFLICT DO NOTHING",
        rusqlite::params![artifact_id.to_string(), returned_bytes as i64, now_ms],
    );
}

pub fn read_session_source(
    conn: &rusqlite::Connection,
    request: &ReadSessionSourceRequest,
    cancel: &CancellationToken,
) -> Result<ReadSessionSourceResponse, ArtifactError> {
    read_session_source_bounded(conn, request, cancel, HARD_MAX_BYTES)
}

/// Like `read_session_source`, but the returned window fits `max_bytes`
/// instead of the 2 MiB storage hard cap (History §10.4 tool bound).
pub fn read_session_source_bounded(
    conn: &rusqlite::Connection,
    request: &ReadSessionSourceRequest,
    cancel: &CancellationToken,
    max_bytes: u64,
) -> Result<ReadSessionSourceResponse, ArtifactError> {
    // History §12: cancellation is checked before the read and before the
    // window is materialized, never by abandoning a transaction midway.
    check_cancel(cancel)?;
    type SourceRow = (
        String,
        String,
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
        String,
        String,
    );
    let row: Option<SourceRow> = conn
        .prepare(
            "SELECT document_id, source_kind, source_field, event_id, event_sequence, turn_id, content_sha256, text
             FROM search_documents WHERE document_id = ?1",
        )
        .map_err(map_sqlite)?
        .query_row([request.result_id.to_string()], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get(7)?,
            ))
        })
        .optional()
        .map_err(map_sqlite)?;

    let Some((
        document_id,
        source_kind,
        source_field,
        event_id,
        event_sequence,
        turn_id,
        content_sha256,
        text,
    )) = row
    else {
        return Err(ArtifactError::new(
            "HISTORY_SOURCE_NOT_FOUND",
            "result_id not found",
        ));
    };
    if source_kind != "event" && source_kind != "state" {
        return Err(ArtifactError::new(
            "HISTORY_SOURCE_NOT_FOUND",
            "result_id is not a session source",
        ));
    }

    let stored_sha = parse_digest(&content_sha256, "document content hash")?;
    let actual_sha = Sha256Digest::digest_bytes(text.as_bytes());
    if actual_sha != stored_sha {
        return Err(ArtifactError::new(
            "HISTORY_EVENT_INTEGRITY",
            "stored text does not hash to content_sha256",
        ));
    }
    let document_id =
        SearchResultId::from_str_canonical(&document_id).map_err(|_| invalid_id("document_id"))?;
    let stored_event_id = event_id
        .as_deref()
        .map(|id| EventId::from_str_canonical(id).map_err(|_| invalid_id("event_id")))
        .transpose()?;
    let stored_turn_id = turn_id
        .as_deref()
        .map(|id| TurnId::from_str_canonical(id).map_err(|_| invalid_id("turn_id")))
        .transpose()?;

    let total_bytes = text.len() as u64;
    let total_lines = line_count_of(&text);
    let offset = request.byte_offset;
    if offset >= total_bytes {
        return Err(ArtifactError::new(
            "HISTORY_ARTIFACT_RANGE",
            "byte offset is outside the text",
        ));
    }
    if !is_scalar_boundary(text.as_bytes(), offset as usize) {
        return Err(ArtifactError::new(
            "HISTORY_ARTIFACT_RANGE",
            "byte offset is not a scalar boundary",
        ));
    }

    let remaining = &text[offset as usize..];
    let mut window = longest_scalar_prefix(remaining, max_bytes as usize);
    if offset + window.len() as u64 != total_bytes {
        // §10.3: a prefix that does not reach the end and contains an LF is
        // shortened to end just after its last LF.
        if let Some(last_lf) = window.rfind('\n') {
            window = &window[..last_lf + 1];
        }
    }
    let returned_bytes = window.len() as u64;
    let reached_end = offset + returned_bytes == total_bytes;
    // §10.3: complete is true only when byte_offset = 0 and the whole text is
    // returned; continuation is null exactly when the window reaches the end.
    let complete = offset == 0 && reached_end;
    let continuation = if reached_end {
        None
    } else {
        Some(ReadSessionSourceRequest {
            result_id: document_id,
            byte_offset: offset + returned_bytes,
        })
    };

    let start_line = text[..offset as usize]
        .bytes()
        .filter(|&b| b == b'\n')
        .count() as u64
        + 1;
    let lfs = window.bytes().filter(|&b| b == b'\n').count() as u64;
    // §10.3: an LF belongs to the line it terminates, so a window ending on an
    // LF ends on the line that LF terminates.
    let end_line = if window.ends_with('\n') {
        start_line + lfs - 1
    } else {
        start_line + lfs
    };

    check_cancel(cancel)?;
    Ok(ReadSessionSourceResponse {
        result_id: document_id,
        source_kind: if source_kind == "state" {
            SearchSourceKind::State
        } else {
            SearchSourceKind::Event
        },
        source_field,
        event_id: stored_event_id,
        event_sequence: event_sequence.map(|seq| seq as u64),
        turn_id: stored_turn_id,
        content_sha256: stored_sha,
        text: window.to_string(),
        byte_offset: offset,
        returned_bytes,
        total_bytes,
        start_line,
        end_line,
        total_lines,
        complete,
        continuation,
    })
}
