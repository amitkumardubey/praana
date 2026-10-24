//! Non-canonical per-user calibration store (`<PRAANA_HOME>/calibration.db`).
//!
//! Token Accounting §9 keeps the latest 128 comparable samples for one bucket
//! key. The file is shared across sessions so a one-turn `praana run` can
//! apply `C`. It is not part of the config digest, not part of any session
//! snapshot, and resume does not read it.
//!
//! Every failure is best-effort: callers turn it into `C = 0` or a dropped
//! sample. This module never panics on I/O, never prints, and never rewrites
//! a corrupt or wrong-version file.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use super::calibration::{CalibrationBucketKey, TokenCalibrationBucket, TokenCalibrationSampleV1};
use super::Sha256Digest;

const SCHEMA_VERSION: i32 = 1;
const SCHEMA_VERSION_TEXT: &str = "1";
/// Distinct from the history database `application_id`.
const APPLICATION_ID: i32 = 0x7035_434C;
const RETAINED_SAMPLES: usize = 128;
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

const CODE_IO: &str = "CALIBRATION_STORE_IO";
const CODE_LOCKED: &str = "CALIBRATION_STORE_LOCKED";
const CODE_CORRUPT: &str = "CALIBRATION_STORE_CORRUPT";
const CODE_SCHEMA: &str = "CALIBRATION_STORE_SCHEMA";
const CODE_READ_ONLY: &str = "CALIBRATION_STORE_READ_ONLY";
const CODE_SYMLINK: &str = "CALIBRATION_STORE_SYMLINK";
const CODE_PERMISSIONS: &str = "CALIBRATION_STORE_PERMISSIONS";

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS calibration_samples (
  sample_id                         INTEGER PRIMARY KEY,
  token_calibration_schema_version  INTEGER NOT NULL CHECK(token_calibration_schema_version = 1),
  provider                          TEXT NOT NULL,
  protocol                          TEXT NOT NULL,
  model                             TEXT NOT NULL,
  model_revision                    TEXT,
  estimator_id                      TEXT NOT NULL,
  request_hash                      TEXT NOT NULL CHECK(length(request_hash) = 64),
  estimated_input_tokens            INTEGER NOT NULL CHECK(estimated_input_tokens >= 0),
  reported_input_tokens             INTEGER NOT NULL CHECK(reported_input_tokens > 0),
  signed_error_tokens               INTEGER NOT NULL,
  positive_error_tokens             INTEGER NOT NULL CHECK(positive_error_tokens >= 0),
  cached_input_tokens               INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  compaction_epoch                  INTEGER NOT NULL CHECK(compaction_epoch >= 0),
  timestamp_ms                      INTEGER NOT NULL,
  CHECK(positive_error_tokens = CASE
    WHEN signed_error_tokens > 0 THEN signed_error_tokens
    ELSE 0 END)
) STRICT;

CREATE INDEX IF NOT EXISTS calibration_samples_bucket_idx
  ON calibration_samples(
    provider, protocol, estimator_id, model_revision, model, timestamp_ms, sample_id
  );
"#;

/// Failure of a calibration-store read or write. `code` is the only payload:
/// no path, no SQLite text, no sample contents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CalibrationStoreError {
    pub code: &'static str,
}

impl std::fmt::Display for CalibrationStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for CalibrationStoreError {}

impl CalibrationStoreError {
    const fn new(code: &'static str) -> Self {
        Self { code }
    }
}

pub fn calibration_store_path(home: &Path) -> PathBuf {
    home.join("calibration.db")
}

/// Oldest-first comparable samples for `key`, at most 128.
///
/// Any failure, including a missing parent permission, a lock, a corrupt
/// file, a wrong schema version, a read-only file, or a symlink, returns an
/// empty bucket so `C` stays 0. A missing file is an empty bucket and is not
/// created here.
pub fn load_bucket(home: &Path, key: &CalibrationBucketKey) -> Vec<TokenCalibrationSampleV1> {
    try_load_bucket(home, key).unwrap_or_default()
}

/// Same as [`load_bucket`], but the caller can record the error code.
pub fn try_load_bucket(
    home: &Path,
    key: &CalibrationBucketKey,
) -> Result<Vec<TokenCalibrationSampleV1>, CalibrationStoreError> {
    let path = calibration_store_path(home);
    match classify_existing(&path)? {
        Existing::Absent | Existing::Uninitialized => Ok(Vec::new()),
        Existing::Ready => read_samples(&path, key),
    }
}

