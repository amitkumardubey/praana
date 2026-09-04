# PRAANA Rust v2 Temporary OpenTUI IPC Specification

**Status:** Normative transport design for Rust v2 Phase 7

**IPC major version:** 1

**UI contract schema version:** 1

**Lifetime:** Temporary migration transport between the TypeScript OpenTUI
client and the long-lived Rust process

**Depends on:** `docs/RUST_V2_UI_CONTRACT.md` for every semantic command,
result, event, payload, ID, priority, sensitivity, and dotted name;
`docs/RUST_V2_PROTOCOL_SPEC.md` for canonical durability; and
`docs/RUST_V2_HISTORY_STORAGE_SPEC.md` for durable operation replay

## 1. Purpose and authority

This specification owns only process launch, JSONL framing, handshake,
transport envelopes, request correlation, event acknowledgement, connection
backpressure, child restart, and strict wire conversion for the temporary
OpenTUI bridge. It does not own semantic DTOs. IPC serializes
`CoreCommand`, `CoreCommandResult`, and `UiEventRecord` from the UI contract and
must not define a second command/event model.

The TypeScript process is a presentation client. It does not own session
history, provider turns, retry policy, tools, safety, artifacts, StateGraph,
compaction, memory lifecycle, settings, credentials, or operation idempotency.
The transport is inherited stdio, not a public network API or an external
memory-plugin protocol.

## 2. Process contract

The client spawns without a shell:

```text
praana core --ipc-stdio --parent-pid <decimal-pid>
```

- Child stdin is protocol input.
- Child stdout contains protocol frames only: no banner, log, ANSI sequence, or
  blank line.
- Child stderr is UTF-8 diagnostics only and is never parsed as protocol.
- The client drains stdout and stderr concurrently from process start.
- EOF cancels active work and invokes normal bounded shutdown where possible.
- The child checks the parent PID every two seconds and shuts down if it is
  gone.
- One process owns at most one active interactive session in IPC v1.
- Normal exit uses semantic `CoreCommand::Shutdown` (`runtime.shutdown`).

## 3. Framing and limits

Each frame is one compact UTF-8 JSON object followed by LF. A receiver may
discard one CR immediately before LF. Embedded newlines are escaped.

```text
hard frame bytes excluding LF:       1,048,576
normal generated frame target:         262,144
maximum JSON nesting depth:                  64
maximum object members:                  4,096
maximum array elements:                 10,000
maximum individual JSON string bytes:   524,288
maximum in-flight requests:                  64
```

These are fixed IPC v1 constants, not Config-v1 keys. Parsers decode UTF-8
strictly; reject duplicate keys, non-integer numbers where integers are
required, NaN/infinity, unknown required fields, and limit violations; and
terminate on an over-limit unterminated frame. Large semantic content uses UI
contract transcript/content paging.

## 4. Handshake and versioning

The first client frame is `hello`. No semantic command is accepted first.
IPC v1 supports exactly UI contract schema 1. Baseline UI commands/events,
including `settings.patch`, are not capabilities and cannot be negotiated away.
Capabilities advertise optional transport behavior only.

Request:

```json
{"v":1,"kind":"request","request_id":"req_01ARZ3NDEKTSV4RRFFQ69G5FAV","command":"hello","payload":{"min_version":1,"max_version":1,"ui_contract_schema_versions":[1],"client":{"name":"praana-opentui","version":"0.20.0"},"capabilities":[]}}
```

Success:

```json
{"v":1,"kind":"response","request_id":"req_01ARZ3NDEKTSV4RRFFQ69G5FAV","ok":true,"result":{"selected_version":1,"ui_contract_schema_version":1,"connection_id":"conn_01ARZ3NDEKTSV4RRFFQ69G5FAW","server":{"name":"praana-core","version":"0.20.0-dev"},"capabilities":[],"limits":{"max_frame_bytes":1048576,"max_in_flight_requests":64,"max_unacked_events":1024,"transcript_page_groups":50,"content_page_bytes":262144}},"error":null}
```

Failure:

