# PRAANA Rust v2 Tool Runtime Specification

**Status:** Normative design for Rust v2 Phases 3, 4, 6, and 8

**Depends on:** `docs/RUST_V2_PLAN.md`, `docs/RUST_V2_UI_CONTRACT.md`, and the
canonical event, artifact, safety-pipeline, and implementation-phase contracts

**Audience:** Implementers of `praana-core` tools, hooks, shell supervision, artifacts, provider adapters, and tests

## 1. Purpose

This document is the direct and final authority for the Rust v2 internal tool
runtime contract: typed Rust tools, generated deterministic schemas, one ordered
safety pipeline, durable execution events, bounded concurrency, and
cross-platform process-tree supervision. The current loose TypeScript
`defineTool({ description, parameters, execute })` registry is not carried
forward.

History Storage is the direct authority for artifact transactions, preview
generation, rollback journals, and raw shell spool files. Token Accounting is
the direct authority for every inline, batch, preview, and request token
estimate. This runtime supplies finalized result bytes and execution intent to
those owners and does not define competing formats or algorithms.
`docs/RUST_V2_CONFIG_SPEC.md` is the sole authority for tool enablement,
allowed paths, concurrency, timeouts, risk allowlists, circuit values, and all
defaults consumed here.
`docs/RUST_V2_BUILTIN_TOOL_CATALOG_SPEC.md` owns every Phase 3/4 built-in
description and tool-specific input/success DTO; this runtime owns their common
envelope and execution. `docs/RUST_V2_REDACTION_SPEC.md` owns detector bytes,
precedence, traversal, and streaming behavior used at the redaction stage.

The runtime MUST preserve this logical order:

```text
pre-tool:
  plan -> validate -> risk -> circuit -> write lock

execute

post-tool:
  LSP -> verify -> enrich -> redact -> circuit accounting -> write lock release
```

No tool may bypass this pipeline by calling its implementation directly from a provider adapter, slash command, plugin, IPC handler, or test runner. Non-model commands that intentionally reuse a tool MUST call `ToolRuntime::execute_batch` with an explicit origin.

## 2. Design Decisions

- Tool request and response types are Rust structs and enums.
- JSON Schema is generated from request types using Schemars, normalized, and snapshot-tested.
- Provider-visible tool order is explicit and independent of hash-map order, registration timing, capabilities, or filesystem discovery.
- Only core built-ins and core-owned standard memory adapters may register model-visible tools in v1.
- A tool describes capabilities and computes a call-specific `ToolIntent` before safety hooks run.
- Accepted provider tool calls in one assistant step form one batch. Admitted calls execute concurrently within limits.
- Preflight is deterministic in provider call order. Risk confirmations are serialized.
- Mutating paths use non-waiting per-path locks. A conflicting call receives a stable error rather than waiting behind an unknown side effect.
- Tool results are structured DTOs. One finalized `ToolResultDto` is the input
  to deterministic protocol, artifact/preview, provider-result, and UI
  conversions; those outer envelopes do not redefine the internal DTO.
- Redaction is fail-closed before finalized results or artifacts become durable.
- Shell output is captured without blocking the Tokio reactor. Large output is artifactized; raw terminal streaming is disabled by default.
- Unix process groups and Windows Job Objects are mandatory, not optional platform enhancements.

## 3. Module Layout

```text
crates/praana-core/src/tools/
  mod.rs
  contract.rs          # typed and erased traits, DTOs
  registry.rs          # registration, ordering, schema catalog
  runtime.rs           # batch state machine
  result.rs            # canonical serialization and artifactization input
  error.rs             # stable codes
  intent.rs            # effects, paths, risk facts
  locks.rs              # normalized per-path lock table
  cancellation.rs      # session/turn/call cancellation hierarchy
  shell/
    mod.rs
    env.rs
    capture.rs
    unix.rs
    windows.rs
  builtin/
    files.rs
    edit.rs
    search.rs
    tests.rs
    git.rs
    state.rs
    artifacts.rs
    session_search.rs

crates/praana-core/src/hooks/
  mod.rs
  plan.rs
  validate.rs
  risk.rs
  circuit.rs
  lsp.rs
  verify.rs
  enrich.rs
  redact.rs
```

The provider layer receives a read-only `ToolCatalog` and submits `ProviderToolCall` values to `ToolRuntime`. It does not own tool implementations.

## 4. Identifiers and DTO Conventions

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(transparent)]
pub struct ToolName(String);
// ToolCallId, ToolBatchId, and ToolExecutionId are protocol-owned newtypes.
```

Rules:

- Tool names match `^[a-z][a-z0-9_]{0,63}$`.
- Provider call IDs are opaque UTF-8 strings, 1 to 256 bytes.
- A missing or empty provider call ID is rejected at adapter ingress with
  canonical `E_TOOL_CALL_ID_MISSING`. No adapter, runtime, or recovery path
  synthesizes a provider call ID.
- A batch ID and execution ID are core-generated ULIDs.
- Tool names and call IDs are never inferred from array position.
- Public DTOs use `snake_case`, deny unknown fields on input, and use tagged enums.
- All strings reject NUL. Individual argument strings are capped by their schema; a complete raw argument object is capped at 1 MiB before parsing.

## 5. Typed and Erased Tool Traits

The typed trait is normative:

```rust
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{de::DeserializeOwned, Serialize};
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait TypedTool: Send + Sync + 'static {
    type Input: DeserializeOwned + JsonSchema + Send + Sync + 'static;
    type Output: Serialize + JsonSchema + Send + Sync + 'static;

    const NAME: &'static str;
    const ORDER: u16;
    const DESCRIPTION: &'static str;

    fn static_capabilities(&self) -> ToolCapabilities;

    fn inspect(
        &self,
        input: &Self::Input,
        context: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError>;

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: Self::Input,
        cancel: CancellationToken,
    ) -> Result<Self::Output, ToolError>;
}
```

The registry stores only erased adapters:

```rust
#[async_trait]
pub trait ErasedTool: Send + Sync + 'static {
    fn descriptor(&self) -> &ToolDescriptor;

    fn parse_and_inspect(
        &self,
        raw: &serde_json::Value,
        context: &ToolInspectContext,
    ) -> Result<PreparedToolCall, ToolError>;

    async fn execute_erased(
        &self,
        context: ToolExecutionContext,
        prepared: PreparedToolCall,
        cancel: CancellationToken,
    ) -> Result<serde_json::Value, ToolError>;
}
```

`ToolAdapter<T: TypedTool>` implements `ErasedTool`. `PreparedToolCall` contains a type-erased boxed input and the immutable `ToolIntent` produced from that exact input. Runtime code cannot alter input after inspection.

`inspect` MUST be deterministic, side-effect free, non-async, and bounded. It may normalize paths lexically through a core helper, but it MUST NOT read files, resolve network names, spawn processes, ask for confirmation, mutate session state, or rewrite provider arguments. Filesystem existence and symlink checks belong to validation.

## 6. Descriptor and Schema Generation

```rust
pub struct ToolDescriptor {
    pub name: ToolName,
    pub order: u16,
    pub description: String,
    pub strict: bool,
    pub input_schema: serde_json::Value,
    pub output_schema: serde_json::Value,
    pub capabilities: ToolCapabilities,
    pub schema_sha256: Sha256Digest,
}
```

Generation is exact:

1. Generate Schemars Draft 2020-12 schema from `T::Input` and `T::Output`.
2. Inline local `$defs` references. Recursive request schemas are forbidden.
3. Remove non-semantic `title` fields generated from Rust type names.
4. Preserve field descriptions, defaults, enums, numeric bounds, string bounds, and required lists.
5. Set `additionalProperties: false` for every request object. Input structs also use `#[serde(deny_unknown_fields)]`.
6. Sort every JSON object key lexicographically and sort each `required` list lexicographically.
7. Do not sort enum arrays, tuple items, `oneOf`, `anyOf`, or property presentation arrays where order has meaning.
8. Serialize compact UTF-8 JSON with no insignificant whitespace.
9. Hash those bytes with SHA-256 into lowercase hex.
10. Convert the normalized core schema to each provider's supported schema subset in the provider adapter. Provider conversion MUST NOT change the core descriptor or catalog order.

