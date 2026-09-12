//! Canonical append-only event store, exclusive writer lock, and startup repair.
//!
//! Platform notes: Unix enforces private modes (`0700`/`0600`), `O_NOFOLLOW`,
//! and single-writer ownership via advisory locks (`fs2`). Outside Unix, private
//! ACLs are not yet implemented in std: permission establishment fails closed
//! with `HISTORY_INSECURE_PERMISSIONS`, while the cross-process writer lock
//! is maintained via `fs2`. Directory fsync outside Unix remains a no-op.

/// Internal diagnostic code emitted as a recoverable warning when an existing session
/// file or directory had wider permissions and was tightened to the required private mode.
pub const WARN_HISTORY_PERMISSIONS_TIGHTENED: &str = "HISTORY_PERMISSIONS_TIGHTENED";

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use crate::clock::{Clock, SystemClock};
use crate::history::replay::EventReplayer;
use crate::protocol::constants::*;
use crate::protocol::errors::{HistoryError, HistoryResult};
use crate::protocol::events::{CanonicalEvent, EventEnvelope};
use crate::protocol::hashes::{calculate_prefix_hash, calculate_sha256};
use crate::protocol::id::{ProjectionId, SessionId, Sha256Digest};
use crate::protocol::json::{deserialize_event_strict, serialize_event_compact};

thread_local! {
    static FAIL_AFTER_SUCCESSFUL_FSYNCS: std::cell::Cell<Option<usize>> =
        const { std::cell::Cell::new(None) };
    static SUCCESSFUL_FSYNCS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static FAIL_AFTER_META_TMP_FSYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_AFTER_META_RENAME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Test-only failpoint: fail the next append `fsync`.
pub fn fail_next_fsync() {
    fail_after_n_successful_fsyncs(0);
}

/// Test-only failpoint: succeed `n` append fsyncs, then fail.
pub fn fail_after_n_successful_fsyncs(n: usize) {
    SUCCESSFUL_FSYNCS.with(|count| count.set(0));
    FAIL_AFTER_SUCCESSFUL_FSYNCS.with(|flag| flag.set(Some(n)));
}

/// Test-only failpoint: fail immediately after `meta.json.tmp` fsync before rename (History §15.2 point 4).
pub fn fail_after_meta_tmp_fsync(fail: bool) {
    FAIL_AFTER_META_TMP_FSYNC.with(|flag| flag.set(fail));
}

/// Test-only failpoint: fail immediately after `meta.json` rename before directory fsync (History §15.2 point 5).
pub fn fail_after_meta_rename(fail: bool) {
    FAIL_AFTER_META_RENAME.with(|flag| flag.set(fail));
}

/// Test-only failpoint reset.
pub fn reset_fsync_injection() {
    SUCCESSFUL_FSYNCS.with(|count| count.set(0));
    FAIL_AFTER_SUCCESSFUL_FSYNCS.with(|flag| flag.set(None));
    FAIL_AFTER_META_TMP_FSYNC.with(|flag| flag.set(false));
    FAIL_AFTER_META_RENAME.with(|flag| flag.set(false));
}

fn sync_file(file: &File) -> std::io::Result<()> {
    let should_fail = FAIL_AFTER_SUCCESSFUL_FSYNCS.with(|flag| {
        flag.get()
            .is_some_and(|limit| SUCCESSFUL_FSYNCS.with(|count| count.get() >= limit))
    });
    if should_fail {
        FAIL_AFTER_SUCCESSFUL_FSYNCS.with(|flag| flag.set(None));
        return Err(std::io::Error::other("injected fsync failure"));
    }
    file.sync_all()?;
    SUCCESSFUL_FSYNCS.with(|count| count.set(count.get() + 1));
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionMetaV1 {
    pub schema_version: u32,
    pub session_id: SessionId,
    pub created_at_ms: i64,
    pub cwd: String,
    pub agent_id: String,
    pub config_schema_version: u32,
    pub config_digest_sha256: Sha256Digest,
    pub event_schema_version: u32,
    pub history_schema_version: u32,
    pub projection_version: ProjectionId,
    pub token_estimator_schema_version: u32,
    pub unicode_utility_version: String,
    pub system_context_schema_version: u32,
    pub provider_registry_schema_version: u32,
    pub builtin_tool_catalog_schema_version: u32,
    pub redaction_version: String,
    pub ui_contract_schema_version: u32,
    pub cursor_hmac_key_base64: String,
    pub creator_version: String,
}

pub struct EventLogStore {
    session_dir: PathBuf,
    session_id: SessionId,
    file: File,
    _lock_file: File,
    replayer: EventReplayer,
    current_sequence: u64,
    current_prefix_hash: [u8; 32],
    quarantined_tail: Option<String>,
    unhealthy: bool,
    events: Vec<EventEnvelope>,
    raw_lines: Vec<String>,
    snapshot_max_steps: u32,
    warnings: Vec<HistoryError>,
}

impl std::fmt::Debug for EventLogStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventLogStore")
            .field("session_dir", &self.session_dir)
            .field("session_id", &self.session_id)
            .field("current_sequence", &self.current_sequence)
            .field("quarantined_tail", &self.quarantined_tail)
            .field("unhealthy", &self.unhealthy)
            .finish()
    }
}

