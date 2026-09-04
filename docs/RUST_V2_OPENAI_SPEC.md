# PRAANA Rust v2 OpenAI and OpenRouter Protocol Specification

Status: Normative v1

Date: 2026-08-31

OpenAI adapter specification version: 1

Scope: OpenAI-compatible Chat Completions, OpenAI Responses, and the OpenAI/OpenRouter provider profiles for Rust v2.

## 1. Normative Language

The terms MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, and MAY are normative.

This specification defines new Rust v2 behavior. It does not require compatibility with old PRAANA config, sessions, databases, event schemas, TypeScript message flattening, malformed tool-argument repair, OpenAI key fallback for OpenRouter, or undocumented gateway quirks.

The TypeScript implementation is evidence for behavior explicitly retained here. It is not the authority where this specification makes a different decision.

This document is the exclusive normative owner of literal OpenAI/OpenRouter
wire roles, fields, ordering, SSE mapping, and OpenAI retry delay/backoff. The
canonical protocol owns envelopes, accepted messages, projection, and attempt
lifecycle. History, Compaction, StateGraph, Tool Runtime, and Memory own their
specialized DTOs. A logical authority order in the plan or protocol never
overrides the literal wire placement specified here.
`docs/RUST_V2_CONFIG_SPEC.md` exclusively owns provider/LLM config keys,
defaults, sources, merge, URL normalization, context-window overrides, output
and timeout values, and future-key rejection.
`docs/RUST_V2_PROVIDER_CATALOG_CREDENTIAL_SPEC.md` owns provider/profile trust,
catalogs, endpoint fingerprints, and credential resolution.
`docs/RUST_V2_SYSTEM_CONTEXT_SPEC.md` owns provider-neutral instruction slot
bytes; this adapter owns only their OpenAI/OpenRouter placement.

OpenAI reasoning behavior in this revision was verified on 2026-09-01 against
the official Reasoning guide at
`https://developers.openai.com/api/docs/guides/reasoning`. In particular,
stateless `store:false` responses return `encrypted_content` by default, the
legacy `reasoning.encrypted_content` include remains accepted but is not
required, and manual replay must preserve every assistant message `phase`.

## 2. Protocol Scope

Rust v2 initially implements these combinations:

| Provider profile | Protocol ID | Endpoint | Supported |
|---|---|---|---|
| `openai` | `openai-chat-v1` | `/chat/completions` | Yes |
| `openai` | `openai-responses-v1` | `/responses` | Yes |
| `openrouter` | `openai-chat-v1` | `/chat/completions` | Yes |
| `openrouter` | `openai-responses-v1` | `/responses` | No |

OpenRouter Responses support is out of scope for v1. It MUST NOT be inferred from endpoint availability. Selecting that combination returns `unsupported_protocol` before auth or network access.

The generic Chat serializer is profile-driven, but v1 ships only the two profiles above. Azure, OpenAI Codex OAuth, DeepSeek, Groq, Ollama, custom gateways, Anthropic, Gemini, and Bedrock are separate specifications.

## 3. Core Invariants

- Canonical accepted messages are the local source of truth.
- Provider response IDs are never the local source of truth.
- The adapter never executes tools.
- The adapter never repairs malformed streamed JSON arguments.
- Tool calls from a failed, aborted, truncated, or superseded attempt are never executable.
- Parallel calls and results are associated by call ID, not name or completion order.
- Provider output item order is retained.
- Encrypted reasoning is opaque continuation data, not transcript text.
- Secrets never enter logs, fixtures, error messages, telemetry attributes, or request digests.
- Retry is allowed only before the first observable model content/tool emission from an attempt.
- Every retry is a fresh canonical attempt and runs fresh admission before its network request.
- Cached input tokens still occupy the context window.

Strings such as `call_01`, `rs_01`, `resp_...`, and provider request IDs in
wire examples are explicitly provider-owned opaque IDs, not canonical local
IDs. Any canonical ID appearing in an adapter fixture uses a raw uppercase
26-character ULID with no `turn_`, `attempt_`, or similar prefix.

## 4. Canonical Provider Input

The adapter receives a read-only projected request from the orchestrator; it
does not read session storage. It imports, rather than redeclares, canonical
types from the protocol and specialized owners:

```rust
use crate::protocol::{
    AssistantBlock, ConversationMessage, ConversationProjection, FinishReason,
    OpenAiResponsesContinuation, ProviderContinuation, ProviderUsage, ToolCall,
};
use crate::tools::{ToolCatalog, ToolDescriptor};
```

The remaining profile, model, reasoning, resolved output, temperature, tool-choice, and
internal-request controls are adapter inputs. They are not alternate canonical
message or usage schemas. The adapter converts them to a secret-free OpenAI wire
body and returns adapter events/errors to the protocol attempt controller.

`resolved_max_output_tokens` is the already-clamped `Rout` produced by request
admission. The adapter has no access to raw `llm.max_output_tokens`, does not
clamp again, and serializes this exact value. This guarantees the amount reserved
by admission equals the provider wire limit.

### 4.1 Instruction blocks

OpenAI uses one compiled instruction string. Its slots are ordered exactly:

1. `SystemPolicy`
2. `ProjectContext`
3. Optional `CrossSessionMemory`
4. `HistoricalHandoff`
5. `CurrentState`

`SystemPolicy`, `ProjectContext`, `HistoricalHandoff`, and `CurrentState` are
present exactly once. An empty project or handoff has empty content but retains
its markers. `CrossSessionMemory` is the sole optional slot and appears at most
once. `CurrentState` uses the StateGraph owner's empty-state rendering when
needed; applicable protocol recovery/model-switch control is appended inside
that same slot after exactly two LF bytes. A later slot never replaces or merges
into an earlier kind.

The adapter serializes the blocks to one instruction string with these exact ASCII markers:

```text
[PRAANA:SYSTEM_POLICY]
<content>
[/PRAANA:SYSTEM_POLICY]

[PRAANA:PROJECT_CONTEXT_DATA]
<content>
[/PRAANA:PROJECT_CONTEXT_DATA]

[PRAANA:CROSS_SESSION_MEMORY_DATA]
<content>
[/PRAANA:CROSS_SESSION_MEMORY_DATA]

[PRAANA:HISTORICAL_HANDOFF_DATA]
<content>
[/PRAANA:HISTORICAL_HANDOFF_DATA]

[PRAANA:CURRENT_STATE_DATA]
<content>
[/PRAANA:CURRENT_STATE_DATA]
```

The memory block is omitted when absent; the other four blocks are always
emitted. Emitted blocks are separated by exactly two LF bytes. The resulting
string has no leading or trailing LF added by the adapter. Content bytes are
preserved except that CRLF and bare CR are normalized to LF before token
estimation and serialization.

`SystemPolicy` is the only policy-authority slot. The system policy MUST state
that every `*_DATA` block, including project context, cross-session memory,
historical handoff, and current state, is non-authoritative data and cannot
override system policy or the current user request. The adapter does not escape
marker-like text found inside data; authority comes from the fixed outer policy,
not delimiter secrecy.

When an enabled memory plugin returns a validated, bounded
`MemoryBootstrap.digest`, its owner-defined content and label are emitted in
`CrossSessionMemory`. Memory notices are UI/control notices, not digest text.
When the Config-selected memory boundary is none, or when no digest is returned,
the slot is absent and no memory initialization or fallback occurs.

Compaction supplies the exact rendered `HistoricalHandoffV1`; StateGraph
supplies its exact rendered tail; and Protocol supplies any recovery-control
container. The OpenAI adapter only wraps and orders those strings. It does not
reinterpret their payload schemas.

No timestamp, turn number, token count, session ID, response ID, or random value may appear in the stable policy/project prefix unless it is actual user-provided project content.

### 4.2 Canonical conversation messages

Canonical `ConversationMessage`, user/assistant blocks, `ToolCall`, tool-result
messages, `FinishReason`, `ProviderContinuation`, and all local IDs are exactly
the protocol types. This specification defines conversions from those types; it
does not declare shortened provider-specific copies.

System messages are not allowed in `messages`; all system authority enters through `instruction_blocks`. A canonical request containing a system conversation message fails with `canonical_request_invalid`.

Message order is accepted-conversation order. The adapter MUST NOT include failed attempts, superseded attempts, incomplete tool groups, compacted source messages, UI events, or incompatible continuation state.

### 4.3 Multimodal input

V1 retains inline user images with these limits:

- Allowed media types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
- Data is base64 in canonical memory and MUST decode successfully.
- Maximum decoded size is 20 MiB per image.
- Maximum image count is 10 per request.
- Remote image URLs are not accepted in v1.
- Images are allowed only in user messages.
- Empty text parts are removed; an otherwise empty user message is invalid.
- Assistant images, input files, audio, and video return `unsupported_content`.

