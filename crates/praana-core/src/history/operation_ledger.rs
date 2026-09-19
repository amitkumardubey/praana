//! Session- and host-scoped durable operation ledgers.
//!
//! History owns two physical ledgers with an identical `operation_records`
//! table: session-scoped records in `history.db` and host-scoped
//! create/setup/auth/settings/shutdown records in
//! `<PRAANA_HOME>/ui-operations.db`. Every read-write connection applies and
//! verifies the section 5.1 pragmas with FULL synchronization. Journal files
//! use private permissions and are removed plus directory-fsynced only after
//! terminal record durability.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::protocol::id::{EventId, SessionId};
use crate::ui_contract::command::CoreCommand;
use crate::ui_contract::ids::OperationId;
use crate::ui_contract::json_data::{ProviderId, Sha256Digest};
use crate::ui_contract::operation::{
    canonical_request_hash, operation_kind_for_command, validate_command_fields, OperationKind,
    OperationLedgerRef, OperationRecordDto, OperationRecoveryError, OperationReservation,
    OperationResultRef, OperationStatus, PlannedEffectRef, StoredTerminalResult,
};
use crate::ui_contract::result::{
    CoreCommandSuccess, CoreErrorCode, CoreErrorDto, ErrorDetailsDto, ErrorRetryAdvice,
    SystemNoticeDto,
};
use crate::ui_contract::setup::{
    AuthLoginResultDto, AuthLogoutResultDto, AuthState, ConsentResolvedResultDto,
    SetupApplyResultDto,
};

pub const HISTORY_APPLICATION_ID: i32 = 1_347_567_937;
pub const HOST_APPLICATION_ID: i32 = 1_347_567_945;
pub const OPERATION_SCHEMA_VERSION: i32 = 1;
pub const HOST_PRUNE_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;

const OPERATION_RECORDS_DDL: &str = r#"
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
) STRICT, WITHOUT ROWID"#;

const OPERATION_RECORDS_INDEXES: &[&str] = &[
    "CREATE INDEX IF NOT EXISTS operation_records_session_idx ON operation_records(session_id, created_at_ms)",
    "CREATE INDEX IF NOT EXISTS operation_records_retention_idx ON operation_records(status, finished_at_ms)",
];

const SCHEMA_META_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
  key                 TEXT PRIMARY KEY NOT NULL,
  value               TEXT NOT NULL
) STRICT, WITHOUT ROWID"#;

const EFFECTIVE_SETTINGS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS effective_settings (
  singleton           INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
  revision            INTEGER NOT NULL CHECK(revision >= 0),
  settings_json       TEXT NOT NULL CHECK(json_valid(settings_json)),
  settings_sha256     TEXT NOT NULL CHECK(length(settings_sha256) = 64),
  updated_at_ms       INTEGER NOT NULL
) STRICT, WITHOUT ROWID"#;

const HOST_REVISIONS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS host_revisions (
  state_kind          TEXT PRIMARY KEY NOT NULL CHECK(state_kind IN
                      ('credentials','setup_config','consent')),
  revision            INTEGER NOT NULL CHECK(revision >= 0),
  state_sha256        TEXT NOT NULL CHECK(length(state_sha256) = 64),
  updated_at_ms       INTEGER NOT NULL
) STRICT, WITHOUT ROWID"#;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LedgerError {
    Open(String),
    Corrupt(String),
    Storage(String),
}

impl std::fmt::Display for LedgerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LedgerError::Open(msg) => write!(f, "open ledger: {msg}"),
            LedgerError::Corrupt(msg) => write!(f, "HISTORY_OPERATION_LEDGER_CORRUPT: {msg}"),
            LedgerError::Storage(msg) => write!(f, "ledger storage: {msg}"),
        }
    }
}

impl std::error::Error for LedgerError {}

