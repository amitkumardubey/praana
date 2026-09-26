//! Raw shell spools. Bytes stay private and unredacted. Removal requires a
//! classified execution, a recorded child, exactly one supervisor, and proof
//! that the owner, child, and process tree are dead.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::error::{io_err, map_ledger, ArtifactError};
use super::operation_ledger::{
    apply_private_dir_permissions, apply_private_file_permissions, apply_private_umask, fsync_dir,
    reject_symlink,
};
use crate::protocol::id::{SessionId, ToolBatchId, ToolCallId, ToolExecutionId};

const STREAM_LIMIT: u64 = 64 * 1024 * 1024;
const COMBINED_LIMIT: u64 = 128 * 1024 * 1024;
static SPOOL_IO: Mutex<()> = Mutex::new(());
static MANIFEST_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct ShellProcessIdentity {
    pub child_pid: u32,
    pub child_process_start_id: String,
    pub unix_process_group_id: Option<i32>,
    pub windows_job_nonce: Option<String>,
}

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

pub fn create_shell_spool(
    session_root: &Path,
    session_id: &SessionId,
    execution_id: &ToolExecutionId,
    batch_id: &ToolBatchId,
    call_id: &ToolCallId,
) -> Result<(), ArtifactError> {
    apply_private_umask();
    let spools = session_root.join("spools");
    reject_symlink(&spools).map_err(map_ledger)?;
    fs::create_dir_all(&spools).map_err(|err| io_err(err.to_string()))?;
    apply_private_dir_permissions(&spools).map_err(map_ledger)?;
    let dir = execution_dir(session_root, execution_id);
    reject_symlink(&dir).map_err(map_ledger)?;
    fs::create_dir_all(&dir).map_err(|err| io_err(err.to_string()))?;
    apply_private_dir_permissions(&dir).map_err(map_ledger)?;
    for name in ["stdout.raw", "stderr.raw"] {
        let path = dir.join(name);
        write_private(&path, &[])?;
    }
    let manifest = ShellSpoolManifestV1 {
        shell_spool_schema_version: 1,
        session_id: *session_id,
        execution_id: *execution_id,
        batch_id: *batch_id,
        call_id: call_id.clone(),
        owner_pid: std::process::id(),
        owner_process_start_id: owner_start_id(),
        child_pid: None,
        child_process_start_id: None,
        unix_process_group_id: None,
        windows_job_nonce: None,
        stdout_bytes: 0,
        stderr_bytes: 0,
        finalized: false,
    };
    store_manifest(session_root, &manifest)?;
    fsync_dir(&dir).map_err(map_ledger)?;
    fsync_dir(&spools).map_err(map_ledger)?;
    Ok(())
}

pub async fn append_stdout(
    session_root: &Path,
    execution_id: &ToolExecutionId,
    bytes: &[u8],
) -> Result<(), ArtifactError> {
    let root = session_root.to_path_buf();
    let execution_id = *execution_id;
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || append_stream(&root, &execution_id, "stdout.raw", &bytes))
        .await
        .map_err(|err| io_err(err.to_string()))?
}

pub async fn append_stderr(
    session_root: &Path,
    execution_id: &ToolExecutionId,
    bytes: &[u8],
) -> Result<(), ArtifactError> {
    let root = session_root.to_path_buf();
    let execution_id = *execution_id;
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || append_stream(&root, &execution_id, "stderr.raw", &bytes))
        .await
        .map_err(|err| io_err(err.to_string()))?
}

pub fn record_shell_process(
    session_root: &Path,
    execution_id: &ToolExecutionId,
    identity: &ShellProcessIdentity,
) -> Result<(), ArtifactError> {
    if !start_verifiable(&identity.child_process_start_id) {
        return Err(uncertain("child process start id is unverifiable"));
    }
    if !exactly_one_supervisor(
        identity.unix_process_group_id,
        identity.windows_job_nonce.as_deref(),
    ) {
        return Err(uncertain("spool supervisor identity is missing"));
    }
    let mut manifest = load_manifest(session_root, execution_id)?;
    if !start_verifiable(&manifest.owner_process_start_id) {
        return Err(uncertain("owner process start id is unverifiable"));
    }
    manifest.child_pid = Some(identity.child_pid);
    manifest.child_process_start_id = Some(identity.child_process_start_id.clone());
    manifest.unix_process_group_id = identity.unix_process_group_id;
    manifest.windows_job_nonce = identity.windows_job_nonce.clone();
    store_manifest(session_root, &manifest)
}

