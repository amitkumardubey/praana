//! Common model selection, usage, and admission DTOs.

use serde::{Deserialize, Serialize};

use crate::protocol::id::{AttemptId, Sha256Digest};
use crate::protocol::json::deserialize_bounded_u64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum HistoryMode {
    Append,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ReasoningEffort {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSelection {
    pub provider: String,
    pub protocol: String,
    pub model: String,
    pub model_revision: Option<String>,
    pub model_family: String,
    pub endpoint_fingerprint: Sha256Digest,
    pub reasoning_effort: ReasoningEffort,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ProviderUsage {
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub input_tokens: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub output_tokens: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub reasoning_tokens: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub total_tokens: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub cache_read_tokens: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub cache_write_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionSnapshot {
    pub token_estimator_schema_version: u32,
    pub estimator_id: String,
    pub estimated_input_sha256: Sha256Digest,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub context_window_tokens: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub estimated_input_tokens: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub resolved_output_tokens: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub requested_reasoning_tokens: u64,
    #[serde(deserialize_with = "deserialize_bounded_u64")]
    pub safety_margin_tokens: u64,
    pub projected_fill_millionths: u32,
    pub capability_profile_hash: Sha256Digest,
    pub estimate_reused_from_attempt_id: Option<AttemptId>,
}
