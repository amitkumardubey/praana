//! Bundled model profiles and capability resolution for provider P2A.

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fmt;

use crate::canonical_json::to_canonical_json_bytes;
use crate::config::normalize_provider_url;
use crate::protocol::id::Sha256Digest;
use crate::protocol::models::ReasoningEffort;
use crate::token::{ImageTokenOccupancyV1, TokenProfileStoreV1};
use crate::ui_contract::json_data::{ModelId, ProviderId};

use super::registry::{protocol_supported, provider_descriptor, ProviderProtocol};

pub const MODEL_PROFILE_SCHEMA_VERSION: u32 = 1;
pub const MODELS_DEV_P2A_SNAPSHOT_PATH: &str =
    "crates/praana-core/data/evidence/models_dev_p2a_gpt-5.6-sol_2026-09-24.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelProfileManifestV1 {
    pub schema_version: u32,
    pub generated_at_ms: i64,
    pub source_urls: Vec<String>,
    pub profiles: Vec<ModelProfileRowV1>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelProfileRowV1 {
    pub provider: ProviderId,
    pub protocol: ProviderProtocol,
    pub model_id: ModelId,
    pub model_revision: Option<String>,
    pub display_name: String,
    pub context_window_tokens: u64,
    pub min_output_tokens: u64,
    pub max_output_tokens: u64,
    pub reasoning_efforts: Vec<ReasoningEffort>,
    pub parallel_tools: bool,
    pub strict_json_schema: bool,
    pub tokenizer_profile_id: Option<String>,
    pub framing_profile_id: String,
    pub temperature_with_reasoning: bool,
    pub image_input: ImageInputCapability,
    pub reasoning_accounting: ReasoningAccounting,
    pub reasoning_context: ReasoningContextCapability,
    pub self_compaction: SelfCompactionCapability,
    pub continuation_after_internal_request: bool,
    pub evidence: Vec<ProfileEvidenceV1>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProfileEvidenceV1 {
    pub url: String,
    pub accessed_on: String,
    pub field: String,
    pub value_sha256: Sha256Digest,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningContextCapability {
    Unsupported,
    CurrentTurn,
    AllTurns,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ReasoningAccounting {
    IncludedInOutputLimit,
    SeparateWindow { default_reserve_tokens: u64 },
    Unknown { conservative_reserve_tokens: u64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum TokenizerCapability {
    Exact { tokenizer_id: String },
    AdapterEstimate { estimator_id: String },
    ConservativeGeneric { estimator_id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ImageInputCapability {
    Unsupported,
    Supported { occupancy: ImageTokenOccupancyV1 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum SelfCompactionCapability {
    Validated {
        evaluator_id: String,
        corpus_version: String,
        prompt_version: String,
        result_manifest_sha256: Sha256Digest,
    },
    Unvalidated,
    Prohibited,
}

/// Exact capability profile consumed by admission and later compaction code.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelCapabilityProfile {
    pub profile_version: String,
    pub profile_source_sha256: Sha256Digest,
    pub catalog_cache_sha256: Option<Sha256Digest>,
    pub provider: String,
    pub protocol: String,
    pub model_pattern: String,
    pub model_revision: Option<String>,
    pub context_window_tokens: u64,
    pub max_output_tokens: u64,
    pub min_output_tokens: u64,
    pub reasoning_accounting: ReasoningAccounting,
    pub reasoning_context: ReasoningContextCapability,
    pub tokenizer: TokenizerCapability,
    pub framing_profile_id: String,
    pub reasoning_efforts: Vec<ReasoningEffort>,
    pub parallel_tools: bool,
    pub strict_json_schema: bool,
    pub temperature_with_reasoning: bool,
    pub image_input: ImageInputCapability,
    pub endpoint_fingerprint: Sha256Digest,
    pub self_compaction: SelfCompactionCapability,
    pub continuation_after_internal_request: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProfileError {
    Parse(String),
    NonCanonical,
    Invalid(String),
    DuplicateKey(String),
    UnknownModel { provider: String, model: String },
    UnsupportedProtocol { provider: String, protocol: String },
}

impl fmt::Display for ProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Parse(detail) => write!(f, "MODEL_PROFILE_PARSE: {detail}"),
            Self::NonCanonical => f.write_str("MODEL_PROFILE_NOT_CANONICAL"),
            Self::Invalid(detail) => write!(f, "MODEL_PROFILE_INVALID: {detail}"),
            Self::DuplicateKey(key) => write!(f, "MODEL_PROFILE_DUPLICATE_KEY: {key}"),
            Self::UnknownModel { provider, model } => {
                write!(f, "MODEL_PROFILE_UNKNOWN: {provider}/{model}")
            }
            Self::UnsupportedProtocol { provider, protocol } => {
                write!(f, "MODEL_PROTOCOL_UNSUPPORTED: {provider}/{protocol}")
            }
        }
    }
}

impl std::error::Error for ProfileError {}

struct StrictValue;

impl<'de> DeserializeSeed<'de> for StrictValue {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(StrictVisitor)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(Value::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(StrictValue)? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut map_access: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut object = Map::new();
        while let Some(key) = map_access.next_key::<String>()? {
            if object.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate key: {key}")));
            }
            let value = map_access.next_value_seed(StrictValue)?;
            object.insert(key, value);
        }
        Ok(Value::Object(object))
    }
}

pub(crate) fn parse_strict_json(bytes: &[u8]) -> Result<Value, ProfileError> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = StrictValue
        .deserialize(&mut deserializer)
        .map_err(|error| ProfileError::Parse(error.to_string()))?;
    deserializer
        .end()
        .map_err(|error| ProfileError::Parse(error.to_string()))?;
    Ok(value)
}

impl ModelProfileManifestV1 {
    pub fn validate(&self) -> Result<(), ProfileError> {
        if self.schema_version != MODEL_PROFILE_SCHEMA_VERSION {
            return Err(ProfileError::Invalid(format!(
                "schema_version must be {MODEL_PROFILE_SCHEMA_VERSION}"
            )));
        }
        if self.generated_at_ms <= 0 {
            return Err(ProfileError::Invalid(
                "generated_at_ms must be positive".to_owned(),
            ));
        }
        if self.source_urls.is_empty()
            || self
                .source_urls
                .iter()
                .any(|url| !url.starts_with("https://"))
        {
            return Err(ProfileError::Invalid(
                "source_urls must contain absolute HTTPS URLs".to_owned(),
            ));
        }

        let token_profiles = TokenProfileStoreV1::load_bundled()
            .map_err(|error| ProfileError::Invalid(format!("token profile store: {error:?}")))?;
        let mut keys = BTreeSet::new();
        let mut previous_key: Option<String> = None;
        for row in &self.profiles {
            if provider_descriptor(row.provider.as_str()).is_none() {
                return Err(ProfileError::Invalid(format!(
                    "provider is not in the closed registry: {}",
                    row.provider
                )));
            }
            if !protocol_supported(row.provider.as_str(), &row.protocol) {
                return Err(ProfileError::Invalid(format!(
                    "protocol is not supported by provider: {}/{}",
                    row.provider,
                    row.protocol.config_name()
                )));
            }
            let key = format!(
                "{}/{}/{}/{}",
                row.provider.as_str(),
                row.protocol.config_name(),
                row.model_id.as_str(),
                row.model_revision.as_deref().unwrap_or("")
            );
            if !keys.insert(key.clone()) {
                return Err(ProfileError::DuplicateKey(key));
            }
            if previous_key
                .as_ref()
                .is_some_and(|previous| previous > &key)
            {
                return Err(ProfileError::Invalid(
                    "profiles must be sorted by provider, protocol, model, revision".to_owned(),
                ));
            }
            previous_key = Some(key.clone());
            if row.context_window_tokens == 0
                || row.min_output_tokens == 0
                || row.max_output_tokens == 0
                || row.min_output_tokens > row.max_output_tokens
                || row.max_output_tokens >= row.context_window_tokens
            {
                return Err(ProfileError::Invalid(format!(
                    "invalid numeric bounds for {key}"
                )));
            }
            match row.reasoning_accounting {
                ReasoningAccounting::SeparateWindow {
                    default_reserve_tokens,
                }
                | ReasoningAccounting::Unknown {
                    conservative_reserve_tokens: default_reserve_tokens,
                } if default_reserve_tokens == 0 => {
                    return Err(ProfileError::Invalid(format!(
                        "reasoning reserve must be positive for {key}"
                    )))
                }
                _ => {}
            }
            if matches!(
                row.self_compaction,
                SelfCompactionCapability::Validated { .. }
            ) && !row.strict_json_schema
            {
                return Err(ProfileError::Invalid(format!(
                    "validated self-compaction requires strict JSON schema for {key}"
                )));
            }
            if let ImageInputCapability::Supported { occupancy } = &row.image_input {
                if occupancy.tokens_per_image() == 0 {
                    return Err(ProfileError::Invalid(format!(
                        "image occupancy must be positive for {key}"
                    )));
                }
            }
            if row.display_name.is_empty() || row.framing_profile_id.is_empty() {
                return Err(ProfileError::Invalid(format!(
                    "empty profile field for {key}"
                )));
            }
            if !token_profiles.contains_framing_profile(&row.framing_profile_id) {
                return Err(ProfileError::Invalid(format!(
                    "unknown framing profile for {key}: {}",
                    row.framing_profile_id
                )));
            }
            if let Some(tokenizer_profile_id) = &row.tokenizer_profile_id {
                if !token_profiles.contains_tokenizer_profile(tokenizer_profile_id) {
                    return Err(ProfileError::Invalid(format!(
                        "unknown tokenizer profile for {key}: {tokenizer_profile_id}"
                    )));
                }
            }
            for effort in &row.reasoning_efforts {
                if row
                    .reasoning_efforts
                    .iter()
                    .filter(|candidate| *candidate == effort)
                    .count()
                    > 1
                {
                    return Err(ProfileError::Invalid(format!(
                        "duplicate reasoning effort for {key}"
                    )));
                }
            }
            for evidence in &row.evidence {
                if evidence.url.is_empty()
                    || evidence.accessed_on.is_empty()
                    || evidence.field.is_empty()
                {
                    return Err(ProfileError::Invalid(format!(
                        "incomplete evidence for {key}"
                    )));
                }
                if evidence.url == MODELS_DEV_P2A_SNAPSHOT_PATH {
                    let actual = Sha256Digest::from_bytes(
                        Sha256::digest(include_bytes!(
                            "../../data/evidence/models_dev_p2a_gpt-5.6-sol_2026-09-24.json"
                        ))
                        .into(),
                    );
                    if evidence.value_sha256 != actual {
                        return Err(ProfileError::Invalid(format!(
                            "evidence hash mismatch for {key}"
                        )));
                    }
                }
            }
        }
        Ok(())
    }
}

pub fn parse_manifest(bytes: &[u8]) -> Result<ModelProfileManifestV1, ProfileError> {
    let value = parse_strict_json(bytes)?;
    let manifest: ModelProfileManifestV1 = serde_json::from_value(value.clone())
        .map_err(|error| ProfileError::Parse(error.to_string()))?;
    manifest.validate()?;
    let canonical = to_canonical_json_bytes(&manifest)
        .map_err(|error| ProfileError::Parse(error.to_string()))?;
    let source = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    if source != canonical.as_slice() {
        return Err(ProfileError::NonCanonical);
    }
    Ok(manifest)
}

pub fn bundled_manifest() -> Result<ModelProfileManifestV1, ProfileError> {
    parse_manifest(include_bytes!("../../data/model_profiles_v1.json"))
}

pub fn bundled_manifest_sha256() -> Result<Sha256Digest, ProfileError> {
    let bytes = include_bytes!("../../data/model_profiles_v1.json");
    Ok(Sha256Digest::from_bytes(Sha256::digest(bytes).into()))
}

pub fn profile_hash(profile: &ModelCapabilityProfile) -> Result<Sha256Digest, ProfileError> {
    let bytes =
        to_canonical_json_bytes(profile).map_err(|error| ProfileError::Parse(error.to_string()))?;
    Ok(Sha256Digest::from_bytes(Sha256::digest(bytes).into()))
}

fn row_protocol_matches(row: &ModelProfileRowV1, protocol: &ProviderProtocol) -> bool {
    &row.protocol == protocol
}

pub fn resolve_bundled_profile(
    provider: &str,
    protocol: &ProviderProtocol,
    model: &str,
    catalog_cache_sha256: Option<Sha256Digest>,
) -> Result<ModelCapabilityProfile, ProfileError> {
    let manifest = bundled_manifest()?;
    resolve_profile_from_manifest(&manifest, provider, protocol, model, catalog_cache_sha256)
}

pub fn resolve_profile_from_manifest(
    manifest: &ModelProfileManifestV1,
    provider: &str,
    protocol: &ProviderProtocol,
    model: &str,
    catalog_cache_sha256: Option<Sha256Digest>,
) -> Result<ModelCapabilityProfile, ProfileError> {
    manifest.validate()?;
    let row = manifest
        .profiles
        .iter()
        .find(|row| {
            row.provider.as_str() == provider
                && row.model_id.as_str() == model
                && row_protocol_matches(row, protocol)
        })
        .ok_or_else(|| {
            if manifest
                .profiles
                .iter()
                .any(|row| row.provider.as_str() == provider && row.model_id.as_str() == model)
            {
                ProfileError::UnsupportedProtocol {
                    provider: provider.to_owned(),
                    protocol: protocol.config_name().to_owned(),
                }
            } else {
                ProfileError::UnknownModel {
                    provider: provider.to_owned(),
                    model: model.to_owned(),
                }
            }
        })?;

    let source_bytes = to_canonical_json_bytes(manifest)
        .map_err(|error| ProfileError::Parse(error.to_string()))?;
    let source_hash = Sha256Digest::from_bytes(Sha256::digest(source_bytes).into());
    Ok(ModelCapabilityProfile {
        profile_version: "model-profile-v1".to_owned(),
        profile_source_sha256: source_hash,
        catalog_cache_sha256,
        provider: row.provider.as_str().to_owned(),
        protocol: row.protocol.config_name().to_owned(),
        model_pattern: row.model_id.as_str().to_owned(),
        model_revision: row.model_revision.clone(),
        context_window_tokens: row.context_window_tokens,
        max_output_tokens: row.max_output_tokens,
        min_output_tokens: row.min_output_tokens,
        reasoning_accounting: row.reasoning_accounting.clone(),
        reasoning_context: row.reasoning_context.clone(),
        tokenizer: match &row.tokenizer_profile_id {
            Some(tokenizer_profile_id) => TokenizerCapability::Exact {
                tokenizer_id: tokenizer_profile_id.clone(),
            },
            None => TokenizerCapability::ConservativeGeneric {
                estimator_id: crate::token::GENERIC_ESTIMATOR_ID.to_owned(),
            },
        },
        framing_profile_id: row.framing_profile_id.clone(),
        reasoning_efforts: row.reasoning_efforts.clone(),
        parallel_tools: row.parallel_tools,
        strict_json_schema: row.strict_json_schema,
        temperature_with_reasoning: row.temperature_with_reasoning,
        image_input: row.image_input.clone(),
        endpoint_fingerprint: official_endpoint_fingerprint(provider)?,
        self_compaction: row.self_compaction.clone(),
        continuation_after_internal_request: row.continuation_after_internal_request,
    })
}

fn official_endpoint_fingerprint(provider: &str) -> Result<Sha256Digest, ProfileError> {
    let descriptor = provider_descriptor(provider).ok_or_else(|| {
        ProfileError::Invalid(format!(
            "provider is not in the closed registry: {provider}"
        ))
    })?;
    let normalized = normalize_provider_url(&descriptor.default_base_url, "provider endpoint")
        .map_err(|error| ProfileError::Invalid(error.to_string()))?;
    Ok(Sha256Digest::digest_bytes(normalized.as_bytes()))
}

pub fn model_id(profile: &ModelCapabilityProfile) -> Result<ModelId, String> {
    ModelId::from_canonical_str(&profile.model_pattern)
}

pub fn provider_id(profile: &ModelCapabilityProfile) -> Result<ProviderId, String> {
    ProviderId::from_canonical_str(&profile.provider)
}