Every built-in v1 descriptor sets `strict = true`. The registry owns this bit;
provider adapters serialize it exactly and MUST NOT infer strictness from the
schema. A future non-strict descriptor requires a Tool Runtime schema-version
change and provider conformance fixtures.

The core schema is the authority. If a provider cannot express a constraint, core still enforces it before `inspect` through Serde plus JSON Schema validation.

Schema generation occurs once at registry build. A schema generation or normalization error is a startup error for a required built-in tool. It is not deferred until a model calls the tool.

Checked-in snapshots cover every initial input schema, the ordered provider catalog, and each provider-specific conversion.

## 7. Capabilities and Call Intent

```rust
bitflags::bitflags! {
    pub struct ToolCapabilities: u32 {
        const READ_FILES       = 1 << 0;
        const WRITE_FILES      = 1 << 1;
        const SPAWN_PROCESS    = 1 << 2;
        const NETWORK_POSSIBLE = 1 << 3;
        const GIT_READ         = 1 << 4;
        const GIT_WRITE        = 1 << 5;
        const STATE_READ       = 1 << 6;
        const STATE_WRITE      = 1 << 7;
        const ARTIFACT_READ    = 1 << 8;
        const MEMORY_READ      = 1 << 9;
        const MEMORY_WRITE     = 1 << 10;
        const LSP_READ         = 1 << 11;
        const LSP_WRITE        = 1 << 12;
    }
}

pub struct ToolIntent {
    pub mutation: ToolMutation,
    pub path_accesses: Vec<PathAccessIntent>,
    pub command: Option<CommandIntent>,
    pub risk_facts: Vec<RiskFact>,
    pub timeout_ms: u64,
    pub idempotency: ToolIdempotency,
}

pub enum ToolMutation {
    PureCompute,
    ReadOnly,
    SessionState,
    Workspace,
    External,
}

pub enum ToolIdempotency {
    ReadOnly,
    IdempotentWrite,
    NonIdempotent,
    Unknown,
}

pub struct PathAccessIntent {
    pub requested: String,
    pub normalized_absolute: std::path::PathBuf,
    pub mode: PathAccessMode,
}

pub enum PathAccessMode {
    Read,
    Write,
}
```

Static capabilities answer what a tool implementation can do. `ToolIntent` answers what one call requests. Safety hooks consume the intent, not ad hoc tool-name sets, except for fixed behavior that is inherently name-specific such as `edit_file` requiring a prior read.

Every path-bearing built-in MUST report all paths, including every file in a batch. Paths are normalized against the session cwd without requiring the target to exist. Validation then resolves the nearest existing ancestor, checks symlink containment, and replaces the lexical path in `PathAccessIntent` with a validated canonical target. The original provider argument remains unchanged for audit.

Shell intent is conservatively `External`, `SPAWN_PROCESS`, `NETWORK_POSSIBLE`, and `NonIdempotent` unless the shell classifier proves it is a read-equivalent or test command for circuit policy. Classification never weakens risk checks for destructive syntax.

## 8. Registry and Deterministic Ordering

```rust
pub struct ToolRegistry {
    by_name: std::collections::BTreeMap<ToolName, std::sync::Arc<dyn ErasedTool>>,
    ordered_names: Vec<ToolName>,
}
```

Registration rules:

- Duplicate names are fatal at startup, even if descriptors are byte-identical.
- Duplicate numeric order values are allowed; the tie-breaker is tool name ascending by ASCII byte.
- Final ordering is `(order ascending, name ascending)`.
- Registration timing, feature discovery, plugin timing, hash seeds, and locale MUST NOT affect order.
- Disabled tools are omitted. Placeholder unavailable tools are not emitted to providers.
- Core standard memory tools reserve their order slots even when absent; absence does not renumber any other tool.
- A catalog hash is SHA-256 over ordered `name + NUL + schema_sha256 + NUL + description` records.
- The exact ordered catalog is part of request cache identity and observability.

No memory plugin or future external extension may inject arbitrary model-visible tools under this contract. A later general tool-plugin design requires a separate security specification.

## 9. Initial Tool Catalog

The following order values are fixed. Phase indicates when a tool first becomes required. Tools whose backing feature is disabled are omitted without shifting other values.

`RUST_V2_BUILTIN_TOOL_CATALOG_SPEC.md` schema 1 supplies implementable schemas
for Phase 3/4 rows. Phase 8 rows below reserve names/orders only; they MUST NOT be
implemented or provider-visible until a later catalog schema defines their exact
request/success DTOs and fixtures. Memory rows import their exact schemas from
the Memory Plugin specification when capability-enabled.

