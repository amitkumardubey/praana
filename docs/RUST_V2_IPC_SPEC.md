# PRAANA Rust v2 Temporary OpenTUI IPC Specification

**Status:** Normative design for Rust v2 Phase 7

**Lifetime:** Temporary migration protocol between the TypeScript OpenTUI client and the long-lived Rust process

**Depends on:** `docs/RUST_V2_PLAN.md`, `docs/RUST_V2_CONFIG_SPEC.md`,
`docs/RUST_V2_TOOL_RUNTIME_SPEC.md`, and the canonical event protocol

## 1. Purpose

During migration, the existing TypeScript/OpenTUI application becomes a presentation client for the Rust core. It MUST NOT own session history, provider turns, tool execution, safety decisions, artifacts, StateGraph, compaction, memory lifecycle, model switching, credentials, or durable settings.

This specification owns the serialized representation of shared UI command,
event, and result DTOs, including field names and version-1 JSON encoding.
Subsystem specs own their internal/canonical DTOs and define conversions into
this surface. Ratatui owns presentation only and does not redefine IPC/shared UI
serialization.

The TypeScript process spawns one long-lived Rust child and communicates over stdin/stdout using bounded one-line JSON frames. Rust stderr is reserved for diagnostics. This is not N-API, a shared library ABI, a network protocol, or a permanent public API.

```text
TypeScript/OpenTUI process
  UI state, editor, overlays, transcript viewport
              |
              | child stdin/stdout: framed JSONL
              v
Long-lived Rust `praana core --ipc-stdio`
  sessions, turns, providers, tools, safety, history, artifacts, settings
              |
              +---- child stderr: logs only
```

## 2. Non-Goals

- Hosting the Rust turn engine through N-API.
- Supporting TCP, WebSocket, Unix socket, named pipe, or remote clients in Phase 7.
- Providing a stable third-party automation API.
- Sending raw artifact bodies or complete historical transcripts in unsolicited events.
- Preserving compatibility after the TypeScript client is deleted.
- Reusing this transport as the external memory plugin protocol without a separate security review.

## 3. Process Contract

The TypeScript client spawns without a shell:

```text
praana core --ipc-stdio --parent-pid <decimal-pid>
```

Rules:

- Child stdin is protocol input.
- Child stdout is protocol output and MUST contain no banner, log, progress text, ANSI escape sequence, or blank line.
- Child stderr is UTF-8 diagnostics and MUST contain no protocol frames.
- The client reads stdout and stderr concurrently from process start.
- The client MUST NOT parse stderr as JSON protocol data, even if a line looks like JSON.
- The child exits when stdin reaches EOF, after cancelling active work and durably recording an interruption where possible.
- The child monitors the parent PID every two seconds. If the parent disappears and stdin has not closed, it performs the same shutdown.
- Normal shutdown is requested through `runtime.shutdown`; stdin EOF is the crash fallback.
- The client uses argument arrays, never shell interpolation, to spawn the binary.

One Rust process owns one active interactive session at a time in Phase 7. It may end that session and create/resume another without restarting.

## 4. Framing

Each frame is exactly one JSON object encoded as UTF-8 followed by LF (`0x0a`). JSON strings escape embedded newlines. A sender MUST NOT pretty-print frames.

The receiver MAY accept CRLF by discarding one `0x0d` immediately before LF. All other unescaped ASCII control bytes are invalid.

Limits:

```text
hard frame bytes excluding LF:       1,048,576
normal generated frame target:         262,144
maximum JSON nesting depth:                  64
maximum object members:                  4,096
maximum array elements:                 10,000
maximum individual JSON string bytes:   524,288
maximum in-flight requests:                  64
```

These are fixed IPC v1 protocol limits, not Rust config keys. The Config
specification explicitly rejects IPC tuning keys in schema v1.

Protocol parsers MUST:

- Decode UTF-8 strictly.
- Reject duplicate object keys.
- Reject non-integer JSON numbers where an integer is required.
- Reject NaN/infinity representations.
- Stop reading and terminate the connection on an over-limit unterminated frame.
- Return a structured error for a complete malformed frame when a valid request ID can be recovered; otherwise emit one stderr diagnostic and terminate.

Large transcript and artifact content is paged or referenced. Increasing the frame limit to carry a large payload is non-conforming.

## 5. Versioning and Handshake

### 5.1 Version policy

`v` is the protocol major version. Version `1` is defined here.

- A breaking envelope, command, event, or required-field change increments `v`.
- Additive commands/events/optional fields use capability negotiation and do not increment `v` during the temporary protocol lifetime.
- A receiver ignores unknown optional fields only after handshake.
- An unknown command or event name is never silently treated as another type.
- The server supports exactly one selected major per connection.

### 5.2 First frame

The first client frame MUST be a `hello` request using envelope version `1`. No other command is accepted before handshake.

```json
{"v":1,"kind":"request","request_id":"req_01K4A000000000000000000001","command":"hello","payload":{"min_version":1,"max_version":1,"client":{"name":"praana-opentui","version":"0.20.0"},"capabilities":["attempt_rewind","artifact_paging","risk_confirm","transcript_groups","event_ack"]}}
```

Success:

```json
{"v":1,"kind":"response","request_id":"req_01K4A000000000000000000001","ok":true,"result":{"selected_version":1,"connection_id":"conn_01K4A000000000000000000001","server":{"name":"praana-core","version":"0.20.0-dev"},"capabilities":["attempt_rewind","artifact_paging","event_ack","risk_confirm","transcript_groups"],"limits":{"max_frame_bytes":1048576,"max_in_flight_requests":64,"max_unacked_events":1024,"transcript_page_groups":50,"artifact_page_bytes":262144}},"error":null}
```

Failure:

```json
{"v":1,"kind":"response","request_id":"req_01K4A000000000000000000001","ok":false,"result":null,"error":{"code":"IPC_VERSION_UNSUPPORTED","message":"No mutually supported protocol version","retryable":false,"details":{"server_versions":[1]}}}
```

After a version failure, the server closes stdout and exits with code 64.

Capabilities are sorted ASCII ascending in responses and snapshots. A capability is usable only when both peers advertised it and the server returned it.

## 6. Envelope Schemas

### 6.1 Request

