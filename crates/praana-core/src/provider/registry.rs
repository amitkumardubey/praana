//! Closed provider registry for Rust v2 packet P2A.
//!
//! The registry is deliberately data, not a plugin mechanism. Provider IDs,
//! protocols, endpoints, and credential environment names are all fixed in
//! schema version 1; later provider families require a new registry schema.

use serde::{Deserialize, Serialize};

use crate::ui_contract::json_data::ProviderId;

pub const PROVIDER_REGISTRY_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProviderProtocol {
    #[serde(rename = "openai-chat-v1")]
    Chat,
    #[serde(rename = "openai-responses-v1")]
    Responses,
}

impl ProviderProtocol {
    pub fn config_name(&self) -> &'static str {
        match self {
            Self::Chat => "openai-chat-v1",
            Self::Responses => "openai-responses-v1",
        }
    }

    pub fn ui_name(&self) -> &'static str {
        match self {
            Self::Chat => "openai_chat_completions",
            Self::Responses => "openai_responses",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethodKindDto {
    ApiKey,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderDescriptorV1 {
    pub provider: ProviderId,
    pub display_name: String,
    pub protocols: Vec<ProviderProtocol>,
    pub default_base_url: String,
    pub models_endpoint: Option<String>,
    pub credential_env: String,
    pub auth_methods: Vec<AuthMethodKindDto>,
}

fn descriptor(
    provider: &str,
    display_name: &str,
    protocols: &[ProviderProtocol],
    base_url: &str,
    credential_env: &str,
) -> ProviderDescriptorV1 {
    ProviderDescriptorV1 {
        provider: ProviderId::from_canonical_str(provider).expect("registry provider ID"),
        display_name: display_name.to_owned(),
        protocols: protocols.to_vec(),
        default_base_url: base_url.to_owned(),
        models_endpoint: Some("/models".to_owned()),
        credential_env: credential_env.to_owned(),
        auth_methods: vec![AuthMethodKindDto::ApiKey],
    }
}

/// The immutable, ordered schema-v1 registry.
pub fn provider_registry() -> &'static [ProviderDescriptorV1] {
    static REGISTRY: std::sync::OnceLock<Vec<ProviderDescriptorV1>> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| {
        vec![
            descriptor(
                "openai",
                "OpenAI",
                &[ProviderProtocol::Chat, ProviderProtocol::Responses],
                "https://api.openai.com/v1",
                "OPENAI_API_KEY",
            ),
            descriptor(
                "openrouter",
                "OpenRouter",
                &[ProviderProtocol::Chat],
                "https://openrouter.ai/api/v1",
                "OPENROUTER_API_KEY",
            ),
        ]
    })
}

/// Alias used by callers that treat the registry as a static catalog.
pub fn all_providers() -> &'static [ProviderDescriptorV1] {
    provider_registry()
}

pub fn provider_descriptor(provider: &str) -> Option<&'static ProviderDescriptorV1> {
    provider_registry()
        .iter()
        .find(|descriptor| descriptor.provider.as_str() == provider)
}

pub fn protocol_supported(provider: &str, protocol: &ProviderProtocol) -> bool {
    provider_descriptor(provider)
        .map(|descriptor| descriptor.protocols.contains(protocol))
        .unwrap_or(false)
}

pub fn validate_provider_id(provider: &str) -> Result<(), String> {
    let bytes = provider.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return Err("provider ID must contain 1..=32 bytes".to_owned());
    }
    if !bytes[0].is_ascii_lowercase()
        || !bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
        })
    {
        return Err(format!("invalid provider ID: {provider:?}"));
    }
    Ok(())
}

pub fn endpoint_for(descriptor: &ProviderDescriptorV1) -> String {
    format!(
        "{}{}",
        descriptor.default_base_url.trim_end_matches('/'),
        descriptor.models_endpoint.as_deref().unwrap_or("/models")
    )
}