impl From<LedgerError> for CoreErrorDto {
    fn from(error: LedgerError) -> Self {
        match error {
            LedgerError::Corrupt(msg) => CoreErrorDto {
                code: CoreErrorCode::IntegrityFailed,
                message: "operation ledger is corrupt".to_string(),
                retry: ErrorRetryAdvice::Never,
                details: ErrorDetailsDto::Domain {
                    domain: "history".to_string(),
                    code: msg,
                },
            },
            LedgerError::Open(msg) | LedgerError::Storage(msg) => CoreErrorDto {
                code: CoreErrorCode::DurabilityFailed,
                message: "operation ledger unavailable".to_string(),
                retry: ErrorRetryAdvice::SameOperation,
                details: ErrorDetailsDto::Domain {
                    domain: "history".to_string(),
                    code: msg,
                },
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LedgerScope {
    Session { session_id: SessionId },
    Host,
}

/// History-owned operation ledger handle.
pub struct OperationLedger {
    conn: Mutex<Connection>,
    scope: LedgerScope,
    db_path: PathBuf,
}

impl OperationLedger {
    pub fn scope(&self) -> &LedgerScope {
        &self.scope
    }

    pub fn ledger_ref(
        &self,
        operation_id: OperationId,
        result_sha256: Sha256Digest,
    ) -> OperationResultRef {
        let ledger = match &self.scope {
            LedgerScope::Session { session_id } => OperationLedgerRef::Session {
                session_id: *session_id,
            },
            LedgerScope::Host => OperationLedgerRef::Host,
        };
        OperationResultRef {
            ledger,
            operation_id,
            ui_contract_schema_version: crate::ui_contract::UI_CONTRACT_SCHEMA_VERSION,
            result_sha256,
        }
    }
}

fn insecure_permissions(detail: &str) -> LedgerError {
    LedgerError::Open(format!("HISTORY_INSECURE_PERMISSIONS: {detail}"))
}

fn reject_symlink(path: &Path) -> Result<(), LedgerError> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(insecure_permissions(&format!(
                "symlink at {}",
                path.display()
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn apply_private_umask() {
    unsafe {
        libc::umask(0o077);
    }
}

#[cfg(not(unix))]
fn apply_private_umask() {}

/// Verify or tighten an existing path to the exact private mode. Never widens
/// a mode. On non-Unix platforms private ACLs cannot be established here, so
/// creation fails closed with `HISTORY_INSECURE_PERMISSIONS`.
#[cfg(unix)]
fn establish_private_mode(path: &Path, mode: u32) -> Result<(), LedgerError> {
    use std::os::unix::fs::PermissionsExt;
    let actual = std::fs::symlink_metadata(path)
        .map_err(|_| insecure_permissions(&format!("stat {}", path.display())))?
        .permissions()
        .mode()
        & 0o777;
    if actual == mode {
        return Ok(());
    }
    let extra = actual & !mode;
    let missing = mode & !actual;
    if extra != 0 && missing == 0 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|_| insecure_permissions(&format!("chmod {}", path.display())))?;
        let after = std::fs::symlink_metadata(path)
            .map_err(|_| insecure_permissions(&format!("stat {}", path.display())))?
            .permissions()
            .mode()
            & 0o777;
        if after != mode {
            return Err(insecure_permissions(&format!(
                "chmod failed for {}",
                path.display()
            )));
        }
        return Ok(());
    }
    Err(insecure_permissions(&format!(
        "mode {actual:o} for {}",
        path.display()
    )))
}

#[cfg(not(unix))]
fn establish_private_mode(path: &Path, _mode: u32) -> Result<(), LedgerError> {
    Err(insecure_permissions(&format!(
        "private ACL unavailable for {}",
        path.display()
    )))
}

fn apply_private_file_permissions(path: &Path) -> Result<(), LedgerError> {
    establish_private_mode(path, 0o600)
}

fn apply_private_dir_permissions(path: &Path) -> Result<(), LedgerError> {
    establish_private_mode(path, 0o700)
}

/// Pre-create a database file with no-follow semantics so a symlinked path
/// can never be opened as the ledger. Existing regular files are reused.
#[cfg(unix)]
fn create_db_file_no_follow(path: &Path) -> Result<(), LedgerError> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| {
            LedgerError::Open(format!("create {} with O_NOFOLLOW: {e}", path.display()))
        })?;
    Ok(())
}

#[cfg(not(unix))]
fn create_db_file_no_follow(path: &Path) -> Result<(), LedgerError> {
    if !path.exists() {
        std::fs::write(path, [])
            .map_err(|e| LedgerError::Open(format!("create {}: {e}", path.display())))?;
    }
    Ok(())
}

/// chmod WAL/SHM sidecars when present. Creation mode is governed by the
/// process umask (0077 on Unix); this covers sidecars that predate us.
fn chmod_wal_shm(path: &Path) -> Result<(), LedgerError> {
    let stem = path.to_string_lossy().into_owned();
    for suffix in ["-wal", "-shm"] {
        let sidecar = Path::new(&format!("{stem}{suffix}")).to_path_buf();
        if sidecar.exists() {
            apply_private_file_permissions(&sidecar)?;
        }
    }
    Ok(())
}

/// fsync a directory so journal renames/removals are durable.
pub fn fsync_dir(path: &Path) -> Result<(), LedgerError> {
    #[cfg(unix)]
    {
        let file = std::fs::File::open(path)
            .map_err(|e| LedgerError::Storage(format!("open dir {}: {e}", path.display())))?;
        file.sync_all()
            .map_err(|e| LedgerError::Storage(format!("fsync dir {}: {e}", path.display())))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

pub fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn open_connection(path: &Path, application_id: i32) -> Result<Connection, LedgerError> {
    reject_symlink(path)?;
    apply_private_umask();
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            reject_symlink(parent)?;
            std::fs::create_dir_all(parent)
                .map_err(|e| LedgerError::Open(format!("create dir {}: {e}", parent.display())))?;
            apply_private_dir_permissions(parent)?;
        }
    }
    reject_symlink(path)?;
    create_db_file_no_follow(path)?;
    apply_private_file_permissions(path)?;
    let conn = Connection::open(path)
        .map_err(|e| LedgerError::Open(format!("open {}: {e}", path.display())))?;
    apply_pragmas(&conn, path)?;
    conn.execute_batch(&format!("PRAGMA application_id = {application_id};"))
        .map_err(|e| LedgerError::Open(format!("application_id: {e}")))?;
    conn.execute_batch(&format!(
        "PRAGMA user_version = {OPERATION_SCHEMA_VERSION};"
    ))
    .map_err(|e| LedgerError::Open(format!("user_version: {e}")))?;
    apply_private_file_permissions(path)?;
    chmod_wal_shm(path)?;
    Ok(conn)
}

fn apply_pragmas(conn: &Connection, path: &Path) -> Result<(), LedgerError> {
    let fail = |what: &str| LedgerError::Open(format!("HISTORY_SQLITE_PRAGMA_FAILED {what}"));
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA wal_autocheckpoint = 1000;
         PRAGMA journal_size_limit = 67108864;
         PRAGMA temp_store = MEMORY;
         PRAGMA trusted_schema = OFF;
         PRAGMA recursive_triggers = OFF;",
    )
    .map_err(|e| LedgerError::Open(format!("{}: {e}", path.display())))?;
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
        .map_err(|_| fail("journal_mode"))?;
    if journal_mode.to_lowercase() != "wal" {
        return Err(fail("journal_mode"));
    }
    let synchronous: i32 = conn
        .query_row("PRAGMA synchronous;", [], |row| row.get(0))
        .map_err(|_| fail("synchronous"))?;
    if synchronous != 2 {
        return Err(fail("synchronous"));
    }
    let foreign_keys: i32 = conn
        .query_row("PRAGMA foreign_keys;", [], |row| row.get(0))
        .map_err(|_| fail("foreign_keys"))?;
    if foreign_keys != 1 {
        return Err(fail("foreign_keys"));
    }
    Ok(())
}

fn create_common_schema(conn: &Connection) -> Result<(), LedgerError> {
    conn.execute_batch(SCHEMA_META_DDL)
        .map_err(|e| LedgerError::Open(format!("schema_meta: {e}")))?;
    conn.execute_batch(OPERATION_RECORDS_DDL)
        .map_err(|e| LedgerError::Open(format!("operation_records: {e}")))?;
    for index in OPERATION_RECORDS_INDEXES {
        conn.execute_batch(index)
            .map_err(|e| LedgerError::Open(format!("operation index: {e}")))?;
    }
    Ok(())
}

fn verify_schema_meta(conn: &Connection, expected: &[(&str, &str)]) -> Result<(), LedgerError> {
    for (key, want) in expected {
        let got: Option<String> = conn
            .query_row(
                "SELECT value FROM schema_meta WHERE key = ?1;",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| LedgerError::Corrupt(format!("schema_meta read: {e}")))?;
        match got {
            Some(value) if value == *want => {}
            Some(value) => {
                return Err(LedgerError::Corrupt(format!(
                    "schema_meta {key} = {value:?}, expected {want:?}"
                )));
            }
            None => {
                return Err(LedgerError::Corrupt(format!("schema_meta missing {key}")));
            }
        }
    }
    Ok(())
}

/// Open (or create) the session-scoped operation ledger in `history.db`.
pub fn open_session_ledger(
    path: &Path,
    session_id: SessionId,
) -> Result<OperationLedger, LedgerError> {
    let conn = open_connection(path, HISTORY_APPLICATION_ID)?;
    create_common_schema(&conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('history_schema_version', '1')",
        [],
    )
    .map_err(|e| LedgerError::Open(format!("schema_meta: {e}")))?;
    conn.execute(
        "INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('ui_contract_schema_version', '1')",
        [],
    )
    .map_err(|e| LedgerError::Open(format!("schema_meta: {e}")))?;
    verify_schema_meta(
        &conn,
        &[
            ("history_schema_version", "1"),
            ("ui_contract_schema_version", "1"),
        ],
    )?;
    Ok(OperationLedger {
        conn: Mutex::new(conn),
        scope: LedgerScope::Session { session_id },
        db_path: path.to_path_buf(),
    })
}

/// Open (or create) the host-scoped `<PRAANA_HOME>/ui-operations.db`.
pub fn open_host_ledger(path: &Path) -> Result<OperationLedger, LedgerError> {
    let conn = open_connection(path, HOST_APPLICATION_ID)?;
    create_common_schema(&conn)?;
    conn.execute_batch(EFFECTIVE_SETTINGS_DDL)
        .map_err(|e| LedgerError::Open(format!("effective_settings: {e}")))?;
    conn.execute_batch(HOST_REVISIONS_DDL)
        .map_err(|e| LedgerError::Open(format!("host_revisions: {e}")))?;
    for (key, value) in [
        ("ui_contract_schema_version", "1"),
        ("host_operation_schema_version", "1"),
    ] {
        conn.execute(
            "INSERT OR IGNORE INTO schema_meta(key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| LedgerError::Open(format!("schema_meta: {e}")))?;
    }
    verify_schema_meta(
        &conn,
        &[
            ("ui_contract_schema_version", "1"),
            ("host_operation_schema_version", "1"),
        ],
    )?;
    // Seed revision-0 settings and host revision rows when absent.
    {
        let settings = crate::ui_contract::settings::EffectiveSettingsDto::initial();
        let json = crate::canonical_json::to_canonical_json_string(&settings)
            .map_err(|e| LedgerError::Storage(format!("settings json: {e}")))?;
        let digest = crate::ui_contract::operation::sha256_hex_of(json.as_bytes());
        conn.execute(
            "INSERT OR IGNORE INTO effective_settings(singleton, revision, settings_json, settings_sha256, updated_at_ms) VALUES (1, 0, ?1, ?2, ?3)",
            params![json, digest.as_str(), system_now_ms()],
        )
        .map_err(|e| LedgerError::Storage(format!("seed settings: {e}")))?;
        for kind in ["credentials", "setup_config", "consent"] {
            conn.execute(
                "INSERT OR IGNORE INTO host_revisions(state_kind, revision, state_sha256, updated_at_ms) VALUES (?1, 0, ?2, ?3)",
                params![kind, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", system_now_ms()],
            )
            .map_err(|e| LedgerError::Storage(format!("seed host revision: {e}")))?;
        }
    }
    Ok(OperationLedger {
        conn: Mutex::new(conn),
        scope: LedgerScope::Host,
        db_path: path.to_path_buf(),
    })
}

fn status_from_str(s: &str) -> Result<OperationStatus, LedgerError> {
    match s {
        "reserved" => Ok(OperationStatus::Reserved),
        "succeeded" => Ok(OperationStatus::Succeeded),
        "failed" => Ok(OperationStatus::Failed),
        "interrupted" => Ok(OperationStatus::Interrupted),
        _ => Err(LedgerError::Corrupt(format!("bad status {s:?}"))),
    }
}

/// Stored operation row with validated typed plan and result.
#[derive(Clone, Debug)]
pub struct StoredOperation {
    pub dto: OperationRecordDto,
    pub result_json: Option<String>,
}

/// Raw `operation_records` row columns in select order.
type OperationRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    i64,
    Option<i64>,
);

fn read_operation_row(
    conn: &Connection,
    scope: &LedgerScope,
    operation_id: &OperationId,
) -> Result<Option<StoredOperation>, LedgerError> {
    let row: Option<OperationRow> = conn
        .query_row(
            "SELECT operation_kind, request_sha256, status, session_id, planned_effects_json, result_json, result_sha256, first_canonical_sequence, terminal_canonical_sequence, created_at_ms, finished_at_ms FROM operation_records WHERE operation_id = ?1;",
            params![operation_id.to_string()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                ))
            },
        )
        .optional()
        .map_err(|e| LedgerError::Storage(format!("lookup: {e}")))?;
    let Some((
        kind_str,
        request_sha256,
        status_str,
        session_id,
        planned_effects_json,
        result_json,
        result_sha256,
        first_seq,
        terminal_seq,
        created_at_ms,
        finished_at_ms,
    )) = row
    else {
        return Ok(None);
    };
    let corrupt = |msg: String| LedgerError::Corrupt(msg);
    let kind: OperationKind = serde_json::from_str(&format!("\"{kind_str}\""))
        .map_err(|_| corrupt(format!("bad operation_kind {kind_str:?}")))?;
    let status = status_from_str(&status_str)?;
    let request_sha256 = Sha256Digest::from_hex_str(&request_sha256)
        .map_err(|_| corrupt("bad request_sha256".to_string()))?;
    let session_id: Option<SessionId> = session_id
        .map(|s| {
            crate::protocol::id::SessionId::from_str_canonical(&s)
                .map_err(|_| corrupt("bad session_id".to_string()))
        })
        .transpose()?;
    let planned_effects: Vec<PlannedEffectRef> = serde_json::from_str(&planned_effects_json)
        .map_err(|_| corrupt("bad planned_effects_json".to_string()))?;
    let result_sha256: Option<Sha256Digest> = result_sha256
        .map(|s| {
            Sha256Digest::from_hex_str(&s).map_err(|_| corrupt("bad result_sha256".to_string()))
        })
        .transpose()?;
    if result_json.is_none() != result_sha256.is_none() {
        return Err(corrupt("result_json/result_sha256 mismatch".to_string()));
    }
    if (status == OperationStatus::Reserved) != result_json.is_none() {
        return Err(corrupt("reserved/result presence mismatch".to_string()));
    }
    if let (Some(json), Some(sha)) = (&result_json, &result_sha256) {
        let parsed: serde_json::Value =
            serde_json::from_str(json).map_err(|_| corrupt("bad result_json".to_string()))?;
        let bytes = crate::canonical_json::to_canonical_json_bytes(&parsed)
            .map_err(|_| corrupt("result not canonical".to_string()))?;
        if crate::ui_contract::operation::sha256_hex_of(&bytes) != *sha {
            return Err(corrupt("result_sha256 mismatch".to_string()));
        }
    }
    Ok(Some(StoredOperation {
        dto: OperationRecordDto {
            operation_id: *operation_id,
            kind,
            request_sha256,
            status: status.clone(),
            session_id,
            planned_effects,
            result_ref: terminal_result_ref(scope, operation_id, &status, result_sha256.as_ref()),
            first_canonical_sequence: first_seq.map(|v| v as u64),
            terminal_canonical_sequence: terminal_seq.map(|v| v as u64),
            created_at_ms,
            finished_at_ms,
        },
        result_json,
    }))
}

/// Reconstruct the `OperationResultRef` from the containing ledger scope, row
/// operation ID, schema version, and result digest. Null while reserved;
/// every terminal row yields a non-null reference.
fn terminal_result_ref(
    scope: &LedgerScope,
    operation_id: &OperationId,
    status: &OperationStatus,
    result_sha256: Option<&Sha256Digest>,
) -> Option<OperationResultRef> {
    if *status == OperationStatus::Reserved {
        return None;
    }
    let result_sha256 = result_sha256?.clone();
    let ledger = match scope {
        LedgerScope::Session { session_id } => OperationLedgerRef::Session {
            session_id: *session_id,
        },
        LedgerScope::Host => OperationLedgerRef::Host,
    };
    Some(OperationResultRef {
        ledger,
        operation_id: *operation_id,
        ui_contract_schema_version: crate::ui_contract::UI_CONTRACT_SCHEMA_VERSION,
        result_sha256,
    })
}

impl OperationLedger {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, LedgerError> {
        self.conn
            .lock()
            .map_err(|_| LedgerError::Storage("ledger lock poisoned".to_string()))
    }

