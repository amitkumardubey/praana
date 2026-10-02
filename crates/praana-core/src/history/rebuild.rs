//! Derived-table rebuild (History §9.4).
//!
//! A checkpoint mismatch, unclean shutdown, or explicit rebuild performs full
//! integrity checks and, when only derived tables fail, rebuilds them in a
//! fresh `history.db.rebuild` file: copy and hash-verify the canonical
//! artifact tables in one read snapshot, replay the valid event prefix into
//! all derived tables, run full integrity checks, fsync, then atomically
//! rename the old database aside and the rebuilt database into place. A
//! corrupt canonical table or a body that fails SHA-256 stops the rebuild
//! with `HISTORY_CANONICAL_DB_CORRUPT`; a body is never rebuilt from an
//! excerpt or summary.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use super::checkpoint::HistoryProjector;
use super::db::HistoryDatabase;
use super::error::{io_err, map_sqlite, ArtifactError};
use super::event_log::EventLogStore;
use super::operation_ledger::fsync_dir;
use crate::protocol::id::Sha256Digest;

fn unix_ms_now() -> Result<i64, ArtifactError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .map_err(|err| io_err(format!("clock: {err}")))
}

/// History §9.4 steps 1–6. On success the caller's database handle is
/// re-opened on the replaced file; every `HistoryDatabase` handle opened
/// earlier still reads the renamed-aside file and must be dropped.
pub(crate) fn rebuild_derived_tables(
    db: &HistoryDatabase,
    log: &EventLogStore,
) -> Result<(), ArtifactError> {
    let db_path = db.path().to_path_buf();
    let session_dir = log.session_dir().to_path_buf();
    let rebuild_path = rebuild_path(&db_path);
    if rebuild_path.exists() {
        std::fs::remove_file(&rebuild_path)
            .map_err(|err| io_err(format!("remove stale rebuild: {err}")))?;
    }

    // Step 1: fresh file with private permissions and the exact schema.
    let rebuild_db = HistoryDatabase::open(&rebuild_path)?;

    // Step 2: copy and hash-verify the canonical artifact tables in one
    // read snapshot of the source database.
    {
        let guard = db.lock();
        let src: &Connection = &guard;
        src.execute_batch("BEGIN").map_err(map_sqlite)?;
        let outcome = copy_canonical_tables(src, &rebuild_db);
        match outcome {
            Ok(()) => src.execute_batch("COMMIT").map_err(map_sqlite)?,
            Err(err) => {
                let _ = src.execute_batch("ROLLBACK");
                return Err(err);
            }
        }
    }

    // Step 3: replay the valid event prefix into all derived tables.
    HistoryProjector::new(&rebuild_db).project(log)?;

    {
        let guard = rebuild_db.lock();
        let dst: &Connection = &guard;
        // History §8: rebuild issues the FTS rebuild after all content rows
        // are present (per-row inserts above already populated the index).
        dst.execute("INSERT INTO search_fts(search_fts) VALUES('rebuild')", [])
            .map_err(map_sqlite)?;
        // Step 4: full integrity checks on the rebuilt database.
        full_integrity_check(dst)?;
        // History §15.2 point 15: checkpoint WAL frames before fsync.
        drop(guard);
        rebuild_db.wal_checkpoint_truncate()?;
    }

    // Step 5: fsync the rebuilt database file and the containing directory.
    drop(rebuild_db);
    File::open(&rebuild_path)
        .and_then(|file| file.sync_all())
        .map_err(|err| io_err(format!("fsync rebuild: {err}")))?;

    // Step 6: rename the old database aside, then the rebuild into place.
    // The old `-wal`/`-shm` sidecars must travel with the renamed file: leaving
    // them beside the new `history.db` would let the next opener replay the
    // old log into the rebuilt database.
    let bad_path = unique_bad_path(&db_path)?;
    rename_database_with_sidecars(&db_path, &bad_path)?;
    let renamed = std::fs::rename(&rebuild_path, &db_path);
    fsync_dir(&session_dir).map_err(|err| io_err(err.to_string()))?;
    renamed.map_err(|err| io_err(format!("rename rebuild into place: {err}")))?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = sidecar_path(&db_path, suffix);
        if sidecar.exists() {
            std::fs::remove_file(&sidecar)
                .map_err(|err| io_err(format!("remove {}: {err}", suffix)))?;
        }
    }
    fsync_dir(&session_dir).map_err(|err| io_err(err.to_string()))?;

    db.reopen()
}

fn sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut name = db_path
        .file_name()
        .map(|name| name.to_owned())
        .unwrap_or_default();
    name.push(suffix);
    db_path.with_file_name(name)
}

/// Move a WAL-mode database and its sidecars under one new base name.
fn rename_database_with_sidecars(from: &Path, to: &Path) -> Result<(), ArtifactError> {
    std::fs::rename(from, to).map_err(|err| io_err(format!("rename aside: {err}")))?;
    for suffix in ["-wal", "-shm"] {
        let source = sidecar_path(from, suffix);
        if source.exists() {
            let mut name = to
                .file_name()
                .map(|name| name.to_owned())
                .unwrap_or_default();
            name.push(suffix);
            std::fs::rename(&source, to.with_file_name(name))
                .map_err(|err| io_err(format!("rename sidecar: {err}")))?;
        }
    }
    Ok(())
}

