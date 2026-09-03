# PRAANA Rust v2 Core/UI Semantic Contract

**Status:** Normative implementation specification

**UI contract schema version:** 1

**Date:** 2026-08-31

## 1. Authority and boundaries

This document is the sole normative permanent semantic contract between the
Rust core and every UI. It owns `CoreCommand`, `CoreCommandResult`, `UiEvent`,
all DTOs reachable from those types, UI-crossing ID rules, operation
idempotency semantics, event priority, sensitivity, coalescing, and command and
event names. The contract is UI-framework-neutral and transport-neutral.

`RUST_V2_IPC_SPEC.md` owns only temporary JSONL envelopes, framing, connection
IDs, request correlation, acknowledgements, and conversion between this
contract and dotted IPC names. It MUST NOT define another semantic payload.
`RUST_V2_RATATUI_SPEC.md` owns only reducer state, effects, terminal input,
layout, and rendering. Ratatui consumes this contract directly and MUST NOT
import semantic DTOs from the IPC crate. Headless, temporary OpenTUI, Ratatui,
plain mode, and recording tests use the same contract.

Canonical conversation/event semantics remain owned by
`RUST_V2_PROTOCOL_SPEC.md`. Physical operation records, transcript queries,
content reads, and cursor storage remain owned by
`RUST_V2_HISTORY_STORAGE_SPEC.md`. This document owns their UI-facing forms.
Config keys are not settings fields; `RUST_V2_CONFIG_SPEC.md` remains the sole
configuration authority. Tool Runtime converts finalized redacted tool state
to the semantic tool events below and never emits wire names.

The TypeScript implementation is neither an authority nor a second event
model. It is only a temporary client and a source of non-normative black-box
comparison fixtures for behavior explicitly retained by the architecture plan.

## 2. Shared Rust conventions

The types below live in `praana-core::ui_contract`. Public structs use
`#[serde(deny_unknown_fields)]`. Public enums use the shown tagged form and
`snake_case` names. Every `Option<T>` is present as JSON `null` in IPC v1. Empty
vectors and maps are present. IPC conversion serializes the variant payload,
not the outer Rust enum tag. No UI-contract field uses `serde_json::Value`.

The implementation uses workspace `serde` with derive, `serde_json` with the
`raw_value` feature only in the IPC crate, `ulid` with serde, `sha2`, `zeroize`,
`async-trait`, Tokio sync/time, and the existing History `rusqlite`. It adds no
UI framework, network, or terminal dependency to `praana-core`.

```rust
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const UI_CONTRACT_SCHEMA_VERSION: u32 = 1;
pub const TRANSCRIPT_PROJECTION_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum JsonData {
    Null,
    Bool(bool),
    Integer(i64),
    Unsigned(u64),
    String(String),
    Array(Vec<JsonData>),
    Object(BTreeMap<String, JsonData>),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct Sha256Digest(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct ProviderId(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct ModelId(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct ToolName(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct ToolCallId(pub String);
```

`JsonData::Integer` and `Unsigned` are limited to JSON's interoperable integer
range. Strings reject NUL. `Sha256Digest` is exactly 64 lowercase hexadecimal
characters. Provider/model strings are 1 through 256 UTF-8 bytes. `ToolName`
uses the Tool Runtime grammar. `ToolCallId` is the provider-owned opaque
exception and is 1 through 256 UTF-8 bytes with no ASCII control character.

## 3. IDs and selectors

The protocol-owned `SessionId`, `EventId`, `TurnId`, `AttemptId`, `StepId`,
`MessageId`, `ToolBatchId`, `ToolExecutionId`, and `ArtifactId` are reused
directly. The UI contract adds these newtypes:

```rust
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct OperationId(pub ulid::Ulid);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct TranscriptGroupId(pub ulid::Ulid);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct TranscriptEntryId(pub ulid::Ulid);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct AssistantBlockId(pub ulid::Ulid);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct ConfirmationId(pub ulid::Ulid);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct ConsentId(pub ulid::Ulid);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct AuthFlowId(pub ulid::Ulid);

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct NoticeId(pub ulid::Ulid);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct ResumeSelector(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct TranscriptCursor(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct ModelCatalogCursor(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct SlashCatalogCursor(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct PathCompletionCursor(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct ContentCursor(pub String);
```

Every canonical or semantic entity ID crossing the UI boundary serializes as a
raw uppercase 26-character Crockford ULID. This includes `OperationId`; `op_`
is forbidden. Lowercase, ambiguous `I`, `L`, `O`, or `U`, wrong length, and
undecodable values are rejected.

Prefixes are reserved for temporary transport-local request, connection,
stream, block, and cursor tokens. They are never accepted in canonical ID
fields. IPC may encode its own `req_`, `conn_`, `stream_`, `block_`, or
`cursor_` tokens in transport envelopes. Those tokens do not become semantic
IDs and are not persisted in canonical history. Semantic events identify a
provisional stream by `AttemptId` and an assistant block by raw
`AssistantBlockId`.

`ResumeSelector` is exactly 12 uppercase Crockford characters and is derived as
the first 12 characters of the canonical `SessionId` string. It is a selector,
not an ID, and never appears in a canonical-ID field. Lookup enumerates valid
session manifests under the selected session root, compares the first 12
characters case-sensitively, and returns:

- zero matches: `CoreErrorCode::SessionNotFound`;
- one match: that canonical `SessionId`;
- two or more matches: `CoreErrorCode::ResumeSelectorAmbiguous` with the sorted
  complete matching session IDs; the core never chooses the newest match.

`SessionLocator::Id` bypasses selector lookup. A UI must retain and prefer the
canonical ID after open; the selector is for human entry and epilogues only.

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum SessionLocator {
    Id(SessionId),
    ResumeSelector(ResumeSelector),
}
```

All cursor newtypes are opaque server-issued ASCII strings of 1 through 512
bytes. A cursor is bound to command kind, session when applicable, query/filter
hash, projection or catalog revision, and position. It may only be echoed to
the command that issued it. A mismatched, expired, malformed, cross-session, or
post-reset cursor returns `CoreErrorCode::CursorInvalid`; it is never treated as
an offset. Catalog cursors expire after ten minutes or a catalog revision.
Transcript cursors remain valid until session clear, projection-version change,
or session deletion. Content cursors are bound to an immutable content hash.

## 4. Commands and results

### 4.1 Command enum

```rust
#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum CoreCommand {
    SessionCreate(SessionCreateCommand),
    SessionResume(SessionResumeCommand),
    SessionEnd(SessionEndCommand),
    SessionSnapshot(SessionSnapshotCommand),
    SessionClear(SessionClearCommand),
    SessionNew(SessionNewCommand),
    TurnSubmit(TurnSubmitCommand),
    TurnCancel(TurnCancelCommand),
    RiskResolve(RiskResolveCommand),
    SlashCatalog(SlashCatalogCommand),
    SlashExecute(SlashExecuteCommand),
    PathComplete(PathCompleteCommand),
    ModelCatalog(ModelCatalogCommand),
    ModelSelect(ModelSelectCommand),
    ReasoningSet(ReasoningSetCommand),
    SettingsPatch(SettingsPatchCommand),
    TranscriptPage(TranscriptPageCommand),
    ContentRead(ContentReadCommand),
    SetupStatus(SetupStatusCommand),
    SetupApply(SetupApplyCommand),
    AuthLogin(AuthLoginCommand),
    AuthLogout(AuthLogoutCommand),
    ConsentResolve(ConsentResolveCommand),
    RuntimePing(RuntimePingCommand),
    Shutdown(ShutdownCommand),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", content = "data", rename_all = "snake_case")]