```rust
pub struct IpcRequestEnvelope {
    pub v: u32,
    pub kind: RequestKindMarker,       // serializes as "request"
    pub request_id: String,
    pub command: String,
    pub payload: serde_json::Value,
}
```

### 6.2 Response

```rust
pub struct IpcResponseEnvelope {
    pub v: u32,
    pub kind: ResponseKindMarker,      // serializes as "response"
    pub request_id: String,
    pub ok: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<IpcErrorDto>,
}

pub struct IpcErrorDto {
    pub code: IpcErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: Option<serde_json::Value>,
}
```

Exactly one of `result` and `error` is non-null. A successful command with no data uses `{}` as result.

### 6.3 Event

```rust
pub struct IpcEventEnvelope {
    pub v: u32,
    pub kind: EventKindMarker,         // serializes as "event"
    pub sequence: u64,
    pub event: String,
    pub session_id: Option<SessionId>,
    pub turn_id: Option<TurnId>,
    pub attempt_id: Option<AttemptId>,
    pub canonical_sequence: Option<u64>,
    pub payload: serde_json::Value,
}
```

`sequence` is connection-local, starts at 1 after `hello` succeeds, and increases by exactly one for every event frame. Responses do not consume sequence values. `canonical_sequence` is present only when an event corresponds to a durable canonical event. It is monotonic within the session but may skip because not every canonical event is sent to the UI.

### 6.4 ID rules

- Client request IDs are `req_` plus a 26-character uppercase Crockford ULID.
- Client operation IDs are `op_` plus a ULID.
- Connection/stream/block/confirmation IDs are IPC-local opaque newtypes with
  their documented prefix. Canonical session, turn, attempt, step, message,
  artifact, execution, batch, StateGraph, compaction, handoff, and event IDs use
  the protocol-owned Rust newtypes and serialize as raw uppercase 26-character
  ULIDs without an IPC prefix. Provider tool-call IDs remain opaque provider
  strings.
- Request IDs MUST be unique for the connection. A duplicate with identical canonical bytes receives the cached response if available. A duplicate with different bytes returns `IPC_REQUEST_ID_REUSED` and closes the connection.
- The server caches the last 256 responses for connection-local duplicate handling.
- Durable mutating commands use `operation_id` in their payload for restart-safe idempotency.

## 7. Common Error Codes

These are IPC wrapper codes, not canonical/provider/tool/History/StateGraph
codes. `RUST_V2_PROTOCOL_SPEC.md` Appendix A normatively maps canonical domain
class/status/retryability to the wrapper selected here. Redacted details may
carry the canonical domain code; IPC strings are never persisted into canonical
history merely because the UI observed them.

```text
IPC_BAD_FRAME
IPC_FRAME_TOO_LARGE
IPC_INVALID_UTF8
IPC_INVALID_ENVELOPE
IPC_VERSION_UNSUPPORTED
IPC_HANDSHAKE_REQUIRED
IPC_REQUEST_ID_REUSED
IPC_TOO_MANY_REQUESTS
IPC_COMMAND_UNKNOWN
IPC_INVALID_PAYLOAD
IPC_NOT_SUPPORTED
IPC_NOT_READY
IPC_SESSION_REQUIRED
IPC_SESSION_BUSY
IPC_SESSION_NOT_FOUND
IPC_TURN_NOT_FOUND
IPC_TURN_ALREADY_FINISHED
IPC_CONFIRMATION_NOT_FOUND
IPC_CONFIRMATION_EXPIRED
IPC_ARTIFACT_NOT_FOUND
IPC_CURSOR_INVALID
IPC_CANCELLED
IPC_TIMEOUT
IPC_INTERNAL
IPC_DURABILITY_FAILED
IPC_BACKPRESSURE
IPC_AUTH_FAILED
```

Error messages are user-safe and capped at 1,000 bytes. `details` is capped at 16 KiB and MUST NOT contain credentials, raw tool arguments, opaque reasoning, raw artifact bodies, Rust paths/backtraces, or child environment values.

## 8. Command Catalog

Every command receives one response. A command that starts asynchronous work responds when the work is admitted, then reports progress/completion through events.

### 8.1 Connection commands

#### `hello`

Defined in section 5. It is valid only as the first command.

#### `connection.ack`

```json
{"through_sequence":128}
```

Acknowledges every event through that connection sequence. The value cannot move backward or exceed the last sent sequence. Response is `{}`. The client sends an ack after 32 new events or 250 ms, whichever comes first.

#### `request.cancel`

```json
{"target_request_id":"req_01K4A000000000000000000099"}
```

Cancels a cancellable long-running request such as model listing, transcript materialization, or artifact read. It does not cancel a turn; use `turn.cancel`. Result is `{"accepted":true}` or `{"accepted":false,"reason":"already_finished"}`.

#### `runtime.ping`

Payload is `{}`. Result includes `server_time_ms`, `connection_id`, active `session_id`, and active `turn_id`.

#### `runtime.shutdown`

```json
{"operation_id":"op_01K4A000000000000000000001","reason":"ui_exit","grace_ms":3000}
```

The response is sent after shutdown is admitted. The server cancels the active
turn, ends/closes the session within the bounded grace, flushes durable stores,
emits `runtime.stopped`, closes stdout, and exits code 0. An omitted `grace_ms`
uses `session.shutdown_grace_ms`; a supplied value is a one-command shortening
or extension clamped to the Config-spec range and does not mutate config.

### 8.2 Session commands

#### `session.create`

```rust
pub struct SessionCreateRequest {
    pub operation_id: String,
    pub cwd: String,
    pub config_path: Option<String>,
    pub incognito: bool,
    pub debug: bool,
}
```

The cwd is an absolute path supplied by the UI launch context and validated by Rust. Result:

`config_path` has exactly the `--config` explicit-source semantics from
`RUST_V2_CONFIG_SPEC.md`: when present it selects one `.toml` or `.json` file
and suppresses discovered files. TypeScript does not parse or merge it.

