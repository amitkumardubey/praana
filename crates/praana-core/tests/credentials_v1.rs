use praana_core::credentials::{
    load_store, resolve_credential, save_store, upsert_credential, validate_credential_value,
    CredentialSource, CredentialStoreError, CredentialStoreV1,
};
use std::collections::BTreeMap;

#[test]
fn credential_store_round_trips_atomically_with_revision_and_redacted_debug() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("home/credentials.json");
    let mut store = CredentialStoreV1::empty();
    upsert_credential(
        &mut store,
        "openai",
        "credential-value-123".to_owned(),
        1_000,
    )
    .unwrap();
    assert_eq!(store.revision, 1);
    save_store(&path, &store).unwrap();

    let loaded = load_store(&path).unwrap();
    assert_eq!(loaded, store);
    let debug = format!("{loaded:?}");
    assert!(!debug.contains("credential-value-123"));
    assert!(debug.contains("openai"));
    let bytes = std::fs::read(&path).unwrap();
    assert!(bytes.ends_with(b"\n"));
}

#[test]
fn credential_resolution_uses_explicit_then_store_then_exact_environment() {
    let mut store = CredentialStoreV1::empty();
    upsert_credential(&mut store, "openai", "stored-value-123".to_owned(), 1_000).unwrap();
    let mut env = BTreeMap::new();
    env.insert(
        "OPENAI_API_KEY".to_owned(),
        "environment-value-123".to_owned(),
    );
    env.insert(
        "OPENROUTER_API_KEY".to_owned(),
        "router-value-123".to_owned(),
    );

    let explicit = resolve_credential(&store, "openai", Some("explicit-value-123"), &env).unwrap();
    assert_eq!(explicit.value, "explicit-value-123");
    assert_eq!(explicit.source, CredentialSource::Explicit);

    let persisted = resolve_credential(&store, "openai", None, &env).unwrap();
    assert_eq!(persisted.value, "stored-value-123");
    assert_eq!(persisted.source, CredentialSource::Store);

    let empty = CredentialStoreV1::empty();
    let environment = resolve_credential(&empty, "openrouter", None, &env).unwrap();
    assert_eq!(environment.value, "router-value-123");
    assert_eq!(environment.source, CredentialSource::Environment);
}

#[test]
fn credentials_reject_invalid_values_unknown_providers_and_missing_auth() {
    for invalid in ["", " leading", "trailing ", "line\nbreak", "[REDACTED]"] {
        assert!(matches!(
            validate_credential_value(invalid),
            Err(CredentialStoreError::InvalidCredential)
        ));
    }
    let mut store = CredentialStoreV1::empty();
    assert!(matches!(
        upsert_credential(&mut store, "anthropic", "value-123".to_owned(), 1_000),
        Err(CredentialStoreError::UnknownProvider(_))
    ));
    let env = BTreeMap::new();
    assert!(matches!(
        resolve_credential(&store, "openai", None, &env),
        Err(CredentialStoreError::CredentialMissing)
    ));
}

#[cfg(unix)]
#[test]
fn credential_parent_and_file_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("home/credentials.json");
    let mut store = CredentialStoreV1::empty();
    upsert_credential(
        &mut store,
        "openai",
        "credential-value-123".to_owned(),
        1_000,
    )
    .unwrap();
    save_store(&path, &store).unwrap();
    assert_eq!(
        std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn credential_boundaries_unicode_whitespace_and_resolved_debug_are_secret_safe() {
    let accepted = "x".repeat(16_384);
    assert!(validate_credential_value(&accepted).is_ok());
    assert!(matches!(
        validate_credential_value(&"x".repeat(16_385)),
        Err(CredentialStoreError::InvalidCredential)
    ));
    assert!(matches!(
        validate_credential_value("\u{2003}credential"),
        Err(CredentialStoreError::InvalidCredential)
    ));

    let store = CredentialStoreV1::empty();
    let mut env = BTreeMap::new();
    env.insert("OPENAI_API_KEY".to_owned(), "secret-value-123".to_owned());
    let resolved = resolve_credential(&store, "openai", None, &env).unwrap();
    assert!(!format!("{resolved:?}").contains("secret-value-123"));
    let owned = praana_core::credentials::resolve_from_process_env(
        &store,
        "openai",
        Some("secret-value-123"),
    )
    .unwrap();
    assert!(!format!("{owned:?}").contains("secret-value-123"));
}

#[cfg(unix)]
#[test]
fn existing_broad_credential_permissions_block_use() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("home/credentials.json");
    let mut store = CredentialStoreV1::empty();
    upsert_credential(&mut store, "openai", "secret-value-123".to_owned(), 1_000).unwrap();
    save_store(&path, &store).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        load_store(&path),
        Err(CredentialStoreError::UnsafePermissions(_))
    ));
}
