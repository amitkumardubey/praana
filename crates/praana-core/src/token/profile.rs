use super::{FramingProfileV1, TokenAccountingError};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TokenProfileEntryV1 {
    pub provider: String,
    pub protocol: String,
    pub model: String,
    pub model_revision: Option<String>,
    pub content_estimator_id: String,
    pub tokenizer_profile_id: Option<String>,
    pub framing_profile: FramingProfileV1,
    pub tokenizer_artifact_hashes: Vec<String>,
    pub fixture_manifest_hash: Option<String>,
}

#[derive(Clone, Debug)]
pub struct TokenProfileStoreV1 {
    entries: Vec<TokenProfileEntryV1>,
}

impl TokenProfileStoreV1 {
    pub fn load_bundled() -> Result<Self, TokenAccountingError> {
        let json_bytes = include_bytes!("../../data/token_profiles_v1.json");
        Self::from_json_bytes(json_bytes)
    }

    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self, TokenAccountingError> {
        let entries: Vec<TokenProfileEntryV1> = serde_json::from_slice(bytes)
            .map_err(|e| TokenAccountingError::ProfileUnknown(e.to_string()))?;
        Ok(Self { entries })
    }

    pub fn resolve(
        &self,
        provider: &str,
        protocol: &str,
        model: &str,
        revision: Option<&str>,
    ) -> Result<&TokenProfileEntryV1, TokenAccountingError> {
        for entry in &self.entries {
            if entry.provider == provider
                && entry.protocol == protocol
                && entry.model == model
                && entry.model_revision.as_deref() == revision
            {
                return Ok(entry);
            }
        }
        Err(TokenAccountingError::ProfileUnknown(format!(
            "{provider}/{protocol}/{model}"
        )))
    }

    pub fn resolve_conservative_generic(
        &self,
    ) -> Result<&TokenProfileEntryV1, TokenAccountingError> {
        for entry in &self.entries {
            if entry.provider == "generic" && entry.model == "generic-conservative" {
                return Ok(entry);
            }
        }
        Err(TokenAccountingError::ProfileUnknown(
            "generic-conservative".to_string(),
        ))
    }

    pub fn contains_framing_profile(&self, framing_profile_id: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.framing_profile.framing_profile_id == framing_profile_id)
    }

    pub fn contains_tokenizer_profile(&self, tokenizer_profile_id: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.tokenizer_profile_id.as_deref() == Some(tokenizer_profile_id))
    }
}
