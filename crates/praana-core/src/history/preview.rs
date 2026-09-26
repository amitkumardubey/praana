//! Immutable artifact previews. The rendered text is the model-visible preview;
//! token checks use the complete rendering, never a cut substring.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::error::{io_err, ArtifactError};
use crate::protocol::id::{ArtifactId, Sha256Digest, ToolCallId};
use crate::token::{
    FramingProfileV1, GenericTokenEstimatorV1, TokenEstimationContext, TokenEstimatorV1,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactPreviewV1 {
    pub preview_schema_version: u32,
    pub artifact_id: ArtifactId,
    pub sha256: Sha256Digest,
    pub tool_call_id: ToolCallId,
    pub tool_name: String,
    pub label: Option<String>,
    pub content_type: ArtifactContentType,
    pub byte_count: u64,
    pub line_count: u64,
    pub estimated_tokens: u64,
    pub is_error: bool,
    pub exit_code: Option<i32>,
    pub redaction: PreviewRedaction,
    pub sample: PreviewSample,
    pub retrieval: Vec<ArtifactRetrievalHint>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactContentType {
    Text,
    Code,
    Diff,
    Log,
    Json,
    TestOutput,
    BuildOutput,
    SearchResults,
    Error,
    Binary,
    Other,
}

impl ArtifactContentType {
    pub fn as_sql(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Code => "code",
            Self::Diff => "diff",
            Self::Log => "log",
            Self::Json => "json",
            Self::TestOutput => "test_output",
            Self::BuildOutput => "build_output",
            Self::SearchResults => "search_results",
            Self::Error => "error",
            Self::Binary => "binary",
            Self::Other => "other",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreviewRedaction {
    pub applied: bool,
    pub replacement_count: u32,
    pub kinds: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreviewSample {
    pub strategy: PreviewStrategy,
    pub text: String,
    pub omitted_bytes: u64,
    pub omitted_lines: u64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreviewStrategy {
    None,
    Full,
    Head,
    Tail,
    HeadTail,
}

impl PreviewStrategy {
    fn as_label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Full => "full",
            Self::Head => "head",
            Self::Tail => "tail",
            Self::HeadTail => "head_tail",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRetrievalHint {
    pub operation: String,
    pub arguments: Value,
}

#[derive(Clone, Debug)]
pub struct PreviewRequest {
    pub artifact_id: ArtifactId,
    pub tool_call_id: ToolCallId,
    pub sha256: Sha256Digest,
    pub tool_name: String,
    pub label: Option<String>,
    pub content_type: ArtifactContentType,
    pub canonical_bytes: Vec<u8>,
    pub text_view: String,
    pub byte_count: u64,
    pub line_count: u64,
    pub estimated_tokens: u64,
    pub is_error: bool,
    pub exit_code: Option<i32>,
    pub redaction_applied: bool,
    pub redaction_count: u32,
    pub redaction_kinds: Vec<String>,
    pub preview_token_limit: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderedPreview {
    pub preview: ArtifactPreviewV1,
    pub preview_json: String,
    pub preview_text: String,
    pub estimated_preview_tokens: u64,
    pub estimator_id: String,
    pub input_sha256: Sha256Digest,
}

struct Unit {
    ordinal: usize,
    text: String,
    byte_start: u64,
    byte_end: u64,
    line_start: u64,
    line_end: u64,
}

pub fn render_preview(request: &PreviewRequest) -> Result<RenderedPreview, ArtifactError> {
    let label = request.label.as_deref().map(cap_label);
    let units = units_for(request);
    if let Some(rendered) = fit(request, label.as_deref(), &units)? {
        return Ok(rendered);
    }
    if label.is_some() {
        if let Some(rendered) = fit(request, None, &units)? {
            return Ok(rendered);
        }
    }
    Err(ArtifactError::new(
        "HISTORY_PREVIEW_BOUND",
        "fixed artifact metadata cannot fit the preview budget",
    ))
}

fn fit(
    request: &PreviewRequest,
    label: Option<&str>,
    units: &[Unit],
) -> Result<Option<RenderedPreview>, ArtifactError> {
    let mut selected: Vec<usize> = Vec::new();
    let metadata = compose(
        request,
        label,
        &[],
        units,
        strategy_for(request, &[], units),
    )?;
    if estimate_text(&metadata.preview_text)?.total_tokens > request.preview_token_limit {
        return Ok(None);
    }
    let mut best = metadata;
    for (index, _unit) in units.iter().enumerate() {
        if selected.contains(&index) {
            continue;
        }
        let mut trial = selected.clone();
        trial.push(index);
        trial.sort_unstable();
        let strategy = strategy_for(request, &trial, units);
        let candidate = compose(request, label, &trial, units, strategy)?;
        if estimate_text(&candidate.preview_text)?.total_tokens <= request.preview_token_limit {
            selected = trial;
            best = candidate;
        }
    }
    let estimate = estimate_text(&best.preview_text)?;
    Ok(Some(RenderedPreview {
        preview: best.preview,
        preview_json: best.preview_json,
        preview_text: best.preview_text,
        estimated_preview_tokens: estimate.total_tokens,
        estimator_id: estimate.estimator_id,
        input_sha256: estimate.input_sha256,
    }))
}

struct Composed {
    preview: ArtifactPreviewV1,
    preview_json: String,
    preview_text: String,
}

fn compose(
    request: &PreviewRequest,
    label: Option<&str>,
    selected: &[usize],
    units: &[Unit],
    strategy: PreviewStrategy,
) -> Result<Composed, ArtifactError> {
    let sample_text = if strategy == PreviewStrategy::None {
        String::new()
    } else {
        let mut ordered = selected.to_vec();
        ordered.sort_by_key(|index| units[*index].ordinal);
        ordered
            .iter()
            .map(|index| units[*index].text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let (omitted_bytes, omitted_lines) = omission(request, selected, units, strategy);
    let preview = ArtifactPreviewV1 {
        preview_schema_version: 1,
        artifact_id: request.artifact_id,
        sha256: request.sha256.clone(),
        tool_call_id: request.tool_call_id.clone(),
        tool_name: request.tool_name.clone(),
        label: label.map(str::to_owned),
        content_type: request.content_type,
        byte_count: request.byte_count,
        line_count: request.line_count,
        estimated_tokens: request.estimated_tokens,
        is_error: request.is_error,
        exit_code: request.exit_code,
        redaction: PreviewRedaction {
            applied: request.redaction_applied,
            replacement_count: request.redaction_count,
            kinds: request.redaction_kinds.clone(),
        },
        sample: PreviewSample {
            strategy,
            text: sample_text,
            omitted_bytes,
            omitted_lines,
        },
        retrieval: vec![ArtifactRetrievalHint {
            operation: "retrieve_artifact".to_owned(),
            arguments: {
                let mut map = Map::new();
                map.insert(
                    "artifact_id".to_owned(),
                    Value::String(request.artifact_id.to_string()),
                );
                Value::Object(map)
            },
        }],
    };
    let preview_text = render_preview_text(&preview);
    let preview_json = canonical_preview(&preview)?;
    Ok(Composed {
        preview,
        preview_json,
        preview_text,
    })
}

pub fn render_preview_text(preview: &ArtifactPreviewV1) -> String {
    let label = match &preview.label {
        None => String::new(),
        Some(value) => format!(
            " [label={}]",
            serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
        ),
    };
    let exit = match preview.exit_code {
        None => "none".to_owned(),
        Some(code) => code.to_string(),
    };
    let sample_body = match preview.sample.strategy {
        PreviewStrategy::None => "[no textual sample]".to_owned(),
        _ if preview.sample.text.is_empty() => "[no selected textual unit fit]".to_owned(),
        _ => preview.sample.text.clone(),
    };
    let mut lines = vec![
        format!(
            "Artifact {}: {}{} ({} bytes, {} lines, {} estimated tokens; error={}; exit={}).",
            preview.artifact_id,
            preview.tool_name,
            label,
            preview.byte_count,
            preview.line_count,
            preview.estimated_tokens,
            preview.is_error,
            exit
        ),
        format!("Sample ({}):", preview.sample.strategy.as_label()),
        sample_body,
    ];
    if preview.sample.omitted_bytes != 0 || preview.sample.omitted_lines != 0 {
        lines.push(format!(
            "[... {} bytes and {} lines omitted ...]",
            preview.sample.omitted_bytes, preview.sample.omitted_lines
        ));
    }
    lines.push(format!(
        "Retrieve with retrieve_artifact({{\"artifact_id\":\"{}\"}}).",
        preview.artifact_id
    ));
    lines.join("\n")
}

fn omission(
    request: &PreviewRequest,
    selected: &[usize],
    units: &[Unit],
    strategy: PreviewStrategy,
) -> (u64, u64) {
    if strategy == PreviewStrategy::None {
        return (request.byte_count, request.line_count);
    }
    let (source, source_lines) = if matches!(request.content_type, ArtifactContentType::Json) {
        let text = std::str::from_utf8(&request.canonical_bytes).unwrap_or("");
        (text, line_count_of(text))
    } else {
        (request.text_view.as_str(), request.line_count)
    };
    let mut covered = vec![false; source.len()];
    let mut covered_lines = std::collections::BTreeSet::new();
    for index in selected {
        let unit = &units[*index];
        let start = unit.byte_start.min(source.len() as u64) as usize;
        let end = unit.byte_end.min(source.len() as u64) as usize;
        for slot in covered.iter_mut().take(end).skip(start) {
            *slot = true;
        }
        if unit.line_end > unit.line_start {
            for line in unit.line_start..unit.line_end {
                covered_lines.insert(line);
            }
        }
    }
    let covered_bytes = covered.iter().filter(|slot| **slot).count() as u64;
    let omitted_bytes = source.len() as u64 - covered_bytes;
    let omitted_lines = source_lines.saturating_sub(covered_lines.len() as u64);
    (omitted_bytes, omitted_lines)
}

fn strategy_for(request: &PreviewRequest, selected: &[usize], units: &[Unit]) -> PreviewStrategy {
    if matches!(request.content_type, ArtifactContentType::Binary) {
        return PreviewStrategy::None;
    }
    if selected.is_empty() {
        return PreviewStrategy::HeadTail;
    }
    if selected.len() == units.len() {
        return PreviewStrategy::Full;
    }
    let mut min = usize::MAX;
    let mut max = 0usize;
    for index in selected {
        min = min.min(*index);
        max = max.max(*index);
    }
    let touches_head = min == 0;
    let touches_tail = max + 1 == units.len();
    match (touches_head, touches_tail) {
        (true, true) => PreviewStrategy::HeadTail,
        (true, false) => PreviewStrategy::Head,
        (false, true) => PreviewStrategy::Tail,
        (false, false) => PreviewStrategy::HeadTail,
    }
}

fn units_for(request: &PreviewRequest) -> Vec<Unit> {
    if matches!(request.content_type, ArtifactContentType::Binary) {
        return Vec::new();
    }
    match request.content_type {
        ArtifactContentType::Json => json_units(&request.canonical_bytes),
        ArtifactContentType::TestOutput | ArtifactContentType::BuildOutput => {
            prioritized_lines(&request.text_view, true, false)
        }
        ArtifactContentType::Diff => diff_units(&request.text_view),
        ArtifactContentType::SearchResults => {
            let parsed = serde_json::from_slice::<Value>(&request.canonical_bytes).ok();
            if let Some(Value::Array(items)) = parsed {
                if items.iter().all(|item| item.is_object()) {
                    return array_units(&items);
                }
            }
            generic_lines(&request.text_view)
        }
        _ => generic_lines(&request.text_view),
    }
}

fn generic_lines(text: &str) -> Vec<Unit> {
    let lines = split_lines(text);
    let mut order = Vec::new();
    let mut left = 0usize;
    let mut right = lines.len();
    while left < right {
        order.push(left);
        left += 1;
        if left < right {
            right -= 1;
            order.push(right);
        }
    }
    reorder(lines, &order)
}

fn prioritized_lines(text: &str, keywords: bool, _diff: bool) -> Vec<Unit> {
    let lines = split_lines(text);
    let mut order = Vec::new();
    if keywords {
        for (index, line) in lines.iter().enumerate() {
            if keyword_line(&line.text) {
                order.push(index);
            }
        }
    }
    let tail_from = lines.len().saturating_sub(5);
    for index in tail_from..lines.len() {
        if !order.contains(&index) {
            order.push(index);
        }
    }
    for index in 0..lines.len() {
        if !order.contains(&index) {
            order.push(index);
        }
    }
    reorder(lines, &order)
}

fn diff_units(text: &str) -> Vec<Unit> {
    let lines = split_lines(text);
    let mut order = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if line.text.starts_with("diff --git ")
            || line.text.starts_with("--- ")
            || line.text.starts_with("+++ ")
            || line.text.starts_with("@@ ")
        {
            order.push(index);
        }
    }
    let changed: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let body = line.text.as_str();
            let changed = (body.starts_with('+') || body.starts_with('-'))
                && !body.starts_with("+++ ")
                && !body.starts_with("--- ");
            changed.then_some(index)
        })
        .collect();
    let mut left = 0usize;
    let mut right = changed.len();
    while left < right {
        order.push(changed[left]);
        left += 1;
        if left < right {
            right -= 1;
            order.push(changed[right]);
        }
    }
    for index in 0..lines.len() {
        if !order.contains(&index) {
            order.push(index);
        }
    }
    reorder(lines, &order)
}

fn keyword_line(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "error",
        "failed",
        "failure",
        "panic",
        "test result",
        "summary",
        "passed",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn json_units(bytes: &[u8]) -> Vec<Unit> {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    match value {
        Value::Object(map) => {
            let Some(mut spans) = object_member_spans(bytes) else {
                return Vec::new();
            };
            cover_document(&mut spans, bytes.len());
            spans
                .into_iter()
                .enumerate()
                .filter_map(|(ordinal, (start, end))| {
                    let key = json_string_at(&bytes[start..])?;
                    let member = map.get(&key)?;
                    let rendered = format!("{}: {}", json_key(&key), json_value(member));
                    Some(Unit {
                        ordinal,
                        text: rendered,
                        byte_start: start as u64,
                        byte_end: end as u64,
                        line_start: newline_count(bytes, start),
                        line_end: newline_count(bytes, end.saturating_sub(1)) + 1,
                    })
                })
                .collect()
        }
        Value::Array(items) => array_units(&items),
        other => vec![Unit {
            ordinal: 0,
            text: format!("value: {}", json_value(&other)),
            byte_start: 0,
            byte_end: bytes.len() as u64,
            line_start: 0,
            line_end: newline_count(bytes, bytes.len().saturating_sub(1)) + 1,
        }],
    }
}

fn cover_document(spans: &mut [(usize, usize)], len: usize) {
    if spans.is_empty() {
        return;
    }
    spans[0].0 = 0;
    for index in 0..spans.len() - 1 {
        spans[index].1 = spans[index + 1].0;
    }
    if let Some(last) = spans.last_mut() {
        last.1 = len;
    }
}

fn newline_count(bytes: &[u8], offset: usize) -> u64 {
    bytes[..offset.min(bytes.len())]
        .iter()
        .filter(|byte| **byte == b'\n')
        .count() as u64
}

fn json_string_at(bytes: &[u8]) -> Option<String> {
    let start = bytes.iter().position(|byte| *byte == b'"')?;
    let mut scan = JsonScan {
        bytes: &bytes[start..],
        index: 0,
    };
    if !scan.skip_string() {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes[start..start + scan.index]).ok()?;
    value.as_str().map(str::to_owned)
}

fn object_member_spans(bytes: &[u8]) -> Option<Vec<(usize, usize)>> {
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut scan = JsonScan { bytes, index: 1 };
    if scan.peek() == Some(b'}') {
        return Some(Vec::new());
    }
    let mut spans = Vec::new();
    loop {
        let start = scan.index;
        if !scan.skip_string() || scan.bump() != Some(b':') || !scan.skip_value() {
            return None;
        }
        spans.push((start, scan.index));
        match scan.bump() {
            Some(b',') => continue,
            Some(b'}') => return Some(spans),
            _ => return None,
        }
    }
}

struct JsonScan<'a> {
    bytes: &'a [u8],
    index: usize,
}

impl JsonScan<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.index).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.index += 1;
        Some(byte)
    }

    fn skip_string(&mut self) -> bool {
        if self.bump() != Some(b'"') {
            return false;
        }
        while let Some(byte) = self.bump() {
            match byte {
                b'\\' => {
                    if self.bump().is_none() {
                        return false;
                    }
                }
                b'"' => return true,
                _ => {}
            }
        }
        false
    }

    fn skip_value(&mut self) -> bool {
        match self.peek() {
            Some(b'"') => self.skip_string(),
            Some(b'{') => self.skip_container(b'{', b'}'),
            Some(b'[') => self.skip_container(b'[', b']'),
            Some(b't') => self.skip_literal(b"true"),
            Some(b'f') => self.skip_literal(b"false"),
            Some(b'n') => self.skip_literal(b"null"),
            Some(b'-') | Some(b'0'..=b'9') => self.skip_number(),
            _ => false,
        }
    }

    fn skip_literal(&mut self, literal: &[u8]) -> bool {
        if self.bytes[self.index..].starts_with(literal) {
            self.index += literal.len();
            true
        } else {
            false
        }
    }

    fn skip_number(&mut self) -> bool {
        let start = self.index;
        while matches!(
            self.peek(),
            Some(b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
        ) {
            self.index += 1;
        }
        self.index > start
    }

    fn skip_container(&mut self, open: u8, close: u8) -> bool {
        if self.bump() != Some(open) {
            return false;
        }
        if self.peek() == Some(close) {
            self.index += 1;
            return true;
        }
        loop {
            if open == b'{' && !self.skip_string() {
                return false;
            }
            if open == b'{' && self.bump() != Some(b':') {
                return false;
            }
            if !self.skip_value() {
                return false;
            }
            match self.bump() {
                Some(b',') => continue,
                Some(found) if found == close => return true,
                _ => return false,
            }
        }
    }
}

fn array_units(items: &[Value]) -> Vec<Unit> {
    items
        .iter()
        .enumerate()
        .map(|(ordinal, value)| Unit {
            ordinal,
            text: format!("[{ordinal}]: {}", json_value(value)),
            byte_start: 0,
            byte_end: 0,
            line_start: ordinal as u64,
            line_end: ordinal as u64 + 1,
        })
        .collect()
}

fn json_key(key: &str) -> String {
    serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_owned())
}

fn json_value(value: &Value) -> String {
    match value {
        Value::Object(map) => format!("<object items={}>", map.len()),
        Value::Array(items) => format!("<array items={}>", items.len()),
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_owned()),
    }
}

fn split_lines(text: &str) -> Vec<Unit> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut units = Vec::new();
    let mut start = 0usize;
    let bytes = text.as_bytes();
    let mut line_no = 0u64;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            let end = index + 1;
            let slice = &text[start..index];
            units.push(Unit {
                ordinal: units.len(),
                text: slice.to_owned(),
                byte_start: start as u64,
                byte_end: end as u64,
                line_start: line_no,
                line_end: line_no + 1,
            });
            start = end;
            line_no += 1;
        }
    }
    if start < bytes.len() {
        units.push(Unit {
            ordinal: units.len(),
            text: text[start..].to_owned(),
            byte_start: start as u64,
            byte_end: bytes.len() as u64,
            line_start: line_no,
            line_end: line_no + 1,
        });
    }
    units
}

