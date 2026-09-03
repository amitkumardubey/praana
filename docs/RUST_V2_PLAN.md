# PRAANA Rust v2 Architecture and Migration Plan

> This is a living architecture and delivery plan. Update it when experiments invalidate an assumption; preserve the decision history and evidence rather than forcing implementation to follow obsolete detail.

**Date:** 2026-09-01

**Status:** Implementation-ready for Phases 0-7 and 9; Phase 8 requires
provider/tool-specific schema-2 specs before coding; no Rust v2 implementation
started

**Goal:** Replace PRAANA's TypeScript/Bun runtime with an eventually all-Rust application built around append-oriented real messages, provider-native reasoning continuation, lossless artifacts, searchable session history, bounded compaction, a current-state StateGraph, and optional plugin-owned cross-session memory.

**Architecture:** A Rust core owns the canonical event history, accepted-conversation projection, provider protocol state, tool loop, artifacts, current-session search, compaction, StateGraph, and safety hooks. A temporary TypeScript/OpenTUI client consumes a versioned JSONL IPC stream while the Rust headless core reaches parity. Ratatui replaces OpenTUI only after core behavior is stable. Cross-session Cognitive Memory is absent by default and available through a full-lifecycle plugin contract.

**Initial tech stack:** Rust 2021 or newer, Tokio, Async Trait, Reqwest with
rustls, Serde/Serde JSON, Zeroize, Clap, Rusqlite with bundled SQLite and FTS5,
Tracing, Schemars, ULID, SHA-256, Regex, and the existing Rust
tree-sitter/search implementation. Ratatui and Crossterm are deferred until the
core is stable.

**Current implementation used for non-normative comparison only:** TypeScript/Bun under `src/`, Bun tests under `tests/`, and the existing Rust N-API crate under `crates/praana-natives/`. Rust v2 specifications and fixtures are the authority.

**Implementation entry point:** Give a coding model one packet from
`docs/RUST_V2_IMPLEMENTATION_HANDOFF.md`, not this full architecture plan.

---

## 1. Decision Record

The following decisions are locked for Rust v2.

| Area | Decision |
|---|---|
| End state | All Rust, including the TUI |
| Migration strategy | Implement the new architecture directly in Rust; do not first rebuild it in TypeScript |
| Transition | Keep the TypeScript implementation as a non-normative comparison baseline and temporary OpenTUI client |
| Initial provider scope | OpenAI-compatible Chat Completions, OpenAI Responses, and OpenRouter |
| Initial distribution | Standalone native binaries and install scripts |
| Initial history policy | `history.mode = "append"` is the only accepted runtime value |
| Future history evaluation | The scored `engine` concept is Phase 10 research only; it is not an initial runtime mode or accepted config value |
| Classic compiler | Delete; do not port |
| Cross-turn representation | Real canonical user, assistant, and tool-result messages |
| Durable history | Append-only event history with logical supersession, not in-place mutation |
| Provider reasoning | Preserve provider-native continuation state for the active tool cycle by default |
| Large tool results | Store once in the per-session artifact database; messages contain immutable previews and references |
| Session search | Exact/regex plus FTS/BM25 first; semantic transcript search is optional research |
| Compaction trigger | Use the experimental `history.compact_at` default owned by the config specification |
| Compaction amount | Retire the oldest complete committed turns using `history.compact_mass_fraction` from the config specification |
| Summary persistence | Immutable source-range summary segments |
| Model-visible summary | One bounded current handoff, not an unbounded list of all summary segments |
| Current state | StateGraph is available in initial append mode and must remain projection-independent if a Phase 10 engine is later approved |
| Cross-session memory | Full-lifecycle plugin, disabled by default |
| Memory implementation | Define contract and first-party built-in plugin first; external loading later |
| Embeddings | Not required by default history or memory; optional capability only |
| SQLite | Keep for per-session artifacts/search/derived state; memory plugin owns any cross-session database |
| Compatibility | No old config, session, database, npm, or event-schema compatibility requirement |

The pressure trigger, retirement fraction, artifact thresholds, and summary-size
target are experimental config defaults, not permanent truths. Their exact
values are owned only by `RUST_V2_CONFIG_SPEC.md`; they must remain observable
and testable.

### Direct and final cross-spec authority

This plan owns locked architecture decisions, phase boundaries, and the version
registry below. Exact implementation contracts belong to the narrow owner in
this table:

| Concern | Normative owner |
|---|---|
| Accepted Rust v2 config keys, defaults, sources, merge, environment/CLI overrides, path normalization, validation, reload, and config digest | `RUST_V2_CONFIG_SPEC.md` |
| Stable system policy, project instruction discovery, project facts, skill catalog, and provider-neutral instruction slot bytes | `RUST_V2_SYSTEM_CONTEXT_SPEC.md` |
| Provider registry, model catalog/profile trust, capability resolution, credential store/resolution, setup, login, and logout | `RUST_V2_PROVIDER_CATALOG_CREDENTIAL_SPEC.md` |
| Canonical event envelope, event/attempt/turn lifecycle, accepted-conversation projection, and logical request projection | `RUST_V2_PROTOCOL_SPEC.md` |
| Literal OpenAI/OpenRouter Chat Completions and Responses wire placement, fields, parsing, and OpenAI retry delay/backoff | `RUST_V2_OPENAI_SPEC.md` |
| Physical session files/database, host UI-operation ledger/journals, artifact transactions and preview generation, retrieval, and current-session search | `RUST_V2_HISTORY_STORAGE_SPEC.md` |
| Admission, compaction selection, compactor input, summary and handoff payloads/rendering, and compaction activation | `RUST_V2_COMPACTION_SPEC.md` |
| Token estimation, component accounting, estimator identity/calibration, persisted estimates, and shared versioned Unicode utilities | `RUST_V2_TOKEN_ACCOUNTING_SPEC.md` |
| `StateChanged` payloads, StateGraph transitions, projection, checkpoint, and state rendering | `RUST_V2_STATE_GRAPH_SPEC.md` |
| Internal tool execution/result DTOs, built-in tool-name grammar, registry, and provider-visible catalog order | `RUST_V2_TOOL_RUNTIME_SPEC.md` |
| Exact Phase 3/4 built-in tool descriptions, request/success DTOs, defaults, bounds, and intent mapping | `RUST_V2_BUILTIN_TOOL_CATALOG_SPEC.md` |
| Secret detectors, precedence, streaming/structured redaction, replacement bytes, metadata, and surface policy | `RUST_V2_REDACTION_SPEC.md` |
| Cross-session memory API, DTOs, lifecycle, digest, and plugin behavior | `RUST_V2_MEMORY_PLUGIN_SPEC.md` |
| Permanent semantic core/UI commands, results, events, crossing IDs, transcript/catalog/setup/settings DTOs, sink policy, and operation idempotency | `RUST_V2_UI_CONTRACT.md` |
| Temporary OpenTUI JSONL envelopes, framing, request correlation, acknowledgement, connection backpressure, and semantic wire conversion | `RUST_V2_IPC_SPEC.md` |
| Terminal layout, interaction, rendering, and other presentation behavior only | `RUST_V2_RATATUI_SPEC.md` |

Each row is a direct, final authority assignment. A shadow type declaration in
another document has no authority. The narrower owner wins only inside its named
concern, including over an architectural sketch in this plan. A duplicated type,
field list, ordering, or example outside its owner is non-normative explanatory
material and MUST be removed or updated when it disagrees with the owner.
Logical authority order in the plan or protocol does not prescribe a literal
provider role or wire field; the provider wire owner does. Ratatui and IPC do
not own or redefine permanent semantic UI DTOs. TypeScript is never an
authority or a second event model.