    /// Look up one operation by ID. Corrupt rows report
    /// `HISTORY_OPERATION_LEDGER_CORRUPT` and block mutation.
    pub fn lookup(
        &self,
        operation_id: &OperationId,
    ) -> Result<Option<StoredOperation>, LedgerError> {
        let conn = self.lock()?;
        read_operation_row(&conn, &self.scope, operation_id)
    }

    fn insert_reserved_row(
        conn: &Connection,
        dto: &OperationRecordDto,
        planned_effects_json: &str,
    ) -> Result<(), LedgerError> {
        conn.execute(
            "INSERT INTO operation_records(operation_id, ui_contract_schema_version, operation_kind, request_sha256, status, session_id, planned_effects_json, result_json, result_sha256, first_canonical_sequence, terminal_canonical_sequence, created_at_ms, finished_at_ms) VALUES (?1, 1, ?2, ?3, 'reserved', ?4, ?5, NULL, NULL, NULL, NULL, ?6, NULL)",
            params![
                dto.operation_id.to_string(),
                dto.kind.as_str(),
                dto.request_sha256.as_str(),
                dto.session_id.map(|s| s.to_string()),
                planned_effects_json,
                dto.created_at_ms,
            ],
        )
        .map_err(|e| LedgerError::Storage(format!("reserve: {e}")))?;
        Ok(())
    }

    /// All reserved rows, ordered by creation time.
    pub fn list_reserved(&self) -> Result<Vec<StoredOperation>, LedgerError> {
        let conn = self.lock()?;
        let ids: Vec<String> = conn
            .prepare("SELECT operation_id FROM operation_records WHERE status = 'reserved' ORDER BY created_at_ms;")
            .map_err(|e| LedgerError::Storage(format!("list reserved: {e}")))?
            .query_map([], |row| row.get(0))
            .map_err(|e| LedgerError::Storage(format!("list reserved: {e}")))?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| LedgerError::Storage(format!("list reserved: {e}")))?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let operation_id = OperationId::from_canonical_str(&id)
                .map_err(|_| LedgerError::Corrupt(format!("bad stored operation_id {id:?}")))?;
            if let Some(stored) = read_operation_row(&conn, &self.scope, &operation_id)? {
                out.push(stored);
            }
        }
        Ok(out)
    }

    /// Mark a reserved operation interrupted without executing an effect,
    /// storing the terminal `OperationInterrupted` result. The schema
    /// requires every non-reserved row to carry result bytes.
    pub fn mark_interrupted(
        &self,
        operation_id: &OperationId,
        error: &CoreErrorDto,
        finished_at_ms: i64,
    ) -> Result<(), LedgerError> {
        let result_bytes = crate::canonical_json::to_canonical_json_bytes(error)
            .map_err(|e| LedgerError::Storage(format!("result json: {e}")))?;
        let result_json = String::from_utf8(result_bytes.clone())
            .map_err(|e| LedgerError::Storage(format!("result utf8: {e}")))?;
        let result_sha = crate::ui_contract::operation::sha256_hex_of(&result_bytes);
        let conn = self.lock()?;
        let updated = conn
            .execute(
                "UPDATE operation_records SET status = 'interrupted', result_json = ?1, result_sha256 = ?2, finished_at_ms = ?3 WHERE operation_id = ?4 AND status = 'reserved';",
                params![result_json, result_sha.as_str(), finished_at_ms, operation_id.to_string()],
            )
            .map_err(|e| LedgerError::Storage(format!("interrupt: {e}")))?;
        if updated != 1 {
            return Err(LedgerError::Storage(
                "interrupt affected no reserved row".to_string(),
            ));
        }
        Ok(())
    }

    /// Complete a reserved operation with a terminal result in one FULL-sync
    /// transaction. Returns the stored result bytes for the caller.
    pub fn complete_terminal(
        &self,
        operation_id: &OperationId,
        result: &StoredTerminalResult,
        first_seq: Option<u64>,
        terminal_seq: Option<u64>,
        finished_at_ms: i64,
    ) -> Result<String, LedgerError> {
        let (result_json, result_sha256) = match result {
            StoredTerminalResult::Success(success) => {
                let bytes = crate::canonical_json::to_canonical_json_bytes(success)
                    .map_err(|e| LedgerError::Storage(format!("result json: {e}")))?;
                let json = String::from_utf8(bytes.clone())
                    .map_err(|e| LedgerError::Storage(format!("result utf8: {e}")))?;
                (json, crate::ui_contract::operation::sha256_hex_of(&bytes))
            }
            StoredTerminalResult::Error(error) => {
                let bytes = crate::canonical_json::to_canonical_json_bytes(error)
                    .map_err(|e| LedgerError::Storage(format!("result json: {e}")))?;
                let json = String::from_utf8(bytes.clone())
                    .map_err(|e| LedgerError::Storage(format!("result utf8: {e}")))?;
                (json, crate::ui_contract::operation::sha256_hex_of(&bytes))
            }
        };
        if result_json.contains("sk-") || result_json.contains("secret-value") {
            return Err(LedgerError::Corrupt(
                "secret plaintext in result".to_string(),
            ));
        }
        let status = match result {
            StoredTerminalResult::Success(_) => "succeeded",
            StoredTerminalResult::Error(_) => "failed",
        };
        let conn = self.lock()?;
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|e| LedgerError::Storage(format!("begin: {e}")))?;
        let updated = conn
            .execute(
                "UPDATE operation_records SET status = ?1, result_json = ?2, result_sha256 = ?3, first_canonical_sequence = ?4, terminal_canonical_sequence = ?5, finished_at_ms = ?6 WHERE operation_id = ?7 AND status = 'reserved';",
                params![
                    status,
                    result_json,
                    result_sha256.as_str(),
                    first_seq.map(|v| v as i64),
                    terminal_seq.map(|v| v as i64),
                    finished_at_ms,
                    operation_id.to_string(),
                ],
            )
            .map_err(|e| LedgerError::Storage(format!("complete: {e}")))?;
        if updated != 1 {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(LedgerError::Storage(
                "complete affected no reserved row".to_string(),
            ));
        }
        conn.execute_batch("COMMIT;")
            .map_err(|e| LedgerError::Storage(format!("commit: {e}")))?;
        Ok(result_json)
    }
}

// Recovery probes and host services.

/// Rebuilt terminal result for a fully-proven reserved operation.
#[derive(Clone, Debug)]
pub struct RebuiltTerminal {
    pub result: StoredTerminalResult,
    pub first_seq: Option<u64>,
    pub terminal_seq: Option<u64>,
}

/// Inspector for effects owned outside the ledger (canonical event store,
/// host files). Production probes read durable state; tests inject fakes.
pub trait RecoveryProbe: Send + Sync {
    fn canonical_events_exist(&self, session_id: &SessionId, event_ids: &[EventId]) -> Vec<bool>;
    fn rebuild_terminal(&self, record: &StoredOperation) -> Option<RebuiltTerminal>;
}

