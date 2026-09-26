//! Multi-file rollback journals. Replacement is write, fsync, rename, parent fsync.
//! A target that no longer matches the recorded identity is left untouched.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::error::{io_err, map_ledger, ArtifactError};
use super::operation_ledger::{
    apply_private_dir_permissions, apply_private_file_permissions, apply_private_umask, fsync_dir,
    reject_symlink,
};
use crate::protocol::id::{SessionId, Sha256Digest, ToolBatchId, ToolCallId, ToolExecutionId};
use serde::{Deserialize, Serialize};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct JournalWrite {
    pub ordinal: u32,
    pub target_path: PathBuf,
    pub new_bytes: Vec<u8>,
}

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
pub enum WriteJournalPhase {
    Prepared,
    Committing,
    Committed,
    RollbackRequired,
}

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
#[serde(
    tag = "platform",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum FileIdentityV1 {
    Unix {
        device: u64,
        inode: u64,
        size: u64,
        mtime_ns: i64,
        ctime_ns: i64,
    },
    #[allow(dead_code)]
    Windows {
        volume_serial: u64,
        file_id_hex: String,
        size: u64,
        last_write_100ns: u64,
    },
}

pub fn prepare_write_journal(
    session_root: &Path,
    workspace_root: &Path,
    session_id: &SessionId,
    execution_id: &ToolExecutionId,
    batch_id: &ToolBatchId,
    call_id: &ToolCallId,
    writes: &[JournalWrite],
) -> Result<(), ArtifactError> {
    prepare_write_journal_in_roots(
        session_root,
        &[workspace_root.to_path_buf()],
        session_id,
        execution_id,
        batch_id,
        call_id,
        writes,
    )
}

pub fn prepare_write_journal_in_roots(
    session_root: &Path,
    workspace_roots: &[PathBuf],
    session_id: &SessionId,
    execution_id: &ToolExecutionId,
    batch_id: &ToolBatchId,
    call_id: &ToolCallId,
    writes: &[JournalWrite],
) -> Result<(), ArtifactError> {
    apply_private_umask();
    let journals = journals_dir(session_root);
    reject_symlink(&journals).map_err(map_ledger)?;
    fs::create_dir_all(&journals).map_err(|err| io_err(err.to_string()))?;
    apply_private_dir_permissions(&journals).map_err(map_ledger)?;
    let payload = payload_dir(session_root, execution_id);
    reject_symlink(&payload).map_err(map_ledger)?;
    fs::create_dir_all(&payload).map_err(|err| io_err(err.to_string()))?;
    apply_private_dir_permissions(&payload).map_err(map_ledger)?;

    let mut planned: Vec<JournalWrite> = writes.to_vec();
    planned.sort_by(|left, right| {
        display_path(&left.target_path)
            .cmp(&display_path(&right.target_path))
            .then(left.ordinal.cmp(&right.ordinal))
    });
    let mut entries = Vec::with_capacity(planned.len());
    for write in planned {
        confine_target(workspace_roots, &write.target_path)?;
        reject_target(&write.target_path)?;
        let target = absolute_lexical(&write.target_path)?;
        let existed = target.is_file();
        let (original_identity, original_sha256, before_relpath) = if existed {
            let rel = format!("before-{}", write.ordinal);
            let before = payload.join(&rel);
            let digest = copy_and_hash(&target, &before)?;
            apply_private_file_permissions(&before).map_err(map_ledger)?;
            let identity = capture_identity(&target)?;
            (Some(identity), Some(digest), Some(rel))
        } else if target.exists() {
            return Err(io_err(format!(
                "journal target is not a regular file: {}",
                target.display()
            )));
        } else {
            (None, None, None)
        };
        let staged_relpath = format!("staged-{}", write.ordinal);
        let staged = payload.join(&staged_relpath);
        write_new_file(&staged, &write.new_bytes)?;
        entries.push(WriteJournalEntryV1 {
            ordinal: write.ordinal,
            target_path: display_path(&target),
            target_existed: existed,
            original_identity,
            original_sha256,
            before_relpath,
            staged_relpath,
            staged_sha256: Sha256Digest::digest_bytes(&write.new_bytes),
            replacement_identity: None,
        });
    }
    let journal = WriteJournalV1 {
        write_journal_schema_version: 1,
        session_id: *session_id,
        execution_id: *execution_id,
        batch_id: *batch_id,
        call_id: call_id.clone(),
        phase: WriteJournalPhase::Prepared,
        next_entry: 0,
        entries,
    };
    store_journal(session_root, &journal)?;
    fsync_dir(&journals).map_err(map_ledger)?;
    Ok(())
}