### Version registry

Integer subsystem schema versions and string projection identifiers are
different namespaces and MUST NOT be compared or serialized as one another.

| Subsystem | Identifier | Kind | Initial value |
|---|---|---|---:|
| Configuration | `config_schema_version` | Integer schema version | 1 |
| Canonical events | `event_schema_version` | Integer schema version | 2 |
| Accepted-conversation projection | `projection_version` | String projection ID | `rust-v2-projection-1` |
| History storage | `history_schema_version` | Integer schema version | 1 |
| Host UI operation storage | `host_operation_schema_version` | Integer schema version | 1 |
| StateGraph | `state_schema_version` | Integer schema version | 1 |
| Compaction payload | `compaction_schema_version` | Integer schema version | 1 |
| Memory plugin API and DTO | `memory_api_version`, `memory_dto_schema_version` | Integer API/schema versions | 1 |
| OpenAI adapter | `openai_adapter_spec_version` | Integer specification version | 1 |
| Permanent core/UI semantics | `ui_contract_schema_version` | Integer schema version | 1 |
| UI transcript projection | `transcript_projection_schema_version` | Integer schema version | 1 |
| Temporary UI IPC | `ipc_major_version` | Integer protocol major | 1 |
| Token accounting | `token_estimator_schema_version` | Integer schema version | 1 |
| Shared Unicode utilities | `unicode_utility_version` | String implementation ID | `praana-unicode-15.1-v1` |
| System/project context | `system_context_schema_version` | Integer schema version | 1 |
| Provider registry/profile manifest | `provider_registry_schema_version` | Integer schema version | 1 |
| Credential store | `credential_store_schema_version` | Integer schema version | 1 |
| Built-in tool catalog | `builtin_tool_catalog_schema_version` | Integer schema version | 1 |
| Secret redaction | `redaction_version` | String implementation ID | `praana-redaction-v1` |

---

## 2. Why Rust v2 Is a Redesign, Not a Port

The current repository contains approximately 54K lines of TypeScript source, 41K lines of TypeScript tests, 9K lines of UI/TUI code, and 2K lines of Rust native code. A line-by-line rewrite would preserve obsolete architecture and create a large semantic verification burden.

Rust v2 must instead preserve contracts that still matter and deliberately replace the rest.

### Preserve

- Provider wire correctness, including streaming and tool calls.
- Safety-hook behavior and ordering.
- Shell process-tree cancellation.
- Credential and secret-handling expectations.
- Config source precedence where retained by the v2 config spec.
- StateGraph semantics that remain useful.
- Lossless source artifacts and filtered retrieval.
- Headless operation and Harbor compatibility.
- Interactive behavior while the TypeScript UI remains the client.

### Replace

- Per-turn reconstruction of cross-turn history into a system-prompt string.
- The current reduced event log as the only resume substrate.
- The coupling between Cognitive Memory, embeddings, skills, artifacts, scorecard, and the context engine.
- The compression checkpoint sidecar as authoritative state.
- The concrete `MemoryStore` dependency throughout `Session` and tools.
- Duplicate transcript representations that can disagree.

### Delete rather than port

- `src/compile-classic.ts`.
- `src/auto-compact.ts` behavior that writes old turns into Cognitive Memory.
- Classic-mode branching and naming.
- Old session/database migrations.
- Default ONNX embedding setup.
- N-API packaging after the TypeScript client is retired.
- Bun-specific global package installation as an initial v2 requirement.

AI-assisted implementation reduces typing and translation cost. It does not reduce the need for wire fixtures, crash tests, security checks, or semantic comparison. Compilation is necessary but never sufficient acceptance evidence.

---

## 3. Target Runtime Architecture

```text
User / headless caller / temporary TypeScript UI
                    |
                    v
              Rust application
                    |
          +---------+---------+
          |                   |
          v                   v
   Session controller      UI event sink
          |
          v
   Turn orchestrator
          |
          +--> request admission
          +--> provider adapter
          +--> tool/safety pipeline
          +--> canonical event append
          +--> logical history projection
          +--> artifact/session search
          +--> StateGraph projection
          +--> compaction projection
          +--> optional memory plugin
```

The core separates storage from what the model sees.

```text
Canonical event history
  Every accepted or failed attempt, tool execution, state change,
  compaction, reset, model switch, and supersession
                    |
                    v
Logical accepted conversation
  Only accepted user/assistant messages and protocol-complete tool groups
                    |
                    v
Model-visible request
  Stable system/tool prefix + bounded handoff + current StateGraph
  + recent accepted real messages + current in-flight tool cycle
```

Append-only describes the durable record. It does not require feeding failed, superseded, compacted, or protocol-incompatible records to the model.

---

## 4. Rust Workspace

Keep the initial crate structure small.

```text
crates/
  praana-native-core/   # pure Rust tree-sitter, search, project detection
  praana-natives/       # temporary N-API wrapper; deleted at final cutover
  praana-core/          # runtime, providers, history, tools, state, plugins
  praana-cli/           # executable, config, headless, temporary IPC, later TUI
```

### `praana-native-core`

- Move reusable logic from `crates/praana-natives/src/` behind Rust-native types.
- Keep N-API annotations and JavaScript DTOs out of this crate.
- Search and parsing functions accept already-validated paths and bounded options.
- Do not include ONNX in the default feature set.

### `praana-natives`

- Temporarily depend on `praana-native-core`.
- Preserve the current TypeScript application's native API while the UI bridge exists.
- Contain only N-API conversion, version checks, and errors.
- Delete after the TypeScript application is retired.

### `praana-core`

Use modules before creating more crates:

```text
src/
  protocol/
  history/
  provider/
  artifacts/
  state/
  tools/
  hooks/
  memory/
  telemetry/
  config/
  ui_contract/          # permanent commands/results/events and sinks
```

Create a new crate only for a real binary, plugin, compilation, or API boundary.

### `praana-cli`

- Produce the `praana` executable.
- Own command parsing and process exit behavior.
- Initially provide `praana run`, `praana doctor`, and session resume commands.
- Provide a temporary framed JSONL IPC serializer for the core UI contract.
- Add Ratatui as a direct UI-contract consumer only after the headless core and
  bridge are stable.

---

## 5. Canonical Event Protocol

### Envelope

The following is an architectural sketch only. The exact envelope and JSON
encoding are owned by `RUST_V2_PROTOCOL_SPEC.md`.

Every event is one JSON object on one line.

```rust
struct EventEnvelope {
    schema_version: u32,
    event_id: EventId,
    session_id: SessionId,
    sequence: u64,
    timestamp_ms: i64,
    turn_id: Option<TurnId>,
    attempt_id: Option<AttemptId>,
    event: CanonicalEvent,
}
```

`sequence` is monotonic within a session and is the replay order. Timestamps are metadata, not ordering authority.

### Event taxonomy

The taxonomy below is an architectural index, not a duplicate schema
declaration. Exact variants and payload types are owned by the protocol and the
narrow payload owners in the authority table.

```rust
enum CanonicalEvent {
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
    StateChanged(StateChanged),
    HistoryCompacted(HistoryCompacted),
    ModelChanged(ModelChanged),
    ResetBoundary(ResetBoundary),
    SystemNote(SystemNote),
}
```

### Attempt rules

