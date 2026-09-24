//! Private credential storage and provider-specific resolution.
//!
//! Credential values are only serialized in this module. All other public
//! surfaces expose provider IDs, revisions, or a borrowed value while a
//! caller is actively constructing an authenticated request.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

use crate::provider::provider_descriptor;
use crate::ui_contract::json_data::ProviderId;

pub const CREDENTIAL_STORE_SCHEMA_VERSION: u32 = 1;
pub const CREDENTIAL_MAX_BYTES: usize = 16_384;
pub const REDACTION_MARKER: &str = "[REDACTED]";

#[derive(PartialEq, Eq)]
pub enum StoredCredentialV1 {
    ApiKey {
        value: Zeroizing<String>,
        updated_at_ms: i64,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum WireStoredCredential {
    ApiKey { value: String, updated_at_ms: i64 },
}

impl Serialize for StoredCredentialV1 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let wire = match self {
            Self::ApiKey {
                value,
                updated_at_ms,
            } => WireStoredCredential::ApiKey {
                value: value.to_string(),
                updated_at_ms: *updated_at_ms,
            },
        };
        wire.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for StoredCredentialV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match WireStoredCredential::deserialize(deserializer)? {
            WireStoredCredential::ApiKey {
                value,
                updated_at_ms,
            } => Ok(Self::ApiKey {
                value: Zeroizing::new(value),
                updated_at_ms,
            }),
        }
    }
}

impl fmt::Debug for StoredCredentialV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ApiKey { updated_at_ms, .. } => formatter
                .debug_struct("ApiKey")
                .field("value", &"[REDACTED]")
                .field("updated_at_ms", updated_at_ms)
                .finish(),
        }
    }
}

impl fmt::Display for StoredCredentialV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ApiKey { updated_at_ms, .. } => {
                write!(
                    formatter,
                    "ApiKey([REDACTED], updated_at_ms={updated_at_ms})"
                )
            }
        }
    }
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CredentialStoreV1 {
    pub schema_version: u32,
    pub revision: u64,
    pub providers: BTreeMap<ProviderId, StoredCredentialV1>,
}

impl fmt::Debug for CredentialStoreV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialStoreV1")
            .field("schema_version", &self.schema_version)
            .field("revision", &self.revision)
            .field("providers", &self.providers.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl CredentialStoreV1 {
    pub fn empty() -> Self {
        Self {
            schema_version: CREDENTIAL_STORE_SCHEMA_VERSION,
            revision: 0,
            providers: BTreeMap::new(),
        }
    }

    pub fn validate(&self) -> Result<(), CredentialStoreError> {
        if self.schema_version != CREDENTIAL_STORE_SCHEMA_VERSION {
            return Err(CredentialStoreError::InvalidStore(
                "unsupported schema_version".to_owned(),
            ));
        }
        for (provider, credential) in &self.providers {
            if provider_descriptor(provider.as_str()).is_none() {
                return Err(CredentialStoreError::UnknownProvider(provider.to_string()));
            }
            match credential {
                StoredCredentialV1::ApiKey {
                    value,
                    updated_at_ms,
                } => {
                    validate_credential_value(value)?;
                    if *updated_at_ms <= 0 {
                        return Err(CredentialStoreError::InvalidStore(
                            "updated_at_ms must be positive".to_owned(),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    pub fn credential_value(&self, provider: &str) -> Option<&str> {
        self.providers
            .iter()
            .find(|(candidate, _)| candidate.as_str() == provider)
            .map(|(_, credential)| match credential {
                StoredCredentialV1::ApiKey { value, .. } => value.as_str(),
            })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CredentialStoreError {
    Io(String),
    UnsafePermissions(String),
    InvalidCredential,
    CredentialMissing,
    InvalidStore(String),
    UnknownProvider(String),
    RevisionOverflow,
    Serialization(String),
}

impl fmt::Display for CredentialStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(detail) => write!(formatter, "CREDENTIAL_STORE_IO: {detail}"),
            Self::UnsafePermissions(detail) => {
                write!(formatter, "CREDENTIAL_STORE_INSECURE_PERMISSIONS: {detail}")
            }
            Self::InvalidCredential => formatter.write_str("CREDENTIAL_INVALID"),
            Self::CredentialMissing => formatter.write_str("AUTH_CREDENTIAL_MISSING"),
            Self::InvalidStore(detail) => write!(formatter, "CREDENTIAL_STORE_INVALID: {detail}"),
            Self::UnknownProvider(provider) => write!(formatter, "PROVIDER_UNKNOWN: {provider}"),
            Self::RevisionOverflow => formatter.write_str("CREDENTIAL_REVISION_OVERFLOW"),
            Self::Serialization(detail) => {
                write!(formatter, "CREDENTIAL_STORE_SERIALIZE: {detail}")
            }
        }
    }
}

impl std::error::Error for CredentialStoreError {}

pub fn credentials_path(praana_home: &Path) -> PathBuf {
    praana_home.join("credentials.json")
}

pub fn validate_credential_value(value: &str) -> Result<(), CredentialStoreError> {
    if value.is_empty()
        || value.len() > CREDENTIAL_MAX_BYTES
        || value.contains('\0')
        || value.contains('\r')
        || value.contains('\n')
        || value == REDACTION_MARKER
        || value
            .chars()
            .next()
            .is_some_and(|character| character.is_whitespace())
        || value
            .chars()
            .next_back()
            .is_some_and(|character| character.is_whitespace())
    {
        return Err(CredentialStoreError::InvalidCredential);
    }
    Ok(())
}

#[cfg(unix)]
fn mode(path: &Path) -> Result<u32, CredentialStoreError> {
    use std::os::unix::fs::PermissionsExt;
    Ok(fs::symlink_metadata(path)
        .map_err(|error| CredentialStoreError::Io(error.to_string()))?
        .permissions()
        .mode()
        & 0o777)
}

#[cfg(unix)]
fn set_mode(path: &Path, expected: u32) -> Result<(), CredentialStoreError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(expected))
        .map_err(|error| CredentialStoreError::UnsafePermissions(error.to_string()))
}

#[cfg(not(unix))]
fn mode(path: &Path) -> Result<u32, CredentialStoreError> {
    let _ = path;
    Err(CredentialStoreError::UnsafePermissions(
        "current-user ACL verification is unavailable".to_owned(),
    ))
}

#[cfg(not(unix))]
fn set_mode(path: &Path, expected: u32) -> Result<(), CredentialStoreError> {
    let _ = (path, expected);
    Err(CredentialStoreError::UnsafePermissions(
        "current-user ACL enforcement is unavailable".to_owned(),
    ))
}

fn reject_symlink(path: &Path) -> Result<(), CredentialStoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                Err(CredentialStoreError::UnsafePermissions(format!(
                    "symlink at {}",
                    path.display()
                )))
            } else {
                Ok(())
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CredentialStoreError::Io(error.to_string())),
    }
}

fn establish_private(path: &Path, expected: u32) -> Result<(), CredentialStoreError> {
    reject_symlink(path)?;
    let actual = mode(path)?;
    if actual != expected {
        return Err(CredentialStoreError::UnsafePermissions(format!(
            "mode {actual:o} for {} (expected {expected:o})",
            path.display()
        )));
    }
    Ok(())
}

fn prepare_parent(path: &Path) -> Result<&Path, CredentialStoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| CredentialStoreError::Io("credential path has no parent".to_owned()))?;
    let existed = parent.exists();
    reject_symlink(parent)?;
    fs::create_dir_all(parent).map_err(|error| CredentialStoreError::Io(error.to_string()))?;
    if existed {
        establish_private(parent, 0o700)?;
    } else {
        set_mode(parent, 0o700)?;
    }
    Ok(parent)
}

