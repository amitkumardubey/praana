//! Provider-neutral system and project context (packet P1D).
//!
//! Ownership: `docs/RUST_V2_SYSTEM_CONTEXT_SPEC.md` exclusively owns stable
//! policy bytes, project-context discovery/normalization/bounds, rendering,
//! slot assembly, and hashes. This crate also owns the reusable report-only
//! secret detector consumed here (see `crate::redaction`).
//!
//! Scope: this packet produces data only. It never formats provider messages,
//! renders history, loads skill bodies, or mutates secrets.

pub mod load;
pub mod render;
pub mod skills;
pub mod stack;

pub use load::{
    discover_project_context, normalize_instruction_bytes, project_context_changed_since_create,
    project_context_source_sha256, resume_context_warnings, ContextPathResolution,
    LoadedProjectContext, ProjectContextSource, SourceScope, PROJECT_CONTEXT_CHANGED_SINCE_CREATE,
};
pub use render::{
    build_instruction_slots, compile_system_context, render_current_state, render_project_context,
    OMISSION_RECORD, SYSTEM_POLICY,
};
pub use skills::{render_skill_lines, validate_skills, SkillCatalogEntryV1, SkillScopeV1};
pub use stack::{detect_project_stack, render_stack_lines, StackMarker};

use crate::protocol::constants::SYSTEM_CONTEXT_SCHEMA_VERSION;
use crate::protocol::id::{SessionId, Sha256Digest};
use crate::protocol::models::{HistoryMode, ReasoningEffort};
use serde::{Deserialize, Serialize};

/// Domain separator of `stable_prefix_sha256` (System Context section 7).
pub const SYSTEM_PREFIX_DOMAIN: &str = "praana-system-context-v1";

/// Domain separator of `project_context_source_sha256` (System Context 7.1).
pub const PROJECT_CONTEXT_SOURCE_DOMAIN: &str = "praana-project-context-source-v1";

/// Combined normalized rendering bound in bytes (System Context section 3).
pub const MAX_COMBINED_CONTEXT_BYTES: usize = 65536;

/// Per-file bound before newline normalization (System Context section 3).
pub const MAX_SOURCE_FILE_BYTES: usize = 65536;

/// Runtime component availability for volatile facts (System Context sections
/// 2 and 6). This is the single crate-wide `ComponentState` defined by the UI
/// Contract (`available` / `disabled` / `unavailable` / `degraded` /
/// `starting`); the runtime-fact block renders its snake_case token verbatim
/// so the system slots and the UI enum can never diverge.
pub use crate::ui_contract::result::ComponentState;

/// Render a `ComponentState` as the exact snake_case runtime-fact token
/// (System Context section 6). Kept in this module because the enum is owned
/// by the UI Contract; the mapping is total over every variant.
pub(crate) fn render_component_state(state: &ComponentState) -> &'static str {
    match state {
        ComponentState::Available => "available",
        ComponentState::Disabled => "disabled",
        ComponentState::Unavailable => "unavailable",
        ComponentState::Degraded => "degraded",
        ComponentState::Starting => "starting",
    }
}

/// Structured loader/slot error. Codes are stable; diagnostics carry relative
/// labels and error codes but never instruction content or absolute paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemContextError {
    pub code: String,
    pub label: Option<String>,
    pub detail: String,
}

impl SystemContextError {
    pub fn new(code: &str, label: Option<&str>, detail: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            label: label.map(|l| l.to_owned()),
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for SystemContextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.label {
            Some(label) => write!(f, "{}: {label}: {}", self.code, self.detail),
            None => write!(f, "{}: {}", self.code, self.detail),
        }
    }
}

impl std::error::Error for SystemContextError {}

/// Reasoning-effort domain re-declared for slot input plumbing convenience.
pub type SlotReasoningEffort = ReasoningEffort;

/// Session-scoped context input (System Context section 2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemContextInputV1 {
    pub praana_version: String,
    pub cwd: String,
    pub git_root: Option<String>,
    pub session_id: SessionId,
    pub history_mode: HistoryMode,
    pub native_status: ComponentState,
    pub search_status: ComponentState,
    pub lsp_status: ComponentState,
    pub skills: Vec<SkillCatalogEntryV1>,
}

/// Provider-neutral instruction slots (System Context section 2). Memory and
/// handoff remain JSON null in this packet; providers assemble the final
/// instruction string with exactly two LF bytes between present slots.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct InstructionSlotsV1 {
    pub system_context_schema_version: u32,
    pub system_policy: String,
    pub project_context: String,
    pub cross_session_memory: Option<String>,
    pub historical_handoff: Option<String>,
    pub current_state: String,
    pub stable_prefix_sha256: Sha256Digest,
}

/// Re-export of the schema constant for slot callers.
pub const SYSTEM_CONTEXT_SCHEMA: u32 = SYSTEM_CONTEXT_SCHEMA_VERSION;
