use super::error::{ConfigError, ConfigWarning};
use super::path::validate_memory_db_path;
use super::raw::ascii_edge_trim;
use super::types::EffectiveConfigV1;
use crate::compaction::activate::{plan_request, CompactionSnapshot, ConfiguredCompactor};
use crate::compaction::selection::Selection;
use crate::compaction::validate::ReferenceUniverse;
use crate::credentials::store::{credentials_path, load_store, validate_credential_value};
use crate::credentials::CredentialStoreError;
use crate::history::replay::EventReplayer;
use crate::provider::provider_descriptor;
use crate::token::Sha256Digest;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub fn normalize_provider_url(raw_url: &str, field_name: &str) -> Result<String, ConfigError> {
    let trimmed = ascii_edge_trim(raw_url);
    if trimmed.is_empty() {
        return Err(ConfigError::InvalidValue(format!(
            "{field_name}: URL cannot be empty"
        )));
    }

    if trimmed.contains('#') {
        return Err(ConfigError::InvalidValue(format!(
            "{field_name}: provider URL cannot contain URL fragment"
        )));
    }

    if trimmed.contains('?') {
        return Err(ConfigError::InvalidValue(format!(
            "{field_name}: provider URL cannot contain query parameters"
        )));
    }

    let (scheme, rest) = if let Some(idx) = trimmed.find("://") {
        (trimmed[..idx].to_ascii_lowercase(), &trimmed[idx + 3..])
    } else {
        return Err(ConfigError::InvalidValue(format!(
            "{field_name}: provider URL must contain scheme (https:// or http://)"
        )));
    };

    let (authority, path_part) = if let Some(slash_idx) = rest.find('/') {
        (&rest[..slash_idx], &rest[slash_idx..])
    } else {
        (rest, "")
    };

    if authority.contains('@') {
        return Err(ConfigError::InvalidValue(format!(
            "{field_name}: provider URL cannot contain username or password credentials"
        )));
    }

    let (host_str, port_opt) = if authority.starts_with('[') {
        // IPv6 bracketed host e.g. [::1]:8080 or [::1]
        if let Some(bracket_end) = authority.find(']') {
            let h = &authority[..=bracket_end];
            let after = &authority[bracket_end + 1..];
            let p = if let Some(stripped) = after.strip_prefix(':') {
                let parsed: u16 = stripped.parse().map_err(|_| {
                    ConfigError::InvalidValue(format!("{field_name}: invalid port '{stripped}'"))
                })?;
                Some(parsed)
            } else {
                None
            };
            (h, p)
        } else {
            return Err(ConfigError::InvalidValue(format!(
                "{field_name}: malformed IPv6 host"
            )));
        }
    } else if let Some((h, p_str)) = authority.split_once(':') {
        let parsed: u16 = p_str.parse().map_err(|_| {
            ConfigError::InvalidValue(format!("{field_name}: invalid port '{p_str}'"))
        })?;
        (h, Some(parsed))
    } else {
        (authority, None)
    };

    if host_str.is_empty() {
        return Err(ConfigError::InvalidValue(format!(
            "{field_name}: provider URL must have non-empty host"
        )));
    }

    let host_lower = host_str.to_ascii_lowercase();
    let is_loopback = host_lower == "localhost"
        || host_lower == "127.0.0.1"
        || host_lower == "::1"
        || host_lower == "[::1]";

    match scheme.as_str() {
        "https" => {}
        "http" if is_loopback => {}
        _ => {
            return Err(ConfigError::InvalidValue(format!(
                "{field_name}: unsupported scheme '{scheme}' for non-loopback host"
            )));
        }
    }

    // Dot-segment removal / path cleaning
    let mut segments = Vec::new();
    for seg in path_part.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        } else if seg == ".." {
            segments.pop();
        } else {
            segments.push(seg);
        }
    }

    let clean_path = if segments.is_empty() {
        String::new()
    } else {
        format!("/{}", segments.join("/"))
    };

    if clean_path.ends_with("/chat/completions") || clean_path.ends_with("/responses") {
        return Err(ConfigError::InvalidValue(format!(
            "{field_name}: provider base_url must not end in /chat/completions or /responses"
        )));
    }

    let port_str = match port_opt {
        Some(port) => {
            let default_port =
                (scheme == "https" && port == 443) || (scheme == "http" && port == 80);
            if default_port {
                String::new()
            } else {
                format!(":{port}")
            }
        }
        None => String::new(),
    };

    let normalized = format!("{scheme}://{host_lower}{port_str}{clean_path}");
    Ok(normalized)
}

