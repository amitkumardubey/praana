//! History-derived checkpoint and projection (History §5.2, §8, §9.4).

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use super::artifact::HISTORY_RESULT_TOOLS;
use super::db::HistoryDatabase;
use super::error::{io_err, map_sqlite, ArtifactError};
use super::event_log::EventLogStore;
use super::recovery::build_interrupted_turn_capsule;
use super::retrieve::compute_text_view;
use super::search::SEARCH_SCHEMA_VERSION;
use crate::canonical_json::to_canonical_json_bytes;
use crate::id::ProtocolUlidId;
use crate::protocol::constants::PROJECTION_VERSION;
use crate::protocol::events::{CanonicalEvent, EventEnvelope};
use crate::protocol::id::{
    ArtifactId, EventId, ProjectionId, SearchResultId, SessionId, Sha256Digest, TurnId,
};
use crate::protocol::messages::{AssistantBlock, UserBlock};
use crate::protocol::tool_result::ToolResultContent;
use crate::redaction::redact_json_v1;

pub const CHECKPOINT_SCHEMA_VERSION: u32 = 1;
pub const PROJECTION_NAME: &str = "history_derived";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HistoryDerivedCheckpointV1 {
    pub checkpoint_schema_version: u32,
    pub session_id: SessionId,
    pub projection_version: crate::protocol::id::ProjectionId,
    pub search_schema_version: u32,
    pub reset_epoch: u32,
    pub applied_through_sequence: u64,
    pub event_prefix_hash: Sha256Digest,
}

pub struct HistoryProjector<'a> {
    db: &'a HistoryDatabase,
}

struct DocRow {
    source_kind: &'static str,
    source_field: String,
    event_id: EventId,
    event_sequence: u64,
    event_kind: &'static str,
    turn_id: Option<TurnId>,
    reset_epoch: u32,
    artifact_id: Option<ArtifactId>,
    tool_name: Option<String>,
    normalized_path: Option<String>,
    text: String,
    created_at_ms: i64,
    source_id: String,
    state_id: Option<String>,
}

struct TurnRow {
    reset_epoch: u32,
    start_sequence: u64,
    status: &'static str,
    commit_sequence: Option<u64>,
    end_sequence: Option<u64>,
    protocol_complete: bool,
    interrupted: bool,
}

impl<'a> HistoryProjector<'a> {
    pub fn new(db: &'a HistoryDatabase) -> Self {
        Self { db }
    }

    pub fn project(&self, log: &EventLogStore) -> Result<(), ArtifactError> {
        self.derive(log, false)
    }

    pub fn rebuild(&self, log: &EventLogStore) -> Result<(), ArtifactError> {
        self.derive(log, true)
    }

    pub fn checkpoint(&self) -> Result<Option<HistoryDerivedCheckpointV1>, ArtifactError> {
        let guard = self.db.lock();
        let conn: &Connection = &guard;
        validated_checkpoint(conn)
    }

    fn derive(&self, log: &EventLogStore, force: bool) -> Result<(), ArtifactError> {
        let events = log
            .events()
            .map_err(|err| ArtifactError::new(err.code(), "event log could not be read"))?;
        let session_id = *log.session_id();
        let current_seq = log.current_sequence();
        let prefix = log.current_prefix_hash();
        let raw_lines = log.raw_lines();

        // §8: replay validates the canonical prefix before any derived write.
        let mut replay = crate::history::replay::EventReplayer::new();
        for (index, event) in events.iter().enumerate() {
            replay
                .process_event(event, Some(index + 1), Some(raw_lines))
                .map_err(|err| ArtifactError::new(err.code(), "event log replay failed"))?;
        }

        if force {
            return super::rebuild::rebuild_derived_tables(self.db, log);
        }

        let guard = self.db.lock();
        let conn: &Connection = &guard;

        match checkpoint_state(conn, session_id, current_seq, prefix, raw_lines)? {
            CheckpointState::Fresh => return Ok(()),
            CheckpointState::Stale | CheckpointState::Absent => {}
            CheckpointState::Invalid => {
                drop(guard);
                return super::rebuild::rebuild_derived_tables(self.db, log);
            }
        }

        // History §15.2 point 11: the finish event is durable (fsync) before
        // this projection transaction begins.
        #[cfg(feature = "failpoints")]
        crate::crash_point::hit("history.finish_fsync_before_projection");

        conn.execute("BEGIN IMMEDIATE", []).map_err(map_sqlite)?;
        let outcome = apply_projection(conn, &events, raw_lines, session_id, current_seq, prefix);
        match outcome {
            Ok(()) => {
                // History §15.2 point 13: checkpoint upsert before commit.
                #[cfg(feature = "failpoints")]
                crate::crash_point::hit("history.checkpoint_upsert_before_commit");
                conn.execute("COMMIT", []).map(|_| ()).map_err(|err| {
                    let _ = conn.execute("ROLLBACK", []);
                    map_sqlite(err)
                })
            }
            Err(err) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(err)
            }
        }
    }
}

