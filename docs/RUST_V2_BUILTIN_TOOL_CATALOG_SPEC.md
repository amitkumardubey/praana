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
MiB. Zero/multiple matches are validation errors. Intent is Workspace +
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
are invalid. Duplicate edit paths are allowed and applied array-order to one
in-memory image. Acquire sorted unique path locks, validate all, journal all,
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
    #[serde(default)] pub source_kinds: Vec<SearchSourceKind>,
    #[serde(default)] pub include_prior_epochs: bool,
    #[serde(default = "default_session_search_limit")] pub limit: u32,
    pub cursor: Option<String>,
}
pub struct SearchSessionLogOutput { pub page: SessionSearchPage }
```

Exact request/response/cursor/source semantics are imported from History and
not redeclared. Absent mode defaults to `Fts`. Query 1..=4,096 bytes, limit
1..=100 default 20. Intent is
ReadOnly session storage.

### 6.2 `retrieve_artifact` (order 110)

Description: `Read a bounded immutable artifact by ID using one byte, line, grep, or JSON-pointer selection.`

```rust
pub struct RetrieveArtifactOutput { pub artifact: RetrieveArtifactResponse }
```

The tool input is exactly History `RetrieveArtifactRequest`; the success value
wraps its exact `RetrieveArtifactResponse`. Selector/defaults/bounds are imported from History.
Intent is ReadOnly + ARTIFACT_READ.

## 7. StateGraph Tools

Convenience requests compile to the exact StateOperationV1 array and use the
current graph sequence. Provider-facing convenience tools do not expose raw
revision overrides; explicit revision APIs remain internal StateGraph services.

```rust
pub struct CreateTaskInput { pub title: String, pub description: Option<String> }
pub struct CompleteTaskInput { pub id: StateId }
pub struct RetractStateInput { pub id: StateId, pub reason: Option<String> }
pub struct AddConstraintInput { pub text: String, pub strength: Option<ConstraintStrength> }
pub struct DecideInput { pub summary: String, pub rationale: String, pub supersedes_id: Option<StateId> }
pub struct AddNoteInput { pub text: String, #[serde(default)] pub tags: Vec<String> }
pub struct StateIdInput { pub id: StateId }
pub struct FocusTaskInput { pub id: StateId }
pub struct ListStateInput {
    #[serde(default)] pub kinds: Vec<StateKind>,
    #[serde(default)] pub tiers: Vec<StateTier>,
    #[serde(default)] pub statuses: Vec<String>,
    #[serde(default)] pub include_hard: bool,
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
pub struct StateListItemDto {
    pub id: StateId,
    pub kind: StateKind,
    pub tier: StateTier,
    pub status: String,
    pub revision: u64,
    pub summary: Option<String>,
}
pub struct StateListToolOutput {
    pub projection_sequence: u64,
    pub items: Vec<StateListItemDto>,
    pub next_cursor: Option<String>,
}
```

Mappings:

| Tool | Request | Operation/result |
|---|---|---|
| `create_task` | `CreateTaskInput` | create Task/Active/Open; mutation result |
| `complete_task` | `CompleteTaskInput` | set task status Completed; mutation result |
| `retract_task` | `RetractStateInput` | retract any kind; name retained for parity; mutation result |
| `add_constraint` | `AddConstraintInput` | create Constraint/Active; mutation result |
| `decide` | `DecideInput` | create Decision/Active; mutation result |
| `add_note` | `AddNoteInput` | create Note/Active; mutation result |
| `soft_unload` | `StateIdInput` | set Soft; mutation result |
| `hard_unload` | `StateIdInput` | set Hard; mutation result |
| `hydrate` | `StateIdInput` | set Active and return complete payload; mutation result |
| `list_state` | `ListStateInput` | state-list output |
| `focus_task` | `FocusTaskInput` | hydrate if needed, focus any current kind; mutation result |

Text/title/rationale/tag bounds, revisions, statuses, cursor encoding, event
payload, and result DTOs are exactly StateGraph's specification. State mutations
are SessionState + STATE_WRITE; list is ReadOnly + STATE_READ. Provider batch
order is serialized by Tool Runtime.

## 8. Descriptors and Snapshots

All Phase 3/4 descriptors set `strict=true`. Description bytes are exactly the
single sentences above. Schema snapshots live at
`crates/praana-core/schemas/tools/v1/<order>-<name>-input.json` and output
equivalents. Manifest rows contain name, order, description SHA-256, input/output
schema SHA-256, capabilities, and catalog schema version. Generation follows
Tool Runtime and fails on any unlisted tool.

## 9. Error Mapping

Tool-specific validation maps to common stable codes: `TOOL_INVALID_INPUT`,
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

Phase 4 adds `history.rs`, `state.rs`, and `builtin_tools_phase4.rs`.

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
