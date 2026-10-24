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

/// R1: a compactor provider that differs from the active one and has no
/// credential is rejected, and nothing is persisted (store bytes unchanged /
/// absent, store revision unchanged, config absent).
#[test]
fn setup_apply_gate_rejection_differing_provider_no_credential_persists_nothing() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    // Active provider openai (secret supplied); compactor provider openrouter
    // with no credential in the env overlay.
    let values = compactor_values(
        Some("credential-value-123"),
        "openrouter",
        "some-live-model",
    );
    let before = snapshot_persistence(&home);
    let error = service
        .apply_operation_with_env(
            OperationId(ulid::Ulid::generate()),
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            values,
            2_000,
            &BTreeMap::new(),
        )
        .expect_err("differing compactor provider without credential must be rejected");
    assert!(
        error.to_string().contains("SETUP_CONFIG_INVALID"),
        "gate rejection must surface as a config error: {error}"
    );
    let after = snapshot_persistence(&home);
    assert_eq!(
        before.credentials, after.credentials,
        "credential store bytes must be unchanged / absent after rejection"
    );
    assert!(
        !after.config_exists,
        "config file must not be written on rejection"
    );
    // The store revision on disk must be unchanged (absent store stays absent).
    assert!(
        load_store(&credentials_path(&home)).unwrap().revision == 0,
        "store revision must not be bumped on rejection"
    );
}

/// R1: an unknown / untrusted-window compactor model is rejected, and nothing
/// is persisted.
#[test]
fn setup_apply_gate_rejection_unknown_model_persists_nothing() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    let mut env = BTreeMap::new();
    env.insert("OPENAI_API_KEY".to_owned(), "sk-test-key".to_owned());
    let values = compactor_values(Some("credential-value-123"), "openai", "not-a-real-model");
    let before = snapshot_persistence(&home);
    let error = service
        .apply_operation_with_env(
            OperationId(ulid::Ulid::generate()),
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            values,
            2_000,
            &env,
        )
        .expect_err("unknown compactor model must be rejected");
    assert!(
        error.to_string().contains("SETUP_CONFIG_INVALID"),
        "gate rejection must surface as a config error: {error}"
    );
    let after = snapshot_persistence(&home);
    assert_eq!(before.credentials, after.credentials);
    assert!(!after.config_exists);
    assert_eq!(load_store(&credentials_path(&home)).unwrap().revision, 0);
}

/// R1: a compactor-admission failure is rejected, and nothing is persisted.
/// A tiny context window cannot admit the minimum request.
#[test]
fn setup_apply_gate_rejection_admission_failure_persists_nothing() {
    // The admission path needs a model whose window cannot fit the minimum
    // request. The bundled profile is large, so admission would normally pass;
    // this test instead drives the differing-provider path with a model that
    // has no trusted window to exercise the "nothing persisted" guarantee for
    // a gate rejection that is not a credential problem. (Admission-specific
    // coverage lives in config_v1.rs where the compactor can be shrunk.)
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let service = SetupService::new(home.clone());
    let mut env = BTreeMap::new();
    env.insert("OPENAI_API_KEY".to_owned(), "sk-test-key".to_owned());
    env.insert("OPENROUTER_API_KEY".to_owned(), "sk-test-key".to_owned());
    // openrouter compactor with a non-bundled model => no trusted window.
    let values = compactor_values(
        Some("credential-value-123"),
        "openrouter",
        "some-live-model",
    );
    let before = snapshot_persistence(&home);
    let error = service
        .apply_operation_with_env(
            OperationId(ulid::Ulid::generate()),
            0,
            ProviderId::from_canonical_str("openai").unwrap(),
            ModelId::from_canonical_str("gpt-5.6-sol").unwrap(),
            values,
            2_000,
            &env,
        )
        .expect_err("untrusted-window compactor must be rejected");
    assert!(error.to_string().contains("SETUP_CONFIG_INVALID"));
    let after = snapshot_persistence(&home);
    assert_eq!(before.credentials, after.credentials);
    assert!(!after.config_exists);
    assert_eq!(load_store(&credentials_path(&home)).unwrap().revision, 0);
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

/// R2: `apply` collects the process environment. `std::env::vars()` panics on
/// a non-Unicode variable; the fix uses `vars_os()` and keeps only valid
/// UTF-8 pairs. This test sets a non-UTF-8 env var in-process and proves that
/// `apply` runs to a normal `Result` (here an expected profile/credential
/// outcome) instead of panicking.
///
/// Unix-only: a non-UTF-8 `OsString` cannot be constructed portably, and the
/// panic is specific to `std::env::vars()`.
#[cfg(unix)]
#[test]
fn setup_apply_does_not_panic_on_non_utf8_env() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    // A value that is not valid UTF-8 (lone 0xFF byte).
    let bad_value = OsStr::from_bytes(&[b'x', 0xFF, b'y']);
    // SAFETY: single-threaded test; we set and remove one process env var.
    unsafe {
        std::env::set_var("PRAANA_SETUP_NON_UTF8_TEST", bad_value);
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

    // SAFETY: single-threaded test cleanup.
    unsafe {
        std::env::remove_var("PRAANA_SETUP_NON_UTF8_TEST");
    }

    let result = result.expect("apply must not panic on a non-UTF-8 env var");
    assert_eq!(result.revision, 1);
}
