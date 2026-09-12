//! Common model selection, usage, and admission DTOs.

use serde::{de, Deserialize, Deserializer, Serialize};

use crate::protocol::constants::MAX_MODEL_LABEL_BYTES;
use crate::protocol::errors::HistoryError;
use crate::protocol::id::{AttemptId, Sha256Digest};
use crate::protocol::json::deserialize_bounded_u64;

pub fn validate_model_label(value: &str) -> Result<(), HistoryError> {
    if value.is_empty() || value.len() > MAX_MODEL_LABEL_BYTES {
        return Err(HistoryError::new(
            "E_EVENT_SCHEMA_INVALID",
            None,
            None,
            false,
        ));
    }
    Ok(())
}

pub(crate) fn deserialize_model_label<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    validate_model_label(&value).map_err(de::Error::custom)?;
    Ok(value)
}

pub(crate) fn deserialize_optional_model_label<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    if let Some(label) = &value {
        validate_model_label(label).map_err(de::Error::custom)?;
    }
    Ok(value)
}

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
    #[serde(deserialize_with = "deserialize_model_label")]
    pub provider: String,
    #[serde(deserialize_with = "deserialize_model_label")]
    pub protocol: String,
    #[serde(deserialize_with = "deserialize_model_label")]
    pub model: String,
    #[serde(deserialize_with = "deserialize_optional_model_label")]
    pub model_revision: Option<String>,
    #[serde(deserialize_with = "deserialize_model_label")]
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