/// Null probe: proves nothing, rebuilds nothing. Uncertain effects stay
/// interrupted; nothing is guessed or repeated.
pub struct NullRecoveryProbe;

impl RecoveryProbe for NullRecoveryProbe {
    fn canonical_events_exist(&self, _session_id: &SessionId, event_ids: &[EventId]) -> Vec<bool> {
        vec![false; event_ids.len()]
    }

    fn rebuild_terminal(&self, _record: &StoredOperation) -> Option<RebuiltTerminal> {
        None
    }
}

/// Synchronous clock for finish timestamps.
pub type NowMs = Arc<dyn Fn() -> i64 + Send + Sync>;

fn default_now_ms() -> NowMs {
    Arc::new(system_now_ms)
}

pub struct HistoryService {
    pub session_ledger: Option<Arc<OperationLedger>>,
    pub host_ledger: Option<Arc<OperationLedger>>,
    pub session_id: Option<SessionId>,
    pub probe: Arc<dyn RecoveryProbe>,
    pub now_ms: NowMs,
}

impl Default for HistoryService {
    fn default() -> Self {
        Self {
            session_ledger: None,
            host_ledger: None,
            session_id: None,
            probe: Arc::new(NullRecoveryProbe),
            now_ms: default_now_ms(),
        }
    }
}

impl HistoryService {
    pub fn counterpart_of(&self, primary: &OperationLedger) -> Option<Arc<OperationLedger>> {
        match primary.scope() {
            LedgerScope::Host => self.session_ledger.clone(),
            LedgerScope::Session { .. } => self.host_ledger.clone(),
        }
    }
}

/// True for the host-scoped kinds (create/setup/auth/settings/shutdown, plus
/// persisted consent whose revisions are host-owned).
pub fn host_scoped_kind(kind: &OperationKind) -> bool {
    matches!(
        kind,
        OperationKind::SessionCreate
            | OperationKind::SessionNew
            | OperationKind::SettingsPatch
            | OperationKind::SetupApply
            | OperationKind::AuthLogin
            | OperationKind::AuthLogout
            | OperationKind::ConsentResolve
            | OperationKind::Shutdown
    )
}

fn operation_conflict_error(existing_request_sha256: Sha256Digest) -> CoreErrorDto {
    CoreErrorDto {
        code: CoreErrorCode::OperationConflict,
        message: "operation ID already reserved with a different request".to_string(),
        retry: ErrorRetryAdvice::NewOperation,
        details: ErrorDetailsDto::OperationConflict {
            existing_request_sha256,
        },
    }
}

pub(crate) fn operation_interrupted_error() -> CoreErrorDto {
    CoreErrorDto {
        code: CoreErrorCode::OperationInterrupted,
        message: "operation was interrupted and must not be retried with the same ID".to_string(),
        retry: ErrorRetryAdvice::NewOperation,
        details: ErrorDetailsDto::None,
    }
}

/// Build the admission plan for a command, preallocating canonical IDs and
/// target revisions during reservation. `NonReplayableSecretWrite` attaches
/// only when the command actually carries secret input.
fn plan_effects(
    kind: &OperationKind,
    command: &CoreCommand,
    session_id: Option<SessionId>,
) -> Result<(Vec<PlannedEffectRef>, Option<SessionId>), LedgerError> {
    match kind {
        OperationKind::SessionCreate | OperationKind::SessionNew => {
            let new_session = SessionId(ulid::Ulid::generate());
            let started = EventId(ulid::Ulid::generate());
            Ok((
                vec![PlannedEffectRef::NewSession {
                    session_id: new_session,
                    session_started_event_id: started,
                }],
                Some(new_session),
            ))
        }
        OperationKind::TurnSubmit => {
            let session = session_id.ok_or_else(|| {
                LedgerError::Storage("turn_submit requires a session".to_string())
            })?;
            Ok((
                vec![PlannedEffectRef::CanonicalEvents {
                    session_id: session,
                    event_ids: vec![EventId(ulid::Ulid::generate())],
                }],
                Some(session),
            ))
        }
        OperationKind::SetupApply => {
            let secret = match command {
                CoreCommand::SetupApply(apply) => apply.values.values().any(|value| {
                    matches!(value, crate::ui_contract::setup::SetupValueDto::Secret(_))
                }),
                _ => false,
            };
            let mut plan = vec![PlannedEffectRef::CredentialRevision {
                from_revision: 0,
                to_revision: 1,
            }];
            if secret {
                plan.push(PlannedEffectRef::NonReplayableSecretWrite);
            }
            Ok((plan, session_id))
        }
        OperationKind::AuthLogin => {
            let secret = match command {
                CoreCommand::AuthLogin(login) => matches!(
                    login.method,
                    crate::ui_contract::setup::AuthMethodDto::ApiKey { .. }
                ),
                _ => false,
            };
            let mut plan = vec![PlannedEffectRef::CredentialRevision {
                from_revision: 0,
                to_revision: 1,
            }];
            if secret {
                plan.push(PlannedEffectRef::NonReplayableSecretWrite);
            }
            Ok((plan, session_id))
        }
        OperationKind::AuthLogout => Ok((
            vec![PlannedEffectRef::CredentialRevision {
                from_revision: 0,
                to_revision: 1,
            }],
            session_id,
        )),
        OperationKind::ConsentResolve => Ok((
            vec![PlannedEffectRef::ConsentRevision {
                from_revision: 0,
                to_revision: 1,
            }],
            session_id,
        )),
        OperationKind::Shutdown => Ok((vec![PlannedEffectRef::ProcessShutdown], session_id)),
        _ => Ok((Vec::new(), session_id)),
    }
}

/// Reserve a settings patch atomically: the reservation row, the settings
/// update, and the terminal result commit in one `BEGIN IMMEDIATE` FULL-sync
/// transaction. There is no crash window between reservation and the settings
/// write. A revision mismatch returns `SettingsConflict` with the current
/// revision and writes nothing.
fn reserve_settings_atomic(
    ledger: &OperationLedger,
    command: &CoreCommand,
    operation_id: OperationId,
    request_sha256: Sha256Digest,
    history: &HistoryService,
) -> Result<OperationReservation, CoreErrorDto> {
    let (expected_revision, changes) = match command {
        CoreCommand::SettingsPatch(patch) => (patch.expected_revision, &patch.changes),
        _ => {
            return Err(CoreErrorDto::from(LedgerError::Storage(
                "settings path requires a settings command".to_string(),
            )));
        }
    };
    let conn = ledger.lock()?;
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("begin: {e}"))))?;
    let result = reserve_settings_inner(
        &conn,
        operation_id,
        request_sha256,
        expected_revision,
        changes,
        history,
    );
    match result {
        Ok(reservation) => {
            conn.execute_batch("COMMIT;")
                .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("commit: {e}"))))?;
            chmod_wal_shm_for(&ledger.db_path);
            Ok(reservation)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

fn reserve_settings_inner(
    conn: &Connection,
    operation_id: OperationId,
    request_sha256: Sha256Digest,
    expected_revision: u64,
    changes: &crate::ui_contract::settings::SettingsPatchDto,
    history: &HistoryService,
) -> Result<OperationReservation, CoreErrorDto> {
    let current_json: String = conn
        .query_row(
            "SELECT settings_json FROM effective_settings WHERE singleton = 1;",
            [],
            |row| row.get(0),
        )
        .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("read settings: {e}"))))?;
    let current: crate::ui_contract::settings::EffectiveSettingsDto =
        serde_json::from_str(&current_json).map_err(|_| {
            CoreErrorDto::from(LedgerError::Corrupt("bad settings_json".to_string()))
        })?;
    if current.revision != expected_revision {
        return Err(CoreErrorDto {
            code: CoreErrorCode::SettingsConflict,
            message: "settings revision mismatch".to_string(),
            retry: ErrorRetryAdvice::NewOperation,
            details: ErrorDetailsDto::CurrentRevision {
                revision: current.revision,
            },
        });
    }
    let next = current.apply_patch(changes).map_err(|e| CoreErrorDto {
        code: CoreErrorCode::InvalidInput,
        message: format!("settings patch: {e}"),
        retry: ErrorRetryAdvice::Never,
        details: ErrorDetailsDto::None,
    })?;
    let planned_effects = vec![PlannedEffectRef::SettingsRevision {
        from_revision: current.revision,
        to_revision: next.revision,
    }];
    let planned_effects_json = crate::canonical_json::to_canonical_json_string(&planned_effects)
        .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("plan json: {e}"))))?;
    let finished_at_ms = (history.now_ms)();
    let dto = OperationRecordDto {
        operation_id,
        kind: OperationKind::SettingsPatch,
        request_sha256,
        status: OperationStatus::Succeeded,
        session_id: history.session_id,
        planned_effects,
        result_ref: None,
        first_canonical_sequence: None,
        terminal_canonical_sequence: None,
        created_at_ms: finished_at_ms,
        finished_at_ms: Some(finished_at_ms),
    };
    let settings_json = crate::canonical_json::to_canonical_json_string(&next)
        .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("settings json: {e}"))))?;
    let settings_sha = crate::ui_contract::operation::sha256_hex_of(settings_json.as_bytes());
    let next_revision = next.revision;
    let success = CoreCommandSuccess::SettingsPatched(next);
    let result_bytes = crate::canonical_json::to_canonical_json_bytes(&success)
        .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("result json: {e}"))))?;
    let result_json = String::from_utf8(result_bytes.clone())
        .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("result utf8: {e}"))))?;
    let result_sha = crate::ui_contract::operation::sha256_hex_of(&result_bytes);
    OperationLedger::insert_reserved_row(conn, &dto, &planned_effects_json)
        .map_err(CoreErrorDto::from)?;
    let updated = conn
        .execute(
            "UPDATE effective_settings SET revision = ?1, settings_json = ?2, settings_sha256 = ?3, updated_at_ms = ?4 WHERE singleton = 1 AND revision = ?5;",
            params![
                next_revision as i64,
                settings_json,
                settings_sha.as_str(),
                finished_at_ms,
                expected_revision as i64,
            ],
        )
        .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("settings update: {e}"))))?;
    if updated != 1 {
        return Err(CoreErrorDto::from(LedgerError::Storage(
            "settings revision raced".to_string(),
        )));
    }
    let updated = conn
        .execute(
            "UPDATE operation_records SET status = 'succeeded', result_json = ?1, result_sha256 = ?2, finished_at_ms = ?3 WHERE operation_id = ?4 AND status = 'reserved';",
            params![
                result_json,
                result_sha.as_str(),
                finished_at_ms,
                operation_id.to_string(),
            ],
        )
        .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("complete: {e}"))))?;
    if updated != 1 {
        return Err(CoreErrorDto::from(LedgerError::Storage(
            "complete affected no reserved row".to_string(),
        )));
    }
    Ok(OperationReservation::ReplayStored(
        StoredTerminalResult::Success(success),
    ))
}

