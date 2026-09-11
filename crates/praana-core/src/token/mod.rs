//! Token accounting and estimation.
//!
//! Normative owner: `docs/RUST_V2_TOKEN_ACCOUNTING_SPEC.md`.

pub mod calibration;
pub mod generic;
pub mod profile;

pub use calibration::{TokenCalibrationBucket, TokenCalibrationSampleV1};
pub use generic::{GenericTokenEstimatorV1, GENERIC_ESTIMATOR_ID};
pub use profile::{TokenProfileEntryV1, TokenProfileStoreV1};

use crate::canonical_json;
use serde::{Deserialize, Serialize};

pub const TOKEN_ESTIMATOR_SCHEMA_VERSION: u32 = 1;

/// Protocol turn identifier newtype.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TurnId(pub String);

impl std::fmt::Display for TurnId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Protocol SHA-256 digest newtype.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Sha256Digest(pub String);

impl Sha256Digest {
    pub fn new(hex: String) -> Result<Self, String> {
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!(
                "invalid sha256 digest: expected 64 hex characters, got {hex}"
            ));
        }
        Ok(Self(hex.to_ascii_lowercase()))
    }

    pub fn from_bytes(bytes: &[u8]) -> Self {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        Self(format!("{:x}", hasher.finalize()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for Sha256Digest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl AsRef<str> for Sha256Digest {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl std::str::FromStr for Sha256Digest {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::new(s.to_string())
    }
}

impl serde::Serialize for Sha256Digest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> serde::Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Self::new(s).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TokenEstimateV1 {
    pub token_estimator_schema_version: u32,
    pub estimator_id: String,
    pub tokenizer_profile_id: Option<String>,
    pub input_sha256: Sha256Digest,
    pub content_tokens: u64,
    pub framing_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum TokenEstimationContext {
    ArtifactResult,
    ArtifactPreview,
    StateGraph,
    MemoryDigest,
    CompactionSourceTurn { turn_id: TurnId },
    CompactionSegment,
    HistoricalHandoff,
    ProviderRequestComponent { component: RequestComponentKind },
    BinaryTelemetry,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum RequestComponentKind {
    System,
    ToolSchema,
    MemoryBootstrap,
    Handoff,
    RetainedMessages,
    StateGraph,
    ActiveToolCycle,
    Continuation,
    ProviderFraming,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FramingProfileV1 {
    pub framing_profile_schema_version: u32,
    pub framing_profile_id: String,
    pub fixed_tokens: u64,
    pub per_item_tokens: u64,
    pub item_count: u64,
    pub additional_tokens: u64,
}

impl FramingProfileV1 {
    pub fn calculate_framing_tokens(&self) -> Result<u64, TokenAccountingError> {
        let per_items = self
            .per_item_tokens
            .checked_mul(self.item_count)
            .ok_or(TokenAccountingError::Overflow)?;
        let total = self
            .fixed_tokens
            .checked_add(per_items)
            .ok_or(TokenAccountingError::Overflow)?
            .checked_add(self.additional_tokens)
            .ok_or(TokenAccountingError::Overflow)?;
        Ok(total)
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum TokenAccountingError {
    #[error("token input is not valid UTF-8")]
    InvalidUtf8,
    #[error("tokenizer or framing profile is unknown: {0}")]
    ProfileUnknown(String),
    /// Reserved for future phases when an offline model-specific tokenizer is introduced (P2B+).
    #[error("tokenizer profile fixture failed: {0}")]
    ProfileFixtureFailed(String),
    #[error("token accounting overflow")]
    Overflow,
    #[error("persisted token input hash does not match")]
    InputHashMismatch,
    #[error("rendered component exceeds its owner bound")]
    BoundExceeded,
}

/// Validate that input bytes match their expected SHA-256 digest per Token Accounting §11 and §13.
/// Returns Ok(()) if the computed hash matches, or Err(TokenAccountingError::InputHashMismatch).
pub fn check_input_hash(input: &[u8], expected: &Sha256Digest) -> Result<(), TokenAccountingError> {
    let actual = Sha256Digest::from_bytes(input);
    if &actual != expected {
        return Err(TokenAccountingError::InputHashMismatch);
    }
    Ok(())
}

pub trait TokenEstimatorV1: Send + Sync {
    fn estimator_id(&self) -> &str;

    fn estimate(
        &self,
        context: TokenEstimationContext,
        exact_content: &[u8],
        framing: &FramingProfileV1,
    ) -> Result<TokenEstimateV1, TokenAccountingError>;
}

/// Calculate ordered RFC 8785 canonical JSON array of 9 TokenEstimateV1 request components,
/// returning (canonical_json_string, estimated_input_sha256, total_request_tokens).
pub fn calculate_request_component_manifest(
    estimates: &[TokenEstimateV1],
) -> Result<(String, Sha256Digest, u64), TokenAccountingError> {
    let json_bytes = canonical_json::to_canonical_json_bytes(&estimates)
        .map_err(|e| TokenAccountingError::ProfileUnknown(e.to_string()))?;
    let digest = Sha256Digest::from_bytes(&json_bytes);
    let mut total_tokens: u64 = 0;
    for est in estimates {
        total_tokens = total_tokens
            .checked_add(est.total_tokens)
            .ok_or(TokenAccountingError::Overflow)?;
    }
    let json_str = String::from_utf8(json_bytes).unwrap();
    Ok((json_str, digest, total_tokens))
}

/// Pure predicate for single artifact inline decision per Token Accounting §7.1:
/// A result is eligible for inline storage iff total_tokens <= artifact_inline_tokens.
pub fn is_eligible_for_inline(total_tokens: u64, inline_threshold: u64) -> bool {
    total_tokens <= inline_threshold
}

/// Calculate batch inline eligibility across multiple results in provider call order.
/// Only individually eligible results enter the checked sum; a result remains inline iff
/// the new sum <= batch_budget.
pub fn calculate_batch_inline_decisions(
    results: &[u64],
    batch_budget: u64,
    inline_threshold: u64,
) -> Result<Vec<bool>, TokenAccountingError> {
    let mut decisions = Vec::with_capacity(results.len());
    let mut running_sum: u64 = 0;
    for &total_tokens in results {
        if is_eligible_for_inline(total_tokens, inline_threshold) {
            let next_sum = running_sum
                .checked_add(total_tokens)
                .ok_or(TokenAccountingError::Overflow)?;
            if next_sum <= batch_budget {
                running_sum = next_sum;
                decisions.push(true);
            } else {
                decisions.push(false);
            }
        } else {
            decisions.push(false);
        }
    }
    Ok(decisions)
}

/// Check whether an estimate exceeds its owner bound per Token Accounting §12.
pub fn check_component_bound(
    estimate: &TokenEstimateV1,
    max_tokens: u64,
) -> Result<(), TokenAccountingError> {
    if estimate.total_tokens > max_tokens {
        Err(TokenAccountingError::BoundExceeded)
    } else {
        Ok(())
    }
}