pub fn commit_write_journal(
    session_root: &Path,
    workspace_root: &Path,
    execution_id: &ToolExecutionId,
) -> Result<(), ArtifactError> {
    commit_write_journal_in_roots(session_root, &[workspace_root.to_path_buf()], execution_id)
}

pub fn commit_write_journal_in_roots(
    session_root: &Path,
    workspace_roots: &[PathBuf],
    execution_id: &ToolExecutionId,
) -> Result<(), ArtifactError> {
    let mut journal = load_journal(session_root, execution_id)?;
    while (journal.next_entry as usize) < journal.entries.len() {
        let index = journal.next_entry as usize;
        let target = PathBuf::from(&journal.entries[index].target_path);
        confine_target(workspace_roots, &target)?;
        verify_original(&journal.entries[index])?;
        journal.phase = WriteJournalPhase::Committing;
        store_journal(session_root, &journal)?;
        let staged = read_rel(
            session_root,
            execution_id,
            &journal.entries[index].staged_relpath,
        )?;
        if Sha256Digest::digest_bytes(&staged) != journal.entries[index].staged_sha256 {
            return Err(conflict("staged journal bytes changed"));
        }
        atomic_replace(
            &target,
            &staged,
            execution_id,
            journal.entries[index].ordinal,
        )?;
        let identity = capture_identity(&target)?;
        journal.entries[index].replacement_identity = Some(identity);
        journal.next_entry += 1;
        store_journal(session_root, &journal)?;
    }
    journal.phase = WriteJournalPhase::Committed;
    store_journal(session_root, &journal)?;
    Ok(())
}

pub fn rollback_write_journal(
    session_root: &Path,
    workspace_root: &Path,
    execution_id: &ToolExecutionId,
) -> Result<(), ArtifactError> {
    rollback_write_journal_in_roots(session_root, &[workspace_root.to_path_buf()], execution_id)
}

pub fn rollback_write_journal_in_roots(
    session_root: &Path,
    workspace_roots: &[PathBuf],
    execution_id: &ToolExecutionId,
) -> Result<(), ArtifactError> {
    let mut journal = load_journal(session_root, execution_id)?;
    adopt_unrecorded_replacement(session_root, workspace_roots, &mut journal)?;
    let mut index = journal.next_entry as usize;
    while index > 0 {
        index -= 1;
        let target = PathBuf::from(&journal.entries[index].target_path);
        confine_target(workspace_roots, &target)?;
        let entry = journal.entries[index].clone();
        confirm_or_adopt_replacement(session_root, execution_id, &mut journal.entries[index])?;
        restore_entry(session_root, execution_id, &entry)?;
        journal.next_entry = index as u32;
        store_journal(session_root, &journal)?;
    }
    journal.phase = WriteJournalPhase::RollbackRequired;
    store_journal(session_root, &journal)?;
    Ok(())
}