fn rebuild_path(db_path: &Path) -> PathBuf {
    let mut name = db_path
        .file_name()
        .map(|name| name.to_owned())
        .unwrap_or_default();
    name.push(".rebuild");
    db_path.with_file_name(name)
}

fn unique_bad_path(db_path: &Path) -> Result<PathBuf, ArtifactError> {
    let base_ms = unix_ms_now()?;
    for suffix in 0..1000i64 {
        let mut name = db_path
            .file_name()
            .map(|name| name.to_owned())
            .unwrap_or_default();
        let tag = if suffix == 0 {
            format!(".bad-{base_ms}")
        } else {
            format!(".bad-{base_ms}-{suffix}")
        };
        name.push(tag);
        let candidate = db_path.with_file_name(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(io_err("no free aside name for history.db"))
}

/// Complete a rebuild interrupted between the step-6 renames: the old file
/// is already aside and only the rebuilt file remains. Called from database
/// open before any creation, so a crashed rebuild can never strand a session
/// without a database.
pub(crate) fn complete_interrupted_rename(db_path: &Path) -> Result<bool, ArtifactError> {
    if db_path.exists() {
        return Ok(false);
    }
    let rebuild_path = rebuild_path(db_path);
    if !rebuild_path.exists() {
        return Ok(false);
    }
    std::fs::rename(&rebuild_path, db_path)
        .map_err(|err| io_err(format!("complete rebuild rename: {err}")))?;
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() {
            fsync_dir(parent).map_err(|err| io_err(err.to_string()))?;
        }
    }
    Ok(true)
}

fn copy_canonical_tables(src: &Connection, dst: &HistoryDatabase) -> Result<(), ArtifactError> {
    verify_blob_hashes(src)?;
    verify_artifact_references(src)?;
    let guard = dst.lock();
    let dst_conn: &Connection = &guard;
    let escaped = src
        .path()
        .map(|path| path.replace('\'', "''"))
        .unwrap_or_default();
    if escaped.is_empty() {
        return Err(io_err("rebuild source has no path"));
    }
    dst_conn
        .execute_batch(&format!("ATTACH DATABASE '{escaped}' AS rebuild_src;"))
        .map_err(map_sqlite)?;
    let outcome = dst_conn
        .execute_batch(
            "INSERT INTO artifact_blobs SELECT * FROM rebuild_src.artifact_blobs;
             INSERT INTO artifacts SELECT * FROM rebuild_src.artifacts;",
        )
        .map_err(map_sqlite);
    let _ = dst_conn.execute_batch("DETACH DATABASE rebuild_src;");
    outcome
}

fn verify_blob_hashes(src: &Connection) -> Result<(), ArtifactError> {
    let mut stmt = src
        .prepare("SELECT sha256, canonical_result FROM artifact_blobs")
        .map_err(map_sqlite)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .map_err(map_sqlite)?;
    for row in rows {
        let (sha256, bytes) = row.map_err(map_sqlite)?;
        if Sha256Digest::digest_bytes(&bytes).as_str() != sha256 {
            return Err(ArtifactError::new(
                "HISTORY_CANONICAL_DB_CORRUPT",
                "artifact blob body fails SHA-256",
            ));
        }
    }
    Ok(())
}

fn verify_artifact_references(src: &Connection) -> Result<(), ArtifactError> {
    let dangling: i64 = src
        .query_row(
            "SELECT COUNT(*) FROM artifacts a
             LEFT JOIN artifact_blobs b ON b.blob_id = a.blob_id
             WHERE b.blob_id IS NULL OR a.result_sha256 != b.sha256",
            [],
            |row| row.get(0),
        )
        .map_err(map_sqlite)?;
    if dangling != 0 {
        return Err(ArtifactError::new(
            "HISTORY_CANONICAL_DB_CORRUPT",
            "artifact row fails canonical reference check",
        ));
    }
    Ok(())
}

fn full_integrity_check(conn: &Connection) -> Result<(), ArtifactError> {
    let rows: Vec<String> = conn
        .prepare("PRAGMA integrity_check")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|_| {
            ArtifactError::new(
                "HISTORY_CANONICAL_DB_CORRUPT",
                "integrity_check could not be read",
            )
        })?;
    if rows != ["ok"] {
        return Err(ArtifactError::new(
            "HISTORY_CANONICAL_DB_CORRUPT",
            "integrity_check failed",
        ));
    }
    let foreign: Vec<String> = conn
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut stmt| {
            stmt.query_map([], |row| {
                // Table, rowid, referenced table, failing index: keep the
                // table name for the message below.
                let table: String = row.get(0)?;
                Ok(table)
            })?
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
            format!("foreign_key_check failed: {}", foreign.join(",")),
        ));
    }
    conn.execute(
        "INSERT INTO search_fts(search_fts) VALUES('integrity-check')",
        [],
    )
    .map_err(|_| {
        ArtifactError::new(
            "HISTORY_CANONICAL_DB_CORRUPT",
            "search_fts integrity check failed",
        )
    })?;
    Ok(())
}
