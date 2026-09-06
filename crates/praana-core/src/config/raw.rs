use super::error::ConfigError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_SOURCE_FILE_BYTES: usize = 1024 * 1024; // 1 MiB

const FORBIDDEN_SECRET_KEYS: &[&str] = &[
    "api_key",
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "credential",
    "private_key",
];

const FORBIDDEN_EXTRA_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "host",
    "content-length",
    "content-type",
    "accept",
    "user-agent",
    "http-referer",
    "x-title",
    "x-api-key",
    "api-key",
];

pub fn ascii_edge_trim(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut start = 0;
    while start < bytes.len() && matches!(bytes[start], b' ' | b'\t' | b'\r' | b'\n') {
        start += 1;
    }
    let mut end = bytes.len();
    while end > start && matches!(bytes[end - 1], b' ' | b'\t' | b'\r' | b'\n') {
        end -= 1;
    }
    &s[start..end]
}

pub fn check_no_nul(s: &str, field_name: &str) -> Result<(), ConfigError> {
    if s.contains('\0') {
        Err(ConfigError::InvalidValue(format!(
            "{field_name}: string contains NUL byte"
        )))
    } else {
        Ok(())
    }
}

pub fn is_http_token(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    name.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'!' | b'#'
                    | b'$'
                    | b'%'
                    | b'&'
                    | b'\''
                    | b'*'
                    | b'+'
                    | b'-'
                    | b'.'
                    | b'^'
                    | b'_'
                    | b'`'
                    | b'|'
                    | b'~'
            )
    })
}

fn is_token_boundary_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

