use super::error::{ConfigError, ConfigWarning};
use super::merge::merge_raw_into_effective;
use super::path::{
    deduplicate_allowed_paths, normalize_config_path, normalize_praana_home,
    to_canonical_json_path, validate_memory_db_path,
};
use super::raw::{ascii_edge_trim, RawConfigV1};
use super::types::{
    CircuitConfig, EffectiveConfigV1, HistoryConfig, LlmConfig, LoggingConfig, MemoryConfig,
    MemoryOptionsConfig, MemoryTimeoutsConfig, ProviderOpenAiConfig, ProviderOpenRouterConfig,
    ProvidersConfig, RiskConfig, SessionConfig, StateConfig, ToolsConfig, TurnConfig,
};
use super::validate::validate_effective_config;
use crate::token::Sha256Digest;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ConfigLoaderEnv {
    pub home_dir: PathBuf,
    pub session_cwd: PathBuf,
    pub process_cwd: PathBuf,
    pub env_vars: HashMap<String, String>,
}

#[derive(Clone, Debug, Default)]
pub struct ConfigCliOverrides {
    pub provider: Option<String>,
    pub protocol: Option<String>,
    pub model: Option<String>,
    pub context_window: Option<u64>,
    pub reasoning: Option<String>,
    pub max_output_tokens: Option<u64>,
    pub max_steps: Option<u32>,
    pub incognito: bool,
    pub debug: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ConfigEnvOverrides {
    pub provider: Option<String>,
    pub protocol: Option<String>,
    pub model: Option<String>,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub reasoning_effort: Option<String>,
    pub incognito: Option<bool>,
    pub debug: Option<bool>,
}

pub fn build_defaults(praana_home: &Path) -> EffectiveConfigV1 {
    let praana_home_canonical = to_canonical_json_path(praana_home.to_str().unwrap());

    EffectiveConfigV1 {
        circuit: CircuitConfig {
            loop_threshold: 3,
            max_tokens: 0,
            max_wall_ms: 0,
        },
        config_schema_version: 1,
        history: HistoryConfig {
            artifact_batch_inline_tokens: 1600,
            artifact_inline_tokens: 800,
            artifact_preview_tokens: 160,
            compact_at: 0.60,
            compact_clear_at: 0.45,
            compact_mass_fraction: 0.50,
            compactor_max_output_tokens: 4096,
            compactor_model: String::new(),
            compactor_provider: String::new(),
            compactor_timeout_ms: 60000,
            handoff_max_tokens: 1600,
            mode: "append".to_string(),
            reasoning_replay: "active".to_string(),
            safety_margin_min_tokens: 512,
            safety_margin_ratio: 0.03,
            summary_segment_max_tokens: 2400,
        },
        llm: LlmConfig {
            context_window: 0,
            fallback_context_window: 0,
            fallback_model: String::new(),
            fallback_protocol: "auto".to_string(),
            fallback_provider: String::new(),
            max_output_tokens: 8192,
            min_output_tokens: 256,
            model: String::new(),
            protocol: "auto".to_string(),
            provider: String::new(),
            reasoning_effort: "medium".to_string(),
            reasoning_reserve_tokens: 0,
            request_timeout_ms: 120000,
            temperature_milli: None,
            unsafe_allow_context_window_increase: false,
        },
        logging: LoggingConfig {
            directory: format!("{praana_home_canonical}/logs"),
            file: false,
            format: "text".to_string(),
            keep_files: 5,
            level: "info".to_string(),
            rotate_bytes: 10485760,
            stderr: true,
        },
        memory: MemoryConfig {
            options: MemoryOptionsConfig {
                db_path: format!("{praana_home_canonical}/plugins/builtin-sqlite/memory.db"),
                digest_max_tokens: 1200,
                extraction: true,
                llm_contradictions: false,
                recall_limit: 10,
            },
            plugin: "none".to_string(),
            timeouts: MemoryTimeoutsConfig {
                close_ms: 2000,
                end_ms: 30000,
                feedback_ms: 1000,
                open_ms: 2000,
                pin_ms: 2000,
                recall_ms: 3000,
                remember_ms: 2000,
                retract_ms: 2000,
                start_ms: 3000,
                stats_ms: 1000,
            },
        },
        providers: ProvidersConfig {
            openai: ProviderOpenAiConfig {
                base_url: "https://api.openai.com/v1".to_string(),
                extra_headers: BTreeMap::new(),
            },
            openrouter: ProviderOpenRouterConfig {
                base_url: "https://openrouter.ai/api/v1".to_string(),
                extra_headers: BTreeMap::new(),
            },
        },
        risk: RiskConfig { allow: Vec::new() },
        session: SessionConfig {
            incognito: false,
            orphan_retention_days: 7,
            retention_days: 0,
            root: format!("{praana_home_canonical}/sessions"),
            shutdown_grace_ms: 3000,
        },
        state: StateConfig {
            active_max_tokens: 4096,
            auto_hydrate: true,
            auto_hydrate_max: 3,
            automation_policy_version: "state-lexical-v1".to_string(),
            idle_hard_after_turns: 50,
            idle_soft_after_turns: 20,
        },
        tools: ToolsConfig {
            allowed_paths: Vec::new(),
            default_timeout_ms: 60000,
            max_parallel_calls: 8,
            max_spawned_processes: 4,
            shell_enabled: true,
            shell_max_timeout_ms: 600000,
            shell_timeout_ms: 30000,
        },
        turn: TurnConfig {
            max_attempts: 3,
            max_steps: 25,
        },
    }
}

fn read_and_validate_source_file(path: &Path) -> Result<Vec<u8>, ConfigError> {
    let metadata = fs::symlink_metadata(path).map_err(|e| {
        ConfigError::SourceInvalid(format!("failed to stat source '{}': {e}", path.display()))
    })?;

    if metadata.file_type().is_symlink() {
        return Err(ConfigError::SourceInvalid(format!(
            "source '{}' is a symlink",
            path.display()
        )));
    }
    if !metadata.is_file() {
        return Err(ConfigError::SourceInvalid(format!(
            "source '{}' is not a regular file",
            path.display()
        )));
    }
    if metadata.len() > 1024 * 1024 {
        return Err(ConfigError::SourceInvalid(format!(
            "source '{}' exceeds 1 MiB limit (size: {} bytes)",
            path.display(),
            metadata.len()
        )));
    }

    let bytes = fs::read(path).map_err(|e| {
        ConfigError::SourceInvalid(format!("failed to read source '{}': {e}", path.display()))
    })?;

    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(ConfigError::Parse(format!(
            "source '{}' contains UTF-8 BOM",
            path.display()
        )));
    }

