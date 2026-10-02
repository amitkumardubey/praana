# PRAANA Rust v2 Built-in Tool Catalog Specification

**Status:** Normative implementation specification for Phases 3 and 4

**Built-in tool catalog schema version:** 1

**Date:** 2026-09-01

## 1. Authority

This document owns exact Phase 3/4 built-in tool names, descriptions, input and
success-data DTOs, defaults, bounds, and intent mapping. Tool Runtime owns the
common descriptor/result envelope, schema normalization, hooks, execution,
locking, cancellation, redaction, and provider catalog order. History owns
search/artifact physical behavior. StateGraph owns state transitions.

Memory tools are owned by the Memory Plugin spec and appear only when enabled.
Phase 8 code-intel/LSP/git-write/skill tools remain reserved names in Tool
Runtime but require a later catalog schema before implementation; this document
does not leave their schemas to an implementer.

### 1.1 Production catalog

From P4B-2a on, the provider-visible catalog of a session contains:

- the history tools (orders 100 through 120, section 6);
- the eleven StateGraph tools (orders 200 through 300, section 7);
- the Phase 3 tools (section 3 onward), under the section 3 Windows exception
  and the `shell` config gate.

Descriptors are ordered by `order`, as Tool Runtime specifies. One production
catalog function, `tools::builtin::production_tools(&ToolsConfig)`, builds
this list. Both the turn loop's tool runtime and the
provider request's tool schemas use it, so the request lists exactly the tools
the runtime can execute. History and StateGraph tools have no workspace
writes, so the Windows exception does not remove them. Without a durable
session context, state tools return `TOOL_UNAVAILABLE` (StateGraph section
14.1); history tools keep their section 6 behavior.

All request structs deny unknown fields. Optional request keys may be absent and
use the defaults stated here. Success structs are serialized beneath
`ToolResultDto.data`. Paths are UTF-8 strings normalized/validated by Tool
Runtime and never expanded by a tool implementation.

For compactness, every public DTO snippet in sections 3 through 7 carries
`#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]`; every
struct carries `#[serde(deny_unknown_fields)]`; and every unit enum carries
`#[serde(rename_all = "snake_case")]`. Integer/default helper functions return
the literal default stated in prose.

## 2. Common Types

```rust
pub const BUILTIN_TOOL_CATALOG_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LineRangeRequest {
    #[serde(default = "one")]
    pub start_line: u64,
    pub max_lines: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FileIdentityDto {
    pub path: String,
    pub sha256: Sha256Digest,
    pub byte_count: u64,
    pub modified_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TextEncodingDto { Utf8 }

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangedFileDto {
    pub path: String,
    pub before_sha256: Option<Sha256Digest>,
    pub after_sha256: Sha256Digest,
    pub bytes_written: u64,
}
```

`start_line` is one-based. `max_lines` is 1..=10,000; absent means 2,000.
Individual path is 1..=4,096 bytes. Text content is at most 4 MiB per call and
contains no NUL. Newlines are preserved; tools do not format content implicitly.

## 3. File Tools

**Approved temporary Windows platform exception (Built-in Catalog owner).**
The current Rust implementation cannot safely confine workspace writes across
parent-directory reparse/junction swaps on Windows. Until handle-anchored,
reparse-safe write/edit/batch operations exist, the Windows runtime omits
`write_file` (410), `edit_file` (420), `batch_write` (430), and `batch_edit`
(440) from its provider-visible catalog; their order slots are not reused.
Direct invocation is also guarded against side effects. The versioned schema
fixtures still describe all four tools for platforms where they are available.
This approved exception does **not** approve Windows write support or change
their DTO definitions. Handle-anchored, reparse-safe Windows write/edit/batch
operations are required before P7 and before any editor-client release
(tracked in `amitkumardubey/praana#621`).

### 3.1 `read_file` (order 400)

Description: `Read a bounded UTF-8 line range from one file. Returns exact text and an immutable file identity.`

```rust
pub struct ReadFileInput { pub path: String, #[serde(flatten)] pub range: LineRangeRequest }
pub struct ReadFileOutput {
    pub file: FileIdentityDto,
    pub encoding: TextEncodingDto,
    pub start_line: u64,
    pub end_line: u64,
    pub total_lines: u64,
    pub content: String,
    pub eof: bool,
}
```