- Provider retries always receive a new `attempt_id`.
- Partial streamed output belongs to an attempt, not the accepted conversation.
- An assistant step becomes model-visible history only after `AssistantStepAccepted` is durable.
- `AttemptSuperseded` identifies the accepted replacement for a failed or abandoned attempt.
- The UI may optimistically render streaming deltas, but it must rewind them if the attempt fails or is superseded.
- Failed partial output remains available for audit and debugging but is excluded from normal model history.

### Tool execution rules

- `AssistantStepAccepted` contains the tool calls exactly as accepted from the provider adapter.
- Persist `ToolExecutionStarted` before invoking each tool.
- Persist `ToolExecutionFinished` only after the post-tool hook pipeline and artifact handling complete.
- Associate parallel calls and results by tool-call ID, never by tool name or array position alone.
- Persist `ToolBatchCompleted` only when every accepted call has a durable result.
- A crash after `ToolExecutionStarted` but before `ToolExecutionFinished` creates an uncertain side-effect record.
- Resume never automatically reruns an uncertain mutating tool.
- The next turn receives a recovery notice and must inspect state before proceeding.

### Turn commit rules

- A committed outer turn starts with one accepted user message.
- It may contain multiple accepted assistant/tool cycles.
- It ends with a terminal accepted assistant step or an explicit durable interruption outcome.
- Only committed outer turns are eligible for normal compaction.
- An in-flight turn is never split across a compaction boundary.

### JSONL recovery

- Parse the longest valid prefix of the file.
- A malformed final line is quarantined and reported; it does not hide earlier events.
- A malformed non-final record is a visible integrity error.
- Sequence gaps and duplicate IDs are integrity errors.
- Event appends use restrictive permissions, append, flush, and fsync.
- Derived indexes may be rebuilt from events without changing event IDs.

---

## 6. Canonical Messages and Provider Continuation

### Portable message model

This is an architectural sketch. The protocol owns canonical conversation
types; compaction owns the historical handoff type; provider specs own wire
conversion.

```rust
enum ConversationMessage {
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolResult(ToolResultMessage),
}

struct AssistantMessage {
    message_id: MessageId,
    turn_id: TurnId,
    step_id: StepId,
    provider: String,
    model: String,
    blocks: Vec<AssistantBlock>,
    finish_reason: FinishReason,
    continuation: Option<ProviderContinuation>,
}

enum AssistantBlock {
    Text(String),
    ReasoningSummary(String),
    ToolCall(ToolCall),
    Image(ImageBlock),
}
```

Block order is preserved. Providers must not reconstruct ordered native output from separate flattened `text`, `thinking`, and `toolCalls` fields.

### Provider-native continuation

```rust
enum ProviderContinuation {
    OpenAiResponses(OpenAiResponsesContinuation),
    Anthropic(AnthropicContinuation),
    Gemini(GeminiContinuation),
    Bedrock(BedrockContinuation),
}
```

Each adapter must implement the equivalent of:

```rust
trait ProviderAdapter {
    fn protocol_id(&self) -> &'static str;
    fn format_request(&self, request: CanonicalRequest) -> Result<WireRequest>;
    fn parse_stream(&self, stream: ByteStream) -> ProviderEventStream;
    fn continuation_compatible(&self, state: &ProviderContinuation, target: &ModelSelection) -> bool;
    fn estimate_request_tokens(&self, request: &CanonicalRequest) -> TokenEstimateV1;
}
```

`TokenEstimateV1` and estimator delegation are defined only by
`RUST_V2_TOKEN_ACCOUNTING_SPEC.md`.

### Initial reasoning policy

The effective `history.reasoning_replay` policy is `active`. The config
specification owns its exact enum, default, and validation; schema v1 accepts no
other replay value.

- Preserve exact native continuation data for the active tool cycle.
- Persist it before executing requested tools.
- Replay it only under the provider specification's exact compatibility rule;
  OpenAI v1 requires the same provider, protocol, model, and model revision.
- Do not index opaque or encrypted reasoning in transcript search.
- Do not include old opaque reasoning in compacted context.
- Keep conclusions, rationale, uncertainty, and next actions through StateGraph and handoff summaries.
- Initial schema v1 never sends `previous_response_id`. Treat any later
  provider-managed continuation ID as an explicitly versioned optimization,
  never the local source of truth.

### Model switching

- A model/provider switch creates an explicit protocol boundary.
- Drop incompatible opaque continuation state from the active request.
- Append a visible handoff describing the prior provider and currently available tool set.
- Re-run context admission against the target model's window and output reserve.
- Expect and measure a provider/model-specific cache miss.
- Do not add automatic per-turn routing in the initial Rust v2 scope.

Cursor reported a 30% CursorBench degradation for one Codex setup when reasoning traces were omitted. This motivates strict adapter tests and telemetry; it does not imply the same effect size for every model.

---

## 7. Logical Conversation Projection

The logical conversation is rebuilt deterministically from canonical events.

It includes:

- Accepted user messages after the active reset boundary.
- Accepted, non-superseded assistant steps.
- Protocol-complete tool-call/result groups.
- The active bounded historical handoff.
- Recent committed turns not retired by the active compaction epoch.
- The current in-flight turn when constructing its next provider request.

It excludes:

- Failed or superseded assistant attempts.
- UI-only events.
- Tool executions not connected to an accepted assistant step.
- Compacted source messages from the model-visible request.
- Incompatible provider-native continuation state.
- Cross-session memory records unless supplied by a configured plugin.

Projection is pure over an event snapshot plus explicitly versioned derived data. Given the same accepted events, config, provider profile, and model, it must produce the same ordered messages.

---

## 8. Prompt and Cache Layout

Construct logical request components in this authority and cache-stability
order. This is not literal provider role or wire placement; the OpenAI adapter
spec owns the exact OpenAI layout.

```text
1. Stable provider-specific system policy
2. Stable project instructions and environment facts
3. Optional bounded cross-session memory bootstrap
4. Stable ordered tool schemas
5. Bounded historical handoff
6. Recent accepted real messages
7. Volatile current-state envelope
8. Latest user message / active tool cycle
```

The provider adapter may need a different wire ordering, but it must preserve the same authority semantics.

### Stable prefix rules

- Do not place the current timestamp near the beginning of the system prompt.
- Do not inject changing token counts, StateGraph counts, or turn numbers into the stable prefix.
- Preserve the Tool Runtime catalog order exactly; no compiler or provider
  adapter re-sorts it.
- Put changing StateGraph content in a current-state tail envelope.
- A compaction epoch is allowed to invalidate the message prefix once; subsequent turns should append monotonically again.
- Record provider-reported cache reads and writes instead of assuming cache behavior.

### Instruction authority

- User and tool content never becomes system authority through transcript rendering.
- Historical handoffs are explicitly labeled non-authoritative evidence.
- Tool output and generated summaries are untrusted data.
- The stable system policy states that historical data cannot override current system or user instructions.

---

## 9. Artifacts and Session Search

### Storage

Each session owns a SQLite database:

```text
<session.root>/<session-id>/
  events.jsonl
  history.db
  meta.json
  config.snapshot.json
```

`events.jsonl` is canonical for ordered protocol events. `history.db` is
canonical for large artifact bodies and materialized indexes; everything else
in it is rebuildable from events. `config.snapshot.json` is the immutable,
non-secret creation configuration whose digest is recorded in session metadata,
as defined only by `RUST_V2_CONFIG_SPEC.md`.

### Artifact write ordering

