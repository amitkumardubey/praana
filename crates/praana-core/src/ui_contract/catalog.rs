//! Slash, path-completion, model-catalog, and reasoning DTOs.
//!
//! The core supplies canonical slash ordering and metadata. The UI may
//! fuzzy-filter a returned page but never invents commands. Path completion is
//! display assistance only and grants no filesystem authority.

use serde::{Deserialize, Serialize};

use crate::ui_contract::ids::{ModelCatalogCursor, PathCompletionCursor, SlashCatalogCursor};
use crate::ui_contract::json_data::{ModelId, ProviderId};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProviderProtocol {
    #[serde(rename = "openai_chat_completions")]
    OpenAiChatCompletions,
    #[serde(rename = "openai_responses")]
    OpenAiResponses,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelCatalogSource {
    Static,
    Live,
    Cache,
    Local,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelAvailability {
    Available,
    AuthenticationRequired,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlashArgumentKind {
    None,
    Optional,
    Required,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlashHandoff {
    None,
    ModelSelector,
    Login,
    Logout,
    Setup,
    Settings,
    Sessions,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SlashCommandDto {
    pub name: String,
    pub aliases: Vec<String>,
    pub usage: String,
    pub description: String,
    pub argument_kind: SlashArgumentKind,
    pub handoff: SlashHandoff,
    pub order: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SlashCatalogPageDto {
    pub revision: u64,
    pub items: Vec<SlashCommandDto>,
    pub next_cursor: Option<SlashCatalogCursor>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlashDisplay {
    Toast,
    Transcript,
    Overlay,
    None,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlashAction {
    None,
    Exit,
    ClearTranscript,
    NewSession,
    RefreshStatus,
    OpenModelSelector,
    OpenLogin,
    OpenLogout,
    OpenSetup,
    OpenSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SlashResultDto {
    pub display: SlashDisplay,
    pub title: Option<String>,
    pub lines: Vec<String>,
    pub action: SlashAction,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PathEntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PathCompletionDto {
    pub display: String,
    pub replacement: String,
    pub kind: PathEntryKind,
    pub append_separator: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PathCompletionPageDto {
    pub token: String,
    pub items: Vec<PathCompletionDto>,
    pub next_cursor: Option<PathCompletionCursor>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelDescriptorDto {
    pub provider: ProviderId,
    pub model_id: ModelId,
    pub display_name: String,
    pub protocol: ProviderProtocol,
    pub context_window_tokens: u64,
    pub reasoning_levels: Vec<ReasoningEffort>,
    pub availability: ModelAvailability,
    pub selected: bool,
    pub source: ModelCatalogSource,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelCatalogPageDto {
    pub revision: u64,
    pub items: Vec<ModelDescriptorDto>,
    pub next_cursor: Option<ModelCatalogCursor>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ActiveModelDto {
    pub provider: ProviderId,
    pub model_id: ModelId,
    pub display_name: String,
    pub protocol: ProviderProtocol,
    pub reasoning_effort: ReasoningEffort,
    pub context_window_tokens: u64,
    pub boundary_canonical_sequence: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReasoningStateDto {
    pub requested: ReasoningEffort,
    pub effective: ReasoningEffort,
    pub supported: Vec<ReasoningEffort>,
    pub boundary_canonical_sequence: Option<u64>,
}