/// History §5.2 checkpoint validity against the row, the current build, and
/// the canonical log. Anything but `Fresh`/`Stale` is discarded: the caller
/// rebuilds the derived tables by full replay (§9.4), never treating the row
/// as empty-state authority.
#[derive(Debug)]
pub(crate) enum CheckpointState {
    Fresh,
    Stale,
    Absent,
    Invalid,
}

pub(crate) fn checkpoint_state(
    conn: &Connection,
    session_id: SessionId,
    current_seq: u64,
    prefix: [u8; 32],
    raw_lines: &[String],
) -> Result<CheckpointState, ArtifactError> {
    let payload = match read_checkpoint_row(conn)? {
        // No row at all: a session that has never been projected, or one whose
        // row does not exist yet. There is nothing to discard, so a full
        // replay writes the first row.
        CheckpointRead::Missing => return Ok(CheckpointState::Absent),
        // A stored row that fails any §5.2 check is discarded and the derived
        // tables are rebuilt by the §9.4 procedure, not repaired in place.
        CheckpointRead::Invalid => return Ok(CheckpointState::Invalid),
        CheckpointRead::Valid(payload) => payload,
    };
    if payload.session_id != session_id {
        return Ok(CheckpointState::Invalid);
    }
    if payload.applied_through_sequence > current_seq {
        return Ok(CheckpointState::Invalid);
    }
    // History §5.2: the stored hash must equal the canonical log's prefix hash
    // at the checkpoint's own applied sequence. A checkpoint behind the log
    // head is stale, not invalid: its hash is correct for the sequence it
    // names. A hash that does not match the log at that sequence means the row
    // cannot be trusted and the derived tables are rebuilt.
    let Some(at_applied) = prefix_hash_at(raw_lines, payload.applied_through_sequence) else {
        return Ok(CheckpointState::Invalid);
    };
    if payload.event_prefix_hash.as_str() != Sha256Digest::from_bytes(at_applied).as_str() {
        return Ok(CheckpointState::Invalid);
    }
    if payload.applied_through_sequence == current_seq {
        debug_assert_eq!(
            payload.event_prefix_hash.as_str(),
            Sha256Digest::from_bytes(prefix).as_str()
        );
        return Ok(CheckpointState::Fresh);
    }
    Ok(CheckpointState::Stale)
}

/// History §4.2 prefix chain recomputed over the log's exact lines, stopping
/// after `sequence`. Returns `None` when the log is shorter than that.
fn prefix_hash_at(raw_lines: &[String], sequence: u64) -> Option<[u8; 32]> {
    if sequence == 0 {
        return Some([0u8; 32]);
    }
    let mut prefix = [0u8; 32];
    for (index, line) in raw_lines.iter().enumerate().take(sequence as usize) {
        let next = index as u64 + 1;
        prefix = crate::protocol::hashes::calculate_prefix_hash(&prefix, next, line.as_bytes());
    }
    (raw_lines.len() as u64 >= sequence).then_some(prefix)
}

struct StoredCheckpointRow {
    checkpoint_schema_version: i64,
    applied_through_sequence: i64,
    event_prefix_hash: String,
    payload_json: String,
    payload_hash: String,
}

/// The stored `history_derived` row, or why it carries no authority.
pub(crate) enum CheckpointRead {
    Missing,
    Invalid,
    Valid(HistoryDerivedCheckpointV1),
}

