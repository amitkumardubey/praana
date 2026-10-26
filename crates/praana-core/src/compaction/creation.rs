//! Creation-only compactor capability, credential-presence, and admission gate.

use std::collections::BTreeMap;
use std::path::Path;

use crate::compaction::activate::{plan_request, CompactionSnapshot, ConfiguredCompactor};
use crate::config::{CompactorPair, ConfigError, EffectiveConfigV1};
use crate::credentials::store::{credentials_path, load_store, validate_credential_value};
use crate::credentials::CredentialStoreError;
use crate::provider::provider_descriptor;
/// Validation-only creation gate used by setup.
pub fn validate_compactor_pair_at_creation(
    config: &EffectiveConfigV1,
    praana_home: &Path,
    now_ms: i64,
    env_vars: &BTreeMap<String, String>,
) -> Result<(), ConfigError> {
    resolve_compactor_at_creation(config, praana_home, now_ms, env_vars).map(|_| ())
}

/// Phase-5 creation gate (P5-7): `history.compactor_provider` /
/// `history.compactor_model` pair validation at session creation (Config §6.4
/// and §6.6, Compaction §7.3 and §14.4). It runs only when a NEW session is
/// created, never during plain config loading, the config digest, or resume:
/// `validate_effective_config` stays a pure function of the config and
/// `praana_home`, so the digest and resume of pre-Phase-5 snapshots are not
/// affected by ambient state.
///
/// - Empty pair: legal and inert. No compactor capability, credential, or
///   admission check runs, and `CONFIG_COMPACTOR_REQUIRED` is never raised
///   (no bundled profile is `Validated`).
/// - One-sided pair: `CONFIG_INVALID_VALUE` (also enforced here as
///   defense-in-depth; `validate_effective_config` rejects it first).
/// - Complete pair: validated for (1) a trusted context window, (2) only the
///   profile's `strict_json_schema` flag, (3) credential presence only (the
///   runtime secret is not resolved, retained, or logged; resolution stays
///   after the durable compaction start, Compaction §12), and (4) compactor
///   admission of the minimum request (control prompt, schema, `Rout`) with
///   one empty synthetic turn against the compactor model's window.
///   The gate makes no network call, so it cannot prove the provider accepts
///   the schema. That was checked once against OpenAI Responses (see #645 and
///   Config §6.4); other providers and endpoints are unverified. No silent
///   fallback, no fidelity manifest, and no
///   `SelfCompactionCapability::Validated` requirement.
pub fn resolve_compactor_at_creation(
    config: &EffectiveConfigV1,
    praana_home: &Path,
    now_ms: i64,
    env_vars: &BTreeMap<String, String>,
) -> Result<Option<ConfiguredCompactor>, ConfigError> {
    match config.history.compactor_pair() {
        CompactorPair::Empty => return Ok(None),
        CompactorPair::OneSided => {
            return Err(ConfigError::InvalidValue(
                "history.compactor: compactor_provider and compactor_model must both be empty or both non-empty".to_string(),
            ));
        }
        CompactorPair::Complete { .. } => {}
    }

    // Complete pair. Resolve provider rules, window, strict-schema, profile
    // output range, and endpoint (reads only the local catalog cache; never
    // the network and never a fidelity manifest).
    // The validation-only wrapper discards the reqwest::Client built by resolve.
    // If the env credential is unusable, load_store may create or tighten the home.
    let compactor = ConfiguredCompactor::resolve(config, praana_home, now_ms).map_err(|error| {
        ConfigError::CompactorRequired(format!(
            "history.compactor: compactor selection failed: {error}"
        ))
    })?;
    validate_compactor_credential_presence(&compactor.provider, praana_home, env_vars)
        .map_err(|error| match error {
            CredentialStoreError::CredentialMissing => ConfigError::CompactorRequired(format!(
                "history.compactor: no credential is available for compactor provider {}",
                compactor.provider
            )),
            other => ConfigError::CompactorRequired(format!(
                "history.compactor: compactor credential cannot be verified: {other}; no credential is available for compactor provider {}",
                compactor.provider
            )),
        })?;
    admit_minimum_compactor_request(config, &compactor)?;
    Ok(Some(compactor))
}

