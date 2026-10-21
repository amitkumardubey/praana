//! Non-authoritative admission telemetry (Compaction §16, §14.3).
//!
//! Telemetry stores IDs and numeric dimensions only: never generated
//! statement text, never artifact content, never a credential. No behavior
//! depends on a telemetry write succeeding (History §10.2), so a write
//! failure is counted and otherwise ignored.
//!
//! The protocol has no telemetry event type and protocol events are a
//! versioned spec surface, so these records never become durable events. They
//! land in the derived `telemetry_samples` table, which may be lost without
//! semantic effect.

use std::collections::BTreeMap;

use crate::history::artifact::ArtifactStore;

/// A recognized provider context-length error and the admitted estimate of
/// the request that produced it.
#[derive(Clone, Debug)]
pub struct ContextUnderestimation {
    pub provider: String,
    pub protocol: String,
    pub model: String,
    pub model_revision: Option<String>,
    pub estimator_id: String,
    pub request_hash: String,
    /// The provider error code, for example `E_PROVIDER_CONTEXT_LENGTH`.
    pub error_code: String,
    /// `W`: the resolved provider/model context window in tokens.
    pub context_window_tokens: u64,
    /// `I`: the estimated model input occupancy for the exact request.
    pub estimated_input_tokens: u64,
    /// The admitted component estimates, in the `AdmissionEstimate` order.
    pub component_tokens: [u64; 9],
}

/// `max(1, W - I + 1)`: the underestimation figure Compaction §14.3 step 2
/// records as telemetry. It is never a calibration sample.
pub fn underestimation_figure(context_window_tokens: u64, estimated_input_tokens: u64) -> u64 {
    context_window_tokens
        .saturating_sub(estimated_input_tokens)
        .saturating_add(1)
        .max(1)
}

/// Telemetry name for the §14.3 underestimation record.
pub const ADMISSION_CONTEXT_UNDERESTIMATION: &str = "admission_context_underestimation";

/// Telemetry name for one admission recovery step.
pub const ADMISSION_RECOVERY_STEP: &str = "admission_recovery_step";

/// Telemetry name for one reserve reduction.
pub const ADMISSION_RESERVE_REDUCTION: &str = "admission_reserve_reduction";

/// Records the §14.3 underestimation figure and the estimated components of
/// the rejected request. The figure is telemetry only: it never becomes a
/// `TokenCalibrationSampleV1` and never enters the calibration bucket.
pub fn record_context_underestimation(
    store: &ArtifactStore,
    record: &ContextUnderestimation,
    occurred_at_ms: i64,
) -> bool {
    let figure =
        underestimation_figure(record.context_window_tokens, record.estimated_input_tokens);
    let mut dimensions: BTreeMap<&str, String> = BTreeMap::new();
    dimensions.insert("provider", record.provider.clone());
    dimensions.insert("protocol", record.protocol.clone());
    dimensions.insert("model", record.model.clone());
    dimensions.insert(
        "model_revision",
        record.model_revision.clone().unwrap_or_default(),
    );
    dimensions.insert("estimator_id", record.estimator_id.clone());
    dimensions.insert("request_hash", record.request_hash.clone());
    dimensions.insert("error_code", record.error_code.clone());
    dimensions.insert(
        "context_window_tokens",
        record.context_window_tokens.to_string(),
    );
    dimensions.insert(
        "estimated_input_tokens",
        record.estimated_input_tokens.to_string(),
    );
    for (index, tokens) in record.component_tokens.iter().enumerate() {
        dimensions.insert(component_dimension(index), tokens.to_string());
    }
    let json = dimensions_json(&dimensions);
    store
        .record_telemetry_sample(
            ADMISSION_CONTEXT_UNDERESTIMATION,
            None,
            figure as i64,
            &json,
            occurred_at_ms,
        )
        .is_ok()
}

/// The `AdmissionEstimate` component order is the `RequestComponentKind`
/// order: system, tool schema, memory bootstrap, handoff, retained messages,
/// state graph, active tool cycle, continuation, provider framing.
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

/// RFC 8785-style object with sorted keys and no insignificant whitespace.
fn dimensions_json(dimensions: &BTreeMap<&str, String>) -> String {
    let mut out = String::from("{");
    for (index, (key, value)) in dimensions.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(&escape_json_string(key));
        out.push_str("\":\"");
        out.push_str(&escape_json_string(value));
        out.push('"');
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
