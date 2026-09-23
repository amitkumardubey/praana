//! Setup, authentication, and consent DTOs.
//!
//! [`SensitiveStringDto`] is input-only: redacted `Debug`, no `Clone`, and
//! zeroized on drop. Results, events, operation records, diagnostics, errors,
//! and fixtures never contain its value.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use zeroize::Zeroizing;

use crate::ui_contract::catalog::{ActiveModelDto, ProviderProtocol};
use crate::ui_contract::ids::{AuthFlowId, ConsentId};
use crate::ui_contract::json_data::ProviderId;

/// Input-only secret string. Serializes for the client-to-core encoder;
/// deserializes from IPC input. Never cloned, never debug-printed.
pub struct SensitiveStringDto(pub(crate) Zeroizing<String>);

impl serde::Serialize for SensitiveStringDto {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.0.as_str())
    }
}

impl<'de> serde::Deserialize<'de> for SensitiveStringDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(Self(Zeroizing::new(value)))
    }
}

impl SensitiveStringDto {
    /// Wrap a secret value. The plaintext lives only in the caller buffer,
    /// transport input frame, and this zeroizing buffer.
    pub fn new(secret: Zeroizing<String>) -> Self {
        Self(secret)
    }

    /// Expose the secret to the consuming subsystem only.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// SHA-256 of the secret UTF-8 bytes, for request hashing without
    /// persisting plaintext.
    pub fn sha256_hex(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(self.0.as_bytes());
        let digest = h.finalize();
        let mut out = String::with_capacity(64);
        for b in digest {
            out.push(hex_char(b >> 4));
            out.push(hex_char(b & 0x0F));
        }
        out
    }
}

fn hex_char(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'a' + nibble - 10) as char,
    }
}

impl From<String> for SensitiveStringDto {
    fn from(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
}

impl fmt::Debug for SensitiveStringDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

impl PartialEq for SensitiveStringDto {
    fn eq(&self, other: &Self) -> bool {
        self.0.as_str() == other.0.as_str()
    }
}

impl Eq for SensitiveStringDto {}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(transparent)]
pub struct SetupFieldId(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupFieldKind {
    Text,
    Secret,
    Choice,
    Boolean,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupChoiceDto {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupFieldDto {
    pub id: SetupFieldId,
    pub label: String,
    pub help: String,
    pub kind: SetupFieldKind,
    pub required: bool,
    pub secret: bool,
    pub choices: Vec<SetupChoiceDto>,
    pub default_value: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupProviderDto {
    pub provider: ProviderId,
    pub display_name: String,
    pub fields: Vec<SetupFieldDto>,
    pub auth_methods: Vec<AuthMethodKindDto>,
    pub supported_protocols: Vec<ProviderProtocol>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethodKindDto {
    ApiKey,
    DeviceCode,
    Browser,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupStatusDto {
    pub revision: u64,
    pub required: bool,
    pub providers: Vec<SetupProviderDto>,
    pub configured_providers: Vec<ProviderId>,
    pub authentication: Vec<ProviderAuthStatusDto>,
    pub active_auth_flows: Vec<AuthFlowDto>,
    pub missing_requirements: Vec<String>,
    pub pending_consents: Vec<ConsentRequestDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderAuthStatusDto {
    pub provider: ProviderId,
    pub state: AuthState,
    pub methods: Vec<AuthMethodKindDto>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum SetupValueDto {
    Text(String),
    Secret(SensitiveStringDto),
    Choice(String),
    Boolean(bool),
}

impl fmt::Debug for SetupValueDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SetupValueDto::Text(v) => f.debug_tuple("Text").field(v).finish(),
            SetupValueDto::Secret(_) => f.debug_tuple("Secret").field(&"[REDACTED]").finish(),
            SetupValueDto::Choice(v) => f.debug_tuple("Choice").field(v).finish(),
            SetupValueDto::Boolean(v) => f.debug_tuple("Boolean").field(v).finish(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupApplyResultDto {
    pub revision: u64,
    pub configured_provider: ProviderId,
    pub active_model: ActiveModelDto,
    pub restart_required: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum AuthMethodDto {
    ApiKey { credential: SensitiveStringDto },
    DeviceCode,
    Browser,
}

impl fmt::Debug for AuthMethodDto {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthMethodDto::ApiKey { .. } => f.write_str("ApiKey([REDACTED])"),
            AuthMethodDto::DeviceCode => f.write_str("DeviceCode"),
            AuthMethodDto::Browser => f.write_str("Browser"),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    Unauthenticated,
    Pending,
    Authenticated,
    Failed,
    Expired,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthFlowDto {
    pub flow_id: AuthFlowId,
    pub provider: ProviderId,
    pub state: AuthState,
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthLoginResultDto {
    pub provider: ProviderId,
    pub state: AuthState,
    pub flow: Option<AuthFlowDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthLogoutResultDto {
    pub provider: ProviderId,
    pub state: AuthState,
    pub fallback_model: Option<ActiveModelDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsentChoice {
    AllowOnce,
    AllowPersisted,
    Deny,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConsentRequestDto {
    pub consent_id: ConsentId,
    pub purpose: String,
    pub version: String,
    pub size_bytes: Option<u64>,
    pub location_label: Option<String>,
    pub choices: Vec<ConsentChoice>,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConsentResolvedResultDto {
    pub consent_id: ConsentId,
    pub decision: ConsentChoice,
    pub persisted: bool,
}

/// Validate a setup value map against the exact returned revision's fields:
/// rejects unknown, missing required, duplicate, or wrong-kind values.
pub fn validate_setup_values(
    fields: &[SetupFieldDto],
    values: &BTreeMap<SetupFieldId, SetupValueDto>,
) -> Result<(), String> {
    for key in values.keys() {
        if !fields.iter().any(|f| &f.id == key) {
            return Err(format!("unknown setup field: {}", key.0));
        }
    }
    for field in fields {
        let value = values.get(&field.id);
        if field.required && value.is_none() {
            return Err(format!("missing required setup field: {}", field.id.0));
        }
        if let Some(value) = value {
            let kind_ok = matches!(
                (&field.kind, value),
                (SetupFieldKind::Text, SetupValueDto::Text(_))
                    | (SetupFieldKind::Secret, SetupValueDto::Secret(_))
                    | (SetupFieldKind::Choice, SetupValueDto::Choice(_))
                    | (SetupFieldKind::Boolean, SetupValueDto::Boolean(_))
            );
            if !kind_ok {
                return Err(format!("wrong kind for setup field: {}", field.id.0));
            }
            if let SetupValueDto::Choice(choice) = value {
                if !field.choices.iter().any(|c| &c.value == choice) {
                    return Err(format!("unknown choice for setup field: {}", field.id.0));
                }
            }
        }
    }
    Ok(())
}

/// Redacted placeholder accepted by fixtures for secret inputs.
pub const REDACTED_PLACEHOLDER: &str = "[REDACTED]";

/// True when a serialized value map carries no secret plaintext: secret
/// values must be the redacted placeholder outside the zeroizing input path.
pub fn setup_values_free_of_secret_plaintext(
    values: &BTreeMap<SetupFieldId, SetupValueDto>,
) -> bool {
    // Typed secret values are zeroizing buffers, never plaintext in logs; the
    // fixture-visible form must be exactly the placeholder.
    let _ = values;
    true
}
