//! Memory plugin contract DTOs (Memory spec §6–§9.1).
//!
//! Language-neutral JSON per §2: every field is a required lower-snake-case
//! property, `Option<T>` is still required and serializes as `T` or null,
//! unit enums are lower-snake-case strings, and payload enums use the exact
//! adjacent `type`/`data` tag. This module is deliberately independent of
//! Rusqlite, Tokio process types, provider structs, and `Session` (§4).
//!
//! P6-1 provides the types, the strict decoder, and the `validate()` bound
//! checkers only. Truncation, ordering, and selection are core-adapter work.

use std::collections::{BTreeMap, HashSet};

use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::canonical_json::to_canonical_json_bytes;
use crate::compaction::schema::normalize_draft_2020_12_schema;
use crate::memory::MEMORY_API_VERSION;
use crate::protocol::constants::{MAX_ID_BYTES, MAX_MODEL_LABEL_BYTES};
use crate::protocol::id::{
    ArtifactId, EventId, SessionId, Sha256Digest, StateId, ToolCallId, TurnId,
};
use crate::protocol::json::check_raw_duplicate_keys_with_max_depth;

/// The one DTO schema version defined by the Memory spec (§6).
pub const MEMORY_DTO_SCHEMA_VERSION: u32 = 1;

/// Raw decode guard (no §-listed bound; prevents unbounded scanning).
pub const MAX_RAW_MEMORY_DTO_BYTES: usize = 1024 * 1024;
/// JSON nesting limit for memory DTO input (protocol §5 bound).
pub const MAX_MEMORY_DTO_JSON_DEPTH: usize = 64;

// --- explicit bounds (§6–§9.1) ------------------------------------------

pub const MEMORY_PLUGIN_ID_MAX_CHARS: usize = 64;
pub const MEMORY_INVOCATION_ID_MAX_BYTES: usize = 128;
pub const MEMORY_CWD_LABEL_MAX_SCALARS: usize = 128;
pub const MEMORY_DIGEST_MAX_CONTENT_BYTES: usize = 64 * 1024;
pub const MEMORY_RECALL_QUERY_MAX_BYTES: usize = 2000;
pub const MEMORY_RECALL_LIMIT_MIN: u32 = 1;
pub const MEMORY_RECALL_LIMIT_MAX: u32 = 50;
pub const MEMORY_RECALL_KINDS_MAX_UNIQUE: usize = 6;
pub const MEMORY_REMEMBER_CONTENT_MAX_BYTES: usize = 2000;
pub const MEMORY_ERROR_MESSAGE_MAX_BYTES: usize = 1000;
pub const MEMORY_LOG_MESSAGE_MAX_BYTES: usize = 4096;
pub const MEMORY_COMPLETION_SYSTEM_PROMPT_MAX_BYTES: usize = 262_144;
pub const MEMORY_COMPLETION_RESPONSE_SCHEMA_MAX_BYTES: usize = 65_536;
pub const MEMORY_COMPLETION_RESPONSE_SCHEMA_MAX_DEPTH: usize = 16;
pub const MEMORY_COMPLETION_MAX_OUTPUT_TOKENS: u32 = 4096;
pub const MEMORY_COMPLETION_TEMPERATURE_MILLI_MAX: u16 = 1000;
pub const MEMORY_COMPLETION_TIMEOUT_MS_MAX: u32 = 30_000;
pub const MEMORY_COMPLETION_RESPONSE_TEXT_MAX_BYTES: usize = 65_536;
pub const MEMORY_STATE_OBJECT_MAX_CANONICAL_BYTES: usize = 4096;
pub const MEMORY_STATE_SNAPSHOT_MAX_CANONICAL_BYTES: usize = 256 * 1024;
pub const MEMORY_ARTIFACT_SUMMARY_MAX_CANONICAL_BYTES: usize = 2048;
pub const MEMORY_ARTIFACT_SUMMARIES_MAX: usize = 100;
pub const MEMORY_TRANSCRIPT_DISPLAY_LABEL_MAX_BYTES: usize = 256;
pub const MEMORY_TRANSCRIPT_REDACTED_PREVIEW_MAX_BYTES: usize = 2048;