// Redaction §3 rows 2–6 frozen copy for Config §10 validation.
// Note: P3A owns the canonical redaction engine; this copy must remain identical to Redaction §3.
pub fn matches_redaction_rows_2_to_6(val: &str) -> bool {
    let bytes = val.as_bytes();
    let len = bytes.len();
    for i in 0..len {
        // Must start at an ASCII token boundary (neighboring byte outside [A-Za-z0-9_-])
        if i > 0 && is_token_boundary_byte(bytes[i - 1]) {
            continue;
        }

        let rem = &bytes[i..];

        // Row 2: aws-access-key: prefix AKIA, ASIA, AIDA, AROA, AIPA, ANPA, ANVA, ASCA + 16 [A-Z0-9]
        if rem.len() >= 20 {
            let prefix = &rem[..4];
            if matches!(
                prefix,
                b"AKIA" | b"ASIA" | b"AIDA" | b"AROA" | b"AIPA" | b"ANPA" | b"ANVA" | b"ASCA"
            ) && rem[4..20]
                .iter()
                .all(|&c| c.is_ascii_uppercase() || c.is_ascii_digit())
                && (rem.len() == 20 || !is_token_boundary_byte(rem[20]))
            {
                return true;
            }
        }

        // Row 3: github-token
        // Case 1: ghp_, gho_, ghu_, ghs_, ghr_ + 36..=255 [A-Za-z0-9_]
        if rem.len() >= 40 {
            let prefix = &rem[..4];
            if matches!(prefix, b"ghp_" | b"gho_" | b"ghu_" | b"ghs_" | b"ghr_") {
                let rest = &rem[4..];
                let count = rest
                    .iter()
                    .take_while(|&&c| c.is_ascii_alphanumeric() || c == b'_')
                    .count();
                if (36..=255).contains(&count) {
                    let end = 4 + count;
                    if end == rem.len() || !is_token_boundary_byte(rem[end]) {
                        return true;
                    }
                }
            }
        }
        // Case 2: github_pat_ + 22..=255 [A-Za-z0-9_]
        if rem.len() >= 33 && rem.starts_with(b"github_pat_") {
            let rest = &rem[11..];
            let count = rest
                .iter()
                .take_while(|&&c| c.is_ascii_alphanumeric() || c == b'_')
                .count();
            if (22..=255).contains(&count) {
                let end = 11 + count;
                if end == rem.len() || !is_token_boundary_byte(rem[end]) {
                    return true;
                }
            }
        }

        // Row 4: gitlab-token: glpat- + 20..=255 [A-Za-z0-9_-]
        if rem.len() >= 26 && rem.starts_with(b"glpat-") {
            let rest = &rem[6..];
            let count = rest
                .iter()
                .take_while(|&&c| is_token_boundary_byte(c))
                .count();
            if (20..=255).contains(&count) {
                let end = 6 + count;
                if end == rem.len() || !is_token_boundary_byte(rem[end]) {
                    return true;
                }
            }
        }

        // Row 5: anthropic-key: sk-ant- + 20..=255 [A-Za-z0-9_-]
        if rem.len() >= 27 && rem.starts_with(b"sk-ant-") {
            let rest = &rem[7..];
            let count = rest
                .iter()
                .take_while(|&&c| is_token_boundary_byte(c))
                .count();
            if (20..=255).contains(&count) {
                let end = 7 + count;
                if end == rem.len() || !is_token_boundary_byte(rem[end]) {
                    return true;
                }
            }
        }

        // Row 6: openai-key: sk- + optional (proj- | svcacct-) + 20..=255 [A-Za-z0-9_-] (sk-ant- excluded)
        if rem.len() >= 23 && rem.starts_with(b"sk-") && !rem.starts_with(b"sk-ant-") {
            let rest = if rem.starts_with(b"sk-proj-") {
                &rem[8..]
            } else if rem.starts_with(b"sk-svcacct-") {
                &rem[11..]
            } else {
                &rem[3..]
            };
            let prefix_len = rem.len() - rest.len();
            let count = rest
                .iter()
                .take_while(|&&c| is_token_boundary_byte(c))
                .count();
            if (20..=255).contains(&count) {
                let end = prefix_len + count;
                if end == rem.len() || !is_token_boundary_byte(rem[end]) {
                    return true;
                }
            }
        }
    }
    false
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RawHistoryConfig {
    pub artifact_batch_inline_tokens: Option<u64>,
    pub artifact_inline_tokens: Option<u64>,
    pub artifact_preview_tokens: Option<u64>,
    pub compact_at: Option<f64>,
    pub compact_clear_at: Option<f64>,
    pub compact_mass_fraction: Option<f64>,
    pub compactor_max_output_tokens: Option<u64>,
    pub compactor_model: Option<String>,
    pub compactor_provider: Option<String>,
    pub compactor_timeout_ms: Option<u64>,
    pub handoff_max_tokens: Option<u64>,
    pub mode: Option<String>,
    pub reasoning_replay: Option<String>,
    pub safety_margin_min_tokens: Option<u64>,
    pub safety_margin_ratio: Option<f64>,
    pub summary_segment_max_tokens: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawStateConfig {
    pub active_max_tokens: Option<u64>,
    pub auto_hydrate: Option<bool>,
    pub auto_hydrate_max: Option<u32>,
    pub automation_policy_version: Option<String>,
    pub idle_hard_after_turns: Option<u64>,
    pub idle_soft_after_turns: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawLlmConfig {
    pub context_window: Option<u64>,
    pub fallback_context_window: Option<u64>,
    pub fallback_model: Option<String>,
    pub fallback_protocol: Option<String>,
    pub fallback_provider: Option<String>,
    pub max_output_tokens: Option<u64>,
    pub min_output_tokens: Option<u64>,
    pub model: Option<String>,
    pub protocol: Option<String>,
    pub provider: Option<String>,
    pub reasoning_effort: Option<String>,
    pub reasoning_reserve_tokens: Option<u64>,
    pub request_timeout_ms: Option<u64>,
    pub temperature_milli: Option<Option<u32>>,
    pub unsafe_allow_context_window_increase: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawProviderOpenAiConfig {
    pub base_url: Option<String>,
    pub extra_headers: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawProviderOpenRouterConfig {
    pub base_url: Option<String>,
    pub extra_headers: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawProvidersConfig {
    pub openai: Option<RawProviderOpenAiConfig>,
    pub openrouter: Option<RawProviderOpenRouterConfig>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawTurnConfig {
    pub max_attempts: Option<u32>,
    pub max_steps: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawToolsConfig {
    pub allowed_paths: Option<Vec<String>>,
    pub default_timeout_ms: Option<u64>,
    pub max_parallel_calls: Option<u32>,
    pub max_spawned_processes: Option<u32>,
    pub shell_enabled: Option<bool>,
    pub shell_max_timeout_ms: Option<u64>,
    pub shell_timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawRiskConfig {
    pub allow: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawCircuitConfig {
    pub loop_threshold: Option<u32>,
    pub max_tokens: Option<u64>,
    pub max_wall_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawSessionConfig {
    pub incognito: Option<bool>,
    pub orphan_retention_days: Option<u32>,
    pub retention_days: Option<u32>,
    pub root: Option<String>,
    pub shutdown_grace_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawLoggingConfig {
    pub directory: Option<String>,
    pub file: Option<bool>,
    pub format: Option<String>,
    pub keep_files: Option<u32>,
    pub level: Option<String>,
    pub rotate_bytes: Option<u64>,
    pub stderr: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawMemoryOptionsConfig {
    pub db_path: Option<String>,
    pub digest_max_tokens: Option<u64>,
    pub extraction: Option<bool>,
    pub llm_contradictions: Option<bool>,
    pub recall_limit: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawMemoryTimeoutsConfig {
    pub close_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub feedback_ms: Option<u64>,
    pub open_ms: Option<u64>,
    pub pin_ms: Option<u64>,
    pub recall_ms: Option<u64>,
    pub remember_ms: Option<u64>,
    pub retract_ms: Option<u64>,
    pub start_ms: Option<u64>,
    pub stats_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RawMemoryConfig {
    pub options: Option<RawMemoryOptionsConfig>,
    pub plugin: Option<String>,
    pub timeouts: Option<RawMemoryTimeoutsConfig>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RawConfigV1 {
    pub circuit: Option<RawCircuitConfig>,
    pub config_schema_version: Option<u32>,
    pub history: Option<RawHistoryConfig>,
    pub llm: Option<RawLlmConfig>,
    pub logging: Option<RawLoggingConfig>,
    pub memory: Option<RawMemoryConfig>,
    pub providers: Option<RawProvidersConfig>,
    pub risk: Option<RawRiskConfig>,
    pub session: Option<RawSessionConfig>,
    pub state: Option<RawStateConfig>,
    pub tools: Option<RawToolsConfig>,
    pub turn: Option<RawTurnConfig>,
}

impl RawConfigV1 {
    pub fn parse_json(bytes: &[u8]) -> Result<Self, ConfigError> {
        if bytes.len() > MAX_SOURCE_FILE_BYTES {
            return Err(ConfigError::SourceInvalid(format!(
                "source exceeds 1 MiB: {} bytes",
                bytes.len()
            )));
        }

        // Check for BOM
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return Err(ConfigError::Parse("source contains UTF-8 BOM".to_string()));
        }

        let s = std::str::from_utf8(bytes)
            .map_err(|_| ConfigError::SourceInvalid("invalid UTF-8".to_string()))?;

        // Parse with duplicate key rejection
        check_json_duplicates_and_secrets(s)?;

        let mut raw: RawConfigV1 = serde_json::from_str(s).map_err(|e| {
            let msg = e.to_string();
            if msg.contains("unknown field") {
                let field = extract_field_name(&msg);
                ConfigError::UnknownKey(field)
            } else if msg.contains("invalid type: null") || msg.contains("expected") {
                ConfigError::InvalidType(msg)
            } else {
                ConfigError::Parse(msg)
            }
        })?;

        raw.validate_schema_version()?;
        raw.validate_raw_layer()?;
        Ok(raw)
    }

    pub fn parse_toml(bytes: &[u8]) -> Result<Self, ConfigError> {
        if bytes.len() > MAX_SOURCE_FILE_BYTES {
            return Err(ConfigError::SourceInvalid(format!(
                "source exceeds 1 MiB: {} bytes",
                bytes.len()
            )));
        }

        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            return Err(ConfigError::Parse("source contains UTF-8 BOM".to_string()));
        }

        let s = std::str::from_utf8(bytes)
            .map_err(|_| ConfigError::SourceInvalid("invalid UTF-8".to_string()))?;

        check_toml_secrets(s)?;

        let mut raw: RawConfigV1 = toml::from_str(s).map_err(|e| {
            let msg = e.to_string();
            if msg.contains("unknown field") {
                let field = extract_field_name(&msg);
                ConfigError::UnknownKey(field)
            } else if msg.contains("invalid type") {
                ConfigError::InvalidType(msg)
            } else {
                ConfigError::Parse(msg)
            }
        })?;

        raw.validate_schema_version()?;
        raw.validate_raw_layer()?;
        Ok(raw)
    }

    pub fn from_slice_json(bytes: &[u8]) -> Result<Self, ConfigError> {
        Self::parse_json(bytes)
    }

    pub fn from_slice_toml(bytes: &[u8]) -> Result<Self, ConfigError> {
        Self::parse_toml(bytes)
    }

    pub fn validate_layer(&mut self, _source_path: &str) -> Result<(), ConfigError> {
        self.validate_schema_version()?;
        self.validate_raw_layer()
    }

    fn validate_schema_version(&self) -> Result<(), ConfigError> {
        if let Some(v) = self.config_schema_version {
            if v != 1 {
                return Err(ConfigError::VersionUnsupported(v));
            }
        }
        Ok(())
    }

    pub fn validate_raw_layer(&mut self) -> Result<(), ConfigError> {
        // Validate individual layer bounds and values
        if let Some(ref mut h) = self.history {
            if let Some(ref mode) = h.mode {
                check_no_nul(mode, "history.mode")?;
                if mode == "engine" {
                    return Err(ConfigError::ValueNotImplemented(
                        "history.mode: 'engine' is not implemented".to_string(),
                    ));
                } else if mode != "append" {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.mode: invalid mode '{mode}'"
                    )));
                }
            }
            if let Some(compact_at) = h.compact_at {
                if !(0.40..=0.95).contains(&compact_at) || compact_at.is_nan() {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.compact_at: {compact_at}"
                    )));
                }
            }
            if let Some(compact_clear_at) = h.compact_clear_at {
                if !(0.10..0.90).contains(&compact_clear_at) || compact_clear_at.is_nan() {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.compact_clear_at: {compact_clear_at}"
                    )));
                }
            }
            if let Some(fraction) = h.compact_mass_fraction {
                if !(0.05..=1.00).contains(&fraction) || fraction.is_nan() {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.compact_mass_fraction: {fraction}"
                    )));
                }
            }
            if let Some(ref replay) = h.reasoning_replay {
                check_no_nul(replay, "history.reasoning_replay")?;
                if replay == "none" || replay == "all" {
                    return Err(ConfigError::ValueNotImplemented(format!(
                        "history.reasoning_replay: '{replay}' is a reserved future value and is not implemented"
                    )));
                } else if replay != "active" {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.reasoning_replay: {replay}"
                    )));
                }
            }
            if let Some(v) = h.artifact_inline_tokens {
                if !(64..=65536).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.artifact_inline_tokens: {v}"
                    )));
                }
            }
            if let Some(v) = h.artifact_batch_inline_tokens {
                if !(64..=262144).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.artifact_batch_inline_tokens: {v}"
                    )));
                }
            }
            if let Some(v) = h.artifact_preview_tokens {
                if !(64..=4096).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.artifact_preview_tokens: {v}"
                    )));
                }
            }
            if let Some(v) = h.safety_margin_ratio {
                if !(0.0..=0.10).contains(&v) || v.is_nan() {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.safety_margin_ratio: {v}"
                    )));
                }
            }
            if let Some(v) = h.safety_margin_min_tokens {
                if v > 8192 {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.safety_margin_min_tokens: {v}"
                    )));
                }
            }
            if let Some(v) = h.summary_segment_max_tokens {
                if !(256..=16384).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.summary_segment_max_tokens: {v}"
                    )));
                }
            }
            if let Some(v) = h.handoff_max_tokens {
                if !(256..=16384).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.handoff_max_tokens: {v}"
                    )));
                }
            }
            if let Some(ref mut p) = h.compactor_provider {
                check_no_nul(p, "history.compactor_provider")?;
                let p_trimmed = ascii_edge_trim(p);
                if !p_trimmed.is_empty() && p_trimmed != "openai" && p_trimmed != "openrouter" {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.compactor_provider: {p}"
                    )));
                }
                *p = p_trimmed.to_string();
            }
            if let Some(ref mut m) = h.compactor_model {
                check_no_nul(m, "history.compactor_model")?;
                let m_trimmed = ascii_edge_trim(m);
                if !m_trimmed.is_empty() && !(1..=256).contains(&m_trimmed.len()) {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.compactor_model: length must be 1..256 bytes, got {}",
                        m_trimmed.len()
                    )));
                }
                *m = m_trimmed.to_string();
            }
            if let Some(v) = h.compactor_timeout_ms {
                if !(1000..=300000).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.compactor_timeout_ms: {v}"
                    )));
                }
            }
            if let Some(v) = h.compactor_max_output_tokens {
                if !(256..=16384).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "history.compactor_max_output_tokens: {v}"
                    )));
                }
            }
        }

        if let Some(ref s) = self.state {
            if let Some(v) = s.active_max_tokens {
                if !(256..=16384).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "state.active_max_tokens: {v}"
                    )));
                }
            }
            if let Some(v) = s.auto_hydrate_max {
                if v > 32 {
                    return Err(ConfigError::InvalidValue(format!(
                        "state.auto_hydrate_max: {v}"
                    )));
                }
            }
            if let Some(v) = s.idle_soft_after_turns {
                if !(1..=100000).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "state.idle_soft_after_turns: {v}"
                    )));
                }
            }
            if let Some(v) = s.idle_hard_after_turns {
                if !(1..=100000).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "state.idle_hard_after_turns: {v}"
                    )));
                }
            }
            if let Some(ref v) = s.automation_policy_version {
                check_no_nul(v, "state.automation_policy_version")?;
                if v != "state-lexical-v1" {
                    return Err(ConfigError::InvalidValue(format!(
                        "state.automation_policy_version: {v}"
                    )));
                }
            }
        }

        if let Some(ref mut l) = self.llm {
            if let Some(ref mut p) = l.provider {
                check_no_nul(p, "llm.provider")?;
                let p_trimmed = ascii_edge_trim(p);
                if !p_trimmed.is_empty() && p_trimmed != "openai" && p_trimmed != "openrouter" {
                    return Err(ConfigError::InvalidValue(format!("llm.provider: {p}")));
                }
                *p = p_trimmed.to_string();
            }
            if let Some(ref proto) = l.protocol {
                check_no_nul(proto, "llm.protocol")?;
                if proto != "auto" && proto != "openai-chat-v1" && proto != "openai-responses-v1" {
                    return Err(ConfigError::InvalidValue(format!("llm.protocol: {proto}")));
                }
            }
            if let Some(ref mut m) = l.model {
                check_no_nul(m, "llm.model")?;
                let m_trimmed = ascii_edge_trim(m);
                if !m_trimmed.is_empty() && !(1..=256).contains(&m_trimmed.len()) {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.model: length must be 1..256 bytes, got {}",
                        m_trimmed.len()
                    )));
                }
                *m = m_trimmed.to_string();
            }
            if let Some(cw) = l.context_window {
                if cw != 0 && !(2048..=2147483647).contains(&cw) {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.context_window: {cw}"
                    )));
                }
            }
            if let Some(v) = l.max_output_tokens {
                if !(1..=1048576).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.max_output_tokens: {v}"
                    )));
                }
            }
            if let Some(v) = l.min_output_tokens {
                if !(1..=1048576).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.min_output_tokens: {v}"
                    )));
                }
            }
            if let Some(ref r) = l.reasoning_effort {
                check_no_nul(r, "llm.reasoning_effort")?;
                if r != "off"
                    && r != "minimal"
                    && r != "low"
                    && r != "medium"
                    && r != "high"
                    && r != "xhigh"
                {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.reasoning_effort: {r}"
                    )));
                }
            }
            if let Some(v) = l.reasoning_reserve_tokens {
                if v > 1048576 {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.reasoning_reserve_tokens: {v}"
                    )));
                }
            }
            if let Some(v) = l.request_timeout_ms {
                if !(1000..=600000).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.request_timeout_ms: {v}"
                    )));
                }
            }
            if let Some(ref mut p) = l.fallback_provider {
                check_no_nul(p, "llm.fallback_provider")?;
                let p_trimmed = ascii_edge_trim(p);
                if !p_trimmed.is_empty() && p_trimmed != "openai" && p_trimmed != "openrouter" {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.fallback_provider: {p}"
                    )));
                }
                *p = p_trimmed.to_string();
            }
            if let Some(ref proto) = l.fallback_protocol {
                check_no_nul(proto, "llm.fallback_protocol")?;
                if proto != "auto" && proto != "openai-chat-v1" && proto != "openai-responses-v1" {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.fallback_protocol: {proto}"
                    )));
                }
            }
            if let Some(ref mut m) = l.fallback_model {
                check_no_nul(m, "llm.fallback_model")?;
                let m_trimmed = ascii_edge_trim(m);
                if !m_trimmed.is_empty() && !(1..=256).contains(&m_trimmed.len()) {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.fallback_model: length must be 1..256 bytes, got {}",
                        m_trimmed.len()
                    )));
                }
                *m = m_trimmed.to_string();
            }
            if let Some(cw) = l.fallback_context_window {
                if cw != 0 && !(2048..=2147483647).contains(&cw) {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.fallback_context_window: {cw}"
                    )));
                }
            }
            if let Some(Some(tm)) = l.temperature_milli {
                if tm > 2000 {
                    return Err(ConfigError::InvalidValue(format!(
                        "llm.temperature_milli: {tm}"
                    )));
                }
            }
        }

        if let Some(ref mut p) = self.providers {
            if let Some(ref mut oai) = p.openai {
                if let Some(ref mut base_url) = oai.base_url {
                    check_no_nul(base_url, "providers.openai.base_url")?;
                    let b_trimmed = ascii_edge_trim(base_url);
                    *base_url = b_trimmed.to_string();
                }
                if let Some(ref mut headers) = oai.extra_headers {
                    validate_and_normalize_extra_headers(headers)?;
                }
            }
            if let Some(ref mut or) = p.openrouter {
                if let Some(ref mut base_url) = or.base_url {
                    check_no_nul(base_url, "providers.openrouter.base_url")?;
                    let b_trimmed = ascii_edge_trim(base_url);
                    *base_url = b_trimmed.to_string();
                }
                if let Some(ref mut headers) = or.extra_headers {
                    validate_and_normalize_extra_headers(headers)?;
                }
            }
        }

        if let Some(ref t) = self.turn {
            if let Some(v) = t.max_steps {
                if !(1..=1000).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!("turn.max_steps: {v}")));
                }
            }
            if let Some(v) = t.max_attempts {
                if !(1..=3).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!("turn.max_attempts: {v}")));
                }
            }
        }

        if let Some(ref t) = self.tools {
            if let Some(ref paths) = t.allowed_paths {
                if paths.len() > 64 {
                    return Err(ConfigError::InvalidValue(
                        "tools.allowed_paths: maximum 64 paths allowed".to_string(),
                    ));
                }
                for path in paths {
                    check_no_nul(path, "tools.allowed_paths")?;
                    if path.len() > 4096 {
                        return Err(ConfigError::InvalidValue(
                            "tools.allowed_paths: path exceeds 4096 bytes".to_string(),
                        ));
                    }
                }
            }
            if let Some(v) = t.max_parallel_calls {
                if !(1..=32).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "tools.max_parallel_calls: {v}"
                    )));
                }
            }
            if let Some(v) = t.max_spawned_processes {
                if !(1..=8).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "tools.max_spawned_processes: {v}"
                    )));
                }
            }
            if let Some(v) = t.default_timeout_ms {
                if !(10..=60000).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "tools.default_timeout_ms: {v}"
                    )));
                }
            }
            if let Some(v) = t.shell_timeout_ms {
                if !(10..=600000).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "tools.shell_timeout_ms: {v}"
                    )));
                }
            }
            if let Some(v) = t.shell_max_timeout_ms {
                if !(10..=600000).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "tools.shell_max_timeout_ms: {v}"
                    )));
                }
            }
        }

        if let Some(ref r) = self.risk {
            if let Some(ref allow) = r.allow {
                const VALID_CLASSES: &[&str] = &[
                    "rm",
                    "git_reset",
                    "git_force_push",
                    "git_clean",
                    "gh_issue_close",
                    "gh_pr_merge",
                    "package_install",
                    "write_outside_cwd",
                ];
                let mut seen = std::collections::HashSet::new();
                for item in allow {
                    check_no_nul(item, "risk.allow")?;
                    if !VALID_CLASSES.contains(&item.as_str()) {
                        return Err(ConfigError::InvalidValue(format!(
                            "risk.allow: unknown class '{item}'"
                        )));
                    }
                    if !seen.insert(item.as_str()) {
                        return Err(ConfigError::InvalidValue(format!(
                            "risk.allow: duplicate class '{item}'"
                        )));
                    }
                }
            }
        }

        if let Some(ref c) = self.circuit {
            if let Some(v) = c.loop_threshold {
                if !(2..=100).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "circuit.loop_threshold: {v}"
                    )));
                }
            }
            if let Some(v) = c.max_tokens {
                if v > 9007199254740991 {
                    return Err(ConfigError::InvalidValue(format!(
                        "circuit.max_tokens: {v}"
                    )));
                }
            }
            if let Some(v) = c.max_wall_ms {
                if v > 604800000 {
                    return Err(ConfigError::InvalidValue(format!(
                        "circuit.max_wall_ms: {v}"
                    )));
                }
            }
        }

        if let Some(ref s) = self.session {
            if let Some(ref root) = s.root {
                check_no_nul(root, "session.root")?;
                if root.len() > 4096 {
                    return Err(ConfigError::InvalidValue(
                        "session.root: path exceeds 4096 bytes".to_string(),
                    ));
                }
            }
            if let Some(v) = s.retention_days {
                if v > 36500 {
                    return Err(ConfigError::InvalidValue(format!(
                        "session.retention_days: {v}"
                    )));
                }
            }
            if let Some(v) = s.orphan_retention_days {
                if v > 36500 {
                    return Err(ConfigError::InvalidValue(format!(
                        "session.orphan_retention_days: {v}"
                    )));
                }
            }
            if let Some(v) = s.shutdown_grace_ms {
                if v > 10000 {
                    return Err(ConfigError::InvalidValue(format!(
                        "session.shutdown_grace_ms: {v}"
                    )));
                }
            }
        }

        if let Some(ref l) = self.logging {
            if let Some(ref dir) = l.directory {
                check_no_nul(dir, "logging.directory")?;
                if dir.len() > 4096 {
                    return Err(ConfigError::InvalidValue(
                        "logging.directory: path exceeds 4096 bytes".to_string(),
                    ));
                }
            }
            if let Some(ref v) = l.level {
                check_no_nul(v, "logging.level")?;
                if v != "trace" && v != "debug" && v != "info" && v != "warn" && v != "error" {
                    return Err(ConfigError::InvalidValue(format!("logging.level: {v}")));
                }
            }
            if let Some(ref v) = l.format {
                check_no_nul(v, "logging.format")?;
                if v != "text" && v != "json" {
                    return Err(ConfigError::InvalidValue(format!("logging.format: {v}")));
                }
            }
            if let Some(v) = l.rotate_bytes {
                if !(1048576..=1073741824).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "logging.rotate_bytes: {v}"
                    )));
                }
            }
            if let Some(v) = l.keep_files {
                if !(1..=100).contains(&v) {
                    return Err(ConfigError::InvalidValue(format!(
                        "logging.keep_files: {v}"
                    )));
                }
            }
        }

        if let Some(ref m) = self.memory {
            if let Some(ref v) = m.plugin {
                check_no_nul(v, "memory.plugin")?;
                if v == "builtin:sqlite" {
                    return Err(ConfigError::FeatureNotImplemented(
                        "memory.plugin: 'builtin:sqlite' is not implemented in P1A".to_string(),
                    ));
                } else if v != "none" {
                    return Err(ConfigError::InvalidValue(format!("memory.plugin: {v}")));
                }
            }
            if let Some(ref opt) = m.options {
                if let Some(ref db_path) = opt.db_path {
                    check_no_nul(db_path, "memory.options.db_path")?;
                    if db_path.len() > 4096 {
                        return Err(ConfigError::InvalidValue(
                            "memory.options.db_path: path exceeds 4096 bytes".to_string(),
                        ));
                    }
                }
                if let Some(v) = opt.digest_max_tokens {
                    if !(64..=16384).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.options.digest_max_tokens: {v}"
                        )));
                    }
                }
                if let Some(v) = opt.recall_limit {
                    if !(1..=50).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.options.recall_limit: {v}"
                        )));
                    }
                }
            }
            if let Some(ref t) = m.timeouts {
                if let Some(v) = t.open_ms {
                    if !(1..=10000).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.timeouts.open_ms: {v}"
                        )));
                    }
                }
                if let Some(v) = t.start_ms {
                    if !(1..=10000).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.timeouts.start_ms: {v}"
                        )));
                    }
                }
                if let Some(v) = t.recall_ms {
                    if !(1..=10000).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.timeouts.recall_ms: {v}"
                        )));
                    }
                }
                if let Some(v) = t.remember_ms {
                    if !(1..=10000).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.timeouts.remember_ms: {v}"
                        )));
                    }
                }
                if let Some(v) = t.retract_ms {
                    if !(1..=10000).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.timeouts.retract_ms: {v}"
                        )));
                    }
                }
                if let Some(v) = t.pin_ms {
                    if !(1..=10000).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.timeouts.pin_ms: {v}"
                        )));
                    }
                }
                if let Some(v) = t.feedback_ms {
                    if !(1..=5000).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.timeouts.feedback_ms: {v}"
                        )));
                    }
                }
                if let Some(v) = t.stats_ms {
                    if !(1..=5000).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.timeouts.stats_ms: {v}"
                        )));
                    }
                }
                if let Some(v) = t.end_ms {
                    if !(1..=60000).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.timeouts.end_ms: {v}"
                        )));
                    }
                }
                if let Some(v) = t.close_ms {
                    if !(1..=5000).contains(&v) {
                        return Err(ConfigError::InvalidValue(format!(
                            "memory.timeouts.close_ms: {v}"
                        )));
                    }
                }
            }
        }

        Ok(())
    }
}

