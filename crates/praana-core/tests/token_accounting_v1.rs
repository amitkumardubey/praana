use praana_core::token::{
    calculate_batch_inline_decisions, calculate_request_component_manifest, check_component_bound,
    check_input_hash, is_eligible_for_inline, CalibrationBucketKey, FramingProfileV1,
    GenericTokenEstimatorV1, RequestComponentKind, Sha256Digest, TokenAccountingError,
    TokenCalibrationBucket, TokenCalibrationSampleV1, TokenEstimateV1, TokenEstimationContext,
    TokenEstimatorV1, TokenProfileStoreV1, TurnId,
};

#[test]
fn generic_estimator_fixture_cases() {
    let estimator = GenericTokenEstimatorV1;
    let zero_framing = FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "test:zero".to_string(),
        fixed_tokens: 0,
        per_item_tokens: 0,
        item_count: 0,
        additional_tokens: 0,
    };

    // Table in Section 11 of spec
    let cases = vec![
        ("", 0, 0),
        ("abcd", 12, 1),
        ("abcde", 15, 2),
        ("\u{4E2D}\u{6587}", 16, 2),
        ("\u{1F600}", 12, 1),
        (
            "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}",
            48,
            4,
        ),
        ("\u{2764}\u{FE0F}", 12, 1),
        ("e\u{0301}", 6, 1),
        ("a\r\nb", 12, 1),
    ];

    for (input, _expected_units, expected_tokens) in cases {
        let estimate = estimator
            .estimate(
                TokenEstimationContext::ArtifactResult,
                input.as_bytes(),
                &zero_framing,
            )
            .unwrap();
        assert_eq!(
            estimate.content_tokens, expected_tokens,
            "Failed for input: {input}"
        );
        assert_eq!(estimate.framing_tokens, 0);
        assert_eq!(estimate.total_tokens, expected_tokens);
        assert_eq!(estimate.estimator_id, "praana-generic-unicode-15.1-v1");
        assert_eq!(estimate.token_estimator_schema_version, 1);
        assert_eq!(estimate.tokenizer_profile_id, None);
        assert_eq!(
            estimate.input_sha256,
            Sha256Digest::digest_bytes(input.as_bytes())
        );
    }
}

#[test]
fn generic_estimator_framing_addition() {
    let estimator = GenericTokenEstimatorV1;
    let framing = FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "test:framing".to_string(),
        fixed_tokens: 10,
        per_item_tokens: 2,
        item_count: 3,
        additional_tokens: 4,
    }; // 10 + 2*3 + 4 = 20

    let estimate = estimator
        .estimate(
            TokenEstimationContext::ArtifactResult,
            "abcde".as_bytes(),
            &framing,
        )
        .unwrap();

    assert_eq!(estimate.content_tokens, 2);
    assert_eq!(estimate.framing_tokens, 20);
    assert_eq!(estimate.total_tokens, 22);
}

#[test]
fn generic_estimator_invalid_utf8_fails() {
    let estimator = GenericTokenEstimatorV1;
    let zero_framing = FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "test:zero".to_string(),
        fixed_tokens: 0,
        per_item_tokens: 0,
        item_count: 0,
        additional_tokens: 0,
    };

    let invalid_bytes = [0xFF, 0xFE, 0xFD];
    let err = estimator
        .estimate(
            TokenEstimationContext::ArtifactResult,
            &invalid_bytes,
            &zero_framing,
        )
        .unwrap_err();

    assert_eq!(err, TokenAccountingError::InvalidUtf8);
}

#[test]
fn generic_estimator_binary_telemetry() {
    let estimator = GenericTokenEstimatorV1;
    let zero_framing = FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "test:zero".to_string(),
        fixed_tokens: 0,
        per_item_tokens: 0,
        item_count: 0,
        additional_tokens: 0,
    };

    let bytes = vec![0u8; 10]; // ceil(10 / 3) = 4 tokens
    let estimate = estimator
        .estimate(
            TokenEstimationContext::BinaryTelemetry,
            &bytes,
            &zero_framing,
        )
        .unwrap();

    assert_eq!(estimate.content_tokens, 4);
    assert_eq!(estimate.total_tokens, 4);
    assert_eq!(estimate.input_sha256, Sha256Digest::digest_bytes(&bytes));
}

#[test]
fn framing_overflow_checked() {
    let framing = FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "test:overflow".to_string(),
        fixed_tokens: u64::MAX,
        per_item_tokens: 1,
        item_count: 1,
        additional_tokens: 0,
    };

    assert_eq!(
        framing.calculate_framing_tokens().unwrap_err(),
        TokenAccountingError::Overflow
    );
}

