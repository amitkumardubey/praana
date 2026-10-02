//! P4A history built-in tools (orders 100, 110, 120).
//!
//! Schemas, descriptions, and error mapping follow Built-in Tool Catalog
//! §6.1–§6.4. Success values are bounded by History §10.4: the RFC 8785 bytes
//! of the complete output DTO never exceed `HISTORY_TOOL_RESULT_MAX_BYTES`.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::files::access;
use crate::history::db::HistoryDatabase;
use crate::history::error::{map_sqlite, ArtifactError};
use crate::history::event_log::read_cursor_hmac_key;
use crate::history::retrieve::{
    read_session_source, read_session_source_bounded, retrieve_artifact, ReadSessionSourceRequest,
    ReadSessionSourceResponse, RetrieveArtifactRequest, RetrieveArtifactResponse,
    HISTORY_TOOL_RESULT_MAX_BYTES,
};
use crate::history::search::{
    read_transaction, search_session_with_cache, SearchSourceKind, SessionSearchFilters,
    SessionSearchMode, SessionSearchPage, SessionSearchRequest, SnapshotBm25Cache,
};
use crate::protocol::id::{ArtifactId, EventId, SearchResultId, StateId, SummarySegmentId};
use crate::tools::contract::{ErasedTool, TypedTool};
use crate::tools::error::{history_tool_error, ToolError, ToolErrorCode};
use crate::tools::intent::{
    ToolExecutionContext, ToolIdempotency, ToolInspectContext, ToolIntent, ToolMutation,
};
use crate::tools::registry::ToolRegistry;
use crate::tools::{PathAccessMode, ToolCapabilities};

pub fn default_session_search_limit() -> u32 {
    20
}

/// Built-in Tool Catalog §6.1 input.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchSessionLogInput {
    pub query: String,
    pub mode: Option<SessionSearchMode>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub source_kinds: Vec<SearchSourceKind>,
    #[serde(default)]
    pub event_ids: Vec<EventId>,
    #[serde(default)]
    pub artifact_ids: Vec<ArtifactId>,
    #[serde(default)]
    pub summary_segment_ids: Vec<SummarySegmentId>,
    #[serde(default)]
    pub state_ids: Vec<StateId>,
    #[serde(default)]
    pub include_prior_epochs: bool,
    #[serde(default = "default_session_search_limit")]
    pub limit: u32,
    pub cursor: Option<String>,
}

/// Built-in Tool Catalog §6.1 success value.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchSessionLogOutput {
    pub page: SessionSearchPage,
}

/// Catalog §6.2: the tool input is exactly History `RetrieveArtifactRequest`.
pub type RetrieveArtifactInput = RetrieveArtifactRequest;

/// Built-in Tool Catalog §6.2 success value.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RetrieveArtifactOutput {
    pub artifact: RetrieveArtifactResponse,
}

/// Built-in Tool Catalog §6.3 input.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReadSessionSourceInput {
    pub result_id: SearchResultId,
    #[serde(default)]
    pub byte_offset: u64,
}

impl From<ReadSessionSourceInput> for ReadSessionSourceRequest {
    fn from(input: ReadSessionSourceInput) -> Self {
        Self {
            result_id: input.result_id,
            byte_offset: input.byte_offset,
        }
    }
}

/// Built-in Tool Catalog §6.3 success value.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReadSessionSourceOutput {
    pub source: ReadSessionSourceResponse,
}

pub struct SearchSessionLogTool;
pub struct RetrieveArtifactTool;
pub struct ReadSessionSourceTool;

pub fn phase4_history_tools() -> Result<Vec<Arc<dyn ErasedTool>>, ToolError> {
    Ok(vec![
        super::adapt(SearchSessionLogTool)?,
        super::adapt(RetrieveArtifactTool)?,
        super::adapt(ReadSessionSourceTool)?,
    ])
}

pub fn register_phase4_history() -> Result<ToolRegistry, ToolError> {
    ToolRegistry::try_from_erased(phase4_history_tools()?)
}

fn history_intent() -> ToolIntent {
    ToolIntent {
        mutation: ToolMutation::ReadOnly,
        path_accesses: vec![access(".", PathAccessMode::Read)],
        command: None,
        risk_facts: Vec::new(),
        timeout_ms: 30_000,
        idempotency: ToolIdempotency::ReadOnly,
        planned: Vec::new(),
    }
}

fn artifact_err(error: ArtifactError) -> ToolError {
    history_tool_error(error.code(), error.message())
}

