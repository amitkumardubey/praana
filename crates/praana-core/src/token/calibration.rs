use super::{Sha256Digest, TokenAccountingError};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TokenCalibrationSampleV1 {
    pub token_calibration_schema_version: u32,
    pub provider: String,
    pub protocol: String,
    pub model: String,
    pub model_revision: Option<String>,
    pub estimator_id: String,
    pub request_hash: Sha256Digest,
    pub estimated_input_tokens: u64,
    pub reported_input_tokens: u64,
    pub signed_error_tokens: i64,
    pub positive_error_tokens: u64,
    pub cached_input_tokens: Option<u64>,
    pub compaction_epoch: u32,
    pub timestamp_ms: i64,
}

impl TokenCalibrationSampleV1 {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        provider: String,
        protocol: String,
        model: String,
        model_revision: Option<String>,
        estimator_id: String,
        request_hash: Sha256Digest,
        estimated_input_tokens: u64,
        reported_input_tokens: u64,
        cached_input_tokens: Option<u64>,
        compaction_epoch: u32,
        timestamp_ms: i64,
    ) -> Result<Self, TokenAccountingError> {
        let reported_signed =
            i64::try_from(reported_input_tokens).map_err(|_| TokenAccountingError::Overflow)?;
        let estimated_signed =
            i64::try_from(estimated_input_tokens).map_err(|_| TokenAccountingError::Overflow)?;
        let signed_error_tokens = reported_signed
            .checked_sub(estimated_signed)
            .ok_or(TokenAccountingError::Overflow)?;
        let positive_error_tokens = if signed_error_tokens > 0 {
            u64::try_from(signed_error_tokens).map_err(|_| TokenAccountingError::Overflow)?
        } else {
            0
        };

        Ok(Self {
            token_calibration_schema_version: 1,
            provider,
            protocol,
            model,
            model_revision,
            estimator_id,
            request_hash,
            estimated_input_tokens,
            reported_input_tokens,
            signed_error_tokens,
            positive_error_tokens,
            cached_input_tokens,
            compaction_epoch,
            timestamp_ms,
        })
    }
}

#[derive(Clone, Debug)]
pub struct TokenCalibrationBucket {
    max_samples: usize,
    samples: Vec<TokenCalibrationSampleV1>,
    excluded_samples_count: usize,
}

impl TokenCalibrationBucket {
    pub fn new(max_samples: usize) -> Self {
        Self {
            max_samples: if max_samples == 0 { 128 } else { max_samples },
            samples: Vec::new(),
            excluded_samples_count: 0,
        }
    }

    pub fn add_sample(&mut self, sample: TokenCalibrationSampleV1) {
        // Exclude placeholder zero reported usage, count as telemetry
        if sample.reported_input_tokens == 0 {
            self.excluded_samples_count = self.excluded_samples_count.saturating_add(1);
            return;
        }

        if self.samples.len() >= self.max_samples {
            self.samples.remove(0);
        }
        self.samples.push(sample);
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    pub fn excluded_samples_count(&self) -> usize {
        self.excluded_samples_count
    }

    pub fn calculate_calibration_margin_c(&self) -> Result<u64, TokenAccountingError> {
        if self.samples.len() < 20 {
            return Ok(0);
        }

        let mut errors: Vec<u64> = self
            .samples
            .iter()
            .map(|s| s.positive_error_tokens)
            .collect();
        errors.sort_unstable();

        let n = errors.len();
        // Nearest-rank p95 using exact integer ceiling: ceil(0.95 * n) = (95 * n).div_ceil(100)
        let rank = (95 * n).div_ceil(100);
        let rank_clamped = rank.max(1).min(n);
        let idx = rank_clamped - 1;
        let p95 = errors[idx];

        p95.checked_add(128).ok_or(TokenAccountingError::Overflow)
    }
}