    if std::str::from_utf8(&bytes).is_err() {
        return Err(ConfigError::SourceInvalid(format!(
            "source '{}' contains invalid UTF-8",
            path.display()
        )));
    }

    Ok(bytes)
}

fn parse_and_normalize_layer(
    path: &Path,
    bytes: &[u8],
    home_dir: &Path,
    praana_home: &Path,
) -> Result<RawConfigV1, ConfigError> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut raw = match ext.as_str() {
        "json" => RawConfigV1::from_slice_json(bytes)?,
        "toml" => RawConfigV1::from_slice_toml(bytes)?,
        _ => {
            return Err(ConfigError::SourceInvalid(format!(
                "source '{}' must have .toml or .json extension",
                path.display()
            )));
        }
    };

    raw.validate_layer(path.to_str().unwrap_or(""))?;

    let source_dir = path.parent().unwrap_or_else(|| Path::new("."));

    // Normalize paths owned by this layer
    if let Some(session) = &mut raw.session {
        if let Some(root) = &mut session.root {
            *root = normalize_config_path(root, source_dir, home_dir, "session.root")?;
        }
    }

    if let Some(logging) = &mut raw.logging {
        if let Some(dir) = &mut logging.directory {
            *dir = normalize_config_path(dir, source_dir, home_dir, "logging.directory")?;
        }
    }

    if let Some(memory) = &mut raw.memory {
        if let Some(options) = &mut memory.options {
            if let Some(db_path) = &mut options.db_path {
                *db_path =
                    normalize_config_path(db_path, source_dir, home_dir, "memory.options.db_path")?;
                validate_memory_db_path(db_path, praana_home)?;
            }
        }
    }

    if let Some(tools) = &mut raw.tools {
        if let Some(allowed) = &mut tools.allowed_paths {
            for p in allowed.iter_mut() {
                *p = normalize_config_path(p, source_dir, home_dir, "tools.allowed_paths")?;
            }
        }
    }

    Ok(raw)
}

