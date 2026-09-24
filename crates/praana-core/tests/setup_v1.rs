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