| Order | Tool | Phase | Mutation/capability summary |
|---:|---|---:|---|
| 100 | `search_session_log` | 4 | Session history read |
| 110 | `retrieve_artifact` | 4 | Artifact read |
| 200 | `create_task` | 4 | StateGraph write |
| 210 | `complete_task` | 4 | StateGraph write |
| 220 | `retract_task` | 4 | StateGraph write |
| 230 | `add_constraint` | 4 | StateGraph write, no memory mirror |
| 240 | `decide` | 4 | StateGraph write, no memory mirror |
| 250 | `add_note` | 4 | StateGraph write |
| 260 | `soft_unload` | 4 | StateGraph write |
| 270 | `hard_unload` | 4 | StateGraph write |
| 280 | `hydrate` | 4 | StateGraph write |
| 290 | `list_state` | 4 | StateGraph read |
| 300 | `focus_task` | 4 | StateGraph write |
| 400 | `read_file` | 3 | File read |
| 410 | `write_file` | 3 | Workspace write |
| 420 | `edit_file` | 3 | Workspace write |
| 430 | `batch_write` | 3 | Workspace writes |
| 440 | `batch_edit` | 3 | Workspace writes |
| 500 | `search_code` | 3 | Native file read/search |
| 510 | `find_files` | 3 | Native path search |
| 520 | `code_parse` | 8 | Native file read/parse |
| 530 | `code_imports` | 8 | Native file read/parse |
| 540 | `code_symbols` | 8 | Native file read/parse |
| 550 | `code_definition` | 8 | Native project search |
| 560 | `code_references` | 8 | Native project search |
| 600 | `run_tests` | 3 | Supervised process |
| 700 | `git_status` | 3 | Git read |
| 710 | `git_diff` | 3 | Git read |
| 720 | `git_branches` | 8 | Git read |
| 730 | `git_log` | 8 | Git read |
| 740 | `git_commit` | 8 | Git/workspace write |
| 800 | `lsp_diagnostics` | 8 | LSP read |
| 810 | `lsp_format` | 8 | Workspace/LSP write |
| 820 | `lsp_hover` | 8 | LSP read |
| 830 | `lsp_completions` | 8 | LSP read |
| 840 | `lsp_definition` | 8 | LSP read |
| 850 | `lsp_references` | 8 | LSP read |
| 860 | `lsp_code_actions` | 8 | LSP read |
| 870 | `lsp_apply_code_action` | 8 | Workspace/LSP write |
| 900 | `load_skill` | 8 | Instruction file read |
| 1000 | `recall` | 6 | Optional standard memory read |
| 1010 | `remember` | 6 | Optional standard memory write |
| 1020 | `retract_memory` | 6 | Optional standard memory write |
| 1100 | `shell` | 3 | Supervised external process |

`context_summary` and `event_lineage` are not initial v2 tools. Their useful behavior is covered by `list_state`, `search_session_log`, and artifact provenance. Add them later only if measured tasks require them.

`read_and_summarize` is not ported. `read_file`, native symbols/imports, and artifact previews provide the retained behavior without a regex-only language parser.

Phase 3 exit requires orders 400 through 510, 600, 700, 710, and 1100 plus the
minimal History-owned artifact substrate required by their output policy. Phase
4 adds full history search, artifact retrieval, and StateGraph tools. Phase 6
adds capability-gated memory tools. Phase 8 adds the remaining parity tools.
When `tools.shell_enabled` is false, `shell` is omitted from the catalog; no
placeholder tool is registered. `tools.allowed_paths` extends path validation
roots exactly as the Config specification defines.