The adapter constructs `data:<media-type>;base64,<data>` without changing the
base64 alphabet or adding whitespace. Admission includes each image through the
model capability profile's pinned `TokenEstimatorV1` additional-item rule; it
never treats base64 character count as ordinary text token count.

### 4.4 Tool definitions

The adapter receives the ordered `ToolCatalog` and `ToolDescriptor` values from
the Tool Runtime specification. It does not declare a second tool-definition
DTO.

Rules:

- Built-in names already match Tool Runtime's lower snake-case grammar
  `^[a-z][a-z0-9_]{0,63}$`.
- Names are unique in a request.
- Description is non-empty and at most 4096 UTF-8 bytes.
- `parameters` is a JSON Schema object whose root `type` is `object`.
- Remote `$ref` values are forbidden. Local references are allowed only if the provider capability table permits them; v1 profiles do not, so any `$ref` is rejected.
- Schema numbers must be finite.
- The tool registry supplies `strict`; the adapter never guesses it.
- Descriptor order is the Tool Runtime catalog order. Admission and both OpenAI
  serializers preserve it exactly; the adapter MUST NOT sort by name.
- Schema object key order does not carry meaning. Golden serializers recursively sort keys only to produce stable fixture text.

`ToolChoice` supports only `Auto`, `None`, and `Required` in v1. Selecting a named function is deferred and returns `unsupported_option`.

## 5. Provider Profiles

### 5.1 OpenAI

```text
profile id: openai
base URL config key: providers.openai.base_url
credential env: OPENAI_API_KEY
auth: Authorization: Bearer <credential>
chat max-output field: max_completion_tokens
chat reasoning request field: reasoning_effort
chat reasoning delta fields: reasoning, reasoning_content
chat streaming usage: required
responses supported: yes
```

The model string is sent exactly as configured. The adapter does not strip `openai/` or any other prefix. Model resolution must supply an API-native model ID before formatting.

### 5.2 OpenRouter

```text
profile id: openrouter
base URL config key: providers.openrouter.base_url
credential env: OPENROUTER_API_KEY
auth: Authorization: Bearer <credential>
HTTP-Referer: https://github.com/amitkumardubey/praana
X-Title: PRAANA
chat max-output field: max_tokens
chat reasoning request field: reasoning.effort
chat reasoning delta fields: reasoning, reasoning_content
chat streaming usage: required
responses supported: no
```

The OpenRouter model string retains its vendor prefix, for example `openai/gpt-5` or `anthropic/claude-sonnet-4`. The profile does not fall back to `OPENAI_API_KEY`; missing `OPENROUTER_API_KEY` is `auth_missing`.

When reasoning is enabled, OpenRouter receives:

```json
{
  "reasoning": {
    "effort": "medium",
    "exclude": false
  }
}
```

`exclude: false` is required so returned reasoning text can be observed when the selected model/provider exposes it. The exact effort must be allowed by the resolved model capability. No value is silently remapped.

### 5.3 Model capabilities

The model registry resolves before request formatting:

- Context window.
- Maximum output tokens.
- Accepted reasoning effort values.
- Whether temperature is accepted with reasoning.
- Whether parallel tool calls are accepted.
- Whether images are accepted and their occupancy estimate.
- Resolved model revision used by exact Responses continuation scope.

Unknown models may use conservative feature and output behavior, but they MUST
have a nonzero `llm.context_window` or a trusted provider/catalog value. If no
trusted context window is available, admission fails before auth/network with
`ADMISSION_CONTEXT_WINDOW_UNKNOWN`; the adapter never guesses a context window.
Unknown models do not gain reasoning, images, or continuation capabilities by
name heuristic. Unsupported requested features fail before network access.

## 6. URL and Header Rules

### 6.1 Base URL validation

An explicit base URL MUST:

- Be an absolute `https` URL, or `http` only for a loopback host.
- Have no username or password.
- Have no query or fragment.
- Preserve its configured path prefix.
- End with no semantic endpoint segment; the adapter appends its endpoint.

Strip trailing `/` bytes and append exactly `/chat/completions` or `/responses`. Do not probe alternate endpoints and do not retry a 404 against another path.

Invalid values return `base_url_invalid` before auth or network access.

### 6.2 Header construction

Headers are assembled in this order:

1. `content-type: application/json`
2. `accept: text/event-stream`
3. `user-agent: praana/<build-version>`
4. Provider profile attribution headers.
5. Authorization.
6. Allowed `providers.<id>.extra_headers` from the Config specification.

Header names compare case-insensitively. Extra headers MUST NOT set or override:

- `authorization`
- `proxy-authorization`
- `cookie`
- `set-cookie`
- `host`
- `content-length`
- `content-type`
- `accept`
- `user-agent`
- `http-referer`
- `x-title`

An attempted override returns `header_forbidden`. Empty names, invalid HTTP token names, CR/LF in names or values, and non-UTF-8 values return `header_invalid`.

### 6.3 Credential resolution

Credential precedence is:

1. Explicit in-memory credential passed by the authenticated caller.
2. Rust v2 credential store entry for the exact provider profile.
3. The profile's exact environment variable.

Trim surrounding ASCII whitespace once. Empty credentials are missing. Credentials are never read from arbitrary custom headers or project config files.

Auth resolution occurs after request admission, so hooks and admission diagnostics never receive a secret-bearing wire request.

### 6.4 Secret handling

- Never log header values for authorization, cookies, API keys, or configured secret headers.
- Structured logs contain header names and the literal value `[REDACTED]` only.
- Canonical `request_hash` is computed from the complete secret-free wire body
  and excludes all HTTP headers exactly as the protocol specifies. Any separate
  diagnostic header fingerprint first replaces secret values with
  `[REDACTED]` and is not `request_hash`.
- HTTP error bodies are parsed and sanitized before logging; raw bodies are never logged.
- Provider request IDs may be logged after validation as visible ASCII up to 256 bytes.
- Golden fixtures use `[REDACTED]`, never syntactically plausible keys.
- Debug mode does not weaken these rules.

## 7. Chat Completions Request Mapping

### 7.1 Top-level body

The semantic body is constructed in this order for stable fixtures, although JSON object order is not protocol-significant:

```json
{
  "model": "gpt-5",
  "messages": [],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

Conditional fields are added as follows:

- `tools`: present only when non-empty.
- `tool_choice`: present only when tools are present. Map `Auto` to `auto`, `None` to `none`, and `Required` to `required`.
- `parallel_tool_calls`: `true` when tools are present and the model capability allows parallel calls; omitted otherwise.
- OpenAI `max_completion_tokens`: `resolved_max_output_tokens`.
- OpenRouter `max_tokens`: `resolved_max_output_tokens`.
- `temperature`: present only when optional `llm.temperature_milli` is set and
  allowed by model capabilities.
- OpenAI `reasoning_effort`: present when reasoning is not off.
- OpenRouter `reasoning`: present as specified in Section 5.2 when reasoning is not off.

For ordinary assistant turns the adapter MUST NOT send `store`, `n`, `logprobs`,
`top_logprobs`, `seed`, `response_format`, `functions`, or legacy
`function_call` in v1. The internal compaction exception is defined in section
8.5 and does not apply to user turns.

If streaming usage is not supported by a future profile, that profile is not v1-compatible. V1 never silently omits `stream_options` for OpenAI or OpenRouter.

### 7.2 System instruction

The compiled instruction string is non-empty and is the first message:

```json
{
  "role": "system",
  "content": "<compiled instruction string>"
}
```

There is exactly one wire system message containing the complete five-slot
instruction string. Additional wire system/developer messages are forbidden.

### 7.3 User mapping

A user message with one text part maps to:

```json
{
  "role": "user",
  "content": "text"
}
```

A multimodal user message maps each canonical part in original order:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "inspect this" },
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/png;base64,..."
      }
    }
  ]
}
```

Do not add `detail` in v1.

### 7.4 Assistant mapping

Chat wire format cannot represent arbitrary interleaving of text and tool calls. A canonical assistant message is Chat-compatible only when:

- All `Text` blocks precede all `ToolCall` blocks.
- It contains no replay-required `ReasoningSummary` block.
- It contains at most one `Refusal` block, after every `Text` block, and no tool
  call in that message.

