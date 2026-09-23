//! Transcript and content DTOs.
//!
//! `Memory` is the only memory transcript role and its wire value is
//! `memory`. `Recall` does not exist. Memory entries are UI history only and
//! never become canonical conversation messages.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::protocol::id::{
    ArtifactId, AttemptId, EventId, MessageId, SessionId, StepId, ToolExecutionId, TurnId,
};
use crate::ui_contract::ids::{
    AssistantBlockId, TranscriptCursor, TranscriptEntryId, TranscriptGroupId,
};
use crate::ui_contract::json_data::{JsonData, Sha256Digest, ToolCallId, ToolName};
use crate::ui_contract::result::{SystemNoticeDto, TurnFooterDto};

pub const MAX_PREVIEW_BYTES_PER_ENTRY: usize = 32 * 1024;
pub const MAX_PREVIEW_BYTES_PER_PAGE: usize = 256 * 1024;
pub const MAX_CONTENT_READ_BYTES: u32 = 262_144;
pub const MAX_CONTENT_LINES: u64 = 10_000;
pub const MAX_GREP_PATTERN_BYTES: usize = 4_096;
pub const MAX_GREP_MATCHES: u16 = 1_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptDirection {
    Before,
    After,
    Tail,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ContentRefDto {
    Artifact {
        artifact_id: ArtifactId,
        sha256: Sha256Digest,
    },
    AssistantText {
        message_id: MessageId,
        sha256: Sha256Digest,
    },
    ToolResult {
        execution_id: ToolExecutionId,
        sha256: Sha256Digest,
    },
    VisibleThinkingSummary {
        step_id: StepId,
        block_id: AssistantBlockId,
        sha256: Sha256Digest,
    },
    TranscriptEntry {
        entry_id: TranscriptEntryId,
        sha256: Sha256Digest,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ContentSelectionDto {
    Bytes {
        offset: u64,
        max_bytes: u32,
    },
    Lines {
        start: u64,
        end: u64,
    },
    Grep {
        pattern: String,
        cursor: Option<crate::ui_contract::ids::ContentCursor>,
        max_matches: u16,
    },
}

impl ContentSelectionDto {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ContentSelectionDto::Bytes { max_bytes, .. } => {
                if *max_bytes == 0 || *max_bytes > MAX_CONTENT_READ_BYTES {
                    return Err(format!("byte read {max_bytes} out of range"));
                }
                Ok(())
            }
            ContentSelectionDto::Lines { start, end } => {
                if *start == 0 || *end < *start {
                    return Err("line range must be inclusive and one-based".to_string());
                }
                if *end - *start + 1 > MAX_CONTENT_LINES {
                    return Err("line range exceeds 10,000 lines".to_string());
                }
                Ok(())
            }
            ContentSelectionDto::Grep {
                pattern,
                max_matches,
                ..
            } => {
                if pattern.len() > MAX_GREP_PATTERN_BYTES {
                    return Err("grep pattern exceeds 4,096 bytes".to_string());
                }
                if *max_matches == 0 || *max_matches > MAX_GREP_MATCHES {
                    return Err("grep max_matches exceeds 1,000".to_string());
                }
                Ok(())
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRoleDto {
    User,
    Assistant,
    ThinkingSummary,
    Tool,
    Memory,
    System,
    TurnFooter,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TextContentDto {
    pub preview: String,
    pub complete: bool,
    pub sha256: Sha256Digest,
    pub detail_ref: Option<ContentRefDto>,
}

impl TextContentDto {
    pub fn validate(&self) -> Result<(), String> {
        if self.preview.len() > MAX_PREVIEW_BYTES_PER_ENTRY {
            return Err("preview exceeds 32 KiB".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolDisplayStatus {
    Pending,
    Running,
    Success,
    Error,
    Blocked,
    Cancelled,
    Uncertain,
    Skipped,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TranscriptToolDto {
    pub call_id: ToolCallId,
    pub execution_id: Option<ToolExecutionId>,
    pub tool_name: ToolName,
    pub label: String,
    pub status: ToolDisplayStatus,
    pub summary: String,
    pub duration_ms: Option<u64>,
    pub redacted_arguments: Option<JsonData>,
    pub detail_ref: Option<ContentRefDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemoryTranscriptDto {
    pub source_label: String,
    pub summary: String,
    pub detail_ref: Option<ContentRefDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum TranscriptContentDto {
    User(TextContentDto),
    Assistant(TextContentDto),
    ThinkingSummary(TextContentDto),
    Tool(TranscriptToolDto),
    Memory(MemoryTranscriptDto),
    System(SystemNoticeDto),
    TurnFooter(TurnFooterDto),
}

impl TranscriptContentDto {
    pub fn discriminant_role(&self) -> TranscriptRoleDto {
        match self {
            TranscriptContentDto::User(_) => TranscriptRoleDto::User,
            TranscriptContentDto::Assistant(_) => TranscriptRoleDto::Assistant,
            TranscriptContentDto::ThinkingSummary(_) => TranscriptRoleDto::ThinkingSummary,
            TranscriptContentDto::Tool(_) => TranscriptRoleDto::Tool,
            TranscriptContentDto::Memory(_) => TranscriptRoleDto::Memory,
            TranscriptContentDto::System(_) => TranscriptRoleDto::System,
            TranscriptContentDto::TurnFooter(_) => TranscriptRoleDto::TurnFooter,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TranscriptEntryDto {
    pub entry_id: TranscriptEntryId,
    pub role: TranscriptRoleDto,
    pub turn_id: Option<TurnId>,
    pub attempt_id: Option<AttemptId>,
    pub canonical_event_id: Option<EventId>,
    pub canonical_sequence: Option<u64>,
    pub content: TranscriptContentDto,
    pub expandable: bool,
    pub estimated_lines: u32,
    pub provisional: bool,
}

impl TranscriptEntryDto {
    /// Role must equal the content discriminant; mismatch is a
    /// projection-integrity error.
    pub fn validate(&self) -> Result<(), String> {
        if self.role != self.content.discriminant_role() {
            return Err("role/content discriminant mismatch".to_string());
        }
        match &self.content {
            TranscriptContentDto::User(t)
            | TranscriptContentDto::Assistant(t)
            | TranscriptContentDto::ThinkingSummary(t) => t.validate()?,
            TranscriptContentDto::Tool(tool) => {
                if let Some(args) = &tool.redacted_arguments {
                    args.validate()?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TranscriptGroupDto {
    pub group_id: TranscriptGroupId,
    pub turn_id: Option<TurnId>,
    pub committed: bool,
    pub entries: Vec<TranscriptEntryDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TranscriptPageDto {
    pub transcript_projection_schema_version: u32,
    pub canonical_through_sequence: u64,
    pub groups: Vec<TranscriptGroupDto>,
    pub before_cursor: Option<TranscriptCursor>,
    pub after_cursor: Option<TranscriptCursor>,
    pub has_before: bool,
    pub has_after: bool,
}

impl TranscriptPageDto {
    pub fn validate(&self) -> Result<(), String> {
        if self.transcript_projection_schema_version
            != crate::ui_contract::TRANSCRIPT_PROJECTION_SCHEMA_VERSION
        {
            return Err("unsupported transcript projection version".to_string());
        }
        let mut total_preview = 0usize;
        for group in &self.groups {
            for entry in &group.entries {
                entry.validate()?;
                total_preview += preview_bytes(&entry.content);
            }
        }
        if total_preview > MAX_PREVIEW_BYTES_PER_PAGE {
            return Err("page previews exceed 256 KiB".to_string());
        }
        Ok(())
    }
}

fn preview_bytes(content: &TranscriptContentDto) -> usize {
    match content {
        TranscriptContentDto::User(t)
        | TranscriptContentDto::Assistant(t)
        | TranscriptContentDto::ThinkingSummary(t) => t.preview.len(),
        _ => 0,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContentEncoding {
    Utf8,
    Base64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContentMatchDto {
    pub line: u64,
    pub byte_start: u64,
    pub byte_end: u64,
    pub excerpt: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContentPageDto {
    pub content_type: String,
    pub encoding: ContentEncoding,
    pub data: String,
    pub byte_start: u64,
    pub byte_end: u64,
    pub total_bytes: u64,
    pub line_start: Option<u64>,
    pub line_end: Option<u64>,
    pub total_lines: Option<u64>,
    pub matches: Vec<ContentMatchDto>,
    pub next_cursor: Option<crate::ui_contract::ids::ContentCursor>,
    pub eof: bool,
    pub sha256: Sha256Digest,
    pub redacted: bool,
}

/// Committed group IDs reuse the turn ID ULID bits.
pub fn committed_group_id(turn_id: &TurnId) -> TranscriptGroupId {
    TranscriptGroupId(turn_id.to_ulid())
}

/// Committed entry IDs reuse the source canonical event ID bits.
pub fn committed_entry_id(event_id: &EventId) -> TranscriptEntryId {
    TranscriptEntryId(event_id.to_ulid())
}

/// Provisional assistant entry IDs reuse the assistant block ID.
pub fn provisional_entry_id(block_id: &AssistantBlockId) -> TranscriptEntryId {
    TranscriptEntryId(block_id.to_ulid())
}

/// Synthetic boot, plugin-memory, or provisional-tool entry ID: the uppercase
/// Crockford ULID encoding of the first 16 SHA-256 bytes of
/// `praana-transcript-v1`, NUL, semantic kind, NUL, session ID, NUL, and the
/// stable source key.
pub fn derive_transcript_entry_id(
    session: &SessionId,
    semantic_kind: &str,
    source_key: &str,
) -> TranscriptEntryId {
    let mut h = Sha256::new();
    h.update(b"praana-transcript-v1");
    h.update([0]);
    h.update(semantic_kind.as_bytes());
    h.update([0]);
    h.update(session.to_string().as_bytes());
    h.update([0]);
    h.update(source_key.as_bytes());
    let digest = h.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    TranscriptEntryId(ulid::Ulid::from_bytes(bytes))
}

/// Memory entries may be constructed only when the effective memory plugin is
/// enabled, the session is not incognito, and the plugin explicitly returns
/// ambient display content.
pub fn memory_entry_allowed(
    plugin_enabled: bool,
    incognito: bool,
    plugin_returned_ambient_content: bool,
) -> bool {
    plugin_enabled && !incognito && plugin_returned_ambient_content
}

/// A cursor is bound to its issuing session; echoing it in another session is
/// `CursorInvalid`. Cursors are opaque and never treated as offsets.
pub fn check_cursor_session_binding(
    issued_session: &SessionId,
    echo_session: &SessionId,
    _cursor: &TranscriptCursor,
) -> Result<(), crate::ui_contract::UiContractError> {
    if issued_session != echo_session {
        return Err(crate::ui_contract::UiContractError::CursorInvalid);
    }
    Ok(())
}
