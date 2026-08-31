# PRAANA Rust v2 Canonical Protocol Specification

**Status:** Normative implementation specification

**Protocol version:** 2

**Projection version:** `rust-v2-projection-1`

**Date:** 2026-08-31

## 1. Scope and Authority

This document specifies the canonical event log, accepted conversation
projection, provider-attempt lifecycle, assistant/tool loop, durability
boundaries, and crash recovery behavior for PRAANA Rust v2. It is intended to
be sufficient for implementation without an implementer choosing data shapes,
event ordering, retry semantics, or recovery policy.

`docs/RUST_V2_PLAN.md` owns locked architecture and the cross-spec authority
table. This document is the direct and final normative owner of the canonical envelope,
event/attempt/turn lifecycle, and accepted-conversation/logical request
projection. `docs/RUST_V2_CONFIG_SPEC.md` exclusively owns accepted config
keys, defaults, source/merge rules, path normalization, phase gates, and the
effective config digest. Narrower specifications own their named concerns: compaction owns
admission and exact summary/handoff payloads, StateGraph owns `StateChanged`
payloads, History Storage owns physical storage/artifact previews/search, Token
Accounting owns all token estimation and shared Unicode utilities, Tool Runtime
owns internal execution/result DTOs and catalog order, and provider
specifications own literal wire placement. A duplicate here is non-normative in
that narrower concern. The current TypeScript implementation is an oracle only
for behavior explicitly retained by the plan.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described by RFC 2119.

This specification covers:

- The on-disk `events.jsonl` representation and append contract.
- Rust types and their exact JSON encoding.
- Canonical user, assistant, and tool-result messages plus projected handoff and
  recovery control data.
- Canonical provider continuation state used by provider adapters.
- Reserved continuation forms for later Anthropic, Gemini, and Bedrock drivers.
- Session, turn, provider-attempt, assistant-step, tool-batch, and tool-execution
  state machines.
- Logical accepted-conversation and model-visible request projection.
- Attempt retry and supersession behavior.
- Parallel tool execution, result matching, and deterministic result ordering.
- Reset, model/reasoning changes, compaction, and continuation boundaries.
- Recovery from process failure and a truncated final JSONL record.
- Golden fixtures and the minimum protocol test suite.

The specification does not define provider credentials, literal provider wire
roles/fields, UI IPC framing, cross-session memory API/framing, tool
implementation internals or catalog ordering, SQLite table DDL, artifact
preview generation, compaction/StateGraph payload fields, token estimation,
Unicode search normalization, or Ratatui behavior except where those systems
must obey a protocol boundary.

## 2. Explicit Non-Goals

The initial implementation MUST NOT add any of the following to this protocol:

- Compatibility with TypeScript event logs, old session directories, old
  databases, old configuration, or compression checkpoints.
- A migration reader or best-effort conversion for an unknown schema version.
- The TypeScript classic compiler or its reconstructed system-prompt history.
- The experimental scored engine projection.
- Automatic per-turn model routing.
- Anthropic, Gemini, Bedrock, Azure, or arbitrary provider execution. Their
  continuation DTOs below reserve a stable data boundary only.
- Semantic transcript search, default embeddings, or model downloads.
- Cross-session Cognitive Memory. Memory plugin records are not canonical
  conversation events.
- Durable streaming-delta events. Deltas are ephemeral UI events.
- Automatic rerun of a tool whose side effects are uncertain.
- In-place editing, deletion, or hiding of a valid canonical event.
- A provider-managed response ID as the source of local conversation truth.
- Fabricated user messages for compaction, recovery, or control instructions.
- Arbitrary provider output-item pass-through. Unsupported output item types
  fail the provider attempt with `E_PROVIDER_OUTPUT_UNSUPPORTED`.

## 3. Terminology

| Term | Definition |
|---|---|
| Canonical event | A schema-valid `EventEnvelope` durably appended to `events.jsonl`. |
| Durable | The event line has been fully written, flushed, and acknowledged by a successful file `fsync`. |
| Accepted step | An assistant message represented by a durable `assistant_step_accepted` event. |
| Outer turn | One accepted user message followed by zero or more assistant/tool cycles and a terminal assistant step or explicit interruption. |
| Provider attempt | One provider request and stream, identified by a fresh `AttemptId`. |
| Assistant step | One accepted provider response within an outer turn. A turn may contain several steps. |
| Tool cycle | One accepted assistant step containing tool calls, the complete result batch, and the next provider attempt. |
| Tool batch | All tool calls in one accepted assistant step. There is exactly one batch per tool-using step. |
| Protocol-complete | Every tool call in an accepted step has exactly one durable result and the batch has a durable completion event. |
| Accepted conversation | Deterministic portable messages projected from accepted canonical events. |
| Model-visible request | The accepted conversation after reset and compaction filtering, plus optional plugin bootstrap memory, active handoff, current state, recovery notices, and compatible active continuation. |
| Attempt supersession | An audit relation from a failed or abandoned attempt to the later accepted replacement for the same purpose. |
| Active tool cycle | The interval from accepting a tool-using assistant step through accepting the next assistant step. |
| Uncertain execution | A tool has a durable start but no durable finish, so the process cannot prove whether its body or side effects completed. |
| Artifact | A complete post-hook, post-redaction tool result stored in the session `history.db`. |
| Inline result | A complete result carried in the event because it is within the artifact policy. It is not a truncated result. |
| Historical handoff | A bounded, non-authoritative model-visible summary activated by compaction. |
| Reset epoch | Events after one `reset_boundary` and before the next. Epoch zero begins at `session_started`. |
| Compaction epoch | Monotonically increasing compaction number within one reset epoch. |
| Replay | Validation and deterministic state construction from canonical events in `sequence` order. |

## 4. Encoding and Validation Rules

### 4.1 JSONL

`events.jsonl` MUST be UTF-8. Each event is one compact JSON object followed by
one LF byte (`0x0a`). Strings use normal JSON escaping. A writer MUST NOT emit a
UTF-8 BOM, comments, blank lines, NaN, positive or negative infinity, or trailing
bytes after the JSON object and before LF.

One event line, excluding LF, MUST NOT exceed 16,777,216 bytes. A local append
that would exceed the limit fails with `E_EVENT_TOO_LARGE` before writing. A
larger line found during replay is an integrity error with the same code. Large
tool data belongs in `history.db`, not the event line.

All JSON object field names are lower snake case. Enum discriminants are lower
snake case. All structs and enums use `#[serde(deny_unknown_fields)]`. A missing
required field, unknown field, duplicate JSON object key, wrong JSON type, or
unknown enum discriminant is `E_EVENT_SCHEMA_INVALID`.

Every `Option<T>` field is serialized explicitly as JSON `null` when absent.
Empty vectors and maps are serialized as `[]` and `{}`. Implementations MUST NOT
use `skip_serializing_if` in canonical event DTOs. This rule makes fixtures and
hash inputs stable.

JSON integer fields MUST be in `0..=9007199254740991`, except `timestamp_ms`,
which MUST be in `-9007199254740991..=9007199254740991`. Production timestamps
MUST be non-negative Unix milliseconds. The wider signed validation range
exists only for deterministic tests with a synthetic clock.

### 4.2 IDs and scalar newtypes

All canonical local IDs are uppercase 26-character Crockford Base32 ULIDs,
including recovery notice, compaction, and StateGraph IDs. Deserialization
MUST reject lowercase, ambiguous characters `I`, `L`, `O`, and `U`, a wrong
length, or a ULID value that cannot be decoded. IDs are serialized as JSON
strings. The writer uses monotonic ULID generation, but replay order is always
`sequence`, never ULID order or timestamp order. `RecoveryNoticeId` is the
deterministic ULID exception defined below; it is still ordering metadata only.

`ToolCallId` is the sole accepted provider tool-call identifier and is an opaque
non-empty provider string, not a ULID. Other provider-owned identifiers, such as
Responses item IDs, use their own opaque protocol newtypes and are not canonical
local IDs. Provider-owned identifiers MUST be at most 256 UTF-8 bytes and contain
no ASCII control character. Tool-call IDs MUST be unique within a session.

SHA-256 values are 64 lowercase hexadecimal characters. Media types are
lowercase type/subtype strings without parameters. Provider, protocol, and
model names are non-empty UTF-8 strings of at most 256 bytes. Built-in tool
names use the Tool Runtime grammar `^[a-z][a-z0-9_]{0,63}$`; the protocol
validates accepted names against the registered catalog and does not define a
broader alias grammar.

`ProjectionId` and estimator/policy/profile version labels are version
identifiers, not local entity IDs. `ProjectionId` validates the exact schema-2
value `rust-v2-projection-1` and serializes as that string. This does not permit
a raw string in a session/turn/event/artifact/StateGraph ID field.

The implementation MUST define these protocol-owned Rust newtypes with custom
validating `Deserialize` and `#[serde(transparent)]` serialization. Every core
boundary and specialized payload MUST use these newtypes, never raw
`ulid::Ulid`, `String`, or a local alias for an ID:

```rust
pub struct SessionId(pub ulid::Ulid);
pub struct EventId(pub ulid::Ulid);
pub struct TurnId(pub ulid::Ulid);
pub struct AttemptId(pub ulid::Ulid);
pub struct StepId(pub ulid::Ulid);
pub struct MessageId(pub ulid::Ulid);
pub struct ToolBatchId(pub ulid::Ulid);
pub struct ToolExecutionId(pub ulid::Ulid);
pub struct ArtifactId(pub ulid::Ulid);
pub struct CompactionId(pub ulid::Ulid);
pub struct SummarySegmentId(pub ulid::Ulid);
pub struct HandoffId(pub ulid::Ulid);
pub struct StateId(pub ulid::Ulid);
pub struct StateMutationId(pub ulid::Ulid);
pub struct RecoveryNoticeId(pub ulid::Ulid);
pub struct SearchResultId(pub ulid::Ulid);
pub struct DeletionId(pub ulid::Ulid);
pub struct ToolCallId(pub String);
pub struct ProviderItemId(pub String);
pub struct ProviderResponseId(pub String);
pub struct Sha256Digest(pub String);
pub struct ProjectionId(pub String);
```

### 4.3 Canonical JSON and hashes

JSON values used as tool arguments or structured tool results MUST be
canonicalized with RFC 8785 JSON Canonicalization Scheme before hashing or
storing their canonical text. Tool argument objects preserve semantic JSON, not
provider whitespace. `ToolCall.raw_arguments` preserves the exact concatenated
provider argument string separately.

Hash definitions are exact:

- `request_hash` is SHA-256 of RFC 8785 canonical JSON for the complete provider
  wire body, excluding credentials and HTTP headers. A body field such as
  `previous_response_id` is included; out-of-body transport/request IDs are not.
- `capability_profile_hash` is SHA-256 of RFC 8785 canonical JSON for the exact
  resolved `ModelCapabilityProfile` from the Compaction specification,
  including its profile/model revision and context window.
- `arguments_hash` is SHA-256 of RFC 8785 canonical JSON for the parsed argument
  object.
- `accepted_messages_hash` is SHA-256 of RFC 8785 canonical JSON for the ordered
  user, assistant, and tool-result `ConversationMessage` array committed by
  that turn. It excludes every handoff, recovery notice, system/current-state
  envelope, and message from another turn.
- Artifact `sha256` is SHA-256 of the exact complete post-redaction result bytes.
- Compaction `source_hash` is SHA-256 over the exact UTF-8 event lines, including
  each terminating LF, from `source_start_sequence` through
  `source_end_sequence` inclusive.
- `endpoint_fingerprint` is SHA-256 of the normalized lowercase scheme, host,
  effective port, and normalized API path prefix. It excludes query parameters,
  credentials, and headers.
- A recovery notice ID is the uppercase Crockford ULID encoding of the first 16
  bytes of SHA-256 over UTF-8 `praana-recovery-v2`, NUL, recovery kind, NUL, and
  each source key separated by NUL. A source key is an uppercase source event ID.
  For a truncated tail, the sole source key is `tail:` followed by the lowercase
  SHA-256 of quarantined bytes. Source keys are in event sequence order. This is
  deterministic ID derivation, not time ordering; retries reproduce the same ID.
  A derived-ID collision with a different recovery tuple is
  `E_REFERENCE_DUPLICATE` and stops automatic recovery.

### 4.4 Schema constants

```rust
pub const EVENT_SCHEMA_VERSION: u32 = 2;
pub const PROJECTION_VERSION: &str = "rust-v2-projection-1";
pub const COMPACTION_POLICY_VERSION: &str = "rust-v2-compaction-1";
pub const ARTIFACT_POLICY_VERSION: &str = "rust-v2-artifact-1";
pub const TOKEN_ESTIMATOR_SCHEMA_VERSION: u32 = 1;
```

A reader that sees any `schema_version` other than 2 MUST stop with
`E_SCHEMA_VERSION_UNSUPPORTED`. It MUST NOT attempt old-session compatibility.

## 5. Exact Rust Data Model

The definitions in this section are normative. Derives such as `Debug`,
`Clone`, `PartialEq`, `Eq`, and `JsonSchema` may be added. Field names, field
types, enum tagging, and JSON names MUST NOT change within schema version 2.

### 5.1 Envelope and event enum

```rust
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventEnvelope {
    pub schema_version: u32,
    pub event_id: EventId,
    pub session_id: SessionId,
    pub sequence: u64,
    pub timestamp_ms: i64,
    pub turn_id: Option<TurnId>,
    pub attempt_id: Option<AttemptId>,
    pub event: CanonicalEvent,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum CanonicalEvent {
    SessionStarted(SessionStarted),
    UserMessageAccepted(UserMessageAccepted),
    TurnStarted(TurnStarted),
    AssistantAttemptStarted(AssistantAttemptStarted),
    AssistantAttemptFailed(AssistantAttemptFailed),
    AssistantStepAccepted(AssistantStepAccepted),
    AttemptSuperseded(AttemptSuperseded),
    ToolExecutionStarted(ToolExecutionStarted),
    ToolExecutionFinished(ToolExecutionFinished),
    ToolBatchCompleted(ToolBatchCompleted),
    TurnCommitted(TurnCommitted),
    TurnInterrupted(TurnInterrupted),
    StateChanged(StateChangedV1),
    HistoryCompacted(HistoryCompactedV1),
    ModelChanged(ModelChanged),
    ResetBoundary(ResetBoundary),
    SystemNote(SystemNote),
}
```

`RUST_V2_STATE_GRAPH_SPEC.md` section 3 directly and finally defines
`StateChangedV1`. `RUST_V2_COMPACTION_SPEC.md` section 11 directly and finally
defines `HistoryCompactedV1`. Their owner specs define the exact Serde shape and
subsystem schema version; this protocol does not declare aliases with different
fields.

The `event` JSON value is therefore always an object with exactly the keys
`kind` and `data`; event payload fields are never flattened into the envelope.