impl EventLogStore {
    pub fn create_or_open(session_dir: &Path, expected_session_id: &str) -> HistoryResult<Self> {
        let mut warnings = Vec::new();
        let session_id = SessionId::from_str_canonical(expected_session_id)?;
        apply_session_umask();
        reject_symlink(session_dir)?;
        let directory_created = !session_dir.exists();
        fs::create_dir_all(session_dir).map_err(|_| insecure())?;
        if let Some(w) = establish_mode(session_dir, 0o700)? {
            warnings.push(w);
        }

        let lock_path = session_dir.join("session.lock");
        reject_symlink(&lock_path)?;
        let lock_created = !lock_path.exists();
        let mut lock_options = OpenOptions::new();
        lock_options.read(true).write(true).create(true);
        #[cfg(unix)]
        lock_options
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        let mut lock_file = lock_options.open(&lock_path).map_err(|_| history_io())?;
        if let Some(w) = establish_mode(&lock_path, 0o600)? {
            warnings.push(w);
        }

        use fs2::FileExt;
        if lock_file.try_lock_exclusive().is_err() {
            return Err(HistoryError::new("E_SESSION_LOCKED", None, None, false));
        }
        write_lock_metadata(&mut lock_file)?;

        let events_path = session_dir.join("events.jsonl");
        reject_symlink(&events_path)?;
        let events_existed = events_path.exists();
        let events_created = !events_existed;
        let preexisting_empty_events = events_existed
            && fs::metadata(&events_path)
                .map(|meta| meta.len() == 0)
                .unwrap_or(false);
        let mut append_options = OpenOptions::new();
        append_options.write(true).append(true).create(true);
        #[cfg(unix)]
        append_options
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        let mut file = append_options
            .open(&events_path)
            .map_err(|_| history_io())?;
        if let Some(w) = establish_mode(&events_path, 0o600)? {
            warnings.push(w);
        }
        if directory_created || lock_created || events_created {
            fsync_dir(session_dir)?;
        }

        let mut content = Vec::new();
        let mut read_options = OpenOptions::new();
        read_options.read(true);
        #[cfg(unix)]
        read_options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        read_options
            .open(&events_path)
            .map_err(|_| history_io())?
            .read_to_end(&mut content)
            .map_err(|_| history_io())?;

        let ScanResult {
            replayer,
            current_sequence,
            current_prefix_hash,
            quarantined_tail,
            events,
            raw_lines,
            read_only,
            warnings: scan_warnings,
        } = scan_and_repair(session_dir, &events_path, &mut file, &content, session_id)?;
        warnings.extend(scan_warnings);

        if preexisting_empty_events && current_sequence == 0 {
            return Err(HistoryError::new(
                "E_SESSION_NOT_STARTED",
                None,
                None,
                false,
            ));
        }

        let meta_path = session_dir.join("meta.json");
        if events_created && current_sequence == 0 {
            write_new_session_meta(session_dir, &session_id)?;
        } else {
            verify_session_meta(session_dir, &session_id, &events)?;
            if let Some(w) = establish_mode(&meta_path, 0o600)? {
                warnings.push(w);
            }
            let snapshot_path = session_dir.join("config.snapshot.json");
            if snapshot_path.exists() {
                if let Some(w) = establish_mode(&snapshot_path, 0o600)? {
                    warnings.push(w);
                }
            }
        }
        if directory_created || lock_created || events_created || !meta_path.exists() {
            fsync_dir(session_dir)?;
        }
        let snapshot_max_steps = load_snapshot_config(session_dir)?.turn.max_steps;

        Ok(Self {
            session_dir: session_dir.to_path_buf(),
            session_id,
            file,
            _lock_file: lock_file,
            replayer,
            current_sequence,
            current_prefix_hash,
            quarantined_tail,
            unhealthy: read_only,
            events,
            raw_lines,
            snapshot_max_steps,
            warnings,
        })
    }

    pub fn open(session_dir: &Path, expected_session_id: &str) -> HistoryResult<Self> {
        let store = Self::create_or_open(session_dir, expected_session_id)?;
        if store.current_sequence == 0 {
            return Err(HistoryError::new(
                "E_SESSION_NOT_STARTED",
                None,
                None,
                false,
            ));
        }
        Ok(store)
    }