Reject directories, non-UTF-8, files above 16 MiB, or line above 1 MiB. Empty
file returns start 1/end 0/total 0/content empty/eof true. Intent is ReadOnly +
READ_FILES with one read path.

### 3.2 `write_file` (order 410)

Description: `Atomically create or replace one UTF-8 file after validation and risk checks.`

```rust
pub struct WriteFileInput {
    pub path: String,
    pub content: String,
    #[serde(default)] pub create_parents: bool,
    pub expected_sha256: Option<Sha256Digest>,
}
pub struct WriteFileOutput { pub changed: bool, pub file: ChangedFileDto }
```

`expected_sha256=null` means no compare-and-swap for an existing file. An absent
target plus non-null expectation conflicts. Same bytes returns `changed=false`
without rewriting. Intent is Workspace + WRITE_FILES, idempotent write, one path.

### 3.3 `edit_file` (order 420)

Description: `Replace one exact unique UTF-8 string in a file using compare-and-swap identity.`

```rust
pub struct EditFileInput {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    pub expected_sha256: Option<Sha256Digest>,
}
pub struct EditFileOutput {
    pub changed: bool,
    pub replacements: u32,
    pub file: ChangedFileDto,
}
```

`old_text` is 1..=1 MiB and must occur exactly once. `new_text` is at most 1
MiB. The existing target must be at most 16 MiB; a larger target fails
validation before any write. Zero/multiple matches are validation errors. Intent is Workspace +
WRITE_FILES, idempotent write, one path.

### 3.4 `batch_write` (order 430) and `batch_edit` (order 440)

Descriptions:

- `batch_write`: `Atomically apply ordered writes to multiple files; all validation succeeds before any replacement.`
- `batch_edit`: `Atomically apply ordered exact-string edits; edits to one file are simulated sequentially before writing.`

```rust
pub struct BatchWriteInput { pub writes: Vec<WriteFileInput> }
pub struct BatchEditInput { pub edits: Vec<EditFileInput> }
pub struct BatchMutationOutput { pub changed: Vec<ChangedFileDto>, pub unchanged_paths: Vec<String> }
```

Arrays contain 1..=100 items, total input at most 16 MiB. Duplicate write paths
are invalid. Duplicate edit paths are allowed and applied array-order,
simulated sequentially in memory. Each existing `batch_edit` target must be
at most 16 MiB, with at most 32 MiB across distinct targets and 48 MiB across
transformed results; these limits do not apply to `batch_write`. The result
bound includes the maximum growth from the 16 MiB batch-input budget. Acquire
sorted unique path locks, validate all, journal all,
then replace all. Any failure restores the before set under Tool Runtime's
journal contract. Intent contains every write path.

## 4. Search Tools

### 4.1 `search_code` (order 500)

Description: `Search project text with a bounded regex and gitignore-aware traversal.`

```rust
pub struct SearchCodeInput {
    pub pattern: String,
    #[serde(default = "dot")] pub path: String,
    #[serde(default)] pub include_globs: Vec<String>,
    #[serde(default)] pub exclude_globs: Vec<String>,
    #[serde(default)] pub case_insensitive: bool,
    #[serde(default = "default_context_lines")] pub context_lines: u8,
    #[serde(default = "default_search_results")] pub max_results: u32,
}
pub struct SearchMatchDto {
    pub path: String,
    pub line: u64,
    pub column: u64,
    pub text: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
}
pub struct SearchCodeOutput { pub matches: Vec<SearchMatchDto>, pub truncated: bool, pub scanned_files: u64 }
```

Pattern is 1..=4,096 bytes, Rust regex syntax, no lookaround/backreference.
Globs are 0..=32 each and 1..=512 bytes. Context 0..=5, results 1..=1,000
(defaults 2 and 100). Result order is normalized path ASCII, line, column.
Intent is ReadOnly + READ_FILES over validated root.

### 4.2 `find_files` (order 510)

Description: `Find project file paths by glob or fuzzy subsequence without reading file bodies.`