/// Presence only, shared with resume's post-start capability check. This does
/// not resolve a secret or apply creation-time capability/admission gates.
pub(crate) fn validate_compactor_credential_presence(
    provider: &str,
    praana_home: &Path,
    env_vars: &BTreeMap<String, String>,
) -> Result<(), CredentialStoreError> {
    // Credential presence (D4): the env var is checked first. If it is valid,
    // presence is satisfied and `load_store` is NOT called — this avoids
    // `load_store`'s side effects (`prepare_parent` runs `create_dir_all` and
    // enforces mode 0700). Only when the env var is unusable do we consult
    // the store. A load failure stays typed so resume can report its specific
    // cause. Presence only — resolve_credential is not used, no secret is
    // retained or logged, and runtime resolution stays after the durable
    // compaction start (Compaction §12).
    //
    // Validity matches runtime: `CredentialStoreV1::validate` (run by
    // `load_store`) already rejects any stored value that fails
    // `validate_credential_value`, so a store row reaching this check is
    // valid by construction. The env var must satisfy the same predicate
    // here — an empty, whitespace-edged, or newline/NUL-containing value is
    // rejected by `resolve_from_process_env` at send time, so creation must
    // not accept it either.
    //
    // Note: `load_store` is retained (no read-only loader exists); it has the
    // side effect of creating/enforcing the parent directory mode. Callers
    // that need to avoid that side effect must ensure a valid env var.
    // On non-unix, load_store always returns UnsafePermissions. The CLI's
    // run/resume commands fail closed on Windows before reaching this check.
    let descriptor = provider_descriptor(provider)
        .ok_or_else(|| CredentialStoreError::UnknownProvider(provider.to_owned()))?;
    if env_vars
        .get(&descriptor.credential_env)
        .is_some_and(|value| validate_credential_value(value).is_ok())
    {
        return Ok(());
    }
    let store = load_store(&credentials_path(praana_home))?;
    if store.credential_value(provider).is_none() {
        return Err(CredentialStoreError::CredentialMissing);
    }

    Ok(())
}

/// Cause codes only; these are message details, not new wire error codes.
pub(crate) fn credential_presence_cause_code(error: &CredentialStoreError) -> &'static str {
    match error {
        CredentialStoreError::CredentialMissing => "AUTH_CREDENTIAL_MISSING",
        CredentialStoreError::UnknownProvider(_) => "PROVIDER_UNKNOWN",
        CredentialStoreError::Io(_) => "CREDENTIAL_STORE_IO",
        CredentialStoreError::UnsafePermissions(_) => "CREDENTIAL_STORE_INSECURE_PERMISSIONS",
        CredentialStoreError::InvalidStore(_) => "CREDENTIAL_STORE_INVALID",
        CredentialStoreError::InvalidCredential => "CREDENTIAL_INVALID",
        CredentialStoreError::RevisionOverflow => "CREDENTIAL_REVISION_OVERFLOW",
        CredentialStoreError::Serialization(_) => "CREDENTIAL_STORE_SERIALIZE",
    }
}

/// Admits the minimum compactor request against the compactor model's window:
/// the §7.4 system policy and control payload with one empty synthetic turn,
/// the candidate schema, and the resolved `Rout`. Reuses `plan_request` so the
/// creation-time check exercises the exact bytes and admission path of the
/// runtime activation.
#[doc(hidden)]
pub fn admit_minimum_compactor_request(
    config: &EffectiveConfigV1,
    compactor: &ConfiguredCompactor,
) -> Result<(), ConfigError> {
    let snapshot = CompactionSnapshot::minimal_for_admission_probe()?;
    plan_request(&snapshot, compactor, config, None).map_err(|error| {
        ConfigError::CompactorRequired(format!(
            "history.compactor: compactor admission failed: {error}"
        ))
    })?;
    Ok(())
}