/// Insert one comparable sample and prune that bucket to the latest 128 rows
/// in the same transaction. Placeholder zero reported usage is not a sample
/// and is dropped without an error. A corrupt or wrong-version file is left
/// untouched.
pub fn append_sample(
    home: &Path,
    sample: &TokenCalibrationSampleV1,
) -> Result<(), CalibrationStoreError> {
    if sample.reported_input_tokens == 0 {
        return Ok(());
    }
    let path = calibration_store_path(home);
    reject_symlink(home)?;
    ensure_private_dir(home)?;
    match classify_existing(&path)? {
        Existing::Absent | Existing::Uninitialized => init_new(&path)?,
        Existing::Ready => {}
    }
    let conn = open_read_write(&path)?;
    let key = CalibrationBucketKey::from_sample(sample);
    in_immediate(&conn, |conn| {
        insert_sample(conn, sample)?;
        prune_bucket(conn, &key)?;
        Ok(())
    })?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
    tighten_private_file(&path)?;
    chmod_sidecars(&path);
    Ok(())
}

/// `C` for one bucket, loaded from the store the first time this process
/// uses the key and kept after that.
///
/// Samples this process appends are added to the cached vec, so a later
/// admission in the same process sees them. Samples another process writes
/// after this process has cached the bucket are picked up by the next
/// process, not by this one. A failed load is cached empty: `C` stays 0 and
/// the store is not retried. `error_code` is set only on that first failure.
pub(crate) struct CachedCalibrationMargin {
    pub(crate) margin: u64,
    pub(crate) error_code: Option<&'static str>,
}

pub(crate) fn cached_calibration_margin(
    home: &Path,
    key: &CalibrationBucketKey,
) -> CachedCalibrationMargin {
    let id = CacheId {
        home: home.to_path_buf(),
        key: key.clone(),
    };
    {
        let guard = cache_lock();
        if let Some(entry) = guard.get(&id) {
            return CachedCalibrationMargin {
                margin: margin_from_samples(&entry.samples),
                error_code: None,
            };
        }
    }
    // Load outside the lock. Re-check before inserting so a sample noted
    // while this load ran is not replaced by a stale vec.
    let loaded = try_load_bucket(home, key);
    let mut guard = cache_lock();
    if let Some(entry) = guard.get(&id) {
        return CachedCalibrationMargin {
            margin: margin_from_samples(&entry.samples),
            error_code: None,
        };
    }
    match loaded {
        Ok(samples) => {
            let margin = margin_from_samples(&samples);
            guard.insert(id, CacheEntry { samples });
            CachedCalibrationMargin {
                margin,
                error_code: None,
            }
        }
        Err(error) => {
            guard.insert(
                id,
                CacheEntry {
                    samples: Vec::new(),
                },
            );
            CachedCalibrationMargin {
                margin: 0,
                error_code: Some(error.code),
            }
        }
    }
}

/// Remember a sample this process just persisted. No disk read when the
/// bucket is already cached.
pub(crate) fn note_appended_sample(home: &Path, sample: &TokenCalibrationSampleV1) {
    let key = CalibrationBucketKey::from_sample(sample);
    let id = CacheId {
        home: home.to_path_buf(),
        key: key.clone(),
    };
    {
        let mut guard = cache_lock();
        if let Some(entry) = guard.get_mut(&id) {
            push_sample(&mut entry.samples, sample);
            return;
        }
    }
    let mut samples = try_load_bucket(home, &key).unwrap_or_default();
    push_sample(&mut samples, sample);
    let mut guard = cache_lock();
    if let Some(entry) = guard.get_mut(&id) {
        push_sample(&mut entry.samples, sample);
        return;
    }
    guard.insert(id, CacheEntry { samples });
}

