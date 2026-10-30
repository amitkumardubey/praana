//! Derived-table rebuild (History §9.4).
//!
//! A checkpoint mismatch, unclean shutdown, or explicit rebuild performs full
//! integrity checks and, when only derived tables fail, rebuilds them in a
//! fresh `history.db.rebuild` file: copy and hash-verify the canonical
//! artifact tables and the canonical operation-record ledger in one read
//! snapshot of the attached source, replay the valid event prefix into all
//! derived tables, run full integrity checks, fsync, then atomically rename
//! the old database aside and the rebuilt database into place. Operation
//! records are preserved unchanged (History §2.1): they are canonical and
//! cannot be rebuilt from the event log. A corrupt canonical table or a body
//! that fails SHA-256 stops the rebuild with
//! `HISTORY_CANONICAL_DB_CORRUPT`; a body is never rebuilt from an excerpt
//! or summary.
//!
//! Publication is one-way. Nothing beside the live path is deleted after the
//! rebuilt file is in place: any `-wal` / `-shm` that appears from then on
//! belongs to a connection opened on the new file, and removing it would
//! discard that connection's committed frames. A failed swap before
//! publication restores the original and fsyncs the directory before the
//! write lock is released. When the main file cannot be restored, the
//! remaining live-named sidecars are moved beside the aside database, so the
//! next open cannot pair them with the rebuilt file it promotes.

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

/// History §9.4 steps 1–6. The rebuild takes the write lock on this
/// connection before the copy snapshot and holds it until the swap commits.
/// Writes from other connections wait on that lock. Once the rebuild
/// commits, those writes fail with `HISTORY_FILE_REPLACED` on ordinary
/// tables instead of landing in the renamed-aside file. A handle opened
/// before the rebuild can still read the old file; it must be dropped and
/// re-opened afterwards. On success this handle is re-opened on the
/// replaced file.
///
/// A failure before publication rolls the tombstone back and leaves the
/// original intact and writable; a failure after publication keeps the swap
/// and reports the error. A failed fence commit is always reported, even
/// when another post-publication error came first.
pub(crate) fn rebuild_derived_tables(
    db: &HistoryDatabase,
    log: &EventLogStore,
) -> Result<(), ArtifactError> {
    let db_path = db.path().to_path_buf();
    let session_dir = log.session_dir().to_path_buf();
    rebuild_hook("history.rebuild_before_begin", &db_path)?;

    // Held until this function returns. BEGIN IMMEDIATE runs before the copy,
    // so another connection's commit is either already in the snapshot or
    // blocked. After the swap commits, a blocked writer fails with
    // HISTORY_FILE_REPLACED on ordinary tables instead of writing the
    // renamed-aside file. A connection opened earlier can still read that
    // file and must be dropped and re-opened.
    let mut guard = db.lock();
    let first = {
        let conn: &Connection = &guard;
        let mut held = HeldWrite { conn, open: false };
        conn.execute_batch("BEGIN IMMEDIATE;").map_err(map_sqlite)?;
        held.open = true;
        prepare_and_swap(&mut held, &db_path, &session_dir, log)
    }?;

    if let Err(err) = rebuild_hook("history.rebuild_reopen", &db_path) {
        return Err(first.unwrap_or(err));
    }
    if let Err(err) = db.reopen(&mut guard) {
        return Err(first.unwrap_or(err));
    }
    match first {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

struct HeldWrite<'a> {
    conn: &'a Connection,
    open: bool,
}

impl Drop for HeldWrite<'_> {
    fn drop(&mut self) {
        if self.open {
            let _ = self.conn.execute_batch("ROLLBACK;");
        }
    }
}

struct Relocation {
    from: PathBuf,
    to: PathBuf,
    main: bool,
}