    pub fn read_events_from_path(path: &Path) -> HistoryResult<Vec<EventEnvelope>> {
        parse_path(path, false)
    }

    pub fn read_and_validate_from_path(path: &Path) -> HistoryResult<Vec<EventEnvelope>> {
        parse_path(path, true)
    }

    pub fn append_event(&mut self, envelope: &EventEnvelope) -> HistoryResult<()> {
        if self.unhealthy {
            return Err(HistoryError::new(
                "E_EVENT_DURABILITY_UNCERTAIN",
                Some(envelope.sequence),
                None,
                false,
            ));
        }
        if envelope.session_id != self.session_id {
            return Err(HistoryError::new(
                "E_SESSION_ID_MISMATCH",
                Some(envelope.sequence),
                None,
                false,
            ));
        }
        let mut candidate = self.replayer.clone();
        candidate.process_event(envelope, None, Some(&self.raw_lines))?;
        let json = serialize_event_compact(envelope)?;
        if json.len() > 16_777_216 {
            return Err(HistoryError::new(
                "E_EVENT_TOO_LARGE",
                Some(envelope.sequence),
                None,
                false,
            ));
        }
        let mut line = json.into_bytes();
        line.push(b'\n');
        if self
            .file
            .write_all(&line)
            .and_then(|_| self.file.flush())
            .and_then(|_| sync_file(&self.file))
            .is_err()
        {
            self.unhealthy = true;
            return Err(HistoryError::new(
                "E_EVENT_DURABILITY_UNCERTAIN",
                Some(envelope.sequence),
                None,
                false,
            ));
        }
        self.replayer = candidate;
        self.current_prefix_hash =
            calculate_prefix_hash(&self.current_prefix_hash, envelope.sequence, &line);
        self.current_sequence = envelope.sequence;
        self.raw_lines
            .push(String::from_utf8(line).expect("compact JSONL is UTF-8"));
        self.events.push(envelope.clone());
        Ok(())
    }

    pub fn current_sequence(&self) -> u64 {
        self.current_sequence
    }

    pub fn current_prefix_hash(&self) -> [u8; 32] {
        self.current_prefix_hash
    }

    pub fn prefix_hash(&self) -> [u8; 32] {
        self.current_prefix_hash
    }

    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub fn session_dir(&self) -> &Path {
        &self.session_dir
    }

    pub fn quarantined_tail(&self) -> Option<&str> {
        self.quarantined_tail.as_deref()
    }

    pub fn is_unhealthy(&self) -> bool {
        self.unhealthy
    }

    pub fn raw_lines(&self) -> &[String] {
        &self.raw_lines
    }

    pub fn snapshot_max_steps(&self) -> u32 {
        self.snapshot_max_steps
    }

    pub fn events(&self) -> HistoryResult<Vec<EventEnvelope>> {
        Ok(self.events.clone())
    }

    pub fn warnings(&self) -> &[HistoryError] {
        &self.warnings
    }
}

struct ScanResult {
    replayer: EventReplayer,
    current_sequence: u64,
    current_prefix_hash: [u8; 32],
    quarantined_tail: Option<String>,
    events: Vec<EventEnvelope>,
    raw_lines: Vec<String>,
    read_only: bool,
    warnings: Vec<HistoryError>,
}