pub enum CoreCommandResult {
    Ok(CoreCommandSuccess),
    Err(CoreErrorDto),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum CoreCommandSuccess {
    SessionOpened(SessionOpenResultDto),
    SessionEnded(SessionEpilogueDto),
    SessionSnapshot(SessionSnapshotDto),
    SessionCleared(SessionClearedResultDto),
    TurnSubmitted(TurnSubmittedDto),
    TurnCancellation(CancellationResultDto),
    RiskResolved(RiskResolvedResultDto),
    SlashCatalog(SlashCatalogPageDto),
    SlashExecuted(SlashResultDto),
    PathCompletion(PathCompletionPageDto),
    ModelCatalog(ModelCatalogPageDto),
    ModelSelected(ActiveModelDto),
    ReasoningSet(ReasoningStateDto),
    SettingsPatched(EffectiveSettingsDto),
    TranscriptPage(TranscriptPageDto),
    ContentRead(ContentPageDto),
    SetupStatus(SetupStatusDto),
    SetupApplied(SetupApplyResultDto),
    AuthLogin(AuthLoginResultDto),
    AuthLogout(AuthLogoutResultDto),
    ConsentResolved(ConsentResolvedResultDto),
    RuntimePong(RuntimePongDto),
    ShutdownAdmitted(ShutdownAdmittedDto),
}
```

The success variant must match the command according to section 12. A mismatch
is an internal contract violation, not a result the UI accepts.

### 4.2 Session, turn, and shutdown commands

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionCreateCommand {
    pub operation_id: OperationId,
    pub cwd: String,
    pub config_path: Option<String>,
    pub incognito: bool,
    pub debug: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionResumeCommand {
    pub operation_id: OperationId,
    pub locator: SessionLocator,
    pub cwd: String,
    pub after_canonical_sequence: Option<u64>,
    pub debug: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionEndReason { Clean, Aborted, Error }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionEndCommand {
    pub operation_id: OperationId,
    pub reason: SessionEndReason,
    pub memory_grace_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionSnapshotCommand {
    pub include_boot: bool,
    pub include_pending_confirmations: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionClearCommand { pub operation_id: OperationId }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionNewCommand {
    pub operation_id: OperationId,
    pub cwd: String,
    pub config_path: Option<String>,
    pub incognito: bool,
    pub debug: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnSubmitCommand {
    pub operation_id: OperationId,
    pub text: String,
    pub client_submitted_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnCancelReason { UserInterrupt, UiShutdown, SessionEnd }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnCancelCommand {
    pub operation_id: OperationId,
    pub turn_id: TurnId,
    pub reason: TurnCancelReason,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimePingCommand {}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShutdownReason { UiExit, Signal, ParentExit, FatalError }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShutdownCommand {
    pub operation_id: OperationId,
    pub reason: ShutdownReason,
    pub grace_ms: Option<u64>,
}
```

`cwd` and `config_path` follow Config-spec normalization. Turn text is 1 through
262,144 UTF-8 bytes after CRLF/CR to LF normalization. NUL is rejected and no
trim is performed.

### 4.3 Risk, slash, and completion commands

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiskDecision { AllowOnce, Deny }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RiskResolveCommand {
    pub operation_id: OperationId,
    pub confirmation_id: ConfirmationId,
    pub decision: RiskDecision,
    pub argument_sha256: Sha256Digest,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SlashCatalogCommand {
    pub query: String,
    pub cursor: Option<SlashCatalogCursor>,
    pub limit: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SlashExecuteCommand {
    pub operation_id: OperationId,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PathCompleteCommand {
    pub token: String,
    pub cursor: Option<PathCompletionCursor>,
    pub limit: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlashArgumentKind { None, Optional, Required }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlashHandoff {
    None, ModelSelector, Login, Logout, Setup, Settings, Sessions,
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
pub enum SlashDisplay { Toast, Transcript, Overlay, None }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlashAction {
    None, Exit, ClearTranscript, NewSession, RefreshStatus,
    OpenModelSelector, OpenLogin, OpenLogout, OpenSetup, OpenSettings,
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
pub enum PathEntryKind { File, Directory, Symlink, Other }

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
```

Slash and path limits are 1 through 200 and 1 through 100 respectively. The
core supplies canonical slash ordering and metadata. The UI may fuzzy-filter a
returned page but does not invent commands, descriptions, aliases, or effects.
Path completion is display assistance only and grants no filesystem authority.

### 4.4 Models, reasoning, and settings

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol { OpenAiChatCompletions, OpenAiResponses }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort { Off, Minimal, Low, Medium, High, Xhigh }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelCatalogSource { Static, Live, Cache, Local }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelAvailability { Available, AuthenticationRequired, Unavailable }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ModelCatalogCommand {
    pub provider: Option<ProviderId>,
    pub query: String,
    pub cursor: Option<ModelCatalogCursor>,
    pub limit: u16,
    pub refresh: bool,
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
pub struct ModelSelectCommand {
    pub operation_id: OperationId,
    pub provider: ProviderId,
    pub model_id: ModelId,
    pub reasoning_effort: ReasoningEffort,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReasoningSetCommand {
    pub operation_id: OperationId,
    pub level: ReasoningEffort,
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThemeId { Default, HighContrast, Mono }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolIconMode { Unicode, Ascii }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SettingsPatchDto {
    pub thinking_visible: Option<bool>,
    pub debug: Option<bool>,
    pub theme: Option<ThemeId>,
    pub tool_icons: Option<ToolIconMode>,
    pub mouse_enabled: Option<bool>,
    pub animation_enabled: Option<bool>,
    pub syntax_highlighting: Option<bool>,
    pub syntax_theme: Option<String>,
    pub incognito_default: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SettingsPatchCommand {
    pub operation_id: OperationId,
    pub expected_revision: u64,
    pub changes: SettingsPatchDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EffectiveSettingsDto {
    pub revision: u64,
    pub thinking_visible: bool,
    pub debug: bool,
    pub theme: ThemeId,
    pub tool_icons: ToolIconMode,
    pub mouse_enabled: bool,
    pub animation_enabled: bool,
    pub syntax_highlighting: bool,
    pub syntax_theme: String,
    pub incognito_default: bool,
}
```

`settings.patch` is mandatory baseline IPC v1 functionality and is never
capability-negotiated. A patch must set at least one field. Revision mismatch is
`SettingsConflict` and returns the current revision in typed error details.
`syntax_theme` is 1 through 128 bytes and must name a built-in Syntect theme
reported by the running binary. These settings are persisted by the Rust
settings service. They are not Config-v1 keys and never mutate the active
session's config snapshot. `incognito_default` affects only subsequently
created sessions; an active session's incognito boundary cannot be disabled.
Focus, selection, scroll, draft, overlay, cache, viewport, and terminal-size
state are presentation-only and absent.

When no persisted settings row exists, the settings service creates revision 0
with `thinking_visible=true`, `debug=false`, `theme=default`,
`tool_icons=unicode`, `mouse_enabled=true`, `animation_enabled=true`,
`syntax_highlighting=true`, `syntax_theme="base16-ocean.dark"`, and
`incognito_default=false`. Environment/CLI terminal capability downgrades affect
rendering but do not rewrite this persisted DTO.

### 4.5 Transcript and content commands

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptDirection { Before, After, Tail }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TranscriptPageCommand {
    pub cursor: Option<TranscriptCursor>,
    pub direction: TranscriptDirection,
    pub limit_groups: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ContentRefDto {
    Artifact { artifact_id: ArtifactId, sha256: Sha256Digest },
    AssistantText { message_id: MessageId, sha256: Sha256Digest },
    ToolResult { execution_id: ToolExecutionId, sha256: Sha256Digest },
    VisibleThinkingSummary {
        step_id: StepId,
        block_id: AssistantBlockId,
        sha256: Sha256Digest,
    },
    TranscriptEntry { entry_id: TranscriptEntryId, sha256: Sha256Digest },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ContentSelectionDto {
    Bytes { offset: u64, max_bytes: u32 },
    Lines { start: u64, end: u64 },
    Grep { pattern: String, cursor: Option<ContentCursor>, max_matches: u16 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContentReadCommand {
    pub reference: ContentRefDto,
    pub selection: ContentSelectionDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptRoleDto {
    User, Assistant, ThinkingSummary, Tool, Memory, System, TurnFooter,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TextContentDto {
    pub preview: String,
    pub complete: bool,
    pub sha256: Sha256Digest,
    pub detail_ref: Option<ContentRefDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolDisplayStatus { Pending, Running, Success, Error, Blocked, Cancelled, Uncertain, Skipped }

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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContentEncoding { Utf8, Base64 }

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
    pub next_cursor: Option<ContentCursor>,
    pub eof: bool,
    pub sha256: Sha256Digest,
    pub redacted: bool,
}
```

`Tail` requires a null cursor. `Before` and `After` require a cursor. Group limit
is 1 through 50. Pages do not split committed turns. Preview text is at most 32
KiB per entry and all previews total at most 256 KiB per page. Heavy content is
referenced. Byte reads allow 1 through 262,144 bytes. Line ranges are inclusive,
one-based, and contain at most 10,000 lines. Grep pattern is at most 4,096 bytes,
returns at most 1,000 matches, and does not expose unredacted bytes.
For `Utf8`, `data` is the exact returned UTF-8 text. For `Base64`, `data` is
RFC 4648 standard-alphabet base64 with required `=` padding. Byte offsets always
address the immutable decoded source bytes, not base64 characters.

`Memory` is the only memory transcript role and its wire value is `memory`.
`Recall` does not exist. Core may construct `TranscriptContentDto::Memory` only
when the effective memory plugin is enabled, not incognito, and explicitly
returns ambient display content. With plugin `none`, startup failure, or
incognito, no memory entry is emitted. Memory entries are UI history only and
do not become canonical conversation messages.

`role` must equal the `TranscriptContentDto` discriminant. A mismatch is a
projection-integrity error. Committed group IDs reuse the `TurnId` ULID bits;
committed entry IDs reuse the source canonical `EventId` bits. Provisional
assistant entry IDs reuse `AssistantBlockId`. Any synthetic boot, plugin-memory,
or provisional tool entry ID is the uppercase Crockford ULID encoding of the
first 16 SHA-256 bytes of `praana-transcript-v1`, NUL, semantic kind, NUL,
session ID, NUL, and its stable source key. The source key is respectively
`boot`, the plugin-owned stable memory record ID, or
`attempt_id + NUL + tool_call_id`. A derived collision with a different tuple is
`CoreErrorCode::Internal` and blocks the page/event; no random replacement is
generated. This makes paging/reconnect de-duplication independent of UI state.

### 4.6 Setup, authentication, and consent

```rust
#[derive(Serialize, Deserialize)]
#[serde(transparent)]
pub struct SensitiveStringDto(zeroize::Zeroizing<String>);

impl std::fmt::Debug for SensitiveStringDto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct SetupFieldId(pub String);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SetupFieldKind { Text, Secret, Choice, Boolean }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupChoiceDto { pub value: String, pub label: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupFieldDto {
    pub id: SetupFieldId,
    pub label: String,
    pub help: String,
    pub kind: SetupFieldKind,
    pub required: bool,
    pub secret: bool,
    pub choices: Vec<SetupChoiceDto>,
    pub default_value: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupProviderDto {
    pub provider: ProviderId,
    pub display_name: String,
    pub fields: Vec<SetupFieldDto>,
    pub auth_methods: Vec<AuthMethodKindDto>,
    pub supported_protocols: Vec<ProviderProtocol>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethodKindDto { ApiKey, DeviceCode, Browser }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupStatusCommand {}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupStatusDto {
    pub revision: u64,
    pub required: bool,
    pub providers: Vec<SetupProviderDto>,
    pub configured_providers: Vec<ProviderId>,
    pub authentication: Vec<ProviderAuthStatusDto>,
    pub active_auth_flows: Vec<AuthFlowDto>,
    pub missing_requirements: Vec<String>,
    pub pending_consents: Vec<ConsentRequestDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderAuthStatusDto {
    pub provider: ProviderId,
    pub state: AuthState,
    pub methods: Vec<AuthMethodKindDto>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum SetupValueDto {
    Text(String),
    Secret(SensitiveStringDto),
    Choice(String),
    Boolean(bool),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetupApplyCommand {
    pub operation_id: OperationId,
    pub expected_revision: u64,
    pub provider: ProviderId,
    pub model_id: ModelId,
    pub values: BTreeMap<SetupFieldId, SetupValueDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetupApplyResultDto {
    pub revision: u64,
    pub configured_provider: ProviderId,
    pub active_model: ActiveModelDto,
    pub restart_required: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum AuthMethodDto {
    ApiKey { credential: SensitiveStringDto },
    DeviceCode,
    Browser,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthLoginCommand {
    pub operation_id: OperationId,
    pub provider: ProviderId,
    pub method: AuthMethodDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthLogoutCommand {
    pub operation_id: OperationId,
    pub provider: ProviderId,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthState { Unauthenticated, Pending, Authenticated, Failed, Expired }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthFlowDto {
    pub flow_id: AuthFlowId,
    pub provider: ProviderId,
    pub state: AuthState,
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthLoginResultDto {
    pub provider: ProviderId,
    pub state: AuthState,
    pub flow: Option<AuthFlowDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthLogoutResultDto {
    pub provider: ProviderId,
    pub state: AuthState,
    pub fallback_model: Option<ActiveModelDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConsentChoice { AllowOnce, AllowPersisted, Deny }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConsentRequestDto {
    pub consent_id: ConsentId,
    pub purpose: String,
    pub version: String,
    pub size_bytes: Option<u64>,
    pub location_label: Option<String>,
    pub choices: Vec<ConsentChoice>,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConsentResolveCommand {
    pub operation_id: OperationId,
    pub consent_id: ConsentId,
    pub purpose: String,
    pub version: String,
    pub decision: ConsentChoice,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConsentResolvedResultDto {
    pub consent_id: ConsentId,
    pub decision: ConsentChoice,
    pub persisted: bool,
}
```

`SensitiveStringDto` is input-only, has a redacted `Debug`, has no `Clone`, and
zeroizes on drop. IPC deserialization accepts it; serialization of a command
containing it is allowed only in the client-to-core encoder. Results, events,
operation records, diagnostics, errors, and fixtures never contain its value.
Setup field maps reject unknown, missing required, duplicate, or wrong-kind
values against the exact returned revision.

### 4.7 Result DTOs, boot, status, and snapshots

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComponentState { Available, Disabled, Unavailable, Degraded, Starting }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ComponentStatusDto {
    pub state: ComponentState,
    pub label: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BootStatusDto {
    pub native: ComponentStatusDto,
    pub search: ComponentStatusDto,
    pub lsp: ComponentStatusDto,
    pub memory: ComponentStatusDto,
    pub provider: ComponentStatusDto,
    pub history: ComponentStatusDto,
    pub skills: ComponentStatusDto,
    pub discovered_skill_count: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum StateStatusSummaryDto {
    Task(TaskStatus),
    Decision(DecisionStatus),
    Constraint(ConstraintStatus),
    Note,
    Error(ErrorStatus),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateObjectSummaryDto {
    pub state_id: StateId,
    pub kind: StateKind,
    pub tier: StateTier,
    pub status: StateStatusSummaryDto,
    pub label: String,
    pub focused: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateSnapshotDto {
    pub graph_sequence: u64,
    pub counts: StateCountsDto,
    pub objects: Vec<StateObjectSummaryDto>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateCountsDto {
    pub total: u64,
    pub tasks: u64,
    pub decisions: u64,
    pub constraints: u64,
    pub notes: u64,
    pub errors: u64,
    pub active: u64,
    pub soft: u64,
    pub hard: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionMetadataDto {
    pub session_id: SessionId,
    pub resume_selector: ResumeSelector,
    pub created_at_ms: i64,
    pub cwd_label: String,
    pub project_label: Option<String>,
    pub config_schema_version: u32,
    pub creation_config_digest_sha256: Sha256Digest,
    pub loaded_config_digest_sha256: Sha256Digest,
    pub runtime_config_digest_sha256: Sha256Digest,
    pub config_changed_since_create: bool,
    pub history_mode: HistoryMode,
    pub projection_version: ProjectionId,
    pub incognito: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SessionOpenResultDto {
    pub session_id: SessionId,
    pub resumed: bool,
    pub canonical_sequence: u64,
    pub metadata: SessionMetadataDto,
    pub active_model: ActiveModelDto,
    pub reasoning: ReasoningStateDto,
    pub settings: EffectiveSettingsDto,
    pub boot: BootStatusDto,
    pub transcript_tail_cursor: Option<TranscriptCursor>,
    pub recovery: Vec<SystemNoticeDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActiveTurnPhase { Admitted, Provider, Tools, Cancelling }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ActiveTurnSnapshotDto {
    pub turn_id: TurnId,
    pub attempt_id: Option<AttemptId>,
    pub phase: ActiveTurnPhase,
    pub cancellation_requested: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SessionSnapshotDto {
    pub metadata: SessionMetadataDto,
    pub canonical_sequence: u64,
    pub active_model: ActiveModelDto,
    pub reasoning: ReasoningStateDto,
    pub settings: EffectiveSettingsDto,
    pub boot: Option<BootStatusDto>,
    pub active_turn: Option<ActiveTurnSnapshotDto>,
    pub pending_confirmation: Option<RiskConfirmationDto>,
    pub transcript_before_cursor: Option<TranscriptCursor>,
    pub transcript_after_cursor: Option<TranscriptCursor>,
    pub context: ContextStatusDto,
    pub state: StateSnapshotDto,
    pub recovery: Vec<SystemNoticeDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionClearedResultDto {
    pub canonical_sequence: u64,
    pub reset_epoch: u64,
    pub transcript_tail_cursor: Option<TranscriptCursor>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnSubmittedDto {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub user_message_event_id: EventId,
    pub canonical_sequence: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CancellationState { Requested, AlreadyRequested, AlreadyFinished, NotFound }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CancellationResultDto {
    pub turn_id: TurnId,
    pub state: CancellationState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RiskResolvedResultDto {
    pub confirmation_id: ConfirmationId,
    pub accepted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemoryEpilogueDto {
    pub state: ComponentState,
    pub extracted: u32,
    pub stored: u32,
    pub skipped: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionEpilogueDto {
    pub session_id: SessionId,
    pub resume_selector: ResumeSelector,
    pub canonical_sequence: u64,
    pub committed_turns: u64,
    pub interrupted_turns: u64,
    pub state: StateSnapshotDto,
    pub memory: MemoryEpilogueDto,
    pub ended_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimePongDto {
    pub server_time_ms: i64,
    pub session_id: Option<SessionId>,
    pub turn_id: Option<TurnId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShutdownAdmittedDto { pub deadline_ms: i64 }
```

`StateSnapshotDto.objects` contains focused first, then active, soft, and hard,
with each tier ordered by `StateId`, capped at 100 summaries. `counts` always
covers the complete current graph and `truncated` is true exactly when more than
100 current objects exist. Retracted objects are excluded from both.

## 5. Usage, context, notices, and errors

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct UsageDto {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
    pub cost_microusd: Option<u64>,
    pub estimated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContextStatusDto {
    pub window_tokens: u64,
    pub occupied_tokens: u64,
    pub available_tokens: u64,
    pub occupied_percent_milli: u32,
    pub compact_at_percent_milli: u32,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub compaction_epoch: u64,
    pub pressure: ComponentState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoticeTone { Info, Success, Warning, Error }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NoticePersistence { Transient, UntilDismissed, Transcript }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SystemNoticeDto {
    pub notice_id: NoticeId,
    pub code: String,
    pub tone: NoticeTone,
    pub title: String,
    pub message: String,
    pub persistence: NoticePersistence,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoreErrorCode {
    InvalidInput,
    NotReady,
    SessionRequired,
    SessionBusy,
    SessionNotFound,
    ResumeSelectorAmbiguous,
    TurnNotFound,
    TurnAlreadyFinished,
    ConfirmationNotFound,
    ConfirmationExpired,
    ConsentNotFound,
    CursorInvalid,
    ContentNotFound,
    CatalogUnavailable,
    SettingsConflict,
    OperationConflict,
    OperationInterrupted,
    AuthenticationFailed,
    ProviderFailed,
    RateLimited,
    PermissionDenied,
    IntegrityFailed,
    Unavailable,
    Cancelled,
    Timeout,
    DurabilityFailed,
    Backpressure,
    Unsupported,
    Internal,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorRetryAdvice { Never, SameOperation, NewOperation, AfterDelay }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ErrorDetailsDto {
    None,
    InvalidField { field: String, reason: String },
    CurrentRevision { revision: u64 },
    MatchingSessions { session_ids: Vec<SessionId> },
    OperationConflict { existing_request_sha256: Sha256Digest },
    Domain { domain: String, code: String },
    RetryAfter { retry_after_ms: u64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CoreErrorDto {
    pub code: CoreErrorCode,
    pub message: String,
    pub retry: ErrorRetryAdvice,
    pub details: ErrorDetailsDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnFooterDto {
    pub turn_id: TurnId,
    pub outcome: TurnCompletionOutcome,
    pub usage: UsageDto,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnCompletionOutcome { Stop, Length, Interrupted }
```

Messages are user-safe and at most 1,000 UTF-8 bytes. Domain details expose a
stable redacted subsystem code only. They never contain credentials, raw tool
arguments, opaque reasoning, artifact bodies, backtraces, environment values,
or unrestricted paths.

Canonical `ErrorClass` maps to the UI code exactly as follows; a more specific
command code already listed above (session/turn/cursor/settings/operation) wins
when applicable:

| Canonical `ErrorClass` | `CoreErrorCode` | Default retry advice |
|---|---|---|
| `transport` | `ProviderFailed` | `NewOperation` |
| `timeout` | `Timeout` | `NewOperation` |
| `rate_limit` | `RateLimited` | `AfterDelay` with typed retry detail |
| `authentication` | `AuthenticationFailed` | `Never` until credentials change |
| `context_length`, `invalid_request`, `validation` | `InvalidInput` | `Never` |
| `invalid_provider_output` | `ProviderFailed` | `Never` |
| `policy` | `PermissionDenied` | `Never` |
| `not_found` | `ContentNotFound` | `Never` |
| `conflict` | `SessionBusy` | `NewOperation` |
| `integrity` | `IntegrityFailed` | `Never` |
| `persistence` | `DurabilityFailed` | `SameOperation` after recovery |
| `unavailable`, `process_crash` | `Unavailable` | `NewOperation` after service recovery |
| `cancelled` | `Cancelled` | `NewOperation` |
| `internal` | `Internal` | `Never` |

## 6. Exact UI event model

### 6.1 Envelope, durability, and enum

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UiEventRecord {
    pub ui_contract_schema_version: u32,
    pub session_id: Option<SessionId>,
    pub turn_id: Option<TurnId>,
    pub attempt_id: Option<AttemptId>,
    pub operation_id: Option<OperationId>,
    pub durability: UiDurabilityRef,
    pub event: UiEvent,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum UiDurabilityRef {
    Ephemeral,
    CanonicalEvent { event_id: EventId, canonical_sequence: u64 },
    CanonicalSnapshot { canonical_through_sequence: u64 },
    SettingsRevision { revision: u64, sha256: Sha256Digest },
    CredentialRevision { revision: u64 },
    HostRevision { kind: HostRevisionKind, revision: u64, sha256: Sha256Digest },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostRevisionKind { SetupConfig, Consent }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum UiEvent {
    RuntimeReady(RuntimeReadyDto),
    RuntimeStopping(RuntimeStoppingDto),
    RuntimeStopped(RuntimeStoppedDto),
    RuntimeBackpressure(BackpressureDto),
    SystemNotice(SystemNoticeDto),
    SystemError(CoreErrorDto),
    SessionOpened(SessionOpenResultDto),
    SessionStatus(SessionStatusDto),
    SessionCleared(SessionClearedResultDto),
    SessionEnded(SessionEpilogueDto),
    ModelChanged(ActiveModelDto),
    ReasoningChanged(ReasoningStateDto),
    SettingsChanged(EffectiveSettingsDto),
    ContextUpdated(ContextStatusDto),
    TurnStarted(TurnStartedDto),
    AttemptStarted(AttemptStartedDto),
    AssistantDelta(AssistantDeltaDto),
    AttemptRewind(AttemptRewindDto),
    AssistantAccepted(AssistantAcceptedDto),
    AttemptSuperseded(AttemptSupersededDto),
    UsageUpdated(UsageUpdatedDto),
    TurnCompleted(TurnCompletedDto),
    TurnInterrupted(TurnInterruptedDto),
    ToolBatchStarted(ToolBatchStartedDto),
    ToolCallPending(ToolCallPendingDto),
    RiskConfirmationRequested(RiskConfirmationDto),
    RiskConfirmationResolved(RiskConfirmationResolvedDto),
    ToolCallStarted(ToolCallStartedDto),
    ToolCallProgress(ToolCallProgressDto),
    ToolCallFinished(ToolCallFinishedDto),
    ToolBatchFinished(ToolBatchFinishedDto),
    SetupChanged(SetupStatusDto),
    AuthFlowUpdated(AuthFlowDto),
    AuthChanged(AuthChangedDto),
    ConsentRequested(ConsentRequestDto),
    ConsentResolved(ConsentResolvedResultDto),
}
```

One serialized core dispatcher establishes semantic emission order. Each sink
preserves the relative order of records it delivers after legal coalescing or
drop. IPC adds its own contiguous connection sequence; the in-process channel's
receive order is authoritative for Ratatui. No semantic order field competes
with canonical or connection sequence.

Envelope context validation is exact:

| Event variants | `session_id` | `turn_id` | `attempt_id` |
|---|---|---|---|
| `RuntimeReady`, `RuntimeBackpressure` | null | null | null |
| `RuntimeStopping`, `RuntimeStopped`, `SystemNotice`, `SystemError` | optional source session | optional only with session | optional only with matching turn |
| `SessionOpened`, `SessionStatus`, `SessionCleared`, `SessionEnded`, `ReasoningChanged`, `ContextUpdated` | required | null | null |
| `ModelChanged` | required | optional only for the protocol's initial-attempt fallback | null |
| `SettingsChanged` | optional active session | null | null |
| `TurnStarted`, `TurnCompleted` | required | required and payload-equal | null |
| `TurnInterrupted` | required | required and payload-equal | optional failed attempt in that turn |
| `AttemptStarted`, `AssistantDelta`, `AttemptRewind`, `AssistantAccepted`, `AttemptSuperseded`, `UsageUpdated` | required | required | required; payload IDs must agree, and supersession uses old attempt |
| All `Tool*` and `Risk*` variants | required | required | required accepted-step attempt |
| `SetupChanged`, `AuthFlowUpdated`, `AuthChanged`, `ConsentRequested`, `ConsentResolved` | optional active session | null | null |

`CanonicalEvent` durability requires a non-null session and its sequence/event
must exist in that session. `CanonicalSnapshot` requires a non-null session.
Settings, credential, and host revisions use no canonical event and may occur
without a session. `operation_id` is non-null exactly when the event is the
direct consequence or result notification of that durable UI operation; later
provider/tool descendants of `TurnSubmit` use null.

### 6.2 Event payloads

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeReadyDto {
    pub core_version: String,
    pub ui_contract_schema_version: u32,
    pub event_schema_version: u32,
    pub history_schema_version: u32,
    pub config_schema_version: u32,
    pub system_context_schema_version: u32,
    pub provider_registry_schema_version: u32,
    pub builtin_tool_catalog_schema_version: u32,
    pub redaction_version: String,
    pub features: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeStoppingDto { pub reason: ShutdownReason, pub deadline_ms: i64 }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RuntimeStoppedDto {
    pub clean: bool,
    pub exit_code: i32,
    pub final_canonical_sequence: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BackpressureDto {
    pub coalesced: u64,
    pub dropped_ephemeral: u64,
    pub blocked_ms: u64,
    pub queue_events: u32,
    pub queue_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionStatusDto {
    pub boot: BootStatusDto,
    pub active_model: ActiveModelDto,
    pub reasoning: ReasoningStateDto,
    pub turn_active: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnStartedDto {
    pub turn_id: TurnId,
    pub user_message_id: MessageId,
    pub user_text: TextContentDto,
    pub turn_index: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttemptStartedDto {
    pub attempt_id: AttemptId,
    pub attempt_number: u32,
    pub provider: ProviderId,
    pub model_id: ModelId,
    pub retry_of: Option<AttemptId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantVisibleBlockKind { Text, ReasoningSummary }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AssistantDeltaDto {
    pub block_id: AssistantBlockId,
    pub block_kind: AssistantVisibleBlockKind,
    pub first_chunk_index: u64,
    pub last_chunk_index: u64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RewindReason { Cancelled, Failed, Reconciliation }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttemptRewindDto {
    pub attempt_id: AttemptId,
    pub reason: RewindReason,
    pub discard_block_ids: Vec<AssistantBlockId>,
    pub replacement_attempt_id: Option<AttemptId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AcceptedAssistantBlockDto {
    pub block_id: AssistantBlockId,
    pub kind: AssistantVisibleBlockKind,
    pub content: TextContentDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AcceptedToolCallDto {
    pub call_id: ToolCallId,
    pub tool_name: ToolName,
    pub call_index: u32,
    pub redacted_label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AssistantAcceptedDto {
    pub step_id: StepId,
    pub attempt_id: AttemptId,
    pub blocks: Vec<AcceptedAssistantBlockDto>,
    pub tool_calls: Vec<AcceptedToolCallDto>,
    pub finish_reason: AssistantFinishReasonDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssistantFinishReasonDto { Stop, Length, ToolCalls }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SupersessionReasonDto { Retry, EmergencyContextRetry, ProviderFallback }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttemptSupersededDto {
    pub old_attempt_id: AttemptId,
    pub replacement_attempt_id: AttemptId,
    pub reason: SupersessionReasonDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UsageUpdatedDto { pub attempt_id: AttemptId, pub cumulative: UsageDto }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnCompletedDto { pub footer: TurnFooterDto }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TurnInterruptedDto {
    pub turn_id: TurnId,
    pub reason: TurnInterruptionReasonDto,
    pub message: String,
    pub uncertain_execution_ids: Vec<ToolExecutionId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnInterruptionReasonDto {
    UserAbort,
    ProviderFailure,
    StepLimit,
    ActiveTurnTooLarge,
    IncompatibleContinuation,
    ToolRuntimePoisoned,
    SessionShutdown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolBatchStartedDto {
    pub batch_id: ToolBatchId,
    pub step_id: StepId,
    pub call_ids: Vec<ToolCallId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolCallPendingDto {
    pub batch_id: ToolBatchId,
    pub call_id: ToolCallId,
    pub call_index: u32,
    pub tool_name: ToolName,
    pub label: String,
    pub redacted_arguments: JsonData,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RiskConfirmationDto {
    pub confirmation_id: ConfirmationId,
    pub call_id: ToolCallId,
    pub tool_name: ToolName,
    pub risk_class: RiskClassDto,
    pub title: String,
    pub detail: String,
    pub redacted_arguments: JsonData,
    pub argument_sha256: Sha256Digest,
    pub choices: Vec<RiskDecision>,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiskClassDto {
    Rm,
    GitReset,
    GitForcePush,
    GitClean,
    GhIssueClose,
    GhPrMerge,
    PackageInstall,
    WriteOutsideCwd,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RiskConfirmationResolvedDto {
    pub confirmation_id: ConfirmationId,
    pub decision: RiskDecision,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolCallStartedDto {
    pub batch_id: ToolBatchId,
    pub execution_id: ToolExecutionId,
    pub call_id: ToolCallId,
    pub tool_name: ToolName,
    pub started_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolProgressPhase { Waiting, Running, PostProcessing, Persisting }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolCallProgressDto {
    pub execution_id: ToolExecutionId,
    pub phase: ToolProgressPhase,
    pub elapsed_ms: u64,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolCallFinishedDto {
    pub batch_id: ToolBatchId,
    pub execution_id: ToolExecutionId,
    pub call_id: ToolCallId,
    pub tool_name: ToolName,
    pub status: ToolDisplayStatus,
    pub summary: String,
    pub duration_ms: u64,
    pub error: Option<CoreErrorDto>,
    pub content_ref: Option<ContentRefDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolBatchFinishedDto {
    pub batch_id: ToolBatchId,
    pub result_execution_ids: Vec<ToolExecutionId>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthChangedDto {
    pub provider: ProviderId,
    pub state: AuthState,
    pub active_model: Option<ActiveModelDto>,
}
```

Provider retry is forbidden after any `AssistantDelta` containing user-visible
text or reasoning summary. A failure after such a delta emits a durable attempt
failure, `AttemptRewind` with `Failed`, and terminal `TurnInterrupted`; it does
not emit `AttemptStarted` for a retry. A retry may occur only after a failed
attempt emitted no user-visible delta. `AttemptRewind` remains valid for
cancellation and accepted-content reconciliation and does not waive provider
retry policy.

## 7. Event priority, sensitivity, durability, and ordering

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiEventPriority { Critical, LatestOnly, Appendable }

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum UiCoalesceKey {
    RuntimeBackpressure,
    SessionStatus(SessionId),
    Settings,
    Context(SessionId),
    AssistantBlock(AttemptId, AssistantBlockId),
    AttemptUsage(AttemptId),
    ToolProgress(ToolExecutionId),
    AuthFlow(AuthFlowId),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiSensitivity { Public, LocalMetadata, Redacted, SecretInput }
```

This table is exhaustive. `-` means no coalescing key. `Canonical` requires
`CanonicalEvent`; `Snapshot` requires `CanonicalSnapshot`; `Settings`,
`Credentials`, and `Host` require their matching durability variants;
`Ephemeral` requires `Ephemeral`. A system notice/error uses the durability of
its stated source and therefore is the only conditional row.

| `UiEvent` variant | Priority | Coalescing key | Sensitivity | Durability |
|---|---|---|---|---|
| `RuntimeReady` | Critical | - | Public | Ephemeral |
| `RuntimeStopping` | Critical | - | Public | Ephemeral |
| `RuntimeStopped` | Critical | - | Public | Snapshot when a session was open, otherwise Ephemeral |
| `RuntimeBackpressure` | LatestOnly | `RuntimeBackpressure` | Public | Ephemeral |
| `SystemNotice` | Critical | - | Redacted | source durability, otherwise Ephemeral |
| `SystemError` | Critical | - | Redacted | source durability, otherwise Ephemeral |
| `SessionOpened` | Critical | - | LocalMetadata | Snapshot |
| `SessionStatus` | LatestOnly | `SessionStatus(session_id)` | LocalMetadata | Snapshot |
| `SessionCleared` | Critical | - | Public | Canonical |
| `SessionEnded` | Critical | - | LocalMetadata | Snapshot |
| `ModelChanged` | Critical | - | Public | Canonical |
| `ReasoningChanged` | Critical | - | Public | Canonical |
| `SettingsChanged` | LatestOnly | `Settings` | Public | Settings |
| `ContextUpdated` | LatestOnly | `Context(session_id)` | Public | Ephemeral |
| `TurnStarted` | Critical | - | Redacted | Canonical |
| `AttemptStarted` | Critical | - | Public | Canonical |
| `AssistantDelta` | Appendable | `AssistantBlock(attempt_id, block_id)` | Redacted | Ephemeral |
| `AttemptRewind` | Critical | - | Public | Canonical when failure/cancel is durable, otherwise Ephemeral for reconciliation |
| `AssistantAccepted` | Critical | - | Redacted | Canonical |
| `AttemptSuperseded` | Critical | - | Public | Canonical |
| `UsageUpdated` | LatestOnly | `AttemptUsage(attempt_id)` | Public | Ephemeral |
| `TurnCompleted` | Critical | - | Public | Canonical |
| `TurnInterrupted` | Critical | - | Redacted | Canonical |
| `ToolBatchStarted` | Critical | - | Public | Snapshot |
| `ToolCallPending` | Critical | - | Redacted | Ephemeral |
| `RiskConfirmationRequested` | Critical | - | Redacted | Ephemeral |
| `RiskConfirmationResolved` | Critical | - | Public | Ephemeral |
| `ToolCallStarted` | Critical | - | Public | Canonical |
| `ToolCallProgress` | LatestOnly | `ToolProgress(execution_id)` | Public | Ephemeral |
| `ToolCallFinished` | Critical | - | Redacted | Canonical |
| `ToolBatchFinished` | Critical | - | Public | Canonical |
| `SetupChanged` | Critical | - | LocalMetadata | Host (`setup_config`) |
| `AuthFlowUpdated` | LatestOnly | `AuthFlow(flow_id)` | LocalMetadata | Ephemeral |
| `AuthChanged` | Critical | - | LocalMetadata | Credentials |
| `ConsentRequested` | Critical | - | LocalMetadata | Ephemeral |
| `ConsentResolved` | Critical | - | Public | Host (`consent`) when persisted, otherwise Ephemeral |

Ordering rules are exact:

1. One core dispatcher serializes emission under a mutex. Concurrent producers
   cannot reorder records at one sink.
2. An event with `CanonicalEvent` is created only after the referenced event is
   fsynced. `CanonicalSnapshot` never claims beyond the last fsynced sequence.
3. Tool finished follows its canonical artifact/result durability; batch
   finished follows every tool finished. Assistant accepted follows canonical
   step acceptance. Turn completion/interruption is last for that turn.
4. Latest-only replacement occupies the older queued record's position and
   carries the newer payload. Appendable merge is legal
   only for adjacent chunk ranges of one coalescing key and produces at most
   16,384 UTF-8 bytes per queued record.
5. The dispatcher may discard an older latest-only record. It may merge or drop
   an appendable delta under pressure because `AssistantAccepted` is complete
   reconciliation authority. No critical event may coalesce or drop.
6. A rewind cannot overtake an earlier delivered delta for its attempt.
   Accepted reconciliation removes extra provisional blocks and replaces gaps.
7. Core durability never waits on terminal rendering. It may await bounded sink
   queue capacity only as specified below, after canonical state is durable.

## 8. Bounded sink behavior

```rust
#[async_trait::async_trait]
pub trait UiEventSink: Send + Sync + 'static {
    async fn emit(&self, event: UiEventRecord) -> Result<(), UiSinkError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UiSinkError {
    Detached,
    CriticalDeadlineExceeded,
    InvalidEvent(String),
}
```

`ChannelUiSink` has 1,024 queued records and 8 MiB estimated payload capacity.
It coalesces before enqueue. Latest-only and appendable emission never waits:
it replaces/merges first and drops the eligible record if no legal bounded slot
exists. Critical emission may await queue capacity for at most 2,000 ms. On
deadline, the sink atomically detaches, closes its event receiver, returns
`CriticalDeadlineExceeded`, and rejects later emits with `Detached`.

Sink failure does not roll back, append, interrupt, or otherwise change
canonical state. The Ratatui loop treats receiver closure as a persistent fatal
`Core UI event sink detached` screen; a headless recording sink returns the
error to its harness. Canonical processing may continue with a `NullUiSink` or
another independently registered sink. Rendering and terminal flush are never
inside `emit`.

`NullUiSink` is an explicit terminal consumer for headless mode: it accepts
every record immediately and retains none. This is not a bounded-queue drop and
cannot be selected for an attached interactive UI.

The temporary IPC adapter is stricter at the connection layer. It has its own
critical queue, acknowledgements, five-second admission pause, and ten-second
blocked-connection deadline. Its semantic sink follows this event table, but
the IPC writer may wait up to that transport deadline before detaching. The
sink failure itself does not mutate canonical state. After detach, the IPC
connection controller handles the condition exactly like client disconnect;
its normal session-shutdown/cancellation path may then append a canonical turn
interruption. That later lifecycle action is not rendering backpressure and
does not retroactively alter an already durable event.

## 9. Command sensitivity and concurrency

Commands containing `SensitiveStringDto` are `SecretInput`. Session cwd/config
paths, path completion, setup metadata, and auth flow metadata are
`LocalMetadata`. Turn text, slash text, redacted risk arguments, transcript, and
content are `Redacted`. Other command fields are `Public`. SecretInput bytes may
exist only in the caller buffer, transport input frame, and consuming Rust
stack/zeroizing buffer. They never enter operation result bytes or request
diagnostics.

Read-only commands are `SessionSnapshot`, `SlashCatalog`, `PathComplete`,
`ModelCatalog`, `TranscriptPage`, `ContentRead`, `SetupStatus`, and
`RuntimePing`; they have no `OperationId`. All other commands are serialized by
the relevant session or host mutation controller and require `OperationId`.
During an active turn, only read-only commands, `TurnCancel`, `RiskResolve`,
`ConsentResolve`, and `Shutdown` are admitted. Other mutations return
`SessionBusy`.

## 10. Durable operation idempotency

`OperationId` is globally unique, canonical, and restart-safe. It is not a
request ID. IPC request IDs are connection-local; repeating a request ID is not
a substitute for repeating an operation ID.

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    SessionCreate, SessionResume, SessionEnd, SessionClear, SessionNew,
    TurnSubmit, TurnCancel, RiskResolve, SlashExecute, ModelSelect,
    ReasoningSet, SettingsPatch, SetupApply, AuthLogin, AuthLogout,
    ConsentResolve, Shutdown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus { Reserved, Succeeded, Failed, Interrupted }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum OperationLedgerRef {
    Session { session_id: SessionId },
    Host,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OperationResultRef {
    pub ledger: OperationLedgerRef,
    pub operation_id: OperationId,
    pub ui_contract_schema_version: u32,
    pub result_sha256: Sha256Digest,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum PlannedEffectRef {
    CanonicalEvents { session_id: SessionId, event_ids: Vec<EventId> },
    NewSession { session_id: SessionId, session_started_event_id: EventId },
    SettingsRevision { from_revision: u64, to_revision: u64 },
    CredentialRevision { from_revision: u64, to_revision: u64 },
    ConsentRevision { from_revision: u64, to_revision: u64 },
    ProcessShutdown,
    NonReplayableSecretWrite,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OperationRecordDto {
    pub operation_id: OperationId,
    pub kind: OperationKind,
    pub request_sha256: Sha256Digest,
    pub status: OperationStatus,
    pub session_id: Option<SessionId>,
    pub planned_effects: Vec<PlannedEffectRef>,
    pub result_ref: Option<OperationResultRef>,
    pub first_canonical_sequence: Option<u64>,
    pub terminal_canonical_sequence: Option<u64>,
    pub created_at_ms: i64,
    pub finished_at_ms: Option<i64>,
}
```

The canonical request hash is SHA-256 of RFC 8785 JSON for
`{"kind":<operation_kind>,"payload":<command payload without operation_id>}`.
Every secret value is replaced before hashing by
`{"sensitive_sha256":SHA256(secret UTF-8 bytes)}`; plaintext is never stored.
Paths have already undergone Config normalization. The result hash is SHA-256
of RFC 8785 JSON for the complete successful `CoreCommandSuccess` or terminal
`CoreErrorDto` under UI contract schema 1.

History owns two physical ledgers with the exact schema in its specification:
session-scoped records in `history.db.operation_records` and host-scoped
create/setup/auth/settings/shutdown records in
`<PRAANA_HOME>/ui-operations.db`. Before any mutation, the controller:

1. Canonicalizes and hashes the request.
2. Looks up `operation_id` in both ledgers. The ID may exist in only one.
3. If absent, preallocates every canonical event/session ID or target store
   revision directly owned by command admission, writes a `Reserved` row and
   its typed plan, commits with `synchronous=FULL`, and only then performs the
   effect. A submitted turn's later provider/tool events belong to the turn
   state machine, not the `TurnSubmit` operation plan. Cancel/risk commands
   record their one-time request/decision; a later terminal turn/tool event is
   not replayed as part of the command.
4. On success or terminal failure, stores the exact schema-1 result JSON,
   result hash, applicable canonical sequence range, terminal status, and finish
   time in one full-sync transaction before returning the result.

Existing-record behavior is exact:

- Same ID, kind, and request hash with `Succeeded` or `Failed`: verify the
  result hash and return the stored result byte-for-byte without another effect.
- Same ID with a different kind or request hash: return `OperationConflict`,
  include only the existing request hash, and perform no effect.
- `Reserved` after restart: inspect every preallocated canonical event ID and
  target revision. If all effects are provably present, reconstruct/store the
  result and mark `Succeeded`. If none are present and the plan has no
  `NonReplayableSecretWrite`, execute once using the stored non-secret command
  plan and preallocated IDs. If effects are partial, inconsistent, or a secret
  write cannot be proved, mark `Interrupted`; never guess or repeat the effect.
- `Interrupted`: return `OperationInterrupted` for that ID. A user may issue a
  new operation ID after reviewing visible recovery status.

For canonical session operations, planned event IDs make the crash window
between event fsync and ledger update decidable. For settings, the settings row
and operation row update in the same host SQLite transaction. Credential,
setup-config, and persisted-consent writes use the History-owned operational
journal with before/after file identity, revision, and SHA-256; a fully matching
after state proves success, a fully matching before state permits one new
operation, and any other state is interrupted. Risk approval is never restored
after process loss; a reserved risk operation becomes interrupted/deny.

Session ledger rows are retained until that session is deleted. Host terminal
rows are retained for 30 days after `finished_at_ms`; rows referenced by a live
session are retained until that session is deleted. `Reserved` and
`Interrupted` rows are never age-pruned automatically. Reusing a pruned ID is
invalid client behavior; core ULID generation prevents normal reuse.

No component may claim restart-safe idempotency without writing and replaying
this ledger. A connection-local response cache is only an optimization.

## 11. Semantic-to-wire-to-reducer mapping

This is the one normative naming table. Wire names are lowercase dotted ASCII.
Underscore wire aliases are forbidden. IPC connection-only `hello`,
`connection.ack`, and `request.cancel` are transport commands and intentionally
have no semantic variants. Ratatui uses only the generic action/effect wrappers
shown; it does not define per-event shadow DTOs.

In the table, `Effect::Invoke(CoreCommand::X)` is exact shorthand for
`Effect::Invoke { request: fresh_local_request_token, command:
CoreCommand::X }`. `Action::CoreEvent(UiEvent::X)` is exact shorthand for
`Action::CoreEvent(UiEventRecord { event: UiEvent::X, ..validated_context })`.
No per-variant Ratatui action or effect exists.

| Direction | Semantic Rust variant | IPC dotted name | Ratatui reducer action/effect |
|---|---|---|---|
| UI -> core | `CoreCommand::SessionCreate` | `session.create` | `Effect::Invoke(CoreCommand::SessionCreate)` |
| UI -> core | `CoreCommand::SessionResume` | `session.resume` | `Effect::Invoke(CoreCommand::SessionResume)` |
| UI -> core | `CoreCommand::SessionEnd` | `session.end` | `Effect::Invoke(CoreCommand::SessionEnd)` |
| UI -> core | `CoreCommand::SessionSnapshot` | `session.snapshot` | `Effect::Invoke(CoreCommand::SessionSnapshot)` |
| UI -> core | `CoreCommand::SessionClear` | `session.clear` | `Effect::Invoke(CoreCommand::SessionClear)` |
| UI -> core | `CoreCommand::SessionNew` | `session.new` | `Effect::Invoke(CoreCommand::SessionNew)` |
| UI -> core | `CoreCommand::TurnSubmit` | `turn.submit` | `Effect::Invoke(CoreCommand::TurnSubmit)` |
| UI -> core | `CoreCommand::TurnCancel` | `turn.cancel` | `Effect::Invoke(CoreCommand::TurnCancel)` |
| UI -> core | `CoreCommand::RiskResolve` | `risk.resolve` | `Effect::Invoke(CoreCommand::RiskResolve)` |
| UI -> core | `CoreCommand::SlashCatalog` | `slash.catalog` | `Effect::Invoke(CoreCommand::SlashCatalog)` |
| UI -> core | `CoreCommand::SlashExecute` | `slash.execute` | `Effect::Invoke(CoreCommand::SlashExecute)` |
| UI -> core | `CoreCommand::PathComplete` | `path.complete` | `Effect::Invoke(CoreCommand::PathComplete)` |
| UI -> core | `CoreCommand::ModelCatalog` | `catalog.models` | `Effect::Invoke(CoreCommand::ModelCatalog)` |
| UI -> core | `CoreCommand::ModelSelect` | `model.select` | `Effect::Invoke(CoreCommand::ModelSelect)` |
| UI -> core | `CoreCommand::ReasoningSet` | `reasoning.set` | `Effect::Invoke(CoreCommand::ReasoningSet)` |
| UI -> core | `CoreCommand::SettingsPatch` | `settings.patch` | `Effect::Invoke(CoreCommand::SettingsPatch)` |
| UI -> core | `CoreCommand::TranscriptPage` | `transcript.page` | `Effect::Invoke(CoreCommand::TranscriptPage)` |
| UI -> core | `CoreCommand::ContentRead` | `content.read` | `Effect::Invoke(CoreCommand::ContentRead)` |
| UI -> core | `CoreCommand::SetupStatus` | `setup.status` | `Effect::Invoke(CoreCommand::SetupStatus)` |
| UI -> core | `CoreCommand::SetupApply` | `setup.apply` | `Effect::Invoke(CoreCommand::SetupApply)` |
| UI -> core | `CoreCommand::AuthLogin` | `auth.login` | `Effect::Invoke(CoreCommand::AuthLogin)` |
| UI -> core | `CoreCommand::AuthLogout` | `auth.logout` | `Effect::Invoke(CoreCommand::AuthLogout)` |
| UI -> core | `CoreCommand::ConsentResolve` | `consent.resolve` | `Effect::Invoke(CoreCommand::ConsentResolve)` |
| UI -> core | `CoreCommand::RuntimePing` | `runtime.ping` | `Effect::Invoke(CoreCommand::RuntimePing)` |
| UI -> core | `CoreCommand::Shutdown` | `runtime.shutdown` | `Effect::Invoke(CoreCommand::Shutdown)` |
| core -> UI | `UiEvent::RuntimeReady` | `runtime.ready` | `Action::CoreEvent(UiEvent::RuntimeReady)` |
| core -> UI | `UiEvent::RuntimeStopping` | `runtime.stopping` | `Action::CoreEvent(UiEvent::RuntimeStopping)` |
| core -> UI | `UiEvent::RuntimeStopped` | `runtime.stopped` | `Action::CoreEvent(UiEvent::RuntimeStopped)` |
| core -> UI | `UiEvent::RuntimeBackpressure` | `runtime.backpressure` | `Action::CoreEvent(UiEvent::RuntimeBackpressure)` |
| core -> UI | `UiEvent::SystemNotice` | `system.notice` | `Action::CoreEvent(UiEvent::SystemNotice)` |
| core -> UI | `UiEvent::SystemError` | `system.error` | `Action::CoreEvent(UiEvent::SystemError)` |
| core -> UI | `UiEvent::SessionOpened` | `session.opened` | `Action::CoreEvent(UiEvent::SessionOpened)` |
| core -> UI | `UiEvent::SessionStatus` | `session.status` | `Action::CoreEvent(UiEvent::SessionStatus)` |
| core -> UI | `UiEvent::SessionCleared` | `session.cleared` | `Action::CoreEvent(UiEvent::SessionCleared)` |
| core -> UI | `UiEvent::SessionEnded` | `session.ended` | `Action::CoreEvent(UiEvent::SessionEnded)` |
| core -> UI | `UiEvent::ModelChanged` | `model.changed` | `Action::CoreEvent(UiEvent::ModelChanged)` |
| core -> UI | `UiEvent::ReasoningChanged` | `reasoning.changed` | `Action::CoreEvent(UiEvent::ReasoningChanged)` |
| core -> UI | `UiEvent::SettingsChanged` | `settings.changed` | `Action::CoreEvent(UiEvent::SettingsChanged)` |
| core -> UI | `UiEvent::ContextUpdated` | `context.updated` | `Action::CoreEvent(UiEvent::ContextUpdated)` |
| core -> UI | `UiEvent::TurnStarted` | `turn.started` | `Action::CoreEvent(UiEvent::TurnStarted)` |
| core -> UI | `UiEvent::AttemptStarted` | `attempt.started` | `Action::CoreEvent(UiEvent::AttemptStarted)` |
| core -> UI | `UiEvent::AssistantDelta` | `assistant.delta` | `Action::CoreEvent(UiEvent::AssistantDelta)` |
| core -> UI | `UiEvent::AttemptRewind` | `attempt.rewind` | `Action::CoreEvent(UiEvent::AttemptRewind)` |
| core -> UI | `UiEvent::AssistantAccepted` | `assistant.accepted` | `Action::CoreEvent(UiEvent::AssistantAccepted)` |
| core -> UI | `UiEvent::AttemptSuperseded` | `attempt.superseded` | `Action::CoreEvent(UiEvent::AttemptSuperseded)` |
| core -> UI | `UiEvent::UsageUpdated` | `usage.updated` | `Action::CoreEvent(UiEvent::UsageUpdated)` |
| core -> UI | `UiEvent::TurnCompleted` | `turn.completed` | `Action::CoreEvent(UiEvent::TurnCompleted)` |
| core -> UI | `UiEvent::TurnInterrupted` | `turn.interrupted` | `Action::CoreEvent(UiEvent::TurnInterrupted)` |
| core -> UI | `UiEvent::ToolBatchStarted` | `tool.batch_started` | `Action::CoreEvent(UiEvent::ToolBatchStarted)` |
| core -> UI | `UiEvent::ToolCallPending` | `tool.call_pending` | `Action::CoreEvent(UiEvent::ToolCallPending)` |
| core -> UI | `UiEvent::RiskConfirmationRequested` | `risk.confirmation_requested` | `Action::CoreEvent(UiEvent::RiskConfirmationRequested)` |
| core -> UI | `UiEvent::RiskConfirmationResolved` | `risk.confirmation_resolved` | `Action::CoreEvent(UiEvent::RiskConfirmationResolved)` |
| core -> UI | `UiEvent::ToolCallStarted` | `tool.call_started` | `Action::CoreEvent(UiEvent::ToolCallStarted)` |
| core -> UI | `UiEvent::ToolCallProgress` | `tool.call_progress` | `Action::CoreEvent(UiEvent::ToolCallProgress)` |
| core -> UI | `UiEvent::ToolCallFinished` | `tool.call_finished` | `Action::CoreEvent(UiEvent::ToolCallFinished)` |
| core -> UI | `UiEvent::ToolBatchFinished` | `tool.batch_finished` | `Action::CoreEvent(UiEvent::ToolBatchFinished)` |
| core -> UI | `UiEvent::SetupChanged` | `setup.changed` | `Action::CoreEvent(UiEvent::SetupChanged)` |
| core -> UI | `UiEvent::AuthFlowUpdated` | `auth.flow_updated` | `Action::CoreEvent(UiEvent::AuthFlowUpdated)` |
| core -> UI | `UiEvent::AuthChanged` | `auth.changed` | `Action::CoreEvent(UiEvent::AuthChanged)` |
| core -> UI | `UiEvent::ConsentRequested` | `consent.requested` | `Action::CoreEvent(UiEvent::ConsentRequested)` |
| core -> UI | `UiEvent::ConsentResolved` | `consent.resolved` | `Action::CoreEvent(UiEvent::ConsentResolved)` |

Command completion always enters Ratatui as
`Action::CommandFinished { request, result: CoreCommandResult }`; the local
`request` token is presentation-only and is not part of this contract or IPC.

## 12. Exact command/result pairing

| Command | Required success variant |
|---|---|
| `SessionCreate`, `SessionResume`, `SessionNew` | `SessionOpened` |
| `SessionEnd` | `SessionEnded` |
| `SessionSnapshot` | `SessionSnapshot` |
| `SessionClear` | `SessionCleared` |
| `TurnSubmit` | `TurnSubmitted` |
| `TurnCancel` | `TurnCancellation` |
| `RiskResolve` | `RiskResolved` |
| `SlashCatalog` | `SlashCatalog` |
| `SlashExecute` | `SlashExecuted` |
| `PathComplete` | `PathCompletion` |
| `ModelCatalog` | `ModelCatalog` |
| `ModelSelect` | `ModelSelected` |
| `ReasoningSet` | `ReasoningSet` |
| `SettingsPatch` | `SettingsPatched` |
| `TranscriptPage` | `TranscriptPage` |
| `ContentRead` | `ContentRead` |
| `SetupStatus` | `SetupStatus` |
| `SetupApply` | `SetupApplied` |
| `AuthLogin` | `AuthLogin` |
| `AuthLogout` | `AuthLogout` |
| `ConsentResolve` | `ConsentResolved` |
| `RuntimePing` | `RuntimePong` |
| `Shutdown` | `ShutdownAdmitted` |

## 13. Machine-verifiable fixture inventory

Fixtures live at `crates/praana-core/tests/fixtures/ui_contract_v1/`:

```text
manifest.json
mapping.json
commands/session_create.json
commands/session_resume_by_id.json
commands/session_resume_by_selector.json
commands/session_end.json
commands/session_snapshot.json
commands/session_clear.json
commands/session_new.json
commands/turn_submit.json
commands/turn_cancel.json
commands/risk_resolve.json
commands/slash_catalog.json
commands/slash_execute.json
commands/path_complete.json
commands/model_catalog.json
commands/model_select.json
commands/reasoning_set.json
commands/settings_patch.json
commands/transcript_page_tail.json
commands/transcript_page_before.json
commands/content_read_bytes.json
commands/content_read_lines.json
commands/content_read_grep.json
commands/setup_status.json
commands/setup_apply_redacted.json
commands/auth_login_api_key_redacted.json
commands/auth_login_device.json
commands/auth_logout.json
commands/consent_resolve.json
commands/runtime_ping.json
commands/shutdown.json
results/session_create.json
results/session_resume_by_id.json
results/session_resume_by_selector.json
results/session_end.json
results/session_snapshot.json
results/session_clear.json
results/session_new.json
results/turn_submit.json
results/turn_cancel.json
results/risk_resolve.json
results/slash_catalog.json
results/slash_execute.json
results/path_complete.json
results/model_catalog.json
results/model_select.json
results/reasoning_set.json
results/settings_patch.json
results/transcript_page_tail.json
results/transcript_page_before.json
results/content_read_bytes.json
results/content_read_lines.json
results/content_read_grep.json
results/setup_status.json
results/setup_apply_redacted.json
results/auth_login_api_key_redacted.json
results/auth_login_device.json
results/auth_logout.json
results/consent_resolve.json
results/runtime_ping.json
results/shutdown.json
events/runtime_ready.json
events/runtime_stopping.json
events/runtime_stopped.json
events/runtime_backpressure.json
events/system_notice.json
events/system_error.json
events/session_opened.json
events/session_status.json
events/session_cleared.json
events/session_ended.json
events/model_changed.json
events/reasoning_changed.json
events/settings_changed.json
events/context_updated.json
events/turn_started.json
events/attempt_started.json
events/assistant_delta.json
events/attempt_rewind.json
events/assistant_accepted.json
events/attempt_superseded.json
events/usage_updated.json
events/turn_completed.json
events/turn_interrupted.json
events/tool_batch_started.json
events/tool_call_pending.json
events/risk_confirmation_requested.json
events/risk_confirmation_resolved.json
events/tool_call_started.json
events/tool_call_progress.json
events/tool_call_finished.json
events/tool_batch_finished.json
events/setup_changed.json
events/auth_flow_updated.json
events/auth_changed.json
events/consent_requested.json
events/consent_resolved.json
events/previsible_retry.jsonl
events/postvisible_interruption.jsonl
events/cancel_rewind.jsonl
events/accepted_reconciliation.jsonl
events/memory_enabled.jsonl
rejections/lowercase_ulid.json
rejections/prefixed_operation_id.json
rejections/recall_role.json
rejections/settings_unknown_field.json
rejections/operation_hash_conflict.json
rejections/cursor_cross_session.json
```

`manifest.json` has exactly:

```rust
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiFixtureManifest {
    pub ui_contract_schema_version: u32,
    pub command_files: Vec<String>,
    pub result_files: Vec<String>,
    pub event_files: Vec<String>,
    pub rejection_files: Vec<String>,
    pub mapping_file: String,
    pub sha256_by_file: BTreeMap<String, Sha256Digest>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiRejectionFixture {
    pub target: UiRejectionTarget,
    pub input_json: String,
    pub expected_code: UiFixtureErrorCode,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiRejectionTarget {
    Command,
    Result,
    Event,
    Transcript,
    OperationReplay,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiFixtureErrorCode {
    InvalidUlid,
    UnknownVariant,
    UnknownField,
    OperationConflict,
    CursorInvalid,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiMappingFixtureRow {
    pub direction: UiMappingDirection,
    pub semantic_variant: String,
    pub ipc_dotted_name: String,
    pub ratatui_mapping: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiMappingDirection { UiToCore, CoreToUi }
```

The test enumerates disk files and fails for an unlisted or missing file. It
recomputes every 64-lowercase-hex digest. `mapping.json` has one row for every
entry in section 11. The implementation defines explicit `ALL_COMMAND_KINDS`
and `ALL_EVENT_KINDS` const arrays beside the enums; exhaustive `match`
functions and the test compare those arrays to `mapping.json`. No reflection
dependency is required and no command/event may exist without one dotted name.
Every JSON ID fixture is a complete valid 26-character uppercase ULID. Every
SHA-256 fixture is a complete 64-character lowercase hexadecimal string.

The retry fixtures are exact: `previsible_retry.jsonl` has attempt start,
failure with no assistant delta, replacement start, acceptance, and
supersession. `postvisible_interruption.jsonl` has attempt start, one text delta,
durable failure, rewind with no replacement, and turn interruption. It contains
no replacement attempt. `cancel_rewind` proves rewind without retry.

## 14. Bounded implementation packet

### 14.1 Exact files

```text
crates/praana-core/src/ui_contract/mod.rs
crates/praana-core/src/ui_contract/ids.rs
crates/praana-core/src/ui_contract/json_data.rs
crates/praana-core/src/ui_contract/command.rs
crates/praana-core/src/ui_contract/result.rs
crates/praana-core/src/ui_contract/event.rs
crates/praana-core/src/ui_contract/transcript.rs
crates/praana-core/src/ui_contract/catalog.rs
crates/praana-core/src/ui_contract/setup.rs
crates/praana-core/src/ui_contract/settings.rs
crates/praana-core/src/ui_contract/sink.rs
crates/praana-core/src/ui_contract/operation.rs
crates/praana-core/src/history/operation_ledger.rs
crates/praana-core/tests/ui_contract_v1.rs
crates/praana-core/tests/ui_sink_backpressure.rs
crates/praana-core/tests/operation_idempotency.rs
crates/praana-cli/src/ipc/convert.rs
crates/praana-cli/tests/ipc_ui_contract_v1.rs
crates/praana-cli/src/tui/action.rs
crates/praana-cli/src/tui/effects.rs
crates/praana-cli/tests/tui_ui_contract_v1.rs
```

Do not add semantic DTOs under `ipc/` or `tui/`.

### 14.2 Required signatures

```rust
pub fn command_wire_name(command: &CoreCommand) -> &'static str;
pub fn event_wire_name(event: &UiEvent) -> &'static str;
pub fn command_from_wire(name: &str, payload: &[u8]) -> Result<CoreCommand, IpcConvertError>;
pub fn result_to_wire(result: &CoreCommandResult) -> Result<Vec<u8>, IpcConvertError>;
pub fn event_to_wire(event: &UiEventRecord) -> Result<Vec<u8>, IpcConvertError>;

pub fn validate_ui_event(event: &UiEventRecord) -> Result<(), UiContractError>;
pub fn priority(event: &UiEvent) -> UiEventPriority;
pub fn coalesce_key(event: &UiEventRecord) -> Option<UiCoalesceKey>;
pub fn sensitivity(event: &UiEvent) -> UiSensitivity;

pub async fn execute_core_command(
    core: &CoreServices,
    command: CoreCommand,
) -> CoreCommandResult;

pub async fn reserve_operation(
    ledger: &OperationLedger,
    command: &CoreCommand,
) -> Result<OperationReservation, CoreErrorDto>;

pub async fn recover_reserved_operations(
    ledger: &OperationLedger,
    history: &HistoryService,
) -> Result<Vec<SystemNoticeDto>, OperationRecoveryError>;

pub fn update(state: &mut AppState, action: Action) -> UpdateResult;
pub async fn run_effect(core: &CoreCommandSender, effect: Effect) -> Action;
```

### 14.3 Tests-first sequence

1. Check in the fixture tree and enum/mapping coverage test. Run
   `cargo test -p praana-core --test ui_contract_v1`; expected red output is
   unresolved `praana_core::ui_contract` imports.
2. Add IDs and leaf DTOs. The same command remains red on missing
   `CoreCommand`, `CoreCommandResult`, and `UiEvent`, then turns green only when
   every fixture round-trips and all rejection fixtures fail with the expected
   code.
3. Add mapping conversion. Run
   `cargo test -p praana-cli --test ipc_ui_contract_v1`; expected red output is
   missing `ipc::convert`, then green with exact dotted names and no unknown
   mapping rows.
4. Add priority/coalescing validation and bounded channel. Run
   `cargo test -p praana-core --test ui_sink_backpressure`; expected red output
   is missing sink behavior, then green with critical deadline under paused
   Tokio time, exact coalescing keys, no critical loss, and receiver detach.
5. Add History ledgers and recovery. Run
   `cargo test -p praana-core --test operation_idempotency`; expected red output
   is missing ledger schema, then green for crash at reservation, every planned
   event fsync, effect completion, result storage, conflict, and retention.
6. Wire Ratatui generic action/effect. Run
   `cargo test -p praana-cli --test tui_ui_contract_v1`; expected red output is
   direct service/IPC DTO imports, then green when all core interactions are
   `Effect::Invoke` and all events enter through `Action::CoreEvent`.
7. Run `cargo fmt --all -- --check`,
   `cargo clippy --workspace --all-targets --all-features -- -D warnings`, and
   `cargo test --workspace`; all must exit 0 before UI-contract implementation
   is accepted.

### 14.4 Non-goals

- No public remote API or stable IPC lifetime beyond the migration.
- No presentation state, widget type, keymap, terminal color, layout, or cache.
- No canonical conversation event replacement.
- No TypeScript-owned DTO, history, retry, settings, or operation ledger.
- No provider retry after a visible assistant delta.
- No old config/session/event compatibility.

### 14.5 Common mistakes

- Prefixing `OperationId` or transcript IDs.
- Treating a 12-character selector as `SessionId`.
- Adding `Recall` beside `Memory`.
- Negotiating baseline `settings.patch`.
- Defining payloads again in IPC or Ratatui.
- Using `serde_json::Value` for a known command, result, event, setup value, or
  error detail.
- Calling a wire event name from Tool Runtime.
- Blocking canonical fsync on terminal draw or waiting forever for UI capacity.
- Dropping a final/critical event or treating a delta as accepted authority.
- Retrying a provider after visible text/reasoning and citing rewind as
  permission.
- Claiming operation restart safety from an in-memory response cache.
- Persisting secret plaintext in request hashes, operation plans, fixtures, or
  errors.

### 14.6 Acceptance checklist

- [ ] `UI_CONTRACT_SCHEMA_VERSION` is 1 and appears in the plan registry.
- [ ] Every command/result/event and reachable DTO is a typed Rust definition.
- [ ] Every semantic variant has exactly one dotted IPC name and generic
      Ratatui action/effect mapping.
- [ ] All crossing semantic IDs are raw uppercase 26-character ULIDs.
- [ ] Resume selector collision tests require explicit canonical ID selection.
- [ ] `Memory` is plugin-gated and `Recall` appears in no Rust v2 contract.
- [ ] `settings.patch` works in baseline IPC v1 without a capability.
- [ ] Critical, latest-only, and appendable behavior passes bounded-channel
      tests with paused time.
- [ ] Durable operations replay from History-owned ledgers at every crash point.
- [ ] Post-visible provider failure terminates rather than retries.
- [ ] IPC and Ratatui import semantic DTOs only from `praana-core::ui_contract`.
- [ ] Fixture inventory, complete ULIDs, full SHA-256 values, and ASCII dotted
      names pass machine validation.
- [ ] Full Rust formatting, lint, and workspace tests pass.
