# PRAANA Rust v2 History Storage Specification

Status: Normative implementation specification for Rust v2

Date: 2026-08-31

This document is the direct and final authority for the physical event store,
per-session artifact store, derived history projections, operational
journals/spools, retrieval, and current-session search. It describes a new
format. There is no compatibility path for old events, databases, checkpoints,
or configuration.

`docs/RUST_V2_PROTOCOL_SPEC.md` is authoritative for event schema 2 DTOs,
accepted-conversation state machines, event ordering, public protocol errors,
and canonical compaction source hashes. This document is authoritative for
physical file ownership, SQLite DDL, artifact transactions, retrieval, search,
and derived projection maintenance. A repeated event field here is explanatory;
the protocol DTO wins if it differs.

`docs/RUST_V2_TOKEN_ACCOUNTING_SPEC.md` is the direct authority for every token
estimate and for exact-search Unicode case folding. This specification owns the
bytes and component boundaries submitted to that estimator, not another token
algorithm.

`docs/RUST_V2_CONFIG_SPEC.md` is the sole authority for session/history paths,
retention, artifact-policy defaults, config parsing, and the effective config
snapshot/digest. This specification consumes those typed values and owns their
storage behavior.

## 1. Goals and invariants

The storage layer MUST satisfy all of the following:

1. Canonical accepted history survives process, machine, and UI restarts.
2. A model-visible artifact reference never precedes the durable artifact body.
3. Failed and superseded provider attempts remain auditable but are not accepted
   conversation history.
4. Tool calls and results are paired by tool-call ID, never by name or array
   position.
5. A corrupt derived index can be discarded and rebuilt without changing
   canonical event IDs, artifact IDs, or logical conversation output.
6. Canonical/derived tool results are post-hook and post-redaction. Raw
   unredacted bytes may exist only in the private transient shell spool format
   in section 8.2; they MUST NOT enter events, SQLite, search, telemetry,
   previews, IPC, or backups made by PRAANA.
7. Search results identify durable source events or artifacts and include an
   exact retrieval operation. An excerpt is never represented as full content.
8. One session has one mutating owner. Read-only clients may query a consistent
   SQLite snapshot concurrently.
9. Cancellation cannot leave a durable event referring to an uncommitted body.
10. Deleting a derived row never deletes source evidence. Referenced artifact
    bodies are retained for the life of the session.

## 2. Storage layout and ownership

The session root is the resolved `session.root`; its exact default and path
normalization are owned by the Config specification. One session directory is:

```text
<session.root>/<session-id>/
  events.jsonl
  history.db
  meta.json
  config.snapshot.json
  journals/
  spools/
  quarantine/
```

Temporary and recovery files may also occur in that directory:

```text
  history.db-wal
  history.db-shm
  session.lock
  meta.json.tmp
  config.snapshot.json.tmp
  journals/write-<execution-id>.json
  journals/write-<execution-id>/before-<ordinal>.bin
  journals/write-<execution-id>/staged-<ordinal>.bin
  spools/<execution-id>/manifest.json
  spools/<execution-id>/stdout.raw
  spools/<execution-id>/stderr.raw
  quarantine/events-tail-<sha256>.bin
```

Whole-session deletion uses the sibling namespace
`<session.root>/.trash/`; it is never nested inside a live session
directory.

`<session-id>` is the uppercase, 26-character Crockford ULID from
`SessionStarted`. Paths are resolved under the configured session root after
normalization. A symlink at the session directory, `events.jsonl`, `history.db`,
`meta.json`, or `config.snapshot.json` path is an error. The core opens files
relative to an already opened session-directory handle where the platform
permits it.

All Rust storage APIs use the protocol-owned ID newtypes. SQLite stores their
canonical string encodings, but a `TEXT` column is never exposed as a raw Rust
`String` at a core boundary. Application validators enforce uppercase Crockford
ULID syntax in addition to SQL length checks. Provider `ToolCallId` remains the
opaque provider-string exception.

### 2.1 Canonical and derived data

| Data | Owner | Classification | Recovery authority |
|---|---|---|---|
| Ordered event envelopes and payloads | `events.jsonl` | Canonical | Longest valid durable prefix |
| Large redacted tool-result bytes | `history.db.artifact_blobs` | Canonical | SQLite row plus SHA-256 verification |
| Artifact identity, producer provenance, and immutable preview | `history.db.artifacts` | Canonical | SQLite row; referenced by an event |
| Session identity and creation parameters | `meta.json` | Canonical static manifest | Must agree with `SessionStarted` |
| Complete non-secret creation configuration | `config.snapshot.json` | Canonical static manifest | Config-spec canonical JSON and SHA-256 |
| Logical accepted conversation | Memory and projection tables | Derived | Replay canonical events |
| Turn ledger and reset epochs | `history.db.turns` | Derived | Replay canonical events |
| FTS and normalized search documents | Search tables | Derived | Replay events and artifact rows |
| Summary metadata copies | `history.db.summary_segments` | Derived | Replay `HistoryCompacted` events |
| StateGraph and other checkpoints | `history.db.projection_checkpoints` | Derived cache | Validate, then replay; otherwise rebuild |
| Multi-file write journals and before/staged files | `journals/` | Sensitive operational recovery | Identity/hash-safe commit or rollback, then canonical uncertain/final result |
| Raw shell capture spools | `spools/` | Sensitive transient operational data | Process identity check, redaction/artifact reconciliation, then removal |
| Access counts, latency, and counters | Telemetry tables | Non-authoritative telemetry | May be lost without semantic effect |
| Per-session skill observations | `skill_session_stats` | Non-authoritative telemetry | May be lost without semantic effect |

Canonical does not mean model-visible. `events.jsonl` records failed attempts,
interruptions, resets, and supersession. The accepted-conversation projector
decides visibility. `history.db` is not a second transcript.

Artifact bodies cannot be rebuilt from previews or events and are therefore
canonical. Every other SQLite table can be dropped and reconstructed from the
valid event prefix and canonical artifact tables.

### 2.2 `meta.json`

`meta.json` is written once during session creation and is immutable. Lifecycle
status, last activity, model changes, and end reasons belong in events and MUST
NOT be updated in this file.

```json
{
  "schema_version": 1,
  "session_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "created_at_ms": 1788134400000,
  "cwd": "/absolute/project/path",
  "agent_id": "praana",
  "config_schema_version": 1,
  "config_digest_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "event_schema_version": 2,
  "history_schema_version": 1,
  "projection_version": "rust-v2-projection-1",
  "token_estimator_schema_version": 1,
  "unicode_utility_version": "praana-unicode-15.1-v1",
  "creator_version": "0.1.0-dev"
}
```

JSON keys are serialized in the order shown. The path is absolute and lexical
normalization has already been applied; it is not required to exist on resume.
The `SessionStarted` envelope repeats session ID and creation timestamp; its
payload repeats cwd, agent, config schema/digest, projection version, compaction
policy version, artifact policy version, token estimator schema version, and
Unicode utility version. `config_digest_sha256` also MUST equal SHA-256 of the
Config-spec canonical effective JSON in `config.snapshot.json`. Those
overlapping fields must agree. A mismatch maps
to public `E_SESSION_ID_MISMATCH` or internal `HISTORY_META_MISMATCH` and
prevents a mutating resume.

### 2.3 `config.snapshot.json`

The Config specification exclusively defines this file's complete schema,
canonical serialization, digest, secret exclusions, and changed-config resume
behavior. History owns only private file creation and durability. Creation
writes and fsyncs `config.snapshot.json.tmp`, renames it without replacement,
fsyncs the session directory, then writes `meta.json` and sequence-1
`SessionStarted` with the matching digest. A process never edits the snapshot.

Resume validates snapshot bytes and digest before opening a mutating event
writer. A mismatch is `HISTORY_META_MISMATCH` and maps to the Config-spec
snapshot error. A current runtime config with a different valid digest does not
alter the creation snapshot; it follows the Config-spec resume warning and
model-boundary rules.

## 3. Permissions and open policy

On Unix:

- The application data root and `session.root` MUST be mode `0700` when created.
- The session directory MUST be mode `0700`.
- `journals`, `spools`, `quarantine`, each per-execution subdirectory, and
  `.trash` MUST be mode `0700`.
- `events.jsonl`, `history.db`, `meta.json`, `config.snapshot.json`,
  `session.lock`, WAL/SHM files, and journal/spool/quarantine/recovery files MUST
  be mode `0600`.
- The process sets umask `0077` before creating session files and verifies modes
  after opening. It does not silently widen an existing mode.

On Windows, files and directories MUST inherit or receive an ACL limited to the
current user and administrators. Failure to establish a private ACL is
`HISTORY_INSECURE_PERMISSIONS`; creation fails rather than proceeding with a
world-readable session.

`events.jsonl` is opened with create, write-only, append, close-on-exec, and
no-follow semantics. It is never opened with truncate during normal operation.
The incomplete-final-record recovery procedure in section 9.1 is the sole
exception.