fn reorder(mut lines: Vec<Unit>, order: &[usize]) -> Vec<Unit> {
    let mut out = Vec::new();
    for index in order {
        if *index < lines.len() {
            let mut unit = Unit {
                ordinal: lines[*index].ordinal,
                text: String::new(),
                byte_start: 0,
                byte_end: 0,
                line_start: 0,
                line_end: 0,
            };
            std::mem::swap(&mut unit, &mut lines[*index]);
            out.push(unit);
        }
    }
    out
}

fn cap_label(label: &str) -> String {
    let mut out = String::new();
    for ch in label.chars() {
        let next = out.len() + ch.len_utf8();
        if next > 256 {
            break;
        }
        out.push(ch);
    }
    out
}

fn zero_framing() -> FramingProfileV1 {
    FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "history-preview-v1".to_owned(),
        fixed_tokens: 0,
        per_item_tokens: 0,
        item_count: 0,
        additional_tokens: 0,
    }
}

fn estimate_text(text: &str) -> Result<crate::token::TokenEstimateV1, ArtifactError> {
    GenericTokenEstimatorV1
        .estimate(
            TokenEstimationContext::ArtifactPreview,
            text.as_bytes(),
            &zero_framing(),
        )
        .map_err(|err| io_err(format!("token accounting overflow: {err}")))
}

fn canonical_preview(preview: &ArtifactPreviewV1) -> Result<String, ArtifactError> {
    let bytes = crate::canonical_json::to_canonical_json_bytes(preview)
        .map_err(|err| io_err(format!("preview json: {err}")))?;
    String::from_utf8(bytes).map_err(|_| io_err("preview json was not utf-8"))
}

pub fn line_count_of(text: &str) -> u64 {
    if text.is_empty() {
        0
    } else {
        1 + text.bytes().filter(|byte| *byte == b'\n').count() as u64
    }
}