fn prepare_and_swap(
    held: &mut HeldWrite<'_>,
    db_path: &Path,
    session_dir: &Path,
    log: &EventLogStore,
) -> Result<Option<ArtifactError>, ArtifactError> {
    rebuild_hook("history.rebuild_after_begin", db_path).map_err(|err| abort(held, err))?;
    install_fence_triggers(held.conn).map_err(|err| abort(held, err))?;

    let rebuild_path = rebuild_path(db_path);
    if rebuild_path.exists() {
        std::fs::remove_file(&rebuild_path)
            .map_err(|err| abort(held, io_err(format!("remove stale rebuild: {err}"))))?;
    }
    let rebuild_db = HistoryDatabase::open(&rebuild_path).map_err(|err| abort(held, err))?;
    copy_canonical_tables(held.conn, &rebuild_db).map_err(|err| abort(held, err))?;

    rebuild_crash("history.rebuild_after_copy");
    rebuild_hook("history.rebuild_after_copy", db_path).map_err(|err| abort(held, err))?;

    HistoryProjector::new(&rebuild_db)
        .project(log)
        .map_err(|err| abort(held, err))?;

    {
        let guard = rebuild_db.lock();
        let dst: &Connection = &guard;
        dst.execute("INSERT INTO search_fts(search_fts) VALUES('rebuild')", [])
            .map_err(|err| abort(held, map_sqlite(err)))?;
        full_integrity_check(dst).map_err(|err| abort(held, err))?;
        drop(guard);
        rebuild_db
            .wal_checkpoint_truncate()
            .map_err(|err| abort(held, err))?;
    }
    drop(rebuild_db);
    File::open(&rebuild_path)
        .and_then(|file| file.sync_all())
        .map_err(|err| abort(held, io_err(format!("fsync rebuild: {err}"))))?;

    let bad_path = unique_bad_path(db_path).map_err(|err| abort(held, err))?;
    let mut moved = Vec::new();
    std::fs::rename(db_path, &bad_path).map_err(|err| {
        fail_swap(
            held,
            db_path,
            &bad_path,
            &moved,
            io_err(format!("rename aside: {err}")),
        )
    })?;
    moved.push(Relocation {
        from: db_path.to_path_buf(),
        to: bad_path.clone(),
        main: true,
    });

    rebuild_hook("history.rebuild_swap_sidecar", db_path)
        .map_err(|err| fail_swap(held, db_path, &bad_path, &moved, err))?;
    for suffix in ["-wal", "-shm"] {
        let source = sidecar_path(db_path, suffix);
        if source.exists() {
            let dest = sidecar_path(&bad_path, suffix);
            std::fs::rename(&source, &dest).map_err(|err| {
                fail_swap(
                    held,
                    db_path,
                    &bad_path,
                    &moved,
                    io_err(format!("rename sidecar: {err}")),
                )
            })?;
            moved.push(Relocation {
                from: source,
                to: dest,
                main: false,
            });
        }
    }

    rebuild_hook("history.rebuild_swap_replace", db_path)
        .map_err(|err| fail_swap(held, db_path, &bad_path, &moved, err))?;
    std::fs::rename(&rebuild_path, db_path).map_err(|err| {
        fail_swap(
            held,
            db_path,
            &bad_path,
            &moved,
            io_err(format!("rename rebuild into place: {err}")),
        )
    })?;

    let mut first: Option<ArtifactError> = None;
    // Publication is complete: the live path now names the rebuilt database and
    // nothing below is undone. The old database's `-wal` / `-shm` were renamed
    // aside with it, so any sidecar that appears from here on belongs to a
    // connection opened on the new file. Deleting it would discard that
    // connection's committed frames, so it is left alone.
    if let Err(err) = rebuild_hook("history.rebuild_after_publish", db_path) {
        first = Some(err);
    }
    if let Err(err) = fsync_dir(session_dir) {
        if first.is_none() {
            first = Some(io_err(err.to_string()));
        }
    }
    if let Err(err) = rebuild_hook("history.rebuild_after_replace_fsync", db_path) {
        if first.is_none() {
            first = Some(err);
        }
    }

    rebuild_crash("history.rebuild_after_rename");
    if let Err(err) = rebuild_hook("history.rebuild_after_rename", db_path) {
        if first.is_none() {
            first = Some(err);
        }
    }
    if let Err(err) = commit_fence(held.conn, db_path) {
        // A failed fence is the safety-relevant outcome even when an earlier
        // post-publication error already happened, so it is never dropped.
        first = Some(match first.take() {
            Some(prior) => merge_errors(prior, err),
            None => err,
        });
    }
    held.open = false;
    Ok(first)
}

fn abort(held: &mut HeldWrite<'_>, err: ArtifactError) -> ArtifactError {
    let err = rollback_combining(held.conn, err);
    held.open = false;
    err
}

