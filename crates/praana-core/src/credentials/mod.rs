//! Credential store and resolution (P2A).

pub mod store;

pub use store::{
    credentials_path, load_store, remove_credential, resolve_credential, resolve_from_process_env,
    save_store, upsert_credential, validate_credential_value, CredentialSource,
    CredentialStoreError, CredentialStoreV1, OwnedResolvedCredential, ResolvedCredential,
    StoredCredentialV1, CREDENTIAL_MAX_BYTES, CREDENTIAL_STORE_SCHEMA_VERSION, REDACTION_MARKER,
};
