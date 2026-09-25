use praana_core::provider::catalog::{
    endpoint_fingerprint, endpoint_trust, parse_live_catalog, refresh_catalog, CatalogError,
    CatalogHttpClient, EndpointTrust, HttpCatalogResponse,
};
use praana_core::provider::profile::{bundled_manifest, parse_manifest, resolve_bundled_profile};
use praana_core::provider::registry::{provider_descriptor, provider_registry, ProviderProtocol};
use std::path::Path;

#[test]
fn registry_is_closed_and_matches_normative_rows() {
    let rows = provider_registry();
    assert_eq!(rows.len(), 2);
    let openai = provider_descriptor("openai").unwrap();
    assert_eq!(openai.default_base_url, "https://api.openai.com/v1");
    assert_eq!(openai.models_endpoint.as_deref(), Some("/models"));
    assert_eq!(openai.credential_env, "OPENAI_API_KEY");
    assert_eq!(
        openai.protocols,
        vec![ProviderProtocol::Chat, ProviderProtocol::Responses]
    );

    let openrouter = provider_descriptor("openrouter").unwrap();
    assert_eq!(openrouter.default_base_url, "https://openrouter.ai/api/v1");
    assert_eq!(openrouter.protocols, vec![ProviderProtocol::Chat]);
    assert!(provider_descriptor("anthropic").is_none());
}

#[test]
fn bundled_manifest_resolves_all_approved_models_dev_rows() {
    let manifest = bundled_manifest().unwrap();
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.profiles.len(), 3);
    use praana_core::provider::ReasoningAccounting;
    let approved = [
        (
            "openai",
            ProviderProtocol::Chat,
            "gpt-5.6-sol",
            "adapter-estimate:openai:openai-chat-v1:v1",
            ReasoningAccounting::IncludedInOutputLimit,
        ),
        (
            "openai",
            ProviderProtocol::Responses,
            "gpt-5.6-sol",
            "adapter-estimate:openai:openai-responses-v1:v1",
            ReasoningAccounting::IncludedInOutputLimit,
        ),
        (
            "openrouter",
            ProviderProtocol::Chat,
            "openai/gpt-5.6-sol",
            "adapter-estimate:openrouter:openai-chat-v1:v1",
            ReasoningAccounting::Unknown {
                conservative_reserve_tokens: 25_000,
            },
        ),
    ];
    for ((provider, protocol, model, framing, reasoning_accounting), row) in
        approved.iter().zip(&manifest.profiles)
    {
        assert_eq!(row.provider.as_str(), *provider);
        assert_eq!(&row.protocol, protocol);
        assert_eq!(row.model_id.as_str(), *model);
        assert_eq!(row.context_window_tokens, 1_050_000);
        assert_eq!(row.min_output_tokens, 256);
        assert_eq!(row.max_output_tokens, 128_000);
        assert_eq!(row.tokenizer_profile_id, None);
        assert_eq!(row.framing_profile_id, *framing);
        assert_eq!(&row.reasoning_accounting, reasoning_accounting);
        assert_eq!(
            row.reasoning_context,
            praana_core::provider::ReasoningContextCapability::AllTurns
        );
        assert!(!row.continuation_after_internal_request);
        assert!(row.parallel_tools);
        assert!(row.strict_json_schema);
        assert!(!row.temperature_with_reasoning);
        assert!(matches!(
            row.image_input,
            praana_core::provider::ImageInputCapability::Unsupported
        ));
        let resolved = resolve_bundled_profile(provider, protocol, model, None).unwrap();
        assert_eq!(resolved.context_window_tokens, 1_050_000);
        assert_eq!(resolved.framing_profile_id, *framing);
        assert_eq!(
            resolved.tokenizer,
            praana_core::provider::TokenizerCapability::ConservativeGeneric {
                estimator_id: praana_core::token::GENERIC_ESTIMATOR_ID.to_owned(),
            }
        );
        assert_eq!(
            resolved.reasoning_context,
            praana_core::provider::ReasoningContextCapability::AllTurns
        );
        assert!(!resolved.continuation_after_internal_request);
        assert_eq!(&resolved.reasoning_accounting, reasoning_accounting);
        assert!(!resolved.temperature_with_reasoning);
        assert!(matches!(
            resolved.image_input,
            praana_core::provider::ImageInputCapability::Unsupported
        ));
        assert!(!resolved.endpoint_fingerprint.as_str().is_empty());
    }
    assert!(
        resolve_bundled_profile("openai", &ProviderProtocol::Responses, "made-up", None).is_err()
    );
}