#[test]
fn token_estimate_v1_json_serialization_preserves_null() {
    let estimate = TokenEstimateV1 {
        token_estimator_schema_version: 1,
        estimator_id: "praana-generic-unicode-15.1-v1".to_string(),
        tokenizer_profile_id: None,
        input_sha256: Sha256Digest::digest_bytes(b"test"),
        content_tokens: 1,
        framing_tokens: 0,
        total_tokens: 1,
    };

    let json_str = serde_json::to_string(&estimate).unwrap();
    assert!(json_str.contains("\"tokenizer_profile_id\":null"));
}

#[test]
fn request_component_manifest_is_rfc8785_canonical() {
    let estimator = GenericTokenEstimatorV1;
    let zero_framing = FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "test:zero".to_string(),
        fixed_tokens: 0,
        per_item_tokens: 0,
        item_count: 0,
        additional_tokens: 0,
    };

    let components: [(RequestComponentKind, &[u8]); 9] = [
        (RequestComponentKind::System, b"system prompt"),
        (RequestComponentKind::ToolSchema, b"tools"),
        (RequestComponentKind::MemoryBootstrap, b""),
        (RequestComponentKind::Handoff, b"handoff"),
        (RequestComponentKind::RetainedMessages, b"messages"),
        (RequestComponentKind::StateGraph, b"state"),
        (RequestComponentKind::ActiveToolCycle, b""),
        (RequestComponentKind::Continuation, b""),
        (RequestComponentKind::ProviderFraming, b""),
    ];

    let mut estimates = Vec::new();
    for (kind, content) in &components {
        let est = estimator
            .estimate(
                TokenEstimationContext::ProviderRequestComponent { component: *kind },
                content,
                &zero_framing,
            )
            .unwrap();
        estimates.push(est);
    }

    let (manifest_json, manifest_hash, total_request_tokens) =
        calculate_request_component_manifest(&estimates).unwrap();

    assert_eq!(estimates.len(), 9);
    assert!(!manifest_json.is_empty());
    assert_eq!(manifest_hash.as_str().len(), 64);
    assert!(total_request_tokens > 0);

    // Assert RFC 8785 key order on each object in the manifest:
    // content_tokens < estimator_id < framing_tokens < input_sha256 < token_estimator_schema_version < tokenizer_profile_id < total_tokens
    let first_obj_end = manifest_json.find('}').unwrap();
    let first_obj = &manifest_json[1..=first_obj_end];

    let idx_content = first_obj.find("\"content_tokens\":").unwrap();
    let idx_estimator = first_obj.find("\"estimator_id\":").unwrap();
    let idx_framing = first_obj.find("\"framing_tokens\":").unwrap();
    let idx_sha256 = first_obj.find("\"input_sha256\":").unwrap();
    let idx_version = first_obj
        .find("\"token_estimator_schema_version\":")
        .unwrap();
    let idx_profile = first_obj.find("\"tokenizer_profile_id\":").unwrap();
    let idx_total = first_obj.find("\"total_tokens\":").unwrap();

    assert!(idx_content < idx_estimator);
    assert!(idx_estimator < idx_framing);
    assert!(idx_framing < idx_sha256);
    assert!(idx_sha256 < idx_version);
    assert!(idx_version < idx_profile);
    assert!(idx_profile < idx_total);
}

#[test]
fn token_calibration_bucket_exact_p95_and_telemetry() {
    let mut bucket = TokenCalibrationBucket::new(128);

    // With fewer than 20 samples, margin C must be 0
    for i in 0..19 {
        let sample = TokenCalibrationSampleV1::new(
            "openai".to_string(),
            "openai-chat-v1".to_string(),
            "gpt-5".to_string(),
            None,
            "praana-generic-unicode-15.1-v1".to_string(),
            Sha256Digest::digest_bytes(b"req"),
            100,
            100 + i + 1, // positive errors 1..=19
            None,
            0,
            1000 + (i as i64),
        )
        .unwrap();
        bucket.add_sample(sample);
    }
    assert_eq!(bucket.calculate_calibration_margin_c().unwrap(), 0);

    // Adding zero usage sample is excluded and increments excluded_samples_count
    let zero_sample = TokenCalibrationSampleV1::new(
        "openai".to_string(),
        "openai-chat-v1".to_string(),
        "gpt-5".to_string(),
        None,
        "praana-generic-unicode-15.1-v1".to_string(),
        Sha256Digest::digest_bytes(b"req"),
        100,
        0, // 0 reported tokens -> excluded
        None,
        0,
        1019,
    )
    .unwrap();
    bucket.add_sample(zero_sample);
    assert_eq!(bucket.excluded_samples_count(), 1);
    assert_eq!(bucket.len(), 19);

    // 20th valid sample added: positive error = 20
    let sample_20 = TokenCalibrationSampleV1::new(
        "openai".to_string(),
        "openai-chat-v1".to_string(),
        "gpt-5".to_string(),
        None,
        "praana-generic-unicode-15.1-v1".to_string(),
        Sha256Digest::digest_bytes(b"req"),
        100,
        120, // error = 20
        None,
        0,
        1020,
    )
    .unwrap();
    bucket.add_sample(sample_20);
    assert_eq!(bucket.len(), 20);

    // With 20 samples: sorted positive errors are 1, 2, ..., 20.
    // Nearest-rank p95: rank = (95 * 20 + 99) / 100 = 1999 / 100 = 19.
    // Index = 19 - 1 = 18. errors[18] is 19.
    // Margin C = 19 + 128 = 147.
    let margin = bucket.calculate_calibration_margin_c().unwrap();
    assert_eq!(margin, 147);
}