fn validate_and_normalize_extra_headers(
    headers: &mut BTreeMap<String, String>,
) -> Result<(), ConfigError> {
    if headers.len() > 32 {
        return Err(ConfigError::InvalidValue(
            "extra_headers: maximum 32 extra headers allowed".to_string(),
        ));
    }
    let mut seen_lower = std::collections::HashSet::new();
    for (name, val) in headers.iter() {
        if !is_http_token(name) {
            return Err(ConfigError::InvalidValue(format!(
                "extra_headers: invalid HTTP header name '{name}'"
            )));
        }
        let name_lower = name.to_ascii_lowercase();
        if !seen_lower.insert(name_lower.clone()) {
            return Err(ConfigError::InvalidValue(format!(
                "extra_headers: duplicate header name '{name}' (case-insensitive)"
            )));
        }
        if FORBIDDEN_EXTRA_HEADERS.contains(&name_lower.as_str()) {
            return Err(ConfigError::SecretForbidden(format!(
                "extra_headers.{name}"
            )));
        }
        if val.len() > 4096 {
            return Err(ConfigError::InvalidValue(format!(
                "extra_headers.{name}: header value exceeds 4096 bytes"
            )));
        }
        if val.contains('\r') || val.contains('\n') || val.contains('\0') {
            return Err(ConfigError::InvalidValue(format!(
                "extra_headers.{name}: header value contains CR/LF/NUL"
            )));
        }
        if val.to_ascii_lowercase().starts_with("bearer ") {
            return Err(ConfigError::SecretForbidden(format!(
                "extra_headers.{name}"
            )));
        }
        if val.contains("-----BEGIN ") {
            return Err(ConfigError::SecretForbidden(format!(
                "extra_headers.{name}"
            )));
        }
        if matches_redaction_rows_2_to_6(val) {
            return Err(ConfigError::SecretForbidden(format!(
                "extra_headers.{name}"
            )));
        }
    }
    Ok(())
}