fn apply_env_overrides(
    effective: &mut EffectiveConfigV1,
    env_vars: &HashMap<String, String>,
) -> Result<(), ConfigError> {
    if let Some(val) = env_vars.get("PRAANA_PROVIDER") {
        let trimmed = ascii_edge_trim(val);
        if !trimmed.is_empty() {
            match trimmed {
                "openai" | "openrouter" => {
                    effective.llm.provider = trimmed.to_string();
                }
                _ => {
                    return Err(ConfigError::InvalidValue(format!(
                        "PRAANA_PROVIDER: invalid provider '{trimmed}'"
                    )));
                }
            }
        }
    }

    if let Some(val) = env_vars.get("PRAANA_PROTOCOL") {
        let trimmed = ascii_edge_trim(val);
        if !trimmed.is_empty() {
            match trimmed {
                "auto" | "openai-chat-v1" | "openai-responses-v1" => {
                    effective.llm.protocol = trimmed.to_string();
                }
                _ => {
                    return Err(ConfigError::InvalidValue(format!(
                        "PRAANA_PROTOCOL: invalid protocol '{trimmed}'"
                    )));
                }
            }
        }
    }

    if let Some(val) = env_vars.get("PRAANA_MODEL") {
        let trimmed = ascii_edge_trim(val);
        if !trimmed.is_empty() {
            if trimmed.len() > 256
                || trimmed.contains('\0')
                || trimmed.contains('\r')
                || trimmed.contains('\n')
            {
                return Err(ConfigError::InvalidValue(
                    "PRAANA_MODEL: model exceeds length or contains control chars".to_string(),
                ));
            }
            effective.llm.model = trimmed.to_string();
        }
    }

    if let Some(val) = env_vars.get("PRAANA_CONTEXT_WINDOW") {
        let trimmed = ascii_edge_trim(val);
        if !trimmed.is_empty() {
            let cw: u64 = trimmed.parse().map_err(|_| {
                ConfigError::InvalidValue(format!(
                    "PRAANA_CONTEXT_WINDOW: invalid integer '{trimmed}'"
                ))
            })?;
            if cw != 0 && cw < 2048 {
                return Err(ConfigError::InvalidValue(format!(
                    "PRAANA_CONTEXT_WINDOW: context_window must be 0 or >= 2048, got {cw}"
                )));
            }
            effective.llm.context_window = cw;
        }
    }

    if let Some(val) = env_vars.get("PRAANA_MAX_OUTPUT_TOKENS") {
        let trimmed = ascii_edge_trim(val);
        if !trimmed.is_empty() {
            let tokens: u64 = trimmed.parse().map_err(|_| {
                ConfigError::InvalidValue(format!(
                    "PRAANA_MAX_OUTPUT_TOKENS: invalid integer '{trimmed}'"
                ))
            })?;
            if !(1..=1048576).contains(&tokens) {
                return Err(ConfigError::InvalidValue(format!(
                    "PRAANA_MAX_OUTPUT_TOKENS: max_output_tokens must be in 1..=1048576, got {tokens}"
                )));
            }
            effective.llm.max_output_tokens = tokens;
        }
    }

    if let Some(val) = env_vars.get("PRAANA_REASONING_EFFORT") {
        let trimmed = ascii_edge_trim(val);
        if !trimmed.is_empty() {
            match trimmed {
                "off" | "minimal" | "low" | "medium" | "high" | "xhigh" => {
                    effective.llm.reasoning_effort = trimmed.to_string();
                }
                _ => {
                    return Err(ConfigError::InvalidValue(format!(
                        "PRAANA_REASONING_EFFORT: invalid reasoning effort '{trimmed}'"
                    )));
                }
            }
        }
    }

    if let Some(val) = env_vars.get("PRAANA_INCOGNITO") {
        let trimmed = ascii_edge_trim(val);
        if !trimmed.is_empty() {
            match trimmed {
                "true" | "1" => {
                    effective.session.incognito = true;
                }
                "false" | "0" => {
                    effective.session.incognito = false;
                }
                _ => {
                    return Err(ConfigError::InvalidValue(format!(
                        "PRAANA_INCOGNITO: must be true, false, 1, or 0, got '{trimmed}'"
                    )));
                }
            }
        }
    }

    if let Some(val) = env_vars.get("PRAANA_DEBUG") {
        let trimmed = ascii_edge_trim(val);
        if !trimmed.is_empty() {
            match trimmed {
                "true" | "1" => {
                    effective.logging.level = "debug".to_string();
                }
                "false" | "0" => {}
                _ => {
                    return Err(ConfigError::InvalidValue(format!(
                        "PRAANA_DEBUG: must be true, false, 1, or 0, got '{trimmed}'"
                    )));
                }
            }
        }
    }

    Ok(())
}