fn fail_swap(
    held: &mut HeldWrite<'_>,
    db_path: &Path,
    bad_path: &Path,
    moved: &[Relocation],
    cause: ArtifactError,
) -> ArtifactError {
    let err = match undo_relocations(db_path, bad_path, moved) {
        // The original is back in place. Make the restoration durable before
        // the write lock is released and other handles may commit again: an
        // unsynced reverse rename could otherwise be lost in a power failure
        // and expose an intermediate swap layout.
        Ok(()) if db_path.exists() => match fsync_parent(db_path) {
            Ok(()) => cause,
            Err(sync) => recovery_error(
                db_path,
                bad_path,
                &format!("the restored original was not synced: {sync}"),
            ),
        },
        // Nothing could be restored: history.db is missing. Live-named sidecars
        // must not stay beside it, because the next open promotes
        // `history.db.rebuild` and would replay those frames into it.
        Ok(()) => match quarantine_orphan_sidecars(db_path, bad_path) {
            Ok(()) => recovery_error(db_path, bad_path, "history.db was not restored"),
            Err(quarantine) => merge_errors(
                recovery_error(db_path, bad_path, "history.db was not restored"),
                quarantine,
            ),
        },
        // Undo stopped partway, so the live main file is still missing and some
        // sidecars may already be back under their live names.
        Err(err) => match quarantine_orphan_sidecars(db_path, bad_path) {
            Ok(()) => err,
            Err(quarantine) => merge_errors(err, quarantine),
        },
    };
    let err = rollback_combining(held.conn, err);
    held.open = false;
    err
}

/// Move live-named `-wal` / `-shm` beside the aside database when the main
/// file could not be restored. Those files belong to the old database, and a
/// missing `history.db` with a live-named WAL would be paired with the rebuilt
/// file by the next open's interrupted-rename recovery.
fn quarantine_orphan_sidecars(db_path: &Path, bad_path: &Path) -> Result<(), ArtifactError> {
    if db_path.exists() {
        return Ok(());
    }
    let mut moved_any = false;
    for suffix in ["-wal", "-shm"] {
        let live = sidecar_path(db_path, suffix);
        if !live.exists() {
            continue;
        }
        let aside = sidecar_path(bad_path, suffix);
        let target = if aside.exists() {
            let tag = unix_ms_now()?;
            sidecar_path(bad_path, &format!("{suffix}.orphan-{tag}"))
        } else {
            aside
        };
        std::fs::rename(&live, &target).map_err(|err| {
            io_err(format!(
                "orphan sidecar quarantine failed: {err}; {} -> {}",
                live.display(),
                target.display()
            ))
        })?;
        moved_any = true;
    }
    if moved_any {
        fsync_parent(db_path)?;
    }
    Ok(())
}

fn fsync_parent(path: &Path) -> Result<(), ArtifactError> {
    let parent = path.parent().unwrap_or(Path::new("."));
    if parent.as_os_str().is_empty() {
        return Ok(());
    }
    fsync_dir(parent).map_err(|err| io_err(err.to_string()))
}

/// Combine two failures without losing either: the earlier one keeps its code
/// and stays first in the message, and the later one's text is appended so a
/// safety-relevant follow-up (for example `fence incomplete`) is never hidden.
fn merge_errors(first: ArtifactError, later: ArtifactError) -> ArtifactError {
    ArtifactError::new(
        first.code(),
        format!("{}; {}", first.message(), later.message()),
    )
}

fn undo_relocations(
    db_path: &Path,
    bad_path: &Path,
    moved: &[Relocation],
) -> Result<(), ArtifactError> {
    let mut first = true;
    for step in moved.iter().rev() {
        if first {
            first = false;
            rebuild_hook("history.rebuild_swap_undo_first", db_path).map_err(|err| {
                recovery_error(db_path, bad_path, &format!("undo stopped: {err}"))
            })?;
        }
        if step.main {
            rebuild_hook("history.rebuild_swap_undo_main", db_path).map_err(|err| {
                recovery_error(db_path, bad_path, &format!("undo stopped: {err}"))
            })?;
        }
        std::fs::rename(&step.to, &step.from).map_err(|err| {
            recovery_error(
                db_path,
                bad_path,
                &format!(
                    "undo rename failed: {err}; {} -> {}",
                    step.to.display(),
                    step.from.display()
                ),
            )
        })?;
    }
    Ok(())
}