/// History §12: search and retrieval use a separate read-only connection, so
/// WAL readers proceed while the writer commits. The writer lock is never
/// taken on a tool path.
fn open_history_read_only(session_dir: &Path) -> Result<HistoryDatabase, ToolError> {
    HistoryDatabase::open_read_only(&session_dir.join("history.db")).map_err(artifact_err)
}

fn check_cancel(cancel: &CancellationToken) -> Result<(), ToolError> {
    if cancel.is_cancelled() {
        return Err(history_tool_error("HISTORY_CANCELLED", "cancelled"));
    }
    Ok(())
}

/// History §10.4: the RFC 8785 bytes of a complete tool output DTO.
fn canonical_len<T: Serialize>(value: &T) -> Result<usize, ToolError> {
    let bytes = crate::canonical_json::to_canonical_json_bytes(value)
        .map_err(|err| ToolError::new(ToolErrorCode::ToolSerializationFailed, err.to_string()))?;
    Ok(bytes.len())
}

fn fits_bound<T: Serialize>(value: &T) -> Result<bool, ToolError> {
    Ok(canonical_len(value)? <= HISTORY_TOOL_RESULT_MAX_BYTES)
}

/// Binary-search the largest candidate bound whose output DTO fits
/// History §10.4. Candidates are tried ascending; the caller must have
/// already tested the complete remainder.
fn fit_bound<F, T>(mut low: u64, mut high: u64, mut probe: F) -> Result<T, ToolError>
where
    F: FnMut(u64) -> Result<T, ToolError>,
    T: Serialize,
{
    let mut best: Option<T> = None;
    while low <= high {
        let mid = low + (high - low) / 2;
        let candidate = probe(mid)?;
        if fits_bound(&candidate)? {
            best = Some(candidate);
            low = mid + 1;
        } else {
            if mid == 1 {
                break;
            }
            high = mid - 1;
        }
    }
    best.ok_or_else(|| {
        history_tool_error(
            "HISTORY_ARTIFACT_TOO_LARGE",
            "no candidate fits the tool result bound",
        )
    })
}

fn join_error(err: tokio::task::JoinError) -> ToolError {
    ToolError::new(
        ToolErrorCode::ToolInternal,
        format!("history tool task: {err}"),
    )
}

#[async_trait]
impl TypedTool for SearchSessionLogTool {
    type Input = SearchSessionLogInput;
    type Output = SearchSessionLogOutput;
    const NAME: &'static str = "search_session_log";
    const ORDER: u16 = 100;
    const DESCRIPTION: &'static str = "Search accepted session history, audit events, artifacts, summaries, or StateGraph evidence with exact or FTS ranking.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::empty()
    }

    fn inspect(
        &self,
        _input: &SearchSessionLogInput,
        _context: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        Ok(history_intent())
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: SearchSessionLogInput,
        cancel: CancellationToken,
    ) -> Result<SearchSessionLogOutput, ToolError> {
        if input.limit == 0 {
            return Err(history_tool_error(
                "HISTORY_SEARCH_QUERY",
                "limit must be at least 1",
            ));
        }
        let request = SessionSearchRequest {
            query: input.query,
            mode: input.mode.unwrap_or(SessionSearchMode::Fts),
            case_sensitive: input.case_sensitive,
            filters: SessionSearchFilters {
                source_kinds: input.source_kinds,
                event_ids: input.event_ids,
                artifact_ids: input.artifact_ids,
                summary_segment_ids: input.summary_segment_ids,
                state_ids: input.state_ids.iter().map(|id| id.to_string()).collect(),
                include_prior_epochs: input.include_prior_epochs,
                ..SessionSearchFilters::default()
            },
            limit: input.limit.min(100),
            cursor: input.cursor,
        };
        let session_dir = context.session_dir.clone();
        let worker_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || -> Result<SearchSessionLogOutput, ToolError> {
            let hmac_key = read_cursor_hmac_key(&session_dir)
                .map_err(|err| history_tool_error(err.code(), err.to_string()))?;
            let db = open_history_read_only(&session_dir)?;
            let conn = db.lock();
            // History §12: the checkpoint read, the candidate fetch, and every
            // size-fitting retry share one deferred read transaction. The BM25
            // copy is built once for that snapshot and reused by the retries.
            let mut bm25 = SnapshotBm25Cache::new();
            read_transaction(
                &conn,
                |err| artifact_err(map_sqlite(err)),
                |conn| {
                    let page = search_session_with_cache(
                        conn,
                        &request,
                        &hmac_key,
                        &worker_cancel,
                        &mut bm25,
                    )
                    .map_err(artifact_err)?;
                    let output = SearchSessionLogOutput { page };
                    if fits_bound(&output)? {
                        return Ok(output);
                    }
                    // History §10.4: add results in rank order; the largest fitting
                    // prefix is found by re-querying with smaller limits, so the
                    // storage side computes each candidate's `next_cursor`.
                    let total = output.page.results.len();
                    if total == 0 {
                        return Err(history_tool_error(
                            "HISTORY_ARTIFACT_TOO_LARGE",
                            "the search page does not fit the tool result bound",
                        ));
                    }
                    fit_bound(1, total as u64, |limit| {
                        check_cancel(&worker_cancel)?;
                        let mut probe_request = request.clone();
                        probe_request.limit = limit as u32;
                        let page = search_session_with_cache(
                            conn,
                            &probe_request,
                            &hmac_key,
                            &worker_cancel,
                            &mut bm25,
                        )
                        .map_err(artifact_err)?;
                        Ok(SearchSessionLogOutput { page })
                    })
                },
            )
        })
        .await
        .map_err(join_error)?
    }
}

