//! Whole-session deletion (History §14).
//!
//! Optional retention operates on whole inactive sessions only: no owner lock
//! is held and the latest event/meta activity is older than the retention
//! threshold. Automatic deletion never removes an open, locked, pinned, or
//! integrity-failed session. The rename of the complete directory into
//! `.trash` is the deletion boundary: failure after rename leaves a retryable
//! trash entry and no discoverable live session, while failure before rename
//! leaves the original live session. In P4A this is a core library operation
//! only; no CLI grammar is added (§4A #628).

use std::fs;
use std::path::{Path, PathBuf};

use super::db::HistoryDatabase;
use super::error::{io_err, ArtifactError};
use super::event_log::EventLogStore;
use super::operation_ledger::{apply_private_dir_permissions, fsync_dir, reject_symlink};
use crate::id::ProtocolUlidId;
use crate::protocol::id::{DeletionId, SessionId};

pub struct DeleteSessionOptions {
    /// Caller-attested pin flag. Pin records live outside the session
    /// directory (§14); the scheduler passes its current value here.
    pub pinned: bool,
    pub now_ms: i64,
    pub retention_threshold_ms: i64,
}

/// The outcome of an eligibility-checked deletion attempt. `Pinned` and
/// `Active` are ordinary results, not errors: History §14 keeps a pinned or
/// non-inactive session, and §13 reserves `HISTORY_SESSION_LOCKED` for another
/// mutating owner holding the session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionRetention {
    /// The directory was renamed into `.trash` and removed.
    Deleted(DeletionId),
    /// The caller attested a pin flag.
    Pinned,
    /// The latest event/meta activity is newer than the retention threshold.
    Active { last_activity_ms: i64 },
}

/// History §14: delete one whole session when it is inactive. The session
/// writer lock is acquired first and held through the rename, and the pin,
/// activity, and integrity checks all run under that lock, so an append cannot
/// interleave between the check and the deletion boundary. The handles stay
/// open across the rename and are released at step 6.
pub fn delete_session(
    sessions_root: &Path,
    session_id: &SessionId,
    options: &DeleteSessionOptions,
) -> Result<SessionRetention, ArtifactError> {
    reject_symlink(sessions_root).map_err(super::error::map_ledger)?;
    let session_dir = sessions_root.join(session_id.to_string());
    reject_symlink(&session_dir).map_err(super::error::map_ledger)?;
    if !session_dir.is_dir() {
        return Err(io_err("session directory is absent"));
    }

    // Step 1 + step 3: acquire the writer lock, run pending canonical recovery,
    // and verify the manifest. The lock stays held for the whole function.
    let log = EventLogStore::create_or_open(&session_dir, &session_id.to_string())
        .map_err(map_history_error)?;
    if log.is_unhealthy() {
        return Err(ArtifactError::new(
            "HISTORY_EVENT_INTEGRITY",
            "session log failed integrity recovery",
        ));
    }
    if options.pinned {
        return Ok(SessionRetention::Pinned);
    }
    let latest = latest_activity_ms(&session_dir, options.now_ms)?;
    if options.now_ms.saturating_sub(latest) <= options.retention_threshold_ms {
        return Ok(SessionRetention::Active {
            last_activity_ms: latest,
        });
    }

    // Step 3 (second half): checkpoint and close SQLite when present.
    let db_path = session_dir.join("history.db");
    if db_path.is_file() {
        let db = HistoryDatabase::open(&db_path)?;
        db.wal_checkpoint_truncate()?;
        drop(db);
    }

    // Step 2: private trash directory on the same filesystem (same parent, so
    // the rename below cannot cross filesystems) and a fresh DeletionId.
    let trash_dir = sessions_root.join(".trash");
    if !trash_dir.exists() {
        fs::create_dir_all(&trash_dir).map_err(|err| io_err(format!("create trash: {err}")))?;
    }
    apply_private_dir_permissions(&trash_dir).map_err(super::error::map_ledger)?;
    let deletion_id = DeletionId::from_validated_ulid(ulid::Ulid::generate());
    let trash_entry = trash_dir.join(format!("{session_id}-{deletion_id}"));
    if trash_entry.exists() {
        return Err(io_err("trash entry already exists"));
    }

    // Step 4: the deletion boundary. No replacement of an existing path.
    #[cfg(feature = "failpoints")]
    crate::crash_point::hit("history.deletion_before_rename");
    std::fs::rename(&session_dir, &trash_entry)
        .map_err(|err| io_err(format!("deletion rename: {err}")))?;
    #[cfg(feature = "failpoints")]
    crate::crash_point::hit("history.deletion_after_rename");

    // Step 5: fsync both the sessions root and the trash directory.
    fsync_dir(sessions_root).map_err(|err| io_err(err.to_string()))?;
    fsync_dir(&trash_dir).map_err(|err| io_err(err.to_string()))?;

    // Step 6: release the writer lock (its file now lives in the trash entry),
    // remove that entry recursively, and fsync `.trash` after removal.
    drop(log);
    std::fs::remove_dir_all(&trash_entry)
        .map_err(|err| io_err(format!("remove trash entry: {err}")))?;
    fsync_dir(&trash_dir).map_err(|err| io_err(err.to_string()))?;
    Ok(SessionRetention::Deleted(deletion_id))
}

/// Retry a trash entry left by a crash after the deletion boundary: the live
/// session is already gone, so only the removal and directory fsync remain.
pub fn remove_trash_entry(trash_entry: &Path) -> Result<(), ArtifactError> {
    reject_symlink(trash_entry).map_err(super::error::map_ledger)?;
    std::fs::remove_dir_all(trash_entry)
        .map_err(|err| io_err(format!("remove trash entry: {err}")))?;
    if let Some(parent) = trash_entry.parent() {
        if !parent.as_os_str().is_empty() {
            fsync_dir(parent).map_err(|err| io_err(err.to_string()))?;
        }
    }
    Ok(())
}

fn latest_activity_ms(session_dir: &Path, now_ms: i64) -> Result<i64, ArtifactError> {
    let mut latest: Option<i64> = None;
    for file in ["events.jsonl", "meta.json", "history.db"] {
        let path = session_dir.join(file);
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let modified = metadata
            .modified()
            .map_err(|err| io_err(format!("mtime: {err}")))?;
        let millis = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(now_ms);
        latest = Some(latest.map_or(millis, |best: i64| best.max(millis)));
    }
    // The event log and manifest are mandatory; without them the session is
    // incomplete and is kept, never deleted.
    if !session_dir.join("events.jsonl").is_file() || !session_dir.join("meta.json").is_file() {
        return Err(io_err("session log or manifest is absent"));
    }
    Ok(latest.unwrap_or(0))
}

fn map_history_error(err: crate::protocol::errors::HistoryError) -> ArtifactError {
    if err.code() == "E_SESSION_LOCKED" {
        ArtifactError::new("HISTORY_SESSION_LOCKED", err.to_string())
    } else {
        io_err(err.to_string())
    }
}

pub fn trash_dir_for(sessions_root: &Path) -> PathBuf {
    sessions_root.join(".trash")
}
