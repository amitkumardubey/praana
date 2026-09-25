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
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};

pub use crate::protocol::id::{Sha256Digest, TurnId};

pub const TOKEN_ESTIMATOR_SCHEMA_VERSION: u32 = 1;

/// Fixture-pinned image occupancy. Unsupported profiles do not carry a value.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ImageTokenOccupancyV1 {
    FixedPerImage {
        #[serde(deserialize_with = "deserialize_positive_tokens_per_image")]
        tokens_per_image: u64,
    },
}

fn deserialize_positive_tokens_per_image<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let tokens_per_image = u64::deserialize(deserializer)?;
    if tokens_per_image == 0 {
        return Err(de::Error::custom(
            TokenAccountingError::ProfileFixtureFailed(
                "tokens_per_image must be positive".to_owned(),
            )
            .to_string(),
        ));
    }
    Ok(tokens_per_image)
}

impl ImageTokenOccupancyV1 {
    pub fn fixed_per_image(tokens_per_image: u64) -> Result<Self, TokenAccountingError> {
        if tokens_per_image == 0 {
            return Err(TokenAccountingError::ProfileFixtureFailed(
                "tokens_per_image must be positive".to_owned(),
            ));
        }
        Ok(Self::FixedPerImage { tokens_per_image })
    }

    /// Checked image contribution for `FramingProfileV1.additional_tokens`.
    pub fn tokens_per_image(&self) -> u64 {
        match self {
            Self::FixedPerImage { tokens_per_image } => *tokens_per_image,
        }
    }

    pub fn image_contribution(&self, image_count: u64) -> Result<u64, TokenAccountingError> {
        self.tokens_per_image()
            .checked_mul(image_count)
            .ok_or(TokenAccountingError::Overflow)
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
    let actual = Sha256Digest::digest_bytes(input);
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
    let digest = Sha256Digest::digest_bytes(&json_bytes);
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