pub fn load_store(path: &Path) -> Result<CredentialStoreV1, CredentialStoreError> {
    let parent = prepare_parent(path)?;
    let _ = parent;
    if !path.exists() {
        return Ok(CredentialStoreV1::empty());
    }
    reject_symlink(path)?;
    establish_private(path, 0o600)?;
    let bytes = fs::read(path).map_err(|error| CredentialStoreError::Io(error.to_string()))?;
    if !bytes.ends_with(b"\n") {
        return Err(CredentialStoreError::InvalidStore(
            "credential JSON must end with LF".to_owned(),
        ));
    }
    let store: CredentialStoreV1 = serde_json::from_slice(&bytes[..bytes.len() - 1])
        .map_err(|error| CredentialStoreError::InvalidStore(error.to_string()))?;
    store.validate()?;
    Ok(store)
}

fn open_private_new(path: &Path) -> Result<fs::File, CredentialStoreError> {
    reject_symlink(path)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options
        .open(path)
        .map_err(|error| CredentialStoreError::Io(error.to_string()))
}

fn sync_parent(parent: &Path) -> Result<(), CredentialStoreError> {
    #[cfg(unix)]
    {
        fs::File::open(parent)
            .map_err(|error| CredentialStoreError::Io(error.to_string()))?
            .sync_all()
            .map_err(|error| CredentialStoreError::Io(error.to_string()))?;
    }
    Ok(())
}

pub fn save_store(path: &Path, store: &CredentialStoreV1) -> Result<(), CredentialStoreError> {
    store.validate()?;
    let parent = prepare_parent(path)?;
    let mut bytes = serde_json::to_vec(store)
        .map_err(|error| CredentialStoreError::Serialization(error.to_string()))?;
    bytes.push(b'\n');
    let temp = parent.join(format!(".credentials-{}.tmp", std::process::id()));
    let mut file = open_private_new(&temp)?;
    file.write_all(&bytes)
        .map_err(|error| CredentialStoreError::Io(error.to_string()))?;
    file.sync_all()
        .map_err(|error| CredentialStoreError::Io(error.to_string()))?;
    drop(file);
    establish_private(&temp, 0o600)?;
    fs::rename(&temp, path).map_err(|error| CredentialStoreError::Io(error.to_string()))?;
    establish_private(path, 0o600)?;
    sync_parent(parent)?;
    Ok(())
}