```json
{"v":1,"kind":"response","request_id":"req_01ARZ3NDEKTSV4RRFFQ69G5FAV","ok":false,"result":null,"error":{"type":"transport","data":{"code":"IPC_VERSION_UNSUPPORTED","message":"No mutually supported protocol version","retryable":false,"details":{"type":"server_versions","data":{"ipc_versions":[1],"ui_contract_schema_versions":[1]}}}}}
```

After version failure the server closes stdout and exits 64. IPC v1 defines no
optional capability, so both arrays are empty. `connection.ack` and every UI
contract schema-1 mapping are baseline. A future capability list is
ASCII-sorted, and a capability is usable only when both peers advertise it and
the server returns it. An additive semantic command/event requires a new UI
contract schema and cannot be introduced as an IPC-only capability.

## 5. Exact transport envelopes

`RawValue` is permitted only in this framing layer so the strict parser can read
an envelope before dispatching by the UI contract's dotted-name table. The
converter immediately deserializes it to the exact typed payload. No core,
handler, UI adapter, or test receives an untyped payload.

```rust
pub struct IpcRequestEnvelope {
    pub v: u32,
    pub kind: RequestKindMarker,
    pub request_id: IpcRequestId,
    pub command: String,
    pub payload: Box<serde_json::value::RawValue>,
}

pub struct IpcResponseEnvelope {
    pub v: u32,
    pub kind: ResponseKindMarker,
    pub request_id: IpcRequestId,
    pub ok: bool,
    pub result: Option<Box<serde_json::value::RawValue>>,
    pub error: Option<IpcFailureDto>,
}

pub struct IpcEventEnvelope {
    pub v: u32,
    pub kind: EventKindMarker,
    pub sequence: u64,
    pub event: String,
    pub session_id: Option<SessionId>,
    pub turn_id: Option<TurnId>,
    pub attempt_id: Option<AttemptId>,
    pub operation_id: Option<OperationId>,
    pub durability: UiDurabilityRef,
    pub payload: Box<serde_json::value::RawValue>,
}

pub enum IpcFailureDto {
    Core(CoreErrorDto),
    Transport(IpcTransportErrorDto),
}

pub struct IpcTransportErrorDto {
    pub code: IpcTransportErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: IpcTransportErrorDetails,
}

pub enum IpcTransportErrorDetails {
    None,
    ServerVersions {
        ipc_versions: Vec<u32>,
        ui_contract_schema_versions: Vec<u32>,
    },
    Limit { name: String, maximum: u64, actual: u64 },
    RequestId { request_id: IpcRequestId },
    Command { command: String },
}
```

Enums use `snake_case` tagged `type`/`data` encoding except
`IpcTransportErrorCode`, which uses `SCREAMING_SNAKE_CASE`. Exactly one of
`result` and `error` is non-null. A semantic success serializes the inner
`CoreCommandSuccess` payload selected by the UI contract pairing table. A
semantic error serializes as `IpcFailureDto::Core`; framing/connection failures
serialize as `Transport`.