#[test]
fn manifest_parser_rejects_duplicates_and_noncanonical_bytes() {
    let duplicate = br#"{"schema_version":1,"schema_version":1,"generated_at_ms":1,"source_urls":["https://example.invalid"],"profiles":[]}"#;
    assert!(matches!(
        parse_manifest(duplicate),
        Err(praana_core::provider::ProfileError::Parse(_))
    ));

    let manifest = bundled_manifest().unwrap();
    let pretty = serde_json::to_vec_pretty(&manifest).unwrap();
    assert!(matches!(
        parse_manifest(&pretty),
        Err(praana_core::provider::ProfileError::NonCanonical)
    ));
}

#[test]
fn endpoint_fingerprint_and_custom_endpoint_trust_are_deterministic() {
    let first = endpoint_fingerprint("https://api.openai.com/v1/").unwrap();
    let second = endpoint_fingerprint("https://api.openai.com/v1").unwrap();
    assert_eq!(first, second);
    assert_eq!(
        endpoint_trust("openai", "https://api.openai.com/v1").unwrap(),
        EndpointTrust::Official
    );
    assert_eq!(
        endpoint_trust("openai", "http://127.0.0.1:8080/v1").unwrap(),
        EndpointTrust::Custom
    );
}

#[test]
fn live_catalog_is_parsed_and_refresh_falls_back_to_unexpired_cache() {
    let body = br#"{"data":[{"id":"gpt-5.6-sol","name":"GPT-5.6 Sol","context_length":1050000,"top_provider":{"max_completion_tokens":128000},"supported_parameters":["tools","parallel_tool_calls","structured_outputs"],"reasoning":{"supported_efforts":["low","high"]}}]}"#;
    let rows = parse_live_catalog("openrouter", body).unwrap();
    assert_eq!(rows[0].model_id.as_str(), "gpt-5.6-sol");
    assert_eq!(rows[0].context_length, Some(1_050_000));
    assert_eq!(rows[0].max_completion_tokens, Some(128_000));

    struct FakeClient {
        response: Result<HttpCatalogResponse, CatalogError>,
    }
    impl CatalogHttpClient for FakeClient {
        fn get_models(
            &self,
            _endpoint: &str,
            _credential: &str,
            _etag: Option<&str>,
        ) -> Result<HttpCatalogResponse, CatalogError> {
            self.response.clone()
        }
    }

    let temp = tempfile::tempdir().unwrap();
    let client = FakeClient {
        response: Ok(HttpCatalogResponse {
            status: 200,
            etag: Some("v1".to_owned()),
            body: body.to_vec(),
        }),
    };
    let first = refresh_catalog(
        &client,
        temp.path(),
        "openrouter",
        "http://127.0.0.1:8080/v1",
        "test-credential",
        1_000,
    )
    .unwrap();
    assert!(!first.used_cache);
    assert!(Path::new(&temp.path().join("cache/model-catalog-v1.json")).exists());

    let unavailable = FakeClient {
        response: Err(CatalogError::Transport("offline".to_owned())),
    };
    let second = refresh_catalog(
        &unavailable,
        temp.path(),
        "openrouter",
        "http://127.0.0.1:8080/v1",
        "test-credential",
        2_000,
    )
    .unwrap();
    assert!(second.used_cache);
    assert_eq!(second.cache.etag.as_deref(), Some("v1"));
}

