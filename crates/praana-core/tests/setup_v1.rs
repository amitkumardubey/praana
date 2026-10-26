use praana_core::config::build_defaults;
use praana_core::credentials::load_store;
use praana_core::setup::{build_setup_status, SetupService};
use praana_core::ui_contract::json_data::{ModelId, ProviderId};
use praana_core::ui_contract::setup::{AuthState, SensitiveStringDto, SetupFieldId, SetupValueDto};
use std::collections::BTreeMap;

#[test]
fn setup_status_exposes_only_closed_registry_rows_and_auth_state() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let config = build_defaults(&home);
    let credentials = praana_core::credentials::CredentialStoreV1::empty();
    let status = build_setup_status(&config, &credentials, 0).unwrap();
    assert!(status.required);
    assert_eq!(status.providers.len(), 2);
    assert_eq!(status.authentication.len(), 2);
    assert!(status
        .authentication
        .iter()
        .all(|auth| auth.state == AuthState::Unauthenticated));
    assert!(status
        .missing_requirements
        .contains(&"llm.provider".to_owned()));
    assert!(status
        .missing_requirements
        .contains(&"llm.model".to_owned()));
}

#[test]
fn login_and_logout_persist_only_provider_identity_in_results() {
    let temp = tempfile::tempdir().unwrap();
    let service = SetupService::new(temp.path().join("home"));
    let login = service
        .login("openai", "credential-value-123".to_owned(), 1_000)
        .unwrap();
    assert_eq!(login.provider.as_str(), "openai");
    assert_eq!(login.state, AuthState::Authenticated);
    let login_json = serde_json::to_string(&login).unwrap();
    assert!(!login_json.contains("credential-value-123"));
    let ledger_bytes = std::fs::read(temp.path().join("home/ui-operations.db")).unwrap();
    assert!(!String::from_utf8_lossy(&ledger_bytes).contains("credential-value-123"));

    let logout = service.logout("openai").unwrap();
    assert_eq!(logout.state, AuthState::Unauthenticated);
    assert!(logout.authentication_required);
    let store = load_store(&service.credential_path()).unwrap();
    assert!(store.providers.is_empty());
}

#[test]
fn setup_apply_validates_profile_writes_secret_free_config_and_returns_active_model() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    let mut values = BTreeMap::new();
    values.insert(
        SetupFieldId("api_key".to_owned()),
        SetupValueDto::Secret(SensitiveStringDto::from("credential-value-123".to_owned())),
    );
    values.insert(
        SetupFieldId("base_url".to_owned()),
        SetupValueDto::Text("https://api.openai.com/v1".to_owned()),
    );
    values.insert(
        SetupFieldId("protocol".to_owned()),
        SetupValueDto::Choice("openai-responses-v1".to_owned()),
    );
    values.insert(
        SetupFieldId("reasoning_effort".to_owned()),
        SetupValueDto::Choice("high".to_owned()),
    );
    let result = service
        .apply(
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            values,
            2_000,
        )
        .unwrap();
    assert_eq!(result.revision, 1);
    assert_eq!(result.configured_provider.as_str(), "openai");
    assert_eq!(result.active_model.model_id.as_str(), "gpt-5.6-sol");
    assert_eq!(result.active_model.context_window_tokens, 1_050_000);
    assert!(result.restart_required);

    let config = std::fs::read_to_string(home.join("praana.config.json")).unwrap();
    assert!(!config.contains("credential-value-123"));
    assert!(config.contains("gpt-5.6-sol"));
    assert!(config.contains("compactor_provider"));
    let operation_bytes = std::fs::read(home.join("ui-operations.db")).unwrap();
    assert!(!String::from_utf8_lossy(&operation_bytes).contains("credential-value-123"));
    let credentials = load_store(&home.join("credentials.json")).unwrap();
    assert_eq!(
        credentials.credential_value("openai"),
        Some("credential-value-123")
    );
}