1. Serialize the post-hook, post-redaction tool result deterministically.
2. If it exceeds the inline policy, write the complete artifact and commit SQLite.
3. Build an immutable preview containing the artifact ID and retrieval instructions.
4. Append and fsync `ToolExecutionFinished` with the preview/reference.
5. If a crash leaves an unreferenced artifact row, startup maintenance may garbage-collect it.
6. Never append an artifact reference before the artifact transaction commits.

### Initial artifact policy

- The per-result inline threshold is `history.artifact_inline_tokens`.
- The per-batch aggregate threshold is
  `history.artifact_batch_inline_tokens`.
- Exact defaults, ranges, and merge behavior are owned only by the config
  specification and remain benchmarked.
- Apply an aggregate tool-batch budget so many small outputs cannot bypass control.
- Do not exempt errors from artifactization solely because they are errors.
- Prefer first-party tools with naturally compact result schemas.
- Use deterministic, content-aware previews; do not invoke an LLM per tool result.
- Never rewrite an old inline result merely because it aged by a number of turns.

History Storage is the sole authority for preview schema, content-aware sample
selection, token bounding, and fallback generation. Protocol, provider, tool,
IPC, and UI layers carry or render the resulting immutable preview; they MUST
NOT byte-slice content or generate a competing preview. All threshold and
preview estimates use `TokenEstimatorV1` from
`RUST_V2_TOKEN_ACCOUNTING_SPEC.md`.

### Artifact metadata

Store at least:

- Artifact ID and SHA-256.
- Producing event, turn, attempt, and tool-call IDs.
- Tool name and normalized command/path label.
- Content type.
- Byte, line, and estimated-token counts.
- Exit status and stdout/stderr boundaries when applicable.
- Source line range for file reads.
- Redaction status.
- Created/access timestamps and counts.
- Immutable preview text.

### Retrieval

The core `retrieve_artifact` tool supports:

- Full retrieval when bounded.
- Line range.
- Head and tail.
- Regex filtering with context.
- JSON path or equivalent structured extraction.
- Clear errors for missing or out-of-range data.

Repeated identical retrieval may return a compact reference after a prior successful retrieval, but must never pretend omitted content was returned.

### Search

Initial session search combines:

- Exact text and regex.
- SQLite FTS5/BM25.
- Filters for event kind, turn range, tool, path, artifact, and summary segment.
- Stable source event IDs and artifact IDs.
- Excerpts with exact retrieval instructions.

Index accepted visible transcript text and complete redacted artifact bodies. Do not index encrypted provider reasoning.

Semantic transcript search is deferred until exact/FTS retrieval is measured and shown insufficient. Codebase semantic search remains a separate capability and is not evidence that transcript embeddings are required.

---

## 10. StateGraph as Current Scratch State

StateGraph remains core and mode-independent.

```text
Canonical events = source of truth
StateGraph       = reconstructible current-state projection
Summary segments = immutable historical narrative/evidence
Current handoff  = bounded context carried across compaction
```

StateGraph owns current:

- Tasks and status.
- Decisions and rationale.
- Constraints.
- Notes/findings.
- Open errors.
- Focus and next actions.

### Rules

- Every mutation appends a `StateChanged` event.
- Updates supersede stale current state rather than appending contradictory prompt prose.
- Active entries appear in the volatile request tail.
- Soft/hard entries are available through state/search tools.
- Checkpoints accelerate resume but are verified against an event sequence/hash.
- StateGraph can be rebuilt from events if a checkpoint is missing or invalid.
- Automatic tiering remains experimental and observable.
- Engine mode may use StateGraph for scoring, but append mode does not run per-turn historical scoring.

This preserves the useful scratchpad/checkpoint part of the current engine without requiring its per-turn BM25/semantic curation pipeline.

---

## 11. Request Admission and Context Pressure

The effective `history.compact_at` threshold starts compaction; it does not
guarantee a request fits.

Before every provider request, including every tool-loop continuation and fallback retry, calculate:

```text
stable system and project context
+ tool schemas
+ current handoff
+ retained accepted messages
+ StateGraph tail
+ active tool protocol state
+ provider framing estimate
+ requested output/reasoning reserve
+ estimator safety margin
```

### Admission policy

- Resolve the actual provider/model context window first.
- Include tool schemas and provider framing.
- Use the provider-tokenizer delegation or deterministic generic fallback from
  `RUST_V2_TOKEN_ACCOUNTING_SPEC.md`.
- Use provider usage as post-request calibration, not sole preflight protection.
- Reserve actual configured output/reasoning allowance rather than defaulting to zero.
- Re-admit after model/provider/reasoning-effort changes.
- Re-admit after every tool batch.
- Record estimated versus provider-reported occupancy.

### Initial configuration

`RUST_V2_CONFIG_SPEC.md` is the sole authority for every initial history key,
default, range, source, merge rule, and phase gate. Schema v1 accepts only
`history.mode = append` and `history.reasoning_replay = active`. Compaction,
artifactization, and preview behavior consume the effective typed values; no
subsystem supplies a fallback default.

`history.compact_mass_fraction` applies only to eligible committed historical
messages. System policy, tool schemas, current StateGraph, the active user
request, and incomplete tool protocol groups are never counted as retireable
mass.

### Hard-ceiling behavior

1. Artifactize every eligible large result in the active request representation.
2. Compact additional oldest committed turns.
3. Reduce requested output allowance only within a provider-safe configured minimum.
4. If the active turn alone cannot fit, stop cleanly with a continuation instruction.
5. On a provider context-length error, perform at most one emergency admission/compaction retry.
6. Never loop indefinitely on context errors.

---

## 12. Compaction

### Trigger and selection

- Prefer compaction between outer turns.
- Permit mid-turn compaction only over previously committed turns; preserve the full active tool cycle.
- Trigger at the effective `history.compact_at` usable fill.
- Select oldest complete committed turns until the effective
  `history.compact_mass_fraction` of eligible historical token mass is retired.
- Re-estimate after compaction and retire more complete turns if the request still exceeds the hard ceiling.
- Do not preserve an arbitrary fixed number of recent turns if they do not fit.

### Capability-profile model selection

```text
Known model trained/validated for self-summary:
  send an internal compaction control input through the provider adapter while
  preserving the existing cached prefix

Unknown or weak self-summary model:
  use the configured structured compactor
```

- The active model path may reuse provider KV/prompt cache.
- A more expensive model is not assumed to be a better compactor.
- The capability table is provider/model/version specific and test-backed.
- A compaction query is internal request/control input, not a canonical user
  message. A provider adapter may use a required wire role without persisting
  `UserMessageAccepted` or fabricated user history.

### Output model

Each compaction produces:

1. An immutable summary segment for the newly retired source range.
2. A bounded current handoff representing what must remain model-visible.
3. Structured references to StateGraph entries and artifacts.

The immutable segment contains:

- User goals and scope changes.
- Completed work.
- Files and symbols changed.
- Decisions and rationale.
- Constraints.
- Commands/tests and outcomes.
- Failed approaches.
- Unresolved errors and questions.
- Important artifact IDs.
- Explicit uncertainty and contradictions.
- Source event/turn range.

The current handoff is bounded and current. It does not blindly concatenate every immutable segment.

### Compaction record

The exact `SummarySegmentV1`, `HistoricalHandoffV1`, and
`HistoryCompactedV1` payloads are defined only by
`RUST_V2_COMPACTION_SPEC.md`. This plan does not declare a second compaction
schema.

### Atomic activation