/// chmod WAL/SHM sidecars for a ledger path when present. Creation mode is
/// governed by the process umask (0077 on Unix); this covers sidecars that
/// predate the current open.
fn chmod_wal_shm_for(db_path: &Path) {
    let _ = chmod_wal_shm(db_path);
}

/// Reserve an operation and its typed plan with FULL synchronization before
/// performing any effect. The plan read and the reserved insert hold one
/// connection lock inside one `BEGIN IMMEDIATE` transaction.
///
/// - Same ID, kind, and request hash with a terminal result: returns the
///   stored result byte-for-byte without another effect.
/// - Same ID, kind, and hash on a `Reserved` row: the reservation is
///   continuable; the caller proceeds to perform the effect and complete it.
///   A crash between reservation and completion is therefore restart-safe
///   under the same operation ID.
/// - Same ID with a different kind or request hash: `OperationConflict`
///   without executing.
/// - `Interrupted` rows report `OperationInterrupted`.
pub async fn reserve_operation(
    ledger: &OperationLedger,
    command: &CoreCommand,
    history: &HistoryService,
) -> Result<OperationReservation, CoreErrorDto> {
    let kind = operation_kind_for_command(command).ok_or_else(|| CoreErrorDto {
        code: CoreErrorCode::InvalidInput,
        message: "read-only commands are not reserved".to_string(),
        retry: ErrorRetryAdvice::Never,
        details: ErrorDetailsDto::None,
    })?;
    validate_command_fields(command)?;
    let operation_id = command.operation_id().ok_or_else(|| CoreErrorDto {
        code: CoreErrorCode::InvalidInput,
        message: "mutating commands require an operation ID".to_string(),
        retry: ErrorRetryAdvice::Never,
        details: ErrorDetailsDto::None,
    })?;
    let request_sha256 = canonical_request_hash(command).map_err(|e| CoreErrorDto {
        code: CoreErrorCode::InvalidInput,
        message: format!("request hash: {e}"),
        retry: ErrorRetryAdvice::Never,
        details: ErrorDetailsDto::None,
    })?;

    if let Some(counterpart) = history.counterpart_of(ledger) {
        if counterpart.lookup(&operation_id)?.is_some() {
            return Err(CoreErrorDto {
                code: CoreErrorCode::IntegrityFailed,
                message: "operation ID present in both ledgers".to_string(),
                retry: ErrorRetryAdvice::Never,
                details: ErrorDetailsDto::Domain {
                    domain: "history".to_string(),
                    code: "HISTORY_OPERATION_LEDGER_CORRUPT".to_string(),
                },
            });
        }
    }

    if let Some(existing) = ledger.lookup(&operation_id)? {
        if existing.dto.kind != kind || existing.dto.request_sha256 != request_sha256 {
            return Err(operation_conflict_error(existing.dto.request_sha256));
        }
        match existing.dto.status {
            OperationStatus::Succeeded | OperationStatus::Failed => {
                let stored = stored_terminal_result(ledger, &existing)?;
                return Ok(OperationReservation::ReplayStored(stored));
            }
            OperationStatus::Interrupted => return Err(operation_interrupted_error()),
            OperationStatus::Reserved => {
                // Continuable reservation: the same operation may proceed to
                // perform its planned effect and complete exactly once.
                return Ok(OperationReservation::Reserved(existing.dto));
            }
        }
    }

    // Settings patches reserve, mutate, and complete atomically (finding 3).
    if kind == OperationKind::SettingsPatch && matches!(ledger.scope(), LedgerScope::Host) {
        return reserve_settings_atomic(ledger, command, operation_id, request_sha256, history);
    }
    if kind == OperationKind::SettingsPatch {
        return Err(CoreErrorDto::from(LedgerError::Storage(
            "settings_patch is host-scoped".to_string(),
        )));
    }

    let session_id = match ledger.scope() {
        LedgerScope::Session { session_id } => Some(*session_id),
        LedgerScope::Host => history.session_id,
    };
    // One lock from plan read through reserved insert and commit, so two
    // concurrent reservations cannot plan from the same revision.
    let conn = ledger.lock()?;
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("begin: {e}"))))?;
    let result = reserve_inner(
        &conn,
        &kind,
        command,
        session_id,
        operation_id,
        request_sha256,
        history,
    );
    match result {
        Ok(reservation) => {
            conn.execute_batch("COMMIT;")
                .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("commit: {e}"))))?;
            chmod_wal_shm_for(&ledger.db_path);
            Ok(reservation)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }
}

fn reserve_inner(
    conn: &Connection,
    kind: &OperationKind,
    command: &CoreCommand,
    session_id: Option<SessionId>,
    operation_id: OperationId,
    request_sha256: Sha256Digest,
    history: &HistoryService,
) -> Result<OperationReservation, CoreErrorDto> {
    let (planned_effects, record_session) =
        plan_effects(kind, command, session_id).map_err(CoreErrorDto::from)?;
    let planned_effects_json = crate::canonical_json::to_canonical_json_string(&planned_effects)
        .map_err(|e| CoreErrorDto::from(LedgerError::Storage(format!("plan json: {e}"))))?;
    if planned_effects_json.contains("sk-") {
        return Err(CoreErrorDto::from(LedgerError::Corrupt(
            "secret plaintext in plan".to_string(),
        )));
    }
    let dto = OperationRecordDto {
        operation_id,
        kind: kind.clone(),
        request_sha256,
        status: OperationStatus::Reserved,
        session_id: record_session,
        planned_effects,
        result_ref: None,
        first_canonical_sequence: None,
        terminal_canonical_sequence: None,
        created_at_ms: (history.now_ms)(),
        finished_at_ms: None,
    };
    OperationLedger::insert_reserved_row(conn, &dto, &planned_effects_json)
        .map_err(CoreErrorDto::from)?;
    Ok(OperationReservation::Reserved(dto))
}

fn stored_terminal_result(
    ledger: &OperationLedger,
    stored: &StoredOperation,
) -> Result<StoredTerminalResult, CoreErrorDto> {
    let json = stored.result_json.clone().ok_or_else(|| {
        CoreErrorDto::from(LedgerError::Corrupt(
            "terminal row without result".to_string(),
        ))
    })?;
    match stored.dto.status {
        OperationStatus::Succeeded => {
            let success: CoreCommandSuccess = serde_json::from_str(&json).map_err(|_| {
                CoreErrorDto::from(LedgerError::Corrupt("bad success result".to_string()))
            })?;
            let _ = ledger;
            Ok(StoredTerminalResult::Success(success))
        }
        OperationStatus::Failed => {
            let error: CoreErrorDto = serde_json::from_str(&json).map_err(|_| {
                CoreErrorDto::from(LedgerError::Corrupt("bad error result".to_string()))
            })?;
            Ok(StoredTerminalResult::Error(error))
        }
        _ => Err(CoreErrorDto::from(LedgerError::Corrupt(
            "non-terminal replay".to_string(),
        ))),
    }
}

/// Persist the exact successful or terminal-error result bytes and hashes
/// before returning.
pub fn complete_operation(
    ledger: &OperationLedger,
    record: &OperationRecordDto,
    result: Result<CoreCommandSuccess, CoreErrorDto>,
) -> Result<(), CoreErrorDto> {
    let (stored, first_seq, terminal_seq) = match result {
        Ok(success) => (StoredTerminalResult::Success(success), None, None),
        Err(error) => (StoredTerminalResult::Error(error), None, None),
    };
    let now = system_now_ms();
    ledger
        .complete_terminal(&record.operation_id, &stored, first_seq, terminal_seq, now)
        .map_err(CoreErrorDto::from)?;
    Ok(())
}