fn apply_cli_overrides(
    effective: &mut EffectiveConfigV1,
    cli: &ConfigCliOverrides,
) -> Result<(), ConfigError> {
    if let Some(provider) = &cli.provider {
        let trimmed = ascii_edge_trim(provider);
        match trimmed {
            "" | "openai" | "openrouter" => {
                effective.llm.provider = trimmed.to_string();
            }
            _ => {
                return Err(ConfigError::InvalidValue(format!(
                    "cli --provider: invalid provider '{trimmed}'"
                )));
            }
        }
    }

    if let Some(protocol) = &cli.protocol {
        let trimmed = ascii_edge_trim(protocol);
        match trimmed {
            "auto" | "openai-chat-v1" | "openai-responses-v1" => {
                effective.llm.protocol = trimmed.to_string();
            }
            _ => {
                return Err(ConfigError::InvalidValue(format!(
                    "cli --protocol: invalid protocol '{trimmed}'"
                )));
            }
        }
    }

    if let Some(model) = &cli.model {
        let trimmed = ascii_edge_trim(model);
        if trimmed.len() > 256
            || trimmed.contains('\0')
            || trimmed.contains('\r')
            || trimmed.contains('\n')
        {
            return Err(ConfigError::InvalidValue(
                "cli --model: model exceeds length or contains control chars".to_string(),
            ));
        }
        effective.llm.model = trimmed.to_string();
    }

    if let Some(cw) = cli.context_window {
        if cw != 0 && cw < 2048 {
            return Err(ConfigError::InvalidValue(format!(
                "cli --context-window: context_window must be 0 or >= 2048, got {cw}"
            )));
        }
        effective.llm.context_window = cw;
    }

    if let Some(reasoning) = &cli.reasoning {
        let trimmed = ascii_edge_trim(reasoning);
        match trimmed {
            "off" | "minimal" | "low" | "medium" | "high" | "xhigh" => {
                effective.llm.reasoning_effort = trimmed.to_string();
            }
            _ => {
                return Err(ConfigError::InvalidValue(format!(
                    "cli --reasoning: invalid reasoning effort '{trimmed}'"
                )));
            }
        }
    }

    if let Some(tokens) = cli.max_output_tokens {
        if !(1..=1048576).contains(&tokens) {
            return Err(ConfigError::InvalidValue(format!(
                "cli --max-output-tokens: max_output_tokens must be in 1..=1048576, got {tokens}"
            )));
        }
        effective.llm.max_output_tokens = tokens;
    }

    if let Some(steps) = cli.max_steps {
        if !(1..=1000).contains(&steps) {
            return Err(ConfigError::InvalidValue(format!(
                "cli --max-steps: max_steps must be in 1..=1000, got {steps}"
            )));
        }
        effective.turn.max_steps = steps;
    }

    if cli.incognito {
        effective.session.incognito = true;
    }

    if cli.debug {
        effective.logging.level = "debug".to_string();
    }

    Ok(())
}

