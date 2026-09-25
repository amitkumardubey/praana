//! P3A redaction transformation. Detector spans come from P1D unchanged.

use praana_core::protocol::id::Sha256Digest;
use praana_core::redaction::{
    redact_json_v1, redact_text_v1, RedactionError, SecretKind, REDACTION_VERSION,
};
use serde_json::json;

fn aws() -> String {
    "AKIA".to_owned() + &"A".repeat(16)
}

fn github() -> String {
    "ghp_".to_owned() + &"a".repeat(36)
}

fn gitlab() -> String {
    "glpat-".to_owned() + &"b".repeat(20)
}

fn anthropic() -> String {
    "sk-ant-".to_owned() + &"c".repeat(20)
}

fn openai() -> String {
    "sk-".to_owned() + &"d".repeat(20)
}

fn pem() -> String {
    "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----".to_owned()
}

fn assert_no_canary(text: &str) {
    for needle in [
        aws(),
        github(),
        gitlab(),
        anthropic(),
        openai(),
        "MIIB".into(),
    ] {
        assert!(!text.contains(&needle), "canary leaked");
    }
}

#[test]
fn replaces_every_detector_kind_with_exact_markers() {
    let cases = [
        (pem(), "[REDACTED:private-key]"),
        (aws(), "[REDACTED:aws-access-key]"),
        (github(), "[REDACTED:github-token]"),
        (gitlab(), "[REDACTED:gitlab-token]"),
        (anthropic(), "[REDACTED:anthropic-key]"),
        (openai(), "[REDACTED:openai-key]"),
        (
            format!("export API_KEY={}", "secretvalue"),
            "export API_KEY=[REDACTED:key-assignment]",
        ),
    ];
    for (input, expected) in cases {
        let out = redact_text_v1(&input).unwrap();
        assert_eq!(out.text, expected);
        assert_eq!(out.summary.redaction_version, REDACTION_VERSION);
        assert_eq!(out.summary.replacement_count, 1);
        assert_eq!(
            out.summary.input_sha256,
            Sha256Digest::digest_bytes(input.as_bytes())
        );
        assert_eq!(
            out.summary.output_sha256,
            Sha256Digest::digest_bytes(expected.as_bytes())
        );
        assert_no_canary(&out.text);
    }
}

#[test]
fn overlap_prefers_lower_precedence_number_then_longer_match() {
    let anthropic_over_openai = redact_text_v1(&anthropic()).unwrap();
    assert_eq!(
        anthropic_over_openai.summary.kinds,
        vec![SecretKind::AnthropicKey]
    );
    assert_eq!(anthropic_over_openai.text, "[REDACTED:anthropic-key]");

    let pem_over_assignment = format!("{}\nAPI_KEY={}\n", pem(), "secretvalue");
    let out = redact_text_v1(&pem_over_assignment).unwrap();
    assert!(out.text.starts_with("[REDACTED:private-key]"));
    assert!(out.text.contains("API_KEY=[REDACTED:key-assignment]"));
    assert_eq!(
        out.summary.kinds,
        vec![SecretKind::PrivateKey, SecretKind::KeyAssignment]
    );
}

#[test]
fn assignment_preserves_key_quotes_and_exempts_sha_and_ulid() {
    let quoted = redact_text_v1("password = \"secretvalue\"").unwrap();
    assert_eq!(quoted.text, "password = \"[REDACTED:key-assignment]\"");

    let sha = "a".repeat(40);
    let kept = redact_text_v1(&format!("API_KEY={sha}")).unwrap();
    assert_eq!(kept.text, format!("API_KEY={sha}"));
    assert_eq!(kept.summary.replacement_count, 0);

    let ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let kept_ulid = redact_text_v1(&format!("password={ulid}")).unwrap();
    assert_eq!(kept_ulid.summary.replacement_count, 0);
}

#[test]
fn duplicate_occurrences_count_and_kinds_are_unique_and_precedence_sorted() {
    let input = format!("{} {}", aws(), aws());
    let out = redact_text_v1(&input).unwrap();
    assert_eq!(out.summary.replacement_count, 2);
    assert_eq!(out.summary.kinds, vec![SecretKind::AwsAccessKey]);
    assert_eq!(
        out.text,
        "[REDACTED:aws-access-key] [REDACTED:aws-access-key]"
    );
}

#[test]
fn over_limit_assignment_line_replaces_value() {
    let value = "v".repeat(70_000);
    let input = format!("API_KEY={value}\n");
    let out = redact_text_v1(&input).unwrap();
    assert_eq!(out.text, "API_KEY=[REDACTED:key-assignment]\n");
    assert_eq!(out.summary.replacement_count, 1);
    assert_no_canary(&out.text);
}

#[test]
fn unterminated_pem_replaces_once_and_warns() {
    let input = "-----BEGIN PRIVATE KEY-----\nMIIB\n";
    let out = redact_text_v1(input).unwrap();
    assert_eq!(out.text, "[REDACTED:private-key]");
    assert!(out
        .warnings
        .iter()
        .any(|w| w == "REDACTION_UNTERMINATED_PRIVATE_KEY"));
    assert_no_canary(&out.text);
}

#[test]
fn structured_traversal_redacts_nested_strings_and_keeps_non_strings() {
    let value = json!({
        "z": [aws(), 1, true, null],
        "nested": {"b": github(), "a": "plain"}
    });
    let out = redact_json_v1(&value).unwrap();
    assert_eq!(out.value["z"][0], "[REDACTED:aws-access-key]");
    assert_eq!(out.value["z"][1], 1);
    assert_eq!(out.value["z"][2], true);
    assert!(out.value["z"][3].is_null());
    assert_eq!(out.value["nested"]["b"], "[REDACTED:github-token]");
    assert_eq!(out.value["nested"]["a"], "plain");
    assert_eq!(
        out.summary.kinds,
        vec![SecretKind::AwsAccessKey, SecretKind::GithubToken]
    );
    let rendered = serde_json::to_string(&out.value).unwrap();
    assert_no_canary(&rendered);
}

#[test]
fn structured_assignment_key_redacts_whole_non_exempt_value() {
    let value = json!({"api_key": "not a token", "note": "plain"});
    let out = redact_json_v1(&value).unwrap();
    assert_eq!(out.value["api_key"], "[REDACTED:key-assignment]");
    assert_eq!(out.value["note"], "plain");
    assert!(out.value.get("api_key").is_some());
}

#[test]
fn structured_depth_failure_is_fail_closed() {
    let mut value = json!("leaf");
    for _ in 0..70 {
        value = json!([value]);
    }
    let err = redact_json_v1(&value).unwrap_err();
    assert!(matches!(err, RedactionError::DepthExceeded));
    let rendered = err.to_string();
    assert!(!rendered.contains("leaf"));
}

#[test]
fn redaction_error_display_does_not_include_secret_bytes() {
    let err = RedactionError::Failed;
    assert!(!err.to_string().contains("AKIA"));
}