### 5.2 Common model and usage types

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum HistoryMode {
    Append,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ReasoningEffort {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSelection {
    pub provider: String,
    pub protocol: String,
    pub model: String,
    pub model_revision: Option<String>,
    pub model_family: String,
    pub endpoint_fingerprint: Sha256Digest,
    pub reasoning_effort: ReasoningEffort,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct ProviderUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionSnapshot {
    pub token_estimator_schema_version: u32,
    pub estimator_id: String,
    pub estimated_input_sha256: Sha256Digest,
    pub context_window_tokens: u64,
    pub estimated_input_tokens: u64,
    pub requested_output_tokens: u64,
    pub requested_reasoning_tokens: u64,
    pub safety_margin_tokens: u64,
    pub projected_fill_millionths: u32,
    pub capability_profile_hash: Sha256Digest,
    pub estimate_reused_from_attempt_id: Option<AttemptId>,
}
```

`projected_fill_millionths` is the projected occupied fraction multiplied by
1,000,000. Floating-point numbers MUST NOT appear in canonical admission data.
This is the canonical event snapshot of the exact owner-defined
`AdmissionEstimate`; it does not define a second admission calculation.
Estimator identity, component boundaries, input hash, and rounding are defined
only by `RUST_V2_TOKEN_ACCOUNTING_SPEC.md`. `estimated_input_sha256` is that
authority's ordered request-component manifest hash, not `request_hash`.
`estimate_reused_from_attempt_id` is non-null only when that earlier attempt's
`request_hash` and `capability_profile_hash` both exactly match this attempt;
reuse does not replace the new attempt's fresh admission decision.
The sum relation for provider usage is advisory because providers report
different categories; all counts MUST be copied without inventing missing
tokens, and unavailable counts are zero.

### 5.3 Canonical conversation messages

Block vectors are ordered and MUST remain ordered through storage, projection,
provider formatting, and fixtures. An adapter MUST NOT flatten separate text,
reasoning, image, and tool-call arrays and later guess their order.

```rust
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "role",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ConversationMessage {
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolResult(ToolResultMessage),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserMessage {
    pub message_id: MessageId,
    pub turn_id: TurnId,
    pub blocks: Vec<UserBlock>,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum UserBlock {
    Text(TextBlock),
    Image(ImageBlock),
    ArtifactRef(ArtifactReferenceBlock),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantMessage {
    pub message_id: MessageId,
    pub turn_id: TurnId,
    pub step_id: StepId,
    pub provider: String,
    pub model: String,
    pub blocks: Vec<AssistantBlock>,
    pub finish_reason: FinishReason,
    pub continuation: Option<ProviderContinuation>,
    pub usage: ProviderUsage,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum AssistantBlock {
    Text(TextBlock),
    ReasoningSummary(ReasoningSummaryBlock),
    ToolCall(ToolCall),
    Image(ImageBlock),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum FinishReason {
    Stop,
    ToolUse,
    Length,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextBlock {
    pub text: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReasoningSummaryBlock {
    pub text: String,
    pub provider_item_id: Option<ProviderItemId>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub call_id: ToolCallId,
    pub name: String,
    pub arguments: serde_json::Map<String, serde_json::Value>,
    pub raw_arguments: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageBlock {
    pub media_type: String,
    pub source: ImageSource,
    pub alt_text: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ImageSource {
    InlineBase64(InlineBase64Image),
    Artifact(ArtifactRef),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InlineBase64Image {
    pub data: String,
    pub sha256: Sha256Digest,
    pub byte_count: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReferenceBlock {
    pub reference: ArtifactRef,
    pub description: String,
}
```

Validation rules:

- `UserMessage.blocks` MUST be non-empty. Text may be empty only when another
  non-empty image or artifact block is present.
- `AssistantMessage.blocks` MUST be non-empty.
- A provider completion whose empty blocks are removed to leave no block fails
  the attempt with `E_PROVIDER_OUTPUT_UNSUPPORTED`; an empty assistant step is
  never accepted.
- `finish_reason = tool_use` requires at least one `tool_call` block.
- `finish_reason = stop` or `length` forbids `tool_call` blocks.
- Every tool-call `arguments` value is an object. Invalid or incomplete JSON
  arguments fail the attempt with `E_TOOL_ARGUMENTS_INVALID`; v2 does not repair
  braces, wrap scalar values, or execute a `_raw` fallback.
- `raw_arguments` is the exact UTF-8 concatenation of provider fragments. Parsing
  it and canonicalizing the result MUST equal `arguments`.
- Empty assistant text blocks are removed before acceptance. Empty reasoning
  summary blocks are removed before acceptance.
- `ReasoningSummaryBlock` is provider-visible summary text, not hidden chain of
  thought. Opaque or encrypted reasoning exists only in continuation data.

### 5.4 Tool-result and artifact-reference types

```rust
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResultMessage {
    pub message_id: MessageId,
    pub turn_id: TurnId,
    pub step_id: StepId,
    pub batch_id: ToolBatchId,
    pub execution_id: ToolExecutionId,
    pub call_id: ToolCallId,
    pub tool_name: String,
    pub status: ToolResultStatus,
    pub body: ToolResultBody,
    pub recovered: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolResultStatus {
    Success,
    Error,
    Blocked,
    Cancelled,
    Uncertain,
    Skipped,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolResultBody {
    pub media_type: String,
    pub content: ToolResultContent,
    pub sha256: Sha256Digest,
    pub byte_count: u64,
    pub line_count: Option<u64>,
    pub estimated_tokens: u64,
    pub token_estimator_schema_version: u32,
    pub estimator_id: String,
    pub token_input_sha256: Sha256Digest,
    pub redacted: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "storage",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ToolResultContent {
    Inline(InlineToolResult),
    Artifact(ArtifactToolResult),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InlineToolResult {
    pub text: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactToolResult {
    pub preview: String,
    pub reference: ArtifactRef,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRef {
    pub artifact_id: ArtifactId,
    pub sha256: Sha256Digest,
    pub media_type: String,
    pub byte_count: u64,
    pub line_count: Option<u64>,
    pub estimated_tokens: u64,
    pub token_estimator_schema_version: u32,
    pub estimator_id: String,
    pub token_input_sha256: Sha256Digest,
    pub retrieval: ArtifactRetrieval,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRetrieval {
    pub tool: String,
    pub arguments: serde_json::Map<String, serde_json::Value>,
}

```

For `Inline`, `text` is the complete result. For `Artifact`, `preview` is an
immutable deterministic preview and the referenced artifact contains the
complete result. Neither form means "best effort" or silent truncation.
`ArtifactRetrieval.tool` MUST equal `retrieve_artifact`, and its arguments MUST
contain exactly `{"artifact_id":"<id>"}` for full retrieval.

The body hash, counts, and token-estimate metadata always describe the complete
result, not the preview. `ToolResultBody` and nested `ArtifactRef` estimate
fields must agree for an artifact result.
For canonical JSON tool results, `media_type` is `application/json` and `text`
or artifact bytes are RFC 8785 canonical JSON. For plain output it is
`text/plain`. `line_count` is the number of logical lines, where an empty byte
string has zero lines and otherwise lines equal LF count plus one.

The Tool Runtime specification owns the finalized internal `ToolResultDto` and
its deterministic conversion into this canonical result message. The History
Storage specification exclusively owns inline/artifact thresholds, physical
artifact rows and transactions, immutable preview schema, content-aware
token-bounded preview generation, and retrieval. This protocol does not define
a byte-slicing fallback or any other preview algorithm. It requires only that a
referenced artifact is durable before the finish event, that the event's
hash/counts describe the complete post-redaction result, and that projection
never represents a preview as the complete body. All estimates use
`RUST_V2_TOKEN_ACCOUNTING_SPEC.md`.

### 5.5 Handoff reference and recovery notices

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum RecoveryKind {
    AttemptLost,
    ToolSideEffectUncertain,
    ToolResultRecovered,
    TurnInterrupted,
    TruncatedLogTail,
    ModelChanged,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryNotice {
    pub notice_id: RecoveryNoticeId,
    pub kind: RecoveryKind,
    pub source_event_ids: Vec<EventId>,
    pub message: String,
    pub required_action: String,
}
```

Every protocol field named `handoff` has the exact `HistoricalHandoffV1` type
from `RUST_V2_COMPACTION_SPEC.md` section 8.3. That owner also defines handoff
validation and deterministic rendering. Literal provider placement is not part
of this protocol; OpenAI placement is defined only by
`RUST_V2_OPENAI_SPEC.md`.

Recovery notice text is generated from fixed templates in Section 14. It is
control data, not an assertion that an uncertain side effect occurred. A
recovery notice is included in the next provider request that can act on it and
is recorded in that request's `assistant_attempt_started` payload.

### 5.6 Provider continuation

```rust
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "provider_protocol",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ProviderContinuation {
    OpenAiResponses(OpenAiResponsesContinuation),
    Anthropic(AnthropicContinuation),
    Gemini(GeminiContinuation),
    Bedrock(BedrockContinuation),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContinuationScope {
    pub provider: String,
    pub protocol: String,
    pub model: String,
    pub model_revision: Option<String>,
    pub endpoint_fingerprint: Sha256Digest,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiResponsesContinuation {
    pub scope: ContinuationScope,
    pub response_id: Option<ProviderResponseId>,
    pub output_items: Vec<OpenAiResponseOutputItem>,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum OpenAiResponseOutputItem {
    Message(OpenAiResponseMessageItem),
    Reasoning(OpenAiResponseReasoningItem),
    FunctionCall(OpenAiResponseFunctionCallItem),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiResponseMessageItem {
    pub id: Option<ProviderItemId>,
    pub status: OpenAiItemStatus,
    pub role: OpenAiMessageRole,
    pub content: Vec<OpenAiResponseContentPart>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum OpenAiItemStatus {
    InProgress,
    Completed,
    Incomplete,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum OpenAiMessageRole {
    Assistant,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum OpenAiResponseContentPart {
    OutputText(OpenAiOutputText),
    Refusal(OpenAiRefusal),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiOutputText {
    pub text: String,
    pub annotations: Vec<serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiRefusal {
    pub refusal: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiResponseReasoningItem {
    pub id: Option<ProviderItemId>,
    pub status: OpenAiItemStatus,
    pub summary: Vec<OpenAiReasoningSummaryPart>,
    pub encrypted_content: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiReasoningSummaryPart {
    pub text: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenAiResponseFunctionCallItem {
    pub id: Option<ProviderItemId>,
    pub status: OpenAiItemStatus,
    pub call_id: ToolCallId,
    pub name: String,
    pub arguments: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnthropicContinuation {
    pub scope: ContinuationScope,
    pub thinking_blocks: Vec<AnthropicThinkingBlock>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnthropicThinkingBlock {
    pub thinking: String,
    pub signature: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GeminiContinuation {
    pub scope: ContinuationScope,
    pub thought_signatures_base64: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BedrockContinuation {
    pub scope: ContinuationScope,
    pub reasoning_blocks: Vec<BedrockReasoningBlock>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BedrockReasoningBlock {
    pub text: Option<String>,
    pub signature: Option<String>,
    pub redacted_content_base64: Option<String>,
}
```

`OpenAiResponsesContinuation.output_items` preserves provider output order.
`response_id` is an optimization. The ordered local items are the source of
truth and MUST be sufficient to issue the next request without
`previous_response_id`. The Responses adapter MAY send `previous_response_id`
only when the provider profile explicitly enables it and the same local output
items remain available.

When the active reasoning policy requires non-empty local encrypted reasoning,
missing encrypted content is `E_CONTINUATION_MISSING` even if `response_id` is
present. A provider-managed ID never substitutes for required local replay
material.

OpenAI-compatible Chat Completions has no `ProviderContinuation` variant in
schema 2. Its visible `reasoning_content` is represented by ordered
`reasoning_summary` blocks. Hidden provider state that cannot be replayed by the
Chat Completions API MUST NOT be invented.

Continuation compatibility is exact for the initial implementation: provider
profile (including endpoint fingerprint), protocol ID, exact model ID, and
resolved model revision MUST all equal the target request. `None` revision
matches only `None`. A response ID, model-family label, name prefix, or registry
family declaration cannot relax this check. If any field differs, continuation
is incompatible.

The Anthropic, Gemini, and Bedrock variants MUST deserialize and round-trip,
but initial v2 provider code MUST NOT emit them. Receiving one for an
unsupported adapter yields `E_CONTINUATION_UNSUPPORTED`, not a lossy conversion.

### 5.7 Provider attempt and partial-output types

```rust
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ProviderAttemptPurpose {
    AssistantStep(AssistantStepPurpose),
    Compaction(CompactionPurpose),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantStepPurpose {
    pub step_id: StepId,
    pub step_index: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompactionPurpose {
    pub compaction_id: CompactionId,
    pub epoch: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialAssistantOutput {
    pub blocks: Vec<PartialAssistantBlock>,
    pub provider_response_id: Option<ProviderResponseId>,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum PartialAssistantBlock {
    Text(TextBlock),
    ReasoningSummary(ReasoningSummaryBlock),
    ToolCallFragment(PartialToolCall),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PartialToolCall {
    pub call_id: Option<ToolCallId>,
    pub name: Option<String>,
    pub raw_arguments: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ErrorClass {
    Transport,
    Timeout,
    RateLimit,
    Authentication,
    ContextLength,
    InvalidRequest,
    InvalidProviderOutput,
    Validation,
    Policy,
    NotFound,
    Conflict,
    Integrity,
    Persistence,
    Unavailable,
    Cancelled,
    ProcessCrash,
    Internal,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolError {
    pub code: String,
    pub class: ErrorClass,
    pub message: String,
    pub retryable: bool,
    pub http_status: Option<u16>,
    pub retry_after_ms: Option<u64>,
}
```

Partial output is audit data only. It MUST NOT enter accepted conversation,
compaction input, StateGraph extraction, memory plugin input, or tool execution.
Secrets in provider errors MUST be redacted before `ProtocolError` is persisted.

### 5.8 Event payloads

```rust
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionStarted {
    pub cwd: String,
    pub agent: String,
    pub config_schema_version: u32,
    pub config_digest_sha256: Sha256Digest,
    pub history_mode: HistoryMode,
    pub projection_version: ProjectionId,
    pub compaction_policy_version: String,
    pub artifact_policy_version: String,
    pub token_estimator_schema_version: u32,
    pub unicode_utility_version: String,
    pub initial_model: ModelSelection,
    pub initial_toolset_hash: Sha256Digest,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserMessageAccepted {
    pub message: UserMessage,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnStarted {
    pub turn_index: u64,
    pub user_message_id: MessageId,
    pub model: ModelSelection,
    pub toolset_hash: Sha256Digest,
    pub max_steps: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantAttemptStarted {
    pub purpose: ProviderAttemptPurpose,
    pub attempt_number: u32,
    pub model: ModelSelection,
    pub request_hash: Sha256Digest,
    pub admission: AdmissionSnapshot,
    pub retry_of: Option<AttemptId>,
    pub emergency_context_retry: bool,
    pub recovery_notices: Vec<RecoveryNotice>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantAttemptFailed {
    pub purpose: ProviderAttemptPurpose,
    pub error: ProtocolError,
    pub partial_output: PartialAssistantOutput,
    pub observable_delta_emitted: bool,
    pub provider_may_have_completed: bool,
    pub usage: ProviderUsage,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantStepAccepted {
    pub purpose: AssistantStepPurpose,
    pub message: AssistantMessage,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum SupersessionReason {
    Retry,
    EmergencyContextRetry,
    ProviderFallback,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptSuperseded {
    pub purpose: ProviderAttemptPurpose,
    pub superseded_attempt_id: AttemptId,
    pub replacement_attempt_id: AttemptId,
    pub replacement_accept_event_id: EventId,
    pub reason: SupersessionReason,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolMutability {
    ReadOnly,
    Mutating,
    Outward,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolExecutionStarted {
    pub batch_id: ToolBatchId,
    pub execution_id: ToolExecutionId,
    pub step_id: StepId,
    pub call_id: ToolCallId,
    pub call_index: u32,
    pub tool_name: String,
    pub arguments_hash: Sha256Digest,
    pub mutability: ToolMutability,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolExecutionFinished {
    pub batch_id: ToolBatchId,
    pub execution_id: ToolExecutionId,
    pub step_id: StepId,
    pub call_id: ToolCallId,
    pub call_index: u32,
    pub started_event_id: Option<EventId>,
    pub result: ToolResultMessage,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolBatchCompleted {
    pub batch_id: ToolBatchId,
    pub step_id: StepId,
    pub call_ids: Vec<ToolCallId>,
    pub result_event_ids: Vec<EventId>,
    pub result_messages_hash: Sha256Digest,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum TurnOutcome {
    Stop,
    Length,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnCommitted {
    pub turn_index: u64,
    pub user_message_id: MessageId,
    pub terminal_step_id: StepId,
    pub accepted_step_ids: Vec<StepId>,
    pub completed_batch_ids: Vec<ToolBatchId>,
    pub outcome: TurnOutcome,
    pub accepted_messages_hash: Sha256Digest,
    pub usage: ProviderUsage,
    pub recovery_notice_ids_presented: Vec<RecoveryNoticeId>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum InterruptionReason {
    UserAbort,
    ProviderFailure,
    StepLimit,
    ActiveTurnTooLarge,
    IncompatibleContinuation,
    ToolRuntimePoisoned,
    SessionShutdown,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnInterrupted {
    pub turn_index: u64,
    pub user_message_id: MessageId,
    pub reason: InterruptionReason,
    pub last_accepted_step_id: Option<StepId>,
    pub failed_attempt_id: Option<AttemptId>,
    pub uncertain_execution_ids: Vec<ToolExecutionId>,
    pub message: String,
}
```

`SessionStarted.config_schema_version` and `config_digest_sha256` MUST match the
immutable creation metadata and `config.snapshot.json` defined by the Config
specification. `SessionStarted.history_mode` and effective `history.mode` MUST
be `append` in the initial implementation. `engine` is not a schema-2
discriminant or accepted initial config value. It is only a Phase 10 future
evaluation that requires new approved config and projection contracts.

`AssistantStepAccepted.purpose` MUST equal the purpose from the envelope's
accepted `attempt_id`, and its `step_id` MUST equal `message.step_id`. A
compaction attempt never emits `AssistantStepAccepted`; successful compaction
is accepted only by `HistoryCompacted`.

`ToolExecutionFinished.started_event_id` is non-null for an invoked tool. It is
null only for `blocked`, `cancelled`, or `skipped` results whose tool body was
never invoked. An `uncertain` result always references the original durable
start. `result.recovered` is true only for a synthetic uncertain result or a
result reconstructed from a committed orphan artifact.

`ToolBatchCompleted.call_ids` is in assistant block order.
`result_event_ids[i]` is the finish event for `call_ids[i]`, regardless of the
physical completion order of tools. `result_messages_hash` hashes the ordered
tool-result message array in that same order.

`ToolResultStatus::Success` is the only status formatted as a non-error provider
result. Every other status maps to the provider's error-result form when one
exists, and its body MUST contain a stable `code`. Blocked, cancelled, and
skipped results are complete protocol results even though no body invocation
occurred.

`TurnCommitted.accepted_step_ids` and `completed_batch_ids` are complete and in
step order. `TurnCommitted.usage` is the field-wise sum of usage from every
provider attempt in the turn, including failed and superseded attempts. Missing
provider-reported categories contribute zero; estimated counts are not mixed
into this structure.

`TurnInterrupted.message` is selected exactly from this table:

| Reason | Message |
|---|---|
| `user_abort` | `Turn aborted by user before commit.` |
| `provider_failure` | `Turn stopped because no further provider attempt could produce accepted output.` |
| `step_limit` | `Turn stopped after reaching the configured assistant step limit.` |
| `active_turn_too_large` | `Turn stopped because the active turn could not fit the provider context window.` |
| `incompatible_continuation` | `Turn stopped because provider-native continuation was incompatible with the available model.` |
| `tool_runtime_poisoned` | `Turn stopped because an uncooperative tool left execution outcome uncertain and the runtime was poisoned.` |
| `session_shutdown` | `Turn stopped because the session was shut down before commit.` |

### 5.9 StateGraph payloads

The `state_changed` event payload is directly defined as `StateChangedV1` by
`RUST_V2_STATE_GRAPH_SPEC.md` section 3. Its `StateOperationV1` array, source
provenance, revisions, focus behavior, state schema version 1, checkpoint, and
projection/rendering rules are normative there. Protocol replay invokes that
owner's validator/projector and MUST NOT accept the former single
create/replace after-image shape or any alternate StateGraph payload.

`turn_index` starts at 1 and increases by one for the entire session. Reset does
not restart it. `step_index` starts at 0 within each turn. `attempt_number`
starts at 1 within each `ProviderAttemptPurpose`.

### 5.10 Compaction and control payloads

The `history_compacted` event payload is directly defined as
`HistoryCompactedV1` by `RUST_V2_COMPACTION_SPEC.md` section 11. Its nested
`SummarySegmentV1` and `HistoricalHandoffV1` are the types in that
specification's section 8. Protocol schema 2 embeds those version-1 payloads
without an alternate field set.

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ModelChangeReason {
    UserSelection,
    ProviderFallback,
    ReasoningEffortChange,
    ConfigReload,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ContinuationDisposition {
    None,
    Retained,
    DroppedIncompatible,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelChanged {
    pub from: ModelSelection,
    pub to: ModelSelection,
    pub reason: ModelChangeReason,
    pub continuation_disposition: ContinuationDisposition,
    pub handoff: HistoricalHandoffV1,
    pub toolset_hash: Sha256Digest,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetBoundary {
    pub reset_epoch: u32,
    pub command: String,
    pub reason: Option<String>,
    pub clears_state: bool,
    pub previous_turn_id: Option<TurnId>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum NoteLevel {
    Info,
    Warning,
    Error,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum NoteAudience {
    Audit,
    User,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemNote {
    pub code: String,
    pub level: NoteLevel,
    pub audience: NoteAudience,
    pub message: String,
    pub references: Vec<EventId>,
    pub details: std::collections::BTreeMap<String, serde_json::Value>,
}
```

`ModelChangeReason::ConfigReload` is reserved and MUST be rejected by initial
schema-v1 producers. Config schema v1 freezes session-semantic config at
creation, has no live reload/file watcher, and `session.new` creates a different
canonical session rather than appending this event.

`ContinuationDisposition::None` means no active opaque continuation existed.
`DroppedIncompatible` means an interrupted prior active cycle had persisted
continuation that cannot match `to`. `Retained` is reserved and MUST be rejected
in the initial implementation because model change during an active compatible
tool cycle is not allowed.

`SystemNote` has no protocol-changing semantics. It is excluded from accepted
conversation and model-visible history. Implementations MUST use a dedicated
event kind for state, model, reset, compaction, attempt, tool, or turn changes
rather than encoding those changes in `SystemNote.details`.

## 6. Envelope Context Matrix

The following matrix defines required envelope references. `required` means a
non-null value; `null` means JSON null; `purpose` means determined by the
provider attempt purpose.

| Event kind | `turn_id` | `attempt_id` |
|---|---:|---:|
| `session_started` | null | null |
| `user_message_accepted` | required | null |
| `turn_started` | required | null |
| `assistant_attempt_started` | required for assistant step, null for compaction | required |
| `assistant_attempt_failed` | required for assistant step, null for compaction | required |
| `assistant_step_accepted` | required | required |
| `attempt_superseded` | required for assistant step, null for compaction | null |
| `tool_execution_started` | required | accepted source attempt |
| `tool_execution_finished` | required | accepted source attempt |
| `tool_batch_completed` | required | accepted source attempt |
| `turn_committed` | required | null |
| `turn_interrupted` | required | null |
| `state_changed` | current turn and attempt when caused by a tool, otherwise null | source attempt when caused by a tool, otherwise null |
| `history_compacted` | null | accepted compaction attempt |
| `model_changed` | null, except an initial-attempt fallback | null |
| `reset_boundary` | null | null |
| `system_note` | related turn or null | related attempt or null |

Any matrix violation is `E_EVENT_CONTEXT_INVALID`. Each envelope introduces its
own unique `event_id`. All other ID introduction and reference rules are exact:

| Event kind | IDs introduced by this event | Required references |
|---|---|---|
| `session_started` | Envelope `session_id` establishes the session | None |
| `user_message_accepted` | Envelope `turn_id`; `message_id` | Message's `turn_id` equals the same-event envelope ID |
| `turn_started` | None | Earlier turn and user message |
| `assistant_attempt_started` | Envelope `attempt_id`; first assistant purpose introduces `step_id`; first compaction purpose introduces `compaction_id`; newly derived recovery notice IDs | Earlier turn for assistant purpose; `retry_of` and recovery source events are earlier when present |
| `assistant_attempt_failed` | None | Open attempt and its previously introduced purpose IDs |
| `assistant_step_accepted` | Assistant `message_id`; provider tool-call and provider item IDs | Open attempt, step, and turn |
| `attempt_superseded` | None | Both attempts and replacement acceptance event are earlier |
| `tool_execution_started` | `execution_id`; `batch_id` on its first event | Accepted step, call, turn, and source attempt |
| `tool_execution_finished` | Result `message_id`; `execution_id` and `batch_id` only when no start exists | Accepted call and batch; non-null start event is earlier; artifact ID must already be committed in `history.db` |
| `tool_batch_completed` | None | Batch, step, every call, and every finish event are earlier |
| `turn_committed` | None | Turn, user message, terminal/accepted steps, and completed batches are earlier |
| `turn_interrupted` | None | Turn and every optional attempt/step/execution reference are earlier |
| `state_changed` | `mutation_id` and IDs in `create` operations | Source event is earlier; other operation references are earlier except a later operation may reference an ID created by an earlier operation in the same atomic array, as StateGraph specifies |
| `history_compacted` | Segment and handoff IDs allocated for this accepted candidate | Compaction ID, attempt-start event, source turns/events, prior lineage, artifact rows, and StateGraph IDs already exist as required by Compaction |
| `model_changed` | Model-switch handoff ID | Evidence/source IDs in the handoff are earlier |
| `reset_boundary` | None | Optional previous turn is earlier |
| `system_note` | None | Every event reference is earlier |

An ID reservation in memory is not introduction. Same-event references are
legal only where the table explicitly says so. Artifact IDs are introduced by
the committed canonical artifact row under History Storage's artifact-before-
event rule. Provider-owned tool-call/item IDs are introduced only by an accepted
assistant step and are never synthesized. Every other forward reference fails
with `E_REFERENCE_UNKNOWN`.

## 7. Event Payload Field Summary

This table is a compact implementation index. The Rust definitions remain the
type authority.

| Event kind | Required payload meaning |
|---|---|
| `session_started` | Config schema/digest, runtime versions, initial provider/model, cwd, append mode, and initial toolset hash. |
| `user_message_accepted` | Complete canonical user message. This is the user admission durability point. |
| `turn_started` | Turn ordinal, admitted user message, effective model/toolset, and step limit. |
| `assistant_attempt_started` | Purpose, fresh attempt number, exact target, request hash, admission calculation, retry link, and request recovery notices. |
| `assistant_attempt_failed` | Stable error, all aggregated partial audit output, emission uncertainty, and usage. |
| `assistant_step_accepted` | Complete ordered assistant message and its assistant-step purpose. |
| `attempt_superseded` | Failed old attempt, accepted replacement, accepting event, and reason. |
| `tool_execution_started` | Batch/execution/call identity, call order, name, arguments hash, and mutability. |
| `tool_execution_finished` | Exact call identity, optional start event, and final post-hook result message. |
| `tool_batch_completed` | Assistant call order, matching finish events, and ordered result hash. |
| `turn_committed` | Entire accepted step/batch set, terminal step, outcome, conversation hash, usage, and notices shown. |
| `turn_interrupted` | Explicit non-commit terminal status with failure and uncertain-execution references. |
| `state_changed` | Exact StateGraph schema-1 atomic operation payload and provenance from the StateGraph specification. |
| `history_compacted` | Exact compaction schema-1 source, summary, handoff, hashes, strategy, and admission metadata from the Compaction specification. |
| `model_changed` | Complete old/new model scopes, reason, continuation disposition, switch handoff, and target toolset. |
| `reset_boundary` | New reset epoch, command/reason, state-clearing fact, and prior turn. |
| `system_note` | Audit/user notice only; never a hidden protocol mutation. |

## 8. Event Ordering and Durability

### 8.1 Session log invariants

For one session log:

1. `session_started` is sequence 1 and appears exactly once.
2. Every envelope `session_id` equals the session directory ID.
3. `sequence` starts at 1 and increments by exactly 1. Gaps, repeats, zero, and
   reordering are integrity failures.
4. `event_id` is unique across the session. Payload-local IDs obey the ownership
   and uniqueness rules in this specification.
5. Timestamps are metadata. Decreasing or equal timestamps are valid.
6. A valid canonical event is never rewritten or removed.
7. A derived database row or checkpoint is never ordering authority.
8. Replay validates the complete longest valid event prefix before exposing a
   writable session.
9. Only one process may hold the session writer lock. A second writer fails
   with `E_SESSION_LOCKED`.
10. Event acknowledgement to the orchestrator or UI occurs only after `fsync`
    succeeds.

### 8.2 Append algorithm

The event writer MUST execute this algorithm under the exclusive session lock:

```text
append(payload, context, reserved_event_id = none):
    assert writer is healthy
    sequence = last_sequence + 1
    event_id = reserved_event_id or monotonic_ulid(clock.now_ms())
    assert event_id has not appeared in the log
    envelope = validate_and_build(sequence, event_id, payload, context)
    bytes = compact_json(envelope) + LF
    write_all(O_APPEND_file, bytes)
    flush_user_space_buffer()
    fsync(file)
    if fsync failed:
        mark writer unhealthy
        return E_EVENT_DURABILITY_UNCERTAIN
    update in-memory replay state using the exact envelope
    acknowledge envelope
```

The session directory is created with mode `0700` on Unix. `events.jsonl`,
`history.db`, `meta.json`, and the Config-owned `config.snapshot.json` are
created with mode `0600`. Existing broader permissions are an explicit warning
and are tightened when ownership permits.
After first creating or renaming a session file, the parent directory MUST also
be fsynced before create-session success is acknowledged.

If write or fsync returns an error, the process MUST stop appending. It MUST NOT
retry the logical event with a new event ID. Recovery reopens and scans the
file. If the complete event is present it is retained; if only a malformed
final fragment is present it is quarantined as specified in Section 14.

### 8.3 Per-event preconditions and effects

| Event | Required earlier state | Durable effect |
|---|---|---|
| `session_started` | Empty newly locked log | Opens reset epoch 0 and establishes initial model/toolset. |
| `user_message_accepted` | No active turn | Creates a new turn and permanently admits one user message. |
| `turn_started` | Matching admitted user, no prior start | Fixes turn index, model, toolset, and step limit. |
| `assistant_attempt_started` | Started turn awaiting a step, or a frozen eligible compaction source snapshot plus an admitted internal request | Records request before any network bytes are sent; no candidate exists yet. |
| `assistant_attempt_failed` | Matching open attempt | Closes attempt as failed; partial output remains audit-only. |
| `assistant_step_accepted` | Matching open assistant attempt with complete valid output | Makes assistant step eligible for accepted conversation. |
| `attempt_superseded` | Old attempt failed; replacement has a durable acceptance event | Records replacement relation only. |
| `tool_execution_started` | Accepted tool-using step and permitted pre-hook result | Records execution immediately before body invocation. |
| `tool_execution_finished` | Matching call; post-hooks/redaction complete; artifact committed if referenced | Adds exactly one final result for the call. |
| `tool_batch_completed` | Every call has one durable finish | Makes the assistant call/result group protocol-complete. |
| `turn_committed` | Terminal accepted step and every earlier tool batch complete | Makes the outer turn committed and compaction-eligible. |
| `turn_interrupted` | Active, uncommitted turn | Closes the turn without inventing assistant completion. |
| `state_changed` | Session active; valid revision predecessor | Changes reconstructible current state. |
| `history_compacted` | Open compaction attempt whose later candidate passed schema/provenance/bounds validation against the still-unchanged frozen source | Atomically activates segment, handoff, and turn retirement. |
| `model_changed` | No active tool cycle; narrow fallback exception below | Changes provider/model/reasoning boundary and switch handoff. |
| `reset_boundary` | No active turn | Starts next reset epoch and clears visible history/current state. |
| `system_note` | Session started | Adds audit/user information and no protocol state. |

### 8.4 Provider and tool external-action boundaries

`assistant_attempt_started` MUST be durable before opening the HTTP request or
writing any request body bytes. A pre-emission HTTP retry is a new canonical
attempt, not an invisible loop inside one attempt.

The tool pipeline order is:

```text
plan -> validation -> risk -> circuit -> write-path acquire
     -> tool body
     -> LSP -> verify -> enrich -> redact -> circuit accounting
     -> write-path release -> artifact decision/commit
```

For one batch, pre-hooks run in assistant call order. Calls blocked before body
invocation receive a `tool_execution_finished` event with `started_event_id =
null`; they do not receive a start event. For every permitted call, all
`tool_execution_started` events are appended in assistant call order before any
tool body in that batch is invoked. Permitted bodies then run concurrently.

Finish events MAY appear in physical completion order. This is the only
nondeterministic event order allowed inside a batch. Projection and provider
formatting MUST reorder results by `call_index` and validate the ordered mapping
against `tool_batch_completed`.

StateGraph-mutating tool calls are the concurrency exception. They enter one
per-session StateGraph mutation queue in accepted provider call order. A queued
call snapshots `expected_graph_sequence` and every implicit convenience-tool
revision only after all earlier ordered StateGraph mutations have committed.
The queue then holds the session writer while validating and appending that
mutation. A later state call is not allowed to capture a stale parallel snapshot
and fail merely because an earlier call in the same accepted batch committed.
Explicit caller-supplied revisions are still validated at dequeue time and may
conflict. The StateGraph specification owns the full queue contract.

Write-path locks are released by the final post-tool hook, before artifact
finalization and event append, on success, error, cancellation, and panic
conversion. Redaction occurs before artifact storage and before
`tool_execution_finished`. A panic is converted to a normal error result and
MUST NOT cross the tool boundary.

### 8.5 Artifact durability

For an artifactized result:

1. Finish the full post-tool pipeline through redaction.
2. Deterministically serialize the complete result.
3. Build the immutable preview and all artifact metadata.
4. In one SQLite transaction, insert the artifact body and metadata and commit.
5. Only after commit succeeds, append and fsync `tool_execution_finished` with
   the reference.
6. Only after every finish is durable, append and fsync `tool_batch_completed`.

SQLite uses WAL mode, `synchronous=FULL`, foreign keys enabled, and a bounded
busy timeout. An event MUST never reference an artifact transaction that has
not committed. An unreferenced committed artifact is an orphan and MAY be
garbage-collected only after canonical replay and History Storage recovery have
first resolved every matching durable started execution as an exact recovered
finish or an uncertain finish. IPC clients and UI lifecycle code have no
artifact garbage-collection authority.

## 9. Formal State Machines

Each transition not explicitly allowed by a table is invalid and returns
`E_EVENT_TRANSITION_INVALID` unless a more specific code is listed. Invalid
events are never appended. An invalid event encountered during replay is an
integrity failure and makes the session read-only.

### 9.1 Session controller

| Current state | Input | Guard | Next state | Action/error |
|---|---|---|---|---|
| `Absent` | create | Directory can be locked and log is empty | `Ready` | Append `session_started`. |
| `Absent` | resume | Valid existing log | `Ready` or `TurnOpen` | Replay and recover incomplete tail. |
| `Ready` | submit user | No shutdown in progress | `TurnOpen` | Append user acceptance then turn start. |
| `Ready` | change model | Target resolves and admits current history | `Ready` | Append `model_changed`. |
| `Ready` | reset | Always | `Ready` | Append `reset_boundary`. |
| `Ready` | detach/end process | Always | `Detached` | Flush derived stores; no canonical terminal event is required. |
| `TurnOpen` | commit/interruption | Matching active turn | `Ready` | Append terminal turn event. |
| `TurnOpen` | submit user | Never | `TurnOpen` | `E_TURN_ALREADY_ACTIVE`. |
| `TurnOpen` | reset | Never | `TurnOpen` | `E_RESET_DURING_TURN`. |
| `TurnOpen` | change model | Only initial fallback guard in Section 12.2 | `TurnOpen` | Otherwise `E_MODEL_CHANGE_DURING_TURN`. |
| `TurnOpen` | uncooperative side-effect-capable tool timeout | Durable start and cleanup cannot prove termination | `Poisoned` | Append uncertain finish/turn interruption when possible, then shut down. |
| `Detached` | resume | Valid lock and log | `Ready` or `TurnOpen` | Replay; detached is process state, not durable closure. |
| `Poisoned` | any provider/tool/session mutation | Never | `Poisoned` | Reject and continue controlled process shutdown. |
| any | integrity failure | Replay or storage validation failed | `IntegrityFailed` | No writes; return exact integrity code. |
| `IntegrityFailed` | any mutation | Never | `IntegrityFailed` | `E_SESSION_INTEGRITY_FAILED`. |

A session may be resumed after a normal process exit. There is deliberately no
`session_ended` canonical event in schema 2.
`Poisoned` is a process-runtime state, not a durable permanent session flag. A
new process must complete normal uncertain-execution and operational-file
recovery before the session can become writable again.

Whole-session deletion is outside the canonical event state machine. History
Storage acquires the writer lock, closes durable handles, and atomically renames
the complete session directory into its external trash namespace. That rename
is the deletion boundary. No deletion-intent, session-ended, or tombstone event
is appended to the session being deleted.

### 9.2 Outer turn

| Current state | Event/input | Next state | Required checks |
|---|---|---|---|
| `None` | `user_message_accepted` | `UserAccepted` | New turn ID; exactly one message; next turn index. |
| `UserAccepted` | `turn_started` | `AwaitingStep` | Same turn/message; fixed model/toolset/max steps. |
| `UserAccepted` | recovery after crash | `AwaitingStep` | Append missing `turn_started` with original effective settings. |
| `AwaitingStep` | attempt starts | `AttemptOpen` | Next step ID/index and fresh attempt ID. |
| `AttemptOpen` | attempt fails | `AwaitingRetryOrInterrupt` | No tool execution from partial output. |
| `AwaitingRetryOrInterrupt` | retry starts | `AttemptOpen` | Bounded retry policy and `retry_of` link. |
| `AwaitingRetryOrInterrupt` | `turn_interrupted` | `Interrupted` | Failure reason retained. |
| `AttemptOpen` | terminal step accepted | `TerminalAccepted` | Finish is `stop` or `length`; no tool calls. |
| `AttemptOpen` | tool step accepted | `ToolBatchPending` | Finish is `tool_use`; one or more valid calls. |
| `ToolBatchPending` | batch completes | `AwaitingStep` | All calls have one ordered result. |
| `TerminalAccepted` | `turn_committed` | `Committed` | Step/batch lists and conversation hash match projection. |
| any nonterminal active state | `turn_interrupted` | `Interrupted` | No incomplete result is made accepted. |
| `Committed` or `Interrupted` | event using same turn as active mutation | invalid | `E_TURN_ALREADY_TERMINAL`. |

`Committed` and `Interrupted` are both terminal, but only `Committed` is eligible
for normal compaction. A terminal accepted step found without a commit after a
crash is deterministically committed during recovery; this does not invent
provider output because the complete accepted step is already durable.

### 9.3 Provider attempt

| Current state | Input/event | Next state | Action/error |
|---|---|---|---|
| `Planned` | append `assistant_attempt_started` | `Started` | Fsync before network. |
| `Started` | receive valid stream data | `Streaming` | Emit ephemeral UI deltas only. |
| `Started` or `Streaming` | complete valid assistant output | `Accepted` | Append `assistant_step_accepted`. |
| `Started` or `Streaming` | complete valid compaction output | `Accepted` | Append `history_compacted` after source validation. |
| `Started` or `Streaming` | provider/parse/cancel failure | `Failed` | Append `assistant_attempt_failed`. |
| `Started` or `Streaming` | process disappears | `Orphaned` | Resume appends failed event with `E_ATTEMPT_LOST`. |
| `Failed` | new bounded attempt starts | `FailedWithReplacementPending` | New attempt ID and `retry_of`; retry guard in Section 12.1 passes. |
| `FailedWithReplacementPending` | replacement accepted | `Superseded` | Append `attempt_superseded` after acceptance. |
| `Accepted` | retry | invalid | `E_PROVIDER_RETRY_AFTER_ACCEPTANCE`. |
| `Accepted` | fail event | invalid | `E_ATTEMPT_ALREADY_TERMINAL`. |
| `Failed` | accept same attempt | invalid | `E_ATTEMPT_ALREADY_TERMINAL`. |

An attempt is retried automatically only after it is durably failed and no
observable text, reasoning, refusal, tool-call, or tool-argument delta was
emitted. Retry after observable emission is forbidden. It returns
`E_PROVIDER_RETRY_AFTER_EMISSION` and the turn is interrupted. No tool call from
a failed attempt is executable, whether or not a delta was shown.

### 9.4 Assistant step

| Current state | Input/event | Next state | Action/error |
|---|---|---|---|
| `Planned` | attempt starts | `Attempting` | Bind step ID/index to purpose. |
| `Attempting` | attempt fails | `Planned` | Same step may receive bounded fresh attempt. |
| `Attempting` | accepted `stop`/`length` message | `TerminalAccepted` | Eligible for turn commit. |
| `Attempting` | accepted `tool_use` message | `ToolAccepted` | Create exactly one tool batch. |
| `ToolAccepted` | batch complete | `ContinuationReady` | Next provider request includes ordered results. |
| `ContinuationReady` | next step attempt starts | `Closed` | Active continuation is admitted if compatible. |
| any accepted state | second accepted attempt for same step | invalid | `E_STEP_ALREADY_ACCEPTED`. |
| `ToolAccepted` | provider continuation before batch complete | invalid | `E_TOOL_BATCH_INCOMPLETE`. |

Step indexes start at zero and increment by one per accepted assistant step.
Retries retain the same step ID and step index but always use a new attempt ID.

### 9.5 Tool batch

| Current state | Input/event | Next state | Action/error |
|---|---|---|---|
| `Declared` | pre-hooks begin | `Preparing` | Process calls in assistant order. |
| `Preparing` | starts for all permitted calls durable | `Running` | Invoke permitted calls concurrently. |
| `Preparing` | all calls blocked/skipped with finishes | `ResultsDurable` | No tool body invoked. |
| `Running` | one finish durable | `Running` or `ResultsDurable` | Match by call ID and execution ID. |
| `ResultsDurable` | `tool_batch_completed` | `Completed` | Validate call-order vectors and hash. |
| `Declared` through `Running` | process crash | `Recovering` | Apply Section 13, never guess a result. |
| `Completed` | additional finish/completion | invalid | `E_TOOL_BATCH_ALREADY_COMPLETE`. |
| any | unknown/duplicate result | invalid | `E_TOOL_RESULT_CALL_MISMATCH` or `E_TOOL_RESULT_DUPLICATE`. |

The batch is not provider-visible until `tool_batch_completed` is durable. Error,
blocked, cancelled, uncertain, and skipped results all count as protocol
results and can complete a batch.

### 9.6 Tool execution

| Current state | Input/event | Next state | Action/error |
|---|---|---|---|
| `Declared` | pre-hook blocks | `Finished` | Append blocked finish with null start. |
| `Declared` | cancelled before invoke | `Finished` | Append cancelled finish with null start. |
| `Declared` | skip due to uncertain mutating peer | `Finished` | Append skipped finish with null start. |
| `Declared` | append start | `Started` | Start references accepted call. |
| `Started` | invoke body | `Running` | All permitted starts in batch are already durable. |
| `Running` | body returns/panics/cancels | `PostProcessing` | Convert panic/error to result. |
| `PostProcessing` | post-hooks through write-lock release complete | `FinalizingResult` | Result is enriched and redacted; select inline/artifact storage. |
| `FinalizingResult` | artifact commit, if any, and finish append complete | `Finished` | Append finish only after artifact commit. |
| `Started`, `Running`, `PostProcessing`, or `FinalizingResult` | process crash | `Uncertain` | Do not rerun automatically. |
| `Uncertain` | orphan artifact cryptographically proves finalized result and exact source identity | `Finished` | Reconstruct exact finish, `recovered=true`, and issue notice. |
| `Uncertain` | no finalized artifact | `Finished` | Append synthetic uncertain error result and issue notice. |
| `Finished` | any second start/finish | invalid | `E_TOOL_EXECUTION_ALREADY_TERMINAL`. |

The synthetic uncertain result has status `uncertain`, media type
`application/json`, and canonical body:

```json
{"code":"E_TOOL_SIDE_EFFECT_UNCERTAIN","error":"The process stopped after this tool was marked started. Its side effects are unknown. Do not repeat the mutation until state has been inspected.","ok":false}
```

If one uncertain execution is mutating or outward, every not-yet-started call in
the same batch is completed as `skipped` without running pre-hooks or bodies.
Its canonical body is:

```json
{"code":"E_TOOL_SKIPPED_UNCERTAIN_PEER","error":"Skipped because another call in the parallel batch has uncertain side effects.","ok":false}
```

If all uncertain peers are read-only, not-yet-started calls resume through the
normal pre-tool pipeline. An already-started read-only tool is still not
automatically rerun; it receives an uncertain result.

## 10. Stable Error Codes

Codes are stable machine identifiers. Human messages may add context but MUST
NOT change the code selected by these conditions.
This table covers protocol-native event/state-machine conditions. Appendix A
defines the complete normative mapping for provider, tool, History,
admission/compaction, StateGraph, token-accounting, and IPC domain codes,
including canonical boundary codes not raised by the event replay reducer.

| Code | Condition |
|---|---|
| `E_SCHEMA_VERSION_UNSUPPORTED` | Envelope schema is not 2. |
| `E_EVENT_SCHEMA_INVALID` | JSON is syntactically valid but violates an exact DTO or scalar validation. |
| `E_EVENT_TOO_LARGE` | Canonical event JSON exceeds 16,777,216 bytes before LF. |
| `E_JSONL_FINAL_TRUNCATED` | Final non-empty line is malformed and has been quarantined. Recoverable warning. |
| `E_JSONL_NON_FINAL_MALFORMED` | A malformed line has bytes after its line terminator. Fatal integrity error. |
| `E_JSONL_SEQUENCE_GAP` | Sequence is greater than expected. |
| `E_JSONL_SEQUENCE_DUPLICATE` | Sequence is less than expected or repeated. |
| `E_EVENT_ID_DUPLICATE` | Event ID was already observed. |
| `E_SESSION_ID_MISMATCH` | Envelope session differs from directory/session. |
| `E_EVENT_CONTEXT_INVALID` | Envelope turn/attempt presence violates Section 6. |
| `E_EVENT_TRANSITION_INVALID` | Event is not legal in current state and no narrower code applies. |
| `E_REFERENCE_UNKNOWN` | Event references an ID not introduced earlier. |
| `E_REFERENCE_DUPLICATE` | Event introduces an already-owned local ID. |
| `E_SESSION_LOCKED` | Another writer owns the session lock. |
| `E_SESSION_NOT_STARTED` | Session directory has no valid sequence-1 `session_started` event. |
| `E_SESSION_INTEGRITY_FAILED` | Mutation attempted after replay integrity failure. |
| `E_EVENT_DURABILITY_UNCERTAIN` | Event write or fsync failed after append began. |
| `E_TURN_ALREADY_ACTIVE` | New user submitted while a turn is active. |
| `E_TURN_ALREADY_TERMINAL` | Event attempts to continue a committed/interrupted turn. |
| `E_RESET_DURING_TURN` | Reset requested with an active turn. |
| `E_MODEL_CHANGE_DURING_TURN` | Model change violates the initial-fallback exception. |
| `E_PROVIDER_RETRY_AFTER_ACCEPTANCE` | Retry requested after accepted output. |
| `E_ATTEMPT_ALREADY_TERMINAL` | Event attempts to change a failed/accepted attempt. |
| `E_ATTEMPT_LOST` | Recovery found a durable attempt start without terminal event. |
| `E_STEP_ALREADY_ACCEPTED` | More than one accepted attempt targets one step. |
| `E_PROVIDER_STREAM` | Provider stream failed without a narrower class. |
| `E_PROVIDER_TIMEOUT` | Provider request or stream exceeded deadline. |
| `E_PROVIDER_RATE_LIMIT` | Provider returned rate limiting. |
| `E_PROVIDER_AUTH` | Provider rejected credentials/authorization. |
| `E_PROVIDER_CONTEXT_LENGTH` | Provider rejected request context length. |
| `E_PROVIDER_RETRY_AFTER_EMISSION` | Automatic retry was requested after any observable output. |
| `E_PROVIDER_RETRY_EXHAUSTED` | The purpose reached its configured attempt limit. |
| `E_PROVIDER_OUTPUT_UNSUPPORTED` | Initial driver received an unsupported output item/type. |
| `E_PROVIDER_CONTENT_FILTER` | Provider terminated or refused the response through a content filter rather than producing an accepted assistant step. |
| `E_TOOL_CALL_FRAGMENT_INVALID` | Fragment indexes/IDs/names conflict or cannot be accumulated. |
| `E_TOOL_CALL_ID_MISSING` | Completed provider tool call has no non-empty provider call ID. |
| `E_TOOL_CALL_ID_REUSED` | Provider reused a session tool-call ID. |
| `E_TOOL_ARGUMENTS_INVALID` | Completed tool arguments are not one valid JSON object. |
| `E_TOOL_UNKNOWN` | Accepted call names no registered tool. |
| `E_TOOL_VALIDATION` | Tool arguments fail the registered schema or pre-validation. |
| `E_TOOL_BLOCKED` | Plan, risk, circuit, or policy hook blocks invocation. |
| `E_TOOL_CANCELLED` | Tool is cancelled before or during invocation. |
| `E_TOOL_EXECUTION` | Tool body or post-tool processing fails without a narrower code. |
| `E_CONTINUATION_INCOMPATIBLE` | Active continuation scope differs from target. |
| `E_CONTINUATION_UNSUPPORTED` | Runtime cannot format the continuation variant. |
| `E_CONTINUATION_MISSING` | Tool-using Responses output omitted required local reasoning continuation data. |
| `E_TOOL_BATCH_INCOMPLETE` | Provider request/commit attempted before complete batch. |
| `E_TOOL_BATCH_ALREADY_COMPLETE` | Event mutates completed batch. |
| `E_TOOL_RESULT_CALL_MISMATCH` | Result IDs/name/index do not match accepted call. |
| `E_TOOL_RESULT_DUPLICATE` | A call receives more than one finish. |
| `E_TOOL_EXECUTION_ALREADY_TERMINAL` | Start/finish follows a final execution result. |
| `E_TOOL_SIDE_EFFECT_UNCERTAIN` | Durable start has no durable final result. |
| `E_TOOL_SKIPPED_UNCERTAIN_PEER` | Unstarted parallel call is skipped due to uncertain mutating peer. |
| `E_ARTIFACT_MISSING` | A durable event references no committed artifact row. |
| `E_ARTIFACT_HASH_MISMATCH` | Artifact bytes do not match reference metadata. |
| `STATE_PROJECTION_INTEGRITY` | StateGraph owner rejected a canonical state payload or replay transition. |
| `E_COMPACTION_RANGE_INVALID` | Source range or retired turns violate compaction rules. |
| `E_COMPACTION_SOURCE_HASH_MISMATCH` | Range bytes do not match source hash. |
| `E_COMPACTION_EPOCH_INVALID` | Reset/compaction epoch is not the required successor. |
| `E_ACTIVE_TURN_TOO_LARGE` | Active turn alone cannot fit after hard-ceiling policy. |

## 11. Accepted Conversation Projection

### 11.1 Projection inputs and outputs

Projection is pure over:

- One fully validated event snapshot ending at a durable sequence.
- Event schema version 2 and projection version `rust-v2-projection-1`.
- The effective target `ModelSelection` and provider capability profile.
- The deterministic stable policy/project/tool prefix.
- A reconstructible StateGraph snapshot at the same ending sequence.

Clock time, file modification time, UI state, provider availability, and
derived index row order are not projection inputs.

Cross-session memory is deliberately not an input to
`ConversationProjection`: enabling a plugin cannot change accepted-history
semantics. The request assembler may additionally receive one validated,
bounded `MemoryBootstrap.digest` from Memory API/DTO version 1. It remains a
separate non-authoritative request component, is absent for `plugin = "none"`,
and is never persisted as a canonical conversation message.

The projector returns:

```rust
pub struct ConversationProjection {
    pub reset_epoch: u32,
    pub through_sequence: u64,
    pub active_handoff: Option<HistoricalHandoffV1>,
    pub messages: Vec<ConversationMessage>,
    pub current_state: StateGraphV1,
    pub active_turn: Option<TurnId>,
    pub pending_recovery: Vec<RecoveryNotice>,
    pub active_continuation: Option<ProviderContinuation>,
    pub compacted_turn_ids: Vec<TurnId>,
}
```

`HistoricalHandoffV1` and `StateGraphV1` are imported from their owner specs.
`messages` is accepted portable user/assistant/tool-result conversation only.
Handoff, StateGraph, memory bootstrap, and recovery control remain separate
projected inputs so a provider adapter cannot mistake them for accepted user
history.

### 11.2 Accepted turn projection rules

For each turn after the most recent reset boundary:

- A committed, non-retired turn contributes its user message, then each
  accepted assistant step in step-index order.
- A tool-using step contributes its assistant message followed immediately by
  exactly one tool-result message per call in assistant block order. It
  contributes nothing unless its batch is durable and protocol-complete.
- A terminal step contributes its assistant message and must be the final
  assistant step in a committed turn.
- The current in-flight turn contributes its user message and every completed
  accepted assistant/tool cycle. It contributes a terminal accepted assistant
  step even if recovery has not yet appended the derivable commit.
- An interrupted turn contributes its accepted user message and every complete
  accepted cycle before interruption. A derived `turn_interrupted` notice is
  returned in `pending_recovery`, not inserted into `messages`. Failed partial
  provider output is excluded.
- A user message admitted before a crash remains accepted. Recovery starts its
  missing `turn_started` record rather than dropping or duplicating it.

Failed attempts and their partial blocks, supersession records, incomplete tool
groups, system notes, UI deltas, and tool executions not linked to an accepted
step are excluded.

### 11.3 Compaction projection rules

Within the active reset epoch, process valid `history_compacted` events in epoch
order. Maintain the union of each exact `HistoryCompactedV1.source_turn_ids`;
duplicate retirement is an integrity error. The active handoff is replaced by
each newer handoff, so only the latest is model-visible. All immutable summary
segments remain stored and searchable but are not concatenated into the prompt.

Retired source events remain canonical and searchable. Retirement affects only
normal model-visible recent messages and compaction eligibility. StateGraph
mutation replay is never suppressed because its event lies inside a compacted
source range.

If compaction generation or validation failed, no `history_compacted` event
exists and the prior projection remains active. A compaction attempt start or
failure alone changes no conversation.

### 11.4 Projection pseudocode

```text
project(events, target_model):
    validate_complete_event_stream(events)

    boundary = last reset_boundary, or virtual epoch 0 before sequence 1
    scoped = events strictly after boundary.sequence
    reset_epoch = boundary.reset_epoch, or 0

    state = empty StateGraph
    turns = ordered map by turn_index
    attempts = map
    batches = map
    retired = ordered set
    active_handoff = none

    for event in events in sequence order:
        apply global integrity and state-machine validation

        if event is reset_boundary:
            clear state, turns, attempts, batches, retired, active_handoff
            continue

        if event is state_changed and event is after active boundary:
            apply StateChangedV1 atomically using the StateGraph owner rules

        if event is history_compacted and event.reset_epoch == reset_epoch:
            validate exact HistoryCompactedV1 through the compaction owner
            retired.add_all(event.source_turn_ids)
            active_handoff = event.handoff

        apply event to turn/attempt/batch maps

    messages = []

    for turn in turns ordered by turn_index:
        if turn.id in retired:
            continue
        if turn is neither committed nor interrupted nor current active:
            continue only if recovery has not yet made it resumable

        messages.push(User(turn.user_message))

        for step in turn.accepted_steps ordered by step_index:
            if step.finish_reason == tool_use:
                batch = exact batch for step
                if batch is not completed:
                    if turn is current active:
                        stop before this step and report recovery required
                    else:
                        fail E_TOOL_BATCH_INCOMPLETE
                messages.push(Assistant(portable(step.message, no opaque filter yet)))
                for call in step.tool_calls in block order:
                    messages.push(ToolResult(batch.result_for(call.call_id)))
            else:
                messages.push(Assistant(portable(step.message, no opaque filter yet)))

    continuation = continuation from the last accepted tool-using step
                   only if that step is the active incomplete tool cycle
                   and continuation_compatible(continuation, target_model)

    pending_recovery = deterministic notices from replay recovery records
    return projection
```

`portable` retains continuation in the returned canonical message for audit.
Provider request formatting strips continuation from every message except the
single active tool cycle selected in `active_continuation`.

### 11.5 Model-visible request layout

The logical authority/component order is:

```text
1. Stable provider-specific system policy.
2. Stable project instructions and environment facts.
3. Optional cross-session memory bootstrap.
4. Stable tool schemas in Tool Runtime catalog order.
5. One active historical handoff, if any.
6. Retained accepted real conversation messages.
7. Volatile current StateGraph and recovery-control data.
8. Latest user message or active tool-cycle continuation.
```

This order defines logical authority and projection inputs, not literal wire
roles or field placement. User/tool/handoff/memory/current-state data never
becomes policy authority merely because an API has limited roles. Provider
adapters preserve the Tool Runtime catalog order without sorting by name.
Compaction owns handoff rendering. The OpenAI specification exclusively owns
how all five OpenAI instruction components are combined and placed.

Recovery notices use one generated control container after current state:

```text
PRAANA RECOVERY CONTROL
These records describe durable recovery state. Follow each REQUIRED ACTION before a dependent mutation.
NOTICE <notice_id> <kind>
MESSAGE
| <each message line, with this prefix>
REQUIRED ACTION
| <each required-action line, with this prefix>
END NOTICE
```

Notices are ordered by first source event sequence, with truncated-tail notices
first because they have no source event. Message and action lines use the same
LF split and `| ` quoting rule. This protocol defines the recovery-control
content, but not a provider role. OpenAI includes it inside the `CurrentState`
instruction component as defined by the OpenAI specification. The stable policy
states that only the fixed `REQUIRED ACTION` wrapper is control authority;
quoted message data is not instruction authority.

## 12. Provider Protocol Rules

### 12.1 Retry and supersession

A provider retry always uses a new `AttemptId` and a new
`assistant_attempt_started` event. `attempt_number` starts at 1 for a purpose
and increments without gaps. `retry_of` points to the immediately preceding
failed attempt for that purpose.

Retry is permitted only when all of these are true:

- The prior attempt has a durable failure record.
- No assistant step or compaction was accepted from the prior attempt.
- No tool call from the prior attempt was executed.
- `observable_delta_emitted` is false.
- The bounded retry policy permits another request.
- A fresh request admission decision has run for the new attempt and effective
  model/profile.

The effective `turn.max_attempts` from the Config specification bounds attempts
for one purpose and includes the initial attempt. Schema v1 allows at most three.
Provider specifications classify their
retryable transport/status failures and own delay, jitter, and retry-hint
handling. Invalid provider output, malformed tool calls, authentication
failure, and cancellation are not retried. A context-length error allows at
most one emergency retry and still counts toward the three-attempt limit. The
context retry has `emergency_context_retry = true`. Exhaustion returns
`E_PROVIDER_RETRY_EXHAUSTED`. Retry scheduling is not a canonical event;
attempt starts and failures are.

Every retry rebuilds the effective request as needed and performs fresh
admission. The estimator computation MAY be reused only when the complete
request hash and resolved capability-profile hash exactly match the prior
attempt; the new attempt still records a new admission decision and records the
estimate reuse. A response-ID fallback, endpoint fallback, transport retry, and
emergency context retry all obey this rule.

After a replacement is accepted, append `attempt_superseded` immediately after
its acceptance event. For assistant output the acceptance event is
`assistant_step_accepted`; for compaction it is `history_compacted`. A failed
attempt with no accepted replacement is not superseded. Supersession never
removes audit data and never targets an accepted attempt.

### 12.2 Model/provider fallback

A `model_changed` event is normally legal only with no active turn. One narrow
exception permits automatic fallback inside a turn when:

- The turn has no accepted assistant step.
- Every provider attempt in the turn is durably failed.
- No tool execution exists in the turn.
- The fallback target was explicitly configured before the turn.
- The event envelope carries the active `turn_id` and null `attempt_id`.

The fallback event is durable before the fallback request begins. Its handoff
describes the failed prior provider, target provider/model, and current toolset.
The fallback attempt uses a fresh attempt ID, attempt number, admission check,
and `retry_of` link. A later fallback inside an active tool cycle is forbidden
with `E_MODEL_CHANGE_DURING_TURN`.

### 12.3 OpenAI-compatible Chat Completions

`RUST_V2_OPENAI_SPEC.md` exclusively defines Chat wire fields, roles, streaming
accumulation, finish mapping, and provider errors. The canonical boundary here
requires ordered accepted blocks, exact provider call IDs, strict argument
objects, and tool results in accepted call order. A completed call without a
provider ID fails with `E_TOOL_CALL_ID_MISSING`; no layer synthesizes one.

Chat reasoning summaries remain visible canonical summary blocks for audit and
display. They are omitted from Chat replay unless the exact provider profile
defines a fixture-tested dedicated wire field. They are never concatenated into
assistant content.

### 12.4 OpenAI Responses

`RUST_V2_OPENAI_SPEC.md` exclusively defines Responses wire fields, item/event
mapping, response-ID optimization, and provider errors. The canonical boundary
requires provider item order to be preserved and complete local continuation
material to be durable before tool execution. Required non-empty encrypted
reasoning cannot be replaced or bypassed by a response ID; absence fails with
`E_CONTINUATION_MISSING`. Empty assistant steps and unsupported terminal/output
forms fail the provider attempt and never become accepted messages.

### 12.5 Active reasoning replay

The Config specification owns the replay-policy enum and schema-v1 accepts only
`history.reasoning_replay = active`:

- Persist continuation as part of the accepted assistant message before tools
  execute.
- Make continuation available only from the most recent tool-using accepted
  step until the immediately following assistant step is accepted or the turn
  is interrupted.
- Replay it only when every `ContinuationScope` field equals the target model
  scope and the adapter supports its variant.
- Do not replay opaque continuation from committed historical turns.
- Do not include opaque continuation in compactor input, FTS, exact search,
  StateGraph extraction, logs other than canonical encrypted fields, or memory
  plugin data.
- Preserve visible conclusions through assistant text/reasoning-summary blocks,
  StateGraph, and historical handoffs.

An incompatible active continuation is not silently dropped mid-cycle. Because
reset and user model changes are forbidden during an active turn, this normally
indicates configuration/provider loss during recovery. Append
`turn_interrupted` with reason `incompatible_continuation` and return
`E_CONTINUATION_INCOMPATIBLE`. The next user turn receives a recovery notice.

### 12.6 Provider call/result invariants

Every provider request after a tool-using assistant step MUST satisfy all of
these invariants:

- The source assistant step is accepted and not from a failed attempt.
- Its batch has one and only one durable completion event.
- Every accepted call ID appears exactly once in `call_ids`.
- Every result references the same turn, step, batch, call ID, call index, tool
  name, execution ID, and source attempt.
- No result references an unknown call or a call from another step.
- Results are formatted in assistant block order.
- Error and uncertain results are included; they are never omitted to make a
  request appear successful.
- No user, handoff, state, or recovery message is inserted between the native
  active output items and their function outputs when the provider protocol
  requires adjacency. Such context is placed before the active cycle.
- A new provider attempt cannot begin until all referenced artifacts resolve
  and match their hashes.

Violation blocks the request locally with the narrowest stable error code. The
adapter MUST NOT send a provider request and wait for the provider to diagnose a
locally detectable pairing error.

## 13. Reset, Model Change, and Compaction Boundaries

### 13.1 Reset

Reset is accepted only in session state `Ready`. The reset event is fsynced
before any reset-visible UI acknowledgement or new user admission. In schema 2,
`clears_state` MUST be true and `reset_epoch` MUST equal the previous reset
epoch plus one.

After reset:

- Accepted conversation before the boundary is excluded from normal model
  history.
- The active historical handoff and compacted-turn set are cleared.
- StateGraph current projection is empty. Prior state events remain auditable.
- Pending recovery notices from prior turns are cleared from automatic prompt
  injection but remain searchable audit evidence.
- Provider continuation is empty.
- The effective model, provider, reasoning effort, tool registry, artifacts,
  and canonical source events remain unchanged.
- Artifact retrieval by an explicit ID remains legal. Default transcript search
  searches only the active reset epoch; an explicit `include_prior_epochs`
  search option may search older evidence.
- The next compaction epoch is 1 within the new reset epoch.

No synthetic user or assistant message represents reset.

### 13.2 Model or reasoning switch

Any change to provider, protocol, model, resolved model revision, model family,
endpoint fingerprint, or reasoning effort appends one `model_changed` event.
Failed target resolution or admission appends no `model_changed`; it may append
a user-audience `system_note` describing failure.

Before event append, construct a bounded switch handoff that states:

- Prior provider/protocol/model.
- Target provider/protocol/model and reasoning effort.
- Current user goal and open StateGraph items.
- Current ordered tool names and target `toolset_hash`.
- That opaque prior continuation is unavailable when disposition is
  `dropped_incompatible`.

The exact `HistoricalHandoffV1` is built and rendered under the Compaction
specification. It is non-authoritative and does not retire real messages. A
compaction handoff, if present, remains the single historical handoff. The
model-switch handoff is projected until the first turn commits under the new
model as a `RecoveryNotice` with kind `model_changed`, `message` equal to the
deterministic rendering of `ModelChanged.handoff`, `required_action` equal to
`Use the target provider, model, reasoning effort, and listed tool set for
subsequent work.`, and `notice_id` deterministically derived from the
`model_changed` event by section 4.3. Its source event list contains only that
event. Retries reproduce the same notice ID. This prevents two historical
handoff blocks from accumulating.

After append, rerun request admission against the target window, tool framing,
output reserve, and reasoning reserve. Cache miss/read/write telemetry records
the boundary. Automatic per-turn routing is forbidden.

### 13.3 Compaction

`RUST_V2_COMPACTION_SPEC.md` exclusively defines admission, trigger/hysteresis,
eligible snapshot and turn selection, internal compactor control input,
candidate validation, exact payloads, hard-ceiling recovery, and activation.
This protocol contributes the attempt lifecycle and durability boundary:

1. Freeze an eligible source snapshot and admit the exact internal request.
2. Append/fsync `assistant_attempt_started` before provider bytes; no candidate
   has been generated or validated at this point.
3. Generate and validate the candidate under the Compaction specification.
4. Append/fsync exact `HistoryCompactedV1` only after source revalidation.
5. Activate retirement/handoff projection only after that event is durable.

The internal compaction query is request-control input, not an accepted user
message. No `UserMessageAccepted` or fabricated canonical user history is
created for it. Literal provider adaptation is owned by the relevant provider
specification. Source events remain canonical and derived index activation is
idempotent.

## 14. Crash and Recovery

### 14.1 JSONL startup scan

Startup takes the exclusive session lock before repair. It then scans bytes from
offset zero and tracks the byte range of each LF-terminated line.

The algorithm is exact:

```text
recover_jsonl(path, expected_session_id):
    bytes = read entire file through a bounded streaming reader
    valid_events = []
    valid_end = 0

    for each LF-terminated line:
        if line is empty:
            fail E_JSONL_NON_FINAL_MALFORMED
        parse with duplicate-key rejection and exact schema validation
        if parse fails:
            if any bytes exist after this line's LF:
                fail E_JSONL_NON_FINAL_MALFORMED
            quarantine line including LF
            truncate file to valid_end and fsync
            report E_JSONL_FINAL_TRUNCATED warning
            break
        validate sequence, IDs, session, references, and transition
        valid_events.push(event)
        valid_end = byte offset immediately after LF

    if non-LF-terminated bytes remain:
        if remainder is one complete valid event with expected next sequence:
            append one LF byte and fsync
            accept event and report final-newline repair warning
        else:
            quarantine remainder
            truncate file to valid_end and fsync
            report E_JSONL_FINAL_TRUNCATED warning

    replay valid_events
```

The quarantine path is
`<session-dir>/quarantine/events-tail-<sha256>.bin`, where the digest is over the
exact quarantined bytes. Create the quarantine directory with `0700`, file with
`0600`, write bytes, fsync the quarantine file and directory, and only then
truncate `events.jsonl`. If quarantine persistence fails, do not truncate and
open the session read-only with `E_EVENT_DURABILITY_UNCERTAIN`.

A malformed line is considered final only when no byte follows its terminating
LF, or when it is the unterminated EOF remainder. A syntactically valid event
with bad sequence/reference/transition is an integrity failure, not a
truncation candidate. Valid earlier events are never hidden by final-tail
damage.

After quarantine, create one in-memory `truncated_log_tail` recovery notice. It
is included in the next provider attempt and may also be surfaced to the user.
Do not append a system note merely to describe the repair before state-machine
recovery has completed.

### 14.2 Incomplete-tail recovery algorithm

After valid replay:

```text
recover_protocol_tail(state):
    if an attempt is open:
        append assistant_attempt_failed(
            code = E_ATTEMPT_LOST,
            class = process_crash,
            retryable = true only if no accepted output exists,
            partial_output = empty because non-durable UI deltas are unknown,
            observable_delta_emitted = false,
            provider_may_have_completed = true)
        queue attempt_lost recovery notice

    for each incomplete batch in assistant call order:
        unresolved = calls without a finish
        uncertain = unresolved calls with durable starts

        for each uncertain call:
            if one committed orphan artifact exactly matches all source/final-result fields:
                verify blob/result/preview hashes and reconstruct finish
                queue tool_result_recovered notice
            else:
                append synthetic uncertain finish
                queue tool_side_effect_uncertain notice

        if any uncertain call is mutating or outward:
            append skipped finishes for every unresolved call without a start
        else:
            execute unresolved calls without starts through normal pipeline

        when all finishes are durable:
            append tool_batch_completed in assistant call order

    if active turn ends in a terminal accepted step:
        recompute exact accepted messages hash and append turn_committed

    if active turn now has a completed tool batch and needs continuation:
        verify active continuation compatibility
        begin a fresh provider attempt with queued recovery notices

    if active turn cannot safely continue:
        append turn_interrupted with exact reason
```

Recovery-generated canonical events use fresh IDs and current timestamps. They
reference the original durable events. Recovery is idempotent: after any crash
during recovery, replay sees already-finished calls and terminal attempts and
continues only missing transitions.

An orphan artifact is usable for reconstruction only when its row transaction
contains the complete canonical `ToolResultBody`, immutable preview, reserved
finish event identity, `result_message_id`, exact `ToolResultStatus`, execution
ID, batch ID, step ID, call ID/index, tool name, non-null source `AttemptId`, and
post-redaction body/result hashes and counts. The source attempt and durable
`ToolExecutionStarted` must agree on every identity field. The core recomputes
the blob hash, canonical result hash, preview rendering/hash, and all counts.
The reserved finish event ID must be unused and its reserved sequence must be
the next recoverable sequence. Only an exact, unique match permits
reconstruction. Any absent field, mismatch, ambiguity, or unverifiable source
prevents reconstruction; the execution receives an uncertain result. Raw shell
spools, IPC cache entries, UI rows, timestamps, and matching tool names alone
are never proof of completion.

### 14.3 Recovery notice templates

Template substitutions use canonical IDs and names without free-form provider
error text.

| Kind | `message` | `required_action` |
|---|---|---|
| `attempt_lost` | `A provider attempt was in progress when the prior process stopped. No output from that attempt was accepted.` | `Continue from durable accepted history; do not assume the lost attempt completed.` |
| `tool_side_effect_uncertain` | `Tool <tool_name> for call <call_id> was marked started before the prior process stopped, but no durable result exists. Its side effects are unknown.` | `Inspect the affected state before repeating this tool or making a dependent mutation.` |
| `tool_result_recovered` | `Tool <tool_name> for call <call_id> completed before the prior process stopped. Its durable artifact was recovered and supplied as the result.` | `Use the recovered result; do not repeat the tool solely because the process stopped.` |
| `turn_interrupted` | `The prior turn ended without an accepted terminal assistant response: <reason>.` | `Reconfirm the current goal and continue only from durable accepted messages and tool results.` |
| `truncated_log_tail` | `An incomplete final event record from the prior process was quarantined. Earlier durable events remain valid.` | `Continue from the reported durable state; do not assume the quarantined event occurred.` |
| `model_changed` | Exact deterministic rendering of `ModelChanged.handoff` under the Compaction specification. | `Use the target provider, model, reasoning effort, and listed tool set for subsequent work.` |

One notice is generated per source condition. Its deterministic ULID
`notice_id` is persisted inside the next
`assistant_attempt_started.recovery_notices`. Retries and recovery before that
first containing event reproduce the same notice ID and content from durable
source keys.
`turn_committed.recovery_notice_ids_presented` contains all notices included in
any attempt for that turn, sorted by first presentation.

### 14.4 Crash boundary matrix

| Last completed durable boundary | State on disk | Required resume behavior | Automatic external action allowed? |
|---|---|---|---|
| Session directory created, no `session_started` | Empty/non-session directory | Do not resume as a session; return `E_SESSION_NOT_STARTED`. Maintenance may remove it. | No. |
| `session_started` | Ready empty session | Resume ready. | No. |
| `user_message_accepted` | Admitted user, no turn start | Append matching `turn_started` using settings captured by session replay, then start provider attempt. | Provider call only. |
| `turn_started` | Turn awaiting first step | Run admission, append fresh attempt start, call provider. | Provider call only. |
| `assistant_attempt_started`, no terminal attempt event | Provider may have received request; no output accepted | Append lost-attempt failure and retry only under bounded policy. Rewind ephemeral UI. | Fresh provider call; never a tool call from lost output. |
| `assistant_attempt_failed` | Failed attempt | Retry if policy permits; otherwise interrupt turn. | Bounded provider call only. |
| Replacement accepted, no `attempt_superseded` | Accepted result plus old failed attempt | Append missing supersession relation, then continue. | As allowed by accepted result. |
| Terminal `assistant_step_accepted`, no commit | Complete accepted terminal response | Recompute hash and append `turn_committed`. | No provider/tool action. |
| Tool-using `assistant_step_accepted`, no tool starts | Calls are accepted and provably uninvoked | Run pre-hooks, persist starts, and execute normally. | Yes, including mutation after normal gates. |
| Some pre-hook-blocked finishes, no starts | Block decisions durable for those calls | Do not rerun finished calls; prepare remaining calls. | Remaining calls only. |
| One or more `tool_execution_started`, no finishes | Started calls have uncertain effects | Never rerun started calls. Emit uncertain results; skip unstarted peers if any uncertain call mutates/outward. | Only safe unstarted peers when all uncertain calls are read-only. |
| Artifact transaction committed, no finish event | Complete result may be recoverable | Verify orphan metadata/hash; append reconstructed finish or uncertain finish. Never rerun. | No. |
| One or more finish events, batch incomplete | Those exact results are durable | Do not rerun finished calls. Recover unresolved calls, then append batch completion. | Per unresolved-call rules. |
| All finish events, no `tool_batch_completed` | Complete ordered result set | Validate/reorder/hash and append batch completion. | No tool action. |
| `tool_batch_completed`, no continuation attempt | Complete active cycle | Start fresh compatible provider attempt with recovery notices. | Provider call only. |
| Continuation attempt started, no terminal event | Provider may have received continuation | Mark attempt lost; bounded fresh attempt using local continuation and results. | Provider call only. |
| `turn_interrupted` | Explicit terminal non-commit | Resume ready; next new turn gets interruption notice. | No. |
| `turn_committed` | Complete committed turn | Resume ready. | No. |
| Compaction attempt started, no failure/success | Source unchanged; provider result unknown | Mark attempt lost. Retry candidate only after re-snapshot/re-hash. | Bounded compactor call. |
| Artifact rows for compaction candidate only | No canonical compaction | Treat rows as orphan derived data; prior projection stays active. | No. |
| `history_compacted`, derived index not updated | New compaction is canonical and active | Rebuild/apply indexes idempotently from event. | No provider call. |
| Derived index update committed | Event and index agree | Resume normally. | No. |
| `model_changed`, no new turn | New model boundary active | Re-admit before next provider request and show switch notice. | No call until user/turn continuation. |
| `reset_boundary`, no new event | New empty reset epoch active | Resume with empty visible conversation/state and same model. | No. |
| Partial final JSON line | Longest valid prefix plus invalid bytes | Quarantine invalid bytes, truncate to valid prefix, then apply this matrix. | Only after recovery completes. |

No recovery path invents assistant text, treats UI deltas as accepted, or
silently claims a tool succeeded. Provider requests may be repeated after a
lost attempt because no output was accepted; tool bodies with durable starts
may not be repeated automatically.

### 14.5 User abort and cancellation

Cancellation is structured by a turn cancellation token. If cancellation
occurs before a provider attempt starts, append `turn_interrupted` with
`user_abort`. If it occurs during a provider stream, append
`assistant_attempt_failed` with class `cancelled`, then interrupt. If it occurs
during tools, tools that have not started receive cancelled results; started
tools are asked to cancel, complete post-processing, and receive exact finished
results. If the process exits before their finish is durable, normal uncertain
recovery applies.

An abort never accepts partial assistant output. UI-rendered partial output is
rewound or marked ephemeral and is not in the resumed transcript projection.

## 15. Exact JSON Examples

The JSON examples whose payloads are protocol-owned are structurally complete
schema 2 JSON. StateGraph and compaction subsections instead reference their
exact owner-defined payloads. Option fields are present as `null`, and empty
collections are present. Hash strings are format-valid illustrative values;
golden fixtures, not this prose, contain cryptographically recomputed expected
hashes.

Every canonical local ID shown below is a raw uppercase 26-character ULID.
Strings with provider prefixes such as `call_`, `resp_`, `rs_`, or `fc_` are
explicitly opaque provider-owned IDs, not canonical local IDs.

### 15.1 Session start

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 1,
  "timestamp_ms": 1788134400000,
  "turn_id": null,
  "attempt_id": null,
  "event": {
    "kind": "session_started",
    "data": {
      "cwd": "/workspace/praana",
      "agent": "praana",
      "config_schema_version": 1,
      "config_digest_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "history_mode": "append",
      "projection_version": "rust-v2-projection-1",
      "compaction_policy_version": "rust-v2-compaction-1",
      "artifact_policy_version": "rust-v2-artifact-1",
      "token_estimator_schema_version": 1,
      "unicode_utility_version": "praana-unicode-15.1-v1",
      "initial_model": {
        "provider": "openai",
        "protocol": "openai-responses-v1",
        "model": "gpt-5",
        "model_revision": "2026-08-01",
        "model_family": "gpt-5",
        "endpoint_fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "reasoning_effort": "medium"
      },
      "initial_toolset_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  }
}
```

### 15.2 User admission and turn start

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 2,
  "timestamp_ms": 1788134400010,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "attempt_id": null,
  "event": {
    "kind": "user_message_accepted",
    "data": {
      "message": {
        "message_id": "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "blocks": [
          {
            "type": "text",
            "data": {
              "text": "Read README.md and report its first heading."
            }
          }
        ]
      }
    }
  }
}
```

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 3,
  "timestamp_ms": 1788134400011,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "attempt_id": null,
  "event": {
    "kind": "turn_started",
    "data": {
      "turn_index": 1,
      "user_message_id": "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      "model": {
        "provider": "openai",
        "protocol": "openai-responses-v1",
        "model": "gpt-5",
        "model_revision": "2026-08-01",
        "model_family": "gpt-5",
        "endpoint_fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "reasoning_effort": "medium"
      },
      "toolset_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "max_steps": 25
    }
  }
}
```

### 15.3 Attempt start with admission and recovery

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 4,
  "timestamp_ms": 1788134400020,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "attempt_id": "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "event": {
    "kind": "assistant_attempt_started",
    "data": {
      "purpose": {
        "type": "assistant_step",
        "data": {
          "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FB3",
          "step_index": 0
        }
      },
      "attempt_number": 1,
      "model": {
        "provider": "openai",
        "protocol": "openai-responses-v1",
        "model": "gpt-5",
        "model_revision": "2026-08-01",
        "model_family": "gpt-5",
        "endpoint_fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "reasoning_effort": "medium"
      },
      "request_hash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "admission": {
        "token_estimator_schema_version": 1,
        "estimator_id": "provider-tokenizer:openai:o200k_base:1",
        "estimated_input_sha256": "9999999999999999999999999999999999999999999999999999999999999999",
        "context_window_tokens": 200000,
        "estimated_input_tokens": 1200,
        "requested_output_tokens": 4096,
        "requested_reasoning_tokens": 4096,
        "safety_margin_tokens": 1000,
        "projected_fill_millionths": 51960,
        "capability_profile_hash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "estimate_reused_from_attempt_id": null
      },
      "retry_of": null,
      "emergency_context_retry": false,
      "recovery_notices": []
    }
  }
}
```

### 15.4 Accepted ordered Responses step with native continuation

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 5,
  "timestamp_ms": 1788134400100,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "attempt_id": "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "event": {
    "kind": "assistant_step_accepted",
    "data": {
      "purpose": {
        "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "step_index": 0
      },
      "message": {
        "message_id": "01ARZ3NDEKTSV4RRFFQ69G5FB5",
        "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "provider": "openai",
        "model": "gpt-5",
        "blocks": [
          {
            "type": "reasoning_summary",
            "data": {
              "text": "I need the requested file heading.",
              "provider_item_id": "rs_001"
            }
          },
          {
            "type": "tool_call",
            "data": {
              "call_id": "call_read_001",
              "name": "read_file",
              "arguments": {
                "path": "README.md"
              },
              "raw_arguments": "{\"path\":\"README.md\"}"
            }
          }
        ],
        "finish_reason": "tool_use",
        "continuation": {
          "provider_protocol": "open_ai_responses",
          "data": {
            "scope": {
              "provider": "openai",
              "protocol": "openai-responses-v1",
              "model": "gpt-5",
              "model_revision": "2026-08-01",
              "endpoint_fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            },
            "response_id": "resp_001",
            "output_items": [
              {
                "type": "reasoning",
                "data": {
                  "id": "rs_001",
                  "status": "completed",
                  "summary": [
                    {
                      "text": "I need the requested file heading."
                    }
                  ],
                  "encrypted_content": "opaque-ciphertext"
                }
              },
              {
                "type": "function_call",
                "data": {
                  "id": "fc_001",
                  "status": "completed",
                  "call_id": "call_read_001",
                  "name": "read_file",
                  "arguments": "{\"path\":\"README.md\"}"
                }
              }
            ]
          }
        },
        "usage": {
          "input_tokens": 1200,
          "output_tokens": 45,
          "reasoning_tokens": 20,
          "total_tokens": 1265,
          "cache_read_tokens": 800,
          "cache_write_tokens": 0
        }
      }
    }
  }
}
```

The Serde discriminant is `open_ai_responses`, because `rename_all =
"snake_case"` is applied to the Rust variant `OpenAiResponses`.

### 15.5 Tool start, artifact result, and batch completion

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FB6",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 6,
  "timestamp_ms": 1788134400110,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "attempt_id": "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "event": {
    "kind": "tool_execution_started",
    "data": {
      "batch_id": "01ARZ3NDEKTSV4RRFFQ69G5FB7",
      "execution_id": "01ARZ3NDEKTSV4RRFFQ69G5FB8",
      "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FB3",
      "call_id": "call_read_001",
      "call_index": 0,
      "tool_name": "read_file",
      "arguments_hash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "mutability": "read_only"
    }
  }
}
```

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FB9",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 7,
  "timestamp_ms": 1788134400120,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "attempt_id": "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "event": {
    "kind": "tool_execution_finished",
    "data": {
      "batch_id": "01ARZ3NDEKTSV4RRFFQ69G5FB7",
      "execution_id": "01ARZ3NDEKTSV4RRFFQ69G5FB8",
      "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FB3",
      "call_id": "call_read_001",
      "call_index": 0,
      "started_event_id": "01ARZ3NDEKTSV4RRFFQ69G5FB6",
      "result": {
        "message_id": "01ARZ3NDEKTSV4RRFFQ69G5FBA",
        "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "batch_id": "01ARZ3NDEKTSV4RRFFQ69G5FB7",
        "execution_id": "01ARZ3NDEKTSV4RRFFQ69G5FB8",
        "call_id": "call_read_001",
        "tool_name": "read_file",
        "status": "success",
        "body": {
          "media_type": "text/plain",
          "content": {
            "storage": "artifact",
            "data": {
              "preview": "Artifact 01ARZ3NDEKTSV4RRFFQ69G5FBB: read_file [label=\"README.md\"] (3204 bytes, 400 lines, 801 estimated tokens; error=false).\nSample (head_tail):\n# PRAANA\nEnd of README.\n[... 3180 bytes and 398 lines omitted ...]\nRetrieve with retrieve_artifact({\"artifact_id\":\"01ARZ3NDEKTSV4RRFFQ69G5FBB\"}).",
              "reference": {
                "artifact_id": "01ARZ3NDEKTSV4RRFFQ69G5FBB",
                "sha256": "057f8570b5137bf1253bc47b3feb66d59c8df1a2c92caf7b4f83d3f99a671619",
                "media_type": "text/plain",
                "byte_count": 3204,
                "line_count": 400,
                "estimated_tokens": 801,
                "token_estimator_schema_version": 1,
                "estimator_id": "praana-generic-unicode-15.1-v1",
                "token_input_sha256": "057f8570b5137bf1253bc47b3feb66d59c8df1a2c92caf7b4f83d3f99a671619",
                "retrieval": {
                  "tool": "retrieve_artifact",
                  "arguments": {
                    "artifact_id": "01ARZ3NDEKTSV4RRFFQ69G5FBB"
                  }
                }
              }
            }
          },
          "sha256": "057f8570b5137bf1253bc47b3feb66d59c8df1a2c92caf7b4f83d3f99a671619",
          "byte_count": 3204,
          "line_count": 400,
          "estimated_tokens": 801,
          "token_estimator_schema_version": 1,
          "estimator_id": "praana-generic-unicode-15.1-v1",
          "token_input_sha256": "057f8570b5137bf1253bc47b3feb66d59c8df1a2c92caf7b4f83d3f99a671619",
          "redacted": false
        },
        "recovered": false
      }
    }
  }
}
```

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FBC",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 8,
  "timestamp_ms": 1788134400121,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "attempt_id": "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "event": {
    "kind": "tool_batch_completed",
    "data": {
      "batch_id": "01ARZ3NDEKTSV4RRFFQ69G5FB7",
      "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FB3",
      "call_ids": [
        "call_read_001"
      ],
      "result_event_ids": [
        "01ARZ3NDEKTSV4RRFFQ69G5FB9"
      ],
      "result_messages_hash": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    }
  }
}
```

### 15.6 Failed attempt and supersession

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FBD",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 20,
  "timestamp_ms": 1788134401000,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "attempt_id": "01ARZ3NDEKTSV4RRFFQ69G5FBE",
  "event": {
    "kind": "assistant_attempt_failed",
    "data": {
      "purpose": {
        "type": "assistant_step",
        "data": {
          "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FBF",
          "step_index": 1
        }
      },
      "error": {
        "code": "E_PROVIDER_STREAM",
        "class": "transport",
        "message": "connection reset",
        "retryable": true,
        "http_status": null,
        "retry_after_ms": null
      },
      "partial_output": {
        "blocks": [],
        "provider_response_id": null
      },
      "observable_delta_emitted": false,
      "provider_may_have_completed": false,
      "usage": {
        "input_tokens": 1300,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "total_tokens": 1300,
        "cache_read_tokens": 1000,
        "cache_write_tokens": 0
      }
    }
  }
}
```

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FBG",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 23,
  "timestamp_ms": 1788134401100,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "attempt_id": null,
  "event": {
    "kind": "attempt_superseded",
    "data": {
      "purpose": {
        "type": "assistant_step",
        "data": {
          "step_id": "01ARZ3NDEKTSV4RRFFQ69G5FBF",
          "step_index": 1
        }
      },
      "superseded_attempt_id": "01ARZ3NDEKTSV4RRFFQ69G5FBE",
      "replacement_attempt_id": "01ARZ3NDEKTSV4RRFFQ69G5FBH",
      "replacement_accept_event_id": "01ARZ3NDEKTSV4RRFFQ69G5FBJ",
      "reason": "retry"
    }
  }
}
```

The missing sequences in this isolated example stand for the replacement start
and acceptance events. A real JSONL fixture has no sequence gap.

### 15.7 Turn commit and interruption

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FBK",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 24,
  "timestamp_ms": 1788134401101,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "attempt_id": null,
  "event": {
    "kind": "turn_committed",
    "data": {
      "turn_index": 1,
      "user_message_id": "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      "terminal_step_id": "01ARZ3NDEKTSV4RRFFQ69G5FBF",
      "accepted_step_ids": [
        "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        "01ARZ3NDEKTSV4RRFFQ69G5FBF"
      ],
      "completed_batch_ids": [
        "01ARZ3NDEKTSV4RRFFQ69G5FB7"
      ],
      "outcome": "stop",
      "accepted_messages_hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "usage": {
        "input_tokens": 2500,
        "output_tokens": 60,
        "reasoning_tokens": 20,
        "total_tokens": 2580,
        "cache_read_tokens": 1800,
        "cache_write_tokens": 0
      },
      "recovery_notice_ids_presented": []
    }
  }
}
```

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FBM",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 30,
  "timestamp_ms": 1788134402000,
  "turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FBN",
  "attempt_id": null,
  "event": {
    "kind": "turn_interrupted",
    "data": {
      "turn_index": 2,
      "user_message_id": "01ARZ3NDEKTSV4RRFFQ69G5FBP",
      "reason": "user_abort",
      "last_accepted_step_id": null,
      "failed_attempt_id": "01ARZ3NDEKTSV4RRFFQ69G5FBQ",
      "uncertain_execution_ids": [],
      "message": "Turn aborted by user before commit."
    }
  }
}
```

### 15.8 State change

Use the complete schema-1 `StateChangedV1` payload examples in
`RUST_V2_STATE_GRAPH_SPEC.md` section 3.3 inside the schema-2 envelope from
section 5.1 here. Protocol fixtures MUST substitute raw uppercase 26-character
ULIDs for every local ID and MUST NOT contain the removed single
create/replace after-image payload.

### 15.9 Compaction

Use exact `HistoryCompactedV1` from `RUST_V2_COMPACTION_SPEC.md` section 11,
including `compaction_schema_version`, `source_turn_ids`, admission token fields,
hashes, strategy, estimator, and attempt-start reference. Its segment and
handoff use the exact structured schema-1 payloads; there is no scalar handoff
body or alternate retired-turn field. Protocol fixtures wrap that payload in a
schema-2 envelope whose `attempt_id` is the accepted compaction attempt.

### 15.10 Model change, reset, and system note

The `ModelChanged.handoff` fixture uses exact structured
`HistoricalHandoffV1` with `reason = model_switch`; it does not use a scalar
handoff body. Both `ModelSelection` values include `model_revision`. The
Compaction specification owns the nested handoff fixture shape.

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FC1",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 102,
  "timestamp_ms": 1788134500200,
  "turn_id": null,
  "attempt_id": null,
  "event": {
    "kind": "reset_boundary",
    "data": {
      "reset_epoch": 1,
      "command": "/clear",
      "reason": "User requested a clean context.",
      "clears_state": true,
      "previous_turn_id": "01ARZ3NDEKTSV4RRFFQ69G5FBN"
    }
  }
}
```

```json
{
  "schema_version": 2,
  "event_id": "01ARZ3NDEKTSV4RRFFQ69G5FC2",
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "sequence": 103,
  "timestamp_ms": 1788134500210,
  "turn_id": null,
  "attempt_id": null,
  "event": {
    "kind": "system_note",
    "data": {
      "code": "SESSION_RESUMED",
      "level": "info",
      "audience": "user",
      "message": "Session resumed from sequence 102.",
      "references": [
        "01ARZ3NDEKTSV4RRFFQ69G5FC1"
      ],
      "details": {
        "through_sequence": 102
      }
    }
  }
}
```

All 17 canonical event kinds are represented either by a full envelope above
or by the exact payload definitions and field summary in Sections 5 and 7. A
golden serialization fixture MUST contain at least one instance of every kind,
including a blocked finish with null `started_event_id` and a recovered
uncertain finish.

## 16. Golden Fixture Inventory

Fixtures live under `crates/praana-core/tests/fixtures/protocol_v2/`. Every
fixture directory contains:

```text
events.jsonl              # input canonical log
expected_projection.json  # exact ConversationProjection, when replay succeeds
expected_error.json       # exact code and failing sequence, when replay fails
history.db.fixture        # only when an artifact row is required
provider_input.json       # projected canonical adapter input when required
manifest.json             # clock seed, ULID seed, hashes, and fixture purpose
```

Exactly one of `expected_projection.json` and `expected_error.json` is required.
JSON fixture files are RFC 8785 canonicalized for comparison. `events.jsonl`
uses compact JSON plus LF. Tests recompute all hashes instead of trusting the
manifest.

### 16.1 Successful projection fixtures

| Fixture | Input fact | Exact projected message sequence |
|---|---|---|
| `01_committed_text_turn` | One user, one terminal assistant, one commit | `user(U1), assistant(A1)`; no active handoff, pending recovery, continuation, or compacted turns. |
| `02_single_tool_cycle_inline` | One call and inline success | `user(U1), assistant(A1 calls C1), tool_result(C1), assistant(A2)`; active continuation null after commit. |
| `03_parallel_results_finish_out_of_order` | Calls C1/C2; finish event C2 precedes C1 | `user(U1), assistant(A1 calls C1,C2), tool_result(C1), tool_result(C2), assistant(A2)` exactly. |
| `04_parallel_error_result` | C1 succeeds; C2 has status error | Same ordered five-message shape as fixture 03; C2 remains present and provider `is_error` mapping is true. |
| `05_responses_reasoning_active_cycle` | Ordered reasoning, text, C1; complete result; no next step yet | `user(U1), assistant(A1), tool_result(C1)` and `active_continuation` equals A1 continuation byte-for-byte. |
| `06_responses_reasoning_cycle_closed` | Fixture 05 plus accepted terminal A2 and commit | Same messages plus `assistant(A2)`; `active_continuation` is null; A1 durable event still contains encrypted data. |
| `07_failed_preemission_then_retry` | Attempt P1 fails before a delta; P2 is accepted; supersession follows | Projection contains only P2 assistant message. P1 has empty partial output. |
| `08_partial_emission_then_interruption` | User accepted; attempt emits partial text, fails, and is not retried; turn interrupted | Messages contain `user(U1)` only; `pending_recovery` contains `turn_interrupted`; partial assistant text is absent. |
| `09_terminal_accept_crash_repair` | Log ends at terminal accepted step | Recovery appends one commit; projection equals fixture 01 and second recovery appends nothing. |
| `10_blocked_tool_no_start` | Call C1 blocked by risk/validation; finish has null start | Assistant C1 followed by blocked result C1 and terminal assistant; no uncertain notice. |
| `11_uncertain_mutation_recovery` | C1 mutating start, no finish; C2 never started | Recovery appends uncertain C1, skipped C2, batch complete, and a notice naming C1. Result order is C1,C2. |
| `12_orphan_artifact_recovery` | C1 start plus matching committed artifact, no finish | Recovery finish references the artifact, status equals stored result, `recovered=true`, and notice kind is `tool_result_recovered`. |
| `13_reset_boundary` | One committed turn, reset, one committed turn | Projection contains only post-reset `user(U2), assistant(A2)`; state and handoff are empty; reset epoch is 1. |
| `14_one_compaction_epoch` | T1/T2 compacted, T3 retained | Messages are `user(U3), assistant(A3)`; `active_handoff` is H1 and compacted IDs are T1,T2 in order. |
| `15_two_compaction_epochs` | H1 compacts T1/T2; H2 compacts T3 | `active_handoff` is H2 only, messages contain retained T4, and compacted IDs are T1,T2,T3. |
| `16_model_switch_boundary` | Committed T1, OpenAI Responses to Chat Completions switch | Portable T1 remains; active opaque continuation is null; switch boundary notice identifies both models and target tools. |
| `17_state_rebuild_and_focus` | Atomic schema-1 operations create S1/S2, focus S2, update/retract S1 | `current_state` is exact `StateGraphV1` with S2 focused and S1 retracted; message projection is unaffected. |
| `18_compaction_mid_active_turn` | T1 retired while T2 waits on complete tool result | H1 replaces T1; complete T2 cycle remains intact; no T2 event is in source range. |
| `19_truncated_final_line` | Valid committed T1 plus malformed EOF bytes | T1 projection succeeds, invalid bytes appear in exact SHA quarantine path, and pending notice kind is `truncated_log_tail`. |
| `20_valid_final_line_without_lf` | Last event is valid but lacks LF | Event is accepted, one LF is appended, projection matches committed source, no truncation notice. |
| `21_provider_fallback_initial_attempt` | Primary P1 fails before accepted step, model change, fallback P2 accepted | Only P2 output appears; model boundary is target; P1 is failed and superseded. |
| `22_compaction_failed_candidate` | Compaction start/failure without compact event | No retirement and no handoff; conversation equals pre-attempt projection. |

The symbolic IDs above map to concrete ULIDs in each manifest. Expected
projections compare complete JSON DTOs, not only role names.

### 16.2 Rejection fixtures

| Fixture | Mutation | Exact expected error |
|---|---|---|
| `e01_schema_version_1` | First envelope uses schema 1 | `E_SCHEMA_VERSION_UNSUPPORTED`, sequence 1. |
| `e02_unknown_event_field` | Adds `actor` to envelope | `E_EVENT_SCHEMA_INVALID`, sequence 2. |
| `e03_unknown_payload_field` | Adds field to `turn_started.data` | `E_EVENT_SCHEMA_INVALID`, sequence 3. |
| `e04_duplicate_json_key` | Repeats `event_id` in one object | `E_EVENT_SCHEMA_INVALID`, failing line 2. |
| `e05_sequence_gap` | Sequence jumps 2 to 4 | `E_JSONL_SEQUENCE_GAP`, expected 3, actual 4. |
| `e06_sequence_duplicate` | Two events have sequence 3 | `E_JSONL_SEQUENCE_DUPLICATE`, expected 4, actual 3. |
| `e07_event_id_duplicate` | Event ID from sequence 2 reused | `E_EVENT_ID_DUPLICATE`, later sequence. |
| `e08_session_mismatch` | One envelope has another session ID | `E_SESSION_ID_MISMATCH`, offending sequence. |
| `e09_nonfinal_malformed` | Malformed line followed by another line | `E_JSONL_NON_FINAL_MALFORMED`; file is not truncated. |
| `e10_tool_result_unknown_call` | Finish references C9 absent from step | `E_TOOL_RESULT_CALL_MISMATCH`. |
| `e11_tool_result_duplicate` | Two finishes reference C1 | `E_TOOL_RESULT_DUPLICATE`. |
| `e12_batch_missing_result` | Batch completion omits C2 | `E_TOOL_BATCH_INCOMPLETE`. |
| `e13_batch_wrong_result_order` | Result event IDs ordered C2,C1 for calls C1,C2 | `E_TOOL_RESULT_CALL_MISMATCH`. |
| `e14_tool_call_id_reused` | Later accepted step reuses C1 | `E_TOOL_CALL_ID_REUSED`. |
| `e15_tool_arguments_scalar` | Raw arguments parse to JSON array | `E_TOOL_ARGUMENTS_INVALID`; no step accepted. |
| `e16_accept_failed_attempt` | Acceptance follows failure for same attempt | `E_ATTEMPT_ALREADY_TERMINAL`. |
| `e17_retry_accepted_attempt` | Retry starts after accepted step | `E_PROVIDER_RETRY_AFTER_ACCEPTANCE`. |
| `e18_step_accepted_twice` | Two attempts accepted for same step | `E_STEP_ALREADY_ACCEPTED`. |
| `e19_commit_incomplete_batch` | Commit follows calls without batch completion | `E_TOOL_BATCH_INCOMPLETE`. |
| `e20_reset_during_turn` | Reset appears before turn terminal event | `E_RESET_DURING_TURN`. |
| `e21_model_change_active_cycle` | Model change follows accepted tool step | `E_MODEL_CHANGE_DURING_TURN`. |
| `e22_missing_artifact` | Finish references absent artifact row | `E_ARTIFACT_MISSING`. |
| `e23_artifact_hash_mismatch` | Artifact bytes differ from reference hash | `E_ARTIFACT_HASH_MISMATCH`. |
| `e24_state_revision_skip` | A `StateOperationV1` expects a skipped/stale revision | `STATE_PROJECTION_INTEGRITY`. |
| `e25_compaction_open_turn` | Retired IDs include active T2 | `E_COMPACTION_RANGE_INVALID`. |
| `e26_compaction_hash_mismatch` | Source bytes differ from source hash | `E_COMPACTION_SOURCE_HASH_MISMATCH`. |
| `e27_compaction_epoch_skip` | First compaction epoch is 2 | `E_COMPACTION_EPOCH_INVALID`. |
| `e28_lowercase_ulid` | Local ID is lowercase | `E_EVENT_SCHEMA_INVALID`. |
| `e29_forward_reference` | Batch references future finish event | `E_REFERENCE_UNKNOWN`. |
| `e30_invalid_envelope_context` | Tool finish has null attempt ID | `E_EVENT_CONTEXT_INVALID`. |
| `e31_retry_after_emission` | Retry starts after failed attempt with observable delta | `E_PROVIDER_RETRY_AFTER_EMISSION`. |
| `e32_missing_provider_call_id` | Completed provider tool call has no non-empty ID | `E_TOOL_CALL_ID_MISSING`; no accepted step or synthesized ID. |

`expected_error.json` has this exact shape:

```json
{
  "code": "E_TOOL_BATCH_INCOMPLETE",
  "sequence": 9,
  "line": 9,
  "recoverable": false
}
```

For errors found before event deserialization, `sequence` is null. `line` is
one-based. Additional fields are forbidden in the expected DTO.

### 16.3 Provider adapter fixtures

Protocol fixtures cover the canonical adapter input/output boundary, fresh
attempt lifecycle, and error conversion. Exact OpenAI request bodies, stream
events, delay/backoff, and wire fixture inventory are owned only by
`RUST_V2_OPENAI_SPEC.md` section 21. Protocol CI consumes those fixtures as a
dependency rather than declaring a competing inventory. Network access is
forbidden in both suites.

## 17. Required Tests

Test names below are normative acceptance inventory. Modules may be rearranged,
but CI MUST expose these names or an explicit one-to-one replacement in the
same change.

### 17.1 Unit tests

```text
protocol::serde_tests::event_round_trip_all_kinds
protocol::serde_tests::option_fields_serialize_as_null
protocol::serde_tests::unknown_fields_are_rejected
protocol::serde_tests::duplicate_json_keys_are_rejected
protocol::serde_tests::ulid_newtypes_reject_noncanonical_text
protocol::serde_tests::provider_tool_call_ids_are_opaque
protocol::hash_tests::request_hash_excludes_headers_and_credentials
protocol::hash_tests::source_hash_includes_line_feeds
protocol::hash_tests::tool_arguments_use_rfc8785
history::replay_tests::committed_text_turn_projects_exactly
history::replay_tests::failed_partial_attempt_is_excluded
history::replay_tests::supersession_does_not_remove_audit_attempt
history::replay_tests::tool_results_project_in_call_order
history::replay_tests::incomplete_tool_batch_is_not_visible
history::replay_tests::reset_clears_visible_projection_and_state
history::replay_tests::latest_handoff_replaces_older_handoff
history::replay_tests::compacted_state_events_still_rebuild_state
history::replay_tests::model_switch_drops_incompatible_continuation
history::replay_tests::active_responses_continuation_is_retained
history::replay_tests::committed_reasoning_continuation_is_not_replayed
history::event_store_tests::append_fsyncs_before_acknowledgement
history::event_store_tests::valid_final_line_without_lf_is_repaired
history::event_store_tests::malformed_final_line_is_quarantined
history::event_store_tests::malformed_nonfinal_line_is_fatal
history::event_store_tests::sequence_gap_is_fatal
history::event_store_tests::event_id_duplicate_is_fatal
history::recovery_tests::open_attempt_becomes_failed_lost_attempt
history::recovery_tests::terminal_accepted_step_is_committed_once
history::recovery_tests::uncertain_mutating_tool_is_never_rerun
history::recovery_tests::uncertain_mutating_peer_skips_unstarted_calls
history::recovery_tests::orphan_artifact_reconstructs_exact_result
history::recovery_tests::recovery_is_idempotent_after_each_repair_event
provider::tool_accumulator_tests::parallel_fragments_preserve_call_order
provider::tool_accumulator_tests::conflicting_fragment_id_is_rejected
provider::tool_accumulator_tests::missing_provider_call_id_is_rejected
provider::tool_accumulator_tests::malformed_arguments_are_not_repaired
provider::openai_chat_tests::formats_ordered_parallel_results
provider::responses_tests::preserves_ordered_output_items
provider::responses_tests::replays_encrypted_reasoning_only_in_active_cycle
provider::responses_tests::local_items_work_without_previous_response_id
provider::responses_tests::missing_encrypted_reasoning_rejects_tool_step
provider::retry_tests::every_retry_gets_new_attempt_id
provider::retry_tests::accepted_output_is_never_retried
provider::retry_tests::observable_delta_is_not_automatically_retried
provider::retry_tests::context_length_retries_at_most_once
tools::batch_tests::all_permitted_starts_are_durable_before_invocation
tools::batch_tests::finish_completion_order_does_not_change_projection
tools::batch_tests::blocked_call_has_no_start_event
artifacts::tests::artifact_commits_before_reference_event
artifacts::tests::errors_are_artifactized_over_threshold
compaction::tests::selects_oldest_half_of_eligible_token_mass
compaction::tests::never_selects_active_or_incomplete_turn
compaction::tests::activation_waits_for_event_fsync
compaction::tests::derived_index_rebuild_is_idempotent
state::tests::state_graph_rebuilds_from_events
state::tests::focus_is_exclusive_during_replay
state::tests::revision_skip_is_rejected
```

### 17.2 Property tests

Use `proptest`. At minimum, implement:

```text
properties::event_round_trip_preserves_value
properties::valid_event_prefix_replays_deterministically
properties::projection_never_emits_orphan_tool_result
properties::projection_emits_complete_batch_in_call_order
properties::accepted_attempt_has_at_most_one_step
properties::committed_turn_is_protocol_complete
properties::reset_projection_contains_no_preboundary_message
properties::compaction_never_removes_source_events
properties::compaction_retirement_is_monotonic_within_reset_epoch
properties::state_checkpoint_equals_full_event_rebuild
properties::artifact_reference_always_resolves
properties::recovery_never_invokes_started_execution
properties::recovery_is_idempotent
properties::rfc8785_hash_is_map_order_independent
```

Generators MUST produce both valid traces and one-mutation invalid traces. The
invalid generator records the expected narrow error class rather than accepting
any failure.

### 17.3 Fuzz targets

Use `cargo-fuzz` with these target names:

```text
fuzz_sse_parser
fuzz_tool_call_accumulator
fuzz_event_json_decoder
fuzz_jsonl_longest_valid_prefix
fuzz_event_state_machine
fuzz_conversation_projection
fuzz_tool_protocol_pairing
fuzz_compaction_source_ranges
fuzz_artifact_line_filters
fuzz_secret_redaction_before_artifact
```

Fuzz assertions include no panic, no unbounded allocation from one frame, no
accepted invalid UTF-8, deterministic replay, no tool result without a call,
and no recovery invocation of a started execution. Seed every target with the
golden fixtures.

### 17.4 Integration and fault-injection tests

```text
tests::fake_provider_multi_step_tool_turn
tests::fake_provider_parallel_fragmented_tools
tests::fake_responses_reasoning_resume
tests::fake_provider_retry_and_supersession
tests::crash_after_every_event_fsync_boundary
tests::crash_after_artifact_commit_before_event
tests::crash_during_recovery_is_idempotent
tests::resume_rejects_second_session_writer
tests::long_session_crosses_multiple_compaction_epochs
tests::model_switch_reformats_portable_history
tests::headless_abort_never_accepts_partial_output
tests::no_network_required_for_protocol_suite
```

`crash_after_every_event_fsync_boundary` runs the same multi-step turn with a
failpoint after each boundary in Section 14.4. It restarts a new process, not
merely a Rust object, and records tool body invocation counts in an independent
test ledger. Every started mutating execution count MUST remain one.

### 17.5 Commands

The minimum local and CI commands are:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo test -p praana-core --test protocol_golden
cargo test -p praana-core --test provider_golden
cargo test -p praana-core --test crash_recovery
cargo test -p praana-core properties::
cargo fuzz run fuzz_sse_parser -- -max_total_time=60
cargo fuzz run fuzz_event_json_decoder -- -max_total_time=60
cargo fuzz run fuzz_event_state_machine -- -max_total_time=60
cargo fuzz run fuzz_conversation_projection -- -max_total_time=60
```

CI runs the full golden and property suites on every change. Scheduled CI runs
all fuzz targets for at least ten minutes each and archives newly discovered
corpora. Provider golden tests use a local fake HTTP/SSE server and no live API
credentials.

## 18. Implementation Packet

Implement in this order. A later packet MUST NOT be used to hide a failing
earlier contract.

### Packet A: DTOs and canonical serialization

- [ ] Add all scalar validators and distinct ID newtypes.
- [ ] Add exact schema 2 DTOs with snake_case tagged enums and unknown-field
  rejection.
- [ ] Add a duplicate-key rejecting JSON decoder.
- [ ] Add RFC 8785 canonical JSON and hash helpers.
- [ ] Add all-kind round-trip and negative Serde fixtures.
- [ ] Freeze `EVENT_SCHEMA_VERSION` and projection/policy version constants.

### Packet B: Event store and replay validator

- [ ] Add restrictive directory/file creation and one-writer lock.
- [ ] Implement append, flush, fsync, acknowledgement, and unhealthy-writer
  behavior.
- [ ] Implement longest-valid-prefix scan, valid missing-LF repair, quarantine,
  and fatal non-final corruption behavior.
- [ ] Implement global sequence/ID/context/reference validation.
- [ ] Implement all six state machines as pure replay reducers.
- [ ] Pass fixtures `01`, `07`, `19`, `20`, and errors `e01` through `e09`.

### Packet C: Accepted projection

- [ ] Build turn, step, attempt, batch, execution, reset, and model replay
  indexes from events. Validate StateGraph/compaction event envelopes through
  their owner schemas, but do not enable those event producers before their
  later phases.
- [ ] Implement exact accepted-message ordering and incomplete-group exclusion.
- [ ] Implement active reset and compaction retirement.
- [ ] Implement active continuation selection. Add active handoff and
  StateGraph projection when their Phase 4/5 owners are enabled.
- [ ] Compare complete projection JSON against the Phase 1 fixtures. Artifact,
  StateGraph, retrieval/search, and compaction fixtures become required in
  Phases 3, 4, and 5 respectively.

### Packet D: Recovery

- [ ] Add open-attempt loss conversion.
- [ ] Add terminal-step commit repair.
- [ ] Add uncertain and skipped-peer result reconstruction for logs without a
  provable finalized artifact.
- [ ] Add deterministic recovery notice templates.
- [ ] Add complete-batch and provider-continuation repair.
- [ ] Add failpoints after every recovery append and prove idempotence.
- [ ] Prove an independently counted started mutation is never invoked twice.

### Packet E: Provider adapters

- [ ] Implement byte-correct SSE parsing for LF, CRLF, comments, multiline data,
  EOF, and split UTF-8.
- [ ] Implement strict fragmented-call accumulation without random IDs or JSON
  repair.
- [ ] Implement OpenAI-compatible Chat Completions request/stream fixtures.
- [ ] Implement OpenRouter reasoning text and usage compatibility fields.
- [ ] Implement Responses ordered items, encrypted continuation, function output,
  usage, and optional previous-response optimization.
- [ ] Implement Phase 2 minimal hard admission: resolve trustworthy model
  windows, account exact request components through `TokenEstimatorV1`, reserve
  output/reasoning space, reject oversized requests before auth/network, and
  bind the estimate to the request/profile hashes.
- [ ] Persist attempt starts before HTTP and failures/acceptance after aggregate
  validation.
- [ ] Implement bounded retries, rate hints, and one emergency context retry.

### Packet F: Phase 3 artifact substrate and tool batches

- [ ] Before enabling a large-output tool, implement the History-owned minimal
  artifact body/provenance transaction, 800/1600 policy, content-aware bounded
  preview, and artifact-before-event durability.
- [ ] Add exact orphan-artifact reconstruction only from the full finalized
  metadata required by Section 14.2; otherwise append an uncertain result.
- [ ] Generate one batch from each accepted tool step.
- [ ] Run pre-hooks in call order and persist every permitted start before any
  body invocation.
- [ ] Execute permitted tools concurrently and allow finish events in completion
  order.
- [ ] Reorder and hash results in call order for batch completion/provider input.
- [ ] Run the full post-hook pipeline and redaction before result finalization.
- [ ] Commit large complete results before event references.
- [ ] Validate artifact existence/hash during replay and before provider calls.

### Packet G: Phase 4 retrieval, search, and StateGraph

- [ ] Add full artifact retrieval and History exact/regex/FTS search.
- [ ] Add StateGraph event projection, ordered mutation queue, checkpoint, tools,
  and current-state request component.
- [ ] Pass StateGraph rebuild, parallel mutation ordering, and source retrieval
  fixtures before enabling pressure compaction.

### Packet H: Phase 5 boundaries and compaction

- [ ] Implement no-active-turn reset and exact epoch behavior.
- [ ] Implement model/reasoning boundary and narrow initial fallback exception.
- [ ] Implement active continuation compatibility and interruption on mismatch.
- [ ] Extend the Phase 2 hard admission path with pressure state, calibration,
  and capability-profile compactor selection.
- [ ] Implement deterministic compaction selection and source hashing.
- [ ] Implement internal compaction attempts and atomic event activation.
- [ ] Rebuild derived indexes after crash without changing canonical events.
- [ ] Pass multiple-epoch, mid-turn, and source-hash fixtures.

## 19. Common Implementation Mistakes

- Reusing the TypeScript `Event` shape with `kind`, `actor`, and arbitrary
  payload. V2 uses a versioned envelope and a typed tagged event.
- Treating timestamp or ULID sort order as replay order. Only `sequence` orders
  events.
- Letting `serde_json` silently accept duplicate object keys. Canonical decoding
  must reject them.
- Omitting null options or empty arrays, causing fixture and hash drift.
- Flattening assistant text, reasoning, and tool calls into separate fields and
  losing provider item order.
- Generating a random call ID when a provider omits one. The correct result is
  `E_TOOL_CALL_ID_MISSING`.
- Repairing malformed tool JSON. The correct result is a failed provider attempt
  and no tool execution.
- Retrying inside one attempt ID. Every network retry is a new durable attempt.
- Retrying after an assistant step was accepted. Acceptance is terminal.
- Executing a tool from partial output before the complete assistant step is
  validated and durable.
- Matching tool results by name or completion array position. Match by call ID
  and validate all other IDs.
- Emitting parallel results in finish-event order. Provider messages use
  assistant call order.
- Appending a start event for a pre-hook-blocked call. A blocked finish has a
  null start reference.
- Invoking the first tool while later permitted start events are not durable.
- Persisting raw result/artifact bytes before secret redaction.
- Appending an artifact reference before its SQLite transaction commits.
- Rerunning a started tool after crash because it was probably read-only or
  probably failed. Started means uncertain; do not rerun automatically.
- Treating an orphan artifact as proof without exact execution and hash metadata.
- Projecting an assistant tool-call message without its complete result batch.
- Using `previous_response_id` as the only copy of Responses continuation.
- Replaying encrypted reasoning into old committed turns, search, compaction, or
  memory.
- Silently dropping incompatible active continuation and continuing the same
  tool cycle.
- Encoding reset/model/compaction behavior as a generic system note.
- Removing compacted source lines or maintaining a mutable compressed-ID
  sidecar. Retirement is event-derived.
- Concatenating all summary segments into the model prompt. Only the latest
  bounded handoff is active.
- Clearing StateGraph mutations merely because their event sequences were in a
  compacted source range.
- Activating compaction before the event fsync completes.
- Treating final JSON corruption as permission to ignore the whole log, or
  truncating a malformed non-final record.
- Adding old-session migration code. Schema 2 rejects old data by design.

## 20. Acceptance Criteria

The protocol implementation is accepted only when all of the following are
true:

- [ ] Every Rust DTO and JSON encoding exactly matches Section 5, including null
  options, enum tags, naming, and unknown-field rejection.
- [ ] Every event append is fsynced before acknowledgement and sequence is the
  sole replay order.
- [ ] All legal transitions in Section 9 pass and every invalid transition
  returns its stable code without appending.
- [ ] Accepted projection is deterministic and emits no failed partial output,
  orphan result, incomplete tool group, retired source turn, or incompatible
  continuation.
- [ ] Parallel tool finish order does not affect provider message order.
- [ ] Every result matches exactly one accepted call by ID and complete context.
- [ ] OpenAI-compatible and Responses golden request/stream fixtures pass at all
  relevant byte splits.
- [ ] Responses encrypted reasoning survives the active tool cycle and is absent
  from historical replay, search, compaction input, and memory input.
- [ ] A provider retry always has a fresh attempt and no accepted attempt is
  retried.
- [ ] Crash injection after every durable boundary resumes without invented
  completion, lost valid records, duplicate mutation, or automatic rerun of a
  started tool.
- [ ] Final malformed JSON is quarantined without hiding earlier valid events;
  malformed non-final JSON stops replay without truncation.
- [ ] Every durable artifact reference resolves and hashes correctly before its
  event is model-visible.
- [ ] Reset, model change, reasoning change, compaction, and continuation
  compatibility obey their explicit boundaries.
- [ ] Compaction selects complete committed turns, preserves source evidence,
  activates only after fsync, and exposes one bounded current handoff.
- [ ] StateGraph rebuild from events equals the validated checkpoint projection.
- [ ] All fixtures in Section 16, tests in Section 17, workspace formatting,
  Clippy, and full tests pass with no network access for protocol tests.
- [ ] No compatibility reader, classic compiler, default memory database,
  embedding dependency, or TypeScript event shape is introduced.

Passing compilation alone is not acceptance evidence. The event, provider,
projection, persistence, and fault-injection suites are all release gates for
the Rust v2 canonical protocol.

## Appendix A. Normative Error Mapping

### A.1 Mapping rules

Internal domain codes are not a shared wire enum. Every boundary maps them
through this appendix:

- A provider or compaction attempt persisted as `ProtocolError` uses the listed
  canonical `E_*` code, `ErrorClass`, retryability, and actual HTTP status when
  one exists.
- A tool call uses the listed `ToolResultStatus` and Tool Runtime `TOOL_*` code
  in its canonical result body. It does not rename that code to a provider
  adapter code.
- A direct headless/core command reports the canonical `E_*` code and class.
- IPC always uses `ok = false` and an `IPC_*` wrapper code selected by section
  A.7. It may include the redacted canonical domain code in bounded details. An
  IPC code is never persisted as a canonical event error merely because the UI
  observed it.
- `http_status` is the actual validated provider HTTP status for provider
  failures and JSON null for local failures. A mapping table never invents an
  HTTP status.
- `conditional` retryability means the named guard in the owning specification
  must pass. Human error prose never makes a failure retryable.

The `Status` column is the canonical tool-result status when the failure occurs
inside a tool call. `n/a` means the failure terminates or rejects another
boundary and no tool result is synthesized.

### A.2 Provider domain

| Internal provider code(s) | Canonical code | Class | Status | Retryable |
|---|---|---|---|---|
| `transport_error` | `E_PROVIDER_STREAM` | `transport` | n/a | Conditional: transient and before emission |
| `provider_timeout` | `E_PROVIDER_TIMEOUT` | `timeout` | n/a | Conditional: before emission |
| `provider_rate_limited` | `E_PROVIDER_RATE_LIMIT` | `rate_limit` | n/a | Conditional: before emission |
| `auth_missing`, `provider_auth_failed`, `provider_permission_denied` | `E_PROVIDER_AUTH` | `authentication` | n/a | No |
| `provider_context_length` | `E_PROVIDER_CONTEXT_LENGTH` | `context_length` | n/a | One emergency admission retry |
| `canonical_request_invalid`, `unsupported_protocol`, `unsupported_option`, `unsupported_content`, `base_url_invalid`, `header_invalid`, `header_forbidden`, `request_serialize_failed` | `E_PROVIDER_REQUEST_INVALID` | `invalid_request` | n/a | No |
| `request_admission_denied` | `E_PROVIDER_REQUEST_INVALID` | `policy` | n/a | No |
| `request_admission_loop` | `E_ADMISSION_ACCOUNTING` | `internal` | n/a | No |
| `context_overflow` | `E_ACTIVE_TURN_TOO_LARGE` | `context_length` | n/a | Only after caller narrows protected content |
| `tool_call_id_missing` | `E_TOOL_CALL_ID_MISSING` | `invalid_provider_output` | n/a | No |
| `tool_arguments_invalid` | `E_TOOL_ARGUMENTS_INVALID` | `invalid_provider_output` | n/a | No |
| `unsupported_output_item`, `provider_empty_response` | `E_PROVIDER_OUTPUT_UNSUPPORTED` | `invalid_provider_output` | n/a | No |
| `provider_content_filter` | `E_PROVIDER_CONTENT_FILTER` | `invalid_provider_output` | n/a | No |
| `continuation_unavailable` | `E_CONTINUATION_MISSING` | `invalid_provider_output` | n/a | No |
| `continuation_incompatible` | `E_CONTINUATION_INCOMPATIBLE` | `invalid_request` | n/a | No |
| `stream_invalid_utf8`, `sse_frame_too_large`, `stream_invalid_json`, `protocol_violation`, `stream_truncated`, `provider_response_failed` | `E_PROVIDER_STREAM` | `invalid_provider_output` | n/a | Only when OpenAI's explicit pre-emission rule says yes |
| `provider_bad_request`, `provider_not_found`, `provider_conflict`, `provider_payload_too_large` | `E_PROVIDER_REQUEST_INVALID` | `invalid_request` | n/a | No |
| `provider_unavailable`, `provider_server_error` | `E_PROVIDER_STREAM` | `transport` | n/a | Only when profile-classified and before emission |
| `continuation_id_rejected` | `E_CONTINUATION_INCOMPATIBLE` | `invalid_request` | n/a | One stateless fallback only |
| `aborted` | `E_PROVIDER_CANCELLED` | `cancelled` | n/a | No automatic retry |

### A.3 Tool domain

| Internal Tool Runtime code(s) | Canonical result code | Class | Status | Retryable |
|---|---|---|---|---|
| `ToolUnknown`, `ToolInvalidJson`, `ToolSchemaInvalid`, `ToolInputTooLarge`, `ToolUnsupported` | Corresponding `TOOL_*` enum string | `validation` | `error` | No |
| `ToolUnavailable` | `TOOL_UNAVAILABLE` | `unavailable` | `error` | Conditional on capability becoming available |
| `ToolPlanBlocked`, `ToolRiskDeclined`, `ToolRiskHeadlessDenied`, `ToolCircuitOpen` | Corresponding `TOOL_*` enum string | `policy` | `blocked` | No automatic retry |
| `ToolValidationFailed`, `ToolPathNotFound`, `ToolPathOutsideWorkspace`, `ToolPathUnread` | Corresponding `TOOL_*` enum string | `validation` | `error` | No |
| `ToolPathBusy` | `TOOL_PATH_BUSY` | `conflict` | `blocked` | Yes after conflicting call finishes |
| `ToolCancelled` | `TOOL_CANCELLED` | `cancelled` | `cancelled` | Only after a new caller decision |
| `ToolTimedOut` after proven cleanup | `TOOL_TIMED_OUT` | `timeout` | `error` | Only after a new caller decision |
| Uncooperative side-effect-capable timeout | `E_TOOL_SIDE_EFFECT_UNCERTAIN` | `process_crash` | `uncertain` | No; runtime is poisoned |
| `ToolPanicked` | `TOOL_PANICKED` | `process_crash` | `error` or `uncertain` if effects cannot be disproved | No automatic retry |
| `ToolIoFailed`, `ToolProcessSpawnFailed`, `ToolProcessExitNonzero`, `ToolProcessOutputLimit`, `ToolSerializationFailed`, `ToolArtifactFailed`, `ToolInternal` | Corresponding `TOOL_*` enum string | `internal` | `error` | No automatic retry after a durable start |
| `ToolRedactionFailed` | `TOOL_REDACTION_FAILED` | `integrity` | `error` | No |
| `MemoryUnavailable`, `MemoryTimeout`, `MemoryCancelled`, `MemoryInvalidInput`, `MemoryNotFound`, `MemoryPluginFailed` | Corresponding `MEMORY_*` enum string | `unavailable`, `timeout`, `cancelled`, `validation`, `not_found`, or `internal` respectively | `error` except cancellation is `cancelled` | Per Memory plugin policy; never retry invisibly inside a tool result |
| Durable start without provable final result | `E_TOOL_SIDE_EFFECT_UNCERTAIN` | `process_crash` | `uncertain` | No |
| Unstarted call skipped for uncertain peer | `E_TOOL_SKIPPED_UNCERTAIN_PEER` | `policy` | `skipped` | No automatic retry |

`TOOL_REDACTION_FAILED` is the only redaction-failure spelling on the internal
tool and canonical tool-result surfaces. History Storage may report a storage
failure while persisting that safe replacement, but MUST NOT emit a second
redaction code.

### A.4 History Storage domain

| Internal History code(s) | Canonical code | Class | Status | Retryable |
|---|---|---|---|---|
| `HISTORY_CANCELLED` | `E_HISTORY_CANCELLED` | `cancelled` | n/a | Yes for a new operation |
| `HISTORY_SESSION_LOCKED` | `E_SESSION_LOCKED` | `conflict` | n/a | Yes |
| `HISTORY_INSECURE_PERMISSIONS`, `HISTORY_META_MISMATCH` | `E_SESSION_INTEGRITY_FAILED` | `integrity` | n/a | No |
| `HISTORY_SCHEMA_UNSUPPORTED` | `E_SCHEMA_VERSION_UNSUPPORTED` | `validation` | n/a | No |
| `HISTORY_EVENT_INTEGRITY` | Narrow replay `E_JSONL_*`, `E_EVENT_*`, or `E_REFERENCE_*`; otherwise `E_SESSION_INTEGRITY_FAILED` | `integrity` | n/a | No |
| `HISTORY_SQLITE_BUSY` | `E_HISTORY_BUSY` | `conflict` | n/a | Yes |
| `HISTORY_SQLITE_PRAGMA_FAILED` | `E_HISTORY_UNAVAILABLE` | `unavailable` | n/a | No in this process |
| `HISTORY_CANONICAL_DB_CORRUPT` | `E_SESSION_INTEGRITY_FAILED` | `integrity` | n/a | No |
| `HISTORY_DANGLING_ARTIFACT` | `E_ARTIFACT_MISSING` or `E_ARTIFACT_HASH_MISMATCH` | `integrity` | n/a | No |
| `HISTORY_ARTIFACT_NOT_FOUND` | `E_ARTIFACT_NOT_FOUND` | `not_found` | `error` when called as a tool | No |
| `HISTORY_ARTIFACT_RANGE`, `HISTORY_JSON_POINTER`, `HISTORY_REGEX_INVALID`, `HISTORY_REGEX_UNSUPPORTED`, `HISTORY_SEARCH_QUERY` | `E_HISTORY_QUERY_INVALID` | `validation` | `error` when called as a tool | No |
| `HISTORY_ARTIFACT_TOO_LARGE` | `E_HISTORY_RESULT_TOO_LARGE` | `validation` | `error` when called as a tool | Yes with a narrower request |
| `HISTORY_PREVIEW_BOUND` | `E_HISTORY_RESULT_TOO_LARGE` | `validation` | `error` for the source tool | No in current artifact policy |
| `HISTORY_SEARCH_CURSOR_STALE` | `E_HISTORY_CURSOR_STALE` | `conflict` | `error` when called as a tool | Yes from a fresh first page |
| `HISTORY_ROLLBACK_CONFLICT` | `E_TOOL_SIDE_EFFECT_UNCERTAIN` | `integrity` | `uncertain` for the source tool | No; session is poisoned |
| `HISTORY_OPERATIONAL_RECOVERY_UNCERTAIN` | `E_TOOL_SIDE_EFFECT_UNCERTAIN` | `process_crash` | `uncertain` for the source tool | No; session is poisoned |
| `HISTORY_IO` | `E_EVENT_DURABILITY_UNCERTAIN` when append began; otherwise `E_HISTORY_PERSISTENCE` | `persistence` | n/a | Only after recovery determines outcome |

### A.5 Admission, compaction, and token accounting

| Internal code(s) | Canonical code | Class | Status | Retryable |
|---|---|---|---|---|
| `ADMISSION_CONTEXT_WINDOW_UNKNOWN` | `E_ADMISSION_CONTEXT_WINDOW_UNKNOWN` | `validation` | n/a | No until profile/config changes |
| `ADMISSION_ARITHMETIC_OVERFLOW`, `TOKEN_ACCOUNTING_OVERFLOW` | `E_ADMISSION_ACCOUNTING` | `internal` | n/a | No |
| `ADMISSION_ACTIVE_CONTEXT_TOO_LARGE`, `TOKEN_BOUND_EXCEEDED` for protected request content | `E_ACTIVE_TURN_TOO_LARGE` | `context_length` | n/a | Yes only after caller narrows protected content |
| `ADMISSION_PROVIDER_CONTEXT_REJECTED` | `E_PROVIDER_CONTEXT_LENGTH` | `context_length` | n/a | No after emergency retry |
| `TOKEN_INVALID_UTF8`, `TOKEN_PROFILE_UNKNOWN`, `TOKEN_PROFILE_FIXTURE_FAILED` with no fallback | `E_ADMISSION_ACCOUNTING` | `validation` | n/a | No in current configuration |
| `TOKEN_INPUT_HASH_MISMATCH` | `E_ADMISSION_ACCOUNTING` | `conflict` | n/a | Yes after re-estimation |
| `COMPACTION_NO_ELIGIBLE_TURNS`, `COMPACTION_MISSING_TOKEN_MASS` | `E_COMPACTION_RANGE_INVALID` | `validation` | n/a | Conditional on new committed history/re-estimation |
| `COMPACTION_UNAVAILABLE` | `E_COMPACTION_UNAVAILABLE` | `unavailable` | n/a | No until capability/config changes |
| `COMPACTION_CANCELLED` | `E_COMPACTION_CANCELLED` | `cancelled` | n/a | Yes only from a new trigger |
| `COMPACTION_TIMEOUT` | `E_COMPACTION_TIMEOUT` | `timeout` | n/a | Conditional on retry policy |
| `COMPACTION_PROVIDER` | Mapped provider `E_*` code | Provider mapping | n/a | Provider mapping |
| `COMPACTION_PARSE`, `COMPACTION_SCHEMA`, `COMPACTION_PROVENANCE` | `E_COMPACTION_CANDIDATE_INVALID` | `invalid_provider_output` | n/a | One schema repair within the attempt |
| `COMPACTION_SOURCE_CHANGED` | `E_COMPACTION_SOURCE_HASH_MISMATCH` | `conflict` | n/a | Yes with fresh snapshot and attempt |
| `COMPACTION_PERSISTENCE` | `E_EVENT_DURABILITY_UNCERTAIN` | `persistence` | n/a | Only after recovery determines outcome |
| `COMPACTION_DERIVED_STALE` | `E_HISTORY_DERIVED_STALE` | `persistence` | n/a | Yes; canonical activation remains active |

### A.6 StateGraph domain

State service codes are retained in redacted `ToolErrorDto.details.state` and
map to the outer tool result as follows. They are not substituted directly for
the outer `ToolErrorCode`.

| Internal state code(s) | Outer tool code | Class | Status | Retryable |
|---|---|---|---|---|
| `STATE_NOT_FOUND` | `TOOL_VALIDATION_FAILED` | `not_found` | `error` | No |
| `STATE_RETRACTED`, `STATE_KIND_MISMATCH`, `STATE_INVALID_TRANSITION`, `STATE_INVALID_SOURCE`, `STATE_DUPLICATE_ID`, `STATE_NO_CHANGE`, `STATE_FOCUS_INVALID`, `STATE_FIELD_LIMIT`, `STATE_OBJECT_LIMIT` | `TOOL_VALIDATION_FAILED` | `validation` | `error` | No |
| `STATE_REVISION_CONFLICT`, `STATE_GRAPH_SEQUENCE_CONFLICT`, `STATE_CURSOR_STALE` | `TOOL_VALIDATION_FAILED` | `conflict` | `error` | Yes after a fresh snapshot |
| `STATE_ACTIVE_BUDGET_EXCEEDED` | `TOOL_VALIDATION_FAILED` | `context_length` | `error` | Yes after explicit tiering |
| `STATE_CANCELLED` | `TOOL_CANCELLED` | `cancelled` | `cancelled` | Yes for a new operation |
| `STATE_PERSISTENCE` | `TOOL_INTERNAL` | `persistence` | `error` | Only after recovery determines outcome |
| `STATE_PROJECTION_INTEGRITY` | `TOOL_INTERNAL` or replay `STATE_PROJECTION_INTEGRITY` | `integrity` | `error` in a tool | No |

### A.7 IPC domain

IPC framing/connection errors remain IPC-only wrapper codes:

| IPC condition or mapped class | IPC code | Retryable |
|---|---|---|
| Malformed, oversized, non-UTF-8, invalid envelope/payload, unknown command | Existing narrow `IPC_BAD_FRAME`, `IPC_FRAME_TOO_LARGE`, `IPC_INVALID_UTF8`, `IPC_INVALID_ENVELOPE`, `IPC_INVALID_PAYLOAD`, or `IPC_COMMAND_UNKNOWN` | No |
| Version/handshake/capability mismatch | `IPC_VERSION_UNSUPPORTED`, `IPC_HANDSHAKE_REQUIRED`, or `IPC_NOT_SUPPORTED` | No in current connection |
| Duplicate request identity | `IPC_REQUEST_ID_REUSED` | No |
| Local concurrency/backpressure or canonical `conflict` | `IPC_TOO_MANY_REQUESTS`, `IPC_SESSION_BUSY`, or `IPC_BACKPRESSURE` | Yes as documented by IPC |
| Canonical `not_found` | Narrow `IPC_SESSION_NOT_FOUND`, `IPC_TURN_NOT_FOUND`, `IPC_CONFIRMATION_NOT_FOUND`, or `IPC_ARTIFACT_NOT_FOUND` | No unless the referenced object may appear later |
| Canonical `cancelled` | `IPC_CANCELLED` | Yes only for a new operation |
| Canonical `timeout` | `IPC_TIMEOUT` | Conditional on domain mapping |
| Canonical `authentication` | `IPC_AUTH_FAILED` | No until credentials change |
| Canonical `persistence` or uncertain durability | `IPC_DURABILITY_FAILED` | Only after core recovery determines outcome |
| Any other redacted canonical failure | `IPC_INTERNAL` | False unless the domain mapping explicitly says true |

Specialized specifications may define additional internal detail codes, but
each new code MUST add an explicit row to this appendix or to a versioned table
that this appendix names. No specification may claim that provider, tool,
History, admission/compaction, StateGraph, and IPC strings are identical across
all surfaces.
