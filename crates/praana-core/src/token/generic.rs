use super::{
    FramingProfileV1, RequestComponentKind, Sha256Digest, TokenAccountingError, TokenEstimateV1,
    TokenEstimationContext, TokenEstimatorV1,
};
use crate::unicode::scalar_token_units_v15_1;

pub const GENERIC_ESTIMATOR_ID: &str = "praana-generic-unicode-15.1-v1";

pub struct GenericTokenEstimatorV1;

impl TokenEstimatorV1 for GenericTokenEstimatorV1 {
    fn estimator_id(&self) -> &str {
        GENERIC_ESTIMATOR_ID
    }

    fn estimate(
        &self,
        context: TokenEstimationContext,
        exact_content: &[u8],
        framing: &FramingProfileV1,
    ) -> Result<TokenEstimateV1, TokenAccountingError> {
        let content_tokens = match context {
            TokenEstimationContext::BinaryTelemetry => {
                // Section 4.4: ceil(byte_count / 3)
                let bytes_len = exact_content.len() as u64;
                if bytes_len == 0 {
                    0
                } else {
                    bytes_len
                        .checked_add(2)
                        .ok_or(TokenAccountingError::Overflow)?
                        / 3
                }
            }
            TokenEstimationContext::ProviderRequestComponent {
                component: RequestComponentKind::ProviderFraming,
            } => {
                // Section 7.3: provider_framing has zero content tokens
                0
            }
            _ => {
                let text = std::str::from_utf8(exact_content)
                    .map_err(|_| TokenAccountingError::InvalidUtf8)?;
                let mut total_units: u64 = 0;
                for c in text.chars() {
                    let (units, _) = scalar_token_units_v15_1(c);
                    total_units = total_units
                        .checked_add(units as u64)
                        .ok_or(TokenAccountingError::Overflow)?;
                }
                if total_units == 0 {
                    0
                } else {
                    total_units
                        .checked_add(11)
                        .ok_or(TokenAccountingError::Overflow)?
                        / 12
                }
            }
        };

        let framing_tokens = framing.calculate_framing_tokens()?;
        let total_tokens = content_tokens
            .checked_add(framing_tokens)
            .ok_or(TokenAccountingError::Overflow)?;

        let input_sha256 = Sha256Digest::digest_bytes(exact_content);

        Ok(TokenEstimateV1 {
            token_estimator_schema_version: 1,
            estimator_id: GENERIC_ESTIMATOR_ID.to_string(),
            tokenizer_profile_id: None,
            input_sha256,
            content_tokens,
            framing_tokens,
            total_tokens,
        })
    }
}