Adjacent text blocks are concatenated with no inserted separator. Empty text with tool calls maps to `content: null`. Tool calls map in canonical block order:

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_01",
      "type": "function",
      "function": {
        "name": "read_file",
        "arguments": "{\"path\":\"README.md\"}"
      }
    }
  ]
}
```

A refusal-only replay is:

```json
{"role":"assistant","content":null,"refusal":"I cannot help with that request."}
```

When preceding text exists, `content` is that concatenated text and `refusal`
is still the exact refusal block text. Capture a non-empty Chat response
`refusal` as canonical `AssistantBlock::Refusal` after visible text. Never map
it to `content`, and reject multiple or empty refusal values.

`raw_arguments` is sent exactly as accepted. It MUST parse as one JSON object and match `arguments`; mismatch is `canonical_request_invalid`. The adapter never reserializes from `arguments` when raw bytes are present.

Chat reasoning deltas are captured as canonical `ReasoningSummaryBlock` values
for display/audit. They are omitted from Chat replay unless the exact provider
profile defines a fixture-tested dedicated reasoning-summary wire field. They
are never concatenated into assistant `content`. Neither v1 profile defines
such a replay field, so v1 always omits them from Chat replay. A model must put
conclusions needed for continuation into assistant text. Active tool calls and
results remain portable.

### 7.5 Tool result mapping

```json
{
  "role": "tool",
  "tool_call_id": "call_01",
  "content": "<deterministically serialized output>"
}
```

After an assistant tool-call message, the projection emits exactly one result per call, in the original assistant call order, regardless of parallel execution completion order. Every ID must match exactly once. No non-tool message may appear until the complete result group is emitted.

An error result is still a tool message. The canonical tool-result serializer must encode error status in `output`; the adapter does not add provider-specific error syntax.

### 7.6 Tool schema mapping

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "Read a file",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    },
    "strict": true
  }
}
```

The adapter preserves the canonical schema semantically and always emits the canonical `strict` value.

## 8. Responses Request Mapping

### 8.1 Top-level body

The default Responses request is stateless and local-first:

```json
{
  "model": "gpt-5",
  "input": [],
  "stream": true,
  "store": false
}
```

Conditional fields:

- `instructions`: required complete five-slot compiled instruction string.
- `tools`, `tool_choice`, and `parallel_tool_calls`: same conditions as Chat, using Responses tool shape.
- `max_output_tokens`: `resolved_max_output_tokens`.
- `temperature`: only when optional `llm.temperature_milli` is set and
  capability-allowed.
- `reasoning`: when reasoning is enabled.
- `include`: omitted in v1; stateless encrypted reasoning is returned by
  default. Legacy include behavior requires a later adapter/profile version.
- `previous_response_id`: forbidden in schema v1; Section 10 reserves future
  behavior.

Reasoning request shape is:

```json
{
  "reasoning": {
    "effort": "medium",
    "summary": "auto",
    "context": "current_turn"
  }
}
```

`summary: auto` is REQUIRED whenever reasoning is enabled. Emit
`context: current_turn` exactly when the resolved capability profile reports
`CurrentTurn` or `AllTurns`; omit `context` for `Unsupported`. Never send
`all_turns` in schema v1. `current_turn` matches
`history.reasoning_replay = active`: local
manual replay supplies every output item from the active tool cycle but does
not ask the provider to render reasoning from earlier completed turns. The
adapter captures non-empty encrypted reasoning returned by stateless mode
without requesting the legacy include. If reasoning is off, the complete
`reasoning` field is omitted.

### 8.2 User input items

Text-only user messages use an explicit input item:

```json
{
  "type": "message",
  "role": "user",
  "content": [
    { "type": "input_text", "text": "hello" }
  ]
}
```

Inline images preserve content order:

```json
{
  "type": "message",
  "role": "user",
  "content": [
    { "type": "input_text", "text": "inspect" },
    { "type": "input_image", "image_url": "data:image/png;base64,..." }
  ]
}
```

### 8.3 Assistant message items

Portable assistant text maps to:

```json
{
  "type": "message",
  "role": "assistant",
  "phase": "commentary",
  "content": [
    {
      "type": "output_text",
      "text": "result",
      "annotations": []
    }
  ]
}
```

`phase` is `commentary` or `final_answer`. Capture the exact provider value in
both canonical `AssistantMessage.phase` and
`OpenAiResponseMessageItem.phase`, then preserve it during manual replay. Omit
the wire field only when canonical phase is null; never infer a phase from item
order or finish reason. Dropping a present phase is a continuation-fixture
failure.

A refusal maps to canonical `AssistantBlock::Refusal`, then back to a content
part with `type: refusal` and `refusal: <text>` during replay. Text and refusal
parts preserve their order. The adapter never converts refusal text into
ordinary assistant text or user content.

### 8.4 Function calls and outputs

Function call:

```json
{
  "type": "function_call",
  "call_id": "call_01",
  "name": "read_file",
  "arguments": "{\"path\":\"README.md\"}"
}
```

Function output:

```json
{
  "type": "function_call_output",
  "call_id": "call_01",
  "output": "<deterministically serialized output>"
}
```

Within an accepted assistant step, output items retain provider `output_index` order. After the step, function outputs are appended in function-call order, not tool completion order.

Responses tool definitions are flat:

```json
{
  "type": "function",
  "name": "read_file",
  "description": "Read a file",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "strict": true
}
```

### 8.5 Internal compaction control input

An admitted compaction attempt carries a host-generated internal control query,
not a canonical `UserMessage`. The query is absent from
`ConversationProjection.messages`, never produces `UserMessageAccepted`, and is
never returned as accepted conversation after the attempt.

For Chat, the adapter appends one ephemeral wire `user` message after the
projected source prefix. For Responses, it appends one ephemeral `message` input
item with `role: user`. In both protocols the content is:

```text
[PRAANA:INTERNAL_COMPACTION_CONTROL]
{exact UTF-8 bytes returned by render_compaction_control_v1}
[/PRAANA:INTERNAL_COMPACTION_CONTROL]
```

The brace line above names a function and is not literal wire text. The exact
content between the marker lines is the return value of
`render_compaction_control_v1` defined by `RUST_V2_COMPACTION_SPEC.md`; the
adapter adds no whitespace and both marker lines end in LF. This provider-role
adaptation does not fabricate user history. The exact bytes
are included in request hashing and admission, tools are absent, and successful
output can become canonical only through `HistoryCompactedV1`. The five-slot
instruction string remains one string and is not modified to impersonate a
current user message.

Strict candidate output uses the checked-in schema and hash from Compaction.
Chat Completions adds this field only for an internal compaction attempt:

```rust
json!({"response_format": {"type": "json_schema", "json_schema": {
    "name": "praana_compaction_candidate_v1",
    "strict": true,
    "schema": schema_json
}}})
```

Responses adds this field only for an internal compaction attempt:

```rust
json!({"text": {"format": {
    "type": "json_schema",
    "name": "praana_compaction_candidate_v1",
    "strict": true,
    "schema": schema_json
}}})
```

`schema_json` is the parsed JSON object from the exact checked-in schema bytes;
the adapter inserts it without modification. It is not serialized as a string.
The request hash uses the resulting complete
wire body. If the selected model/profile does not support this strict schema
shape, it cannot be selected as a compactor.

## 9. Responses Reasoning Capture and Replay

### 9.1 Continuation data

The adapter converts validated response accumulators into the exact protocol
`OpenAiResponsesContinuation`, `ContinuationScope`, and ordered
`OpenAiResponseOutputItem` types. It does not persist arbitrary response JSON or
an OpenAI-local continuation DTO.

The persisted continuation retains original output item order. It contains only validated fields required for replay, not arbitrary response JSON.

For a reasoning output item, capture:

- `type`, which must be `reasoning`.
- Optional provider item `id` after validation.
- Ordered `summary` text parts for visible reasoning summary.
- Non-empty `encrypted_content` exactly as received.

For every message output item, capture and replay its optional `phase` exactly.

Encrypted content is opaque. It MUST NOT be decoded, tokenized as text, summarized, displayed, indexed, searched, sent to memory plugins, or included in diagnostic dumps. It may be encrypted at rest by a future storage layer, but at minimum follows session-file permissions and secret-safe logging.

### 9.2 Active-cycle replay

Effective `history.reasoning_replay = active` means:

1. A Responses assistant step requests one or more function calls.
2. The complete accepted output item list is durably stored before tools run.
3. Tool results become durable.
4. The next same-model Responses request replays accepted output items in original order.
5. Function outputs follow in call order.
6. This repeats for additional tool cycles.
7. Once a terminal assistant response is accepted, opaque continuation is no longer included in the next user turn.

In stateless `store:false` mode, encrypted reasoning is returned by default and
reasoning items are replayed as:

```json
{
  "type": "reasoning",
  "id": "rs_01",
  "summary": [
    { "type": "summary_text", "text": "Checked the constraints." }
  ],
  "encrypted_content": "opaque-ciphertext"
}
```

