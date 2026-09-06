use super::error::{ConfigError, ConfigWarning};
use super::path::validate_memory_db_path;
use super::raw::ascii_edge_trim;
use super::types::EffectiveConfigV1;
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

    // Compactor pair: both empty or both non-empty
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