/// Recover reserved operations after a restart.
///
/// - All effects provably present plus a rebuildable result: `Succeeded`.
/// - No effects present and the plan has no `NonReplayableSecretWrite`:
///   left `Reserved` for a same-ID retry.
/// - Partial, inconsistent, secret-bearing, or otherwise uncertain effects:
///   `Interrupted`; never guessed or repeated.
/// - Reserved risk approvals become interrupted/denied after process loss.
pub async fn recover_reserved_operations(
    ledger: &OperationLedger,
    history: &HistoryService,
) -> Result<Vec<SystemNoticeDto>, OperationRecoveryError> {
    let reserved = ledger
        .list_reserved()
        .map_err(|e| OperationRecoveryError::Storage(e.to_string()))?;
    let mut notices = Vec::new();
    for stored in reserved {
        let notice = recover_one(ledger, history, &stored).await?;
        notices.push(notice);
    }
    Ok(notices)
}

async fn recover_one(
    ledger: &OperationLedger,
    history: &HistoryService,
    stored: &StoredOperation,
) -> Result<SystemNoticeDto, OperationRecoveryError> {
    let finished_at_ms = (history.now_ms)();
    let notice_base = SystemNoticeDto {
        notice_id: crate::ui_contract::ids::NoticeId(ulid::Ulid::generate()),
        code: "operation-recovery".to_string(),
        tone: crate::ui_contract::result::NoticeTone::Warning,
        title: "Operation recovery".to_string(),
        message: format!("operation {}", stored.dto.operation_id),
        persistence: crate::ui_contract::result::NoticePersistence::Transient,
    };
    // Reserved risk approval is never restored after process loss.
    if stored.dto.kind == OperationKind::RiskResolve {
        ledger
            .mark_interrupted(
                &stored.dto.operation_id,
                &operation_interrupted_error(),
                finished_at_ms,
            )
            .map_err(|e| OperationRecoveryError::Storage(e.to_string()))?;
        return Ok(SystemNoticeDto {
            message: format!(
                "risk operation {} interrupted after process loss",
                stored.dto.operation_id
            ),
            ..notice_base
        });
    }
    if stored.dto.planned_effects.is_empty() {
        // Nothing provable; leave reserved for a same-ID retry.
        return Ok(SystemNoticeDto {
            tone: crate::ui_contract::result::NoticeTone::Info,
            message: format!("operation {} still reserved", stored.dto.operation_id),
            ..notice_base
        });
    }
    if stored
        .dto
        .planned_effects
        .iter()
        .any(|e| matches!(e, PlannedEffectRef::ProcessShutdown))
    {
        // Never auto-shutdown during recovery; the running process proves the
        // effect did not complete.
        ledger
            .mark_interrupted(
                &stored.dto.operation_id,
                &operation_interrupted_error(),
                finished_at_ms,
            )
            .map_err(|e| OperationRecoveryError::Storage(e.to_string()))?;
        return Ok(SystemNoticeDto {
            message: format!("shutdown operation {} interrupted", stored.dto.operation_id),
            ..notice_base
        });
    }
    // Canonical event presence per preallocated plan.
    let mut all_present = true;
    let mut none_present = true;
    for effect in &stored.dto.planned_effects {
        if let PlannedEffectRef::CanonicalEvents {
            session_id,
            event_ids,
        } = effect
        {
            let presence = history.probe.canonical_events_exist(session_id, event_ids);
            for present in presence {
                all_present &= present;
                none_present &= !present;
            }
        } else if let PlannedEffectRef::NewSession { .. } = effect {
            // New sessions are proven via the session manifest, which the null
            // probe cannot confirm; treat as absent.
            all_present = false;
        } else if matches!(
            effect,
            PlannedEffectRef::SettingsRevision { .. }
                | PlannedEffectRef::CredentialRevision { .. }
                | PlannedEffectRef::ConsentRevision { .. }
        ) {
            all_present = false;
        }
    }
    let has_secret = stored
        .dto
        .planned_effects
        .iter()
        .any(|e| matches!(e, PlannedEffectRef::NonReplayableSecretWrite));
    if all_present {
        if let Some(rebuilt) = history.probe.rebuild_terminal(stored) {
            ledger
                .complete_terminal(
                    &stored.dto.operation_id,
                    &match rebuilt.result {
                        StoredTerminalResult::Success(s) => StoredTerminalResult::Success(s),
                        StoredTerminalResult::Error(e) => StoredTerminalResult::Error(e),
                    },
                    rebuilt.first_seq,
                    rebuilt.terminal_seq,
                    finished_at_ms,
                )
                .map_err(|e| OperationRecoveryError::Storage(e.to_string()))?;
            return Ok(SystemNoticeDto {
                tone: crate::ui_contract::result::NoticeTone::Success,
                message: format!(
                    "operation {} recovered as succeeded",
                    stored.dto.operation_id
                ),
                ..notice_base
            });
        }
        ledger
            .mark_interrupted(
                &stored.dto.operation_id,
                &operation_interrupted_error(),
                finished_at_ms,
            )
            .map_err(|e| OperationRecoveryError::Storage(e.to_string()))?;
        return Ok(SystemNoticeDto {
            message: format!(
                "operation {} interrupted: effects present but result not rebuildable",
                stored.dto.operation_id
            ),
            ..notice_base
        });
    }
    if none_present && !has_secret {
        return Ok(SystemNoticeDto {
            tone: crate::ui_contract::result::NoticeTone::Info,
            message: format!("operation {} still reserved", stored.dto.operation_id),
            ..notice_base
        });
    }
    ledger
        .mark_interrupted(
            &stored.dto.operation_id,
            &operation_interrupted_error(),
            finished_at_ms,
        )
        .map_err(|e| OperationRecoveryError::Storage(e.to_string()))?;
    Ok(SystemNoticeDto {
        message: format!(
            "operation {} interrupted: uncertain effects",
            stored.dto.operation_id
        ),
        ..notice_base
    })
}

// Host settings, revisions, journals, and retention.

/// Read the current effective host settings.
pub fn get_effective_settings(
    ledger: &OperationLedger,
) -> Result<crate::ui_contract::settings::EffectiveSettingsDto, LedgerError> {
    if !matches!(ledger.scope(), LedgerScope::Host) {
        return Err(LedgerError::Storage("settings are host-scoped".to_string()));
    }
    let conn = ledger.lock()?;
    let json: String = conn
        .query_row(
            "SELECT settings_json FROM effective_settings WHERE singleton = 1;",
            [],
            |row| row.get(0),
        )
        .map_err(|e| LedgerError::Storage(format!("read settings: {e}")))?;
    serde_json::from_str(&json).map_err(|_| LedgerError::Corrupt("bad settings_json".to_string()))
}

/// Host revision row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostRevisionRow {
    pub revision: u64,
    pub state_sha256: Sha256Digest,
}

pub fn get_host_revision(
    ledger: &OperationLedger,
    kind: &str,
) -> Result<HostRevisionRow, LedgerError> {
    let conn = ledger.lock()?;
    let (revision, sha): (i64, String) = conn
        .query_row(
            "SELECT revision, state_sha256 FROM host_revisions WHERE state_kind = ?1;",
            params![kind],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| LedgerError::Storage(format!("host revision: {e}")))?;
    Ok(HostRevisionRow {
        revision: revision as u64,
        state_sha256: Sha256Digest::from_hex_str(&sha)
            .map_err(|_| LedgerError::Corrupt("bad host state sha".to_string()))?,
    })
}

// Operational journal for host writes that cannot share the settings
// transaction.

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostStateTarget {
    Credentials,
    SetupConfig,
    Consent,
}