Omit `id` if the provider omitted it. Never fabricate an item ID.

If a reasoning-enabled response requests tools and a reasoning item lacks
required non-empty encrypted content, the step may be displayed but cannot be
accepted for tool execution. Return `continuation_unavailable`, mapped to
canonical `E_CONTINUATION_MISSING`. A response ID cannot bypass this local
requirement. Do not silently discard reasoning and continue.

### 9.3 Compatibility boundary

Continuation is compatible only when all are equal:

- Provider profile.
- Protocol ID.
- Exact model ID.
- Resolved model revision, including exact `None` equality.
- Endpoint fingerprint as part of the provider scope.
- Reasoning replay policy.

String-prefix, model-family, and registry compatibility declarations are
forbidden in v1. Unknown models are compatible only under the same exact
provider/protocol/model/revision/endpoint scope.

Reasoning continuation is not translated into Chat reasoning fields, OpenRouter reasoning text, system messages, or assistant text.

## 10. Response IDs as an Optional Optimization

Initial schema-v1 behavior is `store: false`, no `previous_response_id`, and
complete local stateless replay.

An explicit future setting may enable server-side continuation for the active
tool cycle. `RUST_V2_CONFIG_SPEC.md` rejects that future key in schema v1. A
later config/provider specification must enable all of these rules together:

- Send `store: true` on the originating response.
- Persist complete local replay material anyway.
- On the next request, send `previous_response_id` and only new function outputs/current input, not duplicated prior output items.
- Use it only with the exact same provider profile, endpoint fingerprint,
  protocol ID, model ID, and resolved model revision.
- Clear it after terminal response, compaction boundary, reset, model switch, or provider switch.
- Never use it as proof that a local assistant step was accepted.

If the provider rejects `previous_response_id` with missing/expired/not-found
semantics before model emission, perform at most one new canonical attempt
without the ID using complete local stateless replay. The replacement attempt
runs fresh admission and records the supersession and fallback. This fallback
is allowed only once per request and is recorded as
`continuation_id_rejected`. If any required local replay material, including
required encrypted reasoning, is incomplete, return `continuation_unavailable`
instead; the response ID never authorizes degraded continuation.

Do not query provider history to reconstruct local state. Do not retain a response ID while dropping its local accepted messages.

## 11. Model and Provider Switching

A switch creates a protocol boundary before the next request.

The orchestrator MUST:

1. Append a durable model-change event.
2. Remove incompatible opaque continuation from the model-visible request.
3. Clear `previous_response_id`.
4. Preserve portable accepted text, function calls, and function outputs.
5. Add a visible, non-authoritative handoff naming the prior provider/model and available tools.
6. Re-resolve capabilities and context window.
7. Re-run admission with the target protocol's framing and output reserve.
8. Expect a prompt-cache miss and record reported cache usage.

The system never inserts encrypted reasoning into the handoff. Switching back later does not revive old active-cycle reasoning state. Automatic per-turn routing is out of scope.

## 12. Streaming Event Contract

The OpenAI adapter emits adapter events to the protocol attempt controller:

```rust
enum OpenAiAdapterEvent {
    ResponseMetadata { response_id: Option<String>, model: Option<String> },
    OutputItemStarted { output_index: u32, item_kind: OutputItemKind },
    TextDelta { output_index: u32, delta: String, refusal: bool },
    ReasoningDelta { output_index: u32, delta: String },
    ToolCallStarted { output_index: u32, call_id: String, name: String },
    ToolCallArgumentsDelta { output_index: u32, call_id: String, delta: String },
    ToolCallCompleted { output_index: u32, call: ToolCall },
    OutputItemCompleted { output_index: u32 },
    Usage(ProviderUsage),
    Completed { finish_reason: FinishReason },
}
```

This is an adapter type, not a competing canonical event or usage schema.
`ToolCall`, `ProviderUsage`, and `FinishReason` above are imported protocol
types produced only after the explicit conversions in this specification.
Events retain `output_index`. The UI may flatten display, but persistence and
continuation do not.

Metadata and usage received before the emission barrier are buffered inside the attempt. The controller publishes them only when the attempt is accepted for emission or completes successfully with no content.

## 13. SSE Framing Requirements

### 13.1 Byte parser

Implement one protocol-independent SSE byte parser with no provider JSON logic.

It MUST:

- Accept arbitrarily split byte chunks.
- Decode UTF-8 incrementally across multibyte boundaries.
- Accept LF, CRLF, and bare CR line endings.
- Ignore one UTF-8 BOM only at stream start.
- Treat an empty line as the only event dispatch boundary.
- Ignore comment lines beginning with `:`.
- Parse `data`, `event`, `id`, and `retry` fields.
- Ignore unknown fields.
- Remove at most one ASCII space immediately after the field colon.
- Join multiple `data` lines with one LF.
- Preserve all other data bytes after UTF-8 decoding.
- Retain the latest `event` and `id` field within one frame.
- Reject an `id` containing NUL.
- Parse `retry` only as non-negative decimal milliseconds; adapters do not use server retry values for API retry policy.
- Release/cancel the body stream when its consumer stops.

Limits:

- Maximum line length: 1 MiB decoded.
- Maximum accumulated event data: 8 MiB decoded.
- Maximum undecoded byte buffer: 8 MiB.

An over-limit frame returns `sse_frame_too_large` and terminates the attempt.

Invalid UTF-8 returns `stream_invalid_utf8`. Lossy replacement is forbidden.

At clean EOF:

- If no frame is pending, return EOF.
- If fields are pending without a blank-line terminator, return `stream_truncated` and do not dispatch that frame.

This strict EOF rule prevents a cut JSON object from being accepted as a complete event.

### 13.2 JSON event parsing

After SSE framing:

- Empty `data` is ignored.
- Chat data equal to `[DONE]` is a terminal marker.
- Responses may emit `[DONE]`; it is ignored after a valid Responses terminal event and is otherwise not sufficient for completion.
- Every other data frame MUST be valid JSON object text.
- Invalid JSON returns `stream_invalid_json`; it is never silently skipped.
- A JSON array, scalar, or null returns `protocol_violation`.
- Unknown provider event types are ignored only if they do not claim an existing output index/item and do not carry an error. Count them in telemetry by type.

## 14. Chat Stream Mapping

### 14.1 Choice rules

- V1 requests one completion and accepts only `choices[0]`.
- A chunk with multiple non-empty choices is `protocol_violation`.
- Empty choices are allowed for usage-only chunks.
- Role deltas are metadata and do not create text.

### 14.2 Text, refusal, and reasoning

- Chat message text, refusal, and reasoning events use `output_index = 0` in
  `OpenAiAdapterEvent`; tool events use their wire tool-call index.
- Non-empty `choice.delta.content` emits `TextDelta` with `refusal = false`.
- Non-empty `choice.delta.refusal` emits `TextDelta` with `refusal = true`.
- Non-empty `choice.delta.reasoning` emits `ReasoningDelta`.
- Otherwise non-empty `choice.delta.reasoning_content` emits `ReasoningDelta`.
- If both reasoning fields occur in one chunk with different values, return `protocol_violation`; do not duplicate them.
- A non-empty text or refusal delta after any tool call has started is `protocol_violation`, because Chat history cannot replay that item ordering losslessly.
- Empty strings emit nothing.

### 14.3 Fragmented and parallel tool calls

Each `delta.tool_calls[]` MUST contain an integer `index`. Accumulation is keyed by that index.

For each index:

- The first non-empty `id` becomes the call ID.
- The first non-empty function `name` becomes the name.
- Later non-empty IDs/names must match exactly.
- Argument fragments append in arrival order for that index.
- Calls at different indexes may interleave arbitrarily.
- Duplicate indexes after completion are `protocol_violation`.
- Missing or empty provider call ID at completion is canonical
  `E_TOOL_CALL_ID_MISSING`; no ID is synthesized. Missing name is
  `protocol_violation`.
- The complete argument string must parse as one JSON object.
- Non-object JSON and malformed/truncated JSON are `tool_arguments_invalid`.
- No braces, quotes, commas, or escapes are repaired.
- `ToolCallStarted` emits only after both ID and name are known.
- Argument deltas received before ID/name are buffered, then emitted in one delta immediately after start.
- `ToolCallCompleted` emits in ascending tool-call index after all calls validate.

Finish reason mapping:

| Wire value | Canonical value |
|---|---|
| `stop` | `stop` |
| `tool_calls` | `tool_use` |
| `length` | `length` |
| `content_filter` | Provider failure `provider_content_filter`, mapped to canonical `E_PROVIDER_CONTENT_FILTER` |
| null before terminal | no decision |
| any other non-empty value | Provider failure `unsupported_output_item`, mapped to canonical `E_PROVIDER_OUTPUT_UNSUPPORTED` |