#[test]
fn live_profile_requires_explicit_context_for_custom_or_expired_catalogs() {
    use praana_core::protocol::id::Sha256Digest;
    use praana_core::provider::catalog::{
        resolve_profile_with_catalog, CatalogCacheV1, LiveModelRowV1,
    };
    use praana_core::ui_contract::json_data::{ModelId, ProviderId};

    let cache = CatalogCacheV1 {
        schema_version: 1,
        provider: ProviderId::from_canonical_str("openrouter").unwrap(),
        endpoint_fingerprint: endpoint_fingerprint("http://127.0.0.1:8080/v1").unwrap(),
        fetched_at_ms: 1_000,
        expires_at_ms: 2_000,
        etag: None,
        body_sha256: Sha256Digest::from_bytes([7; 32]),
        models: vec![LiveModelRowV1 {
            provider: ProviderId::from_canonical_str("openrouter").unwrap(),
            model_id: ModelId::from_canonical_str("live-model").unwrap(),
            display_name: "Live model".to_owned(),
            context_length: Some(131_072),
            max_completion_tokens: Some(8_192),
            supported_parameters: vec!["tools".to_owned()],
            reasoning_efforts: vec!["low".to_owned()],
        }],
    };
    assert!(resolve_profile_with_catalog(
        "openrouter",
        &ProviderProtocol::Chat,
        "live-model",
        "http://127.0.0.1:8080/v1",
        1_500,
        Some(&cache),
        None,
        None,
    )
    .is_err());
    let profile = resolve_profile_with_catalog(
        "openrouter",
        &ProviderProtocol::Chat,
        "live-model",
        "http://127.0.0.1:8080/v1",
        1_500,
        Some(&cache),
        Some(65_536),
        Some(4_096),
    )
    .unwrap();
    assert_eq!(profile.context_window_tokens, 65_536);
    assert_eq!(profile.max_output_tokens, 4_096);
    assert!(profile.catalog_cache_sha256.is_none());
}

#[test]
fn live_catalog_rejects_duplicate_json_keys_and_untrusted_bounds() {
    let duplicate = br#"{"data":[{"id":"a","id":"b"}]}"#;
    assert!(matches!(
        parse_live_catalog("openrouter", duplicate),
        Err(CatalogError::InvalidJson(_))
    ));
    let too_large = br#"{"data":[{"id":"a","context_length":16777217}]}"#;
    assert!(matches!(
        parse_live_catalog("openrouter", too_large),
        Err(CatalogError::InvalidCatalog(_))
    ));
}

#[test]
fn pinned_snapshot_hash_and_https_client_contract_are_checked() {
    use praana_core::provider::ReqwestCatalogClient;
    use sha2::{Digest, Sha256};
    let snapshot_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("data/evidence/models_dev_p2a_gpt-5.6-sol_2026-09-24.json");
    let bytes = std::fs::read(snapshot_path).unwrap();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    assert_eq!(
        hash,
        "ad387e43e1a53dac3826ce299f8c400e39a734ca48e4c25676d755c0ce6cff90"
    );
    let client = ReqwestCatalogClient::new().unwrap();
    assert!(matches!(
        client.get_models("http://127.0.0.1:1/models", "test-credential", None),
        Err(CatalogError::InvalidEndpoint(_))
    ));
}

#[test]
fn openai_official_live_cache_cannot_supply_capability_facts() {
    use praana_core::protocol::id::Sha256Digest;
    use praana_core::provider::catalog::{
        resolve_profile_with_catalog, CatalogCacheV1, LiveModelRowV1,
    };
    use praana_core::ui_contract::json_data::{ModelId, ProviderId};
    let cache = CatalogCacheV1 {
        schema_version: 1,
        provider: ProviderId::from_canonical_str("openai").unwrap(),
        endpoint_fingerprint: endpoint_fingerprint("https://api.openai.com/v1").unwrap(),
        fetched_at_ms: 1_000,
        expires_at_ms: 10_000,
        etag: None,
        body_sha256: Sha256Digest::from_bytes([8; 32]),
        models: vec![LiveModelRowV1 {
            provider: ProviderId::from_canonical_str("openai").unwrap(),
            model_id: ModelId::from_canonical_str("invented-live-model").unwrap(),
            display_name: "Invented".to_owned(),
            context_length: Some(16_777_216),
            max_completion_tokens: Some(16_000_000),
            supported_parameters: vec!["tools".to_owned()],
            reasoning_efforts: vec!["max".to_owned()],
        }],
    };
    assert!(resolve_profile_with_catalog(
        "openai",
        &ProviderProtocol::Responses,
        "invented-live-model",
        "https://api.openai.com/v1",
        2_000,
        Some(&cache),
        None,
        None,
    )
    .is_err());
}

