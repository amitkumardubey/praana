//! Live provider model catalogs, endpoint trust, and six-hour cache handling.
//!
//! Network access is intentionally injected through [`CatalogHttpClient`], so
//! catalog tests never depend on DNS, wall-clock scheduling, or real provider
//! credentials.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::config::normalize_provider_url;
use crate::credentials::validate_credential_value;
use crate::ui_contract::json_data::{ModelId, ProviderId, Sha256Digest};

use super::profile::{
    parse_strict_json, resolve_bundled_profile, ModelCapabilityProfile, ProfileError,
    ReasoningAccounting, ReasoningContextCapability, SelfCompactionCapability, TokenizerCapability,
};
use super::registry::{endpoint_for, protocol_supported, provider_descriptor, ProviderProtocol};

pub const CATALOG_CACHE_SCHEMA_VERSION: u32 = 1;
pub const CATALOG_TTL_MS: i64 = 6 * 60 * 60 * 1000;
pub const CATALOG_TIMEOUT: Duration = Duration::from_secs(20);
pub const CATALOG_RESPONSE_CAP_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LiveModelRowV1 {
    pub provider: ProviderId,
    pub model_id: ModelId,
    pub display_name: String,
    pub context_length: Option<u64>,
    pub max_completion_tokens: Option<u64>,
    pub supported_parameters: Vec<String>,
    pub reasoning_efforts: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CatalogCacheV1 {
    pub schema_version: u32,
    pub provider: ProviderId,
    pub endpoint_fingerprint: Sha256Digest,
    pub fetched_at_ms: i64,
    pub expires_at_ms: i64,
    pub etag: Option<String>,
    pub body_sha256: Sha256Digest,
    pub models: Vec<LiveModelRowV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpCatalogResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub body: Vec<u8>,
}

pub trait CatalogHttpClient {
    fn get_models(
        &self,
        endpoint: &str,
        credential: &str,
        etag: Option<&str>,
    ) -> Result<HttpCatalogResponse, CatalogError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogRefresh {
    pub cache: CatalogCacheV1,
    pub used_cache: bool,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EndpointTrust {
    Official,
    Custom,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogError {
    UnknownProvider(String),
    UnsupportedProtocol(String),
    InvalidEndpoint(String),
    InvalidCredential,
    AuthenticationFailed,
    HttpStatus(u16),
    Transport(String),
    ResponseTooLarge,
    InvalidJson(String),
    InvalidCatalog(String),
    Cache(String),
    Profile(ProfileError),
}

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownProvider(provider) => write!(f, "PROVIDER_UNKNOWN: {provider}"),
            Self::UnsupportedProtocol(protocol) => write!(f, "PROTOCOL_UNSUPPORTED: {protocol}"),
            Self::InvalidEndpoint(detail) => write!(f, "PROVIDER_ENDPOINT_INVALID: {detail}"),
            Self::InvalidCredential => f.write_str("AUTH_CREDENTIAL_INVALID"),
            Self::AuthenticationFailed => f.write_str("AUTH_CREDENTIAL_REJECTED"),
            Self::HttpStatus(status) => write!(f, "CATALOG_HTTP_STATUS: {status}"),
            Self::Transport(detail) => write!(f, "CATALOG_TRANSPORT: {detail}"),
            Self::ResponseTooLarge => f.write_str("CATALOG_RESPONSE_TOO_LARGE"),
            Self::InvalidJson(detail) => write!(f, "CATALOG_JSON_INVALID: {detail}"),
            Self::InvalidCatalog(detail) => write!(f, "CATALOG_INVALID: {detail}"),
            Self::Cache(detail) => write!(f, "CATALOG_CACHE_INVALID: {detail}"),
            Self::Profile(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for CatalogError {}

fn endpoint_fingerprint_from_normalized(endpoint: &str) -> Sha256Digest {
    Sha256Digest::from_bytes(Sha256::digest(endpoint.as_bytes()).into())
}

pub fn endpoint_fingerprint(endpoint: &str) -> Result<Sha256Digest, CatalogError> {
    let normalized = normalize_provider_url(endpoint, "provider endpoint")
        .map_err(|error| CatalogError::InvalidEndpoint(error.to_string()))?;
    Ok(endpoint_fingerprint_from_normalized(&normalized))
}

pub fn endpoint_trust(
    provider: &str,
    configured_endpoint: &str,
) -> Result<EndpointTrust, CatalogError> {
    let descriptor = provider_descriptor(provider)
        .ok_or_else(|| CatalogError::UnknownProvider(provider.to_owned()))?;
    let configured = normalize_provider_url(configured_endpoint, "provider endpoint")
        .map_err(|error| CatalogError::InvalidEndpoint(error.to_string()))?;
    let official = normalize_provider_url(&descriptor.default_base_url, "provider endpoint")
        .map_err(|error| CatalogError::InvalidEndpoint(error.to_string()))?;
    if configured == official {
        Ok(EndpointTrust::Official)
    } else {
        Ok(EndpointTrust::Custom)
    }
}

pub fn catalog_cache_path(praana_home: &Path) -> PathBuf {
    praana_home.join("cache/model-catalog-v1.json")
}

fn validate_cache(cache: &CatalogCacheV1) -> Result<(), CatalogError> {
    if cache.schema_version != CATALOG_CACHE_SCHEMA_VERSION {
        return Err(CatalogError::Cache("unsupported schema_version".to_owned()));
    }
    if cache.fetched_at_ms <= 0 || cache.expires_at_ms <= cache.fetched_at_ms {
        return Err(CatalogError::Cache("invalid cache timestamps".to_owned()));
    }
    provider_descriptor(cache.provider.as_str())
        .ok_or_else(|| CatalogError::UnknownProvider(cache.provider.to_string()))?;
    let mut ids = std::collections::BTreeSet::new();
    for model in &cache.models {
        if model.provider != cache.provider {
            return Err(CatalogError::Cache("model provider mismatch".to_owned()));
        }
        if !ids.insert(model.model_id.as_str()) {
            return Err(CatalogError::Cache(format!(
                "duplicate model {}",
                model.model_id
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn private_mode(path: &Path) -> Result<u32, CatalogError> {
    use std::os::unix::fs::PermissionsExt;
    Ok(fs::symlink_metadata(path)
        .map_err(|error| CatalogError::Cache(error.to_string()))?
        .permissions()
        .mode()
        & 0o777)
}

#[cfg(not(unix))]
fn private_mode(_path: &Path) -> Result<u32, CatalogError> {
    Err(CatalogError::Cache(
        "current-user cache ACL verification is unavailable".to_owned(),
    ))
}

#[cfg(unix)]
fn set_private_mode(path: &Path, mode: u32) -> Result<(), CatalogError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| CatalogError::Cache(format!("chmod {}: {error}", path.display())))
}

#[cfg(not(unix))]
fn set_private_mode(_path: &Path, _mode: u32) -> Result<(), CatalogError> {
    Err(CatalogError::Cache(
        "current-user cache ACL enforcement is unavailable".to_owned(),
    ))
}

fn reject_cache_symlink(path: &Path) -> Result<(), CatalogError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CatalogError::Cache(format!(
            "symlink at {}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CatalogError::Cache(error.to_string())),
    }
}

fn prepare_cache_parent(parent: &Path) -> Result<(), CatalogError> {
    let existed = parent.exists();
    reject_cache_symlink(parent)?;
    fs::create_dir_all(parent).map_err(|error| CatalogError::Cache(error.to_string()))?;
    if existed {
        if private_mode(parent)? != 0o700 {
            return Err(CatalogError::Cache(format!(
                "cache parent {} is not mode 0700",
                parent.display()
            )));
        }
    } else {
        set_private_mode(parent, 0o700)?;
    }
    Ok(())
}

pub fn load_catalog_cache(path: &Path) -> Result<CatalogCacheV1, CatalogError> {
    reject_cache_symlink(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| CatalogError::Cache("cache path has no parent".to_owned()))?;
    prepare_cache_parent(parent)?;
    if private_mode(path)? != 0o600 {
        return Err(CatalogError::Cache(format!(
            "cache file {} is not mode 0600",
            path.display()
        )));
    }
    let bytes = fs::read(path).map_err(|error| CatalogError::Cache(error.to_string()))?;
    let cache: CatalogCacheV1 =
        serde_json::from_slice(&bytes).map_err(|error| CatalogError::Cache(error.to_string()))?;
    validate_cache(&cache)?;
    Ok(cache)
}

pub fn save_catalog_cache(path: &Path, cache: &CatalogCacheV1) -> Result<(), CatalogError> {
    validate_cache(cache)?;
    let parent = path
        .parent()
        .ok_or_else(|| CatalogError::Cache("cache path has no parent".to_owned()))?;
    prepare_cache_parent(parent)?;
    let bytes =
        serde_json::to_vec(cache).map_err(|error| CatalogError::Cache(error.to_string()))?;
    let temp = parent.join(format!(".model-catalog-{}.tmp", std::process::id()));
    reject_cache_symlink(&temp)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options
        .open(&temp)
        .map_err(|error| CatalogError::Cache(error.to_string()))?;
    file.write_all(&bytes)
        .map_err(|error| CatalogError::Cache(error.to_string()))?;
    file.sync_all()
        .map_err(|error| CatalogError::Cache(error.to_string()))?;
    drop(file);
    if private_mode(&temp)? != 0o600 {
        return Err(CatalogError::Cache(
            "temporary cache file is not private".to_owned(),
        ));
    }
    fs::rename(&temp, path).map_err(|error| CatalogError::Cache(error.to_string()))?;
    if private_mode(path)? != 0o600 {
        return Err(CatalogError::Cache("cache file is not private".to_owned()));
    }
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| CatalogError::Cache(error.to_string()))?;
    Ok(())
}

fn parse_model_row(
    provider: &str,
    value: &serde_json::Value,
) -> Result<LiveModelRowV1, CatalogError> {
    let model_id = value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CatalogError::InvalidCatalog("model row missing id".to_owned()))?;
    let display_name = value
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(model_id);
    let context_length = value
        .get("context_length")
        .map(|context| {
            let length = context.as_u64().ok_or_else(|| {
                CatalogError::InvalidCatalog("context_length must be an integer".to_owned())
            })?;
            if provider == "openrouter" && !(1..=16_777_216).contains(&length) {
                return Err(CatalogError::InvalidCatalog(
                    "context_length is outside the trusted range".to_owned(),
                ));
            }
            Ok(length)
        })
        .transpose()?;
    let max_completion_tokens = value
        .get("top_provider")
        .and_then(|top| top.get("max_completion_tokens"))
        .or_else(|| value.get("max_completion_tokens"))
        .map(|max| {
            let value = max.as_u64().ok_or_else(|| {
                CatalogError::InvalidCatalog("max_completion_tokens must be an integer".to_owned())
            })?;
            if provider == "openrouter" && !(1..=16_777_216).contains(&value) {
                return Err(CatalogError::InvalidCatalog(
                    "max_completion_tokens is outside the trusted range".to_owned(),
                ));
            }
            Ok(value)
        })
        .transpose()?;
    let supported_parameters = match value.get("supported_parameters") {
        None => Vec::new(),
        Some(parameters) => parameters
            .as_array()
            .ok_or_else(|| {
                CatalogError::InvalidCatalog("supported_parameters must be an array".to_owned())
            })?
            .iter()
            .map(|parameter| {
                parameter.as_str().map(str::to_owned).ok_or_else(|| {
                    CatalogError::InvalidCatalog(
                        "supported_parameters must contain strings".to_owned(),
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
    };
    let reasoning_efforts = value
        .get("reasoning")
        .and_then(|reasoning| reasoning.get("supported_efforts"))
        .or_else(|| {
            value
                .get("reasoning_options")
                .and_then(|v| v.as_array())
                .and_then(|v| v.first())
                .and_then(|v| v.get("values"))
        })
        .map(|efforts| {
            efforts
                .as_array()
                .ok_or_else(|| {
                    CatalogError::InvalidCatalog("reasoning efforts must be an array".to_owned())
                })?
                .iter()
                .map(|effort| {
                    effort.as_str().map(str::to_owned).ok_or_else(|| {
                        CatalogError::InvalidCatalog(
                            "reasoning efforts must contain strings".to_owned(),
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(LiveModelRowV1 {
        provider: ProviderId::from_canonical_str(provider).map_err(CatalogError::InvalidCatalog)?,
        model_id: ModelId::from_canonical_str(model_id).map_err(CatalogError::InvalidCatalog)?,
        display_name: display_name.to_owned(),
        context_length,
        max_completion_tokens,
        supported_parameters,
        reasoning_efforts,
    })
}

pub fn parse_live_catalog(
    provider: &str,
    body: &[u8],
) -> Result<Vec<LiveModelRowV1>, CatalogError> {
    if body.len() > CATALOG_RESPONSE_CAP_BYTES {
        return Err(CatalogError::ResponseTooLarge);
    }
    let value =
        parse_strict_json(body).map_err(|error| CatalogError::InvalidJson(error.to_string()))?;
    let data = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| CatalogError::InvalidCatalog("response data must be an array".to_owned()))?;
    let mut models = Vec::with_capacity(data.len());
    for row in data {
        models.push(parse_model_row(provider, row)?);
    }
    models.sort_by(|left, right| left.model_id.as_str().cmp(right.model_id.as_str()));
    for pair in models.windows(2) {
        if pair[0].model_id == pair[1].model_id {
            return Err(CatalogError::InvalidCatalog(format!(
                "duplicate model {}",
                pair[0].model_id
            )));
        }
    }
    Ok(models)
}

pub fn refresh_catalog<C: CatalogHttpClient>(
    client: &C,
    praana_home: &Path,
    provider: &str,
    base_url: &str,
    credential: &str,
    now_ms: i64,
) -> Result<CatalogRefresh, CatalogError> {
    let descriptor = provider_descriptor(provider)
        .ok_or_else(|| CatalogError::UnknownProvider(provider.to_owned()))?;
    validate_credential_value(credential).map_err(|_| CatalogError::InvalidCredential)?;
    let normalized = normalize_provider_url(base_url, "provider endpoint")
        .map_err(|error| CatalogError::InvalidEndpoint(error.to_string()))?;
    let endpoint = if endpoint_trust(provider, &normalized)? == EndpointTrust::Official {
        endpoint_for(descriptor)
    } else {
        format!("{}/models", normalized.trim_end_matches('/'))
    };
    let fingerprint = endpoint_fingerprint_from_normalized(&normalized);
    let cache_path = catalog_cache_path(praana_home);
    reject_cache_symlink(&cache_path)?;
    let prior = if cache_path.exists() {
        let cache = load_catalog_cache(&cache_path)?;
        (cache.provider.as_str() == provider && cache.endpoint_fingerprint == fingerprint)
            .then_some(cache)
    } else {
        None
    };
    let response = match client.get_models(
        &endpoint,
        credential,
        prior.as_ref().and_then(|c| c.etag.as_deref()),
    ) {
        Ok(response) if response.status == 304 => {
            if let Some(mut cache) = prior.clone() {
                cache.fetched_at_ms = now_ms;
                cache.expires_at_ms = now_ms.checked_add(CATALOG_TTL_MS).ok_or_else(|| {
                    CatalogError::InvalidCatalog("catalog expiry timestamp overflow".to_owned())
                })?;
                if response.etag.is_some() {
                    cache.etag = response.etag;
                }
                save_catalog_cache(&cache_path, &cache)?;
                return Ok(CatalogRefresh {
                    cache,
                    used_cache: true,
                    warning: None,
                });
            }
            return Err(CatalogError::HttpStatus(304));
        }
        Ok(response) if response.status == 401 || response.status == 403 => {
            return Err(CatalogError::AuthenticationFailed)
        }
        Ok(response) if !(200..300).contains(&response.status) => {
            return Err(CatalogError::HttpStatus(response.status))
        }
        Ok(response) => response,
        Err(error) => {
            if let Some(cache) = prior.filter(|cache| cache.expires_at_ms > now_ms) {
                return Ok(CatalogRefresh {
                    cache,
                    used_cache: true,
                    warning: Some(error.to_string()),
                });
            }
            return Err(error);
        }
    };
    let models = parse_live_catalog(provider, &response.body)?;
    let body_sha256 = Sha256Digest::from_bytes(Sha256::digest(&response.body).into());
    let cache = CatalogCacheV1 {
        schema_version: CATALOG_CACHE_SCHEMA_VERSION,
        provider: ProviderId::from_canonical_str(provider).map_err(CatalogError::InvalidCatalog)?,
        endpoint_fingerprint: fingerprint,
        fetched_at_ms: now_ms,
        expires_at_ms: now_ms.checked_add(CATALOG_TTL_MS).ok_or_else(|| {
            CatalogError::InvalidCatalog("catalog expiry timestamp overflow".to_owned())
        })?,
        etag: response.etag,
        body_sha256,
        models,
    };
    save_catalog_cache(&cache_path, &cache)?;
    Ok(CatalogRefresh {
        cache,
        used_cache: false,
        warning: None,
    })
}

pub fn resolve_profile(
    provider: &str,
    protocol: &ProviderProtocol,
    model: &str,
    _cache: Option<&CatalogCacheV1>,
) -> Result<ModelCapabilityProfile, CatalogError> {
    if !protocol_supported(provider, protocol) {
        return Err(CatalogError::UnsupportedProtocol(
            protocol.config_name().to_owned(),
        ));
    }
    resolve_bundled_profile(provider, protocol, model, None).map_err(CatalogError::Profile)
}

fn trusted_cache<'a>(
    provider: &str,
    endpoint: &str,
    now_ms: i64,
    cache: Option<&'a CatalogCacheV1>,
) -> Result<Option<&'a CatalogCacheV1>, CatalogError> {
    let Some(cache) = cache else {
        return Ok(None);
    };
    if provider != "openrouter"
        || cache.provider.as_str() != provider
        || cache.expires_at_ms <= now_ms
    {
        return Ok(None);
    }
    let fingerprint = endpoint_fingerprint(endpoint)?;
    if cache.endpoint_fingerprint != fingerprint
        || endpoint_trust(provider, endpoint)? != EndpointTrust::Official
    {
        return Ok(None);
    }
    Ok(Some(cache))
}

/// Resolve the required bundled/live/config precedence while preserving the
/// trust boundary for custom and expired catalogs. Bundled rows always win;
/// a live row may provide trusted capability facts only from an unexpired
/// official OpenRouter cache.
#[allow(clippy::too_many_arguments)]
pub fn resolve_profile_with_catalog(
    provider: &str,
    protocol: &ProviderProtocol,
    model: &str,
    endpoint: &str,
    now_ms: i64,
    cache: Option<&CatalogCacheV1>,
    context_override: Option<u64>,
    max_output_override: Option<u64>,
) -> Result<ModelCapabilityProfile, CatalogError> {
    if !protocol_supported(provider, protocol) {
        return Err(CatalogError::UnsupportedProtocol(
            protocol.config_name().to_owned(),
        ));
    }
    let trusted = trusted_cache(provider, endpoint, now_ms, cache)?;
    if let Ok(profile) = resolve_bundled_profile(
        provider,
        protocol,
        model,
        trusted.map(|cache| cache.body_sha256.clone()),
    ) {
        return Ok(profile);
    }

    let Some(cache) = cache else {
        return Err(CatalogError::Profile(ProfileError::UnknownModel {
            provider: provider.to_owned(),
            model: model.to_owned(),
        }));
    };
    let row = cache
        .models
        .iter()
        .find(|row| row.model_id.as_str() == model)
        .ok_or_else(|| {
            CatalogError::Profile(ProfileError::UnknownModel {
                provider: provider.to_owned(),
                model: model.to_owned(),
            })
        })?;
    let (context_window_tokens, trusted_live) = match trusted {
        Some(_) => (row.context_length, true),
        None => (None, false),
    };
    let context_window_tokens = context_window_tokens.or(context_override).ok_or_else(|| {
        CatalogError::Profile(ProfileError::Invalid(
            "MODEL_PROFILE_INCOMPLETE: context window is not trusted".to_owned(),
        ))
    })?;
    if context_window_tokens == 0 || context_window_tokens > 16_777_216 {
        return Err(CatalogError::Profile(ProfileError::Invalid(
            "context window is outside the allowed range".to_owned(),
        )));
    }
    let max_output_tokens = max_output_override
        .or(if trusted_live {
            row.max_completion_tokens
        } else {
            None
        })
        .unwrap_or(8192)
        .min(context_window_tokens.saturating_sub(1));
    if max_output_tokens == 0 {
        return Err(CatalogError::Profile(ProfileError::Invalid(
            "resolved output window is empty".to_owned(),
        )));
    }
    let source_hash = cache.body_sha256.clone();
    Ok(ModelCapabilityProfile {
        profile_version: "model-profile-v1-live".to_owned(),
        profile_source_sha256: source_hash.clone(),
        catalog_cache_sha256: trusted.map(|cache| cache.body_sha256.clone()),
        provider: provider.to_owned(),
        protocol: protocol.config_name().to_owned(),
        model_pattern: model.to_owned(),
        model_revision: None,
        context_window_tokens,
        max_output_tokens,
        min_output_tokens: 1,
        reasoning_accounting: ReasoningAccounting::Unknown {
            conservative_reserve_tokens: 1,
        },
        reasoning_context: ReasoningContextCapability::Unsupported,
        tokenizer: TokenizerCapability::ConservativeGeneric {
            estimator_id: crate::token::GENERIC_ESTIMATOR_ID.to_owned(),
        },
        framing_profile_id: "adapter-estimate:generic:default:v1".to_owned(),
        reasoning_efforts: Vec::new(),
        parallel_tools: false,
        strict_json_schema: false,
        self_compaction: SelfCompactionCapability::Prohibited,
        continuation_after_internal_request: false,
    })
}

/// Production catalog client. TLS is provided by reqwest's rustls backend;
/// plaintext HTTP is rejected even for custom endpoints.
pub struct ReqwestCatalogClient {
    client: reqwest::blocking::Client,
}

impl ReqwestCatalogClient {
    pub fn new() -> Result<Self, CatalogError> {
        let client = reqwest::blocking::Client::builder()
            .timeout(CATALOG_TIMEOUT)
            .https_only(true)
            .build()
            .map_err(|error| CatalogError::Transport(error.to_string()))?;
        Ok(Self { client })
    }
}

impl CatalogHttpClient for ReqwestCatalogClient {
    fn get_models(
        &self,
        endpoint: &str,
        credential: &str,
        etag: Option<&str>,
    ) -> Result<HttpCatalogResponse, CatalogError> {
        validate_credential_value(credential).map_err(|_| CatalogError::InvalidCredential)?;
        if !endpoint.starts_with("https://") {
            return Err(CatalogError::InvalidEndpoint(
                "catalog transport requires https".to_owned(),
            ));
        }
        let mut request = self.client.get(endpoint).bearer_auth(credential);
        if let Some(etag) = etag {
            let value = reqwest::header::HeaderValue::from_str(etag).map_err(|_| {
                CatalogError::InvalidCatalog(
                    "catalog ETag contains invalid header bytes".to_owned(),
                )
            })?;
            request = request.header(reqwest::header::IF_NONE_MATCH, value);
        }
        let mut response = request
            .send()
            .map_err(|error| CatalogError::Transport(error.to_string()))?;
        if response
            .content_length()
            .is_some_and(|length| length > CATALOG_RESPONSE_CAP_BYTES as u64)
        {
            return Err(CatalogError::ResponseTooLarge);
        }
        let status = response.status().as_u16();
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .map(|value| {
                value
                    .to_str()
                    .map(str::to_owned)
                    .map_err(|_| CatalogError::InvalidCatalog("invalid response ETag".to_owned()))
            })
            .transpose()?;
        let mut body = Vec::new();
        response
            .by_ref()
            .take((CATALOG_RESPONSE_CAP_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|error| CatalogError::Transport(error.to_string()))?;
        if body.len() > CATALOG_RESPONSE_CAP_BYTES {
            return Err(CatalogError::ResponseTooLarge);
        }
        Ok(HttpCatalogResponse { status, etag, body })
    }
}