A clean Chat stream is accepted when it has a finish reason and then either `[DONE]` or clean EOF. EOF before a finish reason is `stream_truncated`. A usage-only stream with no choice/finish is invalid.

If finish reason is `tool_calls`, at least one complete tool call is required. If any call is incomplete or invalid, the whole assistant step fails and no call is executable.
After empty text/reasoning parts are removed, a terminal response with no block
is `provider_empty_response`, mapped to canonical
`E_PROVIDER_OUTPUT_UNSUPPORTED`; no empty assistant step is accepted.

## 15. Responses Stream Mapping

The adapter determines type from JSON `type`. If the SSE `event` field is present, it must equal JSON `type`; mismatch is `protocol_violation`.

### 15.1 Metadata

- `response.created` captures validated response ID and model.
- A response ID is optional canonical metadata.
- Later response IDs in the same attempt must match.

### 15.2 Output items

`response.output_item.added` requires `output_index` and an item.

- `message`: start a message item at the index.
- `reasoning`: start a reasoning item at the index.
- `function_call`: bind `output_index`, item ID if present, non-empty `call_id`,
  name, and any initial arguments. Missing/empty `call_id` is canonical
  `E_TOOL_CALL_ID_MISSING`; no ID is synthesized.
- Unsupported item types return `unsupported_output_item` if they contain model-visible output; metadata-only unknown items may be ignored with telemetry.

An output index is bound to one item kind and cannot be reused.

### 15.3 Text and refusal events

- `response.output_text.delta` emits normal text for its output index.
- `response.refusal.delta` emits refusal text for its output index.
- Corresponding `.done` events verify, but do not re-emit, the accumulated text when the event includes full text.
- A full-text mismatch is `protocol_violation`.

### 15.4 Reasoning events

Recognize all of:

- `response.reasoning_summary_part.added`
- `response.reasoning_summary_text.delta`
- `response.reasoning_summary_text.done`
- `response.reasoning_text.delta`
- `response.reasoning_text.done`

Summary and reasoning text deltas emit `ReasoningDelta` in arrival order. Done events verify accumulated text when full text is supplied.

On `response.output_item.done` for a reasoning item, capture the complete validated item, including `encrypted_content`. The complete item is authoritative for encrypted content; deltas never construct ciphertext.

### 15.5 Function arguments

- `response.function_call_arguments.delta` appends to the function call at `output_index`.
- If `item_id` or `call_id` is present, it must match the bound item.
- `response.function_call_arguments.done` verifies its complete `arguments` against accumulated bytes when present.
- `response.output_item.done` finalizes the function call if not already finalized.
- Final arguments must be one JSON object and are never repaired.
- Calls may interleave by output index.

### 15.6 Terminal events

- `response.completed` requires a response object with status `completed` and maps to `Completed`.
- `response.incomplete`, or a completed envelope with status `incomplete`, maps
  to finish reason `length` only when the exact incomplete reason is the
  profile-tested maximum-output limit and all emitted items are
  protocol-complete. Content-filter/safety reasons map to
  `provider_content_filter`; every other reason maps to
  `unsupported_output_item`. Incomplete tool arguments fail with
  `tool_arguments_invalid` instead.
- `response.failed` maps the nested provider error and does not produce an accepted assistant step.
- Top-level `error` maps immediately to a provider error.
- EOF before a valid terminal event is `stream_truncated`.

The terminal response's `output` list, when present, must agree by index, kind, IDs, names, and complete text/arguments with accumulated stream state. A mismatch is `protocol_violation`.

After empty output/summary parts are removed, a terminal response with no
canonical block is `provider_empty_response`, not an accepted empty assistant
step.

## 16. Usage and Cache Accounting

```rust
struct OpenAiUsageAccumulator {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_write_input_tokens: Option<u64>,
    reasoning_output_tokens: Option<u64>,
}

fn into_protocol_usage(raw: OpenAiUsageAccumulator) -> ProviderUsage {
    ProviderUsage {
        input_tokens: raw.input_tokens.unwrap_or(0),
        output_tokens: raw.output_tokens.unwrap_or(0),
        reasoning_tokens: raw.reasoning_output_tokens.unwrap_or(0),
        total_tokens: raw.total_tokens.unwrap_or(0),
        cache_read_tokens: raw.cache_read_input_tokens.unwrap_or(0),
        cache_write_tokens: raw.cache_write_input_tokens.unwrap_or(0),
    }
}
```

`OpenAiUsageAccumulator` is adapter-local and preserves provider absence as
`None`. `ProviderUsage` is imported from the canonical protocol. The conversion
above is exact: it never substitutes estimates or derives a missing provider
total. Any missing category becomes canonical zero and sets
`usage_incomplete` telemetry naming the absent wire fields.

### 16.1 Chat mapping

- `input_tokens = usage.prompt_tokens`.
- `output_tokens = usage.completion_tokens`.
- `total_tokens = usage.total_tokens` when present; otherwise accumulator `None`.
- `cache_read_input_tokens = usage.prompt_tokens_details.cached_tokens` when present.
- For compatible OpenRouter payloads, `prompt_cache_hit_tokens` is a fallback only when `cached_tokens` is absent.
- `cache_write_input_tokens` is unknown unless the provider explicitly reports a cache-write field.
- `prompt_cache_miss_tokens` MUST NOT be treated as cache writes.
- `reasoning_output_tokens = usage.completion_tokens_details.reasoning_tokens` when present.

### 16.2 Responses mapping

- `input_tokens = usage.input_tokens`.
- `output_tokens = usage.output_tokens`.
- `total_tokens = usage.total_tokens` when present; otherwise accumulator `None`.
- `cache_read_input_tokens = usage.input_tokens_details.cached_tokens` when present.
- `cache_write_input_tokens` is unknown unless explicitly reported.
- `reasoning_output_tokens = usage.output_tokens_details.reasoning_tokens` when present.

### 16.3 Accounting invariants

- Missing wire values remain `None` in the adapter accumulator and become zero
  only through the explicit canonical conversion above, with
  `usage_incomplete` telemetry.
- Cached input is a subset of input, not an additional token count.
- Reasoning output is a subset of output, not additional output.
- Context occupancy uses total `input_tokens`, including cached input.
- Billing telemetry may separate cached and uncached input, but admission never subtracts cached input.
- Tool schemas, system instructions, framing, images, replayed reasoning items, function calls, and function outputs all occupy context.
- Provider-reported input tokens calibrate future estimates; they do not retroactively admit an oversized request.
- A reported total inconsistent with input plus output is retained as provider total and emits `usage_inconsistent` telemetry.
- Usage events may update more than once. Counters are snapshots, not deltas; retain the latest non-decreasing value. A decrease is `protocol_violation`.

## 17. Request Admission Hooks

Admission policy, compaction/reduction decisions, and admission errors are owned
by `RUST_V2_COMPACTION_SPEC.md`. Estimator selection, component accounting,
rounding, framing profiles, persisted estimate identity, and calibration are
owned by `RUST_V2_TOKEN_ACCOUNTING_SPEC.md`. This section defines only the
OpenAI adapter call points and ordering around formatting, auth, and send. The
variant names below are orchestration pseudocode, not duplicate DTO
declarations. Admission is provider-independent and runs before auth resolution
and network access.

Required sequence for every initial, tool-continuation, model-switch, fallback, and emergency request:

1. Project accepted canonical history.
2. Resolve exact provider profile, protocol, model capabilities, and context window.
3. Run ordered `pre_request` policy hooks on a read-only canonical request summary.
4. Validate canonical message/tool protocol.
5. Format a secret-free wire request.
6. Estimate full input occupancy with provider framing.
7. Add effective Config-spec output/reasoning reserve and estimator safety
   margin.
8. Run the admission decision.
9. If requested, compact/reduce within policy, rebuild from Step 1, and re-run admission.
10. Resolve credentials and construct secret-bearing headers.
11. Send.

`pre_request` returns exactly one of:

- `Allow`
- `Deny { code, safe_message }`
- `Rebuild { reason }`

It cannot mutate canonical messages, tools, model, URL, or headers in place. A rebuild is bounded to two per outbound request; further rebuild requests return `request_admission_loop`.

Admission returns exactly one of:

- `Admit`
- `Compact { required_tokens }`
- `ReduceOutput { new_max_output_tokens }`
- `Reject { estimated_input, reserve, context_window }`

The orchestrator may compact only eligible committed history. It may reduce output only to the configured provider-safe minimum. If the active cycle alone cannot fit, return `context_overflow` with a safe continuation instruction. No request is sent on rejection.