#[async_trait]
impl TypedTool for RetrieveArtifactTool {
    type Input = RetrieveArtifactInput;
    type Output = RetrieveArtifactOutput;
    const NAME: &'static str = "retrieve_artifact";
    const ORDER: u16 = 110;
    const DESCRIPTION: &'static str =
        "Read a bounded immutable artifact by ID using one byte, line, grep, or JSON-pointer selection.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::ARTIFACT_READ
    }

    fn inspect(
        &self,
        _input: &RetrieveArtifactInput,
        _context: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        Ok(history_intent())
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: RetrieveArtifactInput,
        cancel: CancellationToken,
    ) -> Result<RetrieveArtifactOutput, ToolError> {
        let session_dir = context.session_dir.clone();
        let worker_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || -> Result<RetrieveArtifactOutput, ToolError> {
            let db = open_history_read_only(&session_dir)?;
            let conn = db.lock();
            let response =
                retrieve_artifact(&conn, &input, &worker_cancel).map_err(artifact_err)?;
            let output = RetrieveArtifactOutput { artifact: response };
            if fits_bound(&output)? {
                return Ok(output);
            }
            // History §10.4: binary-search the largest `max_bytes` candidate
            // that fits; storage continuation rules apply unchanged.
            let high = input.max_bytes.unwrap_or(2 * 1024 * 1024).max(1);
            fit_bound(1, high, |max_bytes| {
                check_cancel(&worker_cancel)?;
                let mut probe = input.clone();
                probe.max_bytes = Some(max_bytes);
                let response =
                    retrieve_artifact(&conn, &probe, &worker_cancel).map_err(artifact_err)?;
                Ok(RetrieveArtifactOutput { artifact: response })
            })
        })
        .await
        .map_err(join_error)?
    }
}

#[async_trait]
impl TypedTool for ReadSessionSourceTool {
    type Input = ReadSessionSourceInput;
    type Output = ReadSessionSourceOutput;
    const NAME: &'static str = "read_session_source";
    const ORDER: u16 = 120;
    const DESCRIPTION: &'static str =
        "Read a bounded byte window of one event-sourced session search result by its result_id.";

    fn static_capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::empty()
    }

    fn inspect(
        &self,
        _input: &ReadSessionSourceInput,
        _context: &ToolInspectContext,
    ) -> Result<ToolIntent, ToolError> {
        Ok(history_intent())
    }

    async fn execute(
        &self,
        context: ToolExecutionContext,
        input: ReadSessionSourceInput,
        cancel: CancellationToken,
    ) -> Result<ReadSessionSourceOutput, ToolError> {
        let request = ReadSessionSourceRequest::from(input);
        let session_dir = context.session_dir.clone();
        let worker_cancel = cancel.clone();
        tokio::task::spawn_blocking(move || -> Result<ReadSessionSourceOutput, ToolError> {
            let db = open_history_read_only(&session_dir)?;
            let conn = db.lock();
            let response =
                read_session_source(&conn, &request, &worker_cancel).map_err(artifact_err)?;
            let output = ReadSessionSourceOutput { source: response };
            if fits_bound(&output)? {
                return Ok(output);
            }
            // History §10.4: binary-search the largest window bound that fits.
            fit_bound(1, HISTORY_TOOL_RESULT_MAX_BYTES as u64, |max_bytes| {
                check_cancel(&worker_cancel)?;
                let response =
                    read_session_source_bounded(&conn, &request, &worker_cancel, max_bytes)
                        .map_err(artifact_err)?;
                Ok(ReadSessionSourceOutput { source: response })
            })
        })
        .await
        .map_err(join_error)?
    }
}