```rust
pub struct FindFilesInput {
    pub query: String,
    #[serde(default = "dot")] pub path: String,
    pub mode: Option<FindMode>,
    #[serde(default = "default_find_results")] pub max_results: u32,
}
pub enum FindMode { Fuzzy, Glob }
pub enum FoundPathKind { File, Directory, Symlink, Other }
pub struct FoundPathDto { pub path: String, pub kind: FoundPathKind, pub score_milli: Option<u32> }
pub struct FindFilesOutput { pub paths: Vec<FoundPathDto>, pub truncated: bool }
```

Absent mode defaults to `Fuzzy`. Query 1..=1,024 bytes; max 1..=1,000, default 100. Glob uses gitignore-style
syntax. Fuzzy applies ASCII casefold subsequence scoring with path-component
boundary bonuses; ties are path ASCII. Intent is ReadOnly path traversal.

## 5. Process and Git Read Tools

### 5.1 `run_tests` (order 600)

Description: `Run the detected project test adapter under supervised process limits and return a structured summary.`

```rust
pub struct RunTestsInput {
    #[serde(default)] pub targets: Vec<String>,
    pub name_pattern: Option<String>,
    pub timeout_ms: Option<u64>,
}
pub struct TestCountsDto { pub passed: u64, pub failed: u64, pub skipped: u64 }
pub struct RunTestsOutput {
    pub adapter: String,
    pub command: Vec<String>,
    pub exit_code: Option<i32>,
    pub counts: Option<TestCountsDto>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
}
```

Targets 0..=100, each 1..=4,096 bytes; pattern at most 1,024. Timeout defaults
to Tool Runtime test timeout and is capped by Config shell maximum. Adapter
detection order is Bun, npm/pnpm/yarn from lockfile, Cargo, Go, Pytest, then
generic configured test command; ambiguity fails with candidate list. Intent is
External + SPAWN_PROCESS but test-command circuit exempt; no shell interpolation.

### 5.2 `git_status` (order 700)

Description: `Return porcelain-v2 repository status as stable structured paths.`

```rust
pub struct GitStatusInput { #[serde(default)] pub include_untracked: bool }
pub struct GitStatusEntryDto { pub path: String, pub original_path: Option<String>, pub index: String, pub worktree: String }
pub struct GitStatusOutput { pub branch: Option<String>, pub entries: Vec<GitStatusEntryDto> }
```

Execute `git status --porcelain=v2 -z --branch` with optional
`--untracked-files=all`; parse NUL records, no locale text. Intent is ReadOnly +
GIT_READ.

### 5.3 `git_diff` (order 710)

Description: `Return a bounded git diff for selected paths or staging area; large output becomes an artifact.`

```rust
pub struct GitDiffInput {
    #[serde(default)] pub staged: bool,
    pub base: Option<String>,
    #[serde(default)] pub paths: Vec<String>,
    #[serde(default = "default_diff_context")] pub context_lines: u16,
}
pub struct GitDiffOutput { pub command: Vec<String>, pub exit_code: i32, pub diff: String }
```

Base is 1..=256 ASCII without leading `-`; paths 0..=100; context 0..=100,
default 3. Use argument arrays and `--` before paths. Intent is ReadOnly +
GIT_READ.

### 5.4 `shell` (order 1100)

Description: `Run one non-interactive shell command in a validated working directory with bounded output and process-tree cancellation.`

```rust
pub struct ShellInput {
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_ms: Option<u64>,
}
pub struct ShellOutput {
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub cancelled: bool,
}
```

Command is 1..=262,144 bytes, no NUL. Cwd defaults session cwd. Execute through
the platform shell exactly as Tool Runtime specifies, in a new process group/Job
Object. Capture each stream to restrictive spools, 8 MiB each; overflow keeps
draining while marking truncation and artifactizing full allowed captured bytes.
Intent starts External/NonIdempotent and reports parsed risk facts; classifiers
may exempt read/test commands only from circuit, never risk.

## 6. History Tools

### 6.1 `search_session_log` (order 100)

Description: `Search accepted session history, audit events, artifacts, summaries, or StateGraph evidence with exact or FTS ranking.`