impl HostStateTarget {
    pub fn as_str(&self) -> &'static str {
        match self {
            HostStateTarget::Credentials => "credentials",
            HostStateTarget::SetupConfig => "setup_config",
            HostStateTarget::Consent => "consent",
        }
    }

    /// Target file name under PRAANA_HOME.
    pub fn file_name(&self) -> &'static str {
        match self {
            HostStateTarget::Credentials => "credentials.json",
            HostStateTarget::SetupConfig => "setup-config.json",
            HostStateTarget::Consent => "consent.json",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostJournalStage {
    Prepared,
    Replaced,
    RevisionCommitted,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostOperationJournalV1 {
    pub schema_version: u32,
    pub operation_id: OperationId,
    pub operation_kind: OperationKind,
    pub target_label: HostStateTarget,
    pub before_revision: u64,
    pub after_revision: u64,
    pub before_sha256: Sha256Digest,
    pub after_sha256: Sha256Digest,
    pub before_file_sha256: Sha256Digest,
    pub after_file_sha256: Sha256Digest,
    pub stage: HostJournalStage,
    pub created_at_ms: i64,
}

/// Sibling journal paths for one operation under the journal directory:
///
/// ```text
/// <journal_dir>/<operation-id>.json
/// <journal_dir>/<operation-id>.before
/// <journal_dir>/<operation-id>.after
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalPaths {
    pub manifest: PathBuf,
    pub before: PathBuf,
    pub after: PathBuf,
}

/// Sibling journal paths for one operation ID.
pub fn journal_paths_for(journal_dir: &Path, operation_id: &OperationId) -> JournalPaths {
    let stem = operation_id.to_string();
    JournalPaths {
        manifest: journal_dir.join(format!("{stem}.json")),
        before: journal_dir.join(format!("{stem}.before")),
        after: journal_dir.join(format!("{stem}.after")),
    }
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), LedgerError> {
    reject_symlink(path)?;
    write_private_file_inner(path, bytes, false)
}

fn write_private_file_new(path: &Path, bytes: &[u8]) -> Result<(), LedgerError> {
    reject_symlink(path)?;
    write_private_file_inner(path, bytes, true)
}

#[cfg(unix)]
fn write_private_file_inner(
    path: &Path,
    bytes: &[u8],
    create_new: bool,
) -> Result<(), LedgerError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    let mut file = options.open(path).map_err(|e| {
        LedgerError::Storage(format!("open {} with O_NOFOLLOW: {e}", path.display()))
    })?;
    file.write_all(bytes)
        .map_err(|e| LedgerError::Storage(format!("write {}: {e}", path.display())))?;
    file.sync_all()
        .map_err(|e| LedgerError::Storage(format!("fsync {}: {e}", path.display())))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private_file_inner(
    path: &Path,
    _bytes: &[u8],
    _create_new: bool,
) -> Result<(), LedgerError> {
    // Private ACLs cannot be established here; fail closed without writing.
    Err(insecure_permissions(&format!(
        "private ACL unavailable for {}",
        path.display()
    )))
}

fn manifest_bytes(journal: &HostOperationJournalV1) -> Result<Vec<u8>, LedgerError> {
    let bytes = crate::canonical_json::to_canonical_json_bytes(journal)
        .map_err(|e| LedgerError::Storage(format!("journal json: {e}")))?;
    let mut out = bytes;
    out.push(b'\n');
    Ok(out)
}

/// Reserve-side journal write: sibling manifest plus exact private
/// before/after target-file bytes, each fsynced, with the journal directory
/// fsynced. Files are created exclusively with no-follow semantics.
pub fn journal_prepare(
    journal_dir: &Path,
    journal: &HostOperationJournalV1,
    before_bytes: &[u8],
    after_bytes: &[u8],
) -> Result<JournalPaths, LedgerError> {
    if journal.schema_version != 1 {
        return Err(LedgerError::Storage(
            "journal schema_version must be 1".to_string(),
        ));
    }
    apply_private_umask();
    reject_symlink(journal_dir)?;
    std::fs::create_dir_all(journal_dir)
        .map_err(|e| LedgerError::Storage(format!("journal dir: {e}")))?;
    apply_private_dir_permissions(journal_dir)?;
    let paths = journal_paths_for(journal_dir, &journal.operation_id);
    write_private_file_new(&paths.manifest, &manifest_bytes(journal)?)?;
    // Tighten the manifest if it pre-existed with wider modes.
    apply_private_file_permissions(&paths.manifest)?;
    write_private_file_new(&paths.before, before_bytes)?;
    apply_private_file_permissions(&paths.before)?;
    write_private_file_new(&paths.after, after_bytes)?;
    apply_private_file_permissions(&paths.after)?;
    fsync_dir(journal_dir)?;
    Ok(paths)
}

pub fn journal_read(
    journal_dir: &Path,
    operation_id: &OperationId,
) -> Result<(HostOperationJournalV1, Vec<u8>, Vec<u8>), LedgerError> {
    let paths = journal_paths_for(journal_dir, operation_id);
    let text = std::fs::read_to_string(&paths.manifest)
        .map_err(|e| LedgerError::Corrupt(format!("journal manifest: {e}")))?;
    let journal: HostOperationJournalV1 = serde_json::from_str(&text)
        .map_err(|e| LedgerError::Corrupt(format!("journal json: {e}")))?;
    if journal.schema_version != 1 {
        return Err(LedgerError::Corrupt("journal schema_version".to_string()));
    }
    if journal.operation_id != *operation_id {
        return Err(LedgerError::Corrupt(
            "journal operation mismatch".to_string(),
        ));
    }
    let before = std::fs::read(&paths.before)
        .map_err(|e| LedgerError::Corrupt(format!("journal before: {e}")))?;
    let after = std::fs::read(&paths.after)
        .map_err(|e| LedgerError::Corrupt(format!("journal after: {e}")))?;
    verify_journal_file_hashes(&journal, &before, &after)?;
    Ok((journal, before, after))
}

fn verify_journal_file_hashes(
    journal: &HostOperationJournalV1,
    before: &[u8],
    after: &[u8],
) -> Result<(), LedgerError> {
    let before_sha = crate::ui_contract::operation::sha256_hex_of(before);
    let after_sha = crate::ui_contract::operation::sha256_hex_of(after);
    if before_sha != journal.before_file_sha256 || before_sha != journal.before_sha256 {
        return Err(LedgerError::Corrupt(
            "journal before hash mismatch".to_string(),
        ));
    }
    if after_sha != journal.after_file_sha256 || after_sha != journal.after_sha256 {
        return Err(LedgerError::Corrupt(
            "journal after hash mismatch".to_string(),
        ));
    }
    Ok(())
}

fn journal_write_stage(
    journal_dir: &Path,
    journal: &HostOperationJournalV1,
) -> Result<(), LedgerError> {
    let paths = journal_paths_for(journal_dir, &journal.operation_id);
    write_private_file(&paths.manifest, &manifest_bytes(journal)?)?;
    apply_private_file_permissions(&paths.manifest)?;
    fsync_dir(journal_dir)?;
    Ok(())
}

/// Atomically replace the target file with the journaled after bytes, then
/// advance the manifest to `replaced`.
pub fn journal_replace_target(
    journal_dir: &Path,
    journal: &mut HostOperationJournalV1,
    home_dir: &Path,
) -> Result<(), LedgerError> {
    let target = home_dir.join(journal.target_label.file_name());
    let paths = journal_paths_for(journal_dir, &journal.operation_id);
    let after = std::fs::read(&paths.after)
        .map_err(|e| LedgerError::Storage(format!("journal after: {e}")))?;
    let tmp = target.with_extension("tmp");
    reject_symlink(&tmp)?;
    write_private_file(&tmp, &after)?;
    apply_private_file_permissions(&tmp)?;
    std::fs::rename(&tmp, &target)
        .map_err(|e| LedgerError::Storage(format!("replace target: {e}")))?;
    apply_private_file_permissions(&target)?;
    fsync_dir(home_dir)?;
    journal.stage = HostJournalStage::Replaced;
    journal_write_stage(journal_dir, journal)?;
    Ok(())
}

/// Transactionally advance `host_revisions` and the terminal operation result
/// for a journaled write, then advance the manifest to `revision_committed`.
pub fn journal_commit_revision(
    ledger: &OperationLedger,
    journal_dir: &Path,
    journal: &mut HostOperationJournalV1,
    result: &StoredTerminalResult,
    finished_at_ms: i64,
) -> Result<(), LedgerError> {
    let (result_json, result_sha) = match result {
        StoredTerminalResult::Success(success) => {
            let bytes = crate::canonical_json::to_canonical_json_bytes(success)
                .map_err(|e| LedgerError::Storage(format!("result: {e}")))?;
            let json = String::from_utf8(bytes.clone())
                .map_err(|e| LedgerError::Storage(format!("result utf8: {e}")))?;
            (json, crate::ui_contract::operation::sha256_hex_of(&bytes))
        }
        StoredTerminalResult::Error(error) => {
            let bytes = crate::canonical_json::to_canonical_json_bytes(error)
                .map_err(|e| LedgerError::Storage(format!("result: {e}")))?;
            let json = String::from_utf8(bytes.clone())
                .map_err(|e| LedgerError::Storage(format!("result utf8: {e}")))?;
            (json, crate::ui_contract::operation::sha256_hex_of(&bytes))
        }
    };
    let conn = ledger.lock()?;
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| LedgerError::Storage(format!("begin: {e}")))?;
    let apply = || -> Result<(), LedgerError> {
        let updated = conn
            .execute(
                "UPDATE host_revisions SET revision = ?1, state_sha256 = ?2, updated_at_ms = ?3 WHERE state_kind = ?4 AND revision = ?5;",
                params![
                    journal.after_revision as i64,
                    journal.after_sha256.as_str(),
                    finished_at_ms,
                    journal.target_label.as_str(),
                    journal.before_revision as i64,
                ],
            )
            .map_err(|e| LedgerError::Storage(format!("host revision: {e}")))?;
        if updated != 1 {
            return Err(LedgerError::Storage("host revision mismatch".to_string()));
        }
        let status = match result {
            StoredTerminalResult::Success(_) => "succeeded",
            StoredTerminalResult::Error(_) => "failed",
        };
        let updated = conn
            .execute(
                "UPDATE operation_records SET status = ?1, result_json = ?2, result_sha256 = ?3, finished_at_ms = ?4 WHERE operation_id = ?5 AND status = 'reserved';",
                params![
                    status,
                    result_json,
                    result_sha.as_str(),
                    finished_at_ms,
                    journal.operation_id.to_string(),
                ],
            )
            .map_err(|e| LedgerError::Storage(format!("complete: {e}")))?;
        if updated != 1 {
            return Err(LedgerError::Storage(
                "complete affected no reserved row".to_string(),
            ));
        }
        Ok(())
    };
    match apply() {
        Ok(()) => {
            conn.execute_batch("COMMIT;")
                .map_err(|e| LedgerError::Storage(format!("commit: {e}")))?;
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            return Err(e);
        }
    }
    drop(conn);
    journal.stage = HostJournalStage::RevisionCommitted;
    journal_write_stage(journal_dir, journal)?;
    chmod_wal_shm_for(&ledger.db_path);
    Ok(())
}

/// Remove journal sibling files only after terminal record durability, then
/// fsync the journal directory.
pub fn journal_cleanup(journal_dir: &Path, operation_id: &OperationId) -> Result<(), LedgerError> {
    let paths = journal_paths_for(journal_dir, operation_id);
    for path in [&paths.manifest, &paths.before, &paths.after] {
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| LedgerError::Storage(format!("journal cleanup: {e}")))?;
        }
    }
    fsync_dir(journal_dir)?;
    Ok(())
}