fn scan_and_repair(
    session_dir: &Path,
    events_path: &Path,
    append_file: &mut File,
    content: &[u8],
    expected_session_id: SessionId,
) -> HistoryResult<ScanResult> {
    let mut replayer = EventReplayer::new();
    let mut prefix = [0u8; 32];
    let mut valid_end = 0usize;
    let mut cursor = 0usize;
    let mut line_number = 0usize;
    let mut raw_lines = Vec::new();
    let mut events = Vec::new();
    let mut quarantined = None;
    let mut warnings = Vec::new();
    let read_only = false;

    while let Some(relative) = content[cursor..].iter().position(|byte| *byte == b'\n') {
        line_number += 1;
        let end = cursor + relative + 1;
        let line_with_lf = &content[cursor..end];
        let body = &line_with_lf[..line_with_lf.len() - 1];
        if body.is_empty() {
            return Err(HistoryError::new(
                "E_JSONL_NON_FINAL_MALFORMED",
                None,
                Some(line_number),
                false,
            ));
        }
        if body.ends_with(b"\r") {
            if end < content.len() {
                return Err(HistoryError::new(
                    "E_JSONL_NON_FINAL_MALFORMED",
                    extract_sequence(body),
                    Some(line_number),
                    false,
                ));
            }
            quarantined = Some(persist_quarantine(
                session_dir,
                events_path,
                valid_end,
                line_with_lf,
            )?);
            warnings.push(HistoryError::new(
                "E_JSONL_FINAL_TRUNCATED",
                extract_sequence(body),
                Some(line_number),
                true,
            ));
            break;
        }
        // Classify before deciding torn-tail vs integrity failure (§14.1):
        // only a line that is not complete JSON (bad UTF-8 or JSON syntax)
        // is a truncation candidate. A complete JSON value that fails exact
        // schema validation (wrong schema_version, unknown/duplicate field,
        // scalar violation) surfaces its narrow code — even on the final
        // line — so an old-schema session can never be silently quarantined
        // and reopened as a fresh session (§4.4 MUST stop).
        let event = match parse_scan_line(body, line_number)? {
            Some(event) => event,
            None => {
                if end < content.len() {
                    return Err(HistoryError::new(
                        "E_JSONL_NON_FINAL_MALFORMED",
                        extract_sequence(body),
                        Some(line_number),
                        false,
                    ));
                }
                quarantined = Some(persist_quarantine(
                    session_dir,
                    events_path,
                    valid_end,
                    line_with_lf,
                )?);
                warnings.push(HistoryError::new(
                    "E_JSONL_FINAL_TRUNCATED",
                    extract_sequence(body),
                    Some(line_number),
                    true,
                ));
                break;
            }
        };
        if event.session_id != expected_session_id {
            return Err(HistoryError::new(
                "E_SESSION_ID_MISMATCH",
                Some(event.sequence),
                Some(line_number),
                false,
            ));
        }
        raw_lines.push(String::from_utf8(line_with_lf.to_vec()).map_err(|_| {
            HistoryError::new(
                "E_JSONL_NON_FINAL_MALFORMED",
                Some(event.sequence),
                Some(line_number),
                false,
            )
        })?);
        replayer.process_event(&event, Some(line_number), Some(&raw_lines))?;
        prefix = calculate_prefix_hash(&prefix, event.sequence, line_with_lf);
        events.push(event);
        valid_end = end;
        cursor = end;
    }

    if quarantined.is_none() && cursor < content.len() {
        line_number += 1;
        let remainder = &content[cursor..];
        // Same classification as LF-terminated lines: a torn remainder is
        // quarantined, but a complete JSON value that fails schema validation
        // is a narrow integrity failure, never a truncation candidate.
        let event = match parse_scan_line(remainder, line_number)? {
            Some(event) => event,
            None => {
                quarantined = Some(persist_quarantine(
                    session_dir,
                    events_path,
                    valid_end,
                    remainder,
                )?);
                warnings.push(HistoryError::new(
                    "E_JSONL_FINAL_TRUNCATED",
                    extract_sequence(remainder),
                    Some(line_number),
                    true,
                ));
                return Ok(ScanResult {
                    current_sequence: replayer.current_sequence(),
                    current_prefix_hash: prefix,
                    replayer,
                    quarantined_tail: quarantined,
                    events,
                    raw_lines,
                    read_only,
                    warnings,
                });
            }
        };
        {
            if event.session_id != expected_session_id {
                return Err(HistoryError::new(
                    "E_SESSION_ID_MISMATCH",
                    Some(event.sequence),
                    Some(line_number),
                    false,
                ));
            }
            let mut repaired_line = remainder.to_vec();
            repaired_line.push(b'\n');
            raw_lines.push(String::from_utf8(repaired_line.clone()).map_err(|_| {
                HistoryError::new(
                    "E_JSONL_FINAL_TRUNCATED",
                    Some(event.sequence),
                    Some(line_number),
                    true,
                )
            })?);
            replayer.process_event(&event, Some(line_number), Some(&raw_lines))?;
            append_file
                .write_all(b"\n")
                .and_then(|_| append_file.flush())
                .and_then(|_| sync_file(append_file))
                .map_err(|_| durability())?;
            prefix = calculate_prefix_hash(&prefix, event.sequence, &repaired_line);
            events.push(event);
        }
    }

    Ok(ScanResult {
        current_sequence: replayer.current_sequence(),
        current_prefix_hash: prefix,
        replayer,
        quarantined_tail: quarantined,
        events,
        raw_lines,
        read_only,
        warnings,
    })
}