```rust
pub struct SessionOpenResult {
    pub session_id: SessionId,
    pub resumed: bool,
    pub canonical_sequence: u64,
    pub metadata: SessionMetadataDto,
    pub boot: BootStatusDto,
    pub transcript_tail_cursor: Option<String>,
    pub recovery: Vec<SystemNoticeDto>,
}

pub struct SessionMetadataDto {
    pub session_id: SessionId,
    pub created_at_ms: i64,
    pub cwd_label: String,
    pub project_label: Option<String>,
    pub config_schema_version: u32,
    pub creation_config_digest_sha256: Sha256Digest,
    pub loaded_config_digest_sha256: Sha256Digest,
    pub runtime_config_digest_sha256: Sha256Digest,
    pub config_changed_since_create: bool,
    pub history_mode: String,
    pub projection_version: String,
    pub provider: String,
    pub protocol: String,
    pub model: String,
    pub reasoning_effort: String,
    pub incognito: bool,
    pub memory_status: String,
}
```

The three config digest fields and changed flag follow
`RUST_V2_CONFIG_SPEC.md`. `history_mode` is exactly `append` in IPC v1.
Metadata contains no config source path, credential, provider header, or full
config snapshot. Option fields are present as JSON null under the IPC v1 DTO
rules.

#### `session.resume`

```json
{"operation_id":"op_01K4A000000000000000000002","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","cwd":"/home/user/project","after_canonical_sequence":845,"debug":false}
```

`after_canonical_sequence` is advisory. Rust always validates and projects durable state. The response has `SessionOpenResult`. The client discards all provisional attempt UI before applying the result.

#### `session.end`

```json
{"operation_id":"op_01K4A000000000000000000003","reason":"clean","memory_grace_ms":2000}
```

`reason` is `clean`, `aborted`, or `error`. `memory_grace_ms` may only shorten
the remaining Config-owned memory end deadline for this command and does not
mutate config. Result is the session epilogue DTO: turns, StateGraph objects,
memory status/counts, canonical sequence, and 12-character resume ID. The server
emits `session.ended` after durability completes.

#### `session.snapshot`

Payload:

```json
{"include_boot":true,"include_pending_confirmations":true}
```

Result includes current metadata, model/reasoning/settings, canonical sequence, active turn state, pending confirmation if any, transcript cursors, status/chrome metrics, and recovery notices. It does not include full transcript or artifact bodies.

### 8.3 Turn commands

#### `turn.submit`

```rust
pub struct TurnSubmitRequest {
    pub operation_id: String,
    pub text: String,
    pub client_submitted_at_ms: i64,
}
```

Text is 1 to 256 KiB after newline normalization and before trimming. Rust preserves accepted text except terminal NUL rejection. Result:

```json
{"accepted":true,"session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","user_message_event_id":"01ARZ3NDEKTSV4RRFFQ69G5FAX","canonical_sequence":846}
```

Only one turn may be active. A second new operation receives `IPC_SESSION_BUSY`. Repeating the same durable `operation_id` returns the original turn admission result and never appends another user message.

#### `turn.cancel`

```json
{"operation_id":"op_01K4A000000000000000000004","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","reason":"user_interrupt"}
```

Response reports whether cancellation was newly requested. Completion is `turn.interrupted` or `turn.completed` if the turn won the race. The server cancels provider streaming, open confirmation, tools/process trees, and pending plugin operation through the structured token hierarchy.

### 8.4 Risk confirmation

#### `risk.resolve`

```rust
pub struct RiskResolveRequest {
    pub operation_id: String,
    pub confirmation_id: String,
    pub decision: RiskDecision,
    pub argument_sha256: String,
}

pub enum RiskDecision {
    AllowOnce,
    Deny,
}
```

Approval is valid only for the pending confirmation ID, tool call ID, and exact
argument hash. There is no `allow_always` in this command. Schema-v1
`risk.allow` cannot be changed through IPC settings or during a live process.

### 8.5 Slash and runtime settings

#### `slash.execute`

```json
{"operation_id":"op_01K4A000000000000000000005","text":"/stats"}
```

Rust parses and executes the slash command. Result:

```rust
pub struct SlashResultDto {
    pub display: SlashDisplay,
    pub lines: Vec<String>,
    pub action: SlashAction,
}
```

`display` is `toast`, `transcript`, `overlay`, or `none`. `action` is a closed enum including `none`, `exit`, `clear_transcript`, `new_session`, `refresh_status`, `open_model_selector`, `open_login`, and `open_logout`. TypeScript renders the result but does not repeat its side effect.

#### `model.select`

```json
{"operation_id":"op_01K4A000000000000000000006","provider":"openrouter","model_id":"openai/gpt-5","reasoning_effort":"high"}
```

Rust validates catalogs/provider support, persists the model change, establishes a protocol boundary, and returns the active model DTO. It emits `model.changed`.

#### `reasoning.set`

```json
{"operation_id":"op_01K4A000000000000000000007","level":"medium"}
```

Allowed levels are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`. Rust validates provider support and persists the setting.

#### `settings.patch`

```json
{"operation_id":"op_01K4A000000000000000000008","changes":{"thinking_visible":true,"debug":false,"theme":"default","tool_icons":"unicode"}}
```

Only keys in the negotiated `settings_patch` capability are accepted. These are
typed user-interface/runtime settings, not Config-v1 keys. The Rust settings
service validates and persists settings. UI-local transient focus/scroll state
is not sent. Result returns the complete effective settings DTO and emits
`settings.changed`.

#### `session.clear`

```json
{"operation_id":"op_01K4A000000000000000000009"}
```

Rust appends a reset boundary, clears model-visible current-session context and StateGraph according to core policy, and returns the new canonical sequence. TypeScript clears its viewport only after success.

#### `session.new`

```json
{"operation_id":"op_01K4A000000000000000000010","cwd":"/home/user/project"}
```

Rust ends the old session, performs the Config-spec full load for the new
session, creates it, and returns `SessionOpenResult`. This is not live reload of
the old session. TypeScript does not construct a replacement session or reopen
databases.

### 8.6 Catalog, setup, authentication, and consent

#### `catalog.models`

```json
{"provider":null,"query":"gpt","cursor":null,"limit":100,"refresh":false}
```

Result is a page of model descriptors with provider, ID, display label, context window, reasoning capability, selected flag, next cursor, and source. Limit is 1 to 200.

#### `setup.status`

Payload `{}` returns whether initial setup is required, configured providers, missing requirements, and consent requests. It contains no credential values.

#### `setup.apply`

Carries provider/model/non-secret endpoint choices and optional credential input
through `SensitiveStringDto`. While no turn is active, Rust writes credentials
to the credential store and atomically writes one selected config source, then
runs the complete Config-spec loader. Secret fields never enter config and are
never echoed in the response or any event.

#### `auth.login`

Supports API-key submission and provider-specific device/browser flows through a tagged payload. Browser/device flows respond with a flow ID and emit `auth.flow_updated`. API keys are consumed by Rust immediately and never retained by TypeScript beyond the submission buffer.

#### `auth.logout`

Removes a provider credential in Rust, computes fallback provider/model, and emits `auth.changed` plus `model.changed` when needed.

#### `consent.resolve`

Resolves a server-issued consent ID with `allow_once`, `allow_persisted`, or `deny`, restricted to choices advertised in the consent event. Consent is bound to exact purpose/version metadata.

The detailed provider setup fields are generated from a Rust-owned setup schema returned by `setup.status`; TypeScript renders fields generically. It MUST NOT own provider credential mappings once IPC mode is active.

### 8.7 Transcript paging

#### `transcript.page`

```rust
pub struct TranscriptPageRequest {
    pub cursor: Option<String>,
    pub direction: TranscriptDirection,
    pub limit_groups: u32,
}

