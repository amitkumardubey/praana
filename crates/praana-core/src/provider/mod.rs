//! Provider registry, model catalogs, and capability profiles (P2A).

pub mod catalog;
pub mod profile;
pub mod registry;

pub use catalog::{
    catalog_cache_path, endpoint_fingerprint, endpoint_trust, load_catalog_cache,
    parse_live_catalog, refresh_catalog, resolve_profile, resolve_profile_with_catalog,
    save_catalog_cache, CatalogCacheV1, CatalogError, CatalogHttpClient, CatalogRefresh,
    EndpointTrust, HttpCatalogResponse, LiveModelRowV1, ReqwestCatalogClient,
    CATALOG_CACHE_SCHEMA_VERSION, CATALOG_RESPONSE_CAP_BYTES, CATALOG_TIMEOUT, CATALOG_TTL_MS,
};
pub use profile::{
    bundled_manifest, bundled_manifest_sha256, model_id, parse_manifest, profile_hash, provider_id,
    resolve_bundled_profile, resolve_profile_from_manifest, ImageInputCapability,
    ModelCapabilityProfile, ModelProfileManifestV1, ModelProfileRowV1, ProfileError,
    ProfileEvidenceV1, ReasoningAccounting, ReasoningContextCapability, SelfCompactionCapability,
    TokenizerCapability, MODELS_DEV_P2A_SNAPSHOT_PATH, MODEL_PROFILE_SCHEMA_VERSION,
};
pub use registry::{
    all_providers, endpoint_for, protocol_supported, provider_descriptor, provider_registry,
    validate_provider_id, AuthMethodKindDto, ProviderDescriptorV1, ProviderProtocol,
    PROVIDER_REGISTRY_SCHEMA_VERSION,
};