Phase 2 implements `Admit`, safe output reduction, and hard `Reject` with
trustworthy model-window resolution and `TokenEstimatorV1`. `Compact` is not
actionable until Phase 5; a Phase 2 runtime converts that need to a safe hard
rejection. Phase 5 adds pressure-triggered compaction and capability-profile
strategy logic without replacing the Phase 2 send-time admission gate.

Every retry, including an identical transport resend and a response-ID
fallback, creates a new canonical attempt and runs this full admission sequence
again. The estimator computation may be reused only when the exact request hash
and resolved capability-profile hash both match the prior attempt; the new
attempt still records a fresh admission decision and the source attempt of the
reuse. A context-length provider error may perform one emergency
rebuild/compaction before that fresh admission.

## 18. Retry Semantics

### 18.1 Emission barrier

An attempt crosses the emission barrier on the first non-empty:

- Text delta.
- Refusal delta.
- Reasoning delta.
- Tool call start.
- Tool argument delta.

Before the barrier, response metadata and usage are buffered. SSE comments, empty deltas, role deltas, and response-created metadata do not cross it.

Once the barrier is crossed, generic retry is forbidden. If the stream later fails, the attempt fails, partial UI output is rewound, and no partial assistant step is accepted.

### 18.2 Retryable failures

Before emission, retry only:

- DNS/connect/TLS failures classified as transient.
- Connection reset.
- Request timeout or response-header timeout.
- HTTP 408.
- HTTP 429.
- HTTP 500, 502, 503, or 504.
- Clean connection loss before any complete semantic provider event.

Do not retry generic HTTP 400, 401, 403, 404, 409, 413, 415, or 422.
Context-length errors use the one emergency admission path. The rejected
`previous_response_id` fallback in Section 10 is future behavior and is not
reachable in schema v1.

### 18.3 OpenAI delay and backoff

- The protocol attempt controller supplies and enforces the total-attempt bound;
  the OpenAI adapter does not create invisible transport attempts.
- Base delay: 500 ms.
- Backoff: full jitter uniformly from 0 through `min(8 seconds, 500 ms * 2^(retry_number-1))`.
- Respect `retry-after` seconds or HTTP date and OpenAI `retry-after-ms` when valid.
- A provider delay is capped at 30 seconds.
- Total retry wall time is capped at 60 seconds.
- The injected test clock, RNG, and sleeper make retry tests deterministic.

Each retry creates a new canonical `attempt_id`, appends/fsyncs a new attempt
start before network bytes, and records `retry_of`, admission, and any estimate
reuse exactly as the protocol requires. The same idempotency key, when a profile
later supports one, may identify network retries for one logical assistant
purpose; v1 profiles send no idempotency header. No retry path is allowed after
the emission barrier.

### 18.4 Completion without emitted content

A terminal response with no non-empty text, reasoning summary, refusal, image,
or tool call is rejected as `provider_empty_response`, mapped to canonical
`E_PROVIDER_OUTPUT_UNSUPPORTED`. Buffered metadata/usage remains failed-attempt
audit data. The adapter does not accept an empty step and does not retry this
invalid provider output.

## 19. Abort Behavior

- An already-aborted request returns `aborted` before admission side effects or network access.
- Abort during admission stops the request and returns `aborted`.
- Abort during backoff cancels the sleep immediately and prevents another attempt.
- Abort during request upload or response streaming cancels the HTTP request/body and drops the connection.
- Abort never triggers retry.
- Abort before the emission barrier publishes no model output and discards buffered metadata/usage.
- Abort after the barrier rewinds all optimistic output for that attempt.
- No partial assistant message, partial reasoning item, or partial tool call is accepted.
- No synthetic `done` message containing partial text is generated.
- If a terminal event was fully parsed and accepted before the cancellation token is observed, completion wins; otherwise abort wins.

The attempt controller durably records interruption according to the canonical event specification. The provider adapter returns a typed error; it does not append events itself.

## 20. Error Model

```rust
struct ProviderError {
    code: ProviderErrorCode,
    safe_message: String,
    provider: ProviderProfileId,
    protocol: ProtocolId,
    http_status: Option<u16>,
    request_id: Option<String>,
    retryable: bool,
    retry_after_ms: Option<u64>,
}
```

Stable v1 error code strings:

| Code | Meaning | Generic retry |
|---|---|---|
| `canonical_request_invalid` | Canonical protocol/order/value invariant failed | No |
| `unsupported_protocol` | Profile/protocol combination is not implemented | No |
| `unsupported_option` | Requested model/profile option is unsupported | No |
| `unsupported_content` | Content type is outside v1 | No |
| `unsupported_output_item` | Provider emitted unsupported visible output | No |
| `provider_empty_response` | Provider completed without one non-empty canonical assistant block | No |
| `tool_call_id_missing` | Completed provider function call omitted its required provider ID | No |
| `base_url_invalid` | Base URL validation failed | No |
| `header_invalid` | Header syntax invalid | No |
| `header_forbidden` | Protected header override attempted | No |
| `auth_missing` | No credential resolved | No |
| `request_admission_denied` | Policy hook denied request | No |
| `request_admission_loop` | Too many rebuild requests | No |
| `context_overflow` | Admitted request cannot fit | Emergency path only |
| `request_serialize_failed` | Canonical-to-wire serialization failed | No |
| `provider_bad_request` | HTTP 400/422 not otherwise classified | No |
| `provider_auth_failed` | HTTP 401 | No |
| `provider_permission_denied` | HTTP 403 | No |
| `provider_not_found` | HTTP 404 | No |
| `provider_conflict` | HTTP 409 | No |
| `provider_payload_too_large` | HTTP 413 | No |
| `provider_rate_limited` | HTTP 429 | Before emission |
| `provider_unavailable` | Retryable 5xx | Before emission |
| `provider_server_error` | Other 5xx | No unless profile classifies it |
| `provider_context_length` | Provider says context is too long | One emergency admission |
| `provider_content_filter` | Provider refused due to safety/filter | No |
| `provider_response_failed` | Responses `response.failed` | Based on nested status/code |
| `transport_error` | Network transport failure | Before emission if transient |
| `provider_timeout` | Connect/header/idle timeout | Before emission |
| `stream_invalid_utf8` | Invalid stream encoding | Before emission only |
| `sse_frame_too_large` | SSE limit exceeded | No |
| `stream_invalid_json` | Framed provider data is not JSON object | No |
| `protocol_violation` | Stream ordering/identity invariant failed | No |
| `tool_arguments_invalid` | Complete tool arguments are malformed/non-object | No |
| `stream_truncated` | EOF before valid protocol completion | Before emission only |
| `continuation_unavailable` | Required local replay material is missing | No |
| `continuation_incompatible` | Replay crosses an invalid boundary | No |
| `continuation_id_rejected` | Optional response ID was rejected | One stateless fallback |
| `aborted` | Caller cancelled | No |

Adapter-to-canonical error conversion is explicit for protocol-significant
cases:

| Adapter code | Canonical `ProtocolError.code` | Canonical class |
|---|---|---|
| `tool_call_id_missing` | `E_TOOL_CALL_ID_MISSING` | `invalid_provider_output` |
| `unsupported_output_item`, `provider_empty_response` | `E_PROVIDER_OUTPUT_UNSUPPORTED` | `invalid_provider_output` |
| `provider_content_filter` | `E_PROVIDER_CONTENT_FILTER` | `invalid_provider_output` |
| `continuation_unavailable` | `E_CONTINUATION_MISSING` | `invalid_provider_output` |
| `continuation_incompatible` | `E_CONTINUATION_INCOMPATIBLE` | `invalid_request` |
| `provider_context_length` | `E_PROVIDER_CONTEXT_LENGTH` | `context_length` |
| `provider_rate_limited` | `E_PROVIDER_RATE_LIMIT` | `rate_limit` |
| `provider_auth_failed`, `provider_permission_denied` | `E_PROVIDER_AUTH` | `authentication` |
| `provider_timeout` | `E_PROVIDER_TIMEOUT` | `timeout` |
| `stream_invalid_utf8`, `sse_frame_too_large`, `stream_invalid_json`, `protocol_violation`, `stream_truncated` | `E_PROVIDER_STREAM` | `invalid_provider_output` |

The remaining pre-send adapter validation/configuration errors are returned
before an attempt is sent and do not invent a canonical provider response.
`RUST_V2_PROTOCOL_SPEC.md` Appendix A is the final cross-surface mapping for
canonical class/status/retryability and IPC wrappers. This adapter table supplies
provider-specific inputs to that mapping; provider and canonical strings are not
claimed to be identical.

### 20.1 HTTP/body mapping