#[cfg(unix)]
fn check_file_permissions_not_broad(path: &Path, warnings: &mut Vec<ConfigWarning>) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path) {
        let mode = metadata.permissions().mode();
        if (mode & 0o077) != 0 {
            warnings.push(ConfigWarning::PermissionsBroad(path.display().to_string()));
        }
    }
}

#[cfg(not(unix))]
fn check_file_permissions_not_broad(_path: &Path, _warnings: &mut Vec<ConfigWarning>) {}

pub fn load_effective_config(
    explicit_source: Option<&Path>,
    cli_overrides: &ConfigCliOverrides,
    env: &ConfigLoaderEnv,
) -> Result<(EffectiveConfigV1, Sha256Digest, Vec<ConfigWarning>), ConfigError> {
    let mut warnings = Vec::new();

    // 1. Determine PRAANA_HOME
    let praana_home = normalize_praana_home(
        env.env_vars.get("PRAANA_HOME").map(|s| s.as_str()),
        &env.home_dir,
        &env.process_cwd,
    )?;

    // 2. Build default effective configuration
    let mut effective = build_defaults(&praana_home);

    // 3. Determine explicit or discovered source files
    let explicit_path = if let Some(cli_path) = explicit_source {
        Some(cli_path.to_path_buf())
    } else if let Some(env_path) = env.env_vars.get("PRAANA_CONFIG") {
        let trimmed = ascii_edge_trim(env_path);
        if !trimmed.is_empty() {
            Some(PathBuf::from(trimmed))
        } else {
            None
        }
    } else {
        None
    };

    if let Some(explicit) = explicit_path {
        let resolved = if explicit.is_absolute() {
            explicit
        } else {
            env.process_cwd.join(explicit)
        };

        let ext = resolved
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "json" && ext != "toml" {
            return Err(ConfigError::SourceInvalid(format!(
                "explicit configuration '{}' must end in .json or .toml",
                resolved.display()
            )));
        }

        check_file_permissions_not_broad(&resolved, &mut warnings);
        let bytes = read_and_validate_source_file(&resolved)?;
        let raw_layer = parse_and_normalize_layer(&resolved, &bytes, &env.home_dir, &praana_home)?;
        merge_raw_into_effective(&mut effective, raw_layer);
    } else {
        // Discovered sources in precedence order (lowest to highest):
        // 1. <PRAANA_HOME>/praana.config.json
        // 2. <PRAANA_HOME>/config.toml
        // 3. <session_cwd>/praana.config.json
        // 4. <session_cwd>/praana.config.toml
        let discovery_candidates = [
            praana_home.join("praana.config.json"),
            praana_home.join("config.toml"),
            env.session_cwd.join("praana.config.json"),
            env.session_cwd.join("praana.config.toml"),
        ];

        for candidate in &discovery_candidates {
            match fs::symlink_metadata(candidate) {
                Ok(_) => {
                    check_file_permissions_not_broad(candidate, &mut warnings);
                    let bytes = read_and_validate_source_file(candidate)?;
                    let raw_layer =
                        parse_and_normalize_layer(candidate, &bytes, &env.home_dir, &praana_home)?;
                    merge_raw_into_effective(&mut effective, raw_layer);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Not found, continue discovery
                }
                Err(e) => {
                    return Err(ConfigError::SourceInvalid(format!(
                        "failed to stat source '{}': {e}",
                        candidate.display()
                    )));
                }
            }
        }
    }

    // 4. Apply non-secret environment field overrides
    apply_env_overrides(&mut effective, &env.env_vars)?;

    // 5. Apply command-line field overrides
    apply_cli_overrides(&mut effective, cli_overrides)?;

    // 6. Deduplicate allowed paths
    effective.tools.allowed_paths = deduplicate_allowed_paths(effective.tools.allowed_paths);

    // 7. Validate complete effective configuration
    let val_warnings = validate_effective_config(&mut effective, &praana_home)?;
    warnings.extend(val_warnings);

    // 8. Calculate SHA-256 digest
    let digest = effective.config_digest_sha256();

    Ok((effective, digest, warnings))
}