`session.lock` holds an exclusive advisory lock for the mutating owner. Lock
metadata is diagnostic only and contains PID, process start time, and a random
owner nonce. A second writer receives `HISTORY_SESSION_LOCKED`. Read-only
clients do not take this lock, open SQLite read-only, and parse only the event
file size captured at the beginning of their snapshot.

## 4. Canonical event file

### 4.1 Envelope and sequence

Every record is one UTF-8 JSON object followed by one LF byte. CRLF is not
written. The envelope is exactly protocol `EventEnvelope` schema 2; this
storage specification does not redeclare or alter its fields.

Sequence starts at 1 for `SessionStarted` and increases by exactly one. It is
the only replay order. ULID lexical order and timestamps MUST NOT be used as
replay order. Event IDs are unique within the session. Envelope session ID must
match both the directory and `meta.json`.

### 4.2 Deterministic serialization

Event bytes follow protocol schema 2 section 4 exactly. Event struct fields use
their declared DTO order, every `Option<T>` field serializes as explicit JSON
null, empty vectors/maps are present, no insignificant whitespace is emitted,
and the record ends in exactly one LF. Tool arguments and structured
tool-result text use RFC 8785 JSON Canonicalization Scheme before hashing or
storage. One tested serializer path and golden event bytes are required.

The event prefix hash below is only a projection-checkpoint validation chain. It
does not replace protocol `source_hash`, which is SHA-256 over exact selected
event lines including each LF:

```text
H0 = 32 zero bytes
Li = SHA256(exact event line bytes for event i, including LF)
Hi = SHA256(Hi-1 || u64_be(sequence_i) || u64_be(line_length_i) || Li)
```

Projection checkpoints store `Hi` at their applied sequence. A rebuild computes
the same chain while reading the log.

### 4.3 Redaction boundary

Tool execution receives original arguments and raw output in process memory.
Persistence follows this exact order:

```text
execute
  -> LSP
  -> verify
  -> enrich
  -> redact
  -> circuit accounting
  -> write-path release
  -> RFC 8785 result serialization
  -> artifact decision
  -> artifact/event persistence
```

The accepted assistant event preserves provider-generated tool arguments as
required for exact protocol replay, and `ToolExecutionStarted` hashes that exact
canonical object. Any separate runtime/display/log copy is redacted and no
host credential value is added to canonical arguments. The original execution
arguments are not duplicated into previews, search documents, telemetry, or
artifact metadata. User and assistant messages have a separate transcript
privacy policy and are not modified by the tool-result redactor.

Redaction output is deterministic for a declared `redaction_version`. The
placeholder format is `[REDACTED:<kind>]`. Artifact SHA-256 is computed over the
post-redaction canonical result bytes. An artifact is lossless with respect to
that post-redaction value, not the raw secret-bearing value.

If redaction throws or cannot safely traverse a typed result, the core discards
the raw value, creates a safe synthetic error result with code
`TOOL_REDACTION_FAILED`, and persists only that replacement. This spelling is
normative on the tool-result surface; History errors map through the protocol
appendix and do not invent another redaction code. Redaction failure is never
fail-open.

## 5. SQLite policy and schema

Rust v2 uses `rusqlite` with bundled SQLite and FTS5. The application checks
that the runtime SQLite supports FTS5 before creating a session.

### 5.1 Pragmas

Every read-write connection applies and verifies:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA wal_autocheckpoint = 1000;
PRAGMA journal_size_limit = 67108864;
PRAGMA temp_store = MEMORY;
PRAGMA trusted_schema = OFF;
PRAGMA recursive_triggers = OFF;
```

`journal_mode` must return `wal`, `foreign_keys` must return `1`, and
`synchronous` must return `2`. Otherwise open fails with
`HISTORY_SQLITE_PRAGMA_FAILED`. Read-only clients set `query_only = ON` after
opening. The writer performs `wal_checkpoint(TRUNCATE)` on clean close if no
reader prevents it; inability to truncate the WAL is a warning, not history
failure.

### 5.2 Schema SQL

This is the complete `history_schema_version = 1` schema. There are no v1
migrations from any TypeScript database.

```sql
PRAGMA application_id = 1347567950;
PRAGMA user_version = 1;
-- application_id above is hexadecimal 0x50524141, ASCII "PRAA".