pub fn retire_write_journal(
    session_root: &Path,
    execution_id: &ToolExecutionId,
) -> Result<(), ArtifactError> {
    let json = journal_path(session_root, execution_id);
    let payload = payload_dir(session_root, execution_id);
    if !json.exists() && !payload.exists() {
        return Ok(());
    }
    if json.exists() {
        reject_symlink(&json).map_err(map_ledger)?;
        fs::remove_file(&json).map_err(|err| io_err(err.to_string()))?;
    }
    if payload.exists() {
        reject_symlink(&payload).map_err(map_ledger)?;
        fs::remove_dir_all(&payload).map_err(|err| io_err(err.to_string()))?;
    }
    fsync_dir(&journals_dir(session_root)).map_err(map_ledger)?;
    Ok(())
}

pub fn reconcile_unfinished_journals(
    session_root: &Path,
    workspace_root: &Path,
    unfinished: &[ToolExecutionId],
) -> Result<(), ArtifactError> {
    let dir = session_root.join("journals");
    if !dir.exists() {
        return Ok(());
    }
    for execution_id in unfinished {
        let path = dir.join(format!("write-{execution_id}.json"));
        if path.is_file() {
            reconcile_write_journal(session_root, workspace_root, execution_id)?;
        }
    }
    Ok(())
}

pub fn reconcile_write_journal(
    session_root: &Path,
    workspace_root: &Path,
    execution_id: &ToolExecutionId,
) -> Result<(), ArtifactError> {
    let journal = load_journal(session_root, execution_id)?;
    match journal.phase {
        WriteJournalPhase::Prepared | WriteJournalPhase::RollbackRequired => Ok(()),
        WriteJournalPhase::Committing | WriteJournalPhase::Committed => {
            rollback_write_journal(session_root, workspace_root, execution_id)
        }
    }
}

fn adopt_unrecorded_replacement(
    session_root: &Path,
    workspace_roots: &[PathBuf],
    journal: &mut WriteJournalV1,
) -> Result<(), ArtifactError> {
    let index = journal.next_entry as usize;
    if index >= journal.entries.len() {
        return Ok(());
    }
    if journal.entries[index].replacement_identity.is_some() {
        journal.next_entry += 1;
        return store_journal(session_root, journal);
    }
    let target = PathBuf::from(&journal.entries[index].target_path);
    confine_target(workspace_roots, &target)?;
    reject_target(&target)?;
    if !target.exists() {
        if journal.entries[index].target_existed {
            return Err(conflict(
                "target disappeared before replacement identity was recorded",
            ));
        }
        return Ok(());
    }
    let hash = hash_file(&target)?;
    let identity = capture_identity(&target)?;
    let entry = &journal.entries[index];
    let same_original = entry.original_identity.as_ref() == Some(&identity)
        && entry.original_sha256.as_ref() == Some(&hash);
    if same_original {
        return Ok(());
    }
    if hash != entry.staged_sha256 {
        return Err(conflict(
            "target changed in the unrecorded replacement window",
        ));
    }
    journal.entries[index].replacement_identity = Some(identity);
    journal.next_entry += 1;
    store_journal(session_root, journal)
}

fn confirm_or_adopt_replacement(
    session_root: &Path,
    execution_id: &ToolExecutionId,
    entry: &mut WriteJournalEntryV1,
) -> Result<(), ArtifactError> {
    let target = PathBuf::from(&entry.target_path);
    reject_target(&target)?;
    let current_hash = hash_file(&target)?;
    let current_identity = capture_identity(&target)?;
    if current_hash != entry.staged_sha256 {
        return Err(conflict(
            "target bytes no longer match the staged replacement",
        ));
    }
    match &entry.replacement_identity {
        Some(recorded) if recorded == &current_identity => Ok(()),
        Some(_) => Err(conflict(
            "target identity no longer matches the replacement",
        )),
        None => {
            let same_as_original = entry
                .original_identity
                .as_ref()
                .is_some_and(|original| original == &current_identity);
            if same_as_original {
                return Err(conflict(
                    "replacement identity was not recorded and the original identity remains",
                ));
            }
            entry.replacement_identity = Some(current_identity);
            let _ = (session_root, execution_id);
            Ok(())
        }
    }
}