fn recovery_error(db_path: &Path, bad_path: &Path, detail: &str) -> ArtifactError {
    let wal = sidecar_path(db_path, "-wal");
    let shm = sidecar_path(db_path, "-shm");
    let bad_wal = sidecar_path(bad_path, "-wal");
    let bad_shm = sidecar_path(bad_path, "-shm");
    io_err(format!(
        "swap failed; manual recovery is needed; other connections are not fenced; {detail}; \
         history.db {} at {}; history.db-wal {} at {}; history.db-shm {} at {}; \
         aside {} at {}; aside-wal {} at {}; aside-shm {} at {}",
        exists_word(db_path),
        db_path.display(),
        exists_word(&wal),
        wal.display(),
        exists_word(&shm),
        shm.display(),
        exists_word(bad_path),
        bad_path.display(),
        exists_word(&bad_wal),
        bad_wal.display(),
        exists_word(&bad_shm),
        bad_shm.display(),
    ))
}

fn exists_word(path: &Path) -> &'static str {
    if path.exists() {
        "present"
    } else {
        "missing"
    }
}

fn rollback_combining(conn: &Connection, err: ArtifactError) -> ArtifactError {
    match conn.execute_batch("ROLLBACK;") {
        Ok(()) if conn.is_autocommit() => err,
        Ok(()) => io_err(format!(
            "{err}; ROLLBACK returned but the transaction is still open"
        )),
        Err(rollback) => io_err(format!(
            "{err}; ROLLBACK failed; the transaction is still open: {rollback}"
        )),
    }
}

fn commit_fence(conn: &Connection, db_path: &Path) -> Result<(), ArtifactError> {
    if let Err(err) = rebuild_hook("history.rebuild_commit", db_path) {
        return fence_incomplete(conn, err);
    }
    match conn.execute_batch("COMMIT;") {
        Ok(()) if conn.is_autocommit() => Ok(()),
        Ok(()) => fence_incomplete(
            conn,
            io_err("COMMIT returned but a transaction is still open"),
        ),
        Err(err) => fence_incomplete(conn, map_sqlite(err)),
    }
}

fn fence_incomplete(conn: &Connection, err: ArtifactError) -> Result<(), ArtifactError> {
    if !conn.is_autocommit() {
        if let Err(rollback) = conn.execute_batch("ROLLBACK;") {
            return Err(io_err(format!(
                "fence incomplete; ROLLBACK failed; the transaction is still open: {rollback}; {err}"
            )));
        }
        if !conn.is_autocommit() {
            return Err(io_err(format!(
                "fence incomplete; the transaction is still open after ROLLBACK; {err}"
            )));
        }
    }
    Err(io_err(format!("fence incomplete: {err}")))
}

fn install_fence_triggers(conn: &Connection) -> Result<(), ArtifactError> {
    let mut stmt = conn
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .map_err(map_sqlite)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(map_sqlite)?;
    let mut tables = Vec::new();
    for row in rows {
        tables.push(row.map_err(map_sqlite)?);
    }
    drop(stmt);
    for (name, sql) in tables {
        if sql.as_deref().is_some_and(is_virtual_table_sql) {
            continue;
        }
        for (event, keyword) in [
            ("insert", "INSERT"),
            ("update", "UPDATE"),
            ("delete", "DELETE"),
        ] {
            let trigger = quote_ident(&format!("praana_fence_{name}_{event}"));
            let table = quote_ident(&name);
            conn.execute_batch(&format!(
                "CREATE TRIGGER {trigger} BEFORE {keyword} ON {table} \
                 BEGIN SELECT RAISE(ABORT, 'HISTORY_FILE_REPLACED'); END;"
            ))
            .map_err(map_sqlite)?;
        }
    }
    Ok(())
}