pub enum TranscriptDirection {
    Before,
    After,
    Tail,
}
```

Rules:

- Limit is 1 to 50 complete turn groups; default 20.
- `Tail` requires null cursor.
- `Before` and `After` require a server-issued cursor.
- Cursors are opaque, session-bound, projection-version-bound, and invalid after `session.clear`. They are not SQL offsets.
- Pages never split a committed outer turn group.
- In-flight turn rows may appear only in a tail page and are marked provisional.
- Heavy thinking, tool results, and artifacts are compact references, not inline bodies.

Response:

```rust
pub struct TranscriptPageDto {
    pub transcript_projection_schema_version: u32,
    pub canonical_through_sequence: u64,
    pub groups: Vec<TranscriptGroupDto>,
    pub before_cursor: Option<String>,
    pub after_cursor: Option<String>,
    pub has_before: bool,
    pub has_after: bool,
}

pub struct TranscriptGroupDto {
    pub group_id: String,
    pub turn_id: Option<TurnId>,
    pub committed: bool,
    pub entries: Vec<TranscriptEntryDto>,
}

pub struct TranscriptEntryDto {
    pub entry_id: String,
    pub role: TranscriptRoleDto,
    pub attempt_id: Option<AttemptId>,
    pub canonical_event_id: Option<EventId>,
    pub text: Option<String>,
    pub summary: Option<String>,
    pub tool: Option<TranscriptToolDto>,
    pub detail_ref: Option<ContentRefDto>,
    pub expandable: bool,
    pub estimated_lines: u32,
    pub provisional: bool,
}
```

Roles are `user`, `assistant`, `thinking_summary`, `tool`, `system`, and `turn_footer`. Opaque reasoning is never a transcript detail. `text`/`summary` are capped at 32 KiB per entry and 256 KiB per page. Oversized accepted assistant text receives a `detail_ref` backed by session history/artifacts.

### 8.8 Artifact and detail reads

#### `content.read`

This command handles artifact and transcript detail references:

```rust
pub struct ContentReadRequest {
    pub reference: ContentRefDto,
    pub byte_offset: u64,
    pub max_bytes: u32,
    pub line_start: Option<u64>,
    pub line_end: Option<u64>,
    pub grep: Option<String>,
}