/// Reconstruct a terminal UI result from a proven after-file identity.
///
/// Auth login/logout use credential *keys* only (never values). Setup and
/// consent succeed only when the after bytes are already the exact result DTO.
/// Anything else returns `None` rather than fabricating fields.
fn reconstruct_proven_after_result(
    kind: OperationKind,
    before_bytes: &[u8],
    after_bytes: &[u8],
) -> Option<StoredTerminalResult> {
    match kind {
        OperationKind::AuthLogin => {
            let provider = unique_credential_key_delta(before_bytes, after_bytes, true)?;
            Some(StoredTerminalResult::Success(
                CoreCommandSuccess::AuthLogin(AuthLoginResultDto {
                    provider,
                    state: AuthState::Authenticated,
                    flow: None,
                }),
            ))
        }
        OperationKind::AuthLogout => {
            let provider = unique_credential_key_delta(before_bytes, after_bytes, false)?;
            Some(StoredTerminalResult::Success(
                CoreCommandSuccess::AuthLogout(AuthLogoutResultDto {
                    provider,
                    state: AuthState::Unauthenticated,
                    fallback_model: None,
                }),
            ))
        }
        OperationKind::SetupApply => serde_json::from_slice::<SetupApplyResultDto>(after_bytes)
            .ok()
            .map(|dto| StoredTerminalResult::Success(CoreCommandSuccess::SetupApplied(dto))),
        OperationKind::ConsentResolve => {
            serde_json::from_slice::<ConsentResolvedResultDto>(after_bytes)
                .ok()
                .map(|dto| StoredTerminalResult::Success(CoreCommandSuccess::ConsentResolved(dto)))
        }
        _ => None,
    }
}

fn unique_credential_key_delta(
    before_bytes: &[u8],
    after_bytes: &[u8],
    added: bool,
) -> Option<ProviderId> {
    let before: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(before_bytes).ok()?;
    let after: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(after_bytes).ok()?;
    let before_keys: BTreeSet<&str> = before.keys().map(String::as_str).collect();
    let after_keys: BTreeSet<&str> = after.keys().map(String::as_str).collect();
    let added_keys: Vec<&str> = after_keys.difference(&before_keys).copied().collect();
    let removed_keys: Vec<&str> = before_keys.difference(&after_keys).copied().collect();
    let key = if added {
        if added_keys.len() != 1 || !removed_keys.is_empty() {
            return None;
        }
        added_keys[0]
    } else if removed_keys.len() != 1 || !added_keys.is_empty() {
        return None;
    } else {
        removed_keys[0]
    };
    ProviderId::from_canonical_str(key).ok()
}

/// Startup journal recovery before setup/auth/consent commands.
///
/// - Exact before state (identity, revision, both hashes): the old operation
///   never took effect; mark it interrupted and permit a new operation.
/// - Exact after state: prove the old operation succeeded. Reconstruct the
///   terminal UI result from journal kind plus after/before identity (never
///   from secret values). Fall back to the recovery probe. If neither can
///   produce the exact result, the row stays reserved and continuable with
///   its journal preserved.
/// - Mixed state: mark interrupted and preserve the journal for visible manual
///   recovery.
/// - Secret-bearing operations are never automatically replayed.
pub fn recover_host_journal(
    ledger: &OperationLedger,
    journal_dir: &Path,
    home_dir: &Path,
    history: &HistoryService,
) -> Result<Vec<SystemNoticeDto>, LedgerError> {
    let finished_at_ms = (history.now_ms)();
    let mut notices = Vec::new();
    let mut manifests: Vec<PathBuf> = std::fs::read_dir(journal_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
                .collect()
        })
        .unwrap_or_default();
    manifests.sort();
    for manifest_path in manifests {
        let stem = manifest_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        let operation_id = OperationId::from_canonical_str(&stem).map_err(|_| {
            LedgerError::Corrupt(format!("journal name {}", manifest_path.display()))
        })?;
        let (journal, before_bytes, after_bytes) = match journal_read(journal_dir, &operation_id) {
            Ok(parts) => parts,
            Err(_) => {
                // Corrupt journals block mutation rather than being guessed.
                return Err(LedgerError::Corrupt(format!(
                    "unreadable journal {}",
                    manifest_path.display()
                )));
            }
        };
        let target_path = home_dir.join(journal.target_label.file_name());
        let current_bytes = std::fs::read(&target_path).unwrap_or_default();
        let current_file_sha = crate::ui_contract::operation::sha256_hex_of(&current_bytes);
        let revision = get_host_revision(ledger, journal.target_label.as_str())
            .map(|row| row.revision)
            .unwrap_or(0);
        let matches_before = current_file_sha == journal.before_file_sha256
            && current_file_sha == journal.before_sha256
            && revision == journal.before_revision;
        let matches_after = current_file_sha == journal.after_file_sha256
            && current_file_sha == journal.after_sha256
            && revision == journal.after_revision;
        let notice_base = SystemNoticeDto {
            notice_id: crate::ui_contract::ids::NoticeId(ulid::Ulid::generate()),
            code: "host-journal-recovery".to_string(),
            tone: crate::ui_contract::result::NoticeTone::Warning,
            title: "Host journal recovery".to_string(),
            message: format!("journal {}", journal.operation_id),
            persistence: crate::ui_contract::result::NoticePersistence::Transient,
        };
        if matches_after {
            // The effect is proven complete: the target file already matches
            // the journaled after bytes at the after revision. When the row
            // is not terminal yet, store a reconstructed terminal result from
            // journal kind + after/before identity, or from the probe. If
            // neither can produce the exact UI result, the row stays reserved
            // and continuable with its journal preserved.
            let stored = ledger.lookup(&journal.operation_id)?;
            let terminal = stored
                .as_ref()
                .map(|row| row.dto.status != OperationStatus::Reserved)
                .unwrap_or(false);
            if !terminal {
                let rebuilt = reconstruct_proven_after_result(
                    journal.operation_kind,
                    &before_bytes,
                    &after_bytes,
                )
                .map(|result| RebuiltTerminal {
                    result,
                    first_seq: None,
                    terminal_seq: None,
                })
                .or_else(|| {
                    stored
                        .as_ref()
                        .and_then(|row| history.probe.rebuild_terminal(row))
                });
                if let Some(rebuilt) = rebuilt {
                    ledger.complete_terminal(
                        &journal.operation_id,
                        &rebuilt.result,
                        rebuilt.first_seq,
                        rebuilt.terminal_seq,
                        finished_at_ms,
                    )?;
                    notices.push(SystemNoticeDto {
                        tone: crate::ui_contract::result::NoticeTone::Success,
                        message: format!("journal {} already applied", journal.operation_id),
                        ..notice_base
                    });
                    journal_cleanup(journal_dir, &journal.operation_id)?;
                    continue;
                }
                notices.push(SystemNoticeDto {
                    message: format!(
                        "journal {} proven applied; result pending, journal preserved",
                        journal.operation_id
                    ),
                    ..notice_base
                });
                continue;
            }
            notices.push(SystemNoticeDto {
                tone: crate::ui_contract::result::NoticeTone::Success,
                message: format!("journal {} already applied", journal.operation_id),
                ..notice_base
            });
            journal_cleanup(journal_dir, &journal.operation_id)?;
        } else if matches_before {
            ledger.mark_interrupted(
                &journal.operation_id,
                &operation_interrupted_error(),
                finished_at_ms,
            )?;
            journal_cleanup(journal_dir, &journal.operation_id)?;
            notices.push(SystemNoticeDto {
                message: format!(
                    "journal {} had no effect; a new operation is permitted",
                    journal.operation_id
                ),
                ..notice_base
            });
        } else {
            ledger.mark_interrupted(
                &journal.operation_id,
                &operation_interrupted_error(),
                finished_at_ms,
            )?;
            notices.push(SystemNoticeDto {
                message: format!(
                    "journal {} is inconsistent; preserved for manual recovery",
                    journal.operation_id
                ),
                ..notice_base
            });
        }
    }
    Ok(notices)
}

/// Host retention: terminal rows older than 30 days are pruned only if no
/// live session references them. Reserved and interrupted rows are never
/// age-pruned.
pub fn prune_host_terminal(
    ledger: &OperationLedger,
    now_ms: i64,
    live_session_ids: &HashSet<String>,
) -> Result<u64, LedgerError> {
    if !matches!(ledger.scope(), LedgerScope::Host) {
        return Ok(0);
    }
    let cutoff = now_ms - HOST_PRUNE_AFTER_MS;
    let conn = ledger.lock()?;
    let candidates: Vec<(String, Option<String>)> = conn
        .prepare("SELECT operation_id, session_id FROM operation_records WHERE status IN ('succeeded', 'failed') AND finished_at_ms IS NOT NULL AND finished_at_ms < ?1;")
        .map_err(|e| LedgerError::Storage(format!("prune select: {e}")))?
        .query_map(params![cutoff], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| LedgerError::Storage(format!("prune select: {e}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| LedgerError::Storage(format!("prune select: {e}")))?;
    let mut pruned = 0u64;
    for (operation_id, session_id) in candidates {
        if let Some(session) = session_id {
            if live_session_ids.contains(&session) {
                continue;
            }
        }
        conn.execute(
            "DELETE FROM operation_records WHERE operation_id = ?1;",
            params![operation_id],
        )
        .map_err(|e| LedgerError::Storage(format!("prune delete: {e}")))?;
        pruned += 1;
    }
    Ok(pruned)
}