fn is_virtual_table_sql(sql: &str) -> bool {
    sql.trim_start()
        .to_ascii_uppercase()
        .starts_with("CREATE VIRTUAL")
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn rebuild_hook(label: &str, path: &Path) -> Result<(), ArtifactError> {
    #[cfg(feature = "failpoints")]
    {
        crate::crash_point::check_rebuild_hook(label, path)
            .map_err(|err| io_err(err.to_string()))?;
    }
    #[cfg(not(feature = "failpoints"))]
    {
        let _ = (label, path);
    }
    Ok(())
}

fn rebuild_crash(label: &str) {
    #[cfg(feature = "failpoints")]
    crate::crash_point::hit(label);
    #[cfg(not(feature = "failpoints"))]
    {
        let _ = label;
    }
}

fn sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut name = db_path
        .file_name()
        .map(|name| name.to_owned())
        .unwrap_or_default();
    name.push(suffix);
    db_path.with_file_name(name)
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
    // Verification and copy share one transaction on the attached source, so
    // a failing insert rolls back the whole copy: nothing half-copied ever
    // survives. A row that violates a destination constraint means the
    // canonical source is corrupt and must stop the rebuild (History §9.4),
    // so the INSERT batch is classified separately from other SQLite errors.
    let outcome = (|| {
        dst_conn.execute_batch("BEGIN").map_err(map_sqlite)?;
        verify_blob_hashes(dst_conn, "rebuild_src.")?;
        verify_artifact_references(dst_conn, "rebuild_src.")?;
        dst_conn
            .execute_batch(
                "INSERT INTO artifact_blobs SELECT * FROM rebuild_src.artifact_blobs;
                 INSERT INTO artifacts SELECT * FROM rebuild_src.artifacts;
                 INSERT INTO operation_records(operation_id, ui_contract_schema_version, operation_kind, request_sha256, status, session_id, planned_effects_json, result_json, result_sha256, first_canonical_sequence, terminal_canonical_sequence, created_at_ms, finished_at_ms)
                 SELECT operation_id, ui_contract_schema_version, operation_kind, request_sha256, status, session_id, planned_effects_json, result_json, result_sha256, first_canonical_sequence, terminal_canonical_sequence, created_at_ms, finished_at_ms FROM rebuild_src.operation_records;",
            )
            .map_err(classify_copy_error)?;
        dst_conn.execute_batch("COMMIT").map_err(map_sqlite)
    })();
    if outcome.is_err() {
        let _ = dst_conn.execute_batch("ROLLBACK");
    }
    // DETACH must not fail on the success path: the live source would stay
    // attached to this connection, which later runs full_integrity_check
    // (covering every attached database) and wal_checkpoint_truncate.
    let detach = dst_conn.execute_batch("DETACH DATABASE rebuild_src;");
    match outcome {
        Ok(()) => detach.map_err(map_sqlite)?,
        Err(err) => {
            let _ = detach;
            return Err(err);
        }
    }
    Ok(())
}

/// Classify the INSERT batch failures of the canonical copy. A constraint
/// violation on the destination means the canonical source itself violates a
/// destination CHECK / UNIQUE / STRICT / FOREIGN KEY rule, so the rebuild
/// must stop with `HISTORY_CANONICAL_DB_CORRUPT` (History §9.4). Every other
/// SQLite error keeps the `map_sqlite` mapping wholesale.
fn classify_copy_error(err: rusqlite::Error) -> ArtifactError {
    match &err {
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            ArtifactError::new(
                "HISTORY_CANONICAL_DB_CORRUPT",
                format!("canonical row violates destination constraint: {err}"),
            )
        }
        _ => map_sqlite(err),
    }
}

fn verify_blob_hashes(conn: &Connection, qualifier: &str) -> Result<(), ArtifactError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT sha256, canonical_result FROM {qualifier}artifact_blobs"
        ))
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

fn verify_artifact_references(conn: &Connection, qualifier: &str) -> Result<(), ArtifactError> {
    let dangling: i64 = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM {qualifier}artifacts a
                 LEFT JOIN {qualifier}artifact_blobs b ON b.blob_id = a.blob_id
                 WHERE b.blob_id IS NULL OR a.result_sha256 != b.sha256"
            ),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sqlite_error(raw_code: i32, message: &str) -> rusqlite::Error {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(raw_code),
            Some(message.to_owned()),
        )
    }

    #[test]
    fn copy_error_constraint_violation_is_canonical_corrupt() {
        let err = classify_copy_error(sqlite_error(
            rusqlite::ffi::SQLITE_CONSTRAINT,
            "CHECK constraint failed: operation_kind",
        ));
        assert_eq!(err.code(), "HISTORY_CANONICAL_DB_CORRUPT");
        assert!(err.message().contains("operation_kind"));
    }

    #[test]
    fn copy_error_non_constraint_keeps_map_sqlite_mapping() {
        let busy = classify_copy_error(sqlite_error(
            rusqlite::ffi::SQLITE_BUSY,
            "database is locked",
        ));
        assert_eq!(busy.code(), "HISTORY_SQLITE_BUSY");
        let io = classify_copy_error(sqlite_error(rusqlite::ffi::SQLITE_IOERR, "disk I/O error"));
        assert_eq!(io.code(), "HISTORY_IO");
    }
}