pub struct ContentRefDto {
    pub kind: ContentRefKind,
    pub id: String,
    pub sha256: Option<String>,
}
```

`kind` is `artifact`, `assistant_text`, `tool_result`, or `visible_thinking_summary`. `max_bytes` is 1 to 262,144. Byte paging and line/grep filtering are mutually exclusive. Response contains content type, UTF-8 text or base64 bytes, returned range, total bytes/lines when known, EOF, immutable SHA-256, and redaction status.

The Rust core validates session ownership and never resolves opaque reasoning references. A reference in one session cannot be read from another.

## 9. Event Catalog

### 9.1 Connection and runtime

| Event | Payload purpose | Delivery |
|---|---|---|
| `runtime.ready` | Effective versions, PID, feature status | Critical |
| `runtime.stopping` | Shutdown reason | Critical |
| `runtime.stopped` | Exit status and final durability state | Critical |
| `runtime.backpressure` | Coalescing/drop counters and blocked duration | Coalescible notice |
| `system.notice` | User-visible informational/warning notice | Critical |
| `system.error` | Structured recoverable/fatal error | Critical |

### 9.2 Session

| Event | Payload purpose | Delivery |
|---|---|---|
| `session.opened` | Metadata, boot status, resumed flag | Critical |
| `session.status` | Native/search/LSP/memory/provider status changes | Latest-only |
| `session.cleared` | Durable reset boundary and new cursor epoch | Critical |
| `session.ended` | Epilogue and resume ID | Critical |
| `model.changed` | Active provider/model/protocol boundary | Critical |
| `reasoning.changed` | Effective reasoning level | Critical |
| `settings.changed` | Complete effective non-secret settings | Latest-only |
| `context.updated` | Context occupancy/cache/cost/status-bar data | Latest-only |

### 9.3 Turn and attempts

| Event | Payload purpose | Delivery |
|---|---|---|
| `turn.started` | Durable accepted user message and turn IDs | Critical |
| `attempt.started` | New provisional provider attempt/stream IDs | Critical |
| `assistant.delta` | Text or visible reasoning-summary delta | Coalescible, recoverable |
| `attempt.rewind` | Remove all provisional UI owned by an attempt | Critical |
| `assistant.accepted` | Durable accepted blocks and reconciliation refs | Critical |
| `attempt.superseded` | Durable old-to-new attempt relation | Critical |
| `usage.updated` | Provider usage/cache totals | Latest-only per attempt |
| `turn.completed` | Durable terminal result/footer | Critical |
| `turn.interrupted` | Durable interruption/recovery state | Critical |

### 9.4 Tools and risk

| Event | Payload purpose | Delivery |
|---|---|---|
| `tool.batch_started` | Batch ID and provider-ordered call IDs | Critical |
| `tool.call_pending` | Redacted compact call metadata | Critical |
| `risk.confirmation_requested` | One confirmation request | Critical |
| `risk.confirmation_resolved` | Decision/expiry/cancel result | Critical |
| `tool.call_started` | Durable execution start reference | Critical |
| `tool.call_progress` | Phase, elapsed time, stdout/stderr byte counts | Latest-only per call |
| `tool.call_finished` | Final structured result/artifact refs | Critical |
| `tool.batch_finished` | Durable completion and ordered finish refs | Critical |

### 9.5 Setup/auth/consent

| Event | Payload purpose | Delivery |
|---|---|---|
| `auth.flow_updated` | Device/browser flow status without tokens | Latest-only per flow |
| `auth.changed` | Provider authentication status | Critical |
| `consent.requested` | Server-owned consent prompt | Critical |
| `consent.resolved` | Consent outcome | Critical |

Unknown events are protocol errors unless a negotiated capability explicitly marks an event namespace ignorable. The temporary v1 client treats unknown critical events as a visible incompatibility and stops admitting user input.

## 10. Streaming Attempts, Rewind, and Supersession

### 10.1 Attempt event fields

`attempt.started` payload:

```rust
pub struct AttemptStartedDto {
    pub attempt_id: AttemptId,
    pub stream_id: String,
    pub attempt_number: u32,
    pub provider: String,
    pub model: String,
    pub retry_of: Option<AttemptId>,
}
```

`assistant.delta` payload:

```rust
pub struct AssistantDeltaDto {
    pub stream_id: String,
    pub block_id: String,
    pub block_kind: AssistantVisibleBlockKind,
    pub chunk_index: u64,
    pub text: String,
}
```

`block_kind` is `text` or `reasoning_summary`. Provider-native opaque/encrypted reasoning never produces this event. Text is at most 16 KiB per delta. `chunk_index` starts at 0 per block and increments by one. A duplicate index with identical text is ignored; a gap triggers reconciliation mode until `assistant.accepted`.

### 10.2 Rewind

If an attempt fails, is cancelled before acceptance, or will be retried, Rust emits:

```json
{"v":1,"kind":"event","sequence":44,"event":"attempt.rewind","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","canonical_sequence":851,"payload":{"stream_id":"stream_1","reason":"provider_retry","discard_block_ids":["block_text_1"],"replacement_attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE"}}
```

The client MUST remove all provisional assistant/thinking rows and provisional tool previews owned by that attempt. It MUST NOT remove accepted user text, prior accepted assistant steps, or durable tool rows.

### 10.3 Acceptance and reconciliation

`assistant.accepted` is emitted only after the canonical accepted-step event is fsynced. Its payload contains ordered visible block descriptors with complete text inline when the event fits the normal frame target, otherwise a content reference plus a bounded preview and SHA-256.

The client compares each accepted block with its provisional buffer:

- Exact match: mark accepted without replacement.
- Delta gap or mismatch: replace provisional content from the accepted descriptor/reference.
- Missing provisional block: insert it at the accepted order.
- Extra provisional block: remove it.

Tool calls are included as accepted call descriptors but do not execute until this event is durable.

`attempt.superseded` links old and replacement attempt IDs for audit display. It does not itself mutate rows after `attempt.rewind` has done so.

### 10.4 Example retry

```jsonl
{"v":1,"kind":"event","sequence":40,"event":"attempt.started","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","canonical_sequence":null,"payload":{"attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","stream_id":"stream_1","attempt_number":1,"provider":"openai","model":"gpt-5","retry_of":null}}
{"v":1,"kind":"event","sequence":41,"event":"assistant.delta","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","canonical_sequence":null,"payload":{"stream_id":"stream_1","block_id":"b1","block_kind":"text","chunk_index":0,"text":"Partial answer"}}
{"v":1,"kind":"event","sequence":42,"event":"attempt.rewind","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","canonical_sequence":850,"payload":{"stream_id":"stream_1","reason":"provider_disconnect","discard_block_ids":["b1"],"replacement_attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE"}}
{"v":1,"kind":"event","sequence":43,"event":"attempt.started","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE","canonical_sequence":null,"payload":{"attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE","stream_id":"stream_2","attempt_number":2,"provider":"openai","model":"gpt-5","retry_of":"01ARZ3NDEKTSV4RRFFQ69G5FB2"}}
{"v":1,"kind":"event","sequence":44,"event":"assistant.delta","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE","canonical_sequence":null,"payload":{"stream_id":"stream_2","block_id":"b2","block_kind":"text","chunk_index":0,"text":"Complete answer"}}
{"v":1,"kind":"event","sequence":45,"event":"assistant.accepted","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE","canonical_sequence":853,"payload":{"step_id":"01ARZ3NDEKTSV4RRFFQ69G5FB3","blocks":[{"block_id":"b2","kind":"text","text":"Complete answer","content_ref":null,"sha256":"8f..."}],"finish_reason":"stop","tool_calls":[]}}
{"v":1,"kind":"event","sequence":46,"event":"attempt.superseded","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","canonical_sequence":854,"payload":{"old_attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","replacement_attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE"}}
```

## 11. Risk Confirmation Protocol

`risk.confirmation_requested` payload:

```rust
pub struct RiskConfirmationDto {
    pub confirmation_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub risk_class: String,
    pub title: String,
    pub detail: String,
    pub redacted_arguments: serde_json::Value,
    pub argument_sha256: String,
    pub choices: Vec<RiskDecision>,
    pub expires_at_ms: i64,
}
```

Example:

```jsonl
{"v":1,"kind":"event","sequence":80,"event":"risk.confirmation_requested","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","canonical_sequence":null,"payload":{"confirmation_id":"confirm_01K4A...","tool_call_id":"call_7","tool_name":"shell","risk_class":"package_install","title":"Install packages?","detail":"Command requests bun install","redacted_arguments":{"command":"bun install"},"argument_sha256":"ac01...","choices":["allow_once","deny"],"expires_at_ms":1788200000000}}
{"v":1,"kind":"request","request_id":"req_01K4A000000000000000000080","command":"risk.resolve","payload":{"operation_id":"op_01K4A000000000000000000080","confirmation_id":"confirm_01K4A...","decision":"allow_once","argument_sha256":"ac01..."}}
{"v":1,"kind":"response","request_id":"req_01K4A000000000000000000080","ok":true,"result":{"accepted":true},"error":null}
{"v":1,"kind":"event","sequence":81,"event":"risk.confirmation_resolved","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","canonical_sequence":null,"payload":{"confirmation_id":"confirm_01K4A...","decision":"allow_once","reason":"user"}}
```

Only one risk confirmation is presented at a time. Rust queues requests in provider call order. TypeScript overlays may not reorder them. Closing the UI, cancelling the turn, expiration, connection loss, or malformed response resolves pending confirmation as deny. A child restart never restores an approval; if the call did not start durably, core asks again after a new provider decision.

## 12. Transcript and Artifact Examples

Tail page request:

```jsonl
{"v":1,"kind":"request","request_id":"req_01K4A000000000000000000090","command":"transcript.page","payload":{"cursor":null,"direction":"tail","limit_groups":20}}
{"v":1,"kind":"response","request_id":"req_01K4A000000000000000000090","ok":true,"result":{"transcript_projection_schema_version":1,"canonical_through_sequence":900,"groups":[{"group_id":"turn:01ARZ3NDEKTSV4RRFFQ69G5FAY","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","committed":true,"entries":[{"entry_id":"message:01ARZ3NDEKTSV4RRFFQ69G5FB5","role":"assistant","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","canonical_event_id":"01ARZ3NDEKTSV4RRFFQ69G5FB4","text":"Tests pass.","summary":null,"tool":null,"detail_ref":null,"expandable":false,"estimated_lines":1,"provisional":false}]}],"before_cursor":"cursor_before_x","after_cursor":null,"has_before":true,"has_after":false},"error":null}
```

Artifact page request:

```jsonl
{"v":1,"kind":"request","request_id":"req_01K4A000000000000000000091","command":"content.read","payload":{"reference":{"kind":"artifact","id":"01ARZ3NDEKTSV4RRFFQ69G5FBB","sha256":"51f2..."},"byte_offset":0,"max_bytes":65536,"line_start":null,"line_end":null,"grep":null}}
{"v":1,"kind":"response","request_id":"req_01K4A000000000000000000091","ok":true,"result":{"content_type":"text/plain","encoding":"utf8","text":"first page...","base64":null,"byte_offset":0,"returned_bytes":13,"total_bytes":90000,"line_start":1,"line_end":1,"total_lines":4000,"eof":false,"sha256":"51f2...","redacted":true},"error":null}
```

The client verifies immutable SHA-256 consistency across pages. A mismatch invalidates all cached pages and shows a visible integrity error.

## 13. Client State Machine

```text
NotStarted
  -> Spawning
  -> AwaitingHello
  -> ConnectedNoSession
  -> OpeningSession
  -> Ready
  -> TurnActive
  -> Ready
  -> EndingSession
  -> ConnectedNoSession
  -> ShuttingDown
  -> Stopped