```rust
pub struct SearchSessionLogInput {
    pub query: String,
    pub mode: Option<SessionSearchMode>,
    #[serde(default)] pub case_sensitive: bool,
    #[serde(default)] pub source_kinds: Vec<SearchSourceKind>,
    #[serde(default)] pub event_ids: Vec<EventId>,
    #[serde(default)] pub artifact_ids: Vec<ArtifactId>,
    #[serde(default)] pub summary_segment_ids: Vec<SummarySegmentId>,
    #[serde(default)] pub state_ids: Vec<StateId>,
    #[serde(default)] pub include_prior_epochs: bool,
    #[serde(default = "default_session_search_limit")] pub limit: u32,
    pub cursor: Option<String>,
}
pub struct SearchSessionLogOutput { pub page: SessionSearchPage }
```

Exact request/response/cursor/source semantics are imported from History and
not redeclared. Absent mode defaults to `Fts`. Query 0..=4,096 bytes; an empty
query is valid only as History section 11.2 allows. Limit 1..=100 default 20.
Intent is ReadOnly session storage, with an empty capability set.

The input maps to History `SessionSearchRequest` field for field: `mode`
(resolved), `case_sensitive`, `query`, `limit`, `cursor`, and filters
`source_kinds`, `event_ids`, `artifact_ids`, `summary_segment_ids`,
`state_ids`, and `include_prior_epochs`. Every other `SessionSearchFilters`
field is empty or absent. The four ID filters are the four ID lists of
Compaction `EvidenceRefV1`, so a cited handoff source can be searched directly.
`case_sensitive = true` with mode `Fts` is `ToolValidationFailed` with
`history_code = HISTORY_SEARCH_QUERY` (section 6.4).

### 6.2 `retrieve_artifact` (order 110)

Description: `Read a bounded immutable artifact by ID using one byte, line, grep, or JSON-pointer selection.`

```rust
pub struct RetrieveArtifactOutput { pub artifact: RetrieveArtifactResponse }
```

The tool input is exactly History `RetrieveArtifactRequest`; the success value
wraps its exact `RetrieveArtifactResponse`. Selector/defaults/bounds are imported from History.
Intent is ReadOnly + ARTIFACT_READ.

### 6.3 `read_session_source` (order 120)

Description: `Read a bounded byte window of one event-sourced session search result by its result_id.`

```rust
pub struct ReadSessionSourceInput {
    pub result_id: SearchResultId,
    #[serde(default)] pub byte_offset: u64,
}
pub struct ReadSessionSourceOutput { pub source: ReadSessionSourceResponse }
```

The input maps field for field to History `ReadSessionSourceRequest` (History
section 10.3), and the output is bounded by History section 10.4. Intent is
ReadOnly session storage, with an empty capability set. Search results for
event sources name this tool in `SearchRetrieval`.

### 6.4 History tool schemas and error mapping

In tool schemas, every ULID newtype (`EventId`, `ArtifactId`,
`SummarySegmentId`, `StateId`, `SearchResultId`) is
`{"type":"string","pattern":"^[0-9A-HJKMNP-TV-Z]{26}$"}`. `SessionSearchMode`
and `SearchSourceKind` are snake_case string enums.

History tools return Tool Runtime's implemented `ToolErrorCode` values, and
`ToolErrorDto.details` is exactly
`{"canonical_code": <Protocol Appendix A E_* code>, "history_code": <HISTORY_* code>}`.

| History code(s) | `ToolErrorCode` |
|---|---|
| `HISTORY_SEARCH_QUERY`, `HISTORY_REGEX_INVALID`, `HISTORY_REGEX_UNSUPPORTED`, `HISTORY_ARTIFACT_RANGE`, `HISTORY_JSON_POINTER`, `HISTORY_SELECTOR_UNSUPPORTED`, `HISTORY_ARTIFACT_TOO_LARGE`, `HISTORY_SEARCH_CURSOR_STALE`, `HISTORY_ARTIFACT_NOT_FOUND`, `HISTORY_SOURCE_NOT_FOUND` | `ToolValidationFailed` |
| `HISTORY_CANCELLED` | `ToolCancelled` |
| `HISTORY_SQLITE_BUSY` | `ToolUnavailable` |
| `HISTORY_IO` | `ToolIoFailed` |
| `HISTORY_SQLITE_PRAGMA_FAILED`, `HISTORY_EVENT_INTEGRITY`, `HISTORY_CANONICAL_DB_CORRUPT`, `HISTORY_DANGLING_ARTIFACT` | `ToolInternal` |