pub fn validate_effective_config(
    config: &mut EffectiveConfigV1,
    praana_home: &Path,
) -> Result<Vec<ConfigWarning>, ConfigError> {
    let warnings = Vec::new();

    // 1. History cross-field validation
    if config.history.compact_clear_at >= config.history.compact_at {
        return Err(ConfigError::InvalidValue(format!(
            "history.compact_clear_at: compact_clear_at ({}) must be strictly less than compact_at ({})",
            config.history.compact_clear_at, config.history.compact_at
        )));
    }

    if config.history.artifact_batch_inline_tokens < config.history.artifact_inline_tokens {
        return Err(ConfigError::InvalidValue(format!(
            "history.artifact_batch_inline_tokens: artifact_batch_inline_tokens ({}) must be >= artifact_inline_tokens ({})",
            config.history.artifact_batch_inline_tokens, config.history.artifact_inline_tokens
        )));
    }

    // Compactor pair: both empty or both non-empty. A complete pair is no
    // longer rejected here: the Phase-5 creation gate (P5-7) validates it at
    // session creation (trusted window, strict_json_schema, credential
    // presence, compactor admission) so that plain loading, the config
    // digest, and resume stay pure and independent of ambient state.
    let compactor_provider_empty = ascii_edge_trim(&config.history.compactor_provider).is_empty();
    let compactor_model_empty = ascii_edge_trim(&config.history.compactor_model).is_empty();
    if compactor_provider_empty != compactor_model_empty {
        return Err(ConfigError::InvalidValue(
            "history.compactor: compactor_provider and compactor_model must both be empty or both non-empty".to_string(),
        ));
    }

    // 2. State cross-field validation
    if config.state.idle_hard_after_turns <= config.state.idle_soft_after_turns {
        return Err(ConfigError::InvalidValue(format!(
            "state.idle_hard_after_turns: idle_hard_after_turns ({}) must be strictly greater than idle_soft_after_turns ({})",
            config.state.idle_hard_after_turns, config.state.idle_soft_after_turns
        )));
    }

    // 3. LLM validation
    if config.llm.min_output_tokens > config.llm.max_output_tokens {
        return Err(ConfigError::InvalidValue(format!(
            "llm.min_output_tokens: min_output_tokens ({}) cannot be greater than max_output_tokens ({})",
            config.llm.min_output_tokens, config.llm.max_output_tokens
        )));
    }

    // Provider/protocol validation
    let provider = ascii_edge_trim(&config.llm.provider);
    let protocol = ascii_edge_trim(&config.llm.protocol);
    if provider == "openrouter" && protocol == "openai-responses-v1" {
        return Err(ConfigError::InvalidValue(
            "llm.protocol: OpenRouter Responses (openai-responses-v1) is not supported".to_string(),
        ));
    }

    // Fallback pair validation
    let fallback_provider_empty = ascii_edge_trim(&config.llm.fallback_provider).is_empty();
    let fallback_model_empty = ascii_edge_trim(&config.llm.fallback_model).is_empty();
    if fallback_provider_empty != fallback_model_empty {
        return Err(ConfigError::InvalidValue(
            "llm.fallback: fallback_provider and fallback_model must both be empty or both non-empty".to_string(),
        ));
    }
    if !fallback_provider_empty {
        let fb_provider = ascii_edge_trim(&config.llm.fallback_provider);
        let fb_protocol = ascii_edge_trim(&config.llm.fallback_protocol);
        if fb_provider == "openrouter" && fb_protocol == "openai-responses-v1" {
            return Err(ConfigError::InvalidValue(
                "llm.fallback_protocol: OpenRouter Responses is not supported for fallback"
                    .to_string(),
            ));
        }
    }

    // 4. Provider URLs normalization
    config.providers.openai.base_url = normalize_provider_url(
        &config.providers.openai.base_url,
        "providers.openai.base_url",
    )?;
    config.providers.openrouter.base_url = normalize_provider_url(
        &config.providers.openrouter.base_url,
        "providers.openrouter.base_url",
    )?;

    // 5. Tools validation
    if config.tools.shell_timeout_ms > config.tools.shell_max_timeout_ms {
        return Err(ConfigError::InvalidValue(format!(
            "tools.shell_timeout_ms: shell_timeout_ms ({}) cannot exceed shell_max_timeout_ms ({})",
            config.tools.shell_timeout_ms, config.tools.shell_max_timeout_ms
        )));
    }

    // 6. Memory DB path escape validation
    validate_memory_db_path(&config.memory.options.db_path, praana_home)?;

    Ok(warnings)
}

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
/// - Complete pair: validated for (1) a trusted context window, (2)
///   `strict_json_schema`, (3) credential presence only (the runtime secret is
///   not resolved, retained, or logged; resolution stays after the durable
///   compaction start, Compaction §12), and (4) compactor admission of the
///   minimum request (control prompt, schema, `Rout`) against the compactor
///   model's window. No network completion, no silent fallback to a different
///   model, no fidelity manifest, and no `SelfCompactionCapability::Validated`
///   requirement.
pub fn resolve_compactor_at_creation(
    config: &EffectiveConfigV1,
    praana_home: &Path,
    now_ms: i64,
    env_vars: &BTreeMap<String, String>,
) -> Result<Option<ConfiguredCompactor>, ConfigError> {
    let provider_empty = ascii_edge_trim(&config.history.compactor_provider).is_empty();
    let model_empty = ascii_edge_trim(&config.history.compactor_model).is_empty();
    if provider_empty && model_empty {
        return Ok(None);
    }
    if provider_empty != model_empty {
        return Err(ConfigError::InvalidValue(
            "history.compactor: compactor_provider and compactor_model must both be empty or both non-empty".to_string(),
        ));
    }

    // Complete pair. Resolve provider rules, window, strict-schema, profile
    // output range, and endpoint (reads only the local catalog cache; never
    // the network and never a fidelity manifest).
    let compactor = ConfiguredCompactor::resolve(config, praana_home, now_ms).map_err(|error| {
        ConfigError::CompactorRequired(format!(
            "history.compactor: compactor selection failed: {error}"
        ))
    })?;
    validate_compactor_credential_presence(&compactor, praana_home, env_vars)?;
    admit_minimum_compactor_request(config, &compactor)?;
    Ok(Some(compactor))
}