Any connected state -> Disconnected -> Restarting -> AwaitingHello
Restarting -> OpeningSession(resume) -> Ready
Restarting -> Failed
```

Rules:

- User submission is enabled only in `Ready`.
- Editor text is retained locally while disconnected, but is not submitted until resume succeeds and the user confirms submission normally.
- Risk overlays are valid only in `TurnActive`; disconnect dismisses them as denied.
- Provisional attempt rows are owned by `(connection_id, attempt_id)` and are discarded on disconnect.
- Accepted transcript rows are keyed by durable entry/event ID and survive UI reconnect.
- Every response resolves exactly one pending promise. Unknown response IDs are protocol errors.
- A response timeout does not imply the command failed. For durable mutating commands, reconnect and query/resend the same operation ID.

## 14. Server State Machine

```text
Booting
  -> AwaitingHello
  -> ConnectedIdle
  -> SessionOpenIdle
  -> SessionOpenTurnActive
  -> SessionOpenIdle
  -> Closing
  -> Exited
```

The server has one stdout writer task. All components send typed frames through bounded channels; no component writes stdout directly. Request handlers may run concurrently only for read-only commands. Session mutation commands are serialized by the session controller.

Allowed concurrent requests while a turn is active:

- `connection.ack`
- `runtime.ping`
- `turn.cancel`
- `risk.resolve`
- `transcript.page`
- `content.read`
- `session.snapshot`
- `request.cancel`

Model/settings/session mutation, auth/setup, and a second `turn.submit` return `IPC_SESSION_BUSY` unless the specific operation is documented as safe.

## 15. Backpressure

### 15.1 Queues

The server writer owns:

```text
critical queue:       256 frames or 4 MiB, whichever is first
coalescible state:    one pending frame per coalescing key
unacked event limit:  1,024 events or 8 MiB, whichever is first
```

Critical frames include responses, rewind, accepted output, final tool results, confirmations, and turn/session completion. They are never dropped.

Coalescing keys:

- Assistant delta: `(attempt_id, block_id)`; concatenate adjacent text up to 16 KiB.
- Tool progress: `tool_call_id`; keep latest counters.
- Usage: `attempt_id`; keep latest cumulative values.
- Context/session/settings status: event name; keep latest.

### 15.2 Pressure behavior

1. Coalesce eligible frames.
2. Stop emitting intermediate usage/progress while preserving latest state.
3. Backpressure provider delta production through a bounded stream channel.
4. Ensure `assistant.accepted` contains authoritative complete content or references so dropped/coalesced deltas can be reconciled.
5. If no event ack advances for five seconds while over either unacked limit, emit/queue `runtime.backpressure` when possible and pause admission of new user commands.
6. If critical output remains blocked for ten seconds, cancel the active turn, append a durable interruption if storage is available, write a stderr diagnostic, close the protocol, and exit code 74.

The TypeScript client continuously drains stdout even while an overlay is open or rendering is slow. Parsing and state application are separated from terminal rendering; rendering may coalesce updates, protocol reading may not.

## 16. Cancellation Semantics

- `request.cancel` cancels one request handler and yields `IPC_CANCELLED` on that target request if it has not responded.
- `turn.cancel` is durable-operation idempotent and cancels the structured turn token.
- Closing a risk overlay without a decision sends `deny`; losing the connection is also deny.
- Client process exit closes stdin; Rust cancels active work and supervises child process trees before exit.
- Rust process exit rejects every pending TypeScript request promise with a local `ChildDisconnected` error. The client does not fabricate protocol responses.
- Cancellation does not rewind accepted assistant steps or completed tool results. It rewinds only provisional attempt content and ends the outer turn with a durable interruption.

## 17. Child Crash, Restart, and Resume

### 17.1 Detection

The TypeScript client treats any of these as disconnect:

- Child exit.
- Stdout EOF before `runtime.stopped`.
- Invalid/over-limit frame.
- Event sequence gap or regression.
- Unknown critical event.
- Response with unknown/reused request ID.

It immediately:

- Stops admitting input.
- Dismisses pending confirmation as denied.
- Removes provisional rows from the disconnected connection.
- Stops spinner/progress animations.
- Shows a persistent `Rust core disconnected` notice with exit status.
- Retains accepted transcript pages, editor draft, theme, and scroll anchor.

### 17.2 Restart policy

Automatically attempt at most three restarts with delays of 250 ms, 1,000 ms, and 4,000 ms. Do not restart after explicit shutdown, version mismatch, executable-not-found, or repeated malformed protocol.

For each restart:

1. Spawn a new child.
2. Complete handshake; connection sequence resets.
3. Send `session.resume` with durable session ID, cwd, a new operation ID, and last observed canonical sequence.
4. Apply `SessionOpenResult` and `session.snapshot` state.
5. Request a tail transcript page and reconcile rows by durable entry ID.
6. Display recovery notices for incomplete attempts or uncertain tools.
7. Re-enable input only after resume and tail reconciliation succeed.

The client MUST NOT automatically resubmit text unless the prior `turn.submit` used a durable operation ID and Rust reports that exact operation was not accepted. The normal safe action is to resend the same operation ID and let Rust return the original admission or create it once.

### 17.3 Core recovery

Rust reads the longest valid canonical event prefix, verifies derived indexes,
and projects only accepted protocol-complete history. It never resurrects
provisional stream deltas from IPC. A tool with durable start but no finish
becomes uncertain and is not rerun. A crash after artifact commit but before its
event is resolved only by History Storage startup ordering: reconstruct the
finish when full source/cryptographic proof succeeds, otherwise record uncertain
execution. IPC and reconnect cleanup never authorize orphan garbage collection.

### 17.4 Failed recovery

After three failed restarts, the client remains in `Failed`, preserves the draft/transcript cache, and offers only:

- Retry core.
- Show redacted diagnostics.
- Exit.

It does not fall back to the TypeScript turn engine in the same session. Such fallback would create two authorities for history and tools.

## 18. Security and Privacy

- Transport is inherited stdio only. Rust refuses `--ipc-stdio` when stdin/stdout are the same TTY unless `--allow-tty-ipc` is present in a test build.
- No protocol listener is opened.
- Child executable path is resolved from the installed PRAANA package/binary metadata, not cwd or `PATH` after startup.
- The UI never logs complete frames. Debug logs record direction, request ID, name, byte length, sequence, and redacted error code only.
- Sensitive command fields use a `SensitiveStringDto` wrapper in TypeScript and Rust. Its debug/display serialization is `[REDACTED]`.
- Credentials sent for setup/login are never echoed, persisted in events, placed in error details, or included in crash diagnostics.
- Tool arguments shown to UI are the core's redacted display copy. Exact accepted model arguments remain governed by canonical-event security and are not sent over IPC.
- Tool results reach IPC only after the tool-runtime redaction stage.
- Artifact/detail reads return only the core's redacted durable representation.
- Opaque provider reasoning, continuation tokens, response IDs, cookies, and authorization headers have no IPC DTO.
- The TypeScript client treats all server text as data. It never executes server-provided shell text, opens a URL without user action, or interprets transcript Markdown as terminal control sequences.
- Strip ANSI/control sequences from diagnostics and sanitize rendered text at the terminal boundary.
- Path/cwd validation remains in Rust. TypeScript path completion does not grant access.
- IPC stderr logs follow the same secret-redaction policy and use line length limits.

## 19. TypeScript Adapter Boundary

Add one adapter layer. OpenTUI components consume adapter state/events, not `Session`, `AppController`, `runTurn`, `EventLog`, tool registries, or slash-command implementations.

Target shape:

```text
src/ui/ipc/
  child.ts             # spawn/restart/stderr
  framing.ts           # strict line parser and limits
  protocol.ts          # generated/manual DTO types for v1
  client.ts            # request correlation, ack, state machine
  session-adapter.ts   # OpenTUI-facing actions and event sink
  transcript-cache.ts  # page/detail cache and anchor data