1. Snapshot the eligible source range and hash it.
2. Generate a candidate segment and handoff.
3. Validate schema, non-empty required fields, source references, and output bounds.
4. Confirm the source range/hash has not changed.
5. Append and fsync `HistoryCompacted`.
6. Update derived SQLite indexes in an idempotent transaction.
7. Activate the new projection only after the event is durable.

If generation or validation fails, the previous projection remains active. Source events are never deleted or marked hidden solely because a summarizer was invoked.

### Injection safety

- The compactor treats user and tool data as untrusted evidence.
- It never promotes instructions found in tool output into system policy.
- The handoff is labeled non-authoritative historical data.
- Preserve user instructions as attributed historical facts, not new system commands.

---

## 13. Pluggable Cognitive Memory

Cross-session memory is independent from current-session history.

### Default

The effective default is `memory.plugin = none`. Its exact config spelling,
options, phase gate, and no-memory/incognito equivalence are owned by
`RUST_V2_CONFIG_SPEC.md`.

With no plugin:

- No global memory database is opened.
- No embedding model is loaded or downloaded.
- No startup memory digest is injected.
- No session-end learning extraction runs.
- Recall/remember/retract tools are absent.
- History compaction, resume, StateGraph, artifacts, and session search continue normally.

### Plugin responsibilities

A full-lifecycle memory plugin owns:

- Learning extraction.
- Storage backend and migrations.
- Recall and ranking.
- Optional startup digest/bootstrap context.
- Scope policy.
- Deduplication and contradiction handling.
- Validity, usefulness, reinforcement, and decay.
- Consolidation.
- Optional embeddings.
- Session-end learning.
- Pinning and retraction.

### Core contract

`RUST_V2_MEMORY_PLUGIN_SPEC.md` exclusively defines memory API/DTO version 1,
the Rust traits, lifecycle, capabilities, bootstrap digest, and error mapping.
No abbreviated trait in this plan is an implementation contract.

The host exposes narrow logging, clock, cancellation, and LLM-completion
capabilities. It does not expose the whole session, provider credentials,
arbitrary tools, or general filesystem access. A built-in plugin may be
constructed at the composition root with its one config-resolved plugin-owned
storage path; only the built-in module may open that database or its SQLite
sidecars.

### Data boundary

Plugins may receive:

- Accepted visible transcript.
- Current StateGraph snapshot.
- Project/user/agent scope identifiers.
- Redacted artifact summaries and references.
- Session outcome signals.
- Explicit `remember` inputs.

Plugins do not receive:

- Superseded attempts.
- Opaque/encrypted provider reasoning.
- Provider credentials.
- Raw unredacted artifacts.
- Tool execution handles.
- The full core `Session` object.

### Tool ownership

Core defines stable `recall`, `remember`, and `retract_memory` tool schemas. It registers them only when the plugin advertises the corresponding capability. Plugins do not inject arbitrary tool definitions in v1.

### First-party implementation

- Implement `builtin:sqlite` after the contract tests exist.
- Keep it disabled unless explicitly configured.
- Start with exact/FTS/BM25 recall and no embeddings.
- Keep its schema and lifecycle entirely plugin-owned.
- Allow a later optional semantic feature without making ONNX part of the default binary.

### External plugins

External dynamic loading is deferred until the contract stabilizes.

- Do not use Rust dylibs as the primary plugin API; Rust has no stable ABI.
- Prefer a versioned subprocess JSONL/JSON-RPC protocol for language independence and crash isolation.
- Consider WASI Components later if sandboxing and portable plugin artifacts justify the runtime cost.

### Existing couplings to remove

- `Session` no longer exposes a concrete `MemoryStore`.
- Engine scoring cannot borrow `memoryStore.embedder`.
- Skill usefulness moves to core telemetry/session storage.
- Scorecard cannot read a concrete memory database path.
- Artifact promotion becomes optional plugin session-end behavior.
- Core history compaction does not call the memory plugin.

Memory failure is always soft. A missing, failed, or timed-out plugin never prevents a turn, resume, compaction, or shutdown.

---

## 14. Safety and Tool Pipeline

Preserve the current logical order:

```text
pre-tool:
  plan mode -> validation -> risk -> circuit -> write-path acquire

execute tool

post-tool:
  LSP -> verify -> enrich -> redact -> circuit accounting -> write-path release
```

### Rust requirements

- Tool schemas are generated from typed request structures and are deterministic.
- Validation happens before risk confirmation or lock acquisition.
- Write-path locks are released on success, error, cancellation, and panic boundaries.
- Mutating tools preserve circuit-breaker behavior.
- Redaction occurs before persistent artifacts and model-visible results are finalized.
- User and agent transcript privacy policy is explicit and separate from tool-result redaction.
- Shell timeouts terminate process groups on Unix and Job Objects on Windows.
- Cancellation is structured with one session/turn token, not ad hoc booleans.
- Panics do not cross plugin, provider, tool, or IPC boundaries.

---

## 15. Initial Provider Scope

### OpenAI-compatible Chat Completions

Support:

- OpenAI and OpenRouter endpoint configuration.
- Standard and custom headers.
- Streaming usage when available.
- Parallel fragmented tool calls.
- Provider compatibility flags.
- Reasoning text fields used by OpenRouter-compatible models.
- Deterministic request fixtures.

### OpenAI Responses

Support:

- Ordered response output items.
- Function calls and outputs.
- Reasoning items and encrypted reasoning items.
- Response/continuation identifiers when available.
- Tool-call argument fragmentation.
- Usage and cache accounting.
- Same-model continuation across tool calls.
- Explicit reset behavior after compaction or model switch.

### Retry policy

- Retry only before any observable text, reasoning, refusal, tool-call, or tool-argument emission.
- Each retry is a new attempt in canonical history.
- Every retry performs fresh request admission. An unchanged estimate may be
  reused only when both request and capability-profile hashes match and the
  reuse is recorded.
- Never execute tool calls from a failed partial provider attempt.
- OpenAI/OpenRouter delay, jitter, and rate-limit-hint handling are owned by
  `RUST_V2_OPENAI_SPEC.md`.
- Context-length failure receives at most one emergency admission retry.

Anthropic, Gemini/Vertex, Bedrock, Azure, OAuth variations, and custom provider edge cases are later parity phases.

---

## 16. Temporary TypeScript UI Bridge

Do not expand N-API to host the stateful Rust turn engine. Use a long-lived child process with framed JSONL messages.

`RUST_V2_UI_CONTRACT.md` is the permanent semantic boundary used by every UI.
The temporary IPC specification owns envelopes/framing/wire conversion only;
the TypeScript client does not create another command or event model.

### Commands from UI to core

- Create/resume/end session.
- Submit user input.
- Abort turn.
- Confirm/deny risk action.
- Run slash command.
- Request slash metadata and path completion.
- Change model/reasoning/settings.
- Request model catalogs, transcript pages, and typed content reads.
- Drive setup, authentication, consent, snapshots, and shutdown.

### Events from core to UI

- Session metadata and boot status.
- Assistant text/thinking deltas.
- Attempt started/rewound/accepted.
- Tool call/result state.
- Usage and cache updates.
- System notices and errors.
- Risk confirmation requests.
- Turn completion/interruption.

Transcript/catalog/content data returns as typed command results, not an
unsolicited second event model. The UI Contract mapping table is exhaustive.

### IPC rules

