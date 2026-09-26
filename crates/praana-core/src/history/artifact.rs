//! Canonical tool-result artifactization. Decisions use Token Accounting on the
//! post-redaction canonical bytes. Artifact rows commit before any referencing event.

use std::sync::{Arc, Mutex};

use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::db::HistoryDatabase;
use super::error::{io_err, ArtifactError};
use super::event_log::EventLogStore;
use super::preview::{
    line_count_of, render_preview, ArtifactContentType, PreviewRequest, RenderedPreview,
};
use crate::clock::Clock;
use crate::protocol::events::{CanonicalEvent, EventEnvelope, ToolExecutionFinished};
use crate::protocol::id::*;
use crate::protocol::tool_result::{
    ArtifactRef, ArtifactRetrieval, ArtifactToolResult, InlineToolResult, ToolResultBody,
    ToolResultContent, ToolResultMessage, ToolResultStatus,
};
use crate::redaction::detect_secret_matches_v1;
use crate::token::{
    calculate_batch_inline_decisions, FramingProfileV1, GenericTokenEstimatorV1, TokenEstimateV1,
    TokenEstimationContext, TokenEstimatorV1,
};
use crate::tools::{FinishedCall, ResultCommit};

pub const RESULT_MEDIA_TYPE: &str = "application/vnd.praana.tool-result+json;version=1";

#[derive(Clone, Debug)]
pub struct ArtifactPolicy {
    pub inline_tokens: u64,
    pub batch_inline_tokens: u64,
    pub preview_tokens: u64,
    pub orphan_retention_days: u32,
}

impl ArtifactPolicy {
    pub fn defaults() -> Self {
        Self {
            inline_tokens: 800,
            batch_inline_tokens: 1600,
            preview_tokens: 160,
            orphan_retention_days: 7,
        }
    }
}

pub fn policy_from_session(session_dir: &std::path::Path) -> ArtifactPolicy {
    let path = session_dir.join("config.snapshot.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return ArtifactPolicy::defaults();
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return ArtifactPolicy::defaults();
    };
    let Ok(config) =
        serde_json::from_str::<crate::config::EffectiveConfigV1>(text.trim_end_matches('\n'))
    else {
        return ArtifactPolicy::defaults();
    };
    ArtifactPolicy {
        inline_tokens: config.history.artifact_inline_tokens,
        batch_inline_tokens: config.history.artifact_batch_inline_tokens,
        preview_tokens: config.history.artifact_preview_tokens,
        orphan_retention_days: config.session.orphan_retention_days,
    }
}