```

The adapter exposes high-level UI actions:

```text
start/create/resume/end
submit/cancel
resolveRisk
executeSlash
selectModel/setReasoning/patchSettings
loadTranscriptPage/readContent
setup/login/logout/consent
shutdown
```

The adapter translates Rust events into the current transcript/chrome/overlay stores. It MUST NOT reconstruct core history semantics or persist duplicate `ui_transcript` events.

In IPC mode, remove TypeScript-side calls to:

- `Session.create`, `Session.resume`, and `Session.end`.
- `runTurn` and provider streaming.
- `createAllTools` and hook registries.
- direct `events.jsonl` reads for transcript expansion.
- direct credential/config mutation for model/login/setup.
- direct risk readline prompts.
- memory/embedder consent logic owned by Rust.

The legacy TypeScript runtime remains available only as an explicit development comparison mode until Rust gates pass. It cannot share a live session directory with IPC mode.

## 20. Test Strategy

### 20.1 Codec and framing

- Golden encode/decode for every request, response, and event.
- One-byte chunking at every frame boundary.
- Multiple frames in one read.
- CRLF acceptance and LF output.
- Escaped newline versus raw newline.
- Invalid UTF-8, duplicate keys, depth/member/array/string limits.
- Exactly-at-limit and one-byte-over-limit frames.
- Fuzz arbitrary bytes and structured JSON.
- Ensure stdout contains protocol only and stderr cannot corrupt parsing.

### 20.2 Handshake/version

- Exact v1 success fixture.
- No overlap, command before hello, duplicate hello, capability sorting.
- Client newer/server older and server newer/client older.
- Unknown optional field after handshake.
- Unknown critical event causes visible incompatibility.

### 20.3 IDs and correlation

- Out-of-order responses correlate correctly.
- Duplicate identical request returns cached response.
- Duplicate request ID with changed payload closes.
- Durable operation ID prevents duplicate user message/session mutation across reconnect.
- Event sequence gap/regression detection.
- Ack monotonicity and invalid ack rejection.

### 20.4 Attempt streaming

- Text and visible reasoning-summary deltas, fragmented UTF-8, block interleaving.
- Chunk duplicate, gap, and mismatch reconciliation.
- Retry after partial output removes only the failed attempt.
- Supersession relation links the right attempts.
- Accepted event repairs coalesced/dropped delta state.
- Tool rows start only after assistant acceptance is durable.
- Opaque reasoning fixtures produce no UI delta/content reference.

### 20.5 Tools and risk

- Parallel pending/start/finish IDs.
- Reverse completion order.
- Risk queue order, allow, deny, expiry, cancel, disconnect.
- Argument hash mismatch denies.
- No raw args/results before redaction.
- Large final result uses artifact reference and pages correctly.

### 20.6 Transcript/artifacts

- Tail, before, and after pages over at least 1,000 complete groups.
- No split turns and no duplicate/missing entry IDs across cursor traversal.
- Cursor invalidation after clear/projection change.
- Variable-height compact metadata.
- Content paging, line ranges, grep, EOF, invalid reference, hash mismatch.
- Page/frame byte limits with multi-byte UTF-8.

### 20.7 Backpressure

Use a fake client that pauses stdout reads:

- Delta coalescing preserves accepted final content.
- Latest-only status/progress is bounded.
- Critical frames are never dropped.
- Acks release unacked accounting.
- Admission pauses at five seconds under pressure.
- Ten-second critical blockage durably interrupts and exits 74.
- Client parser remains responsive while terminal rendering sleeps.

### 20.8 Crash/restart

Kill Rust after every durable boundary from the architecture plan.

- Client discards provisional rows and retains accepted rows/draft/anchor.
- Three-delay restart schedule is exact.
- Resume reads longest valid event prefix.
- Uncertain tool notice appears and no side effect is rerun.
- Same operation ID avoids duplicate user message.
- Orphan artifact behavior is correct.
- Version/executable/protocol failures do not loop restart.
- No fallback to TypeScript core.

### 20.9 Security

- Credential canaries in auth, tool args/results, provider errors, artifacts, logs, and stderr.
- Frame metadata logging never captures payload.
- ANSI/OSC/control injection in server text is rendered inert.
- Session-bound references cannot cross sessions.
- TTY misuse and accidental network listener checks.
- Child spawn path and arguments cannot be cwd/PATH injected.

### 20.10 End-to-end PTY

Drive the TypeScript OpenTUI with a fake Rust core and the real Rust core with a scripted fake provider. Cover create, submit, stream, retry rewind, parallel tools, risk allow/deny, transcript page/expand, cancel, model switch, clear, new, child crash/resume, and exit. Record terminal snapshots only after deterministic event barriers, never wall-clock sleeps alone.

## 21. Implementation Sequence

1. Define Rust and TypeScript v1 DTOs from one checked-in language-neutral schema source or golden fixture set.
2. Implement strict framing, envelopes, request correlation, event sequencing, ack, and handshake with an echo server.
3. Implement the Rust stdout writer queue and backpressure tests.
4. Implement session create/resume/snapshot/end commands over the canonical event store.
5. Implement turn submit/cancel and attempt start/delta/rewind/accepted/supersession events with a fake provider.
6. Map tool runtime, risk confirmation, usage, context, and completion events.
7. Implement transcript group paging and content/artifact reads.
8. Implement model/reasoning/settings/slash commands.
9. Implement setup/auth/logout/consent commands and sensitive-field tests.
10. Add TypeScript child/client/session adapter behind an explicit development flag.
11. Rewire OpenTUI stores to adapter actions and remove direct core access in IPC mode.
12. Implement crash detection, three-attempt restart, durable operation retry, and resume reconciliation.
13. Run PTY, backpressure, fault-injection, security, and interactive soak suites.
14. Make IPC mode the only OpenTUI production path after the cutover gate passes.

## 22. OpenTUI Cutover Gate

The TypeScript UI may default to Rust IPC only when:

- Headless Rust core phases 1 through 6 pass independently.
- All v1 codec/framing/version fixtures pass in Rust and TypeScript.
- Existing retained OpenTUI behavior is driven through IPC for session, turn, tool, risk, model, settings, transcript, setup, auth, and shutdown paths.
- A 1,000-group transcript remains pageable without a frame above 1 MiB.
- Provider retry rewind leaves no failed partial output in accepted UI history.
- Backpressure tests prove bounded memory and authoritative acceptance reconciliation.
- Crash injection at every durable boundary resumes without duplicate user messages or tool reruns.
- A 100-session automated soak and 20 manual interactive sessions complete without protocol desynchronization.
- Legacy TypeScript and Rust modes never write the same live session.

## 23. Final Deletion Criteria

The temporary IPC server/client may be deleted only after the Ratatui gate in `docs/RUST_V2_RATATUI_SPEC.md` passes.

Before deletion:

- Every retained OpenTUI feature has a Ratatui equivalent or an approved explicit deletion decision.
- Ratatui consumes the same Rust core event-sink semantics directly without changing canonical history behavior.
- Ratatui PTY/snapshot/performance/release-matrix tests pass.
- Standalone Rust binaries handle setup, login, consent, session resume, risk prompts, transcript paging, and crash recovery without Bun.
- No release/install/doctor path invokes TypeScript or downloads OpenTUI dependencies.
- No TypeScript test remains the only coverage for a preserved behavior.

Deletion removes:

- `--ipc-stdio` and temporary protocol handlers unless a separately approved public IPC proposal exists.
- `src/ui/ipc/`, OpenTUI/Solid runtime code, Bun preload/build paths, and UI package dependencies.
- N-API stateful bridge experiments, if any.
- Duplicate TypeScript session/controller/provider/tool logic.

The canonical Rust event and UI sink DTOs remain internal. They do not inherit permanent compatibility obligations from this temporary transport.
