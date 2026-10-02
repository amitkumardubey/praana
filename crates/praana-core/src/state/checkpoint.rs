//! `state_graph` projection checkpoint (StateGraph §7, History §5.2).

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::canonical_json::to_canonical_json_bytes;
use crate::history::db::HistoryDatabase;
use crate::history::event_log::EventLogStore;
use crate::protocol::events::EventEnvelope;
use crate::protocol::hashes::calculate_prefix_hash;
use crate::protocol::id::{SessionId, Sha256Digest};
use crate::protocol::state_graph::{StateGraphV1, StateValueV1};

use super::apply::validate_stored_graph;
use super::StateServiceError;

pub const STATE_CHECKPOINT_NAME: &str = "state_graph";
const CHECKPOINT_SCHEMA_VERSION: u32 = 1;
const STATE_PROJECTION_SCHEMA_VERSION: u32 = 1;

#[cfg(feature = "failpoints")]
thread_local! {
    static FAIL_NEXT_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Test-only: the next checkpoint write on this thread fails and is logged without payload text.
#[cfg(feature = "failpoints")]
pub fn fail_next_state_checkpoint() {
    FAIL_NEXT_WRITE.with(|flag| flag.set(true));
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateGraphCheckpointV1 {
    pub checkpoint_schema_version: u32,
    pub state_projection_schema_version: u32,
    pub session_id: SessionId,
    pub reset_epoch: u32,
    pub applied_through_sequence: u64,
    pub event_prefix_hash: Sha256Digest,
    pub snapshot_hash: Sha256Digest,
    pub graph: StateGraphV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckpointFault {
    Missing,
    Parse,
    Session,
    Version,
    Sequence,
    Prefix,
    Snapshot,
    Payload,
    DuplicateId,
    Revision,
    Kind,
    Focus,
    Oversized,
}

pub fn load_checkpoint(
    db: &HistoryDatabase,
    log: &EventLogStore,
) -> Result<Option<StateGraphV1>, CheckpointFault> {
    let conn = db.lock();
    let row: Option<(i64, i64, String, String, String)> = conn
        .query_row(
            "SELECT checkpoint_schema_version, applied_through_sequence, event_prefix_hash, \
             payload_json, payload_hash FROM projection_checkpoints WHERE projection_name = ?1",
            params![STATE_CHECKPOINT_NAME],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| CheckpointFault::Parse)?;
    let Some((schema_version, row_sequence, row_prefix, payload_json, row_hash)) = row else {
        return Ok(None);
    };
    let checkpoint = parse_checkpoint(&payload_json)?;
    validate_checkpoint(
        &checkpoint,
        log,
        schema_version,
        row_sequence,
        &row_prefix,
        &row_hash,
        payload_json.as_bytes(),
    )?;
    Ok(Some(checkpoint.graph))
}

pub fn write_checkpoint(
    db: &HistoryDatabase,
    log: &EventLogStore,
    graph: &StateGraphV1,
    updated_at_ms: i64,
) -> Result<(), StateServiceError> {
    #[cfg(feature = "failpoints")]
    if FAIL_NEXT_WRITE.with(|flag| flag.replace(false)) {
        eprintln!("state checkpoint write failed");
        return Err(StateServiceError::new(
            "STATE_PERSISTENCE",
            "state checkpoint write failed",
        ));
    }
    let checkpoint = match build_checkpoint(log, graph) {
        Ok(checkpoint) => checkpoint,
        Err(error) => {
            eprintln!("state checkpoint write failed");
            return Err(error);
        }
    };
    let payload_json = match to_canonical_json_bytes(&checkpoint) {
        Ok(bytes) => bytes,
        Err(_) => {
            eprintln!("state checkpoint write failed");
            return Err(StateServiceError::new(
                "STATE_PERSISTENCE",
                "state checkpoint write failed",
            ));
        }
    };
    let prefix_raw = decode_digest(&checkpoint.event_prefix_hash).map_err(|_| {
        StateServiceError::new("STATE_PERSISTENCE", "state checkpoint write failed")
    })?;
    let payload_hash = payload_hash(graph.applied_through_sequence, &prefix_raw, &payload_json);
    let payload_text = match String::from_utf8(payload_json) {
        Ok(text) => text,
        Err(_) => {
            eprintln!("state checkpoint write failed");
            return Err(StateServiceError::new(
                "STATE_PERSISTENCE",
                "state checkpoint write failed",
            ));
        }
    };
    let conn = db.lock();
    let write = (|| -> Result<(), StateServiceError> {
        conn.execute("BEGIN IMMEDIATE", []).map_err(persist_err)?;
        conn.execute(
            "INSERT INTO projection_checkpoints( \
                 projection_name, checkpoint_schema_version, applied_through_sequence, \
                 event_prefix_hash, payload_json, payload_hash, updated_at_ms) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             ON CONFLICT(projection_name) DO UPDATE SET \
                 checkpoint_schema_version = excluded.checkpoint_schema_version, \
                 applied_through_sequence = excluded.applied_through_sequence, \
                 event_prefix_hash = excluded.event_prefix_hash, \
                 payload_json = excluded.payload_json, \
                 payload_hash = excluded.payload_hash, \
                 updated_at_ms = excluded.updated_at_ms",
            params![
                STATE_CHECKPOINT_NAME,
                CHECKPOINT_SCHEMA_VERSION as i64,
                graph.applied_through_sequence as i64,
                checkpoint.event_prefix_hash.as_str(),
                payload_text,
                payload_hash.as_str(),
                updated_at_ms,
            ],
        )
        .map_err(persist_err)?;
        conn.execute("COMMIT", []).map_err(persist_err)?;
        Ok(())
    })();
    if let Err(_error) = write {
        let _ = conn.execute("ROLLBACK", []);
        eprintln!("state checkpoint write failed");
        return Err(StateServiceError::new(
            "STATE_PERSISTENCE",
            "state checkpoint write failed",
        ));
    }
    Ok(())
}

pub fn build_checkpoint(
    log: &EventLogStore,
    graph: &StateGraphV1,
) -> Result<StateGraphCheckpointV1, StateServiceError> {
    let prefix = prefix_through(log, graph.applied_through_sequence)?;
    let snapshot = snapshot_hash(graph)?;
    Ok(StateGraphCheckpointV1 {
        checkpoint_schema_version: CHECKPOINT_SCHEMA_VERSION,
        state_projection_schema_version: STATE_PROJECTION_SCHEMA_VERSION,
        session_id: *log.session_id(),
        reset_epoch: graph.reset_epoch,
        applied_through_sequence: graph.applied_through_sequence,
        event_prefix_hash: Sha256Digest::from_bytes(prefix),
        snapshot_hash: snapshot,
        graph: graph.clone(),
    })
}

fn parse_checkpoint(payload_json: &str) -> Result<StateGraphCheckpointV1, CheckpointFault> {
    let value: serde_json::Value =
        serde_json::from_str(payload_json).map_err(|_| CheckpointFault::Parse)?;
    let graph_value = value.get("graph").cloned().ok_or(CheckpointFault::Parse)?;
    if graph_value
        .get("objects")
        .and_then(|objects| objects.as_array())
        .is_some_and(|objects| {
            objects.iter().any(|object| {
                object.get("value").is_some_and(|value| {
                    serde_json::from_value::<StateValueV1>(value.clone()).is_err()
                })
            })
        })
    {
        return Err(CheckpointFault::Kind);
    }
    serde_json::from_value(value).map_err(|_| CheckpointFault::Parse)
}

fn validate_checkpoint(
    checkpoint: &StateGraphCheckpointV1,
    log: &EventLogStore,
    row_schema: i64,
    row_sequence: i64,
    row_prefix: &str,
    row_hash: &str,
    payload_json: &[u8],
) -> Result<(), CheckpointFault> {
    if checkpoint.session_id != *log.session_id() {
        return Err(CheckpointFault::Session);
    }
    if checkpoint.checkpoint_schema_version != CHECKPOINT_SCHEMA_VERSION
        || checkpoint.state_projection_schema_version != STATE_PROJECTION_SCHEMA_VERSION
        || checkpoint.graph.schema_version != 1
        || row_schema != CHECKPOINT_SCHEMA_VERSION as i64
    {
        return Err(CheckpointFault::Version);
    }
    map_graph_fault(&checkpoint.graph)?;
    let snapshot = snapshot_hash(&checkpoint.graph).map_err(|_| CheckpointFault::Snapshot)?;
    if snapshot != checkpoint.snapshot_hash {
        return Err(CheckpointFault::Snapshot);
    }
    let prefix = Sha256Digest::from_hex_str(row_prefix).map_err(|_| CheckpointFault::Prefix)?;
    if prefix != checkpoint.event_prefix_hash {
        return Err(CheckpointFault::Prefix);
    }
    let prefix_raw =
        decode_digest(&checkpoint.event_prefix_hash).map_err(|_| CheckpointFault::Prefix)?;
    let expected_hash = payload_hash(
        checkpoint.applied_through_sequence,
        &prefix_raw,
        payload_json,
    );
    let stored_hash = Sha256Digest::from_hex_str(row_hash).map_err(|_| CheckpointFault::Payload)?;
    if stored_hash != expected_hash {
        return Err(CheckpointFault::Payload);
    }
    if checkpoint.graph.applied_through_sequence != checkpoint.applied_through_sequence
        || row_sequence != checkpoint.applied_through_sequence as i64
        || checkpoint.reset_epoch != checkpoint.graph.reset_epoch
    {
        return Err(CheckpointFault::Sequence);
    }
    let sequence = checkpoint.applied_through_sequence;
    if sequence > log.current_sequence() {
        return Err(CheckpointFault::Sequence);
    }
    if sequence > 0 && log_lacks_sequence(log, sequence) {
        return Err(CheckpointFault::Sequence);
    }
    let actual_prefix = prefix_through(log, sequence).map_err(|_| CheckpointFault::Prefix)?;
    if Sha256Digest::from_bytes(actual_prefix) != checkpoint.event_prefix_hash {
        return Err(CheckpointFault::Prefix);
    }
    Ok(())
}

fn map_graph_fault(graph: &StateGraphV1) -> Result<(), CheckpointFault> {
    match validate_stored_graph(graph) {
        Ok(()) => Ok(()),
        Err(error) => Err(match error.state_code.as_str() {
            "STATE_DUPLICATE_ID" => CheckpointFault::DuplicateId,
            "STATE_FOCUS_INVALID" => CheckpointFault::Focus,
            "STATE_FIELD_LIMIT" | "STATE_OBJECT_LIMIT" => CheckpointFault::Oversized,
            _ if error.message == "state revision is invalid" => CheckpointFault::Revision,
            _ => CheckpointFault::Parse,
        }),
    }
}

fn snapshot_hash(graph: &StateGraphV1) -> Result<Sha256Digest, StateServiceError> {
    let body = to_canonical_json_bytes(graph).map_err(|_| {
        StateServiceError::new("STATE_PERSISTENCE", "state checkpoint write failed")
    })?;
    let mut input = b"praana-state-graph-checkpoint-v1\0".to_vec();
    input.extend_from_slice(&body);
    Ok(Sha256Digest::digest_bytes(&input))
}

fn payload_hash(sequence: u64, prefix: &[u8; 32], payload_json: &[u8]) -> Sha256Digest {
    let mut input = Vec::new();
    input.extend_from_slice(b"praana-projection-checkpoint-v1");
    input.push(0);
    input.extend_from_slice(STATE_CHECKPOINT_NAME.as_bytes());
    input.push(0);
    input.extend_from_slice(&CHECKPOINT_SCHEMA_VERSION.to_be_bytes());
    input.extend_from_slice(&sequence.to_be_bytes());
    input.extend_from_slice(prefix);
    input.extend_from_slice(payload_json);
    Sha256Digest::digest_bytes(&input)
}

fn persist_err(_err: rusqlite::Error) -> StateServiceError {
    StateServiceError::new("STATE_PERSISTENCE", "state checkpoint write failed")
}

fn decode_digest(digest: &Sha256Digest) -> Result<[u8; 32], ()> {
    let hex = digest.as_str();
    if hex.len() != 64 {
        return Err(());
    }
    let mut raw = [0u8; 32];
    for (index, slot) in raw.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|_| ())?;
    }
    Ok(raw)
}

pub fn prefix_through(log: &EventLogStore, sequence: u64) -> Result<[u8; 32], StateServiceError> {
    if sequence == log.current_sequence() {
        return Ok(log.current_prefix_hash());
    }
    if sequence == 0 {
        return Ok([0u8; 32]);
    }
    let events = log.events().map_err(|_| {
        StateServiceError::new("STATE_PERSISTENCE", "state checkpoint write failed")
    })?;
    let mut prefix = [0u8; 32];
    for (event, line) in events.iter().zip(log.raw_lines()) {
        if event.sequence > sequence {
            break;
        }
        prefix = calculate_prefix_hash(&prefix, event.sequence, line.as_bytes());
    }
    Ok(prefix)
}

fn log_lacks_sequence(log: &EventLogStore, sequence: u64) -> bool {
    log.events()
        .map(|events| {
            events
                .iter()
                .all(|event: &EventEnvelope| event.sequence != sequence)
        })
        .unwrap_or(true)
}