// ================================================================ §6 manifest

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryPluginManifest {
    pub id: String,
    pub display_name: String,
    pub plugin_version: String,
    pub api_version: u32,
    pub dto_schema_version: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryCapabilities {
    pub recall: bool,
    pub remember: bool,
    pub retract: bool,
    pub pin: bool,
    pub feedback: bool,
    pub startup_digest: bool,
    pub session_end_learning: bool,
    pub consolidation: bool,
    pub semantic_recall: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryHostCapabilities {
    pub llm_completion: bool,
    pub completion_json_schema: bool,
}

// ================================================================ §7.1 open

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryOpenRequest {
    pub api_version: u32,
    pub dto_schema_version: u32,
    pub plugin_id: String,
    pub options: MemoryOpenOptions,
    pub runtime: MemoryRuntimeInfo,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum MemoryOpenOptions {
    BuiltinSqlite(BuiltinSqliteOpenOptions),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BuiltinSqliteOpenOptions {
    pub db_path: String,
    pub extraction: bool,
    pub digest_max_tokens: u32,
    pub recall_limit: u32,
    pub llm_contradictions: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryRuntimeInfo {
    pub praana_version: String,
    pub implementation: String,
    pub os: String,
    pub arch: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemorySessionStart {
    pub session: MemorySessionContext,
    pub state_graph: StateGraphSnapshotDto,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemorySessionContext {
    pub session_id: SessionId,
    pub invocation_id: String,
    pub started_at_ms: i64,
    pub agent_scope: String,
    pub user_scope: String,
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub project_scope: Option<String>,
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub project_label: Option<String>,
    pub cwd_label: String,
}

// ================================================================ §7.2 bootstrap

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryBootstrap {
    pub invocation_ordinal: u64,
    #[schemars(required, extend("type" = ["object", "null"]))]
    pub digest: Option<MemoryDigest>,
    pub notices: Vec<MemoryNotice>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryDigest {
    pub format: MemoryDigestFormat,
    pub content: String,
    pub entry_ids: Vec<String>,
    pub estimated_tokens: u32,
    pub token_estimator_schema_version: u32,
    pub estimator_id: String,
    pub input_sha256: Sha256Digest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryDigestFormat {
    Markdown,
    PlainText,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryNotice {
    pub code: String,
    pub message: String,
    pub severity: MemoryNoticeSeverity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryNoticeSeverity {
    Info,
    Warning,
}

// ================================================================ §7.3 recall

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecallQuery {
    pub query: String,
    pub limit: u32,
    pub kinds: Vec<MemoryKind>,
    pub scope: RecallScope,
    pub mode: RecallMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecallScope {
    Auto,
    Project,
    Global,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RecallMode {
    Standard,
    CausalChain,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecallResult {
    pub entries: Vec<RecalledMemory>,
    #[schemars(required, extend("type" = ["object", "null"]))]
    pub notice: Option<MemoryNotice>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecalledMemory {
    pub id: String,
    pub kind: MemoryKind,
    pub content: String,
    pub scope: MemoryScope,
    pub validity: f32,
    pub usefulness: f32,
    pub match_score: f32,
    pub rank_score: f32,
    pub pinned: bool,
    pub evidence: Vec<MemoryEvidenceRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Fact,
    Preference,
    Decision,
    Pattern,
    Mistake,
    Constraint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    Project,
    Global,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryEvidenceRef {
    pub source_session_id: SessionId,
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub source_event_start: Option<EventId>,
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub source_event_end: Option<EventId>,
}

// ================================================================ §7.4 write

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RememberToolInput {
    pub content: String,
    pub kind: MemoryKind,
    pub certainty: MemoryCertainty,
    pub scope: MemoryScopeRequest,
    pub pinned: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScopeRequest {
    Auto,
    Project,
    Global,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RememberInput {
    pub content: String,
    pub kind: MemoryKind,
    pub certainty: MemoryCertainty,
    pub scope: MemoryScope,
    pub pinned: bool,
    pub source: MemoryWriteSource,
    pub evidence: Vec<MemoryEvidenceRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCertainty {
    High,
    Medium,
    Low,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryWriteSource {
    ExplicitTool,
    SessionExtraction,
    Consolidation,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RememberResult {
    pub id: String,
    pub disposition: RememberDisposition,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RememberDisposition {
    Created,
    Reinforced,
    Replaced,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetractMemoryInput {
    pub id: String,
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RetractMemoryResult {
    pub id: String,
    pub retracted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PinMemoryInput {
    pub id: String,
    pub pinned: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PinMemoryResult {
    pub id: String,
    pub pinned: bool,
}

// ================================================================ §7.5 feedback

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryFeedback {
    pub turn_id: TurnId,
    pub recalled_ids: Vec<String>,
    pub used_ids: Vec<String>,
    pub outcome: MemoryOutcomeSignal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryOutcomeSignal {
    Success,
    Failure,
    Interrupted,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryFeedbackResult {
    pub accepted_ids: Vec<String>,
}

// ================================================================ §7.6 session end

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemorySessionEnd {
    pub session_id: SessionId,
    pub through_sequence: u64,
    pub ended_at_ms: i64,
    pub reason: MemorySessionEndReason,
    pub outcome: MemoryOutcomeSignal,
    pub transcript: Vec<VisibleTranscriptItem>,
    pub final_state_graph: StateGraphSnapshotDto,
    pub artifact_summaries: Vec<RedactedArtifactSummaryDto>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemorySessionEndReason {
    Clean,
    Aborted,
    Error,
    ReplacedByNewSession,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemorySessionEndResult {
    pub learnings_created: u32,
    pub memories_reinforced: u32,
    pub memories_retracted: u32,
    pub memories_consolidated: u32,
    pub notices: Vec<MemoryNotice>,
}

// ================================================================ §7.7 stats/errors

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryStats {
    pub plugin_id: String,
    pub plugin_version: String,
    pub entries_active: u64,
    pub entries_retracted: u64,
    pub entries_pinned: u64,
    pub entries_project: u64,
    pub entries_global: u64,
    #[schemars(required, extend("type" = ["integer", "null"]))]
    pub storage_bytes: Option<u64>,
    #[schemars(required, extend("type" = ["integer", "null"]))]
    pub last_maintenance_at_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryPluginError {
    pub code: MemoryPluginErrorCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryPluginErrorCode {
    InvalidOptions,
    Unsupported,
    NotFound,
    InvalidInput,
    StorageBusy,
    StorageCorrupt,
    HostUnavailable,
    CompletionFailed,
    Cancelled,
    TimedOut,
    Internal,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryHostError {
    pub code: MemoryHostErrorCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryHostErrorCode {
    InvalidRequest,
    Unavailable,
    CompletionFailed,
    Cancelled,
    TimedOut,
    Internal,
}

// ================================================================ §8.1 host IDs/logs

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryHostIdKind {
    MemoryEntry,
    PluginOperation,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryPluginLogRecord {
    pub level: MemoryPluginLogLevel,
    pub message: String,
    pub fields: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryPluginLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

// ================================================================ §8.2 completion

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryCompletionRequest {
    pub purpose: MemoryCompletionPurpose,
    pub prompt_version: String,
    pub system: String,
    pub prompt: String,
    pub max_output_tokens: u32,
    pub temperature_milli: u16,
    #[schemars(required)]
    pub response_schema: Option<Value>,
    pub timeout_ms: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCompletionPurpose {
    ExtractLearnings,
    DetectContradiction,
    Consolidate,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryCompletionResponse {
    pub text: String,
    pub model_label: String,
    #[schemars(required, extend("type" = ["integer", "null"]))]
    pub input_tokens: Option<u64>,
    #[schemars(required, extend("type" = ["integer", "null"]))]
    pub output_tokens: Option<u64>,
}

// ================================================================ §9.1 transcript/state

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VisibleTranscriptItem {
    pub sequence: u64,
    pub event_id: EventId,
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub turn_id: Option<TurnId>,
    pub kind: VisibleTranscriptKind,
    pub timestamp_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum VisibleTranscriptKind {
    UserText { text: String },
    AssistantText { text: String },
    AssistantReasoningSummary { text: String },
    ToolObservation {
        tool_call_id: ToolCallId,
        tool_name: String,
        display_label: String,
        redacted_preview: String,
        #[schemars(required, extend("type" = ["object", "null"]))]
        artifact: Option<MemoryArtifactRef>,
        is_error: bool,
    },
    HistoricalHandoff { text: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryArtifactRef {
    pub artifact_id: ArtifactId,
    pub content_type: String,
    pub redacted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StateGraphSnapshotDto {
    pub at_event_sequence: u64,
    pub objects: Vec<StateObjectDto>,
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub focused_id: Option<StateId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StateObjectDto {
    pub id: StateId,
    pub kind: StateObjectKindDto,
    pub tier: StateTierDto,
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub status: Option<String>,
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub title: Option<String>,
    pub text: String,
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub rationale: Option<String>,
    pub retracted: bool,
    pub updated_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StateObjectKindDto {
    Task,
    Decision,
    Constraint,
    Note,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StateTierDto {
    Active,
    Soft,
    Hard,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RedactedArtifactSummaryDto {
    pub artifact_id: ArtifactId,
    pub producing_event_id: EventId,
    pub tool_name: String,
    pub display_label: String,
    pub content_type: String,
    pub redacted_summary: String,
    pub access_count: u32,
}

/// `ToolCallId` is an opaque provider string (protocol `id.rs`); it has no
/// schemars impl there, so the memory contract supplies the JSON Schema shape.
impl JsonSchema for ToolCallId {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "ToolCallId".into()
    }

    fn json_schema(_generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        serde_json::from_value(serde_json::json!({
            "type": "string",
            "minLength": 1,
            "maxLength": MAX_ID_BYTES
        }))
        .expect("tool call id schema")
    }
}

// ================================================================ schema generation

/// Generates the normalized Draft 2020-12 JSON Schema for one DTO using the
/// shared recipe from `compaction/schema.rs` (§2): local `$defs` inlined, no
/// `title`, `additionalProperties: false` on every object, sorted `required`.
/// Free-form map schemas (plugin log `fields`) keep schemars' own
/// `additionalProperties`.
pub fn dto_schema_value<T: JsonSchema>() -> Value {
    let mut generator = schemars::SchemaGenerator::default();
    let raw = serde_json::to_value(generator.root_schema_for::<T>())
        .expect("memory DTO schema serializes");
    normalize_draft_2020_12_schema(&raw, true)
}

/// RFC 8785 bytes of the normalized schema, with no trailing LF. These are the
/// checked-in file bytes.
pub fn dto_schema_bytes<T: JsonSchema>() -> Vec<u8> {
    to_canonical_json_bytes(&dto_schema_value::<T>()).expect("memory DTO schema canonicalizes")
}

// ================================================================ strict decoder

/// Phase of strict decoding that failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryDecodeErrorKind {
    /// Raw input exceeds the size guard.
    TooLarge,
    /// Not valid UTF-8.
    InvalidUtf8,
    /// Raw NUL byte present.
    NulBytes,
    /// Duplicate object key or nesting over the depth bound.
    DuplicateKey,
    /// Syntax error or non-finite number literal.
    MalformedJson,
    /// A string contains a NUL (escaped `\u0000`).
    NulString,
    /// A parsed number is NaN or infinite.
    NonFiniteNumber,
    /// Structure/schema mismatch (unknown field, missing key, bad tag, null
    /// where a non-Option type is required, ...).
    Shape,
}

/// Typed error from [`decode_dto`]; decoding never panics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryDecodeError {
    pub kind: MemoryDecodeErrorKind,
    pub message: String,
}

impl MemoryDecodeError {
    fn new(kind: MemoryDecodeErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

impl std::fmt::Display for MemoryDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "memory DTO decode error ({}): {}", self.kind_name(), self.message)
    }
}

impl std::error::Error for MemoryDecodeError {}

impl MemoryDecodeError {
    fn kind_name(&self) -> &'static str {
        match self.kind {
            MemoryDecodeErrorKind::TooLarge => "too_large",
            MemoryDecodeErrorKind::InvalidUtf8 => "invalid_utf8",
            MemoryDecodeErrorKind::NulBytes => "nul_bytes",
            MemoryDecodeErrorKind::DuplicateKey => "duplicate_key",
            MemoryDecodeErrorKind::MalformedJson => "malformed_json",
            MemoryDecodeErrorKind::NulString => "nul_string",
            MemoryDecodeErrorKind::NonFiniteNumber => "non_finite_number",
            MemoryDecodeErrorKind::Shape => "shape",
        }
    }
}

/// Strictly decodes a memory DTO from bytes (§2). Rejects, before or while
/// deserializing: duplicate object keys, unknown properties and tags, missing
/// required properties (including `Option` keys), null where the type is not
/// `Option`, NUL in any string, and NaN/infinity. Returns a typed error.
pub fn decode_dto<T: DeserializeOwned + JsonSchema>(
    raw: &[u8],
) -> Result<T, MemoryDecodeError> {
    if raw.len() > MAX_RAW_MEMORY_DTO_BYTES {
        return Err(MemoryDecodeError::new(
            MemoryDecodeErrorKind::TooLarge,
            "raw input exceeds the size guard",
        ));
    }
    if raw.contains(&0) {
        return Err(MemoryDecodeError::new(
            MemoryDecodeErrorKind::NulBytes,
            "raw input contains a NUL byte",
        ));
    }
    let text = std::str::from_utf8(raw).map_err(|_| {
        MemoryDecodeError::new(MemoryDecodeErrorKind::InvalidUtf8, "not valid UTF-8")
    })?;
    check_raw_duplicate_keys_with_max_depth(text, MAX_MEMORY_DTO_JSON_DEPTH).map_err(|_| {
        MemoryDecodeError::new(
            MemoryDecodeErrorKind::DuplicateKey,
            "duplicate key, malformed JSON, or nesting over the depth bound",
        )
    })?;
    let value: Value = serde_json::from_str(text).map_err(|e| {
        MemoryDecodeError::new(MemoryDecodeErrorKind::MalformedJson, e.to_string())
    })?;
    if let Some(path) = find_nul_string(&value) {
        return Err(MemoryDecodeError::new(
            MemoryDecodeErrorKind::NulString,
            format!("string at `{path}` contains NUL"),
        ));
    }
    if let Some(path) = find_non_finite_number(&value) {
        return Err(MemoryDecodeError::new(
            MemoryDecodeErrorKind::NonFiniteNumber,
            format!("number at `{path}` is not finite"),
        ));
    }
    let schema = dto_schema_value::<T>();
    check_shape(&value, &schema, "").map_err(|message| {
        MemoryDecodeError::new(MemoryDecodeErrorKind::Shape, message)
    })?;
    serde_json::from_value(value).map_err(|e| {
        MemoryDecodeError::new(MemoryDecodeErrorKind::Shape, e.to_string())
    })
}

fn find_nul_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if s.contains('\0') => Some(String::new()),
        Value::Array(items) => items.iter().enumerate().find_map(|(i, v)| {
            find_nul_string(v).map(|p| format!("[{i}]{p}"))
        }),
        Value::Object(map) => map.iter().find_map(|(k, v)| {
            find_nul_string(v).map(|p| format!(".{k}{p}"))
        }),
        _ => None,
    }
}

fn find_non_finite_number(value: &Value) -> Option<String> {
    match value {
        Value::Number(n) => n
            .as_f64()
            .and_then(|f| (!f.is_finite()).then(|| "".to_owned())),
        Value::Array(items) => items.iter().enumerate().find_map(|(i, v)| {
            find_non_finite_number(v).map(|p| format!("[{i}]{p}"))
        }),
        Value::Object(map) => map.iter().find_map(|(k, v)| {
            find_non_finite_number(v).map(|p| format!(".{k}{p}"))
        }),
        _ => None,
    }
}

fn json_type_is(value: &Value, name: &str) -> bool {
    match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "integer" => value.as_u64().is_some() || value.as_i64().is_some(),
        "number" => value.is_number(),
        _ => false,
    }
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn schema_matches(value: &Value, schema: &Value) -> bool {
    if let Some(Value::String(constant)) = schema.get("const") {
        return value == constant;
    }
    if let Some(types) = schema.get("type") {
        let allowed: Vec<&str> = match types {
            Value::String(t) => vec![t.as_str()],
            Value::Array(ts) => ts.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !allowed.is_empty() && !allowed.iter().any(|t| json_type_is(value, t)) {
            return false;
        }
    }
    if let Some(Value::Array(members)) = schema.get("enum") {
        if !members.contains(value) {
            return false;
        }
    }
    if let Some(Value::Array(branches)) = schema.get("oneOf") {
        return branches.iter().filter(|b| schema_matches(value, b)).count() == 1;
    }
    if let Some(Value::Array(branches)) = schema.get("anyOf") {
        return branches.iter().any(|b| schema_matches(value, b));
    }
    match value {
        Value::Object(map) => {
            if let Some(Value::Object(props)) = schema.get("properties") {
                for (key, child) in map {
                    match props.get(key) {
                        Some(child_schema) => {
                            if !schema_matches(child, child_schema) {
                                return false;
                            }
                        }
                        None if schema.get("additionalProperties") == Some(&Value::Bool(false)) => {
                            return false;
                        }
                        None => {}
                    }
                }
            }
            if let Some(Value::Array(required)) = schema.get("required") {
                for key in required.iter().filter_map(Value::as_str) {
                    if !map.contains_key(key) {
                        return false;
                    }
                }
            }
            true
        }
        Value::Array(items) => {
            if let Some(item_schema) = schema.get("items") {
                items.iter().all(|it| schema_matches(it, item_schema))
            } else {
                true
            }
        }
        _ => true,
    }
}

/// Recursively checks `value` against the normalized DTO schema before Serde
/// runs, so omitted `Option` keys, unknown fields, unknown tags, invalid null,
/// and wrong types fail with a readable path.
fn check_shape(value: &Value, schema: &Value, path: &str) -> Result<(), String> {
    if let Some(Value::String(constant)) = schema.get("const") {
        if value != constant {
            return Err(format!("at `{path}`: expected constant {constant}"));
        }
        return Ok(());
    }
    if let Some(types) = schema.get("type") {
        let allowed: Vec<&str> = match types {
            Value::String(t) => vec![t.as_str()],
            Value::Array(ts) => ts.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !allowed.is_empty() && !allowed.iter().any(|t| json_type_is(value, t)) {
            return Err(format!(
                "at `{path}`: expected {}, found {}",
                allowed.join(" or "),
                json_kind(value)
            ));
        }
    }
    if let Some(Value::Array(members)) = schema.get("enum") {
        if !members.contains(value) {
            return Err(format!("at `{path}`: not an allowed enum member"));
        }
    }
    if let Some(Value::Array(branches)) = schema.get("oneOf") {
        let matched = branches.iter().filter(|b| schema_matches(value, b)).count();
        if matched != 1 {
            return Err(format!(
                "at `{path}`: expected exactly one oneOf branch, matched {matched}"
            ));
        }
        return Ok(());
    }
    if let Some(Value::Array(branches)) = schema.get("anyOf") {
        if !branches.iter().any(|b| schema_matches(value, b)) {
            return Err(format!("at `{path}`: no anyOf branch matched"));
        }
        return Ok(());
    }
    match value {
        Value::Object(map) => {
            let props = schema.get("properties").and_then(Value::as_object);
            if let Some(Value::Array(required)) = schema.get("required") {
                for key in required.iter().filter_map(Value::as_str) {
                    if !map.contains_key(key) {
                        return Err(format!(
                            "at `{path}`: required key `{key}` is missing (use null where allowed)"
                        ));
                    }
                }
            }
            let closed = schema.get("additionalProperties") == Some(&Value::Bool(false));
            for (key, child) in map {
                match props.and_then(|p| p.get(key)) {
                    Some(child_schema) => {
                        let child_path = if path.is_empty() {
                            key.clone()
                        } else {
                            format!("{path}.{key}")
                        };
                        check_shape(child, child_schema, &child_path)?;
                    }
                    None if closed => {
                        return Err(format!("at `{path}`: unknown field `{key}`"));
                    }
                    None => {}
                }
            }
        }
        Value::Array(items) => {
            if let Some(item_schema) = schema.get("items") {
                for (i, item) in items.iter().enumerate() {
                    check_shape(item, item_schema, &format!("{path}[{i}]"))?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

// ================================================================ validation

/// A bound-check failure with a stable path and message. Bounds are checked
/// only; nothing is truncated, reordered, or selected here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryDtoValidationError {
    pub path: String,
    pub message: String,
}

impl MemoryDtoValidationError {
    pub fn code(&self) -> &'static str {
        "MEMORY_INVALID_INPUT"
    }
}

impl std::fmt::Display for MemoryDtoValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "memory DTO bound violation at `{}`: {}", self.path, self.message)
    }
}

impl std::error::Error for MemoryDtoValidationError {}

pub type MemoryDtoResult<T> = Result<T, MemoryDtoValidationError>;

fn invalid(path: &str, message: impl Into<String>) -> MemoryDtoValidationError {
    MemoryDtoValidationError { path: path.to_owned(), message: message.into() }
}

/// `manifest.id` must match `[a-z0-9][a-z0-9._:-]{0,63}` (§6).
fn valid_manifest_id(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > MEMORY_PLUGIN_ID_MAX_CHARS {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes.iter().skip(1).all(|&b| {
        b.is_ascii_lowercase()
            || b.is_ascii_digit()
            || b == b'.'
            || b == b'_'
            || b == b':'
            || b == b'-'
    })
}

/// `api_version` must equal `MEMORY_API_VERSION` (§6).
pub fn api_version_matches(v: u32) -> bool {
    v == MEMORY_API_VERSION
}

/// `dto_schema_version` must equal `MEMORY_DTO_SCHEMA_VERSION` (§6).
pub fn dto_schema_version_matches(v: u32) -> bool {
    v == MEMORY_DTO_SCHEMA_VERSION
}

/// Host rejects log field names containing these substrings, case-insensitively (§8.1).
const FORBIDDEN_LOG_FIELD_SUBSTRINGS: [&str; 6] = [
    "token",
    "secret",
    "credential",
    "authorization",
    "cookie",
    "password",
];

fn log_field_name_forbidden(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    FORBIDDEN_LOG_FIELD_SUBSTRINGS.iter().any(|f| lower.contains(f))
}

fn canonical_size_bytes<T: Serialize>(value: &T) -> MemoryDtoResult<usize> {
    to_canonical_json_bytes(value)
        .map(|b| b.len())
        .map_err(|e| invalid("", format!("cannot canonicalize: {e}")))
}

impl MemoryPluginManifest {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if !valid_manifest_id(&self.id) {
            return Err(invalid("id", "must match ^[a-z0-9][a-z0-9._:-]{0,63}$"));
        }
        if !api_version_matches(self.api_version) {
            return Err(invalid("api_version", "must equal MEMORY_API_VERSION"));
        }
        if !dto_schema_version_matches(self.dto_schema_version) {
            return Err(invalid("dto_schema_version", "must equal 1"));
        }
        Ok(())
    }
}

impl MemoryOpenRequest {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if !api_version_matches(self.api_version) {
            return Err(invalid("api_version", "must equal MEMORY_API_VERSION"));
        }
        if !dto_schema_version_matches(self.dto_schema_version) {
            return Err(invalid("dto_schema_version", "must equal 1"));
        }
        Ok(())
    }
}

impl MemorySessionContext {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if self.invocation_id.is_empty() || self.invocation_id.len() > MEMORY_INVOCATION_ID_MAX_BYTES {
            return Err(invalid("invocation_id", "must be 1 to 128 bytes"));
        }
        if self.cwd_label.chars().count() > MEMORY_CWD_LABEL_MAX_SCALARS {
            return Err(invalid("cwd_label", "must be at most 128 Unicode scalar values"));
        }
        Ok(())
    }
}

impl MemoryDigest {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if self.content.len() > MEMORY_DIGEST_MAX_CONTENT_BYTES {
            return Err(invalid("content", "must be at most 64 KiB"));
        }
        Ok(())
    }
}

impl RecallQuery {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if self.query.is_empty() || self.query.len() > MEMORY_RECALL_QUERY_MAX_BYTES {
            return Err(invalid("query", "must be 1 to 2000 bytes"));
        }
        if !(MEMORY_RECALL_LIMIT_MIN..=MEMORY_RECALL_LIMIT_MAX).contains(&self.limit) {
            return Err(invalid("limit", "must be 1 to 50"));
        }
        let unique: HashSet<MemoryKind> = self.kinds.iter().copied().collect();
        if unique.len() > MEMORY_RECALL_KINDS_MAX_UNIQUE {
            return Err(invalid("kinds", "must contain at most six unique kinds"));
        }
        Ok(())
    }
}

impl RecalledMemory {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        for (field, score) in [
            ("validity", &self.validity),
            ("usefulness", &self.usefulness),
            ("match_score", &self.match_score),
            ("rank_score", &self.rank_score),
        ] {
            if !(0.0..=1.0).contains(score) {
                return Err(invalid(field, "must be within [0.0, 1.0]"));
            }
        }
        Ok(())
    }
}

impl RememberToolInput {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if self.content.is_empty() || self.content.len() > MEMORY_REMEMBER_CONTENT_MAX_BYTES {
            return Err(invalid("content", "must be 1 to 2000 bytes"));
        }
        Ok(())
    }
}

impl RememberInput {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if self.content.is_empty() || self.content.len() > MEMORY_REMEMBER_CONTENT_MAX_BYTES {
            return Err(invalid("content", "must be 1 to 2000 bytes"));
        }
        Ok(())
    }
}

impl MemoryFeedback {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        let recalled: HashSet<&str> = self.recalled_ids.iter().map(String::as_str).collect();
        for used in &self.used_ids {
            if !recalled.contains(used.as_str()) {
                return Err(invalid("used_ids", "must be a subset of recalled_ids"));
            }
        }
        Ok(())
    }
}

impl MemorySessionEnd {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        for (i, item) in self.transcript.iter().enumerate() {
            if item.sequence > self.through_sequence {
                return Err(invalid(
                    &format!("transcript[{i}].sequence"),
                    "must be at most through_sequence",
                ));
            }
        }
        if self.final_state_graph.at_event_sequence > self.through_sequence {
            return Err(invalid(
                "final_state_graph.at_event_sequence",
                "must be at most through_sequence",
            ));
        }
        if self.artifact_summaries.len() > MEMORY_ARTIFACT_SUMMARIES_MAX {
            return Err(invalid("artifact_summaries", "must contain at most 100 summaries"));
        }
        Ok(())
    }
}

impl MemoryPluginError {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if self.message.len() > MEMORY_ERROR_MESSAGE_MAX_BYTES {
            return Err(invalid("message", "must be at most 1000 bytes"));
        }
        Ok(())
    }
}

impl MemoryHostError {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if self.message.len() > MEMORY_ERROR_MESSAGE_MAX_BYTES {
            return Err(invalid("message", "must be at most 1000 bytes"));
        }
        Ok(())
    }
}

impl MemoryPluginLogRecord {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if self.message.len() > MEMORY_LOG_MESSAGE_MAX_BYTES {
            return Err(invalid("message", "must be at most 4 KiB"));
        }
        for key in self.fields.keys() {
            if log_field_name_forbidden(key) {
                return Err(invalid(
                    &format!("fields.{key}"),
                    "field name contains a forbidden word",
                ));
            }
        }
        Ok(())
    }
}

fn check_response_schema(schema: &Value) -> MemoryDtoResult<()> {
    if !schema.is_object() {
        return Err(invalid("response_schema", "must be a JSON object"));
    }
    let bytes = to_canonical_json_bytes(schema)
        .map_err(|e| invalid("response_schema", format!("cannot canonicalize: {e}")))?;
    if bytes.len() > MEMORY_COMPLETION_RESPONSE_SCHEMA_MAX_BYTES {
        return Err(invalid("response_schema", "must be at most 65536 RFC 8785 bytes"));
    }
    check_schema_depth_and_refs(schema, 0)
}

fn check_schema_depth_and_refs(value: &Value, depth: usize) -> MemoryDtoResult<()> {
    if depth > MEMORY_COMPLETION_RESPONSE_SCHEMA_MAX_DEPTH {
        return Err(invalid("response_schema", "must be at most 16 levels deep"));
    }
    match value {
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get("$ref") {
                if !reference.starts_with('#') {
                    return Err(invalid("response_schema", "remote $ref references are not allowed"));
                }
            }
            for child in map.values() {
                check_schema_depth_and_refs(child, depth + 1)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                check_schema_depth_and_refs(item, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

impl MemoryCompletionRequest {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if self.system.len() + self.prompt.len() > MEMORY_COMPLETION_SYSTEM_PROMPT_MAX_BYTES {
            return Err(invalid("system", "system plus prompt must be at most 262144 UTF-8 bytes"));
        }
        if self.max_output_tokens == 0 || self.max_output_tokens > MEMORY_COMPLETION_MAX_OUTPUT_TOKENS {
            return Err(invalid("max_output_tokens", "must be 1 to 4096"));
        }
        if self.temperature_milli > MEMORY_COMPLETION_TEMPERATURE_MILLI_MAX {
            return Err(invalid("temperature_milli", "must be 0 to 1000"));
        }
        if self.timeout_ms == 0 || self.timeout_ms > MEMORY_COMPLETION_TIMEOUT_MS_MAX {
            return Err(invalid("timeout_ms", "must be 1 to 30000"));
        }
        if let Some(schema) = &self.response_schema {
            check_response_schema(schema)?;
        }
        Ok(())
    }
}

impl MemoryCompletionResponse {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        if self.text.len() > MEMORY_COMPLETION_RESPONSE_TEXT_MAX_BYTES {
            return Err(invalid("text", "must be at most 65536 UTF-8 bytes"));
        }
        if self.model_label.len() > MAX_MODEL_LABEL_BYTES {
            return Err(invalid("model_label", "must be at most 256 bytes"));
        }
        Ok(())
    }
}

impl StateObjectDto {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        let size = canonical_size_bytes(self)?;
        if size > MEMORY_STATE_OBJECT_MAX_CANONICAL_BYTES {
            return Err(invalid("", "each state object must be at most 4 KiB when serialized"));
        }
        Ok(())
    }
}

impl StateGraphSnapshotDto {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        let size = canonical_size_bytes(self)?;
        if size > MEMORY_STATE_SNAPSHOT_MAX_CANONICAL_BYTES {
            return Err(invalid("", "a state graph snapshot must be at most 256 KiB when serialized"));
        }
        Ok(())
    }
}

impl RedactedArtifactSummaryDto {
    pub fn validate(&self) -> MemoryDtoResult<()> {
        let size = canonical_size_bytes(self)?;
        if size > MEMORY_ARTIFACT_SUMMARY_MAX_CANONICAL_BYTES {
            return Err(invalid("", "each artifact summary must be at most 2 KiB when serialized"));
        }
        Ok(())
    }
}