- Versioned handshake before session commands.
- Monotonic event sequence per connection.
- Request IDs for commands requiring responses.
- Bounded frames and explicit large-payload artifact references.
- Backpressure and cancellation behavior.
- Child crash is surfaced visibly; the UI may restart and resume from durable session state.
- IPC serializes UI-contract DTOs only; memory plugins use their independent
  plugin contract and never reuse this temporary transport by implication.

The TypeScript UI remains a client only. New session/context behavior belongs in Rust.

---

## 17. Ratatui Cutover

Ratatui work starts only after the Rust core passes headless, persistence, compaction, and provider gates.

Feature parity includes:

- Streaming transcript and thinking display.
- Virtualized/paged historical transcript.
- Expandable artifact/tool rows.
- Multiline input and paste handling.
- Slash command palette.
- Model selector.
- Setup/login/logout/consent flows.
- Scrolling, tail follow, focus, and overlays.
- Markdown and syntax highlighting.
- Debug/status/usage views.
- Accessible terminal fallback behavior.

Use terminal snapshot tests and PTY integration tests. Treat differences as explicit UX decisions, not accidental omissions.

After parity:

- Remove OpenTUI, Solid, Bun preload/build code, and TypeScript UI.
- Remove the N-API crate and `.node` release sidecar.
- Keep only standalone native release artifacts and install scripts for the first Rust-native release.

---

## 18. Observability and Evaluation

Every run records enough dimensions to distinguish language, provider, and context-policy changes.

```text
implementation = ts | rust
history_mode = append
config_schema_version
config_digest_sha256
event_schema_version
projection_version
token_estimator_schema_version
estimator_id
unicode_utility_version
compaction_policy_version
provider_driver_version
model
memory_plugin_id/version
artifact_policy_version
```

`history_mode = engine` is reserved for a possible Phase 10 evaluation and is
not an initial accepted runtime value.

### Context metrics

- Estimated and provider-reported input occupancy.
- Output/reasoning reserve.
- Cached and uncached input tokens.
- Cache invalidation at compaction/model switch.
- Number, source size, output size, and latency of compactions.
- Summary compression ratio.
- Artifact cards produced and retrieved.
- Search calls, hits, and evidence used.
- Repeat reads/tool calls and churn.

### Correctness metrics

- End-task tests and task-specific graders.
- User goal and constraint retention after compaction.
- Open-task/error recall.
- Unsupported summary statements.
- Contradictions and stale facts.
- Exact source citation/retrieval success.
- Lost subgoals and duplicated work.
- Invalid provider protocol requests.
- Reasoning continuation retained/dropped.
- Resume correctness after injected crashes.

### Initial ablations

1. Reasoning continuation enabled versus deliberately removed.
2. Inline versus artifactized large outputs.
3. Exact/FTS history search available versus unavailable.
4. StateGraph tail available versus unavailable.
5. Structured compactor versus capability-profile self-summary.
6. Rust append mode versus the TypeScript engine baseline, with implementation recorded as a confounder.

### Threshold sweeps

After the default path is stable, evaluate:

- Trigger ratios: 40%, 50%, 60%, 70%, 80%.
- Eligible mass retirement: 25%, 50%, 75%.
- Artifact inline thresholds and aggregate batch budgets.
- Handoff output budgets.
- Same-model versus configured-compactor behavior by model family.

Do not optimize tool-call count, commit count, or generated lines as primary quality measures. Cursor's swarm research showed that high activity can represent churn rather than progress.

---

## 19. Verification Strategy

### Non-normative TypeScript comparison

Keep the current implementation runnable during migration, but never use it to
resolve a conflict in Rust v2 specifications or to define a second event model.

- Capture black-box fixtures before replacing stable behavior.
- Compare only contracts marked "preserve"; do not require parity for intentionally replaced compilers or memory behavior.
- Record exact config/environment/clock/ID seeds in fixtures.
- Keep TypeScript tests until the corresponding Rust behavior has independent coverage.

### Golden provider fixtures

For each supported protocol, cover:

- Exact request JSON and headers.
- UTF-8 and SSE boundaries split at every relevant location.
- CRLF/LF framing.
- Multiple concurrent tool calls.
- Fragmented tool arguments.
- Usage-only events.
- Disconnect before and after accepted emission.
- Rate limits, timeouts, and aborts.
- Reasoning/encrypted continuation items.
- Context-length errors and emergency retry.
- Resume of a complete active tool cycle.

### Persistence fault injection

Crash after each durable boundary:

- User accepted.
- Assistant attempt started.
- Assistant step accepted.
- Tool execution started.
- Artifact committed.
- Tool execution finished.
- Tool batch completed.
- Turn committed.
- Compaction event appended.
- Derived index update.

Verify that resume never invents completion, loses prior valid records, or reruns uncertain side effects.

### Property/fuzz tests

Use property testing and fuzzing for:

- SSE parsing.
- Tool-call accumulation.
- JSONL recovery.
- Event projection.
- Tool protocol pairing.
- Compaction boundaries and source hashes.
- Artifact line/range filters.
- FTS source mapping.
- TokenEstimatorV1 component boundaries, rounding, and persisted estimate hashes.
- Pinned Unicode case-fold/NFKC utilities and source-offset mapping.
- Path sandbox normalization.
- Secret redaction.
- IPC framing.
- UI-contract command/event mapping, cursors, sink bounds, and durable operation
  replay.
- Future plugin framing.

Core invariants:

- Canonical events are never rewritten.
- Every visible tool result references a visible tool call.
- Every committed turn is protocol-complete.
- Every artifact reference resolves before its event becomes visible.
- Compaction never deletes source evidence.
- StateGraph can be rebuilt from canonical events.
- A plugin failure cannot break session history.
- No redacted tool secret appears in a persisted artifact or model-visible result.