pub fn upsert_credential(
    store: &mut CredentialStoreV1,
    provider: &str,
    value: String,
    updated_at_ms: i64,
) -> Result<u64, CredentialStoreError> {
    if provider_descriptor(provider).is_none() {
        return Err(CredentialStoreError::UnknownProvider(provider.to_owned()));
    }
    validate_credential_value(&value)?;
    if updated_at_ms <= 0 {
        return Err(CredentialStoreError::InvalidStore(
            "updated_at_ms must be positive".to_owned(),
        ));
    }
    let provider_id = ProviderId::from_canonical_str(provider)
        .map_err(|_| CredentialStoreError::UnknownProvider(provider.to_owned()))?;
    let next_revision = store
        .revision
        .checked_add(1)
        .ok_or(CredentialStoreError::RevisionOverflow)?;
    store.providers.insert(
        provider_id,
        StoredCredentialV1::ApiKey {
            value: Zeroizing::new(value),
            updated_at_ms,
        },
    );
    store.revision = next_revision;
    Ok(next_revision)
}

pub fn remove_credential(
    store: &mut CredentialStoreV1,
    provider: &str,
) -> Result<Option<u64>, CredentialStoreError> {
    if provider_descriptor(provider).is_none() {
        return Err(CredentialStoreError::UnknownProvider(provider.to_owned()));
    }
    let provider_id = ProviderId::from_canonical_str(provider)
        .map_err(|_| CredentialStoreError::UnknownProvider(provider.to_owned()))?;
    if store.providers.remove(&provider_id).is_none() {
        return Ok(None);
    }
    store.revision = store
        .revision
        .checked_add(1)
        .ok_or(CredentialStoreError::RevisionOverflow)?;
    Ok(Some(store.revision))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialSource {
    Explicit,
    Store,
    Environment,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ResolvedCredential<'a> {
    pub value: &'a str,
    pub source: CredentialSource,
}

impl<'a> fmt::Debug for ResolvedCredential<'a> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedCredential")
            .field("value", &"[REDACTED]")
            .field("source", &self.source)
            .finish()
    }
}

impl fmt::Display for ResolvedCredential<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "ResolvedCredential([REDACTED], {:?})",
            self.source
        )
    }
}

pub fn resolve_credential<'a>(
    store: &'a CredentialStoreV1,
    provider: &str,
    explicit: Option<&'a str>,
    env_vars: &'a BTreeMap<String, String>,
) -> Result<ResolvedCredential<'a>, CredentialStoreError> {
    if provider_descriptor(provider).is_none() {
        return Err(CredentialStoreError::UnknownProvider(provider.to_owned()));
    }
    if let Some(value) = explicit {
        validate_credential_value(value)?;
        return Ok(ResolvedCredential {
            value,
            source: CredentialSource::Explicit,
        });
    }
    if let Some(value) = store.credential_value(provider) {
        return Ok(ResolvedCredential {
            value,
            source: CredentialSource::Store,
        });
    }
    let env_name = provider_descriptor(provider)
        .expect("provider checked above")
        .credential_env
        .as_str();
    if let Some(value) = env_vars.get(env_name) {
        validate_credential_value(value)?;
        return Ok(ResolvedCredential {
            value,
            source: CredentialSource::Environment,
        });
    }
    Err(CredentialStoreError::CredentialMissing)
}

#[derive(PartialEq, Eq)]
pub struct OwnedResolvedCredential {
    pub value: Zeroizing<String>,
    pub source: CredentialSource,
}

impl fmt::Debug for OwnedResolvedCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OwnedResolvedCredential")
            .field("value", &"[REDACTED]")
            .field("source", &self.source)
            .finish()
    }
}

impl fmt::Display for OwnedResolvedCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "OwnedResolvedCredential([REDACTED], {:?})",
            self.source
        )
    }
}

pub fn resolve_from_process_env(
    store: &CredentialStoreV1,
    provider: &str,
    explicit: Option<&str>,
) -> Result<OwnedResolvedCredential, CredentialStoreError> {
    if provider_descriptor(provider).is_none() {
        return Err(CredentialStoreError::UnknownProvider(provider.to_owned()));
    }
    if let Some(value) = explicit {
        validate_credential_value(value)?;
        return Ok(OwnedResolvedCredential {
            value: Zeroizing::new(value.to_owned()),
            source: CredentialSource::Explicit,
        });
    }
    if let Some(value) = store.credential_value(provider) {
        return Ok(OwnedResolvedCredential {
            value: Zeroizing::new(value.to_owned()),
            source: CredentialSource::Store,
        });
    }
    let env_name = provider_descriptor(provider)
        .expect("provider checked above")
        .credential_env
        .as_str();
    let value = std::env::var(env_name).map_err(|_| CredentialStoreError::CredentialMissing)?;
    validate_credential_value(&value)?;
    Ok(OwnedResolvedCredential {
        value: Zeroizing::new(value),
        source: CredentialSource::Environment,
    })
}