pub fn finalize_shell_spool(
    session_root: &Path,
    execution_id: &ToolExecutionId,
) -> Result<(), ArtifactError> {
    let dir = execution_dir(session_root, execution_id);
    for name in ["stdout.raw", "stderr.raw"] {
        let path = dir.join(name);
        let file = OpenOptions::new()
            .read(true)
            .open(&path)
            .map_err(|err| io_err(err.to_string()))?;
        file.sync_all().map_err(|err| io_err(err.to_string()))?;
    }
    let mut manifest = load_manifest(session_root, execution_id)?;
    identity_ready(&manifest)?;
    manifest.stdout_bytes = file_len(&dir.join("stdout.raw"))?;
    manifest.stderr_bytes = file_len(&dir.join("stderr.raw"))?;
    manifest.finalized = true;
    store_manifest(session_root, &manifest)?;
    Ok(())
}

pub fn reconcile_classified_spools(
    session_root: &Path,
    classified: &[ToolExecutionId],
) -> Result<(), ArtifactError> {
    let dir = session_root.join("spools");
    if !dir.exists() {
        return Ok(());
    }
    for execution_id in classified {
        let manifest = dir.join(execution_id.to_string()).join("manifest.json");
        if manifest.is_file() {
            reconcile_shell_spool(session_root, execution_id, true)?;
        }
    }
    Ok(())
}

pub fn reconcile_shell_spool(
    session_root: &Path,
    execution_id: &ToolExecutionId,
    classified: bool,
) -> Result<(), ArtifactError> {
    if !classified {
        return Err(uncertain("spool removal requires a classified execution"));
    }
    let manifest = load_manifest(session_root, execution_id)?;
    identity_ready(&manifest)?;
    require_dead(manifest.owner_pid, &manifest.owner_process_start_id)?;
    let child_pid = manifest.child_pid.expect("identity_ready checks the child");
    let child_start = manifest
        .child_process_start_id
        .clone()
        .expect("identity_ready checks the child");
    require_dead(child_pid, &child_start)?;
    require_tree_dead(&manifest)?;
    let dir = execution_dir(session_root, execution_id);
    fs::remove_dir_all(&dir).map_err(|err| io_err(err.to_string()))?;
    fsync_dir(&session_root.join("spools")).map_err(map_ledger)?;
    Ok(())
}

fn append_stream(
    session_root: &Path,
    execution_id: &ToolExecutionId,
    name: &str,
    bytes: &[u8],
) -> Result<(), ArtifactError> {
    let _guard = SPOOL_IO.lock().unwrap_or_else(|err| err.into_inner());
    let dir = execution_dir(session_root, execution_id);
    let path = dir.join(name);
    reject_symlink(&path).map_err(map_ledger)?;
    let current = file_len(&path)?;
    let other = if name == "stdout.raw" {
        file_len(&dir.join("stderr.raw"))?
    } else {
        file_len(&dir.join("stdout.raw"))?
    };
    let added = bytes.len() as u64;
    if current.saturating_add(added) > STREAM_LIMIT
        || current.saturating_add(other).saturating_add(added) > COMBINED_LIMIT
    {
        return Err(io_err("shell spool exceeded its byte bound"));
    }
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|err| io_err(err.to_string()))?;
    file.write_all(bytes)
        .map_err(|err| io_err(err.to_string()))?;
    file.sync_all().map_err(|err| io_err(err.to_string()))?;
    Ok(())
}

fn store_manifest(
    session_root: &Path,
    manifest: &ShellSpoolManifestV1,
) -> Result<(), ArtifactError> {
    let path = execution_dir(session_root, &manifest.execution_id).join("manifest.json");
    let bytes = serde_json::to_vec(manifest).map_err(|err| io_err(err.to_string()))?;
    let seq = MANIFEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_file_name(format!(".manifest-{}-{seq}.tmp", std::process::id()));
    write_private(&tmp, &bytes)?;
    if let Err(err) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(io_err(err.to_string()));
    }
    if let Some(parent) = path.parent() {
        fsync_dir(parent).map_err(map_ledger)?;
    }
    Ok(())
}

fn load_manifest(
    session_root: &Path,
    execution_id: &ToolExecutionId,
) -> Result<ShellSpoolManifestV1, ArtifactError> {
    let path = execution_dir(session_root, execution_id).join("manifest.json");
    reject_symlink(&path).map_err(map_ledger)?;
    let bytes = fs::read(&path).map_err(|err| io_err(err.to_string()))?;
    serde_json::from_slice(&bytes).map_err(|err| io_err(format!("spool manifest: {err}")))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ArtifactError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|err| io_err(err.to_string()))?;
    file.write_all(bytes)
        .map_err(|err| io_err(err.to_string()))?;
    file.sync_all().map_err(|err| io_err(err.to_string()))?;
    apply_private_file_permissions(path).map_err(map_ledger)?;
    Ok(())
}