/// History §5.2: parse the payload, require the row columns to equal the
/// payload fields, recompute `payload_hash` from the stored JSON, and require
/// the session build versions. A present row that fails any of those checks is
/// `Invalid`, never `Missing`: the caller rebuilds instead of treating it as an
/// empty state.
pub(crate) fn read_checkpoint_row(conn: &Connection) -> Result<CheckpointRead, ArtifactError> {
    let row: Option<StoredCheckpointRow> = conn
        .query_row(
            "SELECT checkpoint_schema_version, applied_through_sequence, event_prefix_hash, \
              payload_json, payload_hash \
              FROM projection_checkpoints WHERE projection_name = ?1",
            params![PROJECTION_NAME],
            |row| {
                Ok(StoredCheckpointRow {
                    checkpoint_schema_version: row.get(0)?,
                    applied_through_sequence: row.get(1)?,
                    event_prefix_hash: row.get(2)?,
                    payload_json: row.get(3)?,
                    payload_hash: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(map_sqlite)?;
    let Some(row) = row else {
        return Ok(CheckpointRead::Missing);
    };
    let Ok(payload) = serde_json::from_str::<HistoryDerivedCheckpointV1>(&row.payload_json) else {
        return Ok(CheckpointRead::Invalid);
    };
    if row.checkpoint_schema_version != CHECKPOINT_SCHEMA_VERSION as i64
        || payload.checkpoint_schema_version != CHECKPOINT_SCHEMA_VERSION
        || row.applied_through_sequence != payload.applied_through_sequence as i64
        || row.event_prefix_hash != payload.event_prefix_hash.as_str()
    {
        return Ok(CheckpointRead::Invalid);
    }
    if payload.projection_version.as_str() != PROJECTION_VERSION
        || payload.search_schema_version != SEARCH_SCHEMA_VERSION
    {
        return Ok(CheckpointRead::Invalid);
    }
    let Ok(canonical) = serde_json::from_str::<serde_json::Value>(&row.payload_json) else {
        return Ok(CheckpointRead::Invalid);
    };
    let Ok(canonical_bytes) = to_canonical_json_bytes(&canonical) else {
        return Ok(CheckpointRead::Invalid);
    };
    let Ok(prefix) = prefix_bytes(&payload.event_prefix_hash) else {
        return Ok(CheckpointRead::Invalid);
    };
    let Ok(expected) =
        checkpoint_payload_hash(payload.applied_through_sequence, prefix, &canonical_bytes)
    else {
        return Ok(CheckpointRead::Invalid);
    };
    if expected.as_str() != row.payload_hash {
        return Ok(CheckpointRead::Invalid);
    }
    Ok(CheckpointRead::Valid(payload))
}

/// The valid checkpoint, or `None` when there is no row or the row carries no
/// authority. Callers that must distinguish the two use
/// [`read_checkpoint_row`].
pub(crate) fn validated_checkpoint(
    conn: &Connection,
) -> Result<Option<HistoryDerivedCheckpointV1>, ArtifactError> {
    match read_checkpoint_row(conn)? {
        CheckpointRead::Valid(payload) => Ok(Some(payload)),
        CheckpointRead::Missing | CheckpointRead::Invalid => Ok(None),
    }
}

fn prefix_bytes(digest: &Sha256Digest) -> Result<[u8; 32], ArtifactError> {
    let hex = digest.as_str();
    let mut raw = [0u8; 32];
    for (index, slot) in raw.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|_| {
            ArtifactError::new(
                "HISTORY_EVENT_INTEGRITY",
                "projection checkpoint prefix hash is corrupt",
            )
        })?;
    }
    Ok(raw)
}

fn apply_projection(
    conn: &Connection,
    events: &[EventEnvelope],
    raw_lines: &[String],
    session_id: SessionId,
    current_seq: u64,
    prefix: [u8; 32],
) -> Result<(), ArtifactError> {
    // History §11.1.1: tool-call argument rows are redacted under the
    // session's `SessionStarted.redaction_version`. Only the build version can
    // be produced here; any other version fails closed.
    let mut redaction_version: Option<&str> = None;
    for envelope in events {
        if let CanonicalEvent::SessionStarted(started) = &envelope.event {
            redaction_version = Some(started.redaction_version.as_str());
            break;
        }
    }
    match redaction_version {
        Some(version) if version == crate::redaction::REDACTION_VERSION => {}
        Some(version) => {
            return Err(ArtifactError::new(
                "HISTORY_SCHEMA_UNSUPPORTED",
                format!("redaction version {version} is not supported"),
            ));
        }
        None => {
            return Err(ArtifactError::new(
                "HISTORY_EVENT_INTEGRITY",
                "event log has no session start",
            ));
        }
    }

    let mut epoch: u32 = 0;
    let mut turns: BTreeMap<TurnId, TurnRow> = BTreeMap::new();
    let mut docs: Vec<DocRow> = Vec::new();

    for envelope in events {
        match &envelope.event {
            CanonicalEvent::UserMessageAccepted(v) => {
                for (index, block) in v.message.blocks.iter().enumerate() {
                    if let UserBlock::Text(text) = block {
                        docs.push(DocRow {
                            source_kind: "event",
                            source_field: format!("user.blocks[{index}].text"),
                            event_id: envelope.event_id,
                            event_sequence: envelope.sequence,
                            event_kind: "user_message_accepted",
                            turn_id: envelope.turn_id,
                            reset_epoch: epoch,
                            artifact_id: None,
                            tool_name: None,
                            normalized_path: None,
                            text: text.text.clone(),
                            created_at_ms: envelope.timestamp_ms,
                            state_id: None,
                            source_id: envelope.event_id.to_string(),
                        });
                    }
                }
            }
            CanonicalEvent::AssistantStepAccepted(v) => {
                for (index, block) in v.message.blocks.iter().enumerate() {
                    match block {
                        AssistantBlock::Text(text) => docs.push(DocRow {
                            source_kind: "event",
                            source_field: format!("assistant.blocks[{index}].text"),
                            event_id: envelope.event_id,
                            event_sequence: envelope.sequence,
                            event_kind: "assistant_step_accepted",
                            turn_id: envelope.turn_id,
                            reset_epoch: epoch,
                            artifact_id: None,
                            tool_name: None,
                            normalized_path: None,
                            text: text.text.clone(),
                            created_at_ms: envelope.timestamp_ms,
                            state_id: None,
                            source_id: envelope.event_id.to_string(),
                        }),
                        AssistantBlock::ReasoningSummary(summary) => docs.push(DocRow {
                            source_kind: "event",
                            source_field: format!("assistant.blocks[{index}].reasoning_summary"),
                            event_id: envelope.event_id,
                            event_sequence: envelope.sequence,
                            event_kind: "assistant_step_accepted",
                            turn_id: envelope.turn_id,
                            reset_epoch: epoch,
                            artifact_id: None,
                            tool_name: None,
                            normalized_path: None,
                            text: summary.text.clone(),
                            created_at_ms: envelope.timestamp_ms,
                            state_id: None,
                            source_id: envelope.event_id.to_string(),
                        }),
                        AssistantBlock::Refusal(refusal) => docs.push(DocRow {
                            source_kind: "event",
                            source_field: format!("assistant.blocks[{index}].refusal"),
                            event_id: envelope.event_id,
                            event_sequence: envelope.sequence,
                            event_kind: "assistant_step_accepted",
                            turn_id: envelope.turn_id,
                            reset_epoch: epoch,
                            artifact_id: None,
                            tool_name: None,
                            normalized_path: None,
                            text: refusal.text.clone(),
                            created_at_ms: envelope.timestamp_ms,
                            state_id: None,
                            source_id: envelope.event_id.to_string(),
                        }),
                        AssistantBlock::ToolCall(call) => {
                            docs.push(DocRow {
                                source_kind: "event",
                                source_field: format!("assistant.blocks[{index}].tool_call.name"),
                                event_id: envelope.event_id,
                                event_sequence: envelope.sequence,
                                event_kind: "assistant_step_accepted",
                                turn_id: envelope.turn_id,
                                reset_epoch: epoch,
                                artifact_id: None,
                                tool_name: Some(call.name.clone()),
                                normalized_path: None,
                                text: call.name.clone(),
                                created_at_ms: envelope.timestamp_ms,
                                state_id: None,
                                source_id: envelope.event_id.to_string(),
                            });
                            let arguments = serde_json::Value::Object(call.arguments.clone());
                            // History §4.3: a redaction failure is never
                            // fail-open. The row is not skipped; the whole
                            // projection fails instead of committing without it.
                            let redacted = redact_json_v1(&arguments).map_err(|_| {
                                ArtifactError::new(
                                    "HISTORY_EVENT_INTEGRITY",
                                    "tool-call arguments redaction failed",
                                )
                            })?;
                            let bytes = to_canonical_json_bytes(&redacted.value).map_err(|_| {
                                ArtifactError::new(
                                    "HISTORY_EVENT_INTEGRITY",
                                    "tool-call arguments redaction failed",
                                )
                            })?;
                            let text = String::from_utf8(bytes).map_err(|_| {
                                ArtifactError::new(
                                    "HISTORY_EVENT_INTEGRITY",
                                    "tool-call arguments redaction failed",
                                )
                            })?;
                            docs.push(DocRow {
                                source_kind: "event",
                                source_field: format!(
                                    "assistant.blocks[{index}].tool_call.arguments"
                                ),
                                event_id: envelope.event_id,
                                event_sequence: envelope.sequence,
                                event_kind: "assistant_step_accepted",
                                turn_id: envelope.turn_id,
                                reset_epoch: epoch,
                                artifact_id: None,
                                tool_name: Some(call.name.clone()),
                                normalized_path: None,
                                text,
                                created_at_ms: envelope.timestamp_ms,
                                state_id: None,
                                source_id: envelope.event_id.to_string(),
                            });
                        }
                        _ => {}
                    }
                }
            }
            CanonicalEvent::ToolExecutionFinished(v) => {
                let tool_name = v.result.tool_name.as_str();
                if !HISTORY_RESULT_TOOLS.contains(&tool_name) {
                    match &v.result.body.content {
                        ToolResultContent::Inline(inline) => docs.push(DocRow {
                            source_kind: "event",
                            source_field: "tool_result.inline.text".to_owned(),
                            event_id: envelope.event_id,
                            event_sequence: envelope.sequence,
                            event_kind: "tool_execution_finished",
                            turn_id: envelope.turn_id,
                            reset_epoch: epoch,
                            artifact_id: None,
                            tool_name: Some(v.result.tool_name.clone()),
                            normalized_path: None,
                            text: inline.text.clone(),
                            created_at_ms: envelope.timestamp_ms,
                            state_id: None,
                            source_id: envelope.event_id.to_string(),
                        }),
                        ToolResultContent::Artifact(artifact) => {
                            let artifact_id = artifact.reference.artifact_id;
                            let row: Option<(String, Option<String>, Vec<u8>)> = conn
                                .query_row(
                                    "SELECT a.content_type, a.normalized_path, b.canonical_result \
                                     FROM artifacts a \
                                     JOIN artifact_blobs b ON b.blob_id = a.blob_id \
                                     WHERE a.artifact_id = ?1",
                                    params![artifact_id.to_string()],
                                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                                )
                                .optional()
                                .map_err(map_sqlite)?;
                            let (content_type, normalized_path, canonical) =
                                row.ok_or_else(|| {
                                    ArtifactError::new(
                                        "HISTORY_DANGLING_ARTIFACT",
                                        "finish event references a missing artifact row",
                                    )
                                })?;
                            if content_type != "binary" {
                                let value: serde_json::Value = serde_json::from_slice(&canonical)
                                    .map_err(|err| {
                                    io_err(format!("canonical artifact is not json: {err}"))
                                })?;
                                let view = compute_text_view(&value);
                                docs.push(DocRow {
                                    source_kind: "artifact",
                                    source_field: "artifact.text_view".to_owned(),
                                    event_id: envelope.event_id,
                                    event_sequence: envelope.sequence,
                                    event_kind: "tool_execution_finished",
                                    turn_id: envelope.turn_id,
                                    reset_epoch: epoch,
                                    artifact_id: Some(artifact_id),
                                    tool_name: Some(v.result.tool_name.clone()),
                                    normalized_path,
                                    text: view.text,
                                    created_at_ms: envelope.timestamp_ms,
                                    state_id: None,
                                    source_id: artifact_id.to_string(),
                                });
                            }
                        }
                    }
                }
            }
            CanonicalEvent::TurnStarted(_) => {
                if let Some(turn_id) = envelope.turn_id {
                    turns.insert(
                        turn_id,
                        TurnRow {
                            reset_epoch: epoch,
                            start_sequence: envelope.sequence,
                            status: "in_flight",
                            commit_sequence: None,
                            end_sequence: None,
                            protocol_complete: false,
                            interrupted: false,
                        },
                    );
                }
            }
            CanonicalEvent::TurnCommitted(_) => {
                if let Some(turn_id) = envelope.turn_id {
                    let entry = turns.entry(turn_id).or_insert(TurnRow {
                        reset_epoch: epoch,
                        start_sequence: envelope.sequence,
                        status: "in_flight",
                        commit_sequence: None,
                        end_sequence: None,
                        protocol_complete: false,
                        interrupted: false,
                    });
                    // §9.4: rebuild never upgrades an interrupted turn.
                    if entry.status == "in_flight" {
                        entry.status = "committed";
                        entry.commit_sequence = Some(envelope.sequence);
                        entry.end_sequence = Some(envelope.sequence);
                        entry.protocol_complete = true;
                    }
                }
            }
            CanonicalEvent::TurnInterrupted(_) => {
                if let Some(turn_id) = envelope.turn_id {
                    let entry = turns.entry(turn_id).or_insert(TurnRow {
                        reset_epoch: epoch,
                        start_sequence: envelope.sequence,
                        status: "in_flight",
                        commit_sequence: None,
                        end_sequence: None,
                        protocol_complete: false,
                        interrupted: false,
                    });
                    if entry.status == "in_flight" {
                        entry.status = "interrupted";
                        entry.end_sequence = Some(envelope.sequence);
                        entry.interrupted = true;
                        // Capsule construction below validates every accepted
                        // step/batch reference and matches the durable event.
                        entry.protocol_complete = true;
                    }
                }
            }
            CanonicalEvent::ResetBoundary(v) => {
                epoch = v.reset_epoch;
            }
            CanonicalEvent::StateChanged(event) => {
                for row in crate::state::state_search_rows(&envelope.event_id, event) {
                    docs.push(DocRow {
                        source_kind: "state",
                        source_field: row.source_field,
                        event_id: envelope.event_id,
                        event_sequence: envelope.sequence,
                        event_kind: "state_changed",
                        turn_id: envelope.turn_id,
                        reset_epoch: epoch,
                        artifact_id: None,
                        tool_name: None,
                        normalized_path: None,
                        text: row.text,
                        created_at_ms: envelope.timestamp_ms,
                        source_id: row.source_id,
                        state_id: Some(row.state_id.to_string()),
                    });
                }
            }
            _ => {}
        }
    }

    // History §15.2 point 12: crash before each derived table update.
    #[cfg(feature = "failpoints")]
    crate::crash_point::hit("history.derived_update_before_turns");
    for (turn_id, turn) in &turns {
        let capsule = if turn.interrupted {
            let capsule =
                build_interrupted_turn_capsule(events, raw_lines, *turn_id).map_err(|err| {
                    ArtifactError::new(err.code(), "interruption capsule build failed")
                })?;
            let bytes = to_canonical_json_bytes(&capsule)
                .map_err(|err| io_err(format!("capsule canonicalization failed: {err}")))?;
            Some(
                String::from_utf8(bytes)
                    .map_err(|err| io_err(format!("capsule canonicalization failed: {err}")))?,
            )
        } else {
            None
        };
        let capsule_sha = capsule.as_deref().map(|text| {
            Sha256Digest::digest_bytes(text.as_bytes())
                .as_str()
                .to_owned()
        });
        // Turn rows evolve across projections (in_flight → committed), so a
        // re-applied turn overwrites; a conflicting sibling sequence is an
        // integrity failure, reported below.
        conn.execute(
            "INSERT INTO turns( \
                  turn_id, reset_epoch, start_sequence, end_sequence, commit_sequence, \
                  status, protocol_complete, accepted_message_tokens, \
                  accepted_message_estimator_id, accepted_message_input_sha256, \
                  interruption_capsule_json, interruption_capsule_sha256, \
                  retired_by_epoch, source_hash) \
              VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, NULL, ?8, ?9, NULL, NULL) \
              ON CONFLICT(turn_id) DO UPDATE SET \
                  reset_epoch = excluded.reset_epoch, \
                  start_sequence = excluded.start_sequence, \
                  end_sequence = excluded.end_sequence, \
                  commit_sequence = excluded.commit_sequence, \
                  status = excluded.status, \
                  protocol_complete = excluded.protocol_complete, \
                  interruption_capsule_json = excluded.interruption_capsule_json, \
                  interruption_capsule_sha256 = excluded.interruption_capsule_sha256",
            params![
                turn_id.to_string(),
                turn.reset_epoch as i64,
                turn.start_sequence as i64,
                turn.end_sequence.map(|value| value as i64),
                turn.commit_sequence.map(|value| value as i64),
                turn.status,
                i64::from(turn.protocol_complete),
                capsule,
                capsule_sha,
            ],
        )
        .map_err(turn_upsert_err)?;
    }

    // History §15.2 point 12: crash before each derived table update.
    #[cfg(feature = "failpoints")]
    crate::crash_point::hit("history.derived_update_before_search_documents");
    // History §5.2: re-applying the same event recomputes the same row.
    // New rows are inserted (collecting their content rowids for the FTS
    // phase below); an existing row must match every column except `rowid`,
    // otherwise the result is `HISTORY_EVENT_INTEGRITY` and no `search_fts`
    // insert is issued for it. Rows are never updated in place, so the §8
    // FTS delete-before-update path has no producer here.
    let mut fresh_fts: Vec<(i64, &str)> = Vec::new();
    for doc in &docs {
        if doc.text.is_empty() {
            continue;
        }
        let content_sha = Sha256Digest::digest_bytes(doc.text.as_bytes());
        let document_id = derive_document_id(
            doc.source_kind,
            &doc.source_id,
            &doc.source_field,
            content_sha.as_str(),
        );
        let event_id = doc.event_id.to_string();
        let turn_id = doc.turn_id.map(|value| value.to_string());
        let artifact_id = doc.artifact_id.map(|value| value.to_string());
        let changed = conn
            .execute(
                "INSERT INTO search_documents( \
                 document_id, source_kind, source_field, event_id, event_sequence, \
                 event_kind, turn_id, reset_epoch, artifact_id, summary_segment_id, \
                 state_id, tool_name, normalized_path, content_sha256, text, created_at_ms) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12, ?13, ?14, ?15) \
             ON CONFLICT(document_id) DO NOTHING",
                params![
                    document_id.to_string(),
                    doc.source_kind,
                    doc.source_field,
                    event_id,
                    doc.event_sequence as i64,
                    doc.event_kind,
                    turn_id,
                    doc.reset_epoch as i64,
                    artifact_id,
                    doc.state_id,
                    doc.tool_name,
                    doc.normalized_path,
                    content_sha.as_str(),
                    doc.text,
                    doc.created_at_ms,
                ],
            )
            .map_err(doc_insert_err)?;
        if changed == 1 {
            fresh_fts.push((conn.last_insert_rowid(), doc.text.as_str()));
        } else {
            compare_document_row(
                conn,
                &document_id,
                doc,
                &event_id,
                turn_id.as_deref(),
                artifact_id.as_deref(),
                content_sha.as_str(),
            )?;
        }
    }

    #[cfg(feature = "failpoints")]
    crate::crash_point::hit("history.derived_update_before_search_fts");
    for (rowid, text) in fresh_fts {
        // History §8: an FTS insert uses the content row's rowid.
        conn.execute(
            "INSERT INTO search_fts(rowid, text) VALUES(?1, ?2)",
            params![rowid, text],
        )
        .map_err(map_sqlite)?;
    }

    write_checkpoint(conn, events, session_id, current_seq, prefix, epoch)
}

#[allow(clippy::too_many_arguments)]
fn compare_document_row(
    conn: &Connection,
    document_id: &SearchResultId,
    doc: &DocRow,
    event_id: &str,
    turn_id: Option<&str>,
    artifact_id: Option<&str>,
    content_sha: &str,
) -> Result<(), ArtifactError> {
    // History §5.2: every column except `rowid` must equal the recomputed
    // value. `summary_segment_id` stays NULL until P5. State rows set `state_id`.
    type DocCompareRow = (
        String,
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
        i64,
    );
    let row: Option<DocCompareRow> = conn
        .query_row(
            "SELECT source_kind, source_field, event_id, event_sequence, event_kind, \
              turn_id, reset_epoch, artifact_id, summary_segment_id, state_id, \
              tool_name, normalized_path, content_sha256, text, created_at_ms \
              FROM search_documents WHERE document_id = ?1",
            params![document_id.to_string()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, i64>(14)?,
                ))
            },
        )
        .optional()
        .map_err(map_sqlite)?;
    let Some(stored) = row else {
        return Err(ArtifactError::new(
            "HISTORY_EVENT_INTEGRITY",
            "derived search document vanished during projection",
        ));
    };
    let expected = (
        doc.source_kind.to_owned(),
        doc.source_field.clone(),
        Some(event_id.to_owned()),
        Some(doc.event_sequence as i64),
        Some(doc.event_kind.to_owned()),
        turn_id.map(str::to_owned),
        doc.reset_epoch as i64,
        artifact_id.map(str::to_owned),
        None,
        doc.state_id.clone(),
        doc.tool_name.clone(),
        doc.normalized_path.clone(),
        content_sha.to_owned(),
        doc.text.clone(),
        doc.created_at_ms,
    );
    if stored.0 != expected.0
        || stored.1 != expected.1
        || stored.2 != expected.2
        || stored.3 != expected.3
        || stored.4 != expected.4
        || stored.5 != expected.5
        || stored.6 != expected.6
        || stored.7 != expected.7
        || stored.8 != expected.8
        || stored.9 != expected.9
        || stored.10 != expected.10
        || stored.11 != expected.11
        || stored.12 != expected.12
        || stored.13 != expected.13
        || stored.14 != expected.14
    {
        return Err(ArtifactError::new(
            "HISTORY_EVENT_INTEGRITY",
            "derived search document differs from the replayed event",
        ));
    }
    Ok(())
}