#[test]
fn token_calibration_overflow_rejected() {
    let err = TokenCalibrationSampleV1::new(
        "openai".to_string(),
        "openai-chat-v1".to_string(),
        "gpt-5".to_string(),
        None,
        "praana-generic-unicode-15.1-v1".to_string(),
        Sha256Digest::digest_bytes(b"req"),
        100,
        u64::MAX, // Exceeds signed i64 range
        None,
        0,
        1000,
    )
    .unwrap_err();

    assert_eq!(err, TokenAccountingError::Overflow);
}

#[test]
fn token_profile_store_resolution_and_errors() {
    let store = TokenProfileStoreV1::load_bundled().unwrap();

    // 1. Successful exact resolution
    let profile = store
        .resolve("openai", "openai-responses-v1", "gpt-5", None)
        .unwrap();
    assert_eq!(
        profile.content_estimator_id,
        "praana-generic-unicode-15.1-v1"
    );
    assert_eq!(profile.framing_profile.framing_profile_schema_version, 1);

    // 2. Generic conservative profile resolution
    let generic_row = store.resolve_conservative_generic().unwrap();
    assert_eq!(generic_row.provider, "generic");
    assert_eq!(generic_row.model, "generic-conservative");

    // 3. Unknown model returns TOKEN_PROFILE_UNKNOWN
    let err = store
        .resolve("openai", "openai-responses-v1", "non-existent-model", None)
        .unwrap_err();
    assert_eq!(
        err,
        TokenAccountingError::ProfileUnknown(
            "openai/openai-responses-v1/non-existent-model".to_string()
        )
    );

    // 4. Revision mismatch returns TOKEN_PROFILE_UNKNOWN
    let rev_err = store
        .resolve(
            "openai",
            "openai-responses-v1",
            "gpt-5",
            Some("unmatched-revision"),
        )
        .unwrap_err();
    assert_eq!(
        rev_err,
        TokenAccountingError::ProfileUnknown("openai/openai-responses-v1/gpt-5".to_string())
    );
}

#[test]
fn artifact_inline_threshold_boundaries() {
    let threshold: u64 = 800;

    // Below threshold -> eligible
    assert!(is_eligible_for_inline(threshold - 1, threshold));
    // Exactly at threshold -> eligible
    assert!(is_eligible_for_inline(threshold, threshold));
    // Above threshold -> ineligible
    assert!(!is_eligible_for_inline(threshold + 1, threshold));
}

#[test]
fn batch_inline_budget_and_order() {
    let inline_threshold: u64 = 150;
    let batch_budget: u64 = 250;

    // Provider call order: [100, 200, 50]
    // 100: eligible (<=150), sum=100 <= 250 -> inline
    // 200: ineligible (>150) -> not inline (does not enter sum)
    // 50: eligible (<=150), sum=100+50=150 <= 250 -> inline
    let results = vec![100, 200, 50];
    let decisions =
        calculate_batch_inline_decisions(&results, batch_budget, inline_threshold).unwrap();
    assert_eq!(decisions, vec![true, false, true]);

    // Reverse physical completion order should yield results corresponding to that order:
    // [50, 200, 100]
    // 50: eligible, sum=50 <= 250 -> true
    // 200: ineligible -> false
    // 100: eligible, sum=50+100=150 <= 250 -> true
    let reversed = vec![50, 200, 100];
    let rev_decisions =
        calculate_batch_inline_decisions(&reversed, batch_budget, inline_threshold).unwrap();
    assert_eq!(rev_decisions, vec![true, false, true]);

    // Budget exceeded case: [100, 100, 100] with budget 250
    // 1: 100 (sum=100) -> true
    // 2: 100 (sum=200) -> true
    // 3: 100 (sum=300 > 250) -> false
    let overflow_results = vec![100, 100, 100];
    let overflow_decisions =
        calculate_batch_inline_decisions(&overflow_results, batch_budget, inline_threshold)
            .unwrap();
    assert_eq!(overflow_decisions, vec![true, true, false]);
}