fn check_json_duplicates_and_secrets(s: &str) -> Result<(), ConfigError> {
    let mut parser = serde_json::Deserializer::from_str(s);
    use serde::de::DeserializeSeed;
    let mut tracker = DuplicateKeyTracker::new();
    tracker.deserialize(&mut parser).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("duplicate key") {
            ConfigError::Parse(msg)
        } else if msg.contains("secret") {
            ConfigError::SecretForbidden("secret_key".to_string())
        } else if msg.contains("null") {
            ConfigError::InvalidType(msg)
        } else {
            ConfigError::Parse(msg)
        }
    })?;
    Ok(())
}

fn check_toml_secrets(s: &str) -> Result<(), ConfigError> {
    for secret in FORBIDDEN_SECRET_KEYS {
        // Look for secret key tokens in toml lines
        for line in s.lines() {
            let line = line.split('#').next().unwrap().trim();
            if let Some((key_part, _)) = line.split_once('=') {
                let k = key_part.trim();
                if k.eq_ignore_ascii_case(secret) || k.ends_with(&format!(".{secret}")) {
                    return Err(ConfigError::SecretForbidden(secret.to_string()));
                }
            }
        }
    }
    Ok(())
}

fn extract_field_name(msg: &str) -> String {
    if let Some(start) = msg.find('`') {
        if let Some(end) = msg[start + 1..].find('`') {
            return msg[start + 1..start + 1 + end].to_string();
        }
    }
    msg.to_string()
}