Parse OpenAI-compatible error envelopes shaped as `error.message`, `error.type`, `error.param`, and `error.code`. Match context-length and content-filter cases using explicit provider codes first; message substring matching is a last-resort profile rule and emits telemetry.

Safe messages:

- Maximum 1024 UTF-8 bytes.
- Strip control characters except LF/TAB, then replace LF/TAB with spaces for one-line logs.
- Redact known secrets and any resolved credential exact value.
- Do not include full request bodies, headers, encrypted reasoning, tool results, or unbounded provider HTML.

Unknown HTTP statuses map to `provider_bad_request` for 4xx and `provider_server_error` for 5xx. Retryability is determined by this specification, never by the provider's prose alone.

## 21. Golden Fixtures

Normative fixtures live at:

```text
tests/fixtures/rust-v2/providers/v1/
  common-sse/
  openai-chat/
    requests/
    streams/
    events/
  openai-responses/
    requests/
    streams/
    events/
  openrouter-chat/
    requests/
    streams/
    events/
```

Each request fixture is one JSON document:

```json
{
  "profile": "openai",
  "protocol": "openai-chat-v1",
  "method": "POST",
  "url": "https://api.openai.com/v1/chat/completions",
  "headers": {
    "accept": "text/event-stream",
    "authorization": "[REDACTED]",
    "content-type": "application/json"
  },
  "body": {}
}
```

Build-version-dependent `user-agent` uses `praana/<VERSION>` in fixtures. Tests substitute the fixed fixture build version `0.0.0-test`.

Each stream has a paired expected event JSONL with fixed output indexes and values. Error fixtures have a paired `.error.json` containing stable code, status, retryable flag, and safe message category, not implementation backtraces.

Required fixture basenames:

### 21.1 Common SSE

- `multiline-crlf.sse`
- `utf8-split-source.sse`
- `comments-fields.sse`
- `unterminated.sse`
- `invalid-utf8.bin`
- `oversize-event.metadata.json` (generate bytes in test; do not commit an 8 MiB file)

### 21.2 OpenAI Chat requests

- `basic-text.json`
- `system-order.json`
- `multimodal.json`
- `tools-strict-parallel.json`
- `assistant-tool-results.json`
- `reasoning-effort.json`
- `max-output-temperature.json`

### 21.3 OpenAI Chat streams

- `text-usage.sse`
- `fragmented-tool.sse`
- `parallel-interleaved-tools.sse`
- `reasoning-and-text.sse`
- `refusal.sse`
- `cache-reasoning-usage.sse`
- `usage-only-before-done.sse`
- `malformed-tool-arguments.sse`
- `missing-tool-call-id.sse`
- `content-filter.sse`
- `unknown-finish.sse`
- `empty-completed.sse`
- `disconnect-after-text.sse`
- `finish-with-clean-eof.sse`

### 21.4 OpenRouter requests/streams

- `attribution-reasoning-request.json`
- `vendor-model-tools-request.json`
- `reasoning-content.sse`
- `reasoning-field.sse`
- `cache-usage.sse`
- `rate-limit.error.json`

### 21.5 Responses requests

- `basic-text.json`
- `system-order.json`
- `multimodal.json`
- `tools-strict-parallel.json`
- `reasoning-encrypted-request.json`
- `stateless-tool-continuation.json`
- `response-id-tool-continuation.json` (deferred; not an initial gate)
- `response-id-fallback.json` (deferred; not an initial gate)

### 21.6 Responses streams

- `text-completed.sse`
- `parallel-fragmented-calls.sse`
- `reasoning-summary-encrypted-call.sse`
- `multi-cycle-reasoning-call.sse`
- `refusal-completed.sse`
- `cache-reasoning-usage.sse`
- `incomplete-length.sse`
- `incomplete-content-filter.sse`
- `incomplete-tool-arguments.sse`
- `empty-completed.sse`
- `response-failed.sse`
- `terminal-output-mismatch.sse`
- `disconnect-before-created.sse`
- `disconnect-after-reasoning.sse`

## 22. Exact Test Matrix

Suggested Rust module path: `crates/praana-core/src/provider/openai/` in Phase 2. Phase 0 MUST NOT create it.

### 22.1 Canonical validation and request mapping

- `openai_chat_request_basic_matches_golden`
- `openai_chat_system_blocks_use_fixed_order_and_markers`
- `openai_instruction_string_includes_optional_memory_in_fixed_slot`
- `openai_instruction_string_keeps_empty_required_data_slots`
- `openai_instruction_data_blocks_are_non_authoritative`
- `openai_chat_rejects_missing_system_policy`
- `openai_chat_multimodal_parts_preserve_order`
- `openai_chat_rejects_remote_image_url`
- `openai_chat_tools_preserve_runtime_catalog_order_and_strictness`
- `openai_chat_tool_results_follow_call_order`
- `openai_chat_rejects_incomplete_tool_group`
- `openai_chat_rejects_interleaved_assistant_blocks`
- `openai_chat_uses_max_completion_tokens`
- `openrouter_chat_uses_max_tokens`
- `openrouter_chat_sets_attribution_headers`
- `openrouter_chat_uses_only_openrouter_credential`
- `openrouter_chat_reasoning_shape_matches_golden`
- `openrouter_responses_is_rejected_before_network`
- `responses_request_basic_matches_golden`
- `responses_system_blocks_map_to_instructions`
- `responses_multimodal_parts_preserve_order`
- `responses_tools_use_flat_shape`
- `responses_reasoning_requests_encrypted_content`

### 22.2 SSE parser

- `sse_split_utf8_at_every_byte_boundary`
- `sse_accepts_lf_crlf_and_bare_cr`
- `sse_joins_multiple_data_lines_with_lf`
- `sse_removes_one_space_after_colon`
- `sse_ignores_comments_and_unknown_fields`
- `sse_rejects_nul_in_id`
- `sse_rejects_invalid_utf8`
- `sse_rejects_oversize_line`
- `sse_rejects_oversize_event`
- `sse_reports_unterminated_final_frame_as_truncated`
- `sse_consumer_drop_cancels_body`

Run the valid framing fixtures with every byte split position and with deterministic pseudo-random chunk groupings.

### 22.3 Chat stream

- `chat_stream_text_usage_and_done_match_golden`
- `chat_stream_accumulates_fragmented_tool_arguments`
- `chat_stream_accumulates_parallel_interleaved_calls_by_index`
- `chat_stream_rejects_conflicting_call_id`
- `chat_stream_rejects_conflicting_function_name`
- `chat_stream_missing_call_id_maps_canonical_error`
- `chat_stream_does_not_repair_tool_json`
- `chat_stream_rejects_non_object_tool_arguments`
- `chat_stream_maps_reasoning_before_text`
- `chat_stream_rejects_two_distinct_reasoning_fields_in_one_chunk`
- `chat_stream_maps_refusal`
- `chat_stream_usage_cache_is_subset_of_input`
- `chat_stream_accepts_finish_then_clean_eof`
- `chat_stream_rejects_eof_before_finish`
- `chat_stream_requires_tool_when_finish_is_tool_calls`
- `chat_stream_rejects_multiple_nonempty_choices`

### 22.4 Responses stream and continuation

- `responses_stream_text_completed_matches_golden`
- `responses_stream_preserves_output_item_order`
- `responses_stream_accumulates_parallel_calls_by_output_index`
- `responses_stream_missing_call_id_maps_canonical_error`
- `responses_stream_validates_argument_done_bytes`
- `responses_stream_captures_reasoning_summary_and_encrypted_content`
- `responses_stream_rejects_missing_encrypted_reasoning_for_tool_cycle`
- `responses_stateless_replay_matches_golden`
- `responses_replay_orders_items_then_outputs_by_call_order`
- `responses_model_switch_drops_opaque_continuation`
- `responses_exact_same_model_keeps_active_continuation`
- `responses_different_model_revision_rejects_continuation`
- `responses_reasoning_done_mismatch_is_protocol_violation`
- `responses_terminal_output_mismatch_is_protocol_violation`
- `responses_incomplete_text_maps_to_length`
- `responses_incomplete_tool_arguments_are_not_executable`
- `responses_failed_maps_nested_error`
- `responses_requires_terminal_event`
- `responses_terminal_cycle_clears_active_replay`
- `chat_empty_completion_is_provider_failure`
- `responses_empty_completion_is_provider_failure`
- `chat_content_filter_maps_canonical_error`
- `chat_unknown_finish_maps_canonical_error`

### 22.5 Retry and abort