/// Parses one raw JSONL line during the startup scan.
///
/// Returns `Ok(None)` only when the bytes are not a complete JSON value
/// (bad UTF-8 or JSON syntax) — the torn-write case that §14.1 quarantines
/// when final and rejects as `E_JSONL_NON_FINAL_MALFORMED` otherwise.
/// A complete JSON value that fails exact schema validation returns its
/// narrow error (`E_SCHEMA_VERSION_UNSUPPORTED`, `E_EVENT_SCHEMA_INVALID`,
/// `E_EVENT_TOO_LARGE`, …) with sequence/line provenance, so schema damage
/// is never mistaken for a truncatable tail.
fn parse_scan_line(body: &[u8], line_number: usize) -> HistoryResult<Option<EventEnvelope>> {
    let text = match std::str::from_utf8(body) {
        Ok(text) => text,
        Err(_) => return Ok(None),
    };
    if serde_json::from_str::<serde_json::Value>(text).is_err() {
        return Ok(None);
    }
    deserialize_event_strict::<EventEnvelope>(text)
        .map(Some)
        .map_err(|error| {
            HistoryError::new(error.code, extract_sequence(body), Some(line_number), false)
        })
}

fn parse_path(path: &Path, validate: bool) -> HistoryResult<Vec<EventEnvelope>> {
    let bytes = fs::read(path).map_err(|_| HistoryError::new("HISTORY_IO", None, None, false))?;
    let mut events = Vec::new();
    let mut raw_lines = Vec::new();
    let mut replayer = EventReplayer::new();
    let mut cursor = 0usize;
    let mut line = 0usize;
    while cursor < bytes.len() {
        line += 1;
        let lf = bytes[cursor..].iter().position(|byte| *byte == b'\n');
        let (body, next, terminated) = match lf {
            Some(relative) => (
                &bytes[cursor..cursor + relative],
                cursor + relative + 1,
                true,
            ),
            None => (&bytes[cursor..], bytes.len(), false),
        };
        if body.is_empty() {
            return Err(HistoryError::new(
                "E_JSONL_NON_FINAL_MALFORMED",
                None,
                Some(line),
                false,
            ));
        }
        if body.ends_with(b"\r") {
            return Err(HistoryError::new(
                if terminated && next < bytes.len() {
                    "E_JSONL_NON_FINAL_MALFORMED"
                } else {
                    "E_JSONL_FINAL_TRUNCATED"
                },
                extract_sequence(body),
                Some(line),
                !terminated || next == bytes.len(),
            ));
        }
        let text = std::str::from_utf8(body).map_err(|_| {
            HistoryError::new(
                if terminated && next < bytes.len() {
                    "E_JSONL_NON_FINAL_MALFORMED"
                } else {
                    "E_JSONL_FINAL_TRUNCATED"
                },
                None,
                Some(line),
                !terminated || next == bytes.len(),
            )
        })?;
        let event = deserialize_event_strict::<EventEnvelope>(text).map_err(|error| {
            let syntactic = serde_json::from_str::<serde_json::Value>(text).is_ok();
            if !syntactic {
                HistoryError::new(
                    if terminated && next < bytes.len() {
                        "E_JSONL_NON_FINAL_MALFORMED"
                    } else {
                        "E_JSONL_FINAL_TRUNCATED"
                    },
                    extract_sequence(body),
                    Some(line),
                    !terminated || next == bytes.len(),
                )
            } else {
                HistoryError::new(error.code, extract_sequence(body), Some(line), false)
            }
        })?;
        let mut exact = body.to_vec();
        exact.push(b'\n');
        raw_lines.push(String::from_utf8(exact).map_err(|_| {
            HistoryError::new(
                "E_EVENT_SCHEMA_INVALID",
                Some(event.sequence),
                Some(line),
                false,
            )
        })?);
        if validate {
            replayer.process_event(&event, Some(line), Some(&raw_lines))?;
        }
        events.push(event);
        cursor = next;
    }
    Ok(events)
}

fn reject_symlink(path: &Path) -> HistoryResult<()> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err(insecure());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn apply_session_umask() {
    unsafe {
        libc::umask(0o077);
    }
}

#[cfg(not(unix))]
fn apply_session_umask() {}

#[cfg(unix)]
fn establish_mode(path: &Path, mode: u32) -> HistoryResult<Option<HistoryError>> {
    let actual = fs::symlink_metadata(path)
        .map_err(|_| insecure())?
        .permissions()
        .mode()
        & 0o777;
    if actual == mode {
        return Ok(None);
    }
    let extra = actual & !mode;
    let missing = mode & !actual;
    if extra != 0 && missing == 0 {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|_| insecure())?;
        let after = fs::symlink_metadata(path)
            .map_err(|_| insecure())?
            .permissions()
            .mode()
            & 0o777;
        if after != mode {
            return Err(insecure());
        }
        return Ok(Some(HistoryError::new(
            WARN_HISTORY_PERMISSIONS_TIGHTENED,
            None,
            None,
            true,
        )));
    }
    Err(insecure())
}