struct CacheEntry {
    samples: Vec<TokenCalibrationSampleV1>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct CacheId {
    home: PathBuf,
    key: CalibrationBucketKey,
}

fn push_sample(samples: &mut Vec<TokenCalibrationSampleV1>, sample: &TokenCalibrationSampleV1) {
    if samples.iter().any(|existing| same_sample(existing, sample)) {
        return;
    }
    samples.push(sample.clone());
    retain_latest(samples);
}

fn same_sample(left: &TokenCalibrationSampleV1, right: &TokenCalibrationSampleV1) -> bool {
    left.request_hash == right.request_hash
        && left.timestamp_ms == right.timestamp_ms
        && left.reported_input_tokens == right.reported_input_tokens
}

fn retain_latest(samples: &mut Vec<TokenCalibrationSampleV1>) {
    if samples.len() <= RETAINED_SAMPLES {
        return;
    }
    // Stable sort: equal timestamps keep the earlier insertion, which is older.
    samples.sort_by_key(|sample| sample.timestamp_ms);
    let overflow = samples.len() - RETAINED_SAMPLES;
    samples.drain(0..overflow);
}

fn margin_from_samples(samples: &[TokenCalibrationSampleV1]) -> u64 {
    let mut bucket = TokenCalibrationBucket::new(RETAINED_SAMPLES);
    for sample in samples {
        bucket.add_sample(sample.clone());
    }
    bucket.calculate_calibration_margin_c().unwrap_or(0)
}

fn cache() -> &'static Mutex<HashMap<CacheId, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheId, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_lock() -> std::sync::MutexGuard<'static, HashMap<CacheId, CacheEntry>> {
    cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

enum Existing {
    Absent,
    /// Empty file, or a SQLite file that does not yet have this schema.
    /// Readers leave it alone. Writers finish initialization.
    Uninitialized,
    Ready,
}

/// Classify the store file without modifying it.
fn classify_existing(path: &Path) -> Result<Existing, CalibrationStoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Existing::Absent),
        Err(_) => return Err(CalibrationStoreError::new(CODE_IO)),
    };
    if metadata.file_type().is_symlink() {
        return Err(CalibrationStoreError::new(CODE_SYMLINK));
    }
    if !metadata.is_file() {
        return Err(CalibrationStoreError::new(CODE_IO));
    }
    match file_header(path)? {
        FileHeader::Empty => return Ok(Existing::Uninitialized),
        FileHeader::Garbage => return Err(CalibrationStoreError::new(CODE_CORRUPT)),
        FileHeader::Sqlite => {}
    }
    let conn =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| {
            if is_read_only(&error) {
                CalibrationStoreError::new(CODE_READ_ONLY)
            } else if is_locked(&error) || is_corrupt(&error) {
                map_sql(error)
            } else {
                CalibrationStoreError::new(CODE_CORRUPT)
            }
        })?;
    // A read-only probe must not be asked to change the journal mode.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(5_000));
    match schema_state(&conn)? {
        SchemaState::Ready => {
            ensure_file_mode(path)?;
            Ok(Existing::Ready)
        }
        SchemaState::Uninitialized => Ok(Existing::Uninitialized),
        SchemaState::Foreign => Err(CalibrationStoreError::new(CODE_SCHEMA)),
    }
}

enum SchemaState {
    Ready,
    Uninitialized,
    Foreign,
}

fn schema_state(conn: &Connection) -> Result<SchemaState, CalibrationStoreError> {
    let user_version = pragma_i32(conn, "user_version")?;
    let application_id = pragma_i32(conn, "application_id")?;
    let meta_table = table_exists(conn, "schema_meta")?;
    let sample_table = table_exists(conn, "calibration_samples")?;
    let meta = if meta_table {
        conn.query_row(
            "SELECT value FROM schema_meta WHERE key = 'calibration_schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(map_sql)?
    } else {
        None
    };
    if user_version == SCHEMA_VERSION
        && application_id == APPLICATION_ID
        && meta.as_deref() == Some(SCHEMA_VERSION_TEXT)
        && sample_table
    {
        return Ok(SchemaState::Ready);
    }
    // Version 0 / application id 0 with no user tables is an unfinished create.
    // Any other database is left untouched.
    if user_version == 0 && application_id == 0 && !sample_table && meta.is_none() {
        let foreign_table = conn
            .query_row(
                "SELECT 1 FROM sqlite_master
                  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(map_sql)?;
        if foreign_table.is_none() {
            return Ok(SchemaState::Uninitialized);
        }
    }
    Ok(SchemaState::Foreign)
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, CalibrationStoreError> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|value| value.is_some())
    .map_err(map_sql)
}

enum FileHeader {
    Empty,
    Sqlite,
    Garbage,
}

fn file_header(path: &Path) -> Result<FileHeader, CalibrationStoreError> {
    let mut file = fs::File::open(path).map_err(map_io)?;
    let mut header = [0u8; 16];
    match file.read(&mut header) {
        Ok(0) => Ok(FileHeader::Empty),
        Ok(16) if header == SQLITE_MAGIC => Ok(FileHeader::Sqlite),
        Ok(_) => Ok(FileHeader::Garbage),
        Err(_) => Err(CalibrationStoreError::new(CODE_IO)),
    }
}

fn init_new(path: &Path) -> Result<(), CalibrationStoreError> {
    create_private_file(path)?;
    // Another writer may have finished the file between the classify and here.
    if matches!(file_header(path)?, FileHeader::Sqlite) {
        match classify_existing(path)? {
            Existing::Ready => return Ok(()),
            Existing::Uninitialized => {}
            Existing::Absent => {}
        }
    }
    let conn = open_read_write(path)?;
    in_immediate(&conn, |conn| {
        conn.execute_batch(SCHEMA_SQL).map_err(map_sql)?;
        conn.execute(
            "INSERT INTO schema_meta(key, value) VALUES ('calibration_schema_version', ?1)
             ON CONFLICT(key) DO NOTHING",
            [SCHEMA_VERSION_TEXT],
        )
        .map_err(map_sql)?;
        Ok(())
    })?;
    conn.execute_batch(&format!(
        "PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {SCHEMA_VERSION};"
    ))
    .map_err(map_sql)?;
    tighten_private_file(path)?;
    chmod_sidecars(path);
    Ok(())
}

fn open_read_write(path: &Path) -> Result<Connection, CalibrationStoreError> {
    apply_private_umask();
    let conn = Connection::open(path).map_err(map_sql)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA foreign_keys = ON;
         PRAGMA trusted_schema = OFF;",
    )
    .map_err(map_sql)?;
    let journal: String = conn
        .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
        .map_err(map_sql)?;
    if !journal.eq_ignore_ascii_case("wal") {
        return Err(CalibrationStoreError::new(CODE_IO));
    }
    let busy = pragma_i32(&conn, "busy_timeout")?;
    if busy != 5000 {
        return Err(CalibrationStoreError::new(CODE_IO));
    }
    Ok(conn)
}