#[test]
fn setup_apply_replays_same_operation_id_without_reapplying() {
    use praana_core::ui_contract::ids::OperationId;
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    let mut values = BTreeMap::new();
    values.insert(
        SetupFieldId("api_key".to_owned()),
        SetupValueDto::Secret(SensitiveStringDto::from("credential-value-123".to_owned())),
    );
    values.insert(
        SetupFieldId("base_url".to_owned()),
        SetupValueDto::Text("https://api.openai.com/v1".to_owned()),
    );
    values.insert(
        SetupFieldId("protocol".to_owned()),
        SetupValueDto::Choice("openai-responses-v1".to_owned()),
    );
    values.insert(
        SetupFieldId("reasoning_effort".to_owned()),
        SetupValueDto::Choice("high".to_owned()),
    );
    let clone_values = |source: &BTreeMap<SetupFieldId, SetupValueDto>| {
        let mut copy = BTreeMap::new();
        for (field, value) in source {
            let copied = match value {
                SetupValueDto::Text(v) => SetupValueDto::Text(v.clone()),
                SetupValueDto::Choice(v) => SetupValueDto::Choice(v.clone()),
                SetupValueDto::Boolean(v) => SetupValueDto::Boolean(*v),
                SetupValueDto::Secret(v) => SetupValueDto::Secret(v.expose().to_owned().into()),
            };
            copy.insert(field.clone(), copied);
        }
        copy
    };

    let operation_id = OperationId(ulid::Ulid::generate());
    let first = service
        .apply_operation(
            operation_id,
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            clone_values(&values),
            2_000,
        )
        .unwrap();
    // Same operation id retried (as after a crash) replays the stored terminal
    // result without applying a second credential revision.
    let replay = service
        .apply_operation(
            operation_id,
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            clone_values(&values),
            3_000,
        )
        .unwrap();
    assert_eq!(first.revision, replay.revision);
    assert_eq!(replay.configured_provider.as_str(), "openai");
    let credentials = load_store(&home.join("credentials.json")).unwrap();
    assert_eq!(credentials.revision, first.revision);
}

fn openai_setup_values() -> BTreeMap<SetupFieldId, SetupValueDto> {
    let mut values = BTreeMap::new();
    values.insert(
        SetupFieldId("api_key".to_owned()),
        SetupValueDto::Secret(SensitiveStringDto::from("credential-value-123".to_owned())),
    );
    values.insert(
        SetupFieldId("base_url".to_owned()),
        SetupValueDto::Text("https://api.openai.com/v1".to_owned()),
    );
    values.insert(
        SetupFieldId("protocol".to_owned()),
        SetupValueDto::Choice("openai-responses-v1".to_owned()),
    );
    values.insert(
        SetupFieldId("reasoning_effort".to_owned()),
        SetupValueDto::Choice("high".to_owned()),
    );
    values
}

#[test]
fn setup_apply_writes_empty_compactor_pair_before_p5() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    let result = service
        .apply(
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            openai_setup_values(),
            2_000,
        )
        .unwrap();
    assert_eq!(result.revision, 1);

    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(home.join("praana.config.json")).unwrap())
            .unwrap();
    let history = config.get("history").expect("history section");
    assert_eq!(
        history.get("compactor_provider").and_then(|v| v.as_str()),
        Some(""),
        "compactor_provider must be empty before P5: {config}"
    );
    assert_eq!(
        history.get("compactor_model").and_then(|v| v.as_str()),
        Some(""),
        "compactor_model must be empty before P5: {config}"
    );
}

#[test]
fn setup_apply_accepts_valid_complete_compactor_pair() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    let mut values = openai_setup_values();
    values.insert(
        SetupFieldId("compactor_provider".to_owned()),
        SetupValueDto::Text("openai".to_owned()),
    );
    values.insert(
        SetupFieldId("compactor_model".to_owned()),
        SetupValueDto::Text("gpt-5.6-sol".to_owned()),
    );

    let result = service
        .apply(
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            values,
            2_000,
        )
        .expect("valid complete compactor pair must be accepted by setup");
    assert_eq!(result.revision, 1);

    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(home.join("praana.config.json")).unwrap())
            .unwrap();
    let history = config.get("history").expect("history section");
    assert_eq!(
        history.get("compactor_provider").and_then(|v| v.as_str()),
        Some("openai"),
        "compactor_provider must be written: {config}"
    );
    assert_eq!(
        history.get("compactor_model").and_then(|v| v.as_str()),
        Some("gpt-5.6-sol"),
        "compactor_model must be written: {config}"
    );
    assert!(!config.to_string().contains("credential-value-123"));
}

#[test]
fn setup_apply_rejects_one_sided_compactor_pair() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());

    for (name, field) in [
        ("provider_only", "compactor_provider"),
        ("model_only", "compactor_model"),
    ] {
        let mut values = openai_setup_values();
        values.insert(
            SetupFieldId(field.to_owned()),
            SetupValueDto::Text("openai".to_owned()),
        );
        let error = service
            .apply(
                0,
                ProviderId::from_canonical_str("openai").unwrap(),
                ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
                values,
                2_000,
            )
            .expect_err("one-sided compactor pair must be rejected");
        assert!(
            error
                .to_string()
                .contains("compactor_provider and compactor_model must be supplied together"),
            "{name}: expected the one-sided message, got {error}"
        );
        assert!(
            !home.join("praana.config.json").exists(),
            "{name}: no config must be written on rejection"
        );
    }
}

// --- R1: setup must not persist anything when the creation gate rejects ---

use praana_core::credentials::credentials_path;
use praana_core::ui_contract::ids::OperationId;