fn restore_entry(
    session_root: &Path,
    execution_id: &ToolExecutionId,
    entry: &WriteJournalEntryV1,
) -> Result<(), ArtifactError> {
    let target = PathBuf::from(&entry.target_path);
    if entry.target_existed {
        let rel = entry
            .before_relpath
            .as_deref()
            .ok_or_else(|| io_err("journal entry is missing before bytes"))?;
        let before = read_rel(session_root, execution_id, rel)?;
        let expected = entry
            .original_sha256
            .as_ref()
            .ok_or_else(|| io_err("journal entry is missing the original hash"))?;
        if &Sha256Digest::digest_bytes(&before) != expected {
            return Err(io_err("before-image hash does not match the journal"));
        }
        atomic_replace(&target, &before, execution_id, entry.ordinal)?;
    } else if target.exists() {
        crate::tools::builtin::confine::remove_regular(&target)
            .map_err(|error| io_err(error.to_string()))?;
        if let Some(parent) = target.parent() {
            fsync_dir(parent).map_err(map_ledger)?;
        }
    }
    Ok(())
}

fn verify_original(entry: &WriteJournalEntryV1) -> Result<(), ArtifactError> {
    let target = PathBuf::from(&entry.target_path);
    reject_target(&target)?;
    if entry.target_existed {
        let identity = capture_identity(&target)?;
        let hash = hash_file(&target)?;
        if entry.original_identity.as_ref() != Some(&identity)
            || entry.original_sha256.as_ref() != Some(&hash)
        {
            return Err(conflict("target changed before the journaled replacement"));
        }
    } else if target.exists() {
        return Err(conflict("target appeared before the journaled replacement"));
    }
    Ok(())
}

fn atomic_replace(
    target: &Path,
    bytes: &[u8],
    _execution_id: &ToolExecutionId,
    _ordinal: u32,
) -> Result<(), ArtifactError> {
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| io_err("journal target has no parent directory"))?;
    crate::tools::builtin::confine::ensure_dir(parent)
        .map_err(|error| io_err(error.to_string()))?;
    crate::tools::builtin::confine::replace_file(target, bytes)
        .map_err(|error| io_err(error.to_string()))
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), ArtifactError> {
    if let Some(parent) = path.parent() {
        reject_symlink(parent).map_err(map_ledger)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|err| io_err(err.to_string()))?;
    file.write_all(bytes)
        .map_err(|err| io_err(err.to_string()))?;
    file.sync_all().map_err(|err| io_err(err.to_string()))?;
    apply_private_file_permissions(path).map_err(map_ledger)?;
    Ok(())
}

fn copy_and_hash(src: &Path, dst: &Path) -> Result<Sha256Digest, ArtifactError> {
    let bytes = crate::tools::builtin::confine::read_regular(src, 16 * 1024 * 1024)
        .map_err(|error| io_err(error.to_string()))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)
        .map_err(|err| io_err(err.to_string()))?;
    output
        .write_all(&bytes)
        .map_err(|err| io_err(err.to_string()))?;
    output.sync_all().map_err(|err| io_err(err.to_string()))?;
    Ok(Sha256Digest::digest_bytes(&bytes))
}

fn hash_file(path: &Path) -> Result<Sha256Digest, ArtifactError> {
    let bytes = crate::tools::builtin::confine::read_regular(path, 16 * 1024 * 1024)
        .map_err(|error| io_err(error.to_string()))?;
    Ok(Sha256Digest::digest_bytes(&bytes))
}

fn read_rel(
    session_root: &Path,
    execution_id: &ToolExecutionId,
    rel: &str,
) -> Result<Vec<u8>, ArtifactError> {
    if rel.contains("..") || rel.contains('/') || rel.contains('\\') {
        return Err(io_err("journal relpath escapes the execution directory"));
    }
    let path = payload_dir(session_root, execution_id).join(rel);
    fs::read(&path).map_err(|err| io_err(err.to_string()))
}