fn read_samples(
    path: &Path,
    key: &CalibrationBucketKey,
) -> Result<Vec<TokenCalibrationSampleV1>, CalibrationStoreError> {
    let conn = open_read_write(path)?;
    let (sql, revision_or_model) = match &key.model_revision {
        Some(revision) => (
            "SELECT token_calibration_schema_version, provider, protocol, model,
                    model_revision, estimator_id, request_hash,
                    estimated_input_tokens, reported_input_tokens,
                    signed_error_tokens, positive_error_tokens, cached_input_tokens,
                    compaction_epoch, timestamp_ms
               FROM calibration_samples
              WHERE provider = ?1 AND protocol = ?2 AND estimator_id = ?3
                AND model_revision = ?4
                AND reported_input_tokens > 0
              ORDER BY timestamp_ms ASC, sample_id ASC
              LIMIT 128",
            revision.clone(),
        ),
        None => {
            let model = key
                .model
                .clone()
                .ok_or_else(|| CalibrationStoreError::new(CODE_IO))?;
            (
                "SELECT token_calibration_schema_version, provider, protocol, model,
                        model_revision, estimator_id, request_hash,
                        estimated_input_tokens, reported_input_tokens,
                        signed_error_tokens, positive_error_tokens, cached_input_tokens,
                        compaction_epoch, timestamp_ms
                   FROM calibration_samples
                  WHERE provider = ?1 AND protocol = ?2 AND estimator_id = ?3
                    AND model_revision IS NULL
                    AND model = ?4
                    AND reported_input_tokens > 0
                  ORDER BY timestamp_ms ASC, sample_id ASC
                  LIMIT 128",
                model,
            )
        }
    };
    let mut statement = conn.prepare(sql).map_err(map_sql)?;
    let rows = statement
        .query_map(
            rusqlite::params![
                key.provider,
                key.protocol,
                key.estimator_id,
                revision_or_model
            ],
            sample_from_row,
        )
        .map_err(map_sql)?;
    let mut samples = Vec::new();
    for row in rows {
        samples.push(row.map_err(map_sql)?);
    }
    Ok(samples)
}

