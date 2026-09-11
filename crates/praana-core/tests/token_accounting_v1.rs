use praana_core::token::{
    calculate_batch_inline_decisions, calculate_request_component_manifest, check_component_bound,
    check_input_hash, is_eligible_for_inline, FramingProfileV1, GenericTokenEstimatorV1,
    RequestComponentKind, Sha256Digest, TokenAccountingError, TokenCalibrationBucket,
    TokenCalibrationSampleV1, TokenEstimateV1, TokenEstimationContext, TokenEstimatorV1,
    TokenProfileStoreV1, TurnId,
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
            Sha256Digest::from_bytes(input.as_bytes())
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
    assert_eq!(estimate.input_sha256, Sha256Digest::from_bytes(&bytes));
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
        input_sha256: Sha256Digest::from_bytes(b"test"),
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
            Sha256Digest::from_bytes(b"req"),
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
        Sha256Digest::from_bytes(b"req"),
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
        Sha256Digest::from_bytes(b"req"),
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
        Sha256Digest::from_bytes(b"req"),
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
    let turn_id = TurnId("01ARZ3NDEKTSV4RRFFQ69G5FAV".to_string());
    let ctx = TokenEstimationContext::CompactionSourceTurn {
        turn_id: turn_id.clone(),
    };
    let json = serde_json::to_string(&ctx).unwrap();
    assert!(json.contains("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
}

#[test]
fn component_bound_exact_limit_and_plus_one() {
    let estimate_exact = TokenEstimateV1 {
        token_estimator_schema_version: 1,
        estimator_id: "praana-generic-unicode-15.1-v1".to_string(),
        tokenizer_profile_id: None,
        input_sha256: Sha256Digest::from_bytes(b"exact"),
        content_tokens: 160,
        framing_tokens: 0,
        total_tokens: 160,
    };

    let estimate_plus_one = TokenEstimateV1 {
        token_estimator_schema_version: 1,
        estimator_id: "praana-generic-unicode-15.1-v1".to_string(),
        tokenizer_profile_id: None,
        input_sha256: Sha256Digest::from_bytes(b"plus_one"),
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
    let valid_hash = Sha256Digest::from_bytes(input);
    let invalid_hash = Sha256Digest::from_bytes(b"tampered or different content");

    assert_eq!(check_input_hash(input, &valid_hash), Ok(()));
    assert_eq!(
        check_input_hash(input, &invalid_hash),
        Err(TokenAccountingError::InputHashMismatch)
    );
}