/// Presence only, shared with resume's post-start capability check. This does
/// not resolve a secret or apply creation-time capability/admission gates.
pub(crate) fn validate_compactor_credential_presence(
    compactor: &ConfiguredCompactor,
    praana_home: &Path,
    env_vars: &BTreeMap<String, String>,
) -> Result<(), ConfigError> {
    // Credential presence (D4): the env var is checked first. If it is valid,
    // presence is satisfied and `load_store` is NOT called — this avoids
    // `load_store`'s side effects (`prepare_parent` runs `create_dir_all` and
    // enforces mode 0700). Only when the env var is unusable do we consult
    // the store. A `load_store` error then counts as `store_present = false`,
    // and if both are unusable the returned error mentions the store problem
    // as well as the missing credential. Presence only — `resolve_credential`
    // is not used, no secret is retained or logged, and runtime resolution
    // stays after the durable compaction start (Compaction §12).
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
    let env_present = {
        let descriptor = provider_descriptor(&compactor.provider).ok_or_else(|| {
            ConfigError::CompactorRequired(format!(
                "history.compactor: unknown compactor provider {}",
                compactor.provider
            ))
        })?;
        env_vars
            .get(&descriptor.credential_env)
            .is_some_and(|value| validate_credential_value(value).is_ok())
    };

    let mut store_error: Option<CredentialStoreError> = None;
    let store_present = if env_present {
        // Presence already satisfied by the env var; do not touch the store.
        true
    } else {
        match load_store(&credentials_path(praana_home)) {
            Ok(store) => store.credential_value(&compactor.provider).is_some(),
            Err(error) => {
                store_error = Some(error);
                false
            }
        }
    };

    if !env_present && !store_present {
        if let Some(error) = store_error {
            return Err(ConfigError::CompactorRequired(format!(
                "history.compactor: compactor credential cannot be verified: {error}; no credential is available for compactor provider {}",
                compactor.provider
            )));
        }
        return Err(ConfigError::CompactorRequired(format!(
            "history.compactor: no credential is available for compactor provider {}",
            compactor.provider
        )));
    }

    Ok(())
}

