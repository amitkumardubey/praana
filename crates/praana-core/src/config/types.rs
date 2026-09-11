use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct HistoryConfig {
    pub artifact_batch_inline_tokens: u64,
    pub artifact_inline_tokens: u64,
    pub artifact_preview_tokens: u64,
    pub compact_at: f64,
    pub compact_clear_at: f64,
    pub compact_mass_fraction: f64,
    pub compactor_max_output_tokens: u64,
    pub compactor_model: String,
    pub compactor_provider: String,
    pub compactor_timeout_ms: u64,
    pub handoff_max_tokens: u64,
    pub mode: String,
    pub reasoning_replay: String,
    pub safety_margin_min_tokens: u64,
    pub safety_margin_ratio: f64,
    pub summary_segment_max_tokens: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateConfig {
    pub active_max_tokens: u64,
    pub auto_hydrate: bool,
    pub auto_hydrate_max: u32,
    pub automation_policy_version: String,
    pub idle_hard_after_turns: u64,
    pub idle_soft_after_turns: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LlmConfig {
    pub context_window: u64,
    pub fallback_context_window: u64,
    pub fallback_model: String,
    pub fallback_protocol: String,
    pub fallback_provider: String,
    pub max_output_tokens: u64,
    pub min_output_tokens: u64,
    pub model: String,
    pub protocol: String,
    pub provider: String,
    pub reasoning_effort: String,
    pub reasoning_reserve_tokens: u64,
    pub request_timeout_ms: u64,
    pub temperature_milli: Option<u32>,
    pub unsafe_allow_context_window_increase: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderOpenAiConfig {
    pub base_url: String,
    pub extra_headers: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderOpenRouterConfig {
    pub base_url: String,
    pub extra_headers: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProvidersConfig {
    pub openai: ProviderOpenAiConfig,
    pub openrouter: ProviderOpenRouterConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnConfig {
    pub max_attempts: u32,
    pub max_steps: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolsConfig {
    pub allowed_paths: Vec<String>,
    pub default_timeout_ms: u64,
    pub max_parallel_calls: u32,
    pub max_spawned_processes: u32,
    pub shell_enabled: bool,
    pub shell_max_timeout_ms: u64,
    pub shell_timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RiskConfig {
    pub allow: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CircuitConfig {
    pub loop_threshold: u32,
    pub max_tokens: u64,
    pub max_wall_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionConfig {
    pub incognito: bool,
    pub orphan_retention_days: u32,
    pub retention_days: u32,
    pub root: String,
    pub shutdown_grace_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LoggingConfig {
    pub directory: String,
    pub file: bool,
    pub format: String,
    pub keep_files: u32,
    pub level: String,
    pub rotate_bytes: u64,
    pub stderr: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemoryOptionsConfig {
    pub db_path: String,
    pub digest_max_tokens: u64,
    pub extraction: bool,
    pub llm_contradictions: bool,
    pub recall_limit: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemoryTimeoutsConfig {
    pub close_ms: u64,
    pub end_ms: u64,
    pub feedback_ms: u64,
    pub open_ms: u64,
    pub pin_ms: u64,
    pub recall_ms: u64,
    pub remember_ms: u64,
    pub retract_ms: u64,
    pub start_ms: u64,
    pub stats_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemoryConfig {
    pub options: MemoryOptionsConfig,
    pub plugin: String,
    pub timeouts: MemoryTimeoutsConfig,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemorySelection {
    None,
}

impl MemorySelection {
    pub fn selection_record(&self, incognito: bool) -> &'static str {
        match self {
            MemorySelection::None => {
                if incognito {
                    "none_incognito"
                } else {
                    "none"
                }
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EffectiveConfigV1 {
    pub circuit: CircuitConfig,
    pub config_schema_version: u32,
    pub history: HistoryConfig,
    pub llm: LlmConfig,
    pub logging: LoggingConfig,
    pub memory: MemoryConfig,
    pub providers: ProvidersConfig,
    pub risk: RiskConfig,
    pub session: SessionConfig,
    pub state: StateConfig,
    pub tools: ToolsConfig,
    pub turn: TurnConfig,
}

impl EffectiveConfigV1 {
    pub fn memory_selection(&self) -> (MemorySelection, &'static str) {
        let sel = MemorySelection::None;
        let rec = sel.selection_record(self.session.incognito);
        (sel, rec)
    }
}