fn write_checkpoint(
    conn: &Connection,
    events: &[EventEnvelope],
    session_id: SessionId,
    current_seq: u64,
    prefix: [u8; 32],
    reset_epoch: u32,
) -> Result<(), ArtifactError> {
    let projection_version = ProjectionId::from_str_canonical(PROJECTION_VERSION)
        .map_err(|err| ArtifactError::new(err.code(), "projection version invalid"))?;
    let payload = HistoryDerivedCheckpointV1 {
        checkpoint_schema_version: CHECKPOINT_SCHEMA_VERSION,
        session_id,
        projection_version,
        search_schema_version: SEARCH_SCHEMA_VERSION,
        reset_epoch,
        applied_through_sequence: current_seq,
        event_prefix_hash: Sha256Digest::from_bytes(prefix),
    };
    let payload_json =
        to_canonical_json_bytes(&payload).map_err(|err| io_err(format!("checkpoint: {err}")))?;
    let payload_text = String::from_utf8(payload_json.clone())
        .map_err(|err| io_err(format!("checkpoint: {err}")))?;
    let payload_hash = checkpoint_payload_hash(current_seq, prefix, &payload_json)?;

    let updated_at_ms = events.last().map(|event| event.timestamp_ms).unwrap_or(0);
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
            PROJECTION_NAME,
            CHECKPOINT_SCHEMA_VERSION as i64,
            current_seq as i64,
            Sha256Digest::from_bytes(prefix).as_str(),
            payload_text,
            payload_hash.as_str(),
            updated_at_ms,
        ],
    )
    .map_err(map_sqlite)?;
    Ok(())
}

