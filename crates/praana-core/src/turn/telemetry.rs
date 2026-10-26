//! Per-session admission telemetry (Compaction §14.3 steps 1–2).
//!
//! Rows hold ids and integers only. They are not calibration samples and they
//! never enter `calibration.db`. A write failure does not change the turn.

use std::collections::BTreeMap;

use crate::history::artifact::ArtifactStore;
use crate::protocol::models::ModelSelection;

pub(crate) const ADMISSION_CONTEXT_UNDERESTIMATION: &str = "admission_context_underestimation";
pub(crate) const CALIBRATION_STORE_ERROR: &str = "calibration_store_error";

/// `max(1, W - I + 1)`. Telemetry only.
pub(crate) fn underestimation_figure(
    context_window_tokens: u64,
    estimated_input_tokens: u64,
) -> u64 {
    context_window_tokens
        .saturating_sub(estimated_input_tokens)
        .saturating_add(1)
        .max(1)
}

pub(crate) struct ContextUnderestimation<'a> {
    pub model: &'a ModelSelection,
    pub estimator_id: &'a str,
    pub request_hash: &'a str,
    pub error_code: &'a str,
    pub context_window_tokens: u64,
    pub estimated_input_tokens: u64,
    pub component_tokens: &'a [u64; 9],
}

pub(crate) fn record_context_underestimation(
    store: &ArtifactStore,
    record: &ContextUnderestimation<'_>,
    occurred_at_ms: i64,
) {
    let Ok(value) = i64::try_from(underestimation_figure(
        record.context_window_tokens,
        record.estimated_input_tokens,
    )) else {
        return;
    };
    let mut dimensions = BTreeMap::new();
    dimensions.insert("provider", Dimension::Text(record.model.provider.clone()));
    dimensions.insert("protocol", Dimension::Text(record.model.protocol.clone()));
    dimensions.insert("model", Dimension::Text(record.model.model.clone()));
    dimensions.insert(
        "model_revision",
        match &record.model.model_revision {
            Some(revision) => Dimension::Text(revision.clone()),
            None => Dimension::Null,
        },
    );
    dimensions.insert(
        "estimator_id",
        Dimension::Text(record.estimator_id.to_owned()),
    );
    dimensions.insert(
        "request_hash",
        Dimension::Text(record.request_hash.to_owned()),
    );
    dimensions.insert("error_code", Dimension::Text(record.error_code.to_owned()));
    dimensions.insert(
        "context_window_tokens",
        Dimension::Number(record.context_window_tokens),
    );
    dimensions.insert(
        "estimated_input_tokens",
        Dimension::Number(record.estimated_input_tokens),
    );
    for (index, tokens) in record.component_tokens.iter().enumerate() {
        dimensions.insert(component_dimension(index), Dimension::Number(*tokens));
    }
    let _ = store.record_telemetry_sample(
        ADMISSION_CONTEXT_UNDERESTIMATION,
        None,
        value,
        &dimensions_json(&dimensions),
        occurred_at_ms,
    );
}

pub(crate) fn record_calibration_store_error(
    store: &ArtifactStore,
    code: &str,
    occurred_at_ms: i64,
) {
    if !code
        .bytes()
        .all(|byte| matches!(byte, b'A'..=b'Z' | b'0'..=b'9' | b'_'))
        || code.is_empty()
    {
        return;
    }
    let json = format!("{{\"error_code\":\"{code}\"}}");
    let _ = store.record_telemetry_sample(CALIBRATION_STORE_ERROR, None, 0, &json, occurred_at_ms);
}

fn component_dimension(index: usize) -> &'static str {
    match index {
        0 => "system_tokens",
        1 => "tool_schema_tokens",
        2 => "memory_bootstrap_tokens",
        3 => "handoff_tokens",
        4 => "retained_message_tokens",
        5 => "state_graph_tokens",
        6 => "active_tool_cycle_tokens",
        7 => "continuation_tokens",
        _ => "provider_framing_tokens",
    }
}

enum Dimension {
    Text(String),
    Number(u64),
    Null,
}

fn dimensions_json(dimensions: &BTreeMap<&str, Dimension>) -> String {
    let mut out = String::from("{");
    for (index, (key, value)) in dimensions.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(&escape_json_string(key));
        out.push_str("\":");
        match value {
            Dimension::Text(text) => {
                out.push('"');
                out.push_str(&escape_json_string(text));
                out.push('"');
            }
            Dimension::Number(number) => out.push_str(&number.to_string()),
            Dimension::Null => out.push_str("null"),
        }
    }
    out.push('}');
    out
}

fn escape_json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if (ch as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out
}