Transport error codes are closed:

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
IPC_EVENT_UNKNOWN
IPC_SEQUENCE_INVALID
IPC_BACKPRESSURE
IPC_INTERNAL
```

Error messages are user-safe and at most 1,000 UTF-8 bytes. Transport details
contain no semantic payload, credentials, raw arguments, reasoning, artifacts,
paths, backtraces, or environment values.

## 6. IDs and sequence

- `IpcRequestId` is `req_` plus one uppercase 26-character Crockford ULID.
- `IpcConnectionId` is `conn_` plus one uppercase ULID.
- Temporary stream/block/cursor tokens may use `stream_`, `block_`, and
  `cursor_` plus an adapter-owned opaque ASCII body.
- Every semantic/canonical ID, including `OperationId`, is exactly the raw
  uppercase 26-character ULID required by the UI contract. `op_` is invalid.
- `ResumeSelector` is exactly the UI contract's 12-character selector and is
  never accepted as `SessionId`.
- Provider tool-call IDs remain opaque strings.

Request IDs are unique per connection. Repeating identical canonical request
bytes returns the cached response when present. Reusing one request ID with
different bytes returns `IPC_REQUEST_ID_REUSED` and closes the connection. The
cache holds the last 256 responses and provides no restart safety. Durable
replay comes only from the History-owned `OperationId` ledger.

Event `sequence` starts at 1 after handshake and increments by exactly one for
every event frame written. Responses do not consume it. It is connection-local
and is not a canonical sequence. The `durability` field carries the exact
UI-contract reference; there is no second nullable
`canonical_sequence` field.

## 7. Wire conversion

The one semantic variant/dotted-name/Ratatui mapping is section 11 of
`RUST_V2_UI_CONTRACT.md`. IPC uses it verbatim. Underscore aliases, alternate
names, case folding, and unknown semantic namespaces are forbidden.

For a request, conversion is:

1. Validate framing and handshake.
2. Resolve `command` through `command_from_wire`.
3. Deserialize `payload` into that variant's exact command struct with unknown
   fields denied.
4. Execute one typed `CoreCommand`.
5. Verify the exact command/result pairing.
6. Serialize the result payload or typed error.

For an event, conversion validates `UiEventRecord`, obtains the dotted name
from `event_wire_name`, copies semantic context/durability into the envelope,
serializes only the exact variant payload, and assigns the next connection
sequence. Tool Runtime emits `UiEvent::ToolCallFinished`; it never emits the
string `tool.call_finished`.

The transport-only commands are:

| Wire command | Payload | Result |
|---|---|---|
| `hello` | section 4 | section 4 |
| `connection.ack` | `{ "through_sequence": u64 }` | `{}` |
| `request.cancel` | `{ "target_request_id": IpcRequestId }` | `{ "accepted": bool }` |

`connection.ack` is monotonic and cannot exceed the last sent event. The client
acks after 32 events or 250 ms, whichever occurs first. `request.cancel` stops a
cancellable read/catalog request only; it never cancels a turn or undoes a
durable operation.

## 8. Baseline semantic coverage

IPC v1 MUST support every command, result, and event in UI contract schema 1.
In particular it supports, without hidden service access:

- transcript tail/before/after paging with typed cursors;
- byte/line/grep content reads with typed references and content cursors;
- slash metadata catalog and slash execution;
- path completion;
- model catalog paging and selection;
- complete effective settings and typed baseline `settings.patch`;
- setup schema/status/apply;
- API-key, device, and browser authentication plus logout;
- consent resolution;
- boot/status/notices/epilogue/session snapshot;
- usage/context and all attempt/tool/risk events.

The TypeScript adapter renders these results. It does not read history,
artifacts, model catalogs, config, credentials, memory, or slash metadata
directly.

Baseline settings example, with a raw canonical `OperationId` and no capability:

```jsonl
{"v":1,"kind":"request","request_id":"req_01ARZ3NDEKTSV4RRFFQ69G5FAX","command":"settings.patch","payload":{"operation_id":"01ARZ3NDEKTSV4RRFFQ69G5FAZ","expected_revision":4,"changes":{"thinking_visible":true,"debug":false,"theme":"default","tool_icons":"unicode","mouse_enabled":null,"animation_enabled":null,"syntax_highlighting":null,"syntax_theme":null,"incognito_default":null}}}
{"v":1,"kind":"response","request_id":"req_01ARZ3NDEKTSV4RRFFQ69G5FAX","ok":true,"result":{"revision":5,"thinking_visible":true,"debug":false,"theme":"default","tool_icons":"unicode","mouse_enabled":true,"animation_enabled":true,"syntax_highlighting":true,"syntax_theme":"base16-ocean.dark","incognito_default":false},"error":null}
```

## 9. Retry, rewind, and reconciliation fixtures

Generic provider retry is legal only before user-visible text/reasoning delta,
as owned by the canonical protocol and provider specification. This valid
pre-visible retry has contiguous connection sequence and monotonic canonical
references:

```jsonl
{"v":1,"kind":"event","sequence":40,"event":"attempt.started","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","operation_id":null,"durability":{"type":"canonical_event","data":{"event_id":"01ARZ3NDEKTSV4RRFFQ69G5FB3","canonical_sequence":850}},"payload":{"attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","attempt_number":1,"provider":"openai","model_id":"gpt-5","retry_of":null}}
{"v":1,"kind":"event","sequence":41,"event":"attempt.rewind","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","operation_id":null,"durability":{"type":"canonical_event","data":{"event_id":"01ARZ3NDEKTSV4RRFFQ69G5FB4","canonical_sequence":851}},"payload":{"attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","reason":"failed","discard_block_ids":[],"replacement_attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE"}}
{"v":1,"kind":"event","sequence":42,"event":"attempt.started","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE","operation_id":null,"durability":{"type":"canonical_event","data":{"event_id":"01ARZ3NDEKTSV4RRFFQ69G5FB5","canonical_sequence":852}},"payload":{"attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE","attempt_number":2,"provider":"openai","model_id":"gpt-5","retry_of":"01ARZ3NDEKTSV4RRFFQ69G5FB2"}}
{"v":1,"kind":"event","sequence":43,"event":"assistant.accepted","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE","operation_id":null,"durability":{"type":"canonical_event","data":{"event_id":"01ARZ3NDEKTSV4RRFFQ69G5FB6","canonical_sequence":853}},"payload":{"step_id":"01ARZ3NDEKTSV4RRFFQ69G5FB7","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE","blocks":[{"block_id":"01ARZ3NDEKTSV4RRFFQ69G5FB8","kind":"text","content":{"preview":"Complete answer","complete":true,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","detail_ref":null}}],"tool_calls":[],"finish_reason":"stop"}}
{"v":1,"kind":"event","sequence":44,"event":"attempt.superseded","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","operation_id":null,"durability":{"type":"canonical_event","data":{"event_id":"01ARZ3NDEKTSV4RRFFQ69G5FB9","canonical_sequence":854}},"payload":{"old_attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","replacement_attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FBE","reason":"retry"}}
```

A disconnect after a visible delta is terminal, not retryable:

```jsonl
{"v":1,"kind":"event","sequence":60,"event":"attempt.started","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","operation_id":null,"durability":{"type":"canonical_event","data":{"event_id":"01ARZ3NDEKTSV4RRFFQ69G5FB3","canonical_sequence":900}},"payload":{"attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","attempt_number":1,"provider":"openai","model_id":"gpt-5","retry_of":null}}
{"v":1,"kind":"event","sequence":61,"event":"assistant.delta","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","operation_id":null,"durability":{"type":"ephemeral"},"payload":{"block_id":"01ARZ3NDEKTSV4RRFFQ69G5FB8","block_kind":"text","first_chunk_index":0,"last_chunk_index":0,"text":"Partial answer"}}
{"v":1,"kind":"event","sequence":62,"event":"attempt.rewind","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","operation_id":null,"durability":{"type":"canonical_event","data":{"event_id":"01ARZ3NDEKTSV4RRFFQ69G5FB4","canonical_sequence":901}},"payload":{"attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","reason":"failed","discard_block_ids":["01ARZ3NDEKTSV4RRFFQ69G5FB8"],"replacement_attempt_id":null}}
{"v":1,"kind":"event","sequence":63,"event":"turn.interrupted","session_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","attempt_id":"01ARZ3NDEKTSV4RRFFQ69G5FB2","operation_id":null,"durability":{"type":"canonical_event","data":{"event_id":"01ARZ3NDEKTSV4RRFFQ69G5FB5","canonical_sequence":902}},"payload":{"turn_id":"01ARZ3NDEKTSV4RRFFQ69G5FAY","reason":"provider_failure","message":"Turn stopped because no further provider attempt could produce accepted output.","uncertain_execution_ids":[]}}
```

There is no replacement attempt in the second fixture. `attempt.rewind` remains
valid for cancellation and accepted-content repair; it is not permission to
retry after visible output.

## 10. Client and server state

Client:

```text
NotStarted -> Spawning -> AwaitingHello -> ConnectedNoSession
ConnectedNoSession -> OpeningSession -> Ready -> TurnActive -> Ready
Ready -> EndingSession -> ConnectedNoSession
any connected state -> Disconnected -> Restarting -> AwaitingHello
Restarting -> OpeningSession(resume) -> Ready | Failed
any connected state -> ShuttingDown -> Stopped
```

Server:

```text
Booting -> AwaitingHello -> ConnectedIdle
ConnectedIdle -> SessionOpenIdle -> SessionOpenTurnActive -> SessionOpenIdle
any state -> Closing -> Exited
```

- Submit is enabled only in `Ready`.
- Provisional rows are owned by connection plus attempt and are discarded on
  disconnect. Accepted rows are keyed by semantic transcript/event IDs.
- Every response resolves exactly one pending request.
- A request timeout does not prove a durable command failed. Reconnect and send
  the same `OperationId` in a new request.
- Read-only requests may run concurrently. Semantic mutation is serialized by
  the UI contract's concurrency rules.
- One stdout writer owns all frames. No handler writes stdout directly.

## 11. Connection backpressure

The IPC writer owns:

```text
critical queue:       256 frames or 4 MiB
coalescible state:    one frame per UI-contract coalescing key
unacked events:       1,024 frames or 8 MiB
```

The adapter applies the UI contract's exhaustive priority/coalescing table.
Critical responses/events never drop. Eligible deltas may concatenate only for
contiguous chunk ranges up to 16 KiB; latest progress/usage/status replaces an
older pending value. Accepted output contains complete content or immutable
references and repairs any omitted provisional delta.

If acknowledgement does not advance for five seconds while above an unacked
limit, the server queues one backpressure event when possible and pauses new
user-command admission. If critical transport output remains blocked for ten
seconds, the IPC sink detaches, writes one redacted stderr diagnostic, closes
the connection, and exits 74. Sink detach itself does not mutate canonical
state. The connection controller then follows normal client-disconnect
shutdown, which may separately cancel an active turn and durably record its
interruption. Core durability never waits on terminal rendering.

The client drains/parses stdout while overlays or slow rendering are active.
Protocol reads are separate from state reduction and terminal draws.

## 12. Crash, restart, and operation replay

Disconnect is child exit, unexpected stdout EOF, invalid frame, connection
sequence gap/regression, unknown semantic event, or unknown/reused response ID.
The client stops input, denies/dismisses confirmation, removes provisional
rows, stops animation, retains accepted pages/draft/theme/anchor, and shows a
persistent disconnect notice.

Automatic restart attempts use 250 ms, 1,000 ms, and 4,000 ms delays. Do not
restart after explicit shutdown, version mismatch, executable-not-found, or
repeated malformed protocol. Each restart:

1. Spawns and handshakes a new child; connection sequence restarts at 1.
2. Sends `session.resume` with a fresh canonical `OperationId`, canonical
   session ID, cwd, and last observed canonical sequence.
3. Applies the typed open result and snapshot.
4. Fetches/reconciles the tail transcript by semantic entry ID.
5. Displays operation/tool recovery notices.
6. Re-enables input only after reconciliation.

The client never automatically resubmits text with a new operation ID. It may
resend the exact original `TurnSubmit` operation ID and request hash; the
History-owned ledger returns the original result, executes a safely reserved
plan once, or reports interrupted. Connection response caches are irrelevant
after restart.

After three failures, the client offers retry core, redacted diagnostics, or
exit. It never falls back to a TypeScript turn engine in the same session.

## 13. Security

- Inherited stdio only; no listener is opened.
- Refuse `--ipc-stdio` when stdin/stdout are the same TTY except an explicit
  test-build override.
- Resolve the child executable from installed metadata, not mutable cwd/PATH.
- Log only direction, request ID, dotted name, byte count, event sequence, and
  redacted code; never complete frames.
- Sensitive setup/auth command fields use UI-contract `SensitiveStringDto` and
  are consumed immediately.
- Events/results contain only core-redacted arguments/results.
- Opaque reasoning, continuation tokens, provider response IDs, cookies, and
  authorization headers have no UI DTO.
- Render server text as inert data; never execute shell text or auto-open URLs.
- Path completion grants no access; Rust validation remains authoritative.

## 14. TypeScript adapter boundary

```text
src/ui/ipc/
  child.ts
  framing.ts
  protocol.ts          # generated mirror of UI contract schema 1 plus envelopes
  client.ts
  session-adapter.ts
  transcript-cache.ts
```

The adapter exposes typed create/resume/end, submit/cancel, risk, slash catalog
and execute, path completion, model/reasoning/settings, transcript/content,
setup/auth/consent, snapshot, and shutdown operations. It must not call
TypeScript `Session`, `runTurn`, tool/hook registries, event-log readers,
credential/config mutation, memory consent, or slash implementations in IPC
mode. It does not persist a duplicate UI transcript.

## 15. Required fixtures and tests

Wire fixtures live in
`crates/praana-cli/tests/fixtures/ipc_v1_ui_contract_v1/` and mirror every file
in the UI contract fixture manifest. A machine test verifies one command
request, success response, error response, and event frame for every mapping
row. All IDs are complete and all SHA-256 strings are 64 lowercase hex.

Required tests:

- strict UTF-8/JSONL, duplicate keys, one-byte chunking, CRLF, and every limit;
- exact handshake success/failure and UI schema mismatch;
- baseline `settings.patch` with no capability and rejection of a client that
  omits UI contract schema 1;
- exact dotted-name exhaustiveness and underscore alias rejection;
- duplicate request correlation and raw canonical operation IDs;
- event sequence/ack monotonicity;
- pre-visible retry, post-visible interruption, cancellation rewind, and
  accepted reconciliation fixtures;
- transcript/model/slash/path/content cursor binding and paging limits;
- setup/auth secret canaries absent from events/results/logs/operation records;
- paused-reader coalescing, admission pause, ten-second detach, and no critical
  frame loss;
- crash at every operation-ledger and canonical durability boundary;
- OpenTUI PTY flows through adapter only.

Commands:

```bash
cargo test -p praana-cli --test ipc_ui_contract_v1
cargo test -p praana-cli --test ipc_framing
cargo test -p praana-cli --test ipc_backpressure
cargo test -p praana-cli --test ipc_restart
```

## 16. Implementation sequence and deletion gate

1. Implement strict framing/handshake/envelopes with an echo harness.
2. Generate or hand-write exhaustive conversion from the UI contract mapping
   and compare against its fixture manifest.
3. Implement request correlation, response cache, event sequence, and ack.
4. Implement bounded writer/coalescing and paused-reader tests.
5. Connect typed core command execution and semantic event sink.
6. Add TypeScript adapter behind a development flag and remove direct service
   access in IPC mode.
7. Add operation-ledger reconnect, tail reconciliation, PTY, fault, and security
   tests.
8. Make IPC the sole production OpenTUI core path after all tests and soak gates
   pass.

### 16.1 Bounded Phase 7 packet

Create only `crates/praana-cli/src/ipc/{mod,framing,convert,server,writer}.rs`,
the tests listed in section 15, and `src/ui/ipc/` temporary TypeScript adapter
files. Check in mirrored UI-contract wire fixtures first. `cargo test -p
praana-cli --test ipc_ui_contract_v1` must initially fail on missing IPC modules;
the TypeScript adapter test must initially fail on missing child client. Build
framing/conversion with an echo server, then bounded writer, then session/turn
adapter and restart. Green requires all four focused Rust commands, OpenTUI PTY
tests, `bun typecheck`, `bun test`, fmt, clippy with warnings denied, and
workspace tests. Do not add semantic DTOs, direct service access, TCP, or a
TypeScript fallback core.

Delete IPC only after Ratatui imports the same UI contract directly, every
retained OpenTUI behavior has Rust coverage or an approved deletion, release
archives require no TypeScript/Bun/OpenTUI path, and the Ratatui specification's
full cutover gate passes. Deletion does not change core semantic DTOs.