### Rust quality gates

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
```

Add target-specific smoke tests for Linux x64/arm64, macOS arm64/x64, and Windows x64 before final cutover.

---

## 20. Implementation Phases

Each phase has an exit gate. Add a narrower implementation checklist when it helps execution, but do not create process documents merely to satisfy a template.

### Phase 0: Contract fixtures and workspace foundation

- [ ] Add this plan and record its approved decisions.
- [ ] Create a preserve/change/delete behavior matrix from current tests.
- [ ] Capture OpenAI-compatible and Responses wire fixtures from the TypeScript drivers.
- [ ] Capture safety-hook ordering and tool-result fixtures.
- [ ] Split pure Rust logic into `praana-native-core` while preserving the N-API wrapper.
- [ ] Add `praana-core` and `praana-cli` workspace crates.
- [ ] Add shared deterministic clock/ID/test dependencies.
- [ ] Freeze UI contract schema 1 fixtures and the exhaustive semantic/dotted
      name mapping before implementing IPC or Ratatui.

**Exit criteria:** Existing TypeScript native tests still pass; Rust workspace gates pass; fixtures are redacted and deterministic; no production command uses the new core yet.

### Phase 1: Event store and logical projection

- [ ] Implement strict schema-v1 config loading, canonical effective snapshots,
      and config digest metadata from `RUST_V2_CONFIG_SPEC.md`.
- [ ] Implement stable system/project context discovery and rendering from
      `RUST_V2_SYSTEM_CONTEXT_SPEC.md`.
- [ ] Implement versioned event envelopes and canonical event enums.
- [ ] Implement append/fsync and longest-valid-prefix recovery.
- [ ] Implement attempts, supersession, tool execution states, and turn commits.
- [ ] Implement accepted-conversation projection.
- [ ] Implement reset boundaries and incomplete-tail recovery notices.
- [ ] Add fault-injection and property tests.
- [ ] Implement History-owned session/host operation ledgers and restart replay
      for UI-contract `OperationId` before claiming command idempotency.

**Exit criteria:** Config source/merge/path/secret fixtures pass; creation writes
a matching canonical config snapshot and metadata digest; a synthetic multi-step
turn can be persisted, crashed at every boundary, resumed, and projected without
orphaned tool messages or automatic side-effect replay.

### Phase 2: OpenAI/OpenRouter provider runtime

- [ ] Implement provider registry/profile/catalog and credential/setup contracts
      from `RUST_V2_PROVIDER_CATALOG_CREDENTIAL_SPEC.md`.
- [ ] Implement HTTP/auth abstraction and SSE parser.
- [ ] Implement the minimal hard request-admission path required before any
      OpenAI/OpenRouter network send: trustworthy model-window resolution,
      output/reasoning reserves, exact request-component accounting through
      `TokenEstimatorV1`, checked hard-ceiling rejection, and one bounded
      context-length retry decision.
- [ ] Implement OpenAI-compatible Chat Completions.
- [ ] Implement OpenAI Responses with reasoning-item continuation.
- [ ] Implement OpenRouter base URL, headers, and compatibility options.
- [ ] Implement usage/cache accounting and bounded pre-emission retries.
- [ ] Match golden request/stream fixtures.

**Exit criteria:** A fake provider can drive multiple protocol tool cycles with
scripted durable results, fragmented parallel calls, and reasoning continuation;
exact request fixtures
pass; every network-send path proves that the exact request was admitted against
the resolved model window; unknown windows and oversized requests fail before
auth/network; no pressure trigger, compactor, shell, or workspace tool is needed
for this gate; no network is needed for tests.

### Phase 3: Headless turn loop, tools, and safety

- [ ] Implement provider-independent turn orchestration.
- [ ] Implement typed tool registry/schema generation.
- [ ] Implement `praana-redaction-v1` before any tool result can become durable.
- [ ] Implement only the Phase 3 schemas in
      `RUST_V2_BUILTIN_TOOL_CATALOG_SPEC.md`; Phase 4 tools remain disabled.
- [ ] Before enabling any shell, process, file-read, search, test, or other
      potentially large-output tool, implement the minimal History-owned
      artifact blob/reference transaction, the config-owned per-result/per-batch
      policy, content-aware
      bounded preview, artifact-before-finish ordering, and orphan proof versus
      uncertain-execution recovery. Full retrieval and search remain Phase 4.
- [ ] Implement History-owned durable multi-file rollback journals and private
      shell raw spools, including identity-safe startup recovery, before enabling
      batch writes or shell.
- [ ] Port minimal read, write, edit, shell, search, and test tools.
- [ ] Port plan, validation, risk, circuit, write-path, redaction, and cancellation behavior.
- [ ] Implement process-group/Job Object supervision.
- [ ] Expose `praana run` with fake-provider integration tests.

**Exit criteria:** The Rust binary completes representative headless coding
turns, enforces hook ordering, survives cancellation, and passes
security/process tests. Every enabled large result is either policy-compliant
inline content or one durable artifact reference with a History-owned preview;
crash recovery never guesses an orphan result or reruns an uncertain started
tool; rollback never overwrites an independently changed file; an uncooperative
side-effect-capable timeout poisons and stops the runtime instead of detaching.

### Phase 4: Artifacts, search, and StateGraph

- [ ] Enable only the Phase 4 History/StateGraph tool schemas from
      `RUST_V2_BUILTIN_TOOL_CATALOG_SPEC.md` after their backing services pass.
- [ ] Activate the full derived/history-search portion of the complete
      `history.db` schema created in Phase 3, with bundled SQLite/FTS5.
- [ ] Implement full artifact retrieval, filtering, retention, and inspection.
- [ ] Implement accepted transcript/artifact indexing and search.
- [ ] Port StateGraph as an event-derived current projection.
- [ ] Implement checkpoint validation and rebuild.
- [ ] Move skill usefulness/telemetry ownership out of memory storage.

**Exit criteria:** Phase 3 artifact references support full bounded retrieval,
exact middle-of-output search succeeds, immutable segments/artifacts/state are
indexed with stable sources, StateGraph rebuilds from events and serializes
parallel mutations in provider order, and no embedding runtime is required.

### Phase 5: Pressure, compaction, and admission calibration

- [ ] Extend Phase 2 hard admission with pressure state, trigger hysteresis,
      calibration, and pressure telemetry; do not replace its send-time gate.
- [ ] Verify admission before every provider request and fallback remains on the
      Phase 2 path.
- [ ] Implement eligible committed-turn selection by token mass.
- [ ] Implement capability-profile compactor selection.
- [ ] Implement immutable segment plus bounded handoff output.
- [ ] Implement source-hash validation and atomic activation.
- [ ] Implement one-shot emergency recovery.
- [ ] Add compaction-fidelity fixtures and threshold telemetry.

**Exit criteria:** Long synthetic sessions cross multiple compaction epochs
without protocol breakage, source loss, unbounded handoff growth, or dependence
on Cognitive Memory. Pressure-triggered compaction and capability-profile
selection are enabled only here; the Phase 2 hard admission gate still safely
rejects when Phase 5 compaction is unavailable.

### Phase 6: Memory plugin contract and built-in plugin

- [ ] Define serializable plugin DTOs and Rust traits.
- [ ] Add contract tests with a fake plugin and failure injection.
- [ ] Register standard memory tools by capabilities.
- [ ] Implement `plugin = "none"` as the default.
- [ ] Convert desired existing Cognitive Memory behavior into `builtin:sqlite`.
- [ ] Start with FTS/BM25 and no default embeddings.
- [ ] Verify plugin failure never affects core session durability.

**Exit criteria:** The same core tests pass with no plugin, a fake plugin, and `builtin:sqlite`; no core module imports plugin database internals.

### Phase 7: TypeScript/OpenTUI bridge

- [ ] Serialize UI contract schema 1 through IPC v1; do not define IPC semantic
      commands/events.
- [ ] Add Rust IPC server mode.
- [ ] Add TypeScript client adapter behind a development flag.
- [ ] Map streaming attempts, rewind, tool, usage, risk, and completion events.
- [ ] Add child restart/resume behavior.
- [ ] Run interactive soak tests while the TypeScript app remains available.

**Exit criteria:** The existing OpenTUI can drive Rust sessions without owning turn/history logic, and a Rust child crash resumes from durable state with a visible notice.

### Phase 8: Provider and tool parity

- [ ] Approve a new provider/tool catalog schema with exact DTOs and fixtures
      before enabling any Phase 8 provider or reserved tool name.
- [ ] Port Anthropic with thinking signatures.
- [ ] Port Gemini/Vertex with thought signatures.
- [ ] Port Bedrock with reasoning/event-stream handling.
- [ ] Port Azure/custom-provider compatibility.
- [ ] Port remaining OAuth, catalog, LSP, verification, and slash-command behavior.
- [ ] Add provider-specific harness profiles and model-switch handoffs.
- [ ] Freeze the TypeScript engine oracle as a content-addressed fixture bundle
      and runnable container/binary with source commit, lockfiles, configuration,
      scorecard schema, model/task corpus, and expected result hashes before any
      TypeScript deletion.

**Exit criteria:** Supported-provider fixture suites and selected live smoke tests pass; all retained TypeScript-only core capabilities have an explicit Rust equivalent or deletion decision.

### Phase 9: Ratatui and standalone cutover

- [ ] Build Ratatui against `praana-core::ui_contract`, independent of IPC.
- [ ] Port virtual transcript, input, overlays, setup, and settings.
- [ ] Add PTY and terminal snapshot tests.
- [ ] Build standalone release matrix and doctor checks.
- [ ] Update install scripts and release packaging.
- [ ] Remove TypeScript runtime, Bun build path, N-API wrapper, and `.node` sidecar.

**Exit criteria:** Standalone binaries pass doctor/headless/TUI smoke on the release matrix, no Bun installation is required, and no TypeScript runtime code remains.

### Phase 10: Engine comparison decision

- [ ] Run Rust append mode against the preserved content-addressed TypeScript
      engine oracle captured in Phase 8; Phase 10 does not require deleted source
      to remain buildable in the main tree.
- [ ] Evaluate correctness, compaction fidelity, cache/cost, and churn by model/task.
- [ ] If engine behavior remains valuable, write a separate Rust engine
      projection plan over the same canonical events/artifacts. Ship it only
      behind an explicit experimental feature and a later config schema that
      accepts `history.mode = engine`.
- [ ] Otherwise archive the engine as research evidence and remove the mode from the final config.

**Exit criteria:** The engine is either implemented as a non-mutating alternative projection or explicitly retired based on measured evidence.

---

## 21. Distribution

Initial Rust v2 distribution prioritizes GitHub release binaries:

- Linux x64 glibc.
- Linux x64 musl where dependencies support it.
- Linux arm64 glibc.
- macOS arm64.
- macOS x64.
- Windows x64 MSVC.

The final binary directly links search and tree-sitter capabilities. The default build does not include ONNX weights or an embedding model.

Install scripts continue to place `praana` in the current user-local binary directory. npm may later become a thin platform-binary downloader, but it does not block Rust v2.

External memory plugins, when implemented, live under a versioned directory
owned by a future config/plugin specification, such as:

```text
<application-data-root>/plugins/<plugin-id>/
```

They are not required to sit beside the main executable.

---

## 22. Explicit Non-Goals for the Initial Rust MVP

- Ratatui parity before the headless core is stable.
- Every existing provider.
- Automatic per-turn model routing.
- External third-party plugin loading.
- Semantic transcript search.
- Default embeddings or model downloads.
- Rust dynamic-library plugin ABI.
- Old session/config/database compatibility.
- Porting the classic compiler.
- Porting the current engine before append-mode evaluation.
- Distributed/cloud execution.
- Multi-agent swarms.
- Replacing mature external tools such as Git solely to make the stack pure Rust.

---

## 23. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| AI produces plausible but wrong provider serializers | Golden request/stream fixtures, reasoning-item assertions, provider-specific integration tests |
| Three changes are confused: language, history policy, memory | Record implementation, projection, compaction, and plugin versions in every eval |
| Rust rewrite stalls product work | Keep each phase independently runnable; headless MVP before TUI/provider parity |
| OpenTUI rewrite consumes the project | Keep TypeScript as a temporary IPC client; Ratatui is a separate late phase |
| Compaction drops critical details | Immutable source evidence, bounded current handoff, StateGraph, searchable artifacts, fidelity probes |
| Summary segments accumulate | Store all segments but expose one bounded current handoff |
| Provider reasoning is lost | First-class continuation enum, active-cycle persistence, adapter capability tests and telemetry |
| Append-only log contains failed attempts | Logical accepted projection plus explicit supersession |
| Crash leaves uncertain side effects | Tool-start/finish durability and inspect-before-continue recovery notices |
| Artifact reference points to missing data | Commit artifact before event; startup integrity checks |
| SQLite becomes a new global coupling | Per-session core DB; plugin-owned cross-session storage |
| Memory plugin crashes core | Narrow trait/host boundary, timeouts, soft failure; external plugins later use processes/WASM |
| Plugins leak sensitive data | Sanitized accepted transcript only; no credentials or opaque reasoning; explicit permissions later |
| Binary size/build time explodes | No default ONNX/AWS/WASM stack; add provider/plugin features incrementally |
| Cache savings are assumed rather than observed | Record cache read/write tokens, TTFT, and compaction/model-switch invalidations |

---

## 24. Definition of Done

Rust v2 is complete when:

- `praana` is a standalone Rust binary with no Bun runtime requirement.
- The closed Rust v2 config schema, canonical snapshot, and session config digest
  pass all source/merge/path/secret/reload fixtures.
- Canonical events durably represent real provider messages, attempts, tools, compaction, and StateGraph changes.
- Resume handles committed turns, active complete tool cycles, failed attempts, truncated final records, and uncertain tools safely.
- OpenAI/OpenRouter plus all providers intentionally retained for release pass fixture and smoke tests.
- Provider-native reasoning continuation is preserved where supported and explicitly reset where incompatible.
- Append history is the default and classic history no longer exists.
- Large tool output is lossless, stored once, searchable, and recoverable by artifact ID.
- Compaction uses complete committed turns or protocol-normalized interrupted
  capsules, immutable summary evidence, a bounded current handoff, and atomic
  activation without replaying uncertain effects.
- Request admission runs before every provider call and reserves output/reasoning space.
- StateGraph is an event-derived current-state projection available in the default mode.
- Cross-session memory is disabled by default and available only through the full-lifecycle plugin contract.
- No embedding model or cross-session memory database is required by the default installation.
- Core, persistence, provider, fault-injection, security, PTY, and release-matrix tests pass.
- The TypeScript runtime, OpenTUI client, N-API wrapper, and native sidecar are removed after Ratatui parity.
- The engine comparison has a measured implement-or-retire decision.

---

## 25. Research Basis and Limits

Relevant Cursor publications informed this plan:

- [Dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery): lossless searchable large outputs and searchable chat after summarization.
- [Training Composer for longer horizons](https://cursor.com/blog/self-summarization): repeated compaction, retained plan/task state, model-trained self-summary, and cache reuse.
- [Improving Cursor's agent for OpenAI Codex models](https://cursor.com/blog/codex-model-harness): provider reasoning-trace continuity and model-specific harness behavior.
- [Continually improving our agent harness](https://cursor.com/blog/continually-improving-agent-harness): dynamic rather than large static context, model-switch costs, context rot, and online/offline measurement.
- [What we've learned building cloud agents](https://cursor.com/blog/cloud-agent-lessons): append-only conversation storage, retries/supersession, durable execution, and separation of conversation from runtime state.
- [Towards self-driving codebases](https://cursor.com/blog/self-driving-codebases): fresh mutable scratch state, automatic summarization, structured handoffs, and observability.
- [Fast regex search](https://cursor.com/blog/fast-regex-search) and [Improving agent with semantic search](https://cursor.com/blog/semsearch): exact search freshness and the complementary role of semantic code search.
- [How we compare model quality in Cursor](https://cursor.com/blog/cursorbench): realistic long-task evaluation across correctness, efficiency, and interaction quality.

These publications validate the direction, not PRAANA's exact constants. In particular, they do not establish 60%, 50%, 800 tokens, immutable segments, or any one summary budget as universally optimal. Those values remain hypotheses to test.

---

## 26. First Implementation Slice

Start with Phase 0: extract `praana-native-core`, add the Rust core/CLI workspace skeleton, and capture deterministic fixtures for behavior marked "preserve." Keep this slice small enough to merge without introducing a second runnable agent loop.

Do not start Ratatui, memory backend conversion, provider networking, or new history behavior in the foundation slice. The first executable milestone begins with Phase 1 after the event protocol and recovery tests exist.