fn sample_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TokenCalibrationSampleV1> {
    let schema: i64 = row.get(0)?;
    let provider: String = row.get(1)?;
    let protocol: String = row.get(2)?;
    let model: String = row.get(3)?;
    let model_revision: Option<String> = row.get(4)?;
    let estimator_id: String = row.get(5)?;
    let request_hash: String = row.get(6)?;
    let estimated: i64 = row.get(7)?;
    let reported: i64 = row.get(8)?;
    let signed: i64 = row.get(9)?;
    let positive: i64 = row.get(10)?;
    let cached: Option<i64> = row.get(11)?;
    let epoch: i64 = row.get(12)?;
    let timestamp_ms: i64 = row.get(13)?;
    let hash = Sha256Digest::from_hex_str(&request_hash)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let estimated = u64::try_from(estimated)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let reported = u64::try_from(reported)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let cached = match cached {
        Some(value) => Some(
            u64::try_from(value)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?,
        ),
        None => None,
    };
    let epoch = u32::try_from(epoch)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    if schema != i64::from(SCHEMA_VERSION) {
        return Err(rusqlite::Error::InvalidColumnType(
            0,
            "token_calibration_schema_version".into(),
            rusqlite::types::Type::Integer,
        ));
    }
    let sample = TokenCalibrationSampleV1::new(
        provider,
        protocol,
        model,
        model_revision,
        estimator_id,
        hash,
        estimated,
        reported,
        cached,
        epoch,
        timestamp_ms,
    )
    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    if sample.signed_error_tokens != signed {
        return Err(rusqlite::Error::InvalidColumnType(
            9,
            "signed_error_tokens".into(),
            rusqlite::types::Type::Integer,
        ));
    }
    let positive_u = u64::try_from(positive)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    if sample.positive_error_tokens != positive_u {
        return Err(rusqlite::Error::InvalidColumnType(
            10,
            "positive_error_tokens".into(),
            rusqlite::types::Type::Integer,
        ));
    }
    Ok(sample)
}

fn insert_sample(
    conn: &Connection,
    sample: &TokenCalibrationSampleV1,
) -> Result<(), CalibrationStoreError> {
    let estimated = i64::try_from(sample.estimated_input_tokens).map_err(|_| io_error())?;
    let reported = i64::try_from(sample.reported_input_tokens).map_err(|_| io_error())?;
    let positive = i64::try_from(sample.positive_error_tokens).map_err(|_| io_error())?;
    let cached = match sample.cached_input_tokens {
        Some(value) => Some(i64::try_from(value).map_err(|_| io_error())?),
        None => None,
    };
    let epoch = i64::from(sample.compaction_epoch);
    conn.execute(
        "INSERT INTO calibration_samples (
            token_calibration_schema_version, provider, protocol, model, model_revision,
            estimator_id, request_hash, estimated_input_tokens, reported_input_tokens,
            signed_error_tokens, positive_error_tokens, cached_input_tokens,
            compaction_epoch, timestamp_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        rusqlite::params![
            i64::from(sample.token_calibration_schema_version),
            sample.provider,
            sample.protocol,
            sample.model,
            sample.model_revision,
            sample.estimator_id,
            sample.request_hash.as_str(),
            estimated,
            reported,
            sample.signed_error_tokens,
            positive,
            cached,
            epoch,
            sample.timestamp_ms,
        ],
    )
    .map(|_| ())
    .map_err(map_sql)
}

fn prune_bucket(
    conn: &Connection,
    key: &CalibrationBucketKey,
) -> Result<(), CalibrationStoreError> {
    let (sql, bound) = match &key.model_revision {
        Some(revision) => (
            "DELETE FROM calibration_samples
              WHERE sample_id IN (
                SELECT sample_id FROM calibration_samples
                 WHERE provider = ?1 AND protocol = ?2 AND estimator_id = ?3
                   AND model_revision = ?4
                 ORDER BY timestamp_ms DESC, sample_id DESC
                 LIMIT -1 OFFSET ?5
              )",
            revision.clone(),
        ),
        None => {
            let model = key.model.clone().ok_or_else(io_error)?;
            (
                "DELETE FROM calibration_samples
                  WHERE sample_id IN (
                    SELECT sample_id FROM calibration_samples
                     WHERE provider = ?1 AND protocol = ?2 AND estimator_id = ?3
                       AND model_revision IS NULL
                       AND model = ?4
                     ORDER BY timestamp_ms DESC, sample_id DESC
                     LIMIT -1 OFFSET ?5
                  )",
                model,
            )
        }
    };
    conn.execute(
        sql,
        rusqlite::params![
            key.provider,
            key.protocol,
            key.estimator_id,
            bound,
            i64::from(u32::try_from(RETAINED_SAMPLES).unwrap_or(128))
        ],
    )
    .map(|_| ())
    .map_err(map_sql)
}