CREATE TABLE schema_meta (
  key                 TEXT PRIMARY KEY NOT NULL,
  value               TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE artifact_blobs (
  blob_id             TEXT PRIMARY KEY NOT NULL,
  sha256              TEXT NOT NULL UNIQUE
                      CHECK(length(sha256) = 64),
  canonical_result    BLOB NOT NULL,
  byte_count          INTEGER NOT NULL CHECK(byte_count >= 0),
  line_count          INTEGER NOT NULL CHECK(line_count >= 0),
  estimated_tokens    INTEGER NOT NULL CHECK(estimated_tokens >= 0),
  token_estimator_schema_version INTEGER NOT NULL
                      CHECK(token_estimator_schema_version = 1),
  token_estimator_id  TEXT NOT NULL,
  token_input_sha256  TEXT NOT NULL CHECK(length(token_input_sha256) = 64),
  result_encoding     TEXT NOT NULL CHECK(result_encoding IN
                      ('rfc8785-json','utf8-text','binary')),
  redaction_version   TEXT NOT NULL,
  redaction_json      TEXT NOT NULL CHECK(json_valid(redaction_json)),
  created_at_ms       INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE artifacts (
  artifact_id                 TEXT PRIMARY KEY NOT NULL
                              CHECK(length(artifact_id) = 26),
  blob_id                     TEXT NOT NULL
                              REFERENCES artifact_blobs(blob_id)
                              ON UPDATE RESTRICT ON DELETE RESTRICT,
  producing_event_id          TEXT NOT NULL UNIQUE
                              CHECK(length(producing_event_id) = 26),
  producing_sequence          INTEGER NOT NULL UNIQUE
                              CHECK(producing_sequence > 0),
  turn_id                     TEXT NOT NULL CHECK(length(turn_id) = 26),
  attempt_id                  TEXT NOT NULL CHECK(length(attempt_id) = 26),
  step_id                     TEXT NOT NULL CHECK(length(step_id) = 26),
  batch_id                    TEXT NOT NULL CHECK(length(batch_id) = 26),
  execution_id                TEXT NOT NULL UNIQUE CHECK(length(execution_id) = 26),
  execution_started           INTEGER NOT NULL CHECK(execution_started IN (0,1)),
  started_event_id            TEXT UNIQUE
                              CHECK(started_event_id IS NULL OR length(started_event_id) = 26),
  tool_call_id                TEXT NOT NULL,
  call_index                  INTEGER NOT NULL CHECK(call_index >= 0),
  tool_name                   TEXT NOT NULL,
  result_message_id           TEXT NOT NULL UNIQUE
                              CHECK(length(result_message_id) = 26),
  result_status               TEXT NOT NULL CHECK(result_status IN
                              ('success','error','blocked','cancelled',
                               'uncertain','skipped')),
  result_media_type           TEXT NOT NULL,
  result_sha256               TEXT NOT NULL CHECK(length(result_sha256) = 64),
  result_byte_count           INTEGER NOT NULL CHECK(result_byte_count >= 0),
  result_line_count           INTEGER CHECK(result_line_count IS NULL OR result_line_count >= 0),
  result_estimated_tokens     INTEGER NOT NULL CHECK(result_estimated_tokens >= 0),
  result_redacted             INTEGER NOT NULL CHECK(result_redacted IN (0,1)),
  normalized_label            TEXT,
  normalized_path             TEXT,
  content_type                TEXT NOT NULL CHECK(content_type IN
                              ('text','code','diff','log','json','test_output',
                               'build_output','search_results','error','binary','other')),
  is_error                    INTEGER NOT NULL CHECK(is_error IN (0,1)),
  default_json_pointer        TEXT NOT NULL,
  source_line_start           INTEGER CHECK(source_line_start IS NULL OR source_line_start > 0),
  source_line_end             INTEGER CHECK(source_line_end IS NULL OR source_line_end >= source_line_start),
  exit_code                   INTEGER,
  text_view_byte_count        INTEGER NOT NULL CHECK(text_view_byte_count >= 0),
  stdout_start_byte           INTEGER,
  stdout_end_byte             INTEGER,
  stderr_start_byte           INTEGER,
  stderr_end_byte             INTEGER,
  preview_schema_version      INTEGER NOT NULL CHECK(preview_schema_version = 1),
  preview_json                TEXT NOT NULL CHECK(json_valid(preview_json)),
  preview_text                TEXT NOT NULL,
  preview_estimated_tokens    INTEGER NOT NULL CHECK(preview_estimated_tokens >= 0),
  preview_estimator_id        TEXT NOT NULL,
  preview_input_sha256        TEXT NOT NULL CHECK(length(preview_input_sha256) = 64),
  created_at_ms               INTEGER NOT NULL,
  CHECK((stdout_start_byte IS NULL) = (stdout_end_byte IS NULL)),
  CHECK((stderr_start_byte IS NULL) = (stderr_end_byte IS NULL)),
  CHECK((execution_started = 1) = (started_event_id IS NOT NULL)),
  CHECK(result_status != 'uncertain' OR execution_started = 1),
  CHECK(stdout_start_byte IS NULL OR
        (stdout_start_byte >= 0 AND stdout_end_byte >= stdout_start_byte AND
         stdout_end_byte <= text_view_byte_count)),
  CHECK(stderr_start_byte IS NULL OR
        (stderr_start_byte >= 0 AND stderr_end_byte >= stderr_start_byte AND
         stderr_end_byte <= text_view_byte_count)),
  UNIQUE(turn_id, tool_call_id),
  UNIQUE(batch_id, call_index)
) STRICT, WITHOUT ROWID;

CREATE INDEX artifacts_blob_idx ON artifacts(blob_id);
CREATE INDEX artifacts_turn_idx ON artifacts(turn_id, producing_sequence);
CREATE INDEX artifacts_tool_idx ON artifacts(tool_name, producing_sequence);
CREATE INDEX artifacts_path_idx ON artifacts(normalized_path, producing_sequence)
  WHERE normalized_path IS NOT NULL;

CREATE TABLE turns (
  turn_id                     TEXT PRIMARY KEY NOT NULL CHECK(length(turn_id) = 26),
  reset_epoch                 INTEGER NOT NULL CHECK(reset_epoch >= 0),
  start_sequence              INTEGER NOT NULL UNIQUE CHECK(start_sequence > 0),
  end_sequence                INTEGER UNIQUE,
  commit_sequence             INTEGER UNIQUE,
  status                      TEXT NOT NULL CHECK(status IN
                              ('in_flight','committed','interrupted')),
  protocol_complete           INTEGER NOT NULL CHECK(protocol_complete IN (0,1)),
  accepted_message_tokens     INTEGER NOT NULL DEFAULT 0
                              CHECK(accepted_message_tokens >= 0),
  accepted_message_estimator_id TEXT,
  accepted_message_input_sha256 TEXT
                              CHECK(accepted_message_input_sha256 IS NULL OR
                                    length(accepted_message_input_sha256) = 64),
  retired_by_epoch            INTEGER CHECK(retired_by_epoch IS NULL OR retired_by_epoch > 0),
  source_hash                 TEXT CHECK(source_hash IS NULL OR length(source_hash) = 64),
  CHECK((status = 'committed') = (commit_sequence IS NOT NULL)),
  CHECK(end_sequence IS NULL OR end_sequence >= start_sequence)
) STRICT, WITHOUT ROWID;

CREATE INDEX turns_epoch_sequence_idx ON turns(reset_epoch, start_sequence);
CREATE INDEX turns_retirement_idx ON turns(reset_epoch, retired_by_epoch, start_sequence);

CREATE TABLE summary_segments (
  segment_id                  TEXT PRIMARY KEY NOT NULL CHECK(length(segment_id) = 26),
  compaction_event_id         TEXT NOT NULL UNIQUE CHECK(length(compaction_event_id) = 26),
  compaction_sequence         INTEGER NOT NULL UNIQUE CHECK(compaction_sequence > 0),
  epoch                       INTEGER NOT NULL CHECK(epoch > 0),
  reset_epoch                 INTEGER NOT NULL CHECK(reset_epoch >= 0),
  source_start_sequence       INTEGER NOT NULL CHECK(source_start_sequence > 0),
  source_end_sequence         INTEGER NOT NULL CHECK(source_end_sequence >= source_start_sequence),
  source_hash                 TEXT NOT NULL CHECK(length(source_hash) = 64),
  source_tokens               INTEGER NOT NULL CHECK(source_tokens >= 0),
  source_estimator_id         TEXT NOT NULL,
  source_input_sha256         TEXT NOT NULL CHECK(length(source_input_sha256) = 64),
  segment_hash                TEXT NOT NULL CHECK(length(segment_hash) = 64),
  handoff_hash                TEXT NOT NULL CHECK(length(handoff_hash) = 64),
  segment_json                TEXT NOT NULL CHECK(json_valid(segment_json)),
  handoff_json                TEXT NOT NULL CHECK(json_valid(handoff_json)),
  output_tokens               INTEGER NOT NULL CHECK(output_tokens >= 0),
  output_estimator_id         TEXT NOT NULL,
  output_input_sha256         TEXT NOT NULL CHECK(length(output_input_sha256) = 64),
  provider                    TEXT NOT NULL,
  model                       TEXT NOT NULL,
  prompt_version              TEXT NOT NULL,
  created_at_ms               INTEGER NOT NULL,
  UNIQUE(reset_epoch, epoch)
) STRICT, WITHOUT ROWID;

CREATE INDEX summary_segments_source_idx
  ON summary_segments(reset_epoch, source_start_sequence, source_end_sequence);

CREATE TABLE projection_checkpoints (
  projection_name             TEXT PRIMARY KEY NOT NULL,
  checkpoint_schema_version   INTEGER NOT NULL CHECK(checkpoint_schema_version > 0),
  applied_through_sequence    INTEGER NOT NULL CHECK(applied_through_sequence >= 0),
  event_prefix_hash           TEXT NOT NULL CHECK(length(event_prefix_hash) = 64),
  payload_json                TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_hash                TEXT NOT NULL CHECK(length(payload_hash) = 64),
  updated_at_ms               INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE search_documents (
  rowid                       INTEGER PRIMARY KEY,
  document_id                 TEXT NOT NULL UNIQUE,
  source_kind                 TEXT NOT NULL CHECK(source_kind IN
                              ('event','artifact','summary_segment','state')),
  source_field                TEXT NOT NULL,
  event_id                    TEXT,
  event_sequence              INTEGER,
  event_kind                  TEXT,
  turn_id                     TEXT,
  reset_epoch                 INTEGER NOT NULL CHECK(reset_epoch >= 0),
  artifact_id                 TEXT REFERENCES artifacts(artifact_id)
                              ON UPDATE RESTRICT ON DELETE CASCADE,
  summary_segment_id          TEXT REFERENCES summary_segments(segment_id)
                              ON UPDATE RESTRICT ON DELETE CASCADE,
  state_id                    TEXT,
  tool_name                   TEXT,
  normalized_path             TEXT,
  content_sha256              TEXT NOT NULL CHECK(length(content_sha256) = 64),
  text                        TEXT NOT NULL,
  created_at_ms               INTEGER NOT NULL,
  CHECK((source_kind != 'artifact') OR artifact_id IS NOT NULL),
  CHECK((source_kind != 'summary_segment') OR summary_segment_id IS NOT NULL)
) STRICT;

CREATE INDEX search_documents_event_idx ON search_documents(event_sequence, source_field);
CREATE INDEX search_documents_turn_idx ON search_documents(turn_id, event_sequence);
CREATE INDEX search_documents_artifact_idx ON search_documents(artifact_id);
CREATE INDEX search_documents_summary_idx ON search_documents(summary_segment_id);
CREATE INDEX search_documents_filter_idx
  ON search_documents(reset_epoch, source_kind, event_kind, tool_name);
CREATE INDEX search_documents_path_idx ON search_documents(normalized_path)
  WHERE normalized_path IS NOT NULL;

CREATE VIRTUAL TABLE search_fts USING fts5(
  text,
  content='search_documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2 tokenchars ''_./-''',
  prefix='2 3 4'
);

CREATE TABLE artifact_access (
  access_id                   INTEGER PRIMARY KEY,
  artifact_id                 TEXT NOT NULL REFERENCES artifacts(artifact_id)
                              ON UPDATE RESTRICT ON DELETE CASCADE,
  access_kind                 TEXT NOT NULL CHECK(access_kind IN
                              ('retrieved','search_hit','preview_injected','handoff_referenced')),
  event_sequence              INTEGER,
  filter_hash                 TEXT,
  returned_bytes              INTEGER NOT NULL DEFAULT 0 CHECK(returned_bytes >= 0),
  occurred_at_ms              INTEGER NOT NULL
) STRICT;

CREATE INDEX artifact_access_artifact_idx
  ON artifact_access(artifact_id, occurred_at_ms);

CREATE TABLE telemetry_counters (
  key                         TEXT PRIMARY KEY NOT NULL,
  value                       INTEGER NOT NULL CHECK(value >= 0),
  updated_at_ms               INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE telemetry_samples (
  sample_id                   INTEGER PRIMARY KEY,
  name                        TEXT NOT NULL,
  event_sequence              INTEGER,
  value_integer               INTEGER,
  dimensions_json             TEXT NOT NULL DEFAULT '{}'
                              CHECK(json_valid(dimensions_json)),
  occurred_at_ms              INTEGER NOT NULL,
  CHECK(value_integer IS NOT NULL)
) STRICT;

CREATE INDEX telemetry_samples_name_idx
  ON telemetry_samples(name, occurred_at_ms);

CREATE TABLE skill_session_stats (
  skill_id                    TEXT PRIMARY KEY NOT NULL,
  catalog_scope               TEXT NOT NULL,
  load_count                  INTEGER NOT NULL DEFAULT 0 CHECK(load_count >= 0),
  use_count                   INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0),
  reload_count                INTEGER NOT NULL DEFAULT 0 CHECK(reload_count >= 0),
  tokens_injected             INTEGER NOT NULL DEFAULT 0 CHECK(tokens_injected >= 0),
  first_sequence              INTEGER,
  last_sequence               INTEGER,
  updated_at_ms               INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
```

`schema_meta` contains at least `history_schema_version`, `event_schema_version`,
string canonical `projection_version`, `artifact_policy_version`,
`redaction_version`, `token_estimator_schema_version`, and
`unicode_utility_version`. The integer projection-checkpoint column is named
`checkpoint_schema_version`; it is not the string canonical projection ID.

`event_schema_version` is `2`. `artifact_blobs.blob_id` is
`sha256:<lowercase-hex-sha256>`. The duplicate
`sha256` column is intentional so malformed IDs can be detected. Blob insertion
deduplicates identical post-redaction result bytes. `artifacts` remains one row
per producing tool call, preserving provenance even when bytes deduplicate.
`summary_segments.segment_json` and `handoff_json` are RFC 8785 canonical bytes
of the finalized Compaction-owner DTOs, stored as SQLite text. Their normalized
source/output estimator IDs and hashes must equal the nested DTO/event values.

The foreign keys to derived `summary_segments` and canonical `artifacts` are
safe because a derived-table rebuild inserts parent rows before search rows.
There is deliberately no SQLite events table and no foreign key pretending
SQLite owns event durability.

The application maintains `search_documents` and `search_fts` explicitly in the
same derived transaction; no SQLite triggers are installed while
`trusted_schema = OFF`. Insert uses the same rowid in both tables. Update/delete
first writes the FTS5 external-content `delete` command with the old rowid/text,
then updates/deletes the content row and inserts replacement FTS text when
needed. Rebuild executes `INSERT INTO search_fts(search_fts) VALUES('rebuild')`
after all content rows are present.

`projection_checkpoints.payload_hash` is SHA-256 of these bytes in order:
ASCII `praana-projection-checkpoint-v1`, NUL, UTF-8 `projection_name`, NUL,
`u32_be(checkpoint_schema_version)`, `u64_be(applied_through_sequence)`, the raw
32-byte decoded `event_prefix_hash`, and RFC 8785 canonical JSON bytes parsed
from `payload_json`. Writers store compact RFC 8785 JSON in `payload_json`.

## 6. Artifact policy

### 6.1 Effective policy

History consumes `history.artifact_inline_tokens`,
`history.artifact_batch_inline_tokens`, and `history.artifact_preview_tokens`.
Their exact defaults, ranges, source/merge behavior, and phase gate are owned
only by `RUST_V2_CONFIG_SPEC.md`. Effective values MUST be emitted in session
telemetry. The per-result threshold applies to each deterministically serialized
post-redaction tool result. The aggregate budget applies to the sum of inline
result token estimates in one accepted tool batch. The exact component bytes,
threshold comparison, estimator selection, and rounding are defined by
`RUST_V2_TOKEN_ACCOUNTING_SPEC.md`.

Results are considered in accepted tool-call order after all parallel results
have completed post-tool processing:

1. Any binary/non-UTF-8 result is artifactized regardless of estimate.
2. Any text/JSON result over `history.artifact_inline_tokens` is artifactized.
3. For each otherwise eligible result, inline it only if adding it keeps the
   batch inline sum at or under `history.artifact_batch_inline_tokens`.
4. Artifactize every other result. Error results receive exactly the same test.
5. Retrieval results that already name an artifact are never ingested as new
   source artifacts.
6. Preview tokens do not count toward the aggregate inline-payload budget, but
   all previews count in request admission. If a preview exceeds
   `history.artifact_preview_tokens` it is
   regenerated by the deterministic fallback policy, not truncated at an
   arbitrary UTF-8 byte.

The policy is independent of result completion order. It cannot change after
an event is durable, and old inline events are never rewritten because they
aged.

### 6.2 Canonical body and text view

`canonical_result` is the exact complete post-redaction result bytes described
by protocol `ToolResultBody`. Structured JSON uses RFC 8785. Plain text uses
unchanged UTF-8 bytes. Binary output uses exact bytes after the tool-runtime
redaction/spooling policy and is never decoded merely for storage. The artifact
row preserves execution, batch, step, call, attempt, and event identity so
recovery can prove that an orphan belongs to one execution.

`default_json_pointer` selects the default retrieval value:

- `/content` when the result has a string `content` field.
- `/stdout` when stdout is the only non-empty output channel.
- The empty pointer for every other result, meaning the complete value.

The text view is computed without another persisted copy:

- A selected JSON string decodes to its string bytes.
- A selected object or array renders as pretty JSON with two-space indentation,
  sorted keys, UTF-8, and final newline omitted.
- A shell result with both stdout and stderr renders stdout followed directly by
  stderr. The four byte-boundary columns identify the two ranges. Empty channels
  have equal start and end positions.

Line counts and line filters operate on this text view. An empty text view has
zero lines. Otherwise line count is one plus the number of LF bytes.

### 6.3 Immutable preview schema

`artifacts.preview_json` contains exactly this structure. Its rendered
`preview_text` becomes protocol `ArtifactToolResult.preview` beside
`ArtifactRef`; database JSON supports integrity checks and UI metadata without
changing that canonical event DTO:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactPreviewV1 {
    pub preview_schema_version: u32,
    pub artifact_id: ArtifactId,
    pub sha256: Sha256Digest,
    pub tool_call_id: ToolCallId,
    pub tool_name: String,
    pub label: Option<String>,
    pub content_type: ArtifactContentType,
    pub byte_count: u64,
    pub line_count: u64,
    pub estimated_tokens: u64,
    pub is_error: bool,
    pub redaction: PreviewRedaction,
    pub sample: PreviewSample,
    pub retrieval: Vec<ArtifactRetrievalHint>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactContentType {
    Text,
    Code,
    Diff,
    Log,
    Json,
    TestOutput,
    BuildOutput,
    SearchResults,
    Error,
    Binary,
    Other,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreviewRedaction {
    pub applied: bool,
    pub replacement_count: u32,
    pub kinds: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PreviewSample {
    pub strategy: PreviewStrategy,
    pub text: String,
    pub omitted_bytes: u64,
    pub omitted_lines: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreviewStrategy { None, Full, Head, Tail, HeadTail }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRetrievalHint {
    pub operation: String,
    pub arguments: serde_json::Value,
}
```

Every field shown is required. `label` is serialized as JSON null when absent.
The strict decoder rejects duplicate keys, missing keys, unknown keys, unknown
enum values, and a schema version other than 1. Protocol ID newtypes provide the
exact uppercase-ULID/provider-ID validation. Other History request/response DTO
snippets in this specification follow the same rules: structs deny unknown
fields, enum values use the shown snake-case names, response option fields are
present as null, and request option fields may be absent only where the request
contract calls them optional.

Preview generation is deterministic and content-aware:

- JSON treats each complete top-level object member in RFC 8785 key order as one
  unit rendered `<JSON_KEY>: <VALUE>`, where the key and scalar value use compact
  JSON encoding. Object/array values render exactly `<object items=N>` or
  `<array items=N>`. A top-level array uses one unit per immediate item rendered
  `[N]: <VALUE>` with zero-based decimal `N`. A top-level scalar is one unit
  rendered `value: <VALUE>`. It never emits a syntactically broken JSON prefix.
- Test/build output prioritizes, in original order, complete lines matching the
  ASCII case-insensitive fixed alternatives `error`, `failed`, `failure`,
  `panic`, `test result`, `summary`, `passed`, then the final five complete
  lines, then leading lines.
- Diff output prioritizes complete lines beginning `diff --git `, `--- `, `+++ `,
  or `@@ ` in original order, then alternates first and last complete changed
  lines beginning `+` or `-` but not headers, then leading context lines.
- Typed search output treats each complete match object as one unit and uses
  provider result order. Untyped search-like text follows generic text.
- Generic text alternates the first remaining complete line and last remaining
  complete line. A single line that cannot fit is omitted whole.
- Binary content emits no sample.

For every strategy, History first renders the metadata-only form below. It then
tries candidate units in the stated priority order. After each addition it
recomputes source-span omission counts, renders the complete preview, and runs
`TokenEstimatorV1`; it keeps the unit only when the complete rendering remains
within `history.artifact_preview_tokens`. Units retain exact source byte/line spans so
`omitted_bytes` and `omitted_lines` count source content not represented by the
sample. Duplicate units selected by two priorities are included once at their
original position. Selected textual units render in source order even when
priority selection occurred in another order.

The proposed preview label is capped at 256 UTF-8 bytes on a scalar boundary.
If the metadata-only rendering with that label exceeds the preview token bound,
the preview object sets `label = null` and retries. If the fixed host metadata
without a label cannot fit, artifact finalization fails with
`HISTORY_PREVIEW_BOUND`; it never emits an over-budget preview.

`preview_text` has exactly this LF-only format, with no leading or trailing LF:

```text
Artifact <ARTIFACT_ID>: <TOOL_NAME><LABEL> (<BYTE_COUNT> bytes, <LINE_COUNT> lines, <ESTIMATED_TOKENS> estimated tokens; error=<true|false>).
Sample (<STRATEGY>):
<SAMPLE_TEXT_OR_[no textual sample]>
[... <OMITTED_BYTES> bytes and <OMITTED_LINES> lines omitted ...]
Retrieve with retrieve_artifact({"artifact_id":"<ARTIFACT_ID>"}).
```

`<LABEL>` is empty when absent and otherwise is ` [label=<JSON_STRING>]`, where
`<JSON_STRING>` uses normal compact JSON string escaping. Strategy names are the
snake-case enum values. The omission line is absent only when both omitted
counts are zero. For `strategy = none`, the sample line is exactly
`[no textual sample]`. For any other empty sample, it is `[no selected textual
unit fit]`. Sample content is copied after redaction and is untrusted data; host
lines are generated from validated fields.

`preview_text` is the deterministic model rendering of this object and always
contains the artifact ID, counts, omission status when content is omitted, and
`retrieve_artifact` instruction. It MUST fit
`history.artifact_preview_tokens` under the
applicable `TokenEstimatorV1`; a non-provider artifact preview uses the generic
estimator. If a content-aware strategy cannot fit, History Storage retries its
own deterministic strategy with fewer complete semantic units and finally a
metadata-only preview containing ID, counts, omission, and retrieval. It never
cuts an arbitrary UTF-8 byte range. The complete body never appears in a preview
merely because it is an error. No protocol/provider/tool/IPC/UI layer may
regenerate, byte-slice, or replace this preview.

## 7. Artifact and event write ordering

The session writer preallocates event ID and sequence before artifact storage.
For an artifactized result the critical section is:

```text
1. Check cancellation before entering the durability critical section.
2. Redact and canonicalize the result.
3. Preallocate protocol `EventId` and `MessageId`; compute exact
   `ToolResultStatus`, body SHA-256/counts, token estimate identity/hash,
   metadata, preview JSON, and preview text.
4. BEGIN IMMEDIATE on history.db.
5. INSERT OR IGNORE artifact_blobs; verify bytes on a hash collision.
6. INSERT artifacts with the future `ToolExecutionFinished` ID/sequence and the
   exact result-message/status/body metadata plus execution-started fact,
   optional start event, batch, step, call, non-null source attempt, and
   call-index identity.
7. COMMIT. synchronous=FULL makes the commit the artifact durability boundary.
8. Build ToolExecutionFinished with the immutable preview/reference.
9. Append the canonical event as one write to the O_APPEND descriptor.
10. fdatasync/fsync events.jsonl.
11. Publish the event to projections and UI.
12. In a separate idempotent SQLite transaction, update derived rows.
```

For an inline result, steps 4 through 7 are absent. The event still becomes
visible only after event fsync.

Cancellation requested during steps 4 through 10 is deferred until step 10
finishes. A process crash can therefore produce an unreferenced artifact, but
cannot produce a normally visible reference to an uncommitted artifact.

The core MUST NOT hold a SQLite transaction while invoking a provider, tool,
hook, redactor, compactor, UI callback, or arbitrary plugin.

## 8. Projection write ordering

Derived writes happen only after the source event is durable. A projector uses
one SQLite transaction per event or bounded contiguous event batch:

```text
BEGIN IMMEDIATE;
verify checkpoint applied_through_sequence and prefix hash;
apply turns, summaries, search documents, and counters idempotently;
upsert projection checkpoint with new sequence and prefix hash;
COMMIT;
```

If that transaction fails, the event remains canonical. The in-memory
projection may continue from the durable event, but SQLite-dependent search is
marked stale. Before the next SQLite query or mutating resume, replay starts at
the last valid checkpoint. Replaying an already applied event MUST produce no
duplicate row and no counter inflation.

No behavior may depend on telemetry transaction success.

### 8.1 Multi-file rollback journals

History Storage owns rollback journal directories, bytes, permissions,
durability, and startup recovery. Tool Runtime requests a journal operation; it
does not invent another format.

`journals/write-<execution-id>.json` is strict JSON with this exact shape:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WriteJournalV1 {
    pub write_journal_schema_version: u32,
    pub session_id: SessionId,
    pub execution_id: ToolExecutionId,
    pub batch_id: ToolBatchId,
    pub call_id: ToolCallId,
    pub phase: WriteJournalPhase,
    pub next_entry: u32,
    pub entries: Vec<WriteJournalEntryV1>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WriteJournalPhase { Prepared, Committing, Committed, RollbackRequired }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WriteJournalEntryV1 {
    pub ordinal: u32,
    pub target_path: String,
    pub target_existed: bool,
    pub original_identity: Option<FileIdentityV1>,
    pub original_sha256: Option<Sha256Digest>,
    pub before_relpath: Option<String>,
    pub staged_relpath: String,
    pub staged_sha256: Sha256Digest,
    pub replacement_identity: Option<FileIdentityV1>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "platform", content = "data", rename_all = "snake_case",
        deny_unknown_fields)]
pub enum FileIdentityV1 {
    Unix { device: u64, inode: u64, size: u64, mtime_ns: i64, ctime_ns: i64 },
    Windows { volume_serial: u64, file_id_hex: String, size: u64, last_write_100ns: u64 },
}
```

Every option field is present as null when absent. Entries are sorted by
normalized target path and then request ordinal. Paths are absolute normalized
display paths; all journal payload paths are revalidated relative to the
already-opened session/workspace handles before use. `before_relpath` and
`staged_relpath` must resolve beneath that execution's journal directory.
`file_id_hex` is exactly 32 lowercase hexadecimal characters representing the
unsigned 128-bit Windows file ID in big-endian display order.

Preparation writes and fsyncs every before/staged file, writes the journal to a
user-only temporary file, fsyncs it, renames it, and fsyncs the journal
directory. Before each target replacement the writer verifies the current
target existence, `FileIdentityV1`, byte size, and SHA-256 still equal the
captured original. It then sets `phase = committing`, fsyncs the journal,
performs the atomic replacement, fsyncs the target parent directory, captures
the replacement identity, increments `next_entry`, and durably rewrites the
journal before advancing.

Rollback MUST NOT overwrite an independently changed target. For each committed
entry in reverse order, rollback proceeds only when the current target identity
and SHA-256 equal the recorded replacement identity and staged hash. If a crash
occurred after replacement but before `replacement_identity` was recorded, the
current target must still have the staged hash and must not have the original
identity; that exact case may be adopted as the replacement identity. Any other
identity/hash state is `HISTORY_ROLLBACK_CONFLICT`: preserve the journal, poison
the mutating session, append uncertain execution when canonical history permits,
and require user inspection. Never restore old bytes over a user or external
change.

For a verified entry whose original target existed, rollback restores the
hash-verified `before_relpath` through a target-directory temporary file and
atomic rename. For a verified entry whose original target did not exist, it
removes only the still-matching replacement. Each action fsyncs the target parent
before the next entry. Before/staged file hashes are verified before use.

After all replacements, set `phase = committed` and fsync the journal. Remove
the journal tree only after the canonical tool finish is durable or after a
verified rollback plus uncertain finish is durable; fsync `journals/` after
removal.

### 8.2 Shell raw spools

History Storage owns `spools/<execution-id>/`. The directory is mode `0700` and
manifest/raw files are mode `0600` on Unix, with the equivalent private Windows
ACL. `manifest.json` is strict JSON:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShellSpoolManifestV1 {
    pub shell_spool_schema_version: u32,
    pub session_id: SessionId,
    pub execution_id: ToolExecutionId,
    pub batch_id: ToolBatchId,
    pub call_id: ToolCallId,
    pub owner_pid: u32,
    pub owner_process_start_id: String,
    pub child_pid: Option<u32>,
    pub child_process_start_id: Option<String>,
    pub unix_process_group_id: Option<i32>,
    pub windows_job_nonce: Option<String>,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
    pub finalized: bool,
}
```

Create and fsync the directory and manifest before spawning the process. Stream
bytes to `stdout.raw` and `stderr.raw`. Immediately after successful spawn,
durably rewrite the manifest with child start identity and exactly one platform
supervisor identity before publishing process progress. All option fields are
required JSON keys and are null when not applicable. Flush and fsync both stream
files before redaction or artifact finalization. Manifest byte counts are
durably updated after capture finishes. Raw spools are unredacted, are never
indexed or exposed through IPC, and are never evidence that a tool completed.

Startup may remove a raw spool only after canonical recovery has classified the
matching durable execution, process identity checks prove the owner and process
tree are dead, and any matching committed artifact has been reconciled. Age
alone is insufficient. Removal fsyncs the spool parent. A live or unverifiable
owner is `HISTORY_OPERATIONAL_RECOVERY_UNCERTAIN`; it poisons the session and
requires inspection rather than deleting evidence or starting another process.

### 8.3 Startup ordering for operational recovery

After acquiring the session writer lock and before admitting a provider request
or tool call, startup runs exactly:

1. Validate/repair the canonical JSONL prefix without executing tools.
2. Open and integrity-check canonical artifact tables read-only.
3. Reconcile orphan artifacts against durable started executions using section
   9.2 and protocol recovery. Do not garbage-collect yet.
4. Reconcile multi-file journals. A cryptographically proved finalized result
   preserves a committed batch; otherwise perform only identity-safe rollback
   and classify execution as uncertain.
5. Prove shell process trees dead, classify unfinished shell executions as
   uncertain, then remove eligible raw spools.
6. Append/fsync required recovered or uncertain finish/batch/turn events.
7. Rebuild stale derived projections.
8. Only now run orphan blob, journal, spool, or trash garbage collection.

IPC reconnect, UI cache state, and maintenance timers cannot reorder or bypass
these steps.

## 9. Recovery and integrity

### 9.1 JSONL recovery

Startup follows protocol section 14.1, retaining each record's byte offset and
exact line hash.

1. Parse the longest complete valid prefix.
2. Verify UTF-8, envelope schema, session ID, contiguous sequence, unique event
   ID, legal event state transitions, and referenced artifact shape.
3. If the final LF-terminated line or unterminated remainder is malformed, copy
   its exact bytes to
   `quarantine/events-tail-<sha256-of-quarantined-bytes>.bin`, fsync the file and
   quarantine directory, truncate `events.jsonl` to the last valid offset,
   fsync the event file, and fsync the session directory. If an unterminated
   remainder is one complete valid next event, append one LF and fsync instead.
   This removes only an incomplete append, not a valid canonical event.
4. If a complete non-final line is malformed, or a sequence/ID invariant fails,
   return `HISTORY_EVENT_INTEGRITY`. Do not skip the record or resume mutating.
5. An unknown future event schema returns `HISTORY_SCHEMA_UNSUPPORTED` rather
   than interpreting it partially.

The recovery action is surfaced to the user and recorded as a `SystemNote` only
after the log is writable again. The note does not contain quarantined bytes.

### 9.2 Orphan artifacts

An orphan is an `artifacts` row whose `producing_event_id` does not occur in the
valid event prefix. This is expected after a crash between the SQLite commit and
event fsync.

- An orphan is not projected or indexed before recovery validates it.
- If exactly one orphan matches a durable unfinished execution on reserved
  finish event ID/sequence, `result_message_id`, exact `result_status`, execution
  ID, `execution_started = 1`, non-null `started_event_id`, batch ID, step ID,
  call ID, call index, tool name, and non-null source attempt, recovery
  recomputes and verifies the blob hash, canonical result
  bytes, `ToolResultBody` hash/counts, token estimator identity/input hash,
  immutable preview JSON/text, and every duplicated metadata field. The source
  attempt, `started_event_id`, and durable `ToolExecutionStarted` payload must
  agree. Only then may resume append the
  reconstructed `ToolExecutionFinished` with `recovered = true`. Only that new
  event makes the result visible and indexable.
- If proof is absent or ambiguous, resume appends the protocol synthetic
  uncertain result and reports the uncertain side effect. It never reruns the
  started tool automatically.
- `praana session inspect` may retrieve an orphan by explicit artifact ID with
  an `orphan: true` warning for forensic recovery.
- An orphan that might correspond to a durable started execution is not eligible
  for deletion until recovery durably appends either the exact recovered finish
  or an uncertain finish. IPC disconnect/reconnect and UI cache cleanup cannot
  authorize deletion.
- After that classification, maintenance retains forensic orphan rows for the
  effective `session.orphan_retention_days`. On clean startup or close, it may
  delete older unreferenced
  orphan `artifacts` rows and then unreferenced blob rows in one transaction.
- A zero-day explicit `praana session gc --orphans` may delete already
  classified forensic orphans immediately, but it cannot bypass execution
  classification or startup ordering.

Age is based on `created_at_ms`, but a backward clock never shortens retention:
negative age is treated as zero.

An artifact row lacking any required schema-v1 recovery field can never prove a
finish. Its matching execution is uncertain. There is no best-effort migration
or reconstruction from preview text, raw shell spool, IPC payload, or UI state.

### 9.3 Dangling references

A dangling reference is a durable event that names a missing artifact row/blob,
or a row whose body hash does not match. It violates the artifact-before-event
rule and is `HISTORY_DANGLING_ARTIFACT`.

The affected tool result, its batch completion, and its turn commit are excluded
from the accepted-conversation projection. The session opens read-only with a
recovery report. It does not fabricate content, downgrade the reference to its
preview, or rerun the tool. A user must restore `history.db` from backup or
delete the session. There is no automatic destructive repair in schema v1.

### 9.4 Database checks and rebuild

Normal startup performs:

```sql
PRAGMA quick_check;
PRAGMA foreign_key_check;
```

An unclean shutdown, checkpoint mismatch, or explicit doctor command performs:

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
INSERT INTO search_fts(search_fts) VALUES('integrity-check');
```

If only derived tables fail, the writer:

1. Creates `history.db.rebuild` with private permissions and the exact schema.
2. Copies and hash-verifies `artifact_blobs` and `artifacts` in one read
   snapshot.
3. Replays the valid event prefix into all derived tables.
4. Runs full integrity checks.
5. Fsyncs the rebuilt database and containing directory.
6. Atomically renames the old database to `history.db.bad-<unix-ms>` and the
   rebuilt database to `history.db`.

If a canonical artifact table is corrupt or a referenced body fails SHA-256,
automatic rebuild stops with `HISTORY_CANONICAL_DB_CORRUPT`. It never rebuilds a
body from an excerpt or summary.

## 10. Retrieval contract

### 10.1 Request

```rust
pub struct RetrieveArtifactRequest {
    pub artifact_id: ArtifactId,
    pub selector: Option<ArtifactSelector>,
    pub line_range: Option<InclusiveLineRange>,
    pub head_lines: Option<u32>,
    pub tail_lines: Option<u32>,
    pub regex: Option<RegexFilter>,
    pub json_pointer: Option<String>,
    pub max_bytes: Option<u64>,
}

pub enum ArtifactSelector { Default, CompleteResult, Stdout, Stderr }

pub struct InclusiveLineRange { pub start: u64, pub end: u64 }

pub struct RegexFilter {
    pub pattern: String,
    pub case_sensitive: bool,
    pub context_before: u32,
    pub context_after: u32,
    pub max_matches: u32,
}
```

Exactly one of `line_range`, `head_lines`, and `tail_lines` may be supplied.
`json_pointer` applies to the complete canonical JSON value before text
rendering and cannot be combined with `selector = stdout|stderr`. Line slicing
then applies, followed by regex filtering. Regex context ranges are merged when
they overlap. Lines retain original 1-based line numbers in the response.

Defaults and limits:

- `selector = default`.
- Full retrieval is allowed only when result size is at or below 256 KiB unless
  `max_bytes` is explicitly set.
- Server hard maximum returned bytes is 2 MiB per call.
- Regex pattern maximum is 4096 bytes, context is at most 20 lines on each side,
  and matches are at most 1000.
- Rust's linear-time `regex` crate is used; unsupported look-around or
  backreferences return `HISTORY_REGEX_UNSUPPORTED`.
- A response that would exceed a bound returns a partial response with
  `complete = false` and a continuation request. It never claims completeness.

### 10.2 Response

```rust
pub struct RetrieveArtifactResponse {
    pub artifact_id: ArtifactId,
    pub sha256: Sha256Digest,
    pub selector: ArtifactSelector,
    pub content: String,
    pub returned_bytes: u64,
    pub complete: bool,
    pub selected_line_start: Option<u64>,
    pub selected_line_end: Option<u64>,
    pub total_lines: u64,
    pub matches: Vec<ArtifactRegexMatch>,
    pub continuation: Option<RetrieveArtifactRequest>,
}

pub struct ArtifactRegexMatch {
    pub line: u64,
    pub start_column: u64,
    pub end_column: u64,
}
```

Columns count Unicode scalar values, not bytes. Returned text preserves source
LF bytes after JSON decoding; it does not normalize line endings inside strings.
Access telemetry is written after successful retrieval and is not part of the
canonical response.

Repeated identical retrieval may be detected for a model-use nudge, but the
storage API always returns the requested bytes. A caller choosing to substitute
a compact card must set `complete = false` and `skipped_payload = true` at its
own protocol layer. It may not masquerade as a successful full retrieval.

## 11. Unified session search

### 11.1 Indexed content

The projector indexes:

- Accepted user message text.
- Accepted, non-superseded assistant visible text and reasoning summaries.
- Redacted tool-call names and argument copies.
- Inline redacted tool results.
- Complete redacted text views of referenced artifacts.
- Immutable summary segments and active historical handoffs.
- State object payloads as state search documents.

It does not index failed partial assistant output, opaque/encrypted provider
reasoning, credentials, raw unredacted tool data, or UI-only deltas.

Each logical field is a separate `search_documents` row so a result can identify
the matched field exactly. Artifact text is indexed only after an event
references the artifact. A reset changes default visibility but does not delete
documents.

### 11.2 Request and filters

```rust
pub struct SessionSearchRequest {
    pub query: String,
    pub mode: SessionSearchMode,
    pub case_sensitive: bool,
    pub filters: SessionSearchFilters,
    pub limit: u32,
    pub cursor: Option<String>,
}

pub enum SessionSearchMode { Exact, Regex, Fts }

pub struct SessionSearchFilters {
    pub source_kinds: Vec<SearchSourceKind>,
    pub event_kinds: Vec<String>,
    pub turn_ids: Vec<TurnId>,
    pub sequence_start: Option<u64>,
    pub sequence_end: Option<u64>,
    pub tool_names: Vec<String>,
    pub path_globs: Vec<String>,
    pub artifact_ids: Vec<ArtifactId>,
    pub summary_segment_ids: Vec<SummarySegmentId>,
    pub state_ids: Vec<StateId>,
    pub include_before_reset: bool,
}
```

Empty filter vectors mean no restriction. Sequence bounds are inclusive.
`include_before_reset` defaults to false, selecting only the current reset
epoch. Explicit audit clients may set it true. Path globs match normalized `/`
separated paths, are case-sensitive on every platform, and support `*`, `?`,
and `**`; they never read the filesystem.

`limit` defaults to 20 and is capped at 100. Query and cursor together are
capped at 64 KiB. The cursor is an authenticated opaque encoding of the last
sort tuple plus a hash of query, mode, filters, projection sequence, and search
schema. A changed projection returns `HISTORY_SEARCH_CURSOR_STALE`.

Exact mode is literal substring search over Unicode scalar values. Case-sensitive
mode uses original scalar values. Case-insensitive mode applies
`default_casefold_v1` from `RUST_V2_TOKEN_ACCOUNTING_SPEC.md` to query and
candidate and maps fold expansions back to complete original scalar ranges as
that specification requires. It MUST NOT use platform lowercase, locale, ICU,
or SQLite `LIKE`. Regex uses the pinned Rust `regex` crate and the same limits as
artifact retrieval; its crate version and Unicode tables are part of the search
implementation manifest. FTS accepts a restricted query grammar of terms,
quoted phrases, prefix `*`, `AND`, `OR`, `NOT`, and parentheses. Column names,
`NEAR`, and raw FTS control syntax are rejected.

FTS uses the bundled SQLite version pinned by the Rust dependency lock and the
literal tokenizer declaration in section 5.2. CI records `sqlite_version()` and
the normalized `sqlite_master` SQL beside golden rankings. Changing SQLite or
tokenizer build options requires a search fixture review. FTS discovery is not
used as exact-search or StateGraph lexical-normalization authority.

### 11.3 Unified result schema

All three modes return the same shape:

```rust
pub struct SessionSearchResult {
    pub result_id: SearchResultId,
    pub mode: SessionSearchMode,
    pub source_kind: SearchSourceKind,
    pub source_field: String,
    pub event_id: Option<EventId>,
    pub event_sequence: Option<u64>,
    pub event_kind: Option<String>,
    pub turn_id: Option<TurnId>,
    pub artifact_id: Option<ArtifactId>,
    pub summary_segment_id: Option<SummarySegmentId>,
    pub state_id: Option<StateId>,
    pub content_sha256: Sha256Digest,
    pub score: SearchScore,
    pub occurrences: Vec<SearchOccurrence>,
    pub excerpt: String,
    pub excerpt_complete: bool,
    pub retrieval: SearchRetrieval,
}

pub struct SearchScore {
    pub primary_micros: i64,
    pub raw_bm25_micros: Option<i64>,
    pub rank_reason: String,
}

pub struct SearchOccurrence {
    pub line: u64,
    pub start_column: u64,
    pub end_column: u64,
}

pub struct SearchRetrieval {
    pub tool: String,
    pub arguments: serde_json::Value,
}
```

`result_id` is the uppercase Crockford ULID encoding of the first 16 bytes of
SHA-256 over ASCII `praana-search-result-v1`, NUL, source kind, NUL, canonical
source ID, NUL, source field, NUL, and lowercase content SHA-256. It is stable
for one immutable source field and independent of query/rank. A derived-ID
collision with different source identity is `HISTORY_EVENT_INTEGRITY`.

`excerpt` is at most 800 UTF-8 bytes and is cut only at scalar and preferably
line boundaries. `excerpt_complete` is true only when it contains the complete
matched source field. Artifact retrieval arguments include artifact ID and a
line range around the match. Event/summary/state retrieval arguments identify
the source ID and field.

### 11.4 Ranking

Ranking is deterministic for one projection snapshot:

- Exact and regex: `primary_micros = 1_000_000`. Sort by primary descending,
  event sequence descending with missing sequence as zero, document ID
  ascending, then first occurrence line/column ascending.
- FTS: execute `bm25(search_fts, 1.0)`. SQLite's raw value is smaller for a
  better match. Store `raw_bm25_micros = round(raw * 1_000_000)` and
  `primary_micros = -raw_bm25_micros`. Sort primary descending, then the same
  deterministic ties as above.

There is no hidden recency boost, semantic score, or engine context score in
v1. Filters are applied before limiting. Duplicate matches in the same source
field are one result with bounded occurrences. The same blob produced by two
tool calls remains two artifact sources because provenance differs.

## 12. Concurrency and cancellation

All mutating history operations pass through one per-session async writer task.
Callers submit ordered commands and receive a result only after the documented
durability boundary. The writer owns event sequence allocation, the append file
descriptor, the read-write SQLite connection, and the in-memory projection.

Parallel tools may execute concurrently. Execution-start events are durable in
provider call order before bodies run. Finish events may use physical
finalization order. Artifact decisions that depend on the aggregate batch budget
are computed from all finalized result sizes in provider order before finish
publication. `ToolBatchCompleted` records call IDs and finish IDs in provider
order, and provider projection uses that order regardless of finish-event
sequence.

Search and retrieval use separate read-only SQLite connections. WAL permits
them while the writer commits. Each request captures a projection sequence and
SQLite read transaction. It either returns a single-snapshot result or
`HISTORY_SEARCH_CURSOR_STALE`; it never combines rows from two projection
versions.

A cancellation token is checked:

- Before expensive canonicalization, preview generation, regex scans, FTS page
  reads, and each 256 KiB artifact decode chunk.
- Between SQLite transactions, never by abandoning a transaction midway.
- Before event append. Once append begins, fsync completes before cancellation
  is returned.

Cancellation returns `HISTORY_CANCELLED` and is not logged as a storage error.
SQLite busy retries obey the 5000 ms total timeout and cancellation token.

## 13. Error codes

Storage APIs return a stable internal code, message, retryability, and structured
detail. `RUST_V2_PROTOCOL_SPEC.md` Appendix A is the normative mapping from each
code below to canonical class, boundary status/code, retryability, and IPC
wrapper. Internal `HISTORY_*`, canonical `E_*`, tool `TOOL_*`, and IPC `IPC_*`
strings are intentionally different namespaces and MUST NOT be passed through
as if they were identical.

| Code | Meaning | Retryable |
|---|---|---|
| `HISTORY_CANCELLED` | Caller cancelled before completion | Yes |
| `HISTORY_SESSION_LOCKED` | Another mutating owner holds the session | Yes |
| `HISTORY_INSECURE_PERMISSIONS` | Private file policy could not be established | No |
| `HISTORY_META_MISMATCH` | Manifest and session event disagree | No |
| `HISTORY_SCHEMA_UNSUPPORTED` | Event or database schema is newer/unknown | No |
| `HISTORY_EVENT_INTEGRITY` | Non-tail JSONL corruption, gap, duplicate, or invalid transition | No |
| `HISTORY_SQLITE_BUSY` | Busy timeout expired | Yes |
| `HISTORY_SQLITE_PRAGMA_FAILED` | Required SQLite behavior unavailable | No |
| `HISTORY_CANONICAL_DB_CORRUPT` | Artifact canonical data cannot be trusted | No |
| `HISTORY_DANGLING_ARTIFACT` | Durable event reference does not resolve | No |
| `HISTORY_ARTIFACT_NOT_FOUND` | Artifact ID is absent or not visible | No |
| `HISTORY_ARTIFACT_RANGE` | Requested line/range/selector is invalid | No |
| `HISTORY_ARTIFACT_TOO_LARGE` | Unbounded response exceeds safe return size | Yes |
| `HISTORY_PREVIEW_BOUND` | Fixed artifact metadata cannot fit preview budget | No in current policy |
| `HISTORY_JSON_POINTER` | Pointer is invalid or does not resolve | No |
| `HISTORY_REGEX_INVALID` | Regex cannot compile | No |
| `HISTORY_REGEX_UNSUPPORTED` | Regex requests unsupported semantics | No |
| `HISTORY_SEARCH_QUERY` | Exact/FTS query or filter is invalid | No |
| `HISTORY_SEARCH_CURSOR_STALE` | Search projection changed after cursor issue | Yes |
| `HISTORY_ROLLBACK_CONFLICT` | Workspace target changed after journaled replacement; safe rollback cannot be proved | No |
| `HISTORY_OPERATIONAL_RECOVERY_UNCERTAIN` | Journal/spool owner or process outcome cannot be proved safe | No |
| `HISTORY_IO` | Other filesystem durability failure | Depends on OS error |

Disk-full during artifact commit leaves no artifact row or finish event.
Disk-full during event append may leave a quarantinable partial final record.
The tool is not rerun automatically in either case.

## 14. Retention and deletion

`session.retention_days` and `session.orphan_retention_days` are defined only by
the Config specification. A zero session-retention value means unlimited
closed-session retention. There is no
turn-based or artifact-access-based eviction of referenced bodies. Summary
source events and artifacts remain available after compaction and reset.

Optional retention operates on whole inactive sessions only. A session is
inactive when no owner lock is held and its latest event/meta activity is older
than the retention threshold. Protocol schema 2 deliberately has no terminal
session event.
Automatic deletion MUST NOT delete an open,
locked, pinned, or integrity-failed session.

Whole-session deletion is:

1. Acquire the session writer lock.
2. Create/verify the private `.trash` directory on the same filesystem and
   allocate a `DeletionId`.
3. Complete pending canonical recovery, checkpoint/close SQLite, close event and
   operational file handles, and retain the directory lock through rename.
4. Rename the complete directory atomically to
   `<session.root>/.trash/<session-id>-<deletion-id>` without replacing an
   existing path. This successful rename is the deletion boundary.
5. Fsync both the sessions root and trash directory before acknowledging
   deletion.
6. Release the lock on the renamed directory and remove that trash directory
   recursively. Fsync `.trash` after removal.

Failure after rename leaves a retryable trash entry and no discoverable live
session. Failure before rename leaves the original live session. No canonical
deletion-intent or terminal event exists or is required; a record needed by an
external retention scheduler belongs outside the session directory and is not
conversation history. Secure erasure is not promised on SSDs, copy-on-write
filesystems, or backups. The CLI states this explicitly.

Row-level deletion is limited to unreferenced orphans as specified in section
9.2 and telemetry cleanup. Deleting telemetry never cascades to canonical rows.

## 15. Tests and fault injection

### 15.1 Deterministic fixtures

Commit fixtures for:

- Canonical event JSON bytes and prefix hashes with fixed IDs, clock, and
  sequence.
- `meta.json` and `config.snapshot.json` bytes and matching config digest.
- Canonical redacted result JSON for nested maps, arrays, Unicode, shell
  channels, and all secret detector classes.
- Preview JSON/text for text, JSON, diff, test output, search output, errors, and
  binary metadata. Cases one token below, exactly at, and one token above the
  Config-spec default per-result threshold exercise individual decisions.
- Batch decisions for totals below, equal to, and above the Config-spec default
  aggregate budget, including parallel completion in reverse order.
- Search result JSON for exact, regex, and FTS with every filter.
- SQLite schema SQL and `sqlite_master` shape.

### 15.2 Crash points

The test writer MUST support deterministic process termination immediately
after each point:

1. Session directory create.
2. `config.snapshot.json.tmp` fsync.
3. Config snapshot rename before directory fsync.
4. `meta.json.tmp` fsync.
5. `meta.json` rename before directory fsync.
6. Event bytes write before event fsync.
7. `ToolExecutionStarted` fsync.
8. Blob insert before artifact transaction commit.
9. Artifact transaction commit.
10. `ToolExecutionFinished` write before fsync.
11. `ToolExecutionFinished` fsync before projection transaction.
12. Each derived table update.
13. Projection checkpoint upsert before commit.
14. Compaction event fsync before summary projection.
15. WAL checkpoint.
16. Session-directory deletion rename.

Each fixture resumes in a fresh process. It asserts valid-prefix preservation,
no invented completion, no automatic uncertain side-effect replay, no visible
dangling reference, and idempotent projection replay.

### 15.3 Property and fuzz tests

- Arbitrary byte truncation of the final event record.
- Malformed complete lines at every event position.
- Duplicate and missing sequence/event IDs.
- Random valid attempt/tool/turn state machines projected after every prefix.
- Canonical JSON map insertion order independence.
- UTF-8, CR/LF, long-line, empty-content, CJK, combining-mark, and emoji bodies.
- Line/head/tail ranges against a reference byte implementation.
- Regex context merging and cancellation.
- FTS source-row mapping through insert, update, delete, and rebuild.
- Glob filters with platform-looking paths.
- Secret redaction proving no detector fixture appears in event, artifact,
  preview, FTS, telemetry, or error text.
- Hash collision simulation by injecting a fake digest; unequal bytes must fail
  rather than deduplicate.
- Multiple read clients during writer commits and WAL checkpoints.

### 15.4 Integration tests

- A multi-cycle turn with fragmented parallel tool calls survives restart at
  every durable boundary.
- A 10 MiB middle marker is found by FTS and retrieved by exact line range.
- Identical artifact bytes from two tool calls use one blob and two provenance
  rows/results.
- A retrieval result is never artifactized into a nested artifact.
- Reset hides prior documents by default but audit search still finds them.
- Compaction does not remove event or artifact searchability.
- Corrupt derived FTS and turn rows rebuild to byte-equivalent query results.
- Missing a referenced blob opens degraded/read-only and excludes the protocol
  group.
- A malformed final line is quarantined while all earlier event IDs remain.
- Disk-full, permission-denied, busy-timeout, cancellation, and process-kill
  errors return their documented codes.

## 16. Implementation sequence

1. In Phase 1, implement private session-directory creation, immutable
   `config.snapshot.json` and `meta.json`, matching config digest, writer
   lock, canonical JSON, event append, prefix hashing, and JSONL recovery.
2. In Phase 1, implement the canonical event state validator and accepted-conversation
   projector without SQLite projections.
3. At the start of Phase 3 and before enabling any large-output tool, create the
   exact complete schema in section 5 but implement only the minimal canonical
   artifact blob/reference transaction: schema checks, artifact canonicalization,
    redaction boundary, config-owned per-result/per-batch decisions,
    content-aware preview generation,
   artifact-before-event writes, and exact orphan proof versus uncertain
   recovery. Implement the journal/spool formats and startup recovery before
   enabling multi-file writes or shell. Derived retrieval/search features remain
   inactive.
4. Run artifact, journal/spool, fault-injection, and long-output fixtures before
   enabling Phase 3 tools.
5. In Phase 4, implement retrieval selectors, bounds, cancellation, and line/regex/JSON
   filters.
6. In Phase 4, implement idempotent turn, StateGraph checkpoint, and search
   projections with prefix-hash checkpoints.
7. In Phase 4, implement exact and regex search, then FTS5/BM25 and cursors.
8. In Phase 4, add orphan inspection/GC, derived rebuild,
   canonical integrity diagnosis, and whole-session deletion. Add summary
   projections when Phase 5 compaction is enabled.
9. Add telemetry and skill observations only after behavior does not depend on
   their availability.
10. Run full retrieval/search/StateGraph fixtures before the temporary UI.

## 17. Common implementation mistakes

- Treating SQLite as the ordered event source because it is convenient.
- Writing an artifact reference and then inserting its body.
- Hashing raw unredacted bytes while storing redacted bytes.
- Pairing parallel tool results by completion order or tool name.
- Letting `serde_json::Map` construction order define canonical bytes.
- Updating projection tables before event fsync.
- Replacing full retrieval with a card while reporting `complete = true`.
- Indexing opaque provider reasoning or failed streamed output.
- Evicting referenced artifacts because a turn is old or compacted.
- Running `LIKE` as a Unicode exact-search implementation.
- Making access-count or telemetry write failure affect prompt behavior.
- Rebuilding a missing canonical body from a summary.
- Skipping a malformed non-final event and continuing replay.

## 18. Acceptance criteria

History storage is accepted only when:

1. Canonical event byte fixtures and prefix hashes are identical across Linux,
   macOS, and Windows.
2. Every enumerated crash point in section 15.2 resumes to the exact expected
   valid prefix, and the checked-in property corpus covers every durable boundary.
3. No accepted projection contains a tool result without its accepted tool call
   and complete batch.
4. Every visible artifact reference resolves and verifies SHA-256 before request
   construction.
5. Secret fixtures have zero matches across all persisted session files and
   model-visible previews.
6. Artifact decisions honor the Config-spec default fixture exactly and remain
   independent of parallel completion order.
7. Full and filtered retrieval are byte/line correct and never create a new
   artifact.
8. Exact, regex, and FTS return the unified schema, deterministic order, stable
   source IDs, and executable retrieval instructions.
9. Dropping every derived table and replaying produces equivalent turns,
   summaries, StateGraph checkpoint inputs, and search results.
10. Corrupt canonical artifact data is detected and never silently repaired from
    lossy data.
11. Concurrent readers see one projection snapshot and the writer never exceeds
    the documented busy timeout without a stable error.
12. Referenced source evidence remains searchable after reset and any number of
    compaction epochs.
13. No test or production path requires Cognitive Memory, embeddings, Bun, or a
    global context-engine database.