#[cfg(not(unix))]
fn establish_mode(_path: &Path, _mode: u32) -> HistoryResult<Option<HistoryError>> {
    // History §3: On non-Unix platforms where private ACLs are not yet established,
    // session creation fails closed rather than proceeding with world-readable permissions.
    Err(insecure())
}

fn write_lock_metadata(file: &mut File) -> HistoryResult<()> {
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| durability())?;
    let nonce = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let started = process_start_time().unwrap_or_else(|| "unknown".to_owned());
    file.set_len(0).map_err(|_| durability())?;
    file.seek(SeekFrom::Start(0)).map_err(|_| durability())?;
    write!(
        file,
        "pid={}\nprocess_start={started}\nowner_nonce={nonce}\n",
        std::process::id()
    )
    .and_then(|_| file.flush())
    .and_then(|_| file.sync_all())
    .map_err(|_| durability())
}

fn process_start_time() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let stat = fs::read_to_string("/proc/self/stat").ok()?;
        return stat
            .rsplit_once(") ")?
            .1
            .split_whitespace()
            .nth(19)
            .map(str::to_owned);
    }
    #[cfg(target_os = "macos")]
    {
        let pid = std::process::id() as libc::pid_t;
        let mut info: libc::kinfo_proc = unsafe { std::mem::zeroed() };
        let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid];
        let mut size = std::mem::size_of::<libc::kinfo_proc>();
        let rc = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                mib.len() as u32,
                &mut info as *mut _ as *mut libc::c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 {
            return None;
        }
        return Some(format!(
            "{}.{}",
            info.kp_proc.p_starttime.tv_sec, info.kp_proc.p_starttime.tv_usec
        ));
    }
    #[cfg(windows)]
    {
        type Handle = *mut std::ffi::c_void;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentProcess() -> Handle;
            fn GetProcessTimes(
                process: Handle,
                creation: *mut u64,
                exit: *mut u64,
                kernel: *mut u64,
                user: *mut u64,
            ) -> i32;
        }
        unsafe {
            let mut creation = 0u64;
            let mut exit = 0u64;
            let mut kernel = 0u64;
            let mut user = 0u64;
            if GetProcessTimes(
                GetCurrentProcess(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            ) == 0
            {
                return None;
            }
            return Some(creation.to_string());
        }
    }
    #[allow(unreachable_code)]
    Some(std::process::id().to_string())
}

fn persist_quarantine(
    session_dir: &Path,
    events_path: &Path,
    valid_end: usize,
    bytes: &[u8],
) -> HistoryResult<String> {
    let sha = quarantine_tail_bytes(session_dir, bytes)?;
    truncate_after_quarantine(session_dir, events_path, valid_end)?;
    Ok(sha)
}

pub fn history_creation_config() -> crate::config::EffectiveConfigV1 {
    crate::config::build_defaults(Path::new("/praana-home"))
}

pub fn write_config_snapshot_durable(
    session_dir: &Path,
    config: &crate::config::EffectiveConfigV1,
) -> HistoryResult<String> {
    reject_symlink(session_dir)?;
    let dest = session_dir.join("config.snapshot.json");
    if dest.exists() {
        return Err(HistoryError::new(
            "HISTORY_META_MISMATCH",
            None,
            None,
            false,
        ));
    }
    let tmp = session_dir.join("config.snapshot.json.tmp");
    reject_symlink(&tmp)?;
    if tmp.exists() {
        fs::remove_file(&tmp).map_err(|_| durability())?;
    }
    let mut bytes = config.to_canonical_json_bytes();
    let digest = calculate_sha256(&bytes).to_string();
    bytes.push(b'\n');
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options.open(&tmp).map_err(|_| durability())?;
    let _ = establish_mode(&tmp, 0o600)?;
    file.write_all(&bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|_| durability())?;
    drop(file);
    rename_without_replacement(&tmp, &dest)?;
    let _ = establish_mode(&dest, 0o600)?;
    fsync_dir(session_dir)?;
    Ok(digest)
}

fn rename_without_replacement(from: &Path, to: &Path) -> HistoryResult<()> {
    if to.exists() {
        return Err(HistoryError::new(
            "HISTORY_META_MISMATCH",
            None,
            None,
            false,
        ));
    }
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        let from_c = CString::new(from.to_string_lossy().as_bytes()).map_err(|_| durability())?;
        let to_c = CString::new(to.to_string_lossy().as_bytes()).map_err(|_| durability())?;
        let rc = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from_c.as_ptr(),
                libc::AT_FDCWD,
                to_c.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if rc != 0 {
            return Err(durability());
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        fs::rename(from, to).map_err(|_| durability())
    }
}