// Recursive serde JSON duplicate key detector
struct DuplicateKeyTracker;

impl DuplicateKeyTracker {
    fn new() -> Self {
        Self
    }
}

impl<'de> serde::de::DeserializeSeed<'de> for &mut DuplicateKeyTracker {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = ();
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("any valid JSON value")
            }

            fn visit_map<M>(self, mut access: M) -> Result<Self::Value, M::Error>
            where
                M: serde::de::MapAccess<'de>,
            {
                let mut seen_keys = std::collections::HashSet::new();
                while let Some(key) = access.next_key::<String>()? {
                    let key_lower = key.to_ascii_lowercase();
                    for secret in FORBIDDEN_SECRET_KEYS {
                        if key_lower == *secret {
                            return Err(serde::de::Error::custom(format!(
                                "forbidden secret key '{key}'"
                            )));
                        }
                    }
                    if !seen_keys.insert(key_lower.clone()) {
                        return Err(serde::de::Error::custom(format!("duplicate key '{key}'")));
                    }
                    let mut sub_tracker = DuplicateKeyTracker::new();
                    access.next_value_seed(&mut sub_tracker)?;
                }
                Ok(())
            }

            fn visit_seq<S>(self, mut access: S) -> Result<Self::Value, S::Error>
            where
                S: serde::de::SeqAccess<'de>,
            {
                while access.next_element::<serde_json::Value>()?.is_some() {}
                Ok(())
            }

            fn visit_bool<E>(self, _v: bool) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_i64<E>(self, _v: i64) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_u64<E>(self, _v: u64) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_f64<E>(self, _v: f64) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_str<E>(self, _v: &str) -> Result<Self::Value, E> {
                Ok(())
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Err(E::custom("JSON null is not permitted in configuration"))
            }
            fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Err(E::custom("JSON null is not permitted in configuration"))
            }
        }

        deserializer.deserialize_any(Visitor)
    }
}