fn store_journal(session_root: &Path, journal: &WriteJournalV1) -> Result<(), ArtifactError> {
    let path = journal_path(session_root, &journal.execution_id);
    let bytes = serde_json::to_vec(journal).map_err(|err| io_err(err.to_string()))?;
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(
        ".{}-{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("journal"),
        seq
    ));
    let write_result = (|| -> Result<(), ArtifactError> {
        write_new_file(&tmp, &bytes)?;
        fs::rename(&tmp, &path).map_err(|err| io_err(err.to_string()))?;
        fsync_dir(&journals_dir(session_root)).map_err(map_ledger)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    write_result
}

fn load_journal(
    session_root: &Path,
    execution_id: &ToolExecutionId,
) -> Result<WriteJournalV1, ArtifactError> {
    let path = journal_path(session_root, execution_id);
    reject_symlink(&path).map_err(map_ledger)?;
    let bytes = fs::read(&path).map_err(|err| io_err(err.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|err| io_err(format!("journal json: {err}")))
}

fn journals_dir(session_root: &Path) -> PathBuf {
    session_root.join("journals")
}

fn payload_dir(session_root: &Path, execution_id: &ToolExecutionId) -> PathBuf {
    journals_dir(session_root).join(format!("write-{execution_id}"))
}

fn journal_path(session_root: &Path, execution_id: &ToolExecutionId) -> PathBuf {
    journals_dir(session_root).join(format!("write-{execution_id}.json"))
}

fn confine_target(workspace_roots: &[PathBuf], target: &Path) -> Result<(), ArtifactError> {
    let target = absolute_lexical(target)?;
    if workspace_roots
        .iter()
        .any(|root| absolute_lexical(root).is_ok_and(|workspace| target.starts_with(&workspace)))
    {
        return Ok(());
    }
    Err(super::error::insecure(format!(
        "journal target is outside the workspace: {}",
        target.display()
    )))
}

fn reject_target(path: &Path) -> Result<(), ArtifactError> {
    reject_symlink(path).map_err(map_ledger)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            reject_symlink(parent).map_err(map_ledger)?;
        }
    }
    Ok(())
}

fn absolute_lexical(path: &Path) -> Result<PathBuf, ArtifactError> {
    if path.is_absolute() {
        Ok(normalize_lexical(path))
    } else {
        let cwd = std::env::current_dir().map_err(|err| io_err(err.to_string()))?;
        Ok(normalize_lexical(&cwd.join(path)))
    }
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn display_path(path: &Path) -> String {
    absolute_lexical(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn conflict(detail: &str) -> ArtifactError {
    ArtifactError::new("HISTORY_ROLLBACK_CONFLICT", detail)
}

#[cfg(unix)]
fn capture_identity(path: &Path) -> Result<FileIdentityV1, ArtifactError> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::symlink_metadata(path).map_err(|err| io_err(err.to_string()))?;
    if meta.file_type().is_symlink() {
        return Err(super::error::insecure(format!(
            "symlink at {}",
            path.display()
        )));
    }
    Ok(FileIdentityV1::Unix {
        device: meta.dev(),
        inode: meta.ino(),
        size: meta.size(),
        mtime_ns: meta
            .mtime()
            .saturating_mul(1_000_000_000)
            .saturating_add(meta.mtime_nsec()),
        ctime_ns: meta
            .ctime()
            .saturating_mul(1_000_000_000)
            .saturating_add(meta.ctime_nsec()),
    })
}

#[cfg(not(unix))]
fn capture_identity(path: &Path) -> Result<FileIdentityV1, ArtifactError> {
    let _ = path;
    Err(ArtifactError::new(
        "HISTORY_IO",
        "file identity is unavailable on this platform",
    ))
}