fn in_immediate(
    conn: &Connection,
    body: impl FnOnce(&Connection) -> Result<(), CalibrationStoreError>,
) -> Result<(), CalibrationStoreError> {
    conn.execute_batch("BEGIN IMMEDIATE").map_err(map_sql)?;
    match body(conn) {
        Ok(()) => conn.execute_batch("COMMIT").map_err(map_sql),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn pragma_i32(conn: &Connection, name: &str) -> Result<i32, CalibrationStoreError> {
    conn.query_row(&format!("PRAGMA {name};"), [], |row| row.get(0))
        .map_err(map_sql)
}

fn reject_symlink(path: &Path) -> Result<(), CalibrationStoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(CalibrationStoreError::new(CODE_SYMLINK))
        }
        Ok(_) | Err(_) => Ok(()),
    }
}

fn ensure_private_dir(path: &Path) -> Result<(), CalibrationStoreError> {
    reject_symlink(path)?;
    if !path.exists() {
        fs::create_dir_all(path).map_err(map_io)?;
        #[cfg(unix)]
        set_mode(path, 0o700)?;
        return Ok(());
    }
    if !path.is_dir() {
        return Err(CalibrationStoreError::new(CODE_IO));
    }
    // Tighten a too-open directory. Never widen, and never follow a symlink
    // (rejected above). A directory that is missing owner access fails closed.
    #[cfg(unix)]
    {
        match mode_of(path)? {
            0o700 => Ok(()),
            mode if mode & !0o700 != 0 && 0o700 & !mode == 0 => set_mode(path, 0o700),
            _ => Err(CalibrationStoreError::new(CODE_PERMISSIONS)),
        }
    }
    #[cfg(not(unix))]
    {
        Ok(())
    }
}

fn ensure_file_mode(path: &Path) -> Result<(), CalibrationStoreError> {
    #[cfg(unix)]
    {
        match mode_of(path)? {
            0o600 => Ok(()),
            mode if mode & 0o200 == 0 => Err(CalibrationStoreError::new(CODE_READ_ONLY)),
            mode if mode & !0o600 != 0 && 0o600 & !mode == 0 => set_mode(path, 0o600),
            _ => Err(CalibrationStoreError::new(CODE_PERMISSIONS)),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn tighten_private_file(path: &Path) -> Result<(), CalibrationStoreError> {
    ensure_file_mode(path)
}

fn create_private_file(path: &Path) -> Result<(), CalibrationStoreError> {
    reject_symlink(path)?;
    if fs::symlink_metadata(path).is_ok() {
        return Ok(());
    }
    apply_private_umask();
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    match options.open(path) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(map_io(error)),
    }
}

fn chmod_sidecars(path: &Path) {
    #[cfg(unix)]
    {
        let stem = path.to_string_lossy();
        for suffix in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{stem}{suffix}"));
            if sidecar.is_file() {
                let _ = set_mode(&sidecar, 0o600);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

#[cfg(unix)]
fn mode_of(path: &Path) -> Result<u32, CalibrationStoreError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::symlink_metadata(path)
        .map_err(map_io)?
        .permissions()
        .mode()
        & 0o777;
    Ok(mode)
}

#[cfg(unix)]
fn set_mode(path: &Path, expected: u32) -> Result<(), CalibrationStoreError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(expected)).map_err(map_io)?;
    let actual = mode_of(path)?;
    if actual != expected {
        return Err(CalibrationStoreError::new(CODE_PERMISSIONS));
    }
    Ok(())
}

fn apply_private_umask() {
    #[cfg(unix)]
    unsafe {
        libc::umask(0o077);
    }
}

fn io_error() -> CalibrationStoreError {
    CalibrationStoreError::new(CODE_IO)
}

fn map_io(_error: std::io::Error) -> CalibrationStoreError {
    CalibrationStoreError::new(CODE_IO)
}

fn map_sql(error: rusqlite::Error) -> CalibrationStoreError {
    if is_locked(&error) {
        CalibrationStoreError::new(CODE_LOCKED)
    } else if is_read_only(&error) {
        CalibrationStoreError::new(CODE_READ_ONLY)
    } else if is_corrupt(&error) {
        CalibrationStoreError::new(CODE_CORRUPT)
    } else {
        CalibrationStoreError::new(CODE_IO)
    }
}

fn is_locked(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(ffi, _)
            if matches!(
                ffi.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
    )
}

fn is_read_only(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(ffi, _) if ffi.code == rusqlite::ErrorCode::ReadOnly
    )
}

fn is_corrupt(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(ffi, _)
            if matches!(
                ffi.code,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
            )
    )
}