fn load_snapshot_config(session_dir: &Path) -> HistoryResult<crate::config::EffectiveConfigV1> {
    let path = session_dir.join("config.snapshot.json");
    if !path.exists() {
        return Err(HistoryError::new(
            "HISTORY_META_MISMATCH",
            None,
            None,
            false,
        ));
    }
    reject_symlink(&path)?;
    let bytes = fs::read(&path).map_err(|_| history_io())?;
    let canonical = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    serde_json::from_slice(canonical)
        .map_err(|_| HistoryError::new("HISTORY_META_MISMATCH", None, None, false))
}

fn ensure_config_snapshot(session_dir: &Path) -> HistoryResult<String> {
    if session_dir.join("config.snapshot.json").exists() {
        return snapshot_digest(session_dir)
            .ok_or_else(|| HistoryError::new("HISTORY_META_MISMATCH", None, None, false));
    }
    write_config_snapshot_durable(session_dir, &history_creation_config())
}

pub fn write_new_session_meta(session_dir: &Path, session_id: &SessionId) -> HistoryResult<()> {
    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|_| durability())?;
    let digest = ensure_config_snapshot(session_dir)?;
    let cwd = std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_owned());
    let meta = SessionMetaV1 {
        schema_version: 1,
        session_id: *session_id,
        created_at_ms: SystemClock.now_ms(),
        cwd,
        agent_id: "praana".to_owned(),
        config_schema_version: 1,
        config_digest_sha256: Sha256Digest(digest),
        event_schema_version: EVENT_SCHEMA_VERSION,
        history_schema_version: 1,
        projection_version: ProjectionId::from_str_canonical(PROJECTION_VERSION)?,
        token_estimator_schema_version: TOKEN_ESTIMATOR_SCHEMA_VERSION,
        unicode_utility_version: UNICODE_UTILITY_VERSION.to_owned(),
        system_context_schema_version: SYSTEM_CONTEXT_SCHEMA_VERSION,
        provider_registry_schema_version: PROVIDER_REGISTRY_SCHEMA_VERSION,
        builtin_tool_catalog_schema_version: BUILTIN_TOOL_CATALOG_SCHEMA_VERSION,
        redaction_version: REDACTION_VERSION.to_owned(),
        ui_contract_schema_version: UI_CONTRACT_SCHEMA_VERSION,
        cursor_hmac_key_base64: encode_base64(&key),
        creator_version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    write_meta_file(session_dir, &meta)
}

fn write_meta_file(session_dir: &Path, meta: &SessionMetaV1) -> HistoryResult<()> {
    reject_symlink(session_dir)?;
    let dest = session_dir.join("meta.json");
    if dest.exists() {
        return Err(HistoryError::new(
            "HISTORY_META_MISMATCH",
            None,
            None,
            false,
        ));
    }
    let tmp = session_dir.join("meta.json.tmp");
    reject_symlink(&tmp)?;
    if tmp.exists() {
        fs::remove_file(&tmp).map_err(|_| durability())?;
    }
    let mut json = serde_json::to_vec(meta).map_err(|_| durability())?;
    json.push(b'\n');
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options.open(&tmp).map_err(|_| durability())?;
    let _ = establish_mode(&tmp, 0o600)?;
    file.write_all(&json)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|_| durability())?;
    drop(file);

    // History §15.2 crash point 4: crash immediately after meta.json.tmp fsync before rename
    if FAIL_AFTER_META_TMP_FSYNC.with(|flag| flag.get()) {
        FAIL_AFTER_META_TMP_FSYNC.with(|flag| flag.set(false));
        return Err(durability());
    }

    rename_without_replacement(&tmp, &dest)?;
    let _ = establish_mode(&dest, 0o600)?;

    // History §15.2 crash point 5: crash immediately after rename before directory fsync
    if FAIL_AFTER_META_RENAME.with(|flag| flag.get()) {
        FAIL_AFTER_META_RENAME.with(|flag| flag.set(false));
        return Err(durability());
    }

    fsync_dir(session_dir)?;
    Ok(())
}