#[derive(Clone, Debug)]
pub struct PlanItem {
    pub call_index: u32,
    pub total_tokens: u64,
    pub binary: bool,
    pub tool_name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageClass {
    Inline,
    Artifact,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactCrashPoint {
    AfterBlobInsertBeforeCommit,
    AfterBlobCommitBeforeArtifactRow,
    AfterCommitBeforeEvent,
    AfterEventWriteBeforeFsync,
}

#[derive(Clone, Debug)]
pub struct PublishInput {
    pub artifact_id: ArtifactId,
    pub finish_event_id: EventId,
    pub result_message_id: MessageId,
    pub canonical_bytes: Vec<u8>,
    pub content_type: ArtifactContentType,
    pub tool_name: String,
    pub call_id: ToolCallId,
    pub call_index: u32,
    pub execution_id: ToolExecutionId,
    pub batch_id: ToolBatchId,
    pub step_id: StepId,
    pub turn_id: TurnId,
    pub attempt_id: AttemptId,
    pub execution_started: bool,
    pub started_event_id: Option<EventId>,
    pub status: ToolResultStatus,
    pub label: Option<String>,
    pub normalized_path: Option<String>,
    pub exit_code: Option<i32>,
    pub redacted: bool,
    pub redaction_json: String,
    pub force_binary: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedEstimate {
    pub estimator_id: String,
    pub token_count: u64,
    pub input_sha256: String,
}

#[derive(Clone, Debug)]
pub struct PublishOutcome {
    pub class: StorageClass,
    pub estimate: TokenEstimateV1,
    pub preview_text: Option<String>,
    pub artifact_id: Option<ArtifactId>,
}

pub struct ArtifactStore {
    db: HistoryDatabase,
    policy: ArtifactPolicy,
    clock: Arc<dyn Clock>,
}

pub fn plan_storage(
    items: &[PlanItem],
    policy: &ArtifactPolicy,
) -> Result<Vec<StorageClass>, ArtifactError> {
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by_key(|&index| (items[index].call_index, index));
    let mut forced = vec![None; items.len()];
    let mut eligible_positions = Vec::new();
    let mut eligible_tokens = Vec::new();
    for index in &order {
        let item = &items[*index];
        if item.tool_name == "retrieve_artifact" {
            forced[*index] = Some(StorageClass::Inline);
        } else if item.binary {
            forced[*index] = Some(StorageClass::Artifact);
        } else {
            eligible_positions.push(*index);
            eligible_tokens.push(item.total_tokens);
        }
    }
    let decided = calculate_batch_inline_decisions(
        &eligible_tokens,
        policy.batch_inline_tokens,
        policy.inline_tokens,
    )
    .map_err(|err| io_err(format!("token accounting overflow: {err}")))?;
    let mut out = vec![StorageClass::Artifact; items.len()];
    for (slot, class) in forced.into_iter().enumerate() {
        if let Some(class) = class {
            out[slot] = class;
        }
    }
    for (position, inline) in eligible_positions.into_iter().zip(decided) {
        out[position] = if inline {
            StorageClass::Inline
        } else {
            StorageClass::Artifact
        };
    }
    Ok(out)
}

impl ArtifactStore {
    pub fn open(
        path: &std::path::Path,
        policy: ArtifactPolicy,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, ArtifactError> {
        Ok(Self {
            db: HistoryDatabase::open(path)?,
            policy,
            clock,
        })
    }

    pub fn publish_batch(
        &self,
        log: &mut EventLogStore,
        inputs: &[PublishInput],
        crash: Option<ArtifactCrashPoint>,
    ) -> Result<Vec<PublishOutcome>, ArtifactError> {
        let mut plans = Vec::with_capacity(inputs.len());
        for input in inputs {
            refuse_secrets(&input.canonical_bytes)?;
            let value = validate_canonical(&input.canonical_bytes)?;
            let estimate = estimate_result(&input.canonical_bytes)?;
            plans.push((value, estimate));
        }
        let items: Vec<PlanItem> = inputs
            .iter()
            .zip(plans.iter())
            .map(|(input, (_, estimate))| PlanItem {
                call_index: input.call_index,
                total_tokens: estimate.total_tokens,
                binary: input.force_binary
                    || matches!(input.content_type, ArtifactContentType::Binary),
                tool_name: input.tool_name.clone(),
            })
            .collect();
        let classes = plan_storage(&items, &self.policy)?;
        let mut order: Vec<usize> = (0..inputs.len()).collect();
        order.sort_by_key(|&index| (inputs[index].call_index, index));
        let mut outcomes = vec![None; inputs.len()];
        for index in order {
            let input = &inputs[index];
            let class = classes[index];
            let estimate = plans[index].1.clone();
            let inspected = inspect_result(&plans[index].0, &input.canonical_bytes);
            let outcome = match class {
                StorageClass::Inline => {
                    self.append_finish(log, input, &estimate, &inspected, None, false, crash)?;
                    PublishOutcome {
                        class,
                        estimate,
                        preview_text: None,
                        artifact_id: None,
                    }
                }
                StorageClass::Artifact => {
                    let rendered = self.render(input, &estimate, &inspected)?;
                    let sequence = log.current_sequence() + 1;
                    let persisted = self.persist_artifact(
                        input, &estimate, &inspected, &rendered, sequence, crash,
                    )?;
                    if crash == Some(ArtifactCrashPoint::AfterCommitBeforeEvent)
                        || crash == Some(ArtifactCrashPoint::AfterBlobInsertBeforeCommit)
                        || crash == Some(ArtifactCrashPoint::AfterBlobCommitBeforeArtifactRow)
                    {
                        return Err(io_err("injected crash before the referencing event"));
                    }
                    if !(persisted == PersistStatus::AlreadyDurable
                        && execution_finished(log, input)?)
                    {
                        self.append_finish(
                            log,
                            input,
                            &estimate,
                            &inspected,
                            Some(&rendered),
                            false,
                            crash,
                        )?;
                    }
                    PublishOutcome {
                        class,
                        estimate,
                        preview_text: Some(rendered.preview_text.clone()),
                        artifact_id: Some(input.artifact_id),
                    }
                }
            };
            outcomes[index] = Some(outcome);
            if crash == Some(ArtifactCrashPoint::AfterEventWriteBeforeFsync) {
                return Err(io_err("injected crash after event write before fsync"));
            }
        }
        Ok(outcomes.into_iter().flatten().collect())
    }

    pub fn artifact_row_count(&self) -> Result<i64, ArtifactError> {
        self.db
            .lock()
            .query_row("SELECT COUNT(*) FROM artifacts", [], |row| row.get(0))
            .map_err(|err| io_err(err.to_string()))
    }

    pub fn blob_row_count(&self) -> Result<i64, ArtifactError> {
        self.db
            .lock()
            .query_row("SELECT COUNT(*) FROM artifact_blobs", [], |row| row.get(0))
            .map_err(|err| io_err(err.to_string()))
    }

    pub fn persisted_estimate(&self, id: &ArtifactId) -> Result<PersistedEstimate, ArtifactError> {
        self.db
            .lock()
            .query_row(
                "SELECT b.token_estimator_id, b.estimated_tokens, b.token_input_sha256
                 FROM artifacts a
                 JOIN artifact_blobs b ON b.blob_id = a.blob_id
                 WHERE a.artifact_id = ?1",
                [id.to_string()],
                |row| {
                    Ok(PersistedEstimate {
                        estimator_id: row.get(0)?,
                        token_count: row.get::<_, i64>(1)? as u64,
                        input_sha256: row.get(2)?,
                    })
                },
            )
            .map_err(|err| io_err(err.to_string()))
    }

    pub fn verify_references(&self, events: &[EventEnvelope]) -> Result<(), ArtifactError> {
        for event in events {
            let CanonicalEvent::ToolExecutionFinished(finished) = &event.event else {
                continue;
            };
            let ToolResultContent::Artifact(artifact) = &finished.result.body.content else {
                continue;
            };
            let reference = &artifact.reference;
            let found: Option<(String, Vec<u8>, i64)> = self
                .db
                .lock()
                .query_row(
                    "SELECT b.sha256, b.canonical_result, b.byte_count
                     FROM artifacts a
                     JOIN artifact_blobs b ON b.blob_id = a.blob_id
                     WHERE a.artifact_id = ?1",
                    [reference.artifact_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|err| io_err(err.to_string()))?;
            let Some((sha, bytes, byte_count)) = found else {
                return Err(ArtifactError::new(
                    "E_ARTIFACT_MISSING",
                    "HISTORY_DANGLING_ARTIFACT",
                ));
            };
            let actual = Sha256Digest::digest_bytes(&bytes);
            if sha != reference.sha256.as_str()
                || actual.as_str() != reference.sha256.as_str()
                || byte_count as u64 != reference.byte_count
                || bytes.len() as u64 != reference.byte_count
            {
                return Err(ArtifactError::new(
                    "E_ARTIFACT_HASH_MISMATCH",
                    "HISTORY_DANGLING_ARTIFACT",
                ));
            }
        }
        Ok(())
    }

    pub fn gc_classified_orphans(
        &self,
        now_ms: i64,
        durable_event_ids: &[EventId],
    ) -> Result<u64, ArtifactError> {
        let _ = (now_ms, durable_event_ids);
        // Unclassified orphans stay. Recovery deletes only after a finish exists.
        Ok(0)
    }

    pub fn delete_expired_classified_orphans(
        &self,
        now_ms: i64,
        classified_execution_ids: &[ToolExecutionId],
        durable_event_ids: &[EventId],
    ) -> Result<u64, ArtifactError> {
        if classified_execution_ids.is_empty() {
            return Ok(0);
        }
        let retention_ms = i64::from(self.policy.orphan_retention_days).saturating_mul(86_400_000);
        let conn = self.db.lock();
        conn.execute_batch("BEGIN IMMEDIATE").map_err(map_sql)?;
        let deleted = (|| -> Result<u64, ArtifactError> {
            let mut removed = 0u64;
            for execution in classified_execution_ids {
                let row: Option<(String, String, String, i64)> = conn
                    .query_row(
                        "SELECT artifact_id, blob_id, producing_event_id, created_at_ms
                         FROM artifacts WHERE execution_id = ?1",
                        [execution.to_string()],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()
                    .map_err(map_sql)?;
                let Some((artifact_id, blob_id, producing_event_id, created_at_ms)) = row else {
                    continue;
                };
                if durable_event_ids
                    .iter()
                    .any(|event_id| event_id.to_string() == producing_event_id)
                {
                    continue;
                }
                let age = if now_ms < created_at_ms {
                    0
                } else {
                    now_ms - created_at_ms
                };
                if retention_ms == 0 || age >= retention_ms {
                    conn.execute(
                        "DELETE FROM artifacts WHERE artifact_id = ?1",
                        [artifact_id],
                    )
                    .map_err(map_sql)?;
                    conn.execute(
                        "DELETE FROM artifact_blobs WHERE blob_id = ?1 AND NOT EXISTS (SELECT 1 FROM artifacts WHERE blob_id = ?1)",
                        [blob_id],
                    )
                    .map_err(map_sql)?;
                    removed += 1;
                }
            }
            Ok(removed)
        })();
        match deleted {
            Ok(removed) => {
                conn.execute_batch("COMMIT").map_err(map_sql)?;
                Ok(removed)
            }
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(err)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reconstruct_orphan(
        &self,
        execution_id: &ToolExecutionId,
        turn_id: TurnId,
        attempt_id: AttemptId,
        batch_id: &ToolBatchId,
        step_id: &StepId,
        call_id: &ToolCallId,
        call_index: u32,
        tool_name: &str,
        started_event_id: Option<EventId>,
        next_sequence: u64,
        session_id: SessionId,
        timestamp_ms: i64,
    ) -> Result<Option<EventEnvelope>, ArtifactError> {
        let conn = self.db.lock();
        let row = load_artifact_row(&conn, execution_id)?;
        drop(conn);
        let Some(row) = row else {
            return Ok(None);
        };
        if !proof_matches(
            &row,
            turn_id,
            attempt_id,
            batch_id,
            step_id,
            call_id,
            call_index,
            tool_name,
            started_event_id,
            next_sequence,
        ) {
            return Ok(None);
        }
        let actual = Sha256Digest::digest_bytes(&row.canonical_bytes);
        if actual.as_str() != row.result_sha256 || row.token_input_sha256 != row.result_sha256 {
            return Ok(None);
        }
        let value = validate_canonical(&row.canonical_bytes)?;
        let inspected = inspect_result(&value, &row.canonical_bytes);
        let estimate = TokenEstimateV1 {
            token_estimator_schema_version: 1,
            estimator_id: row.estimator_id.clone(),
            tokenizer_profile_id: None,
            input_sha256: Sha256Digest::from_hex_str(&row.token_input_sha256)
                .map_err(|_| io_err("stored token hash is not hex"))?,
            content_tokens: row.estimated_tokens,
            framing_tokens: 0,
            total_tokens: row.estimated_tokens,
        };
        let input = row_as_input(&row);
        let rendered = self.render(&input, &estimate, &inspected)?;
        if rendered.preview_text != row.preview_text || rendered.preview_json != row.preview_json {
            return Ok(None);
        }
        let event = finish_envelope(
            &input,
            &estimate,
            &inspected,
            Some(&rendered),
            true,
            session_id,
            next_sequence,
            timestamp_ms,
        )?;
        Ok(Some(event))
    }

    fn render(
        &self,
        input: &PublishInput,
        estimate: &TokenEstimateV1,
        inspected: &Inspected,
    ) -> Result<RenderedPreview, ArtifactError> {
        let (applied, count, kinds) = parse_redaction(&input.redaction_json);
        render_preview(&PreviewRequest {
            artifact_id: input.artifact_id,
            tool_call_id: input.call_id.clone(),
            sha256: Sha256Digest::digest_bytes(&input.canonical_bytes),
            tool_name: input.tool_name.clone(),
            label: input.label.clone(),
            content_type: input.content_type,
            canonical_bytes: input.canonical_bytes.clone(),
            text_view: inspected.text.clone(),
            byte_count: input.canonical_bytes.len() as u64,
            line_count: inspected.line_count,
            estimated_tokens: estimate.total_tokens,
            is_error: input.status != ToolResultStatus::Success,
            exit_code: input.exit_code,
            redaction_applied: applied,
            redaction_count: count,
            redaction_kinds: kinds,
            preview_token_limit: self.policy.preview_tokens,
        })
    }

    fn persist_artifact(
        &self,
        input: &PublishInput,
        estimate: &TokenEstimateV1,
        inspected: &Inspected,
        rendered: &RenderedPreview,
        producing_sequence: u64,
        crash: Option<ArtifactCrashPoint>,
    ) -> Result<PersistStatus, ArtifactError> {
        let sha = Sha256Digest::digest_bytes(&input.canonical_bytes);
        let blob_id = format!("sha256:{}", sha.as_str());
        let conn = self.db.lock();
        conn.execute_batch("BEGIN IMMEDIATE").map_err(map_sql)?;
        let insert_result = insert_blob(
            &conn,
            input,
            estimate,
            inspected,
            &blob_id,
            sha.as_str(),
            self.clock.now_ms(),
        );
        if let Err(err) = insert_result {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(err);
        }
        if crash == Some(ArtifactCrashPoint::AfterBlobInsertBeforeCommit) {
            let _ = conn.execute_batch("ROLLBACK");
            return Ok(PersistStatus::Committed);
        }
        if crash == Some(ArtifactCrashPoint::AfterBlobCommitBeforeArtifactRow) {
            conn.execute_batch("COMMIT").map_err(map_sql)?;
            return Ok(PersistStatus::Committed);
        }
        if let Err(err) = insert_artifact_row(
            &conn,
            input,
            estimate,
            inspected,
            rendered,
            &blob_id,
            sha.as_str(),
            producing_sequence,
            self.clock.now_ms(),
        ) {
            let _ = conn.execute_batch("ROLLBACK");
            if err.code() == "HISTORY_CONSTRAINT" {
                if durable_hash_matches(&conn, input, sha.as_str())? {
                    return Ok(PersistStatus::AlreadyDurable);
                }
                return Err(io_err("durable artifact does not match this execution"));
            }
            return Err(err);
        }
        conn.execute_batch("COMMIT").map_err(map_sql)?;
        Ok(PersistStatus::Committed)
    }

    #[allow(clippy::too_many_arguments)]
    fn append_finish(
        &self,
        log: &mut EventLogStore,
        input: &PublishInput,
        estimate: &TokenEstimateV1,
        inspected: &Inspected,
        rendered: Option<&RenderedPreview>,
        recovered: bool,
        crash: Option<ArtifactCrashPoint>,
    ) -> Result<(), ArtifactError> {
        let event = finish_envelope(
            input,
            estimate,
            inspected,
            rendered,
            recovered,
            *log.session_id(),
            log.current_sequence() + 1,
            self.clock.now_ms(),
        )?;
        if crash == Some(ArtifactCrashPoint::AfterEventWriteBeforeFsync) {
            log.crash_after_event_write(&event)
                .map_err(|err| io_err(err.to_string()))?;
            return Ok(());
        }
        log.append_event(&event)
            .map_err(|err| ArtifactError::new(err.code(), "event append failed"))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PersistStatus {
    Committed,
    AlreadyDurable,
}

fn execution_finished(log: &EventLogStore, input: &PublishInput) -> Result<bool, ArtifactError> {
    let events = log
        .events()
        .map_err(|err| ArtifactError::new(err.code(), "event log could not be read"))?;
    Ok(events.iter().any(|event| match &event.event {
        CanonicalEvent::ToolExecutionFinished(finished) => {
            finished.execution_id == input.execution_id
        }
        _ => false,
    }))
}

fn durable_hash_matches(
    conn: &rusqlite::Connection,
    input: &PublishInput,
    sha: &str,
) -> Result<bool, ArtifactError> {
    let found: Option<(String, Vec<u8>)> = conn
        .query_row(
            "SELECT a.result_sha256, b.canonical_result
             FROM artifacts a
             JOIN artifact_blobs b ON b.blob_id = a.blob_id
             WHERE a.execution_id = ?1",
            [input.execution_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(map_sql)?;
    Ok(match found {
        Some((stored, bytes)) => {
            stored == sha && Sha256Digest::digest_bytes(&bytes).as_str() == sha
        }
        None => false,
    })
}

fn map_sql(err: rusqlite::Error) -> ArtifactError {
    match &err {
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::DatabaseBusy =>
        {
            ArtifactError::new("HISTORY_SQLITE_BUSY", "sqlite busy timeout")
        }
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            ArtifactError::new("HISTORY_CONSTRAINT", "artifact row already exists")
        }
        _ => io_err(err.to_string()),
    }
}

#[derive(Debug, Default)]
pub struct StagedCommits {
    items: Mutex<Vec<FinishedCall>>,
}

impl StagedCommits {
    pub fn len(&self) -> usize {
        self.items
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl ResultCommit for StagedCommits {
    fn commit(&self, finished: &FinishedCall) {
        self.items
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(finished.clone());
    }
}

struct Inspected {
    pointer: String,
    text: String,
    line_count: u64,
    stdout: Option<(i64, i64)>,
    stderr: Option<(i64, i64)>,
}

struct ArtifactRow {
    artifact_id: ArtifactId,
    producing_event_id: EventId,
    producing_sequence: u64,
    turn_id: TurnId,
    attempt_id: AttemptId,
    step_id: StepId,
    batch_id: ToolBatchId,
    execution_id: ToolExecutionId,
    execution_started: bool,
    started_event_id: Option<EventId>,
    call_id: ToolCallId,
    call_index: u32,
    tool_name: String,
    result_message_id: MessageId,
    status: ToolResultStatus,
    result_sha256: String,
    canonical_bytes: Vec<u8>,
    estimated_tokens: u64,
    estimator_id: String,
    token_input_sha256: String,
    redacted: bool,
    content_type: ArtifactContentType,
    label: Option<String>,
    normalized_path: Option<String>,
    exit_code: Option<i32>,
    preview_json: String,
    preview_text: String,
    redaction_json: String,
}

fn refuse_secrets(bytes: &[u8]) -> Result<(), ArtifactError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ArtifactError::new("HISTORY_IO", "canonical result is not utf-8"))?;
    if detect_secret_matches_v1(text).is_empty() {
        Ok(())
    } else {
        Err(ArtifactError::new(
            "HISTORY_IO",
            "secret material refused before durability",
        ))
    }
}

fn validate_canonical(bytes: &[u8]) -> Result<Value, ArtifactError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ArtifactError::new("HISTORY_IO", "canonical result is not utf-8"))?;
    let value: Value = serde_json::from_str(text)
        .map_err(|_| ArtifactError::new("HISTORY_IO", "canonical result is not json"))?;
    let again = crate::canonical_json::to_canonical_json_bytes(&value)
        .map_err(|_| ArtifactError::new("HISTORY_IO", "canonical result could not be checked"))?;
    if again.as_slice() != bytes {
        return Err(ArtifactError::new(
            "HISTORY_IO",
            "canonical result is not rfc8785",
        ));
    }
    Ok(value)
}

fn estimate_result(bytes: &[u8]) -> Result<TokenEstimateV1, ArtifactError> {
    GenericTokenEstimatorV1
        .estimate(
            TokenEstimationContext::ArtifactResult,
            bytes,
            &FramingProfileV1 {
                framing_profile_schema_version: 1,
                framing_profile_id: "history-zero-v1".to_owned(),
                fixed_tokens: 0,
                per_item_tokens: 0,
                item_count: 0,
                additional_tokens: 0,
            },
        )
        .map_err(|err| io_err(format!("token accounting overflow: {err}")))
}

fn inspect_result(value: &Value, bytes: &[u8]) -> Inspected {
    let _ = bytes;
    if let Some(data) = value.get("data").and_then(Value::as_object) {
        if let Some(inspected) = inspect_channels(data, true) {
            return inspected;
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(inspected) = inspect_channels(object, false) {
            return inspected;
        }
        if !object.is_empty() {
            return inspected_text("", &pretty_json(value), None, None);
        }
    }
    match value {
        Value::String(text) => inspected_text("", text, None, None),
        Value::Array(_) => inspected_text("", &pretty_json(value), None, None),
        _ => inspected_text("", "", None, None),
    }
}

fn inspect_channels(
    object: &serde_json::Map<String, Value>,
    under_data: bool,
) -> Option<Inspected> {
    if let Some(content) = object.get("content").and_then(Value::as_str) {
        let pointer = if under_data {
            "/data/content"
        } else {
            "/content"
        };
        return Some(inspected_text(pointer, content, None, None));
    }
    let stdout = object.get("stdout").and_then(Value::as_str);
    let stderr = object.get("stderr").and_then(Value::as_str);
    if let (Some(stdout), Some(stderr)) = (stdout, stderr) {
        let text = format!("{stdout}{stderr}");
        let stdout_end = stdout.len() as i64;
        let stderr_end = text.len() as i64;
        return Some(inspected_text(
            "",
            &text,
            Some((0, stdout_end)),
            Some((stdout_end, stderr_end)),
        ));
    }
    if let Some(stdout) = stdout {
        if !stdout.is_empty() && stderr.unwrap_or("").is_empty() {
            let pointer = if under_data {
                "/data/stdout"
            } else {
                "/stdout"
            };
            return Some(inspected_text(pointer, stdout, None, None));
        }
    }
    None
}

fn inspected_text(
    pointer: &str,
    text: &str,
    stdout: Option<(i64, i64)>,
    stderr: Option<(i64, i64)>,
) -> Inspected {
    Inspected {
        pointer: pointer.to_owned(),
        line_count: line_count_of(text),
        text: text.to_owned(),
        stdout,
        stderr,
    }
}

fn pretty_json(value: &Value) -> String {
    let mut out = String::new();
    write_pretty(value, 0, &mut out);
    out
}

fn write_pretty(value: &Value, indent: usize, out: &mut String) {
    match value {
        Value::Object(map) => {
            out.push_str("{\n");
            let mut keys: Vec<_> = map.keys().cloned().collect();
            keys.sort();
            for (index, key) in keys.iter().enumerate() {
                pad(out, indent + 1);
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push_str(": ");
                write_pretty(&map[key], indent + 1, out);
                if index + 1 != keys.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            pad(out, indent);
            out.push('}');
        }
        Value::Array(items) => {
            out.push_str("[\n");
            for (index, item) in items.iter().enumerate() {
                pad(out, indent + 1);
                write_pretty(item, indent + 1, out);
                if index + 1 != items.len() {
                    out.push(',');
                }
                out.push('\n');
            }
            pad(out, indent);
            out.push(']');
        }
        other => out.push_str(&serde_json::to_string(other).unwrap_or_else(|_| "null".to_owned())),
    }
}

fn pad(out: &mut String, indent: usize) {
    for _ in 0..indent {
        out.push_str("  ");
    }
}

fn insert_blob(
    conn: &rusqlite::Connection,
    input: &PublishInput,
    estimate: &TokenEstimateV1,
    inspected: &Inspected,
    blob_id: &str,
    sha: &str,
    created_at_ms: i64,
) -> Result<(), ArtifactError> {
    conn.execute(
        "INSERT OR IGNORE INTO artifact_blobs(
            blob_id, sha256, canonical_result, byte_count, line_count, estimated_tokens,
            token_estimator_schema_version, token_estimator_id, token_input_sha256,
            result_encoding, redaction_version, redaction_json, created_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 'rfc8785-json', ?9, ?10, ?11)",
        params![
            blob_id,
            sha,
            input.canonical_bytes,
            input.canonical_bytes.len() as i64,
            inspected.line_count as i64,
            estimate.total_tokens as i64,
            estimate.estimator_id,
            estimate.input_sha256.as_str(),
            crate::protocol::constants::REDACTION_VERSION,
            input.redaction_json,
            created_at_ms,
        ],
    )
    .map_err(map_sql)?;
    let existing: Vec<u8> = conn
        .query_row(
            "SELECT canonical_result FROM artifact_blobs WHERE sha256 = ?1",
            [sha],
            |row| row.get(0),
        )
        .map_err(map_sql)?;
    if existing != input.canonical_bytes {
        return Err(ArtifactError::new(
            "HISTORY_CANONICAL_DB_CORRUPT",
            "blob hash collision with unequal bytes",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_artifact_row(
    conn: &rusqlite::Connection,
    input: &PublishInput,
    estimate: &TokenEstimateV1,
    inspected: &Inspected,
    rendered: &RenderedPreview,
    blob_id: &str,
    sha: &str,
    producing_sequence: u64,
    created_at_ms: i64,
) -> Result<(), ArtifactError> {
    let (stdout_start, stdout_end) = match inspected.stdout {
        Some((start, end)) => (Some(start), Some(end)),
        None => (None, None),
    };
    let (stderr_start, stderr_end) = match inspected.stderr {
        Some((start, end)) => (Some(start), Some(end)),
        None => (None, None),
    };
    conn.execute(
        "INSERT INTO artifacts(
            artifact_id, blob_id, producing_event_id, producing_sequence, turn_id, attempt_id,
            step_id, batch_id, execution_id, execution_started, started_event_id, tool_call_id,
            call_index, tool_name, result_message_id, result_status, result_media_type,
            result_sha256, result_byte_count, result_line_count, result_estimated_tokens,
            result_redacted, normalized_label, normalized_path, content_type, is_error,
            default_json_pointer, source_line_start, source_line_end, exit_code,
            text_view_byte_count, stdout_start_byte, stdout_end_byte, stderr_start_byte,
            stderr_end_byte, preview_schema_version, preview_json, preview_text,
            preview_estimated_tokens, preview_estimator_id, preview_input_sha256, created_at_ms
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
            ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, NULL, NULL, ?28, ?29, ?30, ?31,
            ?32, ?33, 1, ?34, ?35, ?36, ?37, ?38, ?39
         )",
        params![
            input.artifact_id.to_string(),
            blob_id,
            input.finish_event_id.to_string(),
            producing_sequence as i64,
            input.turn_id.to_string(),
            input.attempt_id.to_string(),
            input.step_id.to_string(),
            input.batch_id.to_string(),
            input.execution_id.to_string(),
            if input.execution_started { 1 } else { 0 },
            input.started_event_id.map(|id| id.to_string()),
            input.call_id.as_str(),
            input.call_index as i64,
            input.tool_name,
            input.result_message_id.to_string(),
            status_sql(&input.status),
            RESULT_MEDIA_TYPE,
            sha,
            input.canonical_bytes.len() as i64,
            inspected.line_count as i64,
            estimate.total_tokens as i64,
            if input.redacted { 1 } else { 0 },
            input.label,
            input.normalized_path,
            input.content_type.as_sql(),
            if input.status == ToolResultStatus::Success {
                0
            } else {
                1
            },
            inspected.pointer,
            input.exit_code,
            inspected.text.len() as i64,
            stdout_start,
            stdout_end,
            stderr_start,
            stderr_end,
            rendered.preview_json,
            rendered.preview_text,
            rendered.estimated_preview_tokens as i64,
            rendered.estimator_id,
            rendered.input_sha256.as_str(),
            created_at_ms,
        ],
    )
    .map_err(map_sql)?;
    Ok(())
}

fn status_sql(status: &ToolResultStatus) -> &'static str {
    match status {
        ToolResultStatus::Success => "success",
        ToolResultStatus::Error => "error",
        ToolResultStatus::Blocked => "blocked",
        ToolResultStatus::Cancelled => "cancelled",
        ToolResultStatus::Uncertain => "uncertain",
        ToolResultStatus::Skipped => "skipped",
    }
}

fn parse_status(value: &str) -> Option<ToolResultStatus> {
    Some(match value {
        "success" => ToolResultStatus::Success,
        "error" => ToolResultStatus::Error,
        "blocked" => ToolResultStatus::Blocked,
        "cancelled" => ToolResultStatus::Cancelled,
        "uncertain" => ToolResultStatus::Uncertain,
        "skipped" => ToolResultStatus::Skipped,
        _ => return None,
    })
}

fn parse_content(value: &str) -> Option<ArtifactContentType> {
    Some(match value {
        "text" => ArtifactContentType::Text,
        "code" => ArtifactContentType::Code,
        "diff" => ArtifactContentType::Diff,
        "log" => ArtifactContentType::Log,
        "json" => ArtifactContentType::Json,
        "test_output" => ArtifactContentType::TestOutput,
        "build_output" => ArtifactContentType::BuildOutput,
        "search_results" => ArtifactContentType::SearchResults,
        "error" => ArtifactContentType::Error,
        "binary" => ArtifactContentType::Binary,
        "other" => ArtifactContentType::Other,
        _ => return None,
    })
}

fn parse_redaction(json: &str) -> (bool, u32, Vec<String>) {
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return (false, 0, Vec::new());
    };
    let applied = value
        .get("applied")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let count = value
        .get("replacement_count")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    let kinds = value
        .get("kinds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    (applied, count, kinds)
}

#[allow(clippy::too_many_arguments)]
fn finish_envelope(
    input: &PublishInput,
    estimate: &TokenEstimateV1,
    _inspected: &Inspected,
    rendered: Option<&RenderedPreview>,
    recovered: bool,
    session_id: SessionId,
    sequence: u64,
    timestamp_ms: i64,
) -> Result<EventEnvelope, ArtifactError> {
    let sha = Sha256Digest::digest_bytes(&input.canonical_bytes);
    let content = if let Some(rendered) = rendered {
        ToolResultContent::Artifact(ArtifactToolResult {
            preview: rendered.preview_text.clone(),
            reference: ArtifactRef {
                artifact_id: input.artifact_id,
                sha256: sha.clone(),
                media_type: RESULT_MEDIA_TYPE.to_owned(),
                byte_count: input.canonical_bytes.len() as u64,
                line_count: None,
                estimated_tokens: estimate.total_tokens,
                token_estimator_schema_version: 1,
                estimator_id: estimate.estimator_id.clone(),
                token_input_sha256: estimate.input_sha256.clone(),
                retrieval: ArtifactRetrieval {
                    tool: "retrieve_artifact".to_owned(),
                    arguments: {
                        let mut map = serde_json::Map::new();
                        map.insert(
                            "artifact_id".to_owned(),
                            Value::String(input.artifact_id.to_string()),
                        );
                        map
                    },
                },
            },
        })
    } else {
        let text = String::from_utf8(input.canonical_bytes.clone())
            .map_err(|_| ArtifactError::new("HISTORY_IO", "inline result is not utf-8"))?;
        ToolResultContent::Inline(InlineToolResult { text })
    };
    Ok(EventEnvelope {
        schema_version: crate::protocol::constants::EVENT_SCHEMA_VERSION,
        event_id: input.finish_event_id,
        session_id,
        sequence,
        timestamp_ms,
        turn_id: Some(input.turn_id),
        attempt_id: Some(input.attempt_id),
        event: CanonicalEvent::ToolExecutionFinished(ToolExecutionFinished {
            batch_id: input.batch_id,
            execution_id: input.execution_id,
            step_id: input.step_id,
            call_id: input.call_id.clone(),
            call_index: input.call_index,
            started_event_id: input.started_event_id,
            result: ToolResultMessage {
                message_id: input.result_message_id,
                turn_id: input.turn_id,
                step_id: input.step_id,
                batch_id: input.batch_id,
                execution_id: input.execution_id,
                call_id: input.call_id.clone(),
                tool_name: input.tool_name.clone(),
                status: input.status.clone(),
                body: ToolResultBody {
                    media_type: RESULT_MEDIA_TYPE.to_owned(),
                    content,
                    sha256: sha,
                    byte_count: input.canonical_bytes.len() as u64,
                    line_count: None,
                    estimated_tokens: estimate.total_tokens,
                    token_estimator_schema_version: 1,
                    estimator_id: estimate.estimator_id.clone(),
                    token_input_sha256: estimate.input_sha256.clone(),
                    redacted: input.redacted,
                },
                recovered,
            },
        }),
    })
}

fn load_artifact_row(
    conn: &rusqlite::Connection,
    execution_id: &ToolExecutionId,
) -> Result<Option<ArtifactRow>, ArtifactError> {
    conn.query_row(
        "SELECT a.artifact_id, a.producing_event_id, a.producing_sequence, a.turn_id, a.attempt_id,
                a.step_id, a.batch_id, a.execution_id, a.execution_started, a.started_event_id,
                a.tool_call_id, a.call_index, a.tool_name, a.result_message_id, a.result_status,
                a.result_sha256, b.canonical_result, b.estimated_tokens, b.token_estimator_id,
                b.token_input_sha256, a.result_redacted, a.content_type, a.normalized_label,
                a.normalized_path, a.exit_code, a.preview_json, a.preview_text, b.redaction_json
         FROM artifacts a
         JOIN artifact_blobs b ON b.blob_id = a.blob_id
         WHERE a.execution_id = ?1",
        [execution_id.to_string()],
        |row| {
            let status =
                parse_status(&row.get::<_, String>(14)?).unwrap_or(ToolResultStatus::Uncertain);
            let content =
                parse_content(&row.get::<_, String>(21)?).unwrap_or(ArtifactContentType::Other);
            let started: Option<String> = row.get(9)?;
            Ok(ArtifactRow {
                artifact_id: ArtifactId::from_str_canonical(&row.get::<_, String>(0)?)
                    .unwrap_or_else(|_| unreachable_id()),
                producing_event_id: EventId::from_str_canonical(&row.get::<_, String>(1)?)
                    .unwrap_or_else(|_| unreachable_id()),
                producing_sequence: row.get::<_, i64>(2)? as u64,
                turn_id: TurnId::from_str_canonical(&row.get::<_, String>(3)?)
                    .unwrap_or_else(|_| unreachable_id()),
                attempt_id: AttemptId::from_str_canonical(&row.get::<_, String>(4)?)
                    .unwrap_or_else(|_| unreachable_id()),
                step_id: StepId::from_str_canonical(&row.get::<_, String>(5)?)
                    .unwrap_or_else(|_| unreachable_id()),
                batch_id: ToolBatchId::from_str_canonical(&row.get::<_, String>(6)?)
                    .unwrap_or_else(|_| unreachable_id()),
                execution_id: ToolExecutionId::from_str_canonical(&row.get::<_, String>(7)?)
                    .unwrap_or_else(|_| unreachable_id()),
                execution_started: row.get::<_, i64>(8)? == 1,
                started_event_id: started
                    .and_then(|value| EventId::from_str_canonical(&value).ok()),
                call_id: ToolCallId::from_str_canonical(&row.get::<_, String>(10)?)
                    .unwrap_or_else(|_| ToolCallId::from_str_canonical("invalid").expect("call")),
                call_index: row.get::<_, i64>(11)? as u32,
                tool_name: row.get(12)?,
                result_message_id: MessageId::from_str_canonical(&row.get::<_, String>(13)?)
                    .unwrap_or_else(|_| unreachable_id()),
                status,
                result_sha256: row.get(15)?,
                canonical_bytes: row.get(16)?,
                estimated_tokens: row.get::<_, i64>(17)? as u64,
                estimator_id: row.get(18)?,
                token_input_sha256: row.get(19)?,
                redacted: row.get::<_, i64>(20)? == 1,
                content_type: content,
                label: row.get(22)?,
                normalized_path: row.get(23)?,
                exit_code: row.get(24)?,
                preview_json: row.get(25)?,
                preview_text: row.get(26)?,
                redaction_json: row.get(27)?,
            })
        },
    )
    .optional()
    .map_err(|err| io_err(err.to_string()))
}

fn unreachable_id<T: crate::id::ProtocolUlidId>() -> T {
    T::from_validated_ulid(ulid::Ulid::from_string("01ARZ3NDEKTSV4RRFFQ69G5FAV").expect("ulid"))
}

#[allow(clippy::too_many_arguments)]
fn proof_matches(
    row: &ArtifactRow,
    turn_id: TurnId,
    attempt_id: AttemptId,
    batch_id: &ToolBatchId,
    step_id: &StepId,
    call_id: &ToolCallId,
    call_index: u32,
    tool_name: &str,
    started_event_id: Option<EventId>,
    next_sequence: u64,
) -> bool {
    row.producing_sequence == next_sequence
        && row.turn_id == turn_id
        && row.attempt_id == attempt_id
        && row.batch_id == *batch_id
        && row.step_id == *step_id
        && row.call_id == *call_id
        && row.call_index == call_index
        && row.tool_name == tool_name
        && row.execution_started
        && row.started_event_id == started_event_id
        && !row.estimator_id.is_empty()
        && !row.token_input_sha256.is_empty()
}

fn row_as_input(row: &ArtifactRow) -> PublishInput {
    PublishInput {
        artifact_id: row.artifact_id,
        finish_event_id: row.producing_event_id,
        result_message_id: row.result_message_id,
        canonical_bytes: row.canonical_bytes.clone(),
        content_type: row.content_type,
        tool_name: row.tool_name.clone(),
        call_id: row.call_id.clone(),
        call_index: row.call_index,
        execution_id: row.execution_id,
        batch_id: row.batch_id,
        step_id: row.step_id,
        turn_id: row.turn_id,
        attempt_id: row.attempt_id,
        execution_started: row.execution_started,
        started_event_id: row.started_event_id,
        status: row.status.clone(),
        label: row.label.clone(),
        normalized_path: row.normalized_path.clone(),
        exit_code: row.exit_code,
        redacted: row.redacted,
        redaction_json: row.redaction_json.clone(),
        force_binary: matches!(row.content_type, ArtifactContentType::Binary),
    }
}