#[test]
fn separately_rounded_components_vs_combined_ceil() {
    let estimator = GenericTokenEstimatorV1;
    let zero_framing = FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "test:zero".to_string(),
        fixed_tokens: 0,
        per_item_tokens: 0,
        item_count: 0,
        additional_tokens: 0,
    };

    // Three 1-character ASCII inputs. Each has 3 scalar units.
    // Individually: ceil(3 / 12) = 1 token each.
    // Sum of individually rounded components = 1 + 1 + 1 = 3 tokens.
    // If combined before rounding: 3 + 3 + 3 = 9 units -> ceil(9 / 12) = 1 token!
    let est1 = estimator
        .estimate(TokenEstimationContext::StateGraph, b"a", &zero_framing)
        .unwrap();
    let est2 = estimator
        .estimate(TokenEstimationContext::StateGraph, b"b", &zero_framing)
        .unwrap();
    let est3 = estimator
        .estimate(TokenEstimationContext::StateGraph, b"c", &zero_framing)
        .unwrap();

    assert_eq!(est1.content_tokens, 1);
    assert_eq!(est2.content_tokens, 1);
    assert_eq!(est3.content_tokens, 1);
    assert_eq!(est1.total_tokens + est2.total_tokens + est3.total_tokens, 3);
}

#[test]
fn compaction_source_turn_uses_turn_id() {
    let turn_id = TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
    let ctx = TokenEstimationContext::CompactionSourceTurn { turn_id };
    let json = serde_json::to_string(&ctx).unwrap();
    assert!(json.contains("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
}

#[test]
fn component_bound_exact_limit_and_plus_one() {
    let estimate_exact = TokenEstimateV1 {
        token_estimator_schema_version: 1,
        estimator_id: "praana-generic-unicode-15.1-v1".to_string(),
        tokenizer_profile_id: None,
        input_sha256: Sha256Digest::digest_bytes(b"exact"),
        content_tokens: 160,
        framing_tokens: 0,
        total_tokens: 160,
    };

    let estimate_plus_one = TokenEstimateV1 {
        token_estimator_schema_version: 1,
        estimator_id: "praana-generic-unicode-15.1-v1".to_string(),
        tokenizer_profile_id: None,
        input_sha256: Sha256Digest::digest_bytes(b"plus_one"),
        content_tokens: 161,
        framing_tokens: 0,
        total_tokens: 161,
    };

    // 1. Artifact preview bound: default limit is 160 tokens
    assert!(check_component_bound(&estimate_exact, 160).is_ok());
    assert_eq!(
        check_component_bound(&estimate_plus_one, 160).unwrap_err(),
        TokenAccountingError::BoundExceeded
    );

    // 2. StateGraph tail bound: 4096 tokens
    let sg_exact = TokenEstimateV1 {
        total_tokens: 4096,
        ..estimate_exact.clone()
    };
    let sg_plus_one = TokenEstimateV1 {
        total_tokens: 4097,
        ..estimate_plus_one.clone()
    };
    assert!(check_component_bound(&sg_exact, 4096).is_ok());
    assert_eq!(
        check_component_bound(&sg_plus_one, 4096).unwrap_err(),
        TokenAccountingError::BoundExceeded
    );

    // 3. Memory digest bound: 1200 tokens
    let md_exact = TokenEstimateV1 {
        total_tokens: 1200,
        ..estimate_exact
    };
    let md_plus_one = TokenEstimateV1 {
        total_tokens: 1201,
        ..estimate_plus_one
    };
    assert!(check_component_bound(&md_exact, 1200).is_ok());
    assert_eq!(
        check_component_bound(&md_plus_one, 1200).unwrap_err(),
        TokenAccountingError::BoundExceeded
    );
}

#[test]
fn input_hash_verification_matches_or_returns_mismatch() {
    let input = b"exact input content for token accounting";
    let valid_hash = Sha256Digest::digest_bytes(input);
    let invalid_hash = Sha256Digest::digest_bytes(b"tampered or different content");

    assert_eq!(check_input_hash(input, &valid_hash), Ok(()));
    assert_eq!(
        check_input_hash(input, &invalid_hash),
        Err(TokenAccountingError::InputHashMismatch)
    );
}

#[test]
fn token_manifest_digest_is_protocol_owned() {
    let from_token = Sha256Digest::digest_bytes(b"token-manifest");
    let from_protocol = praana_core::protocol::id::Sha256Digest::digest_bytes(b"token-manifest");
    assert_eq!(from_token.as_str(), from_protocol.as_str());
    let preserved = Sha256Digest::from_bytes([0xab; 32]);
    assert_ne!(preserved.as_str(), from_protocol.as_str());
}

#[test]
fn compaction_source_turn_uses_protocol_ulid() {
    let turn_id =
        praana_core::protocol::id::TurnId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV")
            .unwrap();
    let context = TokenEstimationContext::CompactionSourceTurn { turn_id };
    match context {
        TokenEstimationContext::CompactionSourceTurn { turn_id } => {
            assert_eq!(turn_id.as_str(), "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        }
        _ => panic!("expected compaction source turn"),
    }
}

#[test]
fn image_fixed_per_item_contribution_checks_overflow() {
    use praana_core::token::ImageTokenOccupancyV1;

    let occupancy = ImageTokenOccupancyV1::fixed_per_image(4).unwrap();
    assert_eq!(occupancy.image_contribution(3).unwrap(), 12);
    let framing = FramingProfileV1 {
        framing_profile_schema_version: 1,
        framing_profile_id: "test:image".to_string(),
        fixed_tokens: 1,
        per_item_tokens: 0,
        item_count: 0,
        additional_tokens: occupancy.image_contribution(3).unwrap(),
    };
    assert_eq!(framing.calculate_framing_tokens().unwrap(), 13);
    assert!(ImageTokenOccupancyV1::fixed_per_image(0).is_err());
    assert!(serde_json::from_str::<ImageTokenOccupancyV1>(
        r#"{"type":"fixed_per_image","tokens_per_image":0}"#
    )
    .is_err());
    let parsed = serde_json::from_str::<ImageTokenOccupancyV1>(
        r#"{"type":"fixed_per_image","tokens_per_image":4}"#,
    )
    .unwrap();
    assert_eq!(parsed.tokens_per_image(), 4);
    let huge = ImageTokenOccupancyV1::fixed_per_image(u64::MAX).unwrap();
    assert_eq!(
        huge.image_contribution(2).unwrap_err(),
        TokenAccountingError::Overflow
    );
}

/// A temp `PRAANA_HOME` that is never the real `~/.praana`.
fn temp_calibration_home() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temp PRAANA_HOME");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
            .expect("private home");
    }
    assert_temp_praana_home(dir.path());
    dir
}

fn assert_temp_praana_home(home: &std::path::Path) {
    if let Ok(user_home) = std::env::var("HOME") {
        let real = std::path::PathBuf::from(user_home).join(".praana");
        assert_ne!(
            home, real,
            "calibration tests must not use the real ~/.praana"
        );
        assert!(
            !home.starts_with(&real),
            "calibration tests must not write under the real ~/.praana: {}",
            home.display()
        );
    }
    let temp = std::env::temp_dir();
    assert!(
        home.starts_with(&temp),
        "PRAANA_HOME {} is not under {}",
        home.display(),
        temp.display()
    );
}

#[allow(clippy::too_many_arguments)]
fn stored_sample(
    provider: &str,
    protocol: &str,
    model: &str,
    revision: Option<&str>,
    estimator_id: &str,
    nonce: u64,
    estimated: u64,
    reported: u64,
) -> TokenCalibrationSampleV1 {
    TokenCalibrationSampleV1::new(
        provider.to_owned(),
        protocol.to_owned(),
        model.to_owned(),
        revision.map(str::to_owned),
        estimator_id.to_owned(),
        Sha256Digest::digest_bytes(&nonce.to_le_bytes()),
        estimated,
        reported,
        None,
        0,
        1_700_000_000_000 + i64::try_from(nonce).unwrap_or(i64::MAX),
    )
    .expect("sample")
}

fn margin_of(samples: &[TokenCalibrationSampleV1]) -> u64 {
    let mut bucket = TokenCalibrationBucket::new(128);
    for sample in samples {
        bucket.add_sample(sample.clone());
    }
    bucket.calculate_calibration_margin_c().unwrap()
}

/// Samples written through one home are visible to a later open of that same
/// home, and `C` is the Token Accounting margin (0 below 20, else p95 + 128).
#[test]
fn calibration_store_feeds_c_across_sessions() {
    use praana_core::token::{
        append_sample, calibration_store_path, load_bucket, CalibrationBucketKey,
    };

    let home = temp_calibration_home();
    let path = calibration_store_path(home.path());
    assert_eq!(path, home.path().join("calibration.db"));
    let key = CalibrationBucketKey::from_parts(
        "openai",
        "openai-responses-v1",
        "gpt-5",
        None,
        "praana-generic-unicode-15.1-v1",
    );

    for nonce in 0..20 {
        let sample = stored_sample(
            "openai",
            "openai-responses-v1",
            "gpt-5",
            None,
            "praana-generic-unicode-15.1-v1",
            nonce,
            100,
            100 + nonce + 1,
        );
        append_sample(home.path(), &sample).expect("append comparable sample");
    }

    // A second open is what the next session does. It must not reuse an
    // in-memory bucket from the writer.
    let loaded = load_bucket(home.path(), &key);
    assert_eq!(loaded.len(), 20);
    assert_eq!(loaded[0].positive_error_tokens, 1);
    assert_eq!(loaded[19].positive_error_tokens, 20);
    // Sorted errors 1..=20. Rank ceil(0.95*20) = 19, value 19, C = 147.
    assert_eq!(margin_of(&loaded), 147);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::symlink_metadata(&path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "calibration.db is private");
        let parent = std::fs::symlink_metadata(home.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(parent, 0o700, "PRAANA_HOME is private");
    }
}

fn bucket_key(
    provider: &str,
    protocol: &str,
    model: &str,
    revision: Option<&str>,
    estimator_id: &str,
) -> CalibrationBucketKey {
    CalibrationBucketKey::from_parts(
        provider,
        protocol,
        model,
        revision.map(str::to_owned),
        estimator_id,
    )
}

const STORE_PROVIDER: &str = "openai";
const STORE_PROTOCOL: &str = "openai-responses-v1";
const STORE_MODEL: &str = "gpt-5";
const STORE_ESTIMATOR: &str = "praana-generic-unicode-15.1-v1";

fn append_errors(home: &std::path::Path, count: u64) {
    use praana_core::token::append_sample;
    for nonce in 0..count {
        let sample = stored_sample(
            STORE_PROVIDER,
            STORE_PROTOCOL,
            STORE_MODEL,
            None,
            STORE_ESTIMATOR,
            nonce,
            100,
            100 + nonce + 1,
        );
        append_sample(home, &sample).expect("append");
    }
}

fn primary_key() -> CalibrationBucketKey {
    bucket_key(
        STORE_PROVIDER,
        STORE_PROTOCOL,
        STORE_MODEL,
        None,
        STORE_ESTIMATOR,
    )
}

#[test]
fn calibration_store_nineteen_samples_keep_c_at_zero() {
    use praana_core::token::load_bucket;
    let home = temp_calibration_home();
    append_errors(home.path(), 19);
    let loaded = load_bucket(home.path(), &primary_key());
    assert_eq!(loaded.len(), 19);
    assert_eq!(margin_of(&loaded), 0);
}

#[test]
fn calibration_store_keeps_latest_128_per_key() {
    use praana_core::token::load_bucket;
    let home = temp_calibration_home();
    append_errors(home.path(), 129);
    let loaded = load_bucket(home.path(), &primary_key());
    assert_eq!(loaded.len(), 128);
    // Nonce 0 (positive error 1) is the oldest and is evicted.
    assert_eq!(loaded[0].positive_error_tokens, 2);
    assert_eq!(loaded[127].positive_error_tokens, 129);
    assert!(loaded
        .iter()
        .all(|sample| sample.positive_error_tokens != 1));
}

#[test]
fn calibration_store_isolates_bucket_keys() {
    use praana_core::token::{append_sample, load_bucket};

    let home = temp_calibration_home();
    append_errors(home.path(), 20);
    let primary = load_bucket(home.path(), &primary_key());
    assert_eq!(margin_of(&primary), 147);

    let variants = [
        (
            "other-provider",
            STORE_PROTOCOL,
            STORE_MODEL,
            None,
            STORE_ESTIMATOR,
        ),
        (
            STORE_PROVIDER,
            "openai-chat-v1",
            STORE_MODEL,
            None,
            STORE_ESTIMATOR,
        ),
        (
            STORE_PROVIDER,
            STORE_PROTOCOL,
            STORE_MODEL,
            Some("rev-a"),
            STORE_ESTIMATOR,
        ),
        (
            STORE_PROVIDER,
            STORE_PROTOCOL,
            STORE_MODEL,
            None,
            "other-estimator",
        ),
        (
            STORE_PROVIDER,
            STORE_PROTOCOL,
            "gpt-other",
            None,
            STORE_ESTIMATOR,
        ),
    ];
    for (index, (provider, protocol, model, revision, estimator)) in variants.iter().enumerate() {
        let sample = stored_sample(
            provider,
            protocol,
            model,
            *revision,
            estimator,
            1_000 + index as u64,
            100,
            180,
        );
        append_sample(home.path(), &sample).expect("append other key");
        let key = bucket_key(provider, protocol, model, *revision, estimator);
        let loaded = load_bucket(home.path(), &key);
        assert_eq!(
            loaded.len(),
            1,
            "key {provider}/{protocol}/{model:?}/{revision:?}/{estimator}"
        );
        assert_eq!(margin_of(&loaded), 0);
    }

    // The original bucket is unchanged by the other keys.
    let primary = load_bucket(home.path(), &primary_key());
    assert_eq!(primary.len(), 20);
    assert_eq!(margin_of(&primary), 147);

    // A revision is the spec identity: two model names with the same revision
    // share one bucket. The model name joins the key only when revision is absent.
    for (index, model) in ["gpt-left", "gpt-right"].iter().enumerate() {
        for nonce in 0..10 {
            let sample = stored_sample(
                STORE_PROVIDER,
                STORE_PROTOCOL,
                model,
                Some("shared-rev"),
                STORE_ESTIMATOR,
                2_000 + (index as u64) * 10 + nonce,
                50,
                50 + nonce + 1,
            );
            append_sample(home.path(), &sample).expect("shared revision");
        }
    }
    let shared = bucket_key(
        STORE_PROVIDER,
        STORE_PROTOCOL,
        "gpt-left",
        Some("shared-rev"),
        STORE_ESTIMATOR,
    );
    let loaded = load_bucket(home.path(), &shared);
    assert_eq!(loaded.len(), 20);
    assert!(loaded.iter().any(|sample| sample.model == "gpt-left"));
    assert!(loaded.iter().any(|sample| sample.model == "gpt-right"));
    let other_rev = bucket_key(
        STORE_PROVIDER,
        STORE_PROTOCOL,
        "gpt-left",
        Some("other-rev"),
        STORE_ESTIMATOR,
    );
    assert!(load_bucket(home.path(), &other_rev).is_empty());
}

#[test]
fn calibration_store_drops_zero_reported_usage() {
    use praana_core::token::{append_sample, calibration_store_path, load_bucket};
    let home = temp_calibration_home();
    let zero = stored_sample(
        STORE_PROVIDER,
        STORE_PROTOCOL,
        STORE_MODEL,
        None,
        STORE_ESTIMATOR,
        1,
        100,
        0,
    );
    append_sample(home.path(), &zero).expect("zero usage is not a store failure");
    assert!(
        !calibration_store_path(home.path()).exists(),
        "a dropped sample does not create the store"
    );
    append_errors(home.path(), 1);
    let zero_again = stored_sample(
        STORE_PROVIDER,
        STORE_PROTOCOL,
        STORE_MODEL,
        None,
        STORE_ESTIMATOR,
        2,
        100,
        0,
    );
    append_sample(home.path(), &zero_again).unwrap();
    let loaded = load_bucket(home.path(), &primary_key());
    assert_eq!(loaded.len(), 1);
    assert!(loaded.iter().all(|sample| sample.reported_input_tokens > 0));
}

#[test]
fn calibration_store_two_writers_keep_128_without_busy() {
    use std::sync::{Arc, Barrier};
    use std::thread;

    use praana_core::token::{append_sample, load_bucket};

    let home = temp_calibration_home();
    let barrier = Arc::new(Barrier::new(2));
    let mut joins = Vec::new();
    for writer in 0..2u64 {
        let home_path = home.path().to_path_buf();
        let barrier = Arc::clone(&barrier);
        joins.push(thread::spawn(move || {
            barrier.wait();
            for step in 0..80u64 {
                let nonce = writer * 80 + step;
                let sample = stored_sample(
                    STORE_PROVIDER,
                    STORE_PROTOCOL,
                    STORE_MODEL,
                    None,
                    STORE_ESTIMATOR,
                    nonce,
                    100,
                    110,
                );
                append_sample(&home_path, &sample).unwrap_or_else(|error| {
                    panic!("writer {writer} sample {nonce} failed: {error}");
                });
            }
        }));
    }
    for join in joins {
        join.join().expect("writer thread");
    }
    let loaded = load_bucket(home.path(), &primary_key());
    assert_eq!(loaded.len(), 128);
    let nonces: std::collections::BTreeSet<u64> = loaded
        .iter()
        .map(|sample| {
            // timestamp_ms is 1_700_000_000_000 + nonce.
            u64::try_from(sample.timestamp_ms - 1_700_000_000_000).unwrap()
        })
        .collect();
    let expected: std::collections::BTreeSet<u64> = (32..160).collect();
    assert_eq!(nonces, expected);
}

/// Store failures are best-effort. The child process is what proves nothing
/// is written to stderr; this parent also checks the bytes itself so a panic
/// points at the case.
#[test]
fn calibration_store_failures_leave_the_file_unchanged() {
    let home = temp_calibration_home();
    exercise_store_failures(home.path());
}

#[test]
fn calibration_store_failure_child() {
    let Ok(home) = std::env::var("PRAANA_CALIBRATION_HOME") else {
        return;
    };
    if std::env::var("PRAANA_CALIBRATION_CHILD").as_deref() != Ok("failures") {
        return;
    }
    assert_temp_praana_home(std::path::Path::new(&home));
    exercise_store_failures(std::path::Path::new(&home));
}

#[test]
fn calibration_store_failures_print_nothing() {
    let home = temp_calibration_home();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "calibration_store_failure_child", "--nocapture"])
        .env("PRAANA_CALIBRATION_HOME", home.path())
        .env("PRAANA_CALIBRATION_CHILD", "failures")
        .output()
        .expect("spawn failure child");
    assert!(
        output.status.success(),
        "failure child failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "stderr must stay empty, got: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn exercise_store_failures(root: &std::path::Path) {
    use praana_core::token::{append_sample, calibration_store_path, load_bucket, try_load_bucket};

    let case = |name: &str| {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        dir
    };

    // Corrupt: not a database. Bytes stay identical and no sidecar appears.
    {
        let dir = case("corrupt");
        let path = calibration_store_path(&dir);
        let original = b"not-a-sqlite-database".to_vec();
        std::fs::write(&path, &original).unwrap();
        let sample = stored_sample(
            STORE_PROVIDER,
            STORE_PROTOCOL,
            STORE_MODEL,
            None,
            STORE_ESTIMATOR,
            7,
            10,
            40,
        );
        let error = append_sample(&dir, &sample).expect_err("corrupt store");
        assert_eq!(error.code, "CALIBRATION_STORE_CORRUPT");
        assert_eq!(error.to_string(), "CALIBRATION_STORE_CORRUPT");
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(!path.with_file_name("calibration.db-wal").exists());
        assert!(try_load_bucket(&dir, &primary_key()).is_err());
        assert!(load_bucket(&dir, &primary_key()).is_empty());
    }

    // Wrong schema version is not rewritten.
    {
        let dir = case("schema");
        let path = calibration_store_path(&dir);
        let script = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version=99'); c.execute('create table foreign_store(x)'); c.commit()";
        let status = std::process::Command::new("python3")
            .arg("-c")
            .arg(script)
            .arg(&path)
            .status()
            .expect("python3");
        assert!(
            status.success(),
            "python3 could not seed a foreign database"
        );
        let original = std::fs::read(&path).unwrap();
        let sample = stored_sample(
            STORE_PROVIDER,
            STORE_PROTOCOL,
            STORE_MODEL,
            None,
            STORE_ESTIMATOR,
            8,
            10,
            40,
        );
        let error = append_sample(&dir, &sample).expect_err("wrong version");
        assert_eq!(error.code, "CALIBRATION_STORE_SCHEMA");
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(load_bucket(&dir, &primary_key()).is_empty());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::{symlink, PermissionsExt};

        // Read-only valid store: C stays empty for this process's load and
        // the new sample is not written.
        {
            let dir = case("readonly");
            append_errors(&dir, 1);
            let path = calibration_store_path(&dir);
            let original = std::fs::read(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
            let sample = stored_sample(
                STORE_PROVIDER,
                STORE_PROTOCOL,
                STORE_MODEL,
                None,
                STORE_ESTIMATOR,
                50,
                10,
                90,
            );
            let error = append_sample(&dir, &sample).expect_err("read-only");
            assert_eq!(error.code, "CALIBRATION_STORE_READ_ONLY");
            assert!(load_bucket(&dir, &primary_key()).is_empty());
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), original);
            assert_eq!(load_bucket(&dir, &primary_key()).len(), 1);
        }

        // Unreadable store.
        {
            let dir = case("unreadable");
            append_errors(&dir, 1);
            let path = calibration_store_path(&dir);
            let original = std::fs::read(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
            let sample = stored_sample(
                STORE_PROVIDER,
                STORE_PROTOCOL,
                STORE_MODEL,
                None,
                STORE_ESTIMATOR,
                51,
                10,
                90,
            );
            let error = append_sample(&dir, &sample).expect_err("unreadable");
            assert_eq!(error.code, "CALIBRATION_STORE_IO");
            assert!(load_bucket(&dir, &primary_key()).is_empty());
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }

        // Symlink: do not follow it and do not rewrite the target.
        {
            let dir = case("symlink");
            let target = root.join("symlink-target");
            let original = b"calibration-target-bytes".to_vec();
            std::fs::write(&target, &original).unwrap();
            symlink(&target, calibration_store_path(&dir)).unwrap();
            let sample = stored_sample(
                STORE_PROVIDER,
                STORE_PROTOCOL,
                STORE_MODEL,
                None,
                STORE_ESTIMATOR,
                52,
                10,
                90,
            );
            let error = append_sample(&dir, &sample).expect_err("symlink");
            assert_eq!(error.code, "CALIBRATION_STORE_SYMLINK");
            assert_eq!(std::fs::read(&target).unwrap(), original);
            assert!(load_bucket(&dir, &primary_key()).is_empty());
            assert!(std::fs::symlink_metadata(calibration_store_path(&dir))
                .unwrap()
                .file_type()
                .is_symlink());
        }

        // Exclusive lock: the append waits out busy_timeout and returns the
        // locked code instead of surfacing SQLITE_BUSY.
        {
            let dir = case("locked");
            append_errors(&dir, 1);
            let path = calibration_store_path(&dir);
            let script = "import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1], timeout=0); c.execute('BEGIN EXCLUSIVE'); c.execute('select 1').fetchall(); time.sleep(12)";
            let mut holder = std::process::Command::new("python3")
                .arg("-c")
                .arg(script)
                .arg(&path)
                .spawn()
                .expect("python3 lock");
            std::thread::sleep(std::time::Duration::from_millis(400));
            let sample = stored_sample(
                STORE_PROVIDER,
                STORE_PROTOCOL,
                STORE_MODEL,
                None,
                STORE_ESTIMATOR,
                53,
                10,
                90,
            );
            let error = append_sample(&dir, &sample).expect_err("locked");
            let _ = holder.kill();
            let _ = holder.wait();
            assert_eq!(error.code, "CALIBRATION_STORE_LOCKED");
            assert!(!error.to_string().contains("SQLITE"));
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
            let loaded = load_bucket(&dir, &primary_key());
            assert_eq!(loaded.len(), 1);
            assert_eq!(loaded[0].timestamp_ms, 1_700_000_000_000);
        }
    }
}
