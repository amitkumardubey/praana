//! Exact `history_schema_version = 1` database. Search tables are created so the
//! schema matches the owner; this packet does not query or maintain them.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use std::sync::Mutex;

use super::error::{map_ledger, schema_unsupported, ArtifactError};
use super::operation_ledger::{
    apply_pragmas, apply_private_dir_permissions, apply_private_file_permissions,
    apply_private_umask, chmod_wal_shm, create_db_file_no_follow, reject_symlink,
    HISTORY_APPLICATION_ID,
};
use crate::protocol::constants::{
    ARTIFACT_POLICY_VERSION, BUILTIN_TOOL_CATALOG_SCHEMA_VERSION, EVENT_SCHEMA_VERSION,
    PROJECTION_VERSION, PROVIDER_REGISTRY_SCHEMA_VERSION, REDACTION_VERSION,
    SYSTEM_CONTEXT_SCHEMA_VERSION, UI_CONTRACT_SCHEMA_VERSION, UNICODE_UTILITY_VERSION,
};
use crate::token::TOKEN_ESTIMATOR_SCHEMA_VERSION;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
  key                 TEXT PRIMARY KEY NOT NULL,
  value               TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS operation_records (
  operation_id        TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id) = 26),
  ui_contract_schema_version INTEGER NOT NULL CHECK(ui_contract_schema_version = 1),
  operation_kind      TEXT NOT NULL CHECK(operation_kind IN
                      ('session_create','session_resume','session_end',
                       'session_clear','session_new','turn_submit','turn_cancel',
                       'risk_resolve','slash_execute','model_select',
                       'reasoning_set','settings_patch','setup_apply','auth_login',
                       'auth_logout','consent_resolve','shutdown')),
  request_sha256      TEXT NOT NULL CHECK(length(request_sha256) = 64),
  status              TEXT NOT NULL CHECK(status IN
                      ('reserved','succeeded','failed','interrupted')),
  session_id          TEXT CHECK(session_id IS NULL OR length(session_id) = 26),
  planned_effects_json TEXT NOT NULL CHECK(json_valid(planned_effects_json)),
  result_json         TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  result_sha256       TEXT CHECK(result_sha256 IS NULL OR length(result_sha256) = 64),
  first_canonical_sequence INTEGER CHECK(first_canonical_sequence IS NULL OR
                                         first_canonical_sequence > 0),
  terminal_canonical_sequence INTEGER CHECK(terminal_canonical_sequence IS NULL OR
                                            terminal_canonical_sequence >=
                                            first_canonical_sequence),
  created_at_ms       INTEGER NOT NULL,
  finished_at_ms      INTEGER,
  CHECK((status = 'reserved') = (finished_at_ms IS NULL)),
  CHECK((status = 'reserved') = (result_json IS NULL)),
  CHECK((result_json IS NULL) = (result_sha256 IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS operation_records_session_idx
  ON operation_records(session_id, created_at_ms);
CREATE INDEX IF NOT EXISTS operation_records_retention_idx
  ON operation_records(status, finished_at_ms);

CREATE TABLE IF NOT EXISTS artifact_blobs (
  blob_id             TEXT PRIMARY KEY NOT NULL,
  sha256              TEXT NOT NULL UNIQUE
                      CHECK(length(sha256) = 64),
  canonical_result    BLOB NOT NULL,
  byte_count          INTEGER NOT NULL CHECK(byte_count >= 0),
  line_count          INTEGER CHECK(line_count IS NULL OR line_count >= 0),
  estimated_tokens    INTEGER NOT NULL CHECK(estimated_tokens >= 0),
  token_estimator_schema_version INTEGER NOT NULL
                      CHECK(token_estimator_schema_version = 1),
  token_estimator_id  TEXT NOT NULL,
  token_input_sha256  TEXT NOT NULL CHECK(length(token_input_sha256) = 64),
  result_encoding     TEXT NOT NULL CHECK(result_encoding = 'rfc8785-json'),
  redaction_version   TEXT NOT NULL,
  redaction_json      TEXT NOT NULL CHECK(json_valid(redaction_json)),
  created_at_ms       INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS artifacts (
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
  result_media_type           TEXT NOT NULL CHECK(result_media_type =
                              'application/vnd.praana.tool-result+json;version=1'),
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

CREATE INDEX IF NOT EXISTS artifacts_blob_idx ON artifacts(blob_id);
CREATE INDEX IF NOT EXISTS artifacts_turn_idx ON artifacts(turn_id, producing_sequence);
CREATE INDEX IF NOT EXISTS artifacts_tool_idx ON artifacts(tool_name, producing_sequence);
CREATE INDEX IF NOT EXISTS artifacts_path_idx ON artifacts(normalized_path, producing_sequence)
  WHERE normalized_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS turns (
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
  interruption_capsule_json   TEXT
                              CHECK(interruption_capsule_json IS NULL OR
                                    json_valid(interruption_capsule_json)),
  interruption_capsule_sha256 TEXT
                              CHECK(interruption_capsule_sha256 IS NULL OR
                                    length(interruption_capsule_sha256) = 64),
  retired_by_epoch            INTEGER CHECK(retired_by_epoch IS NULL OR retired_by_epoch > 0),
  source_hash                 TEXT CHECK(source_hash IS NULL OR length(source_hash) = 64),
  CHECK((status = 'committed') = (commit_sequence IS NOT NULL)),
  CHECK((status = 'interrupted') = (interruption_capsule_json IS NOT NULL)),
  CHECK((interruption_capsule_json IS NULL) =
        (interruption_capsule_sha256 IS NULL)),
  CHECK(end_sequence IS NULL OR end_sequence >= start_sequence)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS turns_epoch_sequence_idx ON turns(reset_epoch, start_sequence);
CREATE INDEX IF NOT EXISTS turns_retirement_idx ON turns(reset_epoch, retired_by_epoch, start_sequence);

CREATE TABLE IF NOT EXISTS summary_segments (
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

CREATE INDEX IF NOT EXISTS summary_segments_source_idx
  ON summary_segments(reset_epoch, source_start_sequence, source_end_sequence);

CREATE TABLE IF NOT EXISTS projection_checkpoints (
  projection_name             TEXT PRIMARY KEY NOT NULL,
  checkpoint_schema_version   INTEGER NOT NULL CHECK(checkpoint_schema_version > 0),
  applied_through_sequence    INTEGER NOT NULL CHECK(applied_through_sequence >= 0),
  event_prefix_hash           TEXT NOT NULL CHECK(length(event_prefix_hash) = 64),
  payload_json                TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_hash                TEXT NOT NULL CHECK(length(payload_hash) = 64),
  updated_at_ms               INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS search_documents (
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

CREATE INDEX IF NOT EXISTS search_documents_event_idx ON search_documents(event_sequence, source_field);
CREATE INDEX IF NOT EXISTS search_documents_turn_idx ON search_documents(turn_id, event_sequence);
CREATE INDEX IF NOT EXISTS search_documents_artifact_idx ON search_documents(artifact_id);
CREATE INDEX IF NOT EXISTS search_documents_summary_idx ON search_documents(summary_segment_id);
CREATE INDEX IF NOT EXISTS search_documents_filter_idx
  ON search_documents(reset_epoch, source_kind, event_kind, tool_name);
CREATE INDEX IF NOT EXISTS search_documents_path_idx ON search_documents(normalized_path)
  WHERE normalized_path IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  text,
  content='search_documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2 tokenchars ''_./-''',
  prefix='2 3 4'
);

CREATE TABLE IF NOT EXISTS artifact_access (
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

CREATE INDEX IF NOT EXISTS artifact_access_artifact_idx
  ON artifact_access(artifact_id, occurred_at_ms);

CREATE TABLE IF NOT EXISTS telemetry_counters (
  key                         TEXT PRIMARY KEY NOT NULL,
  value                       INTEGER NOT NULL CHECK(value >= 0),
  updated_at_ms               INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS telemetry_samples (
  sample_id                   INTEGER PRIMARY KEY,
  name                        TEXT NOT NULL,
  event_sequence              INTEGER,
  value_integer               INTEGER,
  dimensions_json             TEXT NOT NULL DEFAULT '{}'
                              CHECK(json_valid(dimensions_json)),
  occurred_at_ms              INTEGER NOT NULL,
  CHECK(value_integer IS NOT NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS telemetry_samples_name_idx
  ON telemetry_samples(name, occurred_at_ms);

CREATE TABLE IF NOT EXISTS skill_session_stats (
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
"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PragmaSnapshot {
    pub journal_mode: String,
    pub synchronous: i32,
    pub foreign_keys: i32,
    pub busy_timeout: i32,
}

pub struct HistoryDatabase {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl std::fmt::Debug for HistoryDatabase {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HistoryDatabase")
            .field("path", &self.path)
            .finish()
    }
}

impl HistoryDatabase {
    pub fn open(path: &Path) -> Result<Self, ArtifactError> {
        reject_symlink(path).map_err(map_ledger)?;
        apply_private_umask();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                reject_symlink(parent).map_err(map_ledger)?;
                if !parent.exists() {
                    std::fs::create_dir_all(parent).map_err(|err| {
                        super::error::io_err(format!("create {}: {err}", parent.display()))
                    })?;
                }
                apply_private_dir_permissions(parent).map_err(map_ledger)?;
            }
        }
        reject_symlink(path).map_err(map_ledger)?;
        let preexisting = path.is_file();
        create_db_file_no_follow(path).map_err(map_ledger)?;
        apply_private_file_permissions(path).map_err(map_ledger)?;
        let conn = Connection::open(path)
            .map_err(|err| super::error::io_err(format!("open {}: {err}", path.display())))?;
        apply_pragmas(&conn, path).map_err(map_ledger)?;
        let application_id: i32 = pragma_i32(&conn, "application_id")?;
        let user_version: i32 = pragma_i32(&conn, "user_version")?;
        if user_version != 0 && user_version != 1 {
            return Err(schema_unsupported(format!("user_version {user_version}")));
        }
        if application_id != 0 && application_id != HISTORY_APPLICATION_ID {
            return Err(schema_unsupported(format!(
                "application_id {application_id}"
            )));
        }
        let fresh = !preexisting
            || (user_version == 0 && application_id == 0 && !table_exists(&conn, "schema_meta")?);
        if fresh {
            conn.execute_batch(&format!(
                "PRAGMA application_id = {HISTORY_APPLICATION_ID}; PRAGMA user_version = 1;"
            ))
            .map_err(|err| super::error::io_err(format!("schema version: {err}")))?;
            if !fts5_available(&conn)? {
                return Err(ArtifactError::new(
                    "HISTORY_SQLITE_PRAGMA_FAILED",
                    "FTS5 is unavailable",
                ));
            }
            conn.execute_batch(SCHEMA_SQL)
                .map_err(|err| super::error::io_err(format!("schema: {err}")))?;
            insert_schema_meta(&conn)?;
        } else if let Some(version) = meta_value(&conn, "history_schema_version")? {
            if version != "1" {
                return Err(schema_unsupported(format!(
                    "history_schema_version {version}"
                )));
            }
            // A P1C ledger may already own schema_meta and operation_records at
            // version 1. Creating the remaining tables is schema completion.
            if !table_exists(&conn, "artifacts")? {
                conn.execute_batch(SCHEMA_SQL)
                    .map_err(|err| super::error::io_err(format!("schema: {err}")))?;
                insert_schema_meta(&conn)?;
            }
        }
        let busy: i32 = pragma_i32(&conn, "busy_timeout")?;
        if busy != 5000 {
            return Err(ArtifactError::new(
                "HISTORY_SQLITE_PRAGMA_FAILED",
                format!("busy_timeout {busy}"),
            ));
        }
        apply_private_file_permissions(path).map_err(map_ledger)?;
        chmod_wal_shm(path).map_err(map_ledger)?;
        assert_canonical_integrity(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn pragma_snapshot(&self) -> Result<PragmaSnapshot, ArtifactError> {
        let conn = self.lock();
        Ok(PragmaSnapshot {
            journal_mode: pragma_string(&conn, "journal_mode")?,
            synchronous: pragma_i32(&conn, "synchronous")?,
            foreign_keys: pragma_i32(&conn, "foreign_keys")?,
            busy_timeout: pragma_i32(&conn, "busy_timeout")?,
        })
    }

    pub fn table_names(&self) -> Result<Vec<String>, ArtifactError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table'
                   AND name NOT LIKE 'sqlite_%'
                   AND name NOT LIKE 'search_fts\\_%' ESCAPE '\\'
                 ORDER BY name",
            )
            .map_err(|err| super::error::io_err(err.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|err| super::error::io_err(err.to_string()))?;
        let mut names = Vec::new();
        for row in rows {
            names.push(row.map_err(|err| super::error::io_err(err.to_string()))?);
        }
        Ok(names)
    }

    pub fn column_names(&self, table: &str) -> Result<Vec<String>, ArtifactError> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|err| super::error::io_err(err.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|err| super::error::io_err(err.to_string()))?;
        let mut names = Vec::new();
        for row in rows {
            names.push(row.map_err(|err| super::error::io_err(err.to_string()))?);
        }
        Ok(names)
    }

    pub fn user_version(&self) -> Result<i32, ArtifactError> {
        pragma_i32(&self.lock(), "user_version")
    }

    pub fn application_id(&self) -> Result<i32, ArtifactError> {
        pragma_i32(&self.lock(), "application_id")
    }

    pub fn schema_meta(&self, key: &str) -> Result<Option<String>, ArtifactError> {
        meta_value(&self.lock(), key)
    }

    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }
}

fn pragma_i32(conn: &Connection, name: &str) -> Result<i32, ArtifactError> {
    conn.query_row(&format!("PRAGMA {name};"), [], |row| row.get(0))
        .map_err(|err| super::error::io_err(format!("pragma {name}: {err}")))
}

fn pragma_string(conn: &Connection, name: &str) -> Result<String, ArtifactError> {
    conn.query_row(&format!("PRAGMA {name};"), [], |row| row.get(0))
        .map_err(|err| super::error::io_err(format!("pragma {name}: {err}")))
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, ArtifactError> {
    let found: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| super::error::io_err(err.to_string()))?;
    Ok(found.is_some())
}

fn meta_value(conn: &Connection, key: &str) -> Result<Option<String>, ArtifactError> {
    if !table_exists(conn, "schema_meta")? {
        return Ok(None);
    }
    conn.query_row(
        "SELECT value FROM schema_meta WHERE key = ?1",
        [key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| super::error::io_err(err.to_string()))
}

fn fts5_available(conn: &Connection) -> Result<bool, ArtifactError> {
    match conn.execute_batch(
        "CREATE VIRTUAL TABLE temp.praana_fts5_probe USING fts5(text); DROP TABLE temp.praana_fts5_probe;",
    ) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

fn insert_schema_meta(conn: &Connection) -> Result<(), ArtifactError> {
    let rows = [
        ("history_schema_version", "1"),
        ("event_schema_version", &EVENT_SCHEMA_VERSION.to_string()),
        ("projection_version", PROJECTION_VERSION),
        ("artifact_policy_version", ARTIFACT_POLICY_VERSION),
        ("redaction_version", REDACTION_VERSION),
        (
            "token_estimator_schema_version",
            &TOKEN_ESTIMATOR_SCHEMA_VERSION.to_string(),
        ),
        ("unicode_utility_version", UNICODE_UTILITY_VERSION),
        (
            "system_context_schema_version",
            &SYSTEM_CONTEXT_SCHEMA_VERSION.to_string(),
        ),
        (
            "provider_registry_schema_version",
            &PROVIDER_REGISTRY_SCHEMA_VERSION.to_string(),
        ),
        (
            "builtin_tool_catalog_schema_version",
            &BUILTIN_TOOL_CATALOG_SCHEMA_VERSION.to_string(),
        ),
        (
            "ui_contract_schema_version",
            &UI_CONTRACT_SCHEMA_VERSION.to_string(),
        ),
    ];
    for (key, value) in rows {
        conn.execute(
            "INSERT OR IGNORE INTO schema_meta(key, value) VALUES (?1, ?2)",
            [key, value],
        )
        .map_err(|err| super::error::io_err(format!("schema_meta {key}: {err}")))?;
    }
    Ok(())
}

fn assert_canonical_integrity(conn: &Connection) -> Result<(), ArtifactError> {
    let rows = conn
        .prepare("PRAGMA quick_check")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| {
            ArtifactError::new(
                "HISTORY_CANONICAL_DB_CORRUPT",
                "quick_check could not be read",
            )
        })?;
    if rows != ["ok"] {
        return Err(ArtifactError::new(
            "HISTORY_CANONICAL_DB_CORRUPT",
            "quick_check failed",
        ));
    }
    let foreign = conn
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| {
            ArtifactError::new(
                "HISTORY_CANONICAL_DB_CORRUPT",
                "foreign_key_check could not be read",
            )
        })?;
    if !foreign.is_empty() {
        return Err(ArtifactError::new(
            "HISTORY_CANONICAL_DB_CORRUPT",
            "foreign_key_check failed",
        ));
    }
    Ok(())
}