/// Admits the minimum compactor request against the compactor model's window:
/// the §7.4 system policy and control payload (with no source turns yet), the
/// candidate schema, and the resolved `Rout`. Reuses `plan_request` so the
/// creation-time check exercises the exact bytes and admission path of the
/// runtime activation.
#[doc(hidden)]
pub fn admit_minimum_compactor_request(
    config: &EffectiveConfigV1,
    compactor: &ConfiguredCompactor,
) -> Result<(), ConfigError> {
    let snapshot = CompactionSnapshot {
        projection_sequence: 0,
        reset_epoch: 0,
        epoch: 1,
        previous_handoff: None,
        previous_handoff_hash: None,
        selection: Selection {
            turn_ids: Vec::new(),
            source_start_sequence: 1,
            source_end_sequence: 1,
            eligible_mass: 0,
            target_mass: 0,
            selected_mass: 0,
        },
        source_hash: Sha256Digest::digest_bytes(b""),
        event_prefix_hash_before: Sha256Digest::digest_bytes(b""),
        snapshot_event_prefix_hash: [0u8; 32],
        replay_state: EventReplayer::default(),
        turn_estimates: Vec::new(),
        // The renderer rejects a control with zero source turns (§7.4), so
        // the minimum admissible request carries exactly one synthetic turn
        // with no messages: the smallest control the runtime can ever render.
        source_turns: vec![crate::compaction::control::CompactionSourceTurnV1 {
            turn_id: crate::protocol::id::TurnId::from_str_canonical("01J8Z3NDEK0000000000000001")
                .map_err(|error| {
                    ConfigError::InvalidValue(format!("synthetic turn id: {error}"))
                })?,
            start_sequence: 1,
            end_sequence: 1,
            interrupted: None,
            messages: Vec::new(),
            artifact_previews: Vec::new(),
        }],
        current_state: crate::compaction::control::CompactionStateInputV1 {
            graph_sequence: 0,
            rendered_input_sha256: Sha256Digest::digest_bytes(b""),
            rendered_active_state: String::new(),
        },
        universe: ReferenceUniverse {
            source_event_ids: BTreeSet::new(),
            source_artifact_ids: BTreeSet::new(),
            source_state_ids: BTreeSet::new(),
            prior_segment_ids: BTreeSet::new(),
            lineage_event_ids: BTreeSet::new(),
            session_artifact_ids: BTreeSet::new(),
            current_state_ids: BTreeSet::new(),
        },
    };
    plan_request(&snapshot, compactor, config, None).map_err(|error| {
        ConfigError::CompactorRequired(format!(
            "history.compactor: compactor admission failed: {error}"
        ))
    })?;
    Ok(())
}
