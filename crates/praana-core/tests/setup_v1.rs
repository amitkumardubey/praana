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
            !std::fs::read_to_string(home.join("praana.config.json"))
                .map(|text| text.contains("compactor_provider"))
                .unwrap_or(false),
            "{name}: no config must be written on rejection"
        );
    }
}