/// Snapshot of the on-disk credential store and config after an apply attempt.
/// A rejected apply must leave the credential store byte-identical (or absent)
/// and must not write the config file at all.
struct PersistenceSnapshot {
    credentials: Option<Vec<u8>>,
    config_exists: bool,
}

fn snapshot_persistence(home: &std::path::Path) -> PersistenceSnapshot {
    PersistenceSnapshot {
        credentials: std::fs::read(credentials_path(home)).ok(),
        config_exists: home.join("praana.config.json").exists(),
    }
}

fn compactor_values(
    secret: Option<&str>,
    compactor_provider: &str,
    compactor_model: &str,
) -> BTreeMap<SetupFieldId, SetupValueDto> {
    let mut values = BTreeMap::new();
    if let Some(secret) = secret {
        values.insert(
            SetupFieldId("api_key".to_owned()),
            SetupValueDto::Secret(SensitiveStringDto::from(secret.to_owned())),
        );
    }
    values.insert(
        SetupFieldId("base_url".to_owned()),
        SetupValueDto::Text("https://api.openai.com/v1".to_owned()),
    );
    values.insert(
        SetupFieldId("protocol".to_owned()),
        SetupValueDto::Choice("openai-responses-v1".to_owned()),
    );
    values.insert(
        SetupFieldId("reasoning_effort".to_owned()),
        SetupValueDto::Choice("high".to_owned()),
    );
    values.insert(
        SetupFieldId("compactor_provider".to_owned()),
        SetupValueDto::Text(compactor_provider.to_owned()),
    );
    values.insert(
        SetupFieldId("compactor_model".to_owned()),
        SetupValueDto::Text(compactor_model.to_owned()),
    );
    values
}

/// The shared creation gate must reject before save_store for every reachable
/// rejection class. Bundled windows cannot reach admission failure through setup;
/// config_v1 exercises that gate directly with a deliberately shrunk profile.
#[test]
fn setup_apply_gate_rejections_precede_save_store() {
    for (provider, model, reason) in [
        (
            "openrouter",
            "openai/gpt-5.6-sol",
            "no credential is available",
        ),
        ("openai", "not-a-real-model", "no trusted window"),
        ("openrouter", "review/no-window", "no trusted window"),
        (
            "openrouter",
            "review/no-strict",
            "does not support strict JSON schema",
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let service = SetupService::new(home.clone());
        // Known live rows distinguish an unresolved window from an unknown model.
        let cache = serde_json::json!({
            "schema_version": 1, "provider": "openrouter",
            "endpoint_fingerprint": praana_core::provider::endpoint_fingerprint(
                "https://openrouter.ai/api/v1").unwrap(),
            "fetched_at_ms": 2000, "expires_at_ms": 21602000,
            "etag": null, "body_sha256": praana_core::token::Sha256Digest::digest_bytes(b"catalog"),
            "models": [
                {"provider": "openrouter", "model_id": "review/no-window",
                 "display_name": "No window", "context_length": null,
                 "max_completion_tokens": 8192, "supported_parameters": [], "reasoning_efforts": []},
                {"provider": "openrouter", "model_id": "review/no-strict",
                 "display_name": "No strict schema", "context_length": 65536,
                 "max_completion_tokens": 8192, "supported_parameters": [], "reasoning_efforts": []}
            ]
        });
        let path = praana_core::provider::catalog_cache_path(&home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&cache).unwrap()).unwrap();
        let before = snapshot_persistence(&home);
        let error = service
            .apply_operation_with_env(
                OperationId(ulid::Ulid::generate()),
                0,
                ProviderId::from_canonical_str("openai").unwrap(),
                ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
                compactor_values(Some("pending-not-to-be-saved"), provider, model),
                2000,
                &BTreeMap::new(),
            )
            .expect_err("the gate must reject before saving the pending credential");
        assert!(
            error.to_string().contains("SETUP_CONFIG_INVALID"),
            "{error}"
        );
        assert!(
            error.to_string().contains(reason),
            "{provider}/{model}: {error}"
        );
        let after = snapshot_persistence(&home);
        assert_eq!(
            after.credentials, before.credentials,
            "{provider}/{model}: gate must precede save_store, including its revision bump"
        );
        assert!(!after.config_exists);
        assert_eq!(load_store(&credentials_path(&home)).unwrap().revision, 0);
    }
}

