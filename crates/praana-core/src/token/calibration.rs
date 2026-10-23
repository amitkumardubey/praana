use super::{Sha256Digest, TokenAccountingError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

    /// The comparable samples, oldest first. Read-only diagnostic surface.
    pub fn samples(&self) -> &[TokenCalibrationSampleV1] {
        &self.samples
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

/// Token Accounting §9: one bucket per exact provider, protocol, model
/// revision, and estimator ID. A model switch or fallback must not mix
/// samples, and a changed estimator identity starts a new bucket without
/// deleting the old one.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CalibrationBucketKey {
    pub provider: String,
    pub protocol: String,
    pub model_revision: Option<String>,
    pub estimator_id: String,
}

impl CalibrationBucketKey {
    pub fn new(
        provider: impl Into<String>,
        protocol: impl Into<String>,
        model_revision: Option<String>,
        estimator_id: impl Into<String>,
    ) -> Self {
        Self {
            provider: provider.into(),
            protocol: protocol.into(),
            model_revision,
            estimator_id: estimator_id.into(),
        }
    }
}

impl TokenCalibrationSampleV1 {
    /// The bucket this sample belongs to.
    pub fn bucket_key(&self) -> CalibrationBucketKey {
        CalibrationBucketKey::new(
            self.provider.clone(),
            self.protocol.clone(),
            self.model_revision.clone(),
            self.estimator_id.clone(),
        )
    }
}

/// The keyed set of calibration buckets. `C` is read from the bucket that
/// matches the request's exact identity; a request whose identity has no
/// bucket yet gets `C = 0`.
#[derive(Clone, Debug)]
pub struct TokenCalibrationBuckets {
    max_samples: usize,
    buckets: BTreeMap<CalibrationBucketKey, TokenCalibrationBucket>,
}

impl TokenCalibrationBuckets {
    pub fn new(max_samples: usize) -> Self {
        Self {
            max_samples: if max_samples == 0 { 128 } else { max_samples },
            buckets: BTreeMap::new(),
        }
    }

    /// Routes one sample to its bucket. The sample's own identity selects the
    /// bucket, so a changed estimator identity or model revision never mixes
    /// with the previous bucket.
    pub fn add_sample(&mut self, sample: TokenCalibrationSampleV1) {
        let key = sample.bucket_key();
        self.buckets
            .entry(key)
            .or_insert_with(|| TokenCalibrationBucket::new(self.max_samples))
            .add_sample(sample);
    }

    pub fn bucket(&self, key: &CalibrationBucketKey) -> Option<&TokenCalibrationBucket> {
        self.buckets.get(key)
    }

    pub fn keys(&self) -> impl Iterator<Item = &CalibrationBucketKey> {
        self.buckets.keys()
    }

    /// Comparable sample count for one exact identity.
    pub fn sample_count(&self, key: &CalibrationBucketKey) -> usize {
        self.buckets.get(key).map_or(0, TokenCalibrationBucket::len)
    }

    /// Comparable samples for one exact identity, oldest first.
    pub fn samples(&self, key: &CalibrationBucketKey) -> Option<&[TokenCalibrationSampleV1]> {
        self.buckets.get(key).map(TokenCalibrationBucket::samples)
    }

    /// Excluded (non-comparable) sample count for one exact identity.
    pub fn excluded_sample_count(&self, key: &CalibrationBucketKey) -> usize {
        self.buckets
            .get(key)
            .map_or(0, TokenCalibrationBucket::excluded_samples_count)
    }

    /// `C` for one exact identity: 0 below 20 comparable samples, then the
    /// nearest-rank p95 of positive error plus 128.
    pub fn margin_c(&self, key: &CalibrationBucketKey) -> u64 {
        self.buckets
            .get(key)
            .and_then(|bucket| bucket.calculate_calibration_margin_c().ok())
            .unwrap_or(0)
    }
}

/// Rebuilds the calibration buckets from the durable event log.
///
/// A comparable sample needs the admitted estimate of the attempt that
/// produced the accepted step (`AdmissionSnapshot.estimated_input_tokens`),
/// the accepted step's provider-reported usage, and the attempt's exact
/// identity. The same exclusions as live recording apply: an emergency
/// context retry is never a sample, placeholder zero usage is excluded, and a
/// changed estimator identity starts a new bucket instead of mixing.
pub fn rebuild_buckets_from_events(
    events: &[crate::protocol::events::EventEnvelope],
) -> TokenCalibrationBuckets {
    use crate::protocol::events::{CanonicalEvent, ProviderAttemptPurpose};
    let mut buckets = TokenCalibrationBuckets::new(128);
    // Attempt id -> the admission identity recorded at the durable start.
    let mut starts: BTreeMap<String, crate::protocol::events::AssistantAttemptStarted> =
        BTreeMap::new();
    // Attempt id -> the compaction epoch in effect when it was accepted.
    let mut epoch_at: BTreeMap<String, u32> = BTreeMap::new();
    let mut epoch: u32 = 0;
    for event in events {
        match &event.event {
            CanonicalEvent::HistoryCompacted(compacted) => {
                epoch = compacted.epoch;
            }
            CanonicalEvent::AssistantAttemptStarted(started) => {
                if matches!(started.purpose, ProviderAttemptPurpose::AssistantStep(_)) {
                    if let Some(attempt_id) = event.attempt_id {
                        starts.insert(attempt_id.to_string(), started.clone());
                        epoch_at.insert(attempt_id.to_string(), epoch);
                    }
                }
            }
            CanonicalEvent::AssistantStepAccepted(accepted) => {
                let Some(attempt_id) = event.attempt_id else {
                    continue;
                };
                let key = attempt_id.to_string();
                let Some(started) = starts.get(&key) else {
                    continue;
                };
                // An emergency context retry attempt is never a sample.
                if started.emergency_context_retry {
                    continue;
                }
                let reported = accepted.message.usage.input_tokens;
                let estimated = started.admission.estimated_input_tokens;
                let Ok(sample) = TokenCalibrationSampleV1::new(
                    started.model.provider.clone(),
                    started.model.protocol.clone(),
                    started.model.model.clone(),
                    started.model.model_revision.clone(),
                    started.admission.estimator_id.clone(),
                    started.request_hash.clone(),
                    estimated,
                    reported,
                    Some(accepted.message.usage.cache_read_tokens),
                    epoch_at.get(&key).copied().unwrap_or(epoch),
                    event.timestamp_ms,
                ) else {
                    continue;
                };
                buckets.add_sample(sample);
            }
            _ => {}
        }
    }
    buckets
}