Any other History code reaching a history tool is `ToolInternal`. As with the
StateGraph rows of Protocol Appendix A.6, a History code that A.4 marks
`error when called as a tool` keeps A.4's class and retryability on the tool
surface; for example, `HISTORY_SEARCH_CURSOR_STALE` is `conflict` and
retryable from a fresh first page. Every other mapped code takes the class and
retryability of its `ToolErrorCode` in A.3.

## 7. StateGraph Tools

Convenience requests compile to the exact StateOperationV1 array and use the
current graph sequence. Provider-facing convenience tools do not expose raw
revision overrides; explicit revision APIs remain internal StateGraph services.

### 7.1 Descriptions, DTOs, and defaults

| Order | Tool | Description |
|---|---|---|
| 200 | `create_task` | `Create a current-session task with status todo in the active StateGraph tier.` |
| 210 | `complete_task` | `Mark one current-session task done and move it to the soft StateGraph tier.` |
| 220 | `retract_task` | `Retract any current-session StateGraph object by ID with a reason; it remains searchable.` |
| 230 | `add_constraint` | `Record a current-session constraint in the active StateGraph tier; strength defaults to hard.` |
| 240 | `decide` | `Record a current-session decision with its rationale, optionally superseding an active decision.` |
| 250 | `add_note` | `Record a semantic current-session note or finding, with optional lowercase tags.` |
| 260 | `soft_unload` | `Move one StateGraph object to the soft tier; it stays listed and can be hydrated.` |
| 270 | `hard_unload` | `Archive one StateGraph object to the hard tier; its content then requires hydrate.` |
| 280 | `hydrate` | `Move one StateGraph object to the active tier and return its complete content.` |
| 290 | `list_state` | `List current-session StateGraph objects with bounded summaries, filtered by kind, tier, and status.` |
| 300 | `focus_task` | `Make one current StateGraph object the single focus, activating it if needed, and return its content.` |

```rust
pub struct CreateTaskInput { pub title: String, pub description: Option<String> }
pub struct CompleteTaskInput { pub id: StateId }
pub struct RetractStateInput { pub id: StateId, pub reason: String }
pub struct AddConstraintInput {
    pub text: String,
    #[serde(default = "default_constraint_strength")] pub strength: ConstraintStrength,
}
pub struct DecideInput { pub summary: String, pub rationale: String, pub supersedes_id: Option<StateId> }
pub struct AddNoteInput { pub text: String, #[serde(default)] pub tags: Vec<String> }
pub struct StateIdInput { pub id: StateId }
pub struct FocusTaskInput { pub id: StateId }
pub struct ListStateInput {
    #[serde(default)] pub kinds: Vec<StateKind>,
    #[serde(default)] pub tiers: Vec<StateTier>,
    #[serde(default)] pub statuses: Vec<StateStatusFilter>,
    #[serde(default)] pub include_retracted: bool,
    #[serde(default = "default_state_limit")] pub limit: u32,
    pub cursor: Option<String>,
}
pub struct StateMutationObjectDto { pub id: StateId, pub revision: u64 }
pub struct StateMutationToolOutput {
    pub event_id: EventId,
    pub sequence: u64,
    pub affected: Vec<StateMutationObjectDto>,
}
pub struct StateObjectViewDto {
    pub id: StateId,
    pub kind: StateKind,
    pub tier: StateTier,
    pub lifecycle: ObjectLifecycle,
    pub focused: bool,
    pub revision: u64,
    pub created_sequence: u64,
    pub updated_sequence: u64,
    pub source_sequence: u64,
    pub value: StateValueV1,
}
pub struct StateObjectToolOutput {
    pub mutation: StateMutationToolOutput,
    pub object: StateObjectViewDto,
}
pub struct StateListItemDto {
    pub id: StateId,
    pub kind: StateKind,
    pub tier: StateTier,
    pub lifecycle: ObjectLifecycle,
    pub status: Option<String>,
    pub focused: bool,
    pub revision: u64,
    pub updated_sequence: u64,
    pub summary: Option<String>,
}
pub struct StateListToolOutput {
    pub projection_sequence: u64,
    pub items: Vec<StateListItemDto>,
    pub next_cursor: Option<String>,
}
```

Defaults and bounds:

- `default_constraint_strength` is `hard`.
- `list_state` `limit` is 1..=200 with default 50; any other value is
  `STATE_FIELD_LIMIT`.
- Text bounds are StateGraph section 5 byte bounds, enforced by the state
  service after StateGraph section 4.7 normalization. They are not JSON Schema
  `maxLength`, which counts characters. A violation is `STATE_FIELD_LIMIT`.
- Tool schemas carry no `minimum`/`maximum` on `limit`, no length bounds, and
  no tag pattern, so those failures are the service's `STATE_FIELD_LIMIT` and
  never `ToolSchemaInvalid`.
- In tool schemas, `StateId`/`EventId` use the section 6.4 ULID pattern.
  `StateKind`, `StateTier`, `ObjectLifecycle`, `ConstraintStrength`, and
  `StateStatusFilter` (StateGraph section 11.2) are snake_case string enums.
  `StateValueV1` is StateGraph's exact adjacently tagged shape.

Output fields:

- `affected` has one entry per distinct object the event changed, sorted by
  `id` ascending, with its revision after the event.
- `StateObjectViewDto` is the object after the event. `source_sequence` is
  `StateObjectV1.source.sequence`.
- `StateListItemDto.status` is the StateGraph section 11.2 status string, or
  null for notes. `summary` follows StateGraph section 11.2.
- `projection_sequence` is the graph's `applied_through_sequence` at the call's
  snapshot.

Intent:

- The ten mutation tools are `SessionState` + `STATE_WRITE`,
  `ToolIdempotency::NonIdempotent`, with `timeout_ms = 30_000` and no path or
  command intent.
- `list_state` is `ReadOnly` + `STATE_READ`, `ToolIdempotency::ReadOnly`, with
  `timeout_ms = 30_000`.
- Plan mode does not block any of them (Tool Runtime section 14.1).
- The mutation tools are mutating tools for the circuit loop gate.

Results:

- No state tool result is artifactized (History section 6.1 rule 5).
- `list_state` fills its page greedily under the History section 10.4 bound,
  in the StateGraph section 11.2 order. `next_cursor` points after the last
  included item.
- Mutation and object outputs are bounded by construction by the StateGraph
  section 5 field bounds. For every kind a P4B-1 tool can create, the RFC 8785
  bytes of `StateObjectToolOutput` are below 65,536 even when every text byte
  is a control character. Tests MUST assert this at maximum field sizes.
- State results have no per-batch cap, unlike history results.

### 7.2 Exact operations

Each call builds one `StateChangedV1` whose `operations` are exactly the
following. Checks run in this order: text normalization and input bounds
(StateGraph sections 4.6 and 4.7), then target preconditions, then the section
4 transition and section 5 object-count rules on the candidate graph. The first
failure is returned. The target object is looked up in the current reset epoch.
Precondition failures append nothing:

- An absent ID is `STATE_NOT_FOUND`.
- A retracted target is `STATE_RETRACTED`.
- A wrong kind is `STATE_KIND_MISMATCH`.

`r` is the target's current revision at queue head, and `N` is a fresh state
ID.

| Tool | Preconditions | `operations` |
|---|---|---|
| `create_task` | none | `Create{N, active, Task{title, description, status: todo, blocker: null}}` |
| `complete_task` | Task. `done` is `STATE_NO_CHANGE`; `cancelled` is `STATE_INVALID_TRANSITION`. | `UpdateTask{id, r, {title: null, description: keep, status: done, blocker: clear}, touch: true}`, then `SetTier{id, r+1, soft, touch: true}` |
| `retract_task` | any kind | `Retract{id, r, reason}` |
| `add_constraint` | none | `Create{N, active, Constraint{text, strength, status: active, status_reason: null}}` |
| `decide` | With `supersedes_id`: a Decision whose status is `active`, else `STATE_INVALID_TRANSITION` | `Create{N, active, Decision{summary, rationale, status: active}}`, then, with `supersedes_id`, `SupersedeDecision{supersedes_id, r, by: N, touch: true}` |
| `add_note` | none | `Create{N, active, Note{text, tags}}` with tags sorted and deduplicated |
| `soft_unload` | any kind | `SetTier{id, r, soft, touch: true}` |
| `hard_unload` | any kind | `SetTier{id, r, hard, touch: true}` |
| `hydrate` | any kind | `SetTier{id, r, active, touch: true}` |
| `focus_task` | any kind | tier `active`: `Touch{id, r}`, then `SetFocus{set id}`; otherwise `SetTier{id, r, active, touch: true}`, then `SetFocus{set id}` |