#[test]
fn endpoint_fingerprint_changes_profile_hash_identity() {
    use praana_core::provider::{profile_hash, resolve_profile_with_catalog};

    let official = resolve_profile_with_catalog(
        "openai",
        &ProviderProtocol::Responses,
        "gpt-5.6-sol",
        "https://api.openai.com/v1",
        2_000,
        None,
        None,
        None,
    )
    .unwrap();
    let custom = resolve_profile_with_catalog(
        "openai",
        &ProviderProtocol::Responses,
        "gpt-5.6-sol",
        "http://127.0.0.1:9/v1",
        2_000,
        None,
        None,
        None,
    )
    .unwrap();
    assert_ne!(official.endpoint_fingerprint, custom.endpoint_fingerprint);
    assert_ne!(
        profile_hash(&official).unwrap(),
        profile_hash(&custom).unwrap()
    );
}

#[test]
fn image_and_temperature_change_profile_hash_identity() {
    use praana_core::provider::{profile_hash, resolve_bundled_profile, ImageInputCapability};
    use praana_core::token::ImageTokenOccupancyV1;

    let baseline =
        resolve_bundled_profile("openai", &ProviderProtocol::Responses, "gpt-5.6-sol", None)
            .unwrap();
    let baseline_hash = profile_hash(&baseline).unwrap();

    let mut warmer = baseline.clone();
    warmer.temperature_with_reasoning = true;
    assert_ne!(profile_hash(&warmer).unwrap(), baseline_hash);

    let mut imaged = baseline;
    imaged.image_input = ImageInputCapability::Supported {
        occupancy: ImageTokenOccupancyV1::fixed_per_image(17).unwrap(),
    };
    assert_ne!(profile_hash(&imaged).unwrap(), baseline_hash);
}

#[test]
fn live_conservative_profile_gains_neither_temperature_nor_image_capability() {
    use praana_core::protocol::id::Sha256Digest;
    use praana_core::provider::catalog::{
        resolve_profile_with_catalog, CatalogCacheV1, LiveModelRowV1,
    };
    use praana_core::provider::ImageInputCapability;
    use praana_core::ui_contract::json_data::{ModelId, ProviderId};

    let cache = CatalogCacheV1 {
        schema_version: 1,
        provider: ProviderId::from_canonical_str("openrouter").unwrap(),
        endpoint_fingerprint: endpoint_fingerprint("https://openrouter.ai/api/v1").unwrap(),
        fetched_at_ms: 1_000,
        expires_at_ms: 1_000 + 6 * 60 * 60 * 1000,
        etag: None,
        body_sha256: Sha256Digest::from_bytes([9; 32]),
        models: vec![LiveModelRowV1 {
            provider: ProviderId::from_canonical_str("openrouter").unwrap(),
            model_id: ModelId::from_canonical_str("vendor/unknown-live").unwrap(),
            display_name: "Unknown".to_owned(),
            context_length: Some(32_000),
            max_completion_tokens: Some(4_000),
            supported_parameters: vec!["tools".to_owned()],
            reasoning_efforts: vec!["high".to_owned()],
        }],
    };
    let profile = resolve_profile_with_catalog(
        "openrouter",
        &ProviderProtocol::Chat,
        "vendor/unknown-live",
        "https://openrouter.ai/api/v1",
        2_000,
        Some(&cache),
        None,
        None,
    )
    .unwrap();
    assert!(!profile.temperature_with_reasoning);
    assert!(matches!(
        profile.image_input,
        ImageInputCapability::Unsupported
    ));
    assert_eq!(
        profile.endpoint_fingerprint,
        endpoint_fingerprint("https://openrouter.ai/api/v1").unwrap()
    );
}