#[test]
fn setup_apply_same_operation_retries_after_credential_repair_exactly_once() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    let operation = OperationId(ulid::Ulid::generate());
    let values = || {
        compactor_values(
            Some("pending-openai-key"),
            "openrouter",
            "openai/gpt-5.6-sol",
        )
    };
    let apply = |env: &BTreeMap<String, String>| {
        service.apply_operation_with_env(
            operation,
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            values(),
            2000,
            env,
        )
    };
    let error = apply(&BTreeMap::new()).unwrap_err();
    assert!(
        error.to_string().contains("no credential is available"),
        "{error}"
    );
    assert_eq!(load_store(&credentials_path(&home)).unwrap().revision, 0);
    let repaired = BTreeMap::from([("OPENROUTER_API_KEY".into(), "repaired-key".into())]);
    let result = apply(&repaired).expect("byte-identical retry continues its reservation");
    assert_eq!(result.revision, 1);
    let saved = std::fs::read(credentials_path(&home)).unwrap();
    let replay = apply(&BTreeMap::new()).expect("terminal result replays even without the repair");
    assert_eq!(replay.revision, 1);
    assert_eq!(std::fs::read(credentials_path(&home)).unwrap(), saved);
    assert_eq!(load_store(&credentials_path(&home)).unwrap().revision, 1);
}

/// R1: after a gate rejection, a retry with the SAME `expected_revision` and a
/// corrected pair succeeds. A rejection must not have bumped the stored
/// revision, so the retry does not hit `RevisionConflict`.
#[test]
fn setup_apply_retry_after_gate_rejection_same_revision_succeeds() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    let mut env = BTreeMap::new();
    env.insert("OPENAI_API_KEY".to_owned(), "sk-test-key".to_owned());

    // First attempt: rejected (unknown compactor model).
    let bad = compactor_values(Some("credential-value-123"), "openai", "not-a-real-model");
    service
        .apply_operation_with_env(
            OperationId(ulid::Ulid::generate()),
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            bad,
            2_000,
            &env,
        )
        .expect_err("first attempt must be rejected");

    // Retry with the SAME expected_revision (0) and a corrected pair.
    let good = compactor_values(Some("credential-value-123"), "openai", "gpt-5.6-sol");
    let result = service
        .apply_operation_with_env(
            OperationId(ulid::Ulid::generate()),
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            good,
            3_000,
            &env,
        )
        .expect("retry with the same expected_revision must not hit RevisionConflict");
    assert_eq!(result.revision, 1);
}

/// R1: the overlay works — a compactor provider equal to the active provider
/// with a NEW secret supplied in the same apply is accepted, even though the
/// gate runs before the credential is saved. The overlay must make the pending
/// secret visible to the gate.
#[test]
fn setup_apply_overlay_same_provider_new_secret_accepted() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    // No OPENAI_API_KEY in the env and no store row yet: only the pending
    // secret can satisfy credential presence for the compactor.
    let values = compactor_values(Some("credential-value-123"), "openai", "gpt-5.6-sol");
    let result = service
        .apply_operation_with_env(
            OperationId(ulid::Ulid::generate()),
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            values,
            2_000,
            &BTreeMap::new(),
        )
        .expect("overlay must make the pending secret visible to the gate");
    assert_eq!(result.revision, 1);
    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(home.join("praana.config.json")).unwrap())
            .unwrap();
    let history = config.get("history").expect("history section");
    assert_eq!(
        history.get("compactor_provider").and_then(|v| v.as_str()),
        Some("openai")
    );
    assert!(!config.to_string().contains("credential-value-123"));
    let credentials = load_store(&credentials_path(&home)).unwrap();
    assert_eq!(
        credentials.credential_value("openai"),
        Some("credential-value-123")
    );
}

// --- R2: setup apply must not panic on a non-Unicode environment ---

/// `apply` ignores non-UTF-8 environment pairs. Inject the invalid value at
/// child creation, never by mutating the threaded test runner's environment.
///
/// Unix-only: a non-UTF-8 `OsString` cannot be constructed portably, and the
/// panic is specific to `std::env::vars()`.
#[cfg(unix)]
#[test]
fn setup_apply_does_not_panic_on_non_utf8_env() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    if std::env::var_os("PRAANA_SETUP_NON_UTF8_CHILD").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "setup_apply_does_not_panic_on_non_utf8_env",
                "--nocapture",
            ])
            .env("PRAANA_SETUP_NON_UTF8_CHILD", "1")
            .env(
                "PRAANA_SETUP_NON_UTF8_TEST",
                OsStr::from_bytes(&[b'x', 0xFF, b'y']),
            )
            .output()
            .expect("spawn isolated non-UTF-8 child");
        assert!(
            output.status.success(),
            "non-UTF-8 child failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    // A valid openai apply. The non-UTF-8 var in the environment must be
    // skipped, not panic. The apply itself should succeed.
    let result = service.apply(
        0,
        ProviderId::from_canonical_str("openai").unwrap(),
        ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
        openai_setup_values(),
        2_000,
    );

    let result = result.expect("apply must not panic on a non-UTF-8 env var");
    assert_eq!(result.revision, 1);
}