Unloading, completing, or retracting the focused object clears focus by the
StateGraph section 4.1 focus invariant. `focus_task` accepts any current
object, including a done or cancelled task and a superseded decision. `decide`
with `supersedes_id` leaves the superseded decision's tier unchanged. `hydrate` and `focus_task` return
`StateObjectToolOutput`, and the other mutation tools return
`StateMutationToolOutput`. A mutation that would leave more than 256 active or
4096 current objects is `STATE_OBJECT_LIMIT`. `list_state` appends nothing and
returns `StateListToolOutput`.

### 7.3 Error mapping

State tools return the implemented `ToolErrorCode` named by Protocol Appendix
A.6 for the state code, with `ToolErrorDto.details` exactly as StateGraph
section 11 defines. The tool result's canonical result code is that outer
`TOOL_*` string. Class, status, and retryability are A.6's row for
`details.state_code`, overriding A.3 in the same way as section 6.4 does for
history codes. A.6's conditional retryability for `STATE_PERSISTENCE` is
`false` on the tool surface. Redaction failure (StateGraph section 4.7) is
`ToolRedactionFailed` with no details. Any other failure is `ToolInternal`.

## 8. Descriptors and Snapshots

All Phase 3/4 descriptors set `strict=true`. Description bytes are exactly the
single sentences above. Schema snapshots live at
`crates/praana-core/schemas/tools/v1/<order>-<name>-input.json` and output
equivalents. Manifest rows contain name, order, description SHA-256, input/output
schema SHA-256, capabilities, and catalog schema version. Generation follows
Tool Runtime and fails on any unlisted tool.

## 9. Error Mapping

Sections 6.4 and 7.3 supersede this paragraph for history and StateGraph
tools, whose codes are the implemented Tool Runtime `ToolErrorCode` values. Tool-specific validation maps to common stable codes: `TOOL_INVALID_INPUT`,
`TOOL_PATH_NOT_FOUND`, `TOOL_PATH_OUTSIDE_ROOT`, `TOOL_FILE_CHANGED`,
`TOOL_TEXT_NOT_UNIQUE`, `TOOL_OUTPUT_TOO_LARGE`, `TOOL_UNSUPPORTED_ENCODING`,
`TOOL_PROCESS_FAILED`, `TOOL_SEARCH_INVALID`, `TOOL_CURSOR_INVALID`, and the
StateGraph/History domain code in `ToolErrorDto.details`. Provider-visible error
messages are bounded and never include unrestricted paths or raw stderr beyond
the redacted result DTO.

## 10. Bounded Implementation Packets

Phase 3 files:

```text
crates/praana-core/src/tools/builtin/files.rs
crates/praana-core/src/tools/builtin/search.rs
crates/praana-core/src/tools/builtin/tests.rs
crates/praana-core/src/tools/builtin/git_read.rs
crates/praana-core/src/tools/builtin/shell.rs
crates/praana-core/tests/builtin_tools_phase3.rs
```

Phase 4 adds `history.rs`, `state.rs`, and `builtin_tools_phase4.rs`. Packet
P4A adds `history.rs` (orders 100, 110, 120) and the history cases of
`builtin_tools_phase4.rs`; P4B-1 adds `state.rs` (orders 200 through 300) and
the state cases. P4B-2a adds both families to the production catalog
(section 1.1).

For each phase, check in exact schema/description/result fixtures first; the
test initially fails on missing built-ins. Implement one tool family at a time,
run its named test, then Tool Runtime hook/fault tests. Run fmt, clippy with
warnings denied, and workspace tests before the phase gate.

Non-goals: interactive PTY shell, phase-8 tools, arbitrary commands for git/test
adapters, implicit formatting, compatibility aliases, or generic JSON success
objects. Common mistakes: shell interpolation for non-shell tools, results in
completion order, hidden defaults absent from schema tests, path validation in
the implementation instead of runtime, and provider-visible output bypassing
the common result/redaction/artifact path.