- `retry_retries_429_before_emission`
- `retry_respects_retry_after_ms_with_cap`
- `retry_uses_three_total_attempts`
- `retry_does_not_retry_401`
- `retry_does_not_retry_invalid_json`
- `retry_can_retry_disconnect_before_emission`
- `retry_does_not_retry_after_text_delta`
- `retry_does_not_retry_after_reasoning_delta`
- `retry_does_not_retry_after_tool_call_start`
- `retry_buffers_metadata_and_usage_until_acceptance`
- `retry_context_length_uses_one_emergency_admission`
- `retry_response_id_rejection_uses_one_stateless_fallback`
- `abort_before_send_makes_no_http_request`
- `abort_during_backoff_prevents_next_attempt`
- `abort_before_emission_discards_buffered_events`
- `abort_after_emission_rewinds_attempt`
- `abort_never_accepts_partial_tool_call`
- `completion_wins_only_after_terminal_event_is_parsed`

### 22.6 Auth, headers, URL, and redaction

- `auth_explicit_credential_precedes_store_and_env`
- `auth_openrouter_does_not_use_openai_env_key`
- `auth_missing_is_reported_before_send`
- `base_url_preserves_path_prefix`
- `base_url_rejects_userinfo_query_and_fragment`
- `base_url_rejects_non_loopback_http`
- `headers_reject_authorization_override_case_insensitively`
- `headers_reject_crlf_injection`
- `logs_redact_authorization_and_configured_secret_headers`
- `errors_redact_credential_echoed_by_provider`
- `fixtures_contain_no_secret_shaped_values`

### 22.7 Usage and admission

- `chat_usage_maps_cached_and_reasoning_subsets`
- `chat_prompt_cache_miss_is_not_cache_write`
- `responses_usage_maps_cached_and_reasoning_subsets`
- `usage_snapshots_must_not_decrease`
- `cached_tokens_still_count_toward_occupancy`
- `admission_counts_system_tools_images_and_active_cycle`
- `admission_runs_before_auth_resolution`
- `admission_runs_after_every_tool_batch`
- `admission_rebuild_is_bounded`
- `admission_rejects_active_cycle_that_cannot_fit`
- `admission_unknown_model_requires_trusted_context_window`
- `generic_retry_creates_attempt_and_reruns_admission`
- `generic_retry_reuses_estimate_only_for_matching_request_and_profile_hashes`
- `model_switch_reruns_admission_with_target_window`

### 22.8 Test transport

Golden request tests call pure formatters directly. Stream tests feed byte streams directly. Retry/integration tests use a local `tokio::net::TcpListener` fixture server already available through Tokio; do not add a mock-server crate solely for these cases. No test contacts OpenAI, OpenRouter, DNS, or the public internet.

## 23. Implementation Sequence

This is Phase 2 sequencing. Do not pull it into Phase 0.

1. Import canonical protocol/tool DTOs and add explicit OpenAI conversion and
   validation tests.
2. Add the bounded incremental SSE parser and exhaustive chunk-boundary tests.
3. Add stable provider errors and safe OpenAI error-envelope parsing.
4. Add provider profile registry for only OpenAI and OpenRouter.
5. Add URL/header/auth construction with redaction tests.
6. Add pure Chat request formatter and golden tests.
7. Add Chat stream state machine, text/reasoning/refusal mapping, and strict parallel tool accumulation.
8. Add normalized usage/cache accounting.
9. Add pure Responses request formatter and golden tests.
10. Add Responses output-item state machine and terminal validation.
11. Add encrypted reasoning capture and stateless active-cycle replay.
12. Keep response-ID continuation disabled; schema-v1 config has no key for it.
    Retain its reserved protocol data and deferred fixtures without enabling the
    wire optimization.
13. Add pre-emission attempt controller, deterministic retry policy, and abort behavior.
14. Add Phase 2 minimal hard request admission before auth/send: model-window
    resolution, exact `TokenEstimatorV1` component/framing accounting,
    output/reasoning reserve, safe oversized rejection, and emergency context
    handling. Pressure-triggered compaction remains Phase 5.
15. Add local fake-server multi-cycle integration tests.
16. Run format, clippy, unit, fixture, integration, secret-scan, and full workspace gates.

Do not start with Reqwest calls and fill in validation later. Pure request and stream fixtures must pass before live transport is connected.

### 23.1 Bounded Phase 2 packet

Create/modify only `crates/praana-core/src/provider/openai/{mod,chat,responses,sse,error,usage}.rs`, provider registry/profile modules from their owner spec, and `crates/praana-core/tests/openai_v1.rs`. Check in request/SSE/continuation fixtures first. Run `cargo test -p praana-core --test openai_v1`; expected red is unresolved adapter modules. Implement pure conversion/parser code before transport, then fake-server retry/abort integration. The packet is green only when that test, protocol fixtures, fmt, clippy with warnings denied, and workspace tests exit zero. It does not implement tools, history compaction, UI, non-OpenAI providers, OAuth, or server-ID continuation.

## 24. Common Mistakes

- Treating `previous_response_id` as durable history.
- Sending `previous_response_id` and full replay items together.
- Omitting `store: false` in default Responses requests.
- Requiring the legacy `include: ["reasoning.encrypted_content"]` in stateless
  mode even though current OpenAI behavior returns encrypted content by default.
- Dropping a returned assistant message `phase` during manual replay.
- Capturing reasoning summary but dropping encrypted reasoning needed for tool continuation.
- Replaying encrypted reasoning after the active tool cycle, compaction, reset, or model switch.
- Decoding, logging, indexing, or summarizing encrypted reasoning.
- Flattening Responses output items into separate unordered text/thinking/tool arrays.
- Using tool name or array completion order to pair parallel calls/results.
- Generating a missing provider tool-call ID locally.
- Repairing malformed JSON arguments and executing the repaired call.
- Emitting tool calls before all calls in the assistant step validate.
- Retrying after text, reasoning, refusal, or tool emission.
- Returning a synthetic partial assistant message on abort.
- Silently skipping malformed SSE JSON.
- Dispatching an unterminated final SSE frame at EOF.
- Decoding invalid UTF-8 lossily.
- Counting cached input in addition to total input, or subtracting it from context occupancy.
- Treating cache misses as cache writes.
- Ignoring tool schemas, images, output reserve, or active protocol items in admission.
- Resolving secrets before hooks/admission and accidentally exposing them.
- Allowing custom headers to override auth or attribution.
- Falling back from OpenRouter to `OPENAI_API_KEY`.
- Guessing continuation compatibility from model name prefixes, family labels,
  or a response ID.
- Probing alternate endpoints after 404.
- Mutating requests after admission without re-admitting.
- Writing goldens from tests or recording live provider traffic with real credentials.
- Making tests depend on wall time, uncontrolled random jitter, DNS, or the
  public network.

## 25. Acceptance Criteria

The OpenAI/OpenRouter v1 provider runtime is accepted only when:

- Every required golden request matches semantically and every header fixture matches exactly after mandated redaction.
- The SSE parser passes every-byte UTF-8 and delimiter split tests for LF, CRLF, and CR.
- Chat text, refusal, reasoning, fragmented calls, parallel calls, finish reasons, and usage map exactly as specified.
- Responses output item order, assistant phase, refusals, fragmented calls,
  reasoning summaries, default stateless encrypted reasoning, and usage map
  exactly as specified.
- A fake provider completes at least two consecutive Responses tool cycles with encrypted stateless reasoning replay.
- Missing encrypted continuation prevents tool execution rather than silently degrading.
- A response ID never bypasses missing required local continuation, and
  compatibility is exact provider/protocol/model/revision scope.
- Response-ID continuation is disabled in schema v1 and complete local stateless
  replay is the only initial path.
- Model/provider switches remove opaque continuation, create a handoff, and rerun admission.
- No partial or malformed tool call can become executable.
- No generic retry occurs after the emission barrier.
- Every retry is a fresh canonical attempt with fresh admission; estimate reuse
  requires matching request/profile hashes and is recorded.
- Abort leaves no accepted partial assistant step and no synthetic partial completion.
- Stable error codes and retryability match the matrix.
- OpenAI and OpenRouter use only their exact credentials, URLs, and headers.
- Secret scans find no credentials or encrypted reasoning in logs, fixtures, errors, telemetry, or request digests.
- Usage accounting treats cached/reasoning tokens as subsets and context occupancy includes cached tokens.
- Admission runs before every request and counts all provider-visible input plus output/reasoning reserve.
- Unknown models without a configured or trusted context window fail with
  `ADMISSION_CONTEXT_WINDOW_UNKNOWN`.
- All provider tests are deterministic and require no external network.
- `cargo fmt --all -- --check`, workspace clippy with warnings denied, and all workspace tests pass.

Any failure above blocks provider release and Phase 3 turn-loop integration.