fn verify_session_meta(
    session_dir: &Path,
    session_id: &SessionId,
    events: &[EventEnvelope],
) -> HistoryResult<()> {
    let path = session_dir.join("meta.json");
    if !path.exists() {
        return Err(HistoryError::new(
            "HISTORY_META_MISMATCH",
            None,
            None,
            false,
        ));
    }
    reject_symlink(&path)?;
    let bytes = fs::read(&path).map_err(|_| history_io())?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| HistoryError::new("HISTORY_META_MISMATCH", None, None, false))?;
    let text = text.trim_end_matches('\n');
    let meta: SessionMetaV1 = serde_json::from_str(text)
        .map_err(|_| HistoryError::new("HISTORY_META_MISMATCH", None, None, false))?;
    if meta.session_id != *session_id
        || meta.event_schema_version != EVENT_SCHEMA_VERSION
        || meta.schema_version != 1
    {
        return Err(HistoryError::new(
            "HISTORY_META_MISMATCH",
            None,
            None,
            false,
        ));
    }
    let digest = snapshot_digest(session_dir)
        .ok_or_else(|| HistoryError::new("HISTORY_META_MISMATCH", None, None, false))?;
    if meta.config_digest_sha256.as_str() != digest {
        return Err(HistoryError::new(
            "HISTORY_META_MISMATCH",
            None,
            None,
            false,
        ));
    }
    if let Some(CanonicalEvent::SessionStarted(started)) = events.first().map(|event| &event.event)
    {
        if started.config_digest_sha256 != meta.config_digest_sha256
            || events[0].session_id != meta.session_id
        {
            return Err(HistoryError::new(
                "HISTORY_META_MISMATCH",
                None,
                None,
                false,
            ));
        }
    }
    Ok(())
}

fn snapshot_digest(session_dir: &Path) -> Option<String> {
    let path = session_dir.join("config.snapshot.json");
    let bytes = fs::read(&path).ok()?;
    let canonical = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    Some(calculate_sha256(canonical).to_string())
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let remaining = bytes.len() - index;
        let b0 = bytes[index];
        let b1 = if remaining > 1 { bytes[index + 1] } else { 0 };
        let b2 = if remaining > 2 { bytes[index + 2] } else { 0 };
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if remaining == 1 {
            out.push('=');
            out.push('=');
        } else {
            out.push(TABLE[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
            if remaining == 2 {
                out.push('=');
            } else {
                out.push(TABLE[(b2 & 0x3f) as usize] as char);
            }
        }
        index += 3;
    }
    out
}

fn quarantine_tail_bytes(session_dir: &Path, bytes: &[u8]) -> HistoryResult<String> {
    let sha = calculate_sha256(bytes).to_string();
    let directory = session_dir.join("quarantine");
    reject_symlink(&directory)?;
    fs::create_dir_all(&directory).map_err(|_| durability())?;
    let _ = establish_mode(&directory, 0o700).map_err(|_| durability())?;
    let path = directory.join(format!("events-tail-{sha}.bin"));
    reject_symlink(&path)?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let mut file = options.open(&path).map_err(|_| durability())?;
    let _ = establish_mode(&path, 0o600).map_err(|_| durability())?;
    file.write_all(bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
        .map_err(|_| durability())?;
    fsync_dir(&directory)?;
    Ok(sha)
}

fn truncate_after_quarantine(
    session_dir: &Path,
    events_path: &Path,
    valid_end: usize,
) -> HistoryResult<()> {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    let file = options.open(events_path).map_err(|_| durability())?;
    file.set_len(valid_end as u64).map_err(|_| durability())?;
    file.sync_all().map_err(|_| durability())?;
    fsync_dir(session_dir)
}

#[cfg(unix)]
fn fsync_dir(path: &Path) -> HistoryResult<()> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| durability())
}

#[cfg(not(unix))]
fn fsync_dir(_path: &Path) -> HistoryResult<()> {
    // Directory handles and advisory locking have no std-only portable equivalent.
    Ok(())
}

fn extract_sequence(bytes: &[u8]) -> Option<u64> {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|value| value.get("sequence").and_then(|value| value.as_u64()))
}

fn insecure() -> HistoryError {
    HistoryError::new("HISTORY_INSECURE_PERMISSIONS", None, None, false)
}

fn history_io() -> HistoryError {
    HistoryError::new("HISTORY_IO", None, None, false)
}

fn durability() -> HistoryError {
    HistoryError::new("E_EVENT_DURABILITY_UNCERTAIN", None, None, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn fsync_failure_does_not_bump_sequence() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/protocol_v2/01_committed_text_turn/events.jsonl");
        let events = parse_path(&fixture, false).unwrap();
        let temp = TempDir::new().unwrap();
        let session_dir = temp.path().join("session");
        let mut store =
            EventLogStore::create_or_open(&session_dir, "01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap();
        assert_eq!(store.current_sequence(), 0);
        fail_next_fsync();
        let err = store.append_event(&events[0]).unwrap_err();
        assert_eq!(err.code(), "E_EVENT_DURABILITY_UNCERTAIN");
        assert_eq!(store.current_sequence(), 0);
        assert!(store.is_unhealthy());
    }

    #[test]
    fn creation_config_digest_is_stable() {
        let digest = history_creation_config().config_digest_sha256().to_string();
        assert_eq!(
            digest,
            "1aecaa286f1f61128b79b8ff623dfc99bf40a786ce0997bb6d7a00f101328760"
        );
    }
}