/// History §5.2: SHA-256 of `praana-projection-checkpoint-v1`, NUL,
/// `projection_name`, NUL, `u32_be(version)`, `u64_be(sequence)`, raw prefix
/// bytes, then RFC 8785 payload bytes.
fn checkpoint_payload_hash(
    applied_through_sequence: u64,
    prefix: [u8; 32],
    payload_json: &[u8],
) -> Result<Sha256Digest, ArtifactError> {
    let mut input = Vec::new();
    input.extend_from_slice(b"praana-projection-checkpoint-v1");
    input.push(0);
    input.extend_from_slice(PROJECTION_NAME.as_bytes());
    input.push(0);
    input.extend_from_slice(&CHECKPOINT_SCHEMA_VERSION.to_be_bytes());
    input.extend_from_slice(&applied_through_sequence.to_be_bytes());
    input.extend_from_slice(&prefix);
    input.extend_from_slice(payload_json);
    Ok(Sha256Digest::digest_bytes(&input))
}

/// History §11.3: `result_id` is the ULID encoding of the first 16 bytes of
/// SHA-256 over `praana-search-result-v1`, NUL, source kind, NUL, canonical
/// source ID, NUL, source field, NUL, lowercase content SHA-256.
fn derive_document_id(
    source_kind: &str,
    source_id: &str,
    source_field: &str,
    content_sha: &str,
) -> SearchResultId {
    let mut input = Vec::new();
    input.extend_from_slice(b"praana-search-result-v1");
    input.push(0);
    input.extend_from_slice(source_kind.as_bytes());
    input.push(0);
    input.extend_from_slice(source_id.as_bytes());
    input.push(0);
    input.extend_from_slice(source_field.as_bytes());
    input.push(0);
    input.extend_from_slice(content_sha.as_bytes());
    let digest = Sha256Digest::digest_bytes(&input);
    let hex = digest.as_str();
    let mut raw = [0u8; 16];
    for (index, slot) in raw.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).expect("hex digest");
    }
    SearchResultId::from_validated_ulid(Ulid::from(u128::from_be_bytes(raw)))
}

fn turn_upsert_err(err: rusqlite::Error) -> ArtifactError {
    let constraint = matches!(
        &err,
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == rusqlite::ErrorCode::ConstraintViolation
    );
    if constraint {
        ArtifactError::new(
            "HISTORY_EVENT_INTEGRITY",
            "derived turn row conflicts with a different turn",
        )
    } else {
        map_sqlite(err)
    }
}

fn doc_insert_err(err: rusqlite::Error) -> ArtifactError {
    let constraint = matches!(
        &err,
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == rusqlite::ErrorCode::ConstraintViolation
    );
    if constraint {
        ArtifactError::new(
            "HISTORY_EVENT_INTEGRITY",
            "derived search document id collided with a different source",
        )
    } else {
        map_sqlite(err)
    }
}