## 10. Provider Call Input

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProviderToolCall {
    pub tool_call_id: ToolCallId,
    pub tool_name: ToolName,
    pub arguments: serde_json::Value,
    pub provider_ordinal: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolBatchRequest {
    pub batch_id: ToolBatchId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub attempt_id: AttemptId,
    pub calls: Vec<ProviderToolCall>,
    pub origin: ToolCallOrigin,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallOrigin {
    Model,
    SlashCommand,
    HeadlessCommand,
}
```

Calls are ordered by `provider_ordinal`; duplicate ordinals or call IDs are protocol errors and the batch is not executed. The accepted assistant step containing model calls MUST be durable before batch admission starts.

Unknown tool, malformed JSON, oversized input, and schema failures become per-call tool results so the provider can recover. They do not fail sibling calls or the process.

## 11. Exact Tool Result Contract

Tool implementations return their typed output only on success. The runtime creates the common envelope:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolResultDto {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolErrorDto>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ToolWarningDto>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<ArtifactRef>,
    pub meta: ToolResultMeta,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ToolErrorDto {
    pub code: ToolErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolWarningDto {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolResultMeta {
    pub tool_call_id: ToolCallId,
    pub tool_name: ToolName,
    pub duration_ms: u64,
    pub cancelled: bool,
    pub timed_out: bool,
    pub redacted: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BinaryEncoding { Base64 }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BinaryDataV1 {
    pub encoding: BinaryEncoding,
    pub data: String,
    pub sha256: Sha256Digest,
    pub byte_count: u64,
}
```

Exact rules:

- Success is `ok=true`, non-null `data`, and absent `error`.
- Failure is `ok=false`, absent `data`, and one `error`.
- Tool-specific success structs serialize under `data`; they MUST NOT define another `ok` field.
- Warnings never flip success to failure.
- `details` contains bounded machine-readable fields only. It never contains a backtrace, panic payload, credential, or full raw output.
- Result strings are valid UTF-8. Non-UTF-8 bytes are stored in an artifact and
  represented by metadata plus the History-owned binary preview.
- All floats must be finite. Non-finite values are a tool serialization failure.

The `skip_serializing_if` attributes above are intentional and fully define this
internal DTO's compact shape: success omits `error`, failure omits `data`, and
empty warnings/artifacts are omitted. This is not a canonical event DTO and does
not override the protocol rule that canonical event option fields are present as
null. All present fields are required on deserialization unless an explicit
`#[serde(default)]` is shown. Protocol ID newtypes are used at every runtime,
History, provider, and event boundary.

Canonical serialization uses RFC 8785 JSON Canonicalization Scheme, preserves
array order, and emits no trailing newline. Values outside RFC 8785's exact
interoperable number domain are rejected before serialization. Tests pin exact
bytes. Non-spooled in-memory results are capped at 1 MiB. Shell/test and other
explicitly spooled results may reach their documented capture limit and are
streamed through redaction/canonical artifact storage without assembling one
unbounded JSON string in memory. Normal inline admission is governed by History
Storage's artifact policy.

These RFC 8785 bytes are named `canonical_tool_result_bytes` and are the sole
complete tool-result payload consumed by History Storage. Their media type is
exactly `application/vnd.praana.tool-result+json;version=1`. Their SHA-256,
byte count, and token estimate always describe the complete finalized
post-redaction `ToolResultDto`, never an extracted stdout string or preview.
Binary/non-UTF-8 tool output is represented inside tool-specific `data` by
`BinaryDataV1`. `data` is RFC 4648 standard-alphabet base64 with required
padding, `sha256` describes decoded bytes, and `byte_count` equals decoded size.
Large outer canonical JSON is then artifactized as one complete result by
History, avoiding a circular child-artifact reference. The outer result is
always valid canonical JSON.

Protocol `ToolResultMessage` adds canonical call/turn/batch identity, status,
hash/counts, and either the complete inline canonical bytes or the History-owned
artifact preview/reference. The provider receives the exact inline canonical
JSON string or deterministic preview string. The UI
Contract owns the one semantic UI conversion; IPC only serializes it and a UI
may derive compact presentation. There is no separate shell-only, IPC-only, or
TUI-only internal result shape.

## 12. Stable Error Codes

These are internal `ToolErrorCode` variants and canonical tool-result body codes,
not provider, History, StateGraph, or IPC strings.
`RUST_V2_PROTOCOL_SPEC.md` Appendix A normatively maps them to canonical
`ErrorClass`, `ToolResultStatus`, and retryability; the UI Contract maps the
resulting semantic failure to `CoreErrorDto`. IPC does not rename it.

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ToolErrorCode {
    ToolUnknown,
    ToolInputTooLarge,
    ToolInvalidJson,
    ToolSchemaInvalid,
    ToolUnavailable,
    ToolUnsupported,
    ToolPlanBlocked,
    ToolValidationFailed,
    ToolPathNotFound,
    ToolPathOutsideWorkspace,
    ToolPathUnread,
    ToolPathBusy,
    ToolRiskDeclined,
    ToolRiskHeadlessDenied,
    ToolCircuitOpen,
    ToolCancelled,
    ToolTimedOut,
    ToolPanicked,
    ToolIoFailed,
    ToolProcessSpawnFailed,
    ToolProcessExitNonzero,
    ToolProcessOutputLimit,
    ToolSerializationFailed,
    ToolRedactionFailed,
    ToolArtifactFailed,
    ToolInternal,
    MemoryUnavailable,
    MemoryTimeout,
    MemoryCancelled,
    MemoryInvalidInput,
    MemoryNotFound,
    MemoryPluginFailed,
}
```

JSON enum values are uppercase snake case, for example `TOOL_PATH_BUSY`.
Existing TypeScript prose errors are not stable API. Rust v2 tests assert codes
first and user-safe message fragments second. Other surfaces map these codes;
they do not claim identical strings.

## 13. Batch State Machine

```text
Received
  -> AcceptedAssistantStepVerified
  -> CallsAnnounced
  -> ParsedAndInspected
  -> Preflighted(plan, validate, risk, circuit)
  -> LocksAcquired
  -> StartsDurable
  -> Executing
  -> PostProcessing
  -> ResultsDurable
  -> BatchDurable
  -> ReadyForProviderContinuation
```

Any call can instead become `Rejected`, `CancelledBeforeStart`, or `Failed`. The batch reaches `BatchDurable` only after every accepted call has one durable final result or rejection result.

### 13.1 Admission algorithm

1. Verify the accepted assistant step and all call IDs.
2. Emit `UiEvent::ToolCallPending` for every call in provider order using
   redacted display arguments.
3. Look up descriptors, enforce raw size, validate schema, deserialize, and call `inspect` in provider order.
4. Run plan, validation, risk, and circuit for each prepared call in provider order. Risk confirmation requests are serialized by one session confirmation queue. No path lock is held while waiting for confirmation.
5. Calls blocked before write-lock acquisition receive a finalized error result with `execution_started=false`.
6. Acquire validated path locks for remaining calls in provider order. For a multi-path call, sort unique platform-normalized lock keys ascending and acquire all or none.
7. Capture any required pre-edit LSP diagnostic snapshot while the write lock is held. This is preparation for the first post stage, not another safety gate.
8. Append and fsync `ToolExecutionStarted` records in provider order for all calls that will execute.
9. Start admitted implementations concurrently, subject to semaphores.

Preflight for later calls continues after an earlier call is rejected. A declined risk prompt does not cancel safe siblings. Application or turn cancellation stops new preflight and yields `TOOL_CANCELLED` for calls not started.

### 13.2 Concurrency

Initial concurrency limits are `tools.max_parallel_calls` and
`tools.max_spawned_processes`; their exact defaults, ranges, and hard maxima are
owned by the Config specification. LSP mutation concurrency is a fixed
single-call Phase 8 invariant until a future Config specification accepts an
LSP key. The batch task set uses `JoinSet`; one child failure cannot cancel
siblings unless the shared turn token is cancelled.

Results may finish in any order. `ToolExecutionFinished` sequence reflects actual finalization order. `ToolBatchCompleted` contains call IDs in provider order and references each finish/rejection event. The provider continuation receives results in provider order regardless of completion order.

The UI addresses rows by `tool_call_id`, never completion position.

Calls with `STATE_WRITE` are admitted with siblings but execute their mutation
portion through the one per-session StateGraph mutation queue. Queue order is
provider order, not semaphore acquisition or task wake order. A state call takes
its graph-sequence/revision snapshot only at queue head after all earlier ordered
state mutations have committed, then holds the session writer through event
append. Convenience tools therefore observe prior same-batch state revisions;
explicit caller-supplied stale revisions still fail. Non-state calls remain
concurrent. StateGraph owns the exact snapshot and revision rules.

### 13.3 Per-path locking

Lock keys are canonical absolute paths with platform-aware case handling:

- Unix: canonical bytes after nearest-existing-ancestor symlink resolution; case-sensitive.
- Windows: verbatim absolute path with drive letter uppercased, separators normalized, and case folded for the lock key.
- macOS: use the filesystem-resolved canonical path; do not assume case sensitivity from the OS name.

Rules:

- A write conflicts with any read or write lock on the same key.
- A read conflicts with a write lock on the same key.
- Reads on the same key may coexist.
- Workspace write tools acquire write locks.
- `read_file`, file code-intel, LSP reads, and direct path search roots acquire read locks when they address one file. Project-wide searches do not lock every discovered file; they use snapshot-tolerant semantics.
- Two calls in one batch targeting the same path conflict. The earlier provider-ordered admitted call wins; the later receives `TOOL_PATH_BUSY` without waiting.
- A batch tool deduplicates paths internally. Multiple sequential edits to one path are one write lock.
- Locks are session-runtime locks, not OS file locks. External edits are detected through file identity/mtime checks where relevant.

An RAII `PathLease` is held through all post stages and released last. The explicit release stage records metrics; `Drop` is a panic/cancellation backstop. Tests must prove the lock is gone after every exit path.

## 14. Exact Hook Pipeline

Hooks are core internal components, not externally registered callbacks in v1. Their order is a typed tuple/explicit calls in `ToolRuntime`, not a mutable vector whose registration order can drift.

### 14.1 Pre stage 1: plan

- If user-armed plan mode is off, continue.
- If on, block `Workspace`, `External`, and mutating `SessionState` calls according to the plan-mode tool policy.
- Read-only calls continue.
- Explicit plan execution/approval transitions plan mode before a batch, never midway through one.
- Error: `TOOL_PLAN_BLOCKED`.

### 14.2 Pre stage 2: validate

Validation includes:

- JSON Schema and typed parse already succeeded.
- Required paths exist for read/edit operations.
- Write parents resolve safely and comply with workspace/sandbox policy.
- Symlinks cannot escape allowed roots through an existing ancestor.
- `edit_file` requires the file to have been read in the session when the read index is active.
- `old_text` is non-empty and uniquely present; batch edits are simulated sequentially before writes.
- Shell cwd exists and is allowed.
- Shell first executable is a shell builtin or is discoverable on the sanitized `PATH`, unless command syntax starts with an assignment or explicit path.
- Limits for regex, glob, line range, result count, file size, and timeout.

Validation never prompts and never mutates. Error enrichment suggestions are not generated here unless needed to explain the immediate block.

### 14.3 Pre stage 3: risk

Risk classes are fixed initially and are the exact enum accepted by
`risk.allow` in the Config specification:

```text
rm
git_reset
git_force_push
git_clean
gh_issue_close
gh_pr_merge
package_install
write_outside_cwd
```

The classifier consumes typed intent plus shell/git syntax. It never lowers a class based on model prose. TTY calls issue a confirmation request. Headless calls fail closed unless the class is in `[risk].allow`. Approval applies only to one tool call ID and exact canonical argument hash. Error: `TOOL_RISK_DECLINED` or `TOOL_RISK_HEADLESS_DENIED`.

### 14.4 Pre stage 4: circuit

- Read-only tools, read-equivalent shell commands, and recognized test commands are exempt.
- Apply `circuit.loop_threshold` to identical mutating `tool name + canonical
  args` calls; the threshold attempt is blocked.
- Apply the same threshold to qualifying errors for one normalized path/command.
- The session token/wall budget gate consumes `circuit.max_tokens` and
  `circuit.max_wall_ms` outside an individual call before a new model step; it
  does not partially reject one parallel batch already accepted.
- Error: `TOOL_CIRCUIT_OPEN`.

### 14.5 Pre stage 5: write lock

Acquire all `PathLease` locks as specified in section 13.3. No tool implementation starts before its `ToolExecutionStarted` event is durable.

### 14.6 Execute

Execution receives only:

- Session and turn IDs.
- Validated cwd/workspace roots.
- Narrow service handles declared by the built-in implementation, such as artifact store, StateGraph, native search, or process supervisor.
- A per-call cancellation token and deadline.
- The typed request.

It does not receive provider credentials, provider adapters, the IPC writer, or the full session controller.

The runtime wraps execution in deadline and panic containment. A timeout
cancels and invokes tool-specific cleanup. It yields `TOOL_TIMED_OUT` only when
the task joined or side-effect cleanup is proved. An uncooperative
side-effect-capable task follows section 16, records uncertain execution, and
poisons the session/runtime. A panic yields `TOOL_PANICKED` only when final
effect status is known; otherwise it is uncertain. Panic payload and backtrace
are tracing-only after redaction.

### 14.7 Post stage 1: LSP

For successful edit operations only, after the Phase 8 LSP capability and its
future config contract are implemented:

- Optionally format-on-edit while the path lock is still held.
- Request diagnostics and compute introduced diagnostics against the pre-edit snapshot.
- Add a bounded `lsp` object to success data or add a warning on LSP failure.
- LSP failure does not flip an otherwise successful edit.

### 14.8 Post stage 2: verify

For successful writes/edits only after the Phase 8 verification capability and
its future config contract are implemented. Config schema v1 intentionally
rejects `[verify]`:

- Parse syntax.
- Run scoped typecheck when a project configuration exists.
- Run reverse-import affected tests within configured caps.
- Syntax/type errors skip tests.
- Missing parser/config/runner and timeout are explicit soft-failure fields.
- Add a bounded `verify` object; do not alter the original write result's `ok` solely because verification found project errors.

### 14.9 Post stage 3: enrich

For failed path-bearing calls:

- Add at most five fuzzy path suggestions from tracked repository files and session reads.
- Add at most five recent writes for the same normalized path.
- Never rewrite the primary error code or claim an operation occurred.

For successful read/retrieve calls, this stage may add repeat-read/churn warnings. Warnings are telemetry and guidance, not blocks.

### 14.10 Post stage 4: redact

- Apply `RUST_V2_REDACTION_SPEC.md` version `praana-redaction-v1` exactly to
  every string value in data, errors, warnings, and metadata labels. Object keys
  are detector context and remain unchanged. No History preview exists yet;
  History later derives it only from this finalized redacted value and validated
  redaction metadata.
- Captured process output uses that specification's incremental UTF-8, line,
  fixed-token overlap, and PEM state machine. No local regex/overlap is allowed.
- The detector specification exclusively owns provider-key/private-key/
  assignment patterns and SHA/ULID exemptions.
- Redaction never changes `ok` unless redaction itself fails.
- A redaction panic/error discards the entire unredacted candidate and replaces it with `TOOL_REDACTION_FAILED`. No candidate bytes become an artifact, event, model message, UI event, or log.

### 14.11 Post stage 5: circuit accounting

Record final success/error classification against canonical args. Tool panics, timeouts, validation errors, and process failures count according to circuit policy. Risk declines, plan blocks, cancellation, and path-busy conflicts do not count as implementation failures.

### 14.12 Post stage 6: release

Release all path leases and LSP apply-action extra leases. This stage runs after circuit accounting on success, error, timeout, cancellation, and panic. RAII drop is the backstop, not the normal path.

Post-hook failures are soft except redaction. LSP, verify, and enrich failures become bounded warnings and continue. Circuit-accounting failure is logged and release still runs.

## 15. Artifactization and Result Durability

After the post pipeline releases its path leases:

1. Canonically serialize the finalized redacted result candidate.
2. Submit exact bytes and provider call order to History Storage. History applies
   the config-owned `TokenEstimatorV1` per-result and aggregate batch policy and, when
   required, commits the complete redacted body to `history.db`.
3. Accept the immutable content-aware token-bounded preview and artifact
   reference produced by History Storage. Tool Runtime MUST NOT byte-slice or
   regenerate it.
4. Preserve the internal DTO as the complete stored result; do not mutate it
   into a second artifact-shaped internal DTO.
5. Build protocol `ToolResultMessage` with status, counts, and either inline DTO
   bytes or the History-owned preview/reference.
6. Append and fsync `ToolExecutionFinished` with that canonical message.
7. Emit the equivalent UI event.
8. After all calls finalize, append and fsync `ToolBatchCompleted`.

Artifact commit MUST precede any event containing its reference. Artifact failure yields `TOOL_ARTIFACT_FAILED`; it MUST NOT silently truncate a successful result or append a dangling reference.

Phase 3 creates this minimal History-owned artifact path before any shell,
process, file-read, search, test, or other potentially large-output tool is
enabled. Phase 4 adds full retrieval, exact/FTS search, and StateGraph; Phase 5
adds pressure-triggered compaction. A Phase 3 runtime does not defer artifact
safety to either later phase.

Canonical `ToolExecutionStarted` has exactly the protocol-owned payload: batch,
execution, step/call identity and order, tool name, canonical argument SHA-256,
and protocol mutability. Redacted display arguments and richer intent are
ephemeral UI/telemetry DTOs, not fields added to that canonical payload. It does
not duplicate raw output.

A crash after `ToolExecutionStarted` and before `ToolExecutionFinished` creates an uncertain execution. Resume:

- Never reruns a `Workspace`, `External`, non-idempotent, or unknown call automatically.
- May re-run a read-only call only after an explicit new provider decision, not merely because resume noticed it.
- Adds a recovery notice naming the call ID, tool, paths/command label, and uncertainty.

Calls rejected before execution have a durable final rejection record with `execution_started=false`; they are not uncertain side effects.

## 16. Cancellation and Timeouts

Cancellation is hierarchical:

```text
application token
  -> session token
    -> turn token
      -> batch token
        -> call token
```

Cancelling a parent cancels descendants. A sibling error does not cancel siblings. Risk confirmation uses the call token; cancelling while a prompt is open closes that prompt and returns `TOOL_CANCELLED`.

Timeout policy consumes `tools.default_timeout_ms`, `tools.shell_timeout_ms`,
and `tools.shell_max_timeout_ms`; exact defaults and ranges are owned by the
Config specification:

- Each descriptor/request computes a bounded timeout in `ToolIntent`.
- Runtime hard maxima are the effective config bounds for shell/tests and other
  initial tools unless a narrower tool schema says otherwise.
- Timeout starts when execution obtains its concurrency semaphore, not while waiting for risk confirmation.
- Waiting for a semaphore is cancellable and bounded by the turn deadline.
- Timeout cancellation and process-tree termination complete before a normal
  timeout result is finalized.
- After cancellation, wait the tool-specific cleanup grace, initially one
  second. If the task joins and cleanup reports a proved outcome, finalize that
  outcome.
- A process tool returns a normal timeout only after the Unix process group or
  Windows Job Object is proved terminated and reaped according to section 18.
- A task classified as `SessionState`, `Workspace`, `External`,
  `SPAWN_PROCESS`, non-idempotent, or unknown, or holding any mutable core
  service handle, MUST NEVER be detached while the runtime continues.
- If such a task does not join after cleanup, append a canonical uncertain
  result when the event writer is healthy, include its execution in
  `TurnInterrupted.uncertain_execution_ids` with reason
  `tool_runtime_poisoned`, mark the session/runtime poisoned, cancel siblings,
  refuse further provider/tool/session mutation, and begin controlled process
  shutdown. If the uncertain finish cannot become durable,
  shutdown still proceeds and normal startup recovery derives uncertainty from
  the durable start.
- Detachment is permitted only for a tool statically and call-specifically
  classified `PureCompute`, with no filesystem, network, process, session,
  artifact, StateGraph, plugin, clock-mutation, or other side-effect handle.
  Tests must prove this capability boundary. No initial built-in requires this
  exception.

Rust file operations that cannot be asynchronously cancelled are moved to
`spawn_blocking` for large work and bounded by file size. Dropping a blocking
task is not cancellation. A mutating blocking task is awaited to a proved
boundary or poisons/shuts down the runtime; it is never detached. Temporary
files and History-owned atomic rename/rollback journals reduce uncertainty but
do not waive this rule.

## 17. Panic and Error Containment

- Wrap each implementation and each post stage in `AssertUnwindSafe(...).catch_unwind()`.
- Convert execution panic to `TOOL_PANICKED`.
- Convert serialization panic/error to `TOOL_SERIALIZATION_FAILED`.
- Redaction failure is fail-closed as section 14.10.
- Never include Rust `Debug` formatting of arbitrary inputs in user-visible errors.
- The runtime itself treats failure to append/fsync canonical events as fatal to the active session. It cancels the batch and MUST NOT continue the provider loop with non-durable results.
- SQLite artifact/index errors are per-call until a canonical event append is affected.
- A provider adapter cannot catch and hide a tool durability error.

## 18. Shell Contract

### 18.1 Request and response

```rust
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShellInput {
    pub command: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize, JsonSchema)]
pub struct ShellOutput {
    pub stdout: CapturedStreamDto,
    pub stderr: CapturedStreamDto,
    pub exit: ProcessExitDto,
}

pub struct CapturedStreamDto {
    pub text: String,
    pub bytes: u64,
    pub lines: u64,
    pub utf8_lossy: bool,
}

pub struct ProcessExitDto {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub timed_out: bool,
    pub cancelled: bool,
}
```

`command` is 1 to 128 KiB. `cwd` defaults to session cwd and must pass
workspace/sandbox validation. An omitted timeout resolves to
`tools.shell_timeout_ms`; its minimum and maximum are defined only by the Config
specification.

A non-zero process exit is a successful process launch represented as tool error `TOOL_PROCESS_EXIT_NONZERO`. It includes the complete `ShellOutput` in `error.details` only through artifact references/previews. Tests and provider behavior MUST distinguish spawn/runtime failure from command exit failure.

Timeout uses `TOOL_TIMED_OUT`; cancellation uses `TOOL_CANCELLED`; output hard-limit termination uses `TOOL_PROCESS_OUTPUT_LIMIT`.

### 18.2 Environment sanitization

Build a copy of the parent environment, then remove:

- Every provider credential env name registered by the core provider catalog, including aliases and user-declared provider credential env names.
- `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `COHERE_API_KEY`, and equivalent catalog additions.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, and `AWS_WEB_IDENTITY_TOKEN_FILE`.
- Internal IPC authentication or one-shot bootstrap secrets.
- `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `CDPATH`, `GIT_ASKPASS`, `SSH_ASKPASS`, `SUDO_ASKPASS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, and every `DYLD_*` variable.

Retain `PATH`, `HOME`/user profile, locale, terminal variables, `AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `GH_TOKEN`, and `GITHUB_TOKEN` for current behavior parity. The security documentation MUST state that user shell commands can access retained user tooling credentials. A future stricter shell profile may remove them, but must be explicit rather than silently changing this list.

Set:

```text
PRAANA_TOOL=1
PRAANA_SESSION_ID=<non-secret session ULID>
```

Do not export provider, model, prompt, memory, or artifact content. Environment names are compared case-insensitively on Windows and case-sensitively on Unix, except the fixed denylist is checked in uppercase on all platforms.

### 18.3 Unix supervision

On Linux and macOS:

1. Execute `/bin/bash --noprofile --norc -c <command>`.
2. Use `tokio::process::Command` with piped stdout/stderr, null stdin, sanitized env, and validated cwd.
3. In `pre_exec`, create a new process group with `setpgid(0, 0)`. Failure aborts spawn.
4. Record the PGID before exposing execution as started.
5. On normal exit, drain both pipes to EOF and reap the child.
6. On timeout/cancel, send `SIGTERM` to `-pgid`.
7. Wait 1,000 ms while continuing to drain output.
8. If any group process remains or pipes stay open, send `SIGKILL` to `-pgid`.
9. Wait up to 1,000 ms to reap the leader and 250 ms to finish pipe drains. Then close read handles and finalize.
10. Ignore `ESRCH` during termination. Other signal/reap errors are logged and included as bounded warnings.

Killing only the shell leader is non-conforming. Tests include a grandchild that holds stdout open and a process that ignores `SIGTERM`.

### 18.4 Windows supervision

On Windows:

1. Execute `%COMSPEC% /D /S /C <command>`; default `COMSPEC` is `cmd.exe` when absent.
2. Create a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
3. Create the process suspended with a new process group, assign it to the Job Object, then resume it. Failure to assign terminates the suspended process and reports spawn failure.
4. Capture stdout/stderr through overlapped or Tokio-compatible pipes and null stdin.
5. On timeout/cancel, first attempt `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, process_group_id)` when a console group is available.
6. Wait 1,000 ms while draining.
7. Call `TerminateJobObject` with exit code 124 for timeout or 130 for cancellation.
8. Wait up to 1,000 ms for process and pipe completion, then close handles. Closing the Job Object is the final kill backstop.

Using `child.kill()` without a Job Object is non-conforming because descendants may survive.

### 18.5 Output capture and artifactization

Stdout and stderr are drained concurrently through the History Storage spool API
into the exact user-only `spools/<execution-id>/` layout and manifest defined by
that specification. This prevents pipe deadlock and avoids unbounded RAM. Tool
Runtime does not own a second spool directory, format, permission, fsync, or
startup-GC policy.

Limits:

```text
per stream hard capture limit: 64 MiB
combined hard capture limit: 128 MiB
in-memory capture/redaction accumulator: 64 KiB per stream
```

When a hard limit is reached, terminate the process tree, preserve all bytes captured up to the limit, set explicit truncation metadata, and return `TOOL_PROCESS_OUTPUT_LIMIT`. Never claim complete output.

After process exit:

1. Run streaming redaction over each spool, carrying a 4 KiB overlap between chunks so secrets split at boundaries are caught.
2. Store redacted full streams as one structured shell artifact when artifact policy requires it.
3. Keep stdout/stderr boundaries and byte/line counts in artifact metadata.
4. Decode UTF-8 strictly. For invalid sequences, set `utf8_lossy=true` and keep
   redacted bytes in an `application/octet-stream` artifact. History Storage
   alone selects and renders any binary metadata/sample preview.
5. Ask History Storage to delete raw unredacted spools only after the finalized
   artifact/result durability boundary. On startup, History first reconciles
   canonical attempts/artifacts and proves process identity dead; age alone
   never authorizes spool deletion.

Raw shell output MUST NOT be written directly to the terminal or IPC stream before redaction. UI receives progress events with byte counts and the finalized preview/result. An explicit future unsafe debug mode is out of scope.

## 19. File and Edit Semantics

### 19.1 `read_file`

- UTF-8 text request with optional 1-based `line_start` and positive `line_count`.
- Maximum direct file size is 64 MiB; larger files require bounded ranges.
- Return exact selected text and source line metadata.
- Missing path is `TOOL_PATH_NOT_FOUND`.
- Repeated unchanged reads may return an existing artifact reference plus an explicit `payload_reused=true`; they never pretend bytes were reread.

### 19.2 `write_file`

- Create missing parent directories only inside allowed roots.
- Write a user-only temp file in the target directory, flush it, then atomically rename.
- Preserve existing file permissions when replacing; new files use user-writable non-executable permissions.
- Validate JSON/TOML syntax after preparing content and return a warning without blocking the write.
- On failure before rename, target remains unchanged.

### 19.3 `edit_file`

- Exact byte-string match, not regex.
- `old_text` must occur exactly once.
- The file must have been read in the session when the read index is active.
- Apply through temp-file plus atomic rename while the write lock is held.
- Optional edit confirmation is implemented through the risk/confirmation service with an edit-specific confirmation kind, not direct stdin reads in the tool.

### 19.4 Batch operations

- Validate and simulate all operations before writing.
- Duplicate batch-write paths use last input content, but the result records all requested ordinals and unique changed paths.
- Multiple edits to one file are sequential and may match text introduced by an earlier edit.
- Acquire all unique path locks in sorted order.
- Stage every target through the History Storage write-journal API, then commit.
  Because multi-file filesystem rename is not globally atomic, History owns the
  exact journal directory/DTO, before/staged files, permissions, fsync sequence,
  and cleanup.
- Resume runs History's journal recovery before starting a new tool call. It
  restores old bytes only when file identity plus SHA-256 prove the target is
  still the journal's replacement. An external/user change causes a rollback
  conflict, uncertain execution, and poisoned session; it is never overwritten.

## 20. Event and UI Surface

The runtime emits UI-contract `UiEvent` variants through `UiEventSink`; it never
writes terminal escape sequences or dotted/underscore wire names.

Minimum events:

```text
UiEvent::ToolBatchStarted
UiEvent::ToolCallPending
UiEvent::RiskConfirmationRequested
UiEvent::ToolCallStarted
UiEvent::ToolCallProgress
UiEvent::ToolCallFinished
UiEvent::ToolBatchFinished
UiEvent::SystemNotice
```

`UiEvent::ToolCallProgress` is latest-only and non-canonical. It carries byte
counts, phase, and elapsed time only. Pending/started/finished events carry call
IDs. The UI Contract owns exact payloads, durability references, priorities,
coalescing, and bounded sink failure. UI backpressure may coalesce progress but
never final results.

Canonical event append is a serialized service with restrictive file permissions, append, flush, and fsync semantics from the architecture plan. Tool completion is not visible to the provider until its finish event and any artifact are durable.

## 21. Test Matrix

### 21.1 Trait, schema, and registry

- Typed round trip for every request/response.
- Unknown fields, missing fields, invalid enum, non-finite number, NUL, and size limits.
- Exact normalized schema snapshots and SHA-256.
- Provider schema conversion fixtures.
- Duplicate name rejection.
- Stable order/catalog hash across randomized registration order, feature combinations, locales, and process runs.
- Memory capability insertion without renumbering.

### 21.2 Pipeline order

Use a recording fake for every stage and assert exact traces for:

- Success.
- Plan block.
- Validation block.
- Risk decline/headless denial.
- Circuit block.
- Lock conflict.
- Implementation error.
- Timeout.
- Uncooperative workspace/session/external timeout records uncertainty, poisons
  the runtime, and never detaches into a continuing session.
- Explicitly side-effect-free pure compute timeout is the only detach-capable
  fixture.
- Cancellation before preflight, during confirmation, waiting for semaphore, during execution, and during post.
- Panic in implementation and every post stage.
- Redaction failure replacing the candidate.

No stage after a pre block runs except final result construction. Once a lease is acquired, release always occurs and is last.

### 21.3 Concurrent batches

- All pending UI rows appear before any start/finish.
- Preflight and lock winners follow provider order.
- Independent calls overlap in wall time.
- Same-path later call receives `TOOL_PATH_BUSY`.
- Multi-path acquisition has no deadlock.
- Results return to the provider in call order despite reverse completion.
- Finish events may be completion ordered and batch references are correct.
- One panic/error does not cancel siblings.
- Batch cancellation terminates all process trees and releases all leases.
- StateGraph mutations run through one provider-ordered queue and later
  convenience calls snapshot revisions after earlier mutation commits.

### 21.4 Durability and crash injection

Crash after:

- Accepted assistant step.
- Each pending notification boundary (non-canonical, no recovery effect).
- Each `ToolExecutionStarted` fsync.
- Tool side effect before result.
- Post-redaction before artifact commit.
- Artifact commit.
- Finish event append/fsync.
- Batch-complete append/fsync.

Resume must identify uncertain calls, never rerun side effects, resolve every artifact reference, and never feed a non-durable result to a provider.

### 21.5 Shell Unix

- stdout/stderr concurrency and ordering within each stream.
- Empty output, non-zero exit, signal exit, spawn failure.
- Timeout before output and during output.
- Cancellation before spawn and during execution.
- Child ignores `SIGTERM`.
- Grandchild holds pipe open.
- Grandchild outlives shell leader unless group-killed.
- Output exceeds each hard limit.
- Invalid UTF-8 and split multibyte boundaries.
- Secret split across capture chunks is redacted.
- Provider env keys absent; retained profile/region/GitHub variables present.
- No zombie leader and no live process group after finalization.

### 21.6 Shell Windows

- All general shell cases above on Windows CI.
- Child and grandchild assigned to the Job Object.
- Cancellation and timeout leave no descendant process.
- Assignment failure kills suspended child.
- Paths with spaces and non-ASCII characters.
- Case-insensitive environment stripping.
- Handle-leak count remains stable over 1,000 short commands.

### 21.7 Files, edits, search, tests, and git

- Path traversal and symlink escape on every supported OS.
- Case/drive normalization on Windows.
- Atomic single-file replacement and preserved permissions.
- Exact unique edit and sequential same-file batch edits.
- Rollback journal recovery at every multi-file commit boundary.
- Rollback refuses to overwrite a target whose post-replacement identity/hash
  was changed externally and poisons the source session as uncertain.
- Search ignore rules, bounded results, timeout, and cancellation.
- Test adapter selection and structured count parsing.
- Git read tools never mutate; commit remains gated and never pushes.

### 21.8 Security

- Secret canaries in args, output, nested JSON keys/values, errors, warnings, LSP, verify, and enrich data.
- No unredacted candidate in canonical events, artifacts, IPC, UI sink, tracing, or panic text.
- Raw spools have restrictive permissions and are deleted.
- Tool implementations cannot access provider credentials through context services.
- Risk approval is bound to exact call ID and argument hash and cannot be replayed.

## 22. Implementation Sequence

1. Define IDs, errors, result DTOs, typed/erased traits, and canonical JSON serializer.
2. Implement schema normalization and deterministic registry; check in snapshots.
3. Implement intent/path normalization and validation with property tests.
4. Implement explicit pre/post pipeline with recording fakes, cancellation, panic containment, and RAII leases.
5. At the start of Phase 3, integrate History Storage's minimal complete
   artifact blob/provenance transaction, Config-resolved per-result/per-batch
   decision, preview service,
   journal/spool ownership, and orphan recovery before enabling a potentially
   large-output tool.
6. Implement canonical tool start/finish/batch durability and fault injection,
   including uncertain timeout poisoning and provider-ordered StateGraph queue
   dispatch.
7. Implement Unix and Windows process supervisors before exposing `shell` or `run_tests`.
8. Implement History-owned output spooling, streaming redaction,
   artifactization, and security tests.
9. Port Phase 3 file/edit/search/test/git-read tools.
10. Add Phase 4 artifact retrieval/session-search/StateGraph tools.
11. Add capability-gated Phase 6 standard memory adapters.
12. Port retained Phase 8 git, code-intel, LSP, verification, and skill behavior.
13. Run target-specific stress, leak, cancellation, and crash suites.

Do not port the current `src/tools/index.ts` object spread pattern, `src/tools/tool-def.ts`, direct `process.stdout` shell streaming, or mutable hook registration order.

### 22.1 Bounded Phase 3 runtime packet

Create `tools/{contract,registry,intent,runtime,locks,result}.rs`, `hooks/{mod,plan,validate,risk,circuit,redact}.rs`, `process/{mod,unix,windows,capture}.rs`, and `tests/tool_runtime_phase3.rs`. Check in schema/order/hook/fault/process fixtures first. Run `cargo test -p praana-core --test tool_runtime_phase3`; expected red is unresolved runtime modules. Implement common runtime and Redaction owner integration before any built-in, then process supervisors, then the Phase 3 Built-in Tool Catalog packet. Green requires artifact/history crash tests, target process-tree tests, fmt, clippy with warnings denied, and workspace tests. Phase 4/6/8 tools are separate packets and may not expand this one.

## 23. Acceptance Gate

The Rust tool runtime is ready for the TypeScript IPC client only when:

- Every model-visible schema is generated, normalized, hashed, ordered, and snapshot-tested.
- The exact safety pipeline order is enforced by one runtime path.
- Independent calls execute concurrently and same-path calls resolve deterministically without deadlock.
- Cancellation, timeout, panic, and every post failure release locks.
- Canonical start/result/batch records satisfy crash recovery invariants.
- No unredacted result or raw shell output reaches durable or UI surfaces.
- Unix process groups and Windows Job Objects pass descendant-kill tests.
- Shell capture is bounded and large output is lossless up to explicit hard limits through artifacts.
- Internal tool errors map through the protocol appendix and UI Contract to
  provider, canonical, headless, and UI surfaces; IPC only serializes the UI
  result. Tests assert mappings rather than identical strings across namespaces.
- Phase-specific tool suites pass on Linux, macOS, and Windows targets.