fn execution_dir(session_root: &Path, execution_id: &ToolExecutionId) -> PathBuf {
    session_root.join("spools").join(execution_id.to_string())
}

fn file_len(path: &Path) -> Result<u64, ArtifactError> {
    Ok(fs::symlink_metadata(path)
        .map_err(|err| io_err(err.to_string()))?
        .len())
}

fn uncertain(detail: &str) -> ArtifactError {
    ArtifactError::new("HISTORY_OPERATIONAL_RECOVERY_UNCERTAIN", detail)
}

fn owner_start_id() -> String {
    #[cfg(target_os = "linux")]
    {
        match read_start_id(std::process::id()) {
            Ok(Some(start)) => start,
            _ => "unverified".to_owned(),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        "unverified".to_owned()
    }
}

fn start_verifiable(start: &str) -> bool {
    !start.is_empty() && start != "unverified"
}

fn exactly_one_supervisor(unix_pgrp: Option<i32>, windows_job: Option<&str>) -> bool {
    let unix = unix_pgrp.is_some();
    let windows = windows_job.is_some_and(|value| !value.is_empty());
    unix != windows
}

fn identity_ready(manifest: &ShellSpoolManifestV1) -> Result<(), ArtifactError> {
    if !start_verifiable(&manifest.owner_process_start_id) {
        return Err(uncertain("owner process start id is unverifiable"));
    }
    let Some(start) = manifest.child_process_start_id.as_deref() else {
        return Err(uncertain("spool child identity is missing"));
    };
    if manifest.child_pid.is_none() || !start_verifiable(start) {
        return Err(uncertain("spool child identity is missing"));
    }
    if !exactly_one_supervisor(
        manifest.unix_process_group_id,
        manifest.windows_job_nonce.as_deref(),
    ) {
        return Err(uncertain("spool supervisor identity is missing"));
    }
    Ok(())
}

fn require_dead(pid: u32, start_id: &str) -> Result<(), ArtifactError> {
    if !start_verifiable(start_id) {
        return Err(uncertain("process start id is unverifiable"));
    }
    match read_liveness(pid, start_id)? {
        Liveness::Dead => Ok(()),
        Liveness::Alive => Err(uncertain("spool process is still live")),
    }
}

fn require_tree_dead(manifest: &ShellSpoolManifestV1) -> Result<(), ArtifactError> {
    match (
        manifest.unix_process_group_id,
        manifest.windows_job_nonce.as_deref(),
    ) {
        (Some(pgid), None) => {
            if process_group_has_members(pgid)? {
                return Err(uncertain("spool process group is still live"));
            }
            Ok(())
        }
        (None, Some(nonce)) if !nonce.is_empty() => Err(uncertain(
            "windows job cannot be proved dead on this platform",
        )),
        _ => Err(uncertain("spool supervisor identity is missing")),
    }
}

enum Liveness {
    Alive,
    Dead,
}

fn read_liveness(pid: u32, start_id: &str) -> Result<Liveness, ArtifactError> {
    #[cfg(target_os = "linux")]
    {
        match read_start_id(pid)? {
            Some(actual) if actual == start_id => Ok(Liveness::Alive),
            Some(_) | None => Ok(Liveness::Dead),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (pid, start_id);
        Err(uncertain(
            "process identity cannot be proved on this platform",
        ))
    }
}

#[cfg(target_os = "linux")]
fn read_start_id(pid: u32) -> Result<Option<String>, ArtifactError> {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat
            .rsplit_once(") ")
            .and_then(|(_, rest)| rest.split_whitespace().nth(19))
            .map(|start| Ok(Some(start.to_owned())))
            .unwrap_or_else(|| Err(uncertain("process identity cannot be read"))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(uncertain("process identity cannot be read")),
    }
}

#[cfg(target_os = "linux")]
fn process_group_has_members(pgid: i32) -> Result<bool, ArtifactError> {
    let entries = fs::read_dir("/proc").map_err(|_| uncertain("process tree cannot be read"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.chars().all(|ch| ch.is_ascii_digit()) {
            continue;
        }
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some(actual) = stat
            .rsplit_once(") ")
            .and_then(|(_, rest)| rest.split_whitespace().nth(2))
            .and_then(|field| field.parse::<i32>().ok())
        else {
            continue;
        };
        if actual == pgid {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(not(target_os = "linux"))]
fn process_group_has_members(pgid: i32) -> Result<bool, ArtifactError> {
    let _ = pgid;
    Err(uncertain(
        "process identity cannot be proved on this platform",
    ))
}
