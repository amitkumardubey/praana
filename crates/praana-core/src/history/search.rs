//! Unified session search (History §11).

use std::cmp::Reverse;
use std::collections::HashMap;

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use regex::{Regex, RegexBuilder};
use rusqlite::types::Value as SqlValue;
use rusqlite::OptionalExtension;
use schemars::JsonSchema;
use tokio_util::sync::CancellationToken;

use super::checkpoint::{HistoryDerivedCheckpointV1, PROJECTION_NAME};
use super::cursor::{decode_cursor, encode_cursor, SessionSearchCursorV2, CURSOR_SCHEMA_VERSION};
use super::error::{map_sqlite, ArtifactError};
use crate::canonical_json::to_canonical_json_bytes;
use crate::protocol::errors::HistoryError;
use crate::protocol::id::{
    ArtifactId, EventId, SearchResultId, SessionId, Sha256Digest, SummarySegmentId, TurnId,
};
use crate::unicode::default_casefold_v1_with_offsets;

pub const SEARCH_SCHEMA_VERSION: u32 = 1;

const QUERY_MAX_BYTES: usize = 4096;
const CURSOR_TOTAL_MAX_BYTES: usize = 64 * 1024;
const FILTER_MAX_VALUES: usize = 100;
const PATH_GLOB_MAX_COUNT: usize = 32;
const PATH_GLOB_MAX_BYTES: usize = 4096;
const PAGE_LIMIT_MAX: u32 = 100;
const OCCURRENCE_CAP: usize = 100;
const EXCERPT_MAX_BYTES: usize = 800;
const CANCEL_CHECK_INTERVAL: usize = 128;

/// Snake-case `CanonicalEvent` tags accepted by `event_kinds` (History §11.2).
const EVENT_KIND_TAGS: [&str; 17] = [
    "session_started",
    "user_message_accepted",
    "turn_started",
    "assistant_attempt_started",
    "assistant_attempt_failed",
    "assistant_step_accepted",
    "attempt_superseded",
    "tool_execution_started",
    "tool_execution_finished",
    "tool_batch_completed",
    "turn_committed",
    "turn_interrupted",
    "state_changed",
    "history_compacted",
    "model_changed",
    "reset_boundary",
    "system_note",
];

/// History §12: one read transaction covers the checkpoint read and the
/// candidate fetch. A caller that already holds a deferred read transaction
/// (the tool's size-fitting retries) keeps that snapshot.
pub(crate) fn read_transaction<T, E>(
    conn: &rusqlite::Connection,
    mut map_begin: impl FnMut(rusqlite::Error) -> E,
    body: impl FnOnce(&rusqlite::Connection) -> Result<T, E>,
) -> Result<T, E> {
    let owns = conn.is_autocommit();
    if owns {
        conn.execute_batch("BEGIN DEFERRED")
            .map_err(&mut map_begin)?;
    }
    let result = body(conn);
    if owns {
        match &result {
            Ok(_) => {
                if let Err(err) = conn.execute_batch("COMMIT").map_err(&mut map_begin) {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(err);
                }
            }
            Err(_) => {
                let _ = conn.execute_batch("ROLLBACK");
            }
        }
    }
    result
}

/// BM25 values for one query at one snapshot `P`. A tool request builds this
/// once and reuses it for size-fitting retries.
pub(crate) struct SnapshotBm25Cache {
    query: String,
    snapshot: u64,
    scores: HashMap<i64, f64>,
    filled: bool,
}

impl SnapshotBm25Cache {
    pub(crate) fn new() -> Self {
        Self {
            query: String::new(),
            snapshot: 0,
            scores: HashMap::new(),
            filled: false,
        }
    }

    fn matches(&self, query: &str, snapshot: u64) -> bool {
        self.filled && self.snapshot == snapshot && self.query == query
    }

    fn store(&mut self, query: &str, snapshot: u64, scores: HashMap<i64, f64>) {
        self.query = query.to_owned();
        self.snapshot = snapshot;
        self.scores = scores;
        self.filled = true;
    }
}

pub fn search_session(
    conn: &rusqlite::Connection,
    request: &SessionSearchRequest,
    hmac_key: &[u8; 32],
    cancel: &CancellationToken,
) -> Result<SessionSearchPage, ArtifactError> {
    let mut cache = SnapshotBm25Cache::new();
    search_session_with_cache(conn, request, hmac_key, cancel, &mut cache)
}

pub(crate) fn search_session_with_cache(
    conn: &rusqlite::Connection,
    request: &SessionSearchRequest,
    hmac_key: &[u8; 32],
    cancel: &CancellationToken,
    cache: &mut SnapshotBm25Cache,
) -> Result<SessionSearchPage, ArtifactError> {
    validate_request(request)?;
    check_cancel(cancel)?;
    read_transaction(conn, map_sqlite, |conn| {
        search_session_in_read(conn, request, hmac_key, cancel, cache)
    })
}

fn search_session_in_read(
    conn: &rusqlite::Connection,
    request: &SessionSearchRequest,
    hmac_key: &[u8; 32],
    cancel: &CancellationToken,
    cache: &mut SnapshotBm25Cache,
) -> Result<SessionSearchPage, ArtifactError> {
    let (session_id, reset_epoch, current_projection) = load_projection_context(conn)?;
    let request_sha256 = compute_request_sha256(request)?;
    let regex = compile_query_regex(request)?;
    let globs = compile_path_globs(&request.filters.path_globs)?;
    let cursor = match &request.cursor {
        Some(encoded) => Some(decode_cursor(
            encoded,
            hmac_key,
            &request_sha256,
            reset_epoch,
            current_projection,
            &session_id,
        )?),
        None => None,
    };
    // History §11.2: a first page freezes P after catch-up. Continuations keep
    // that snapshot instead of the projection sequence at read time.
    let snapshot = cursor
        .as_ref()
        .map(|cursor| cursor.projection_through_sequence)
        .unwrap_or(current_projection);

    let plan = match request.mode {
        SessionSearchMode::Exact if request.query.is_empty() => MatchPlan::IdsOnly,
        SessionSearchMode::Exact if request.case_sensitive => MatchPlan::Literal {
            needle: request.query.clone(),
            case_sensitive: true,
        },
        SessionSearchMode::Exact => MatchPlan::Literal {
            needle: request.query.clone(),
            case_sensitive: false,
        },
        SessionSearchMode::Regex => MatchPlan::Pattern(regex.as_ref().expect("regex compiles")),
        SessionSearchMode::Fts => {
            let node = parse_fts_query(&request.query)?;
            let mut positives = Vec::new();
            collect_positive_atoms(&node, false, &mut positives);
            MatchPlan::Fts(positives)
        }
    };

    let mut candidates = fetch_candidates(conn, request, reset_epoch, snapshot, &globs, cancel)?;
    if matches!(request.mode, SessionSearchMode::Fts) {
        // History §11.4: execute bm25(search_fts, 1.0). When rows exist past
        // P, rank from a copy of every row with event_sequence <= P in every
        // epoch. That is the index search_fts held when P was applied. The
        // epoch filter stays on candidate selection.
        apply_snapshot_bm25(
            conn,
            &request.query,
            snapshot,
            cancel,
            cache,
            &mut candidates,
        )?;
    }
    let mut results = Vec::with_capacity(candidates.len());
    for row in candidates {
        let Some(ranges) = match_ranges(&row.text, &plan) else {
            continue;
        };
        let mut ranges = ranges;
        ranges.sort_unstable();
        ranges.dedup();
        let first_range = ranges.first().copied();
        let occurrences = to_occurrences(&row.text, &ranges);
        let score = match request.mode {
            SessionSearchMode::Exact => SearchScore {
                primary_micros: 1_000_000,
                raw_bm25_micros: None,
                rank_reason: "exact".to_owned(),
            },
            SessionSearchMode::Regex => SearchScore {
                primary_micros: 1_000_000,
                raw_bm25_micros: None,
                rank_reason: "regex".to_owned(),
            },
            SessionSearchMode::Fts => {
                let raw = row.bm25.unwrap_or(0.0);
                let raw_micros = (raw * 1_000_000.0).round() as i64;
                SearchScore {
                    primary_micros: -raw_micros,
                    raw_bm25_micros: Some(raw_micros),
                    rank_reason: "fts".to_owned(),
                }
            }
        };
        let result_id = SearchResultId::from_str_canonical(&row.document_id).map_err(|_| {
            ArtifactError::new("HISTORY_EVENT_INTEGRITY", "indexed result id is invalid")
        })?;
        let first_line = occurrences.first().map(|hit| hit.line);
        let retrieval = build_retrieval(&row, &result_id, first_line);
        let (excerpt, excerpt_complete) = build_excerpt(&row.text, first_range);
        results.push(SessionSearchResult {
            result_id,
            mode: request.mode,
            source_kind: source_kind_from_tag(&row.source_kind),
            source_field: row.source_field.clone(),
            event_id: parse_optional_id(row.event_id, EventId::from_str_canonical)?,
            event_sequence: row.event_sequence.map(|value| value as u64),
            event_kind: row.event_kind.clone(),
            turn_id: parse_optional_id(row.turn_id, TurnId::from_str_canonical)?,
            artifact_id: parse_optional_id(row.artifact_id, ArtifactId::from_str_canonical)?,
            summary_segment_id: parse_optional_id(
                row.summary_segment_id,
                SummarySegmentId::from_str_canonical,
            )?,
            state_id: row.state_id.clone(),
            content_sha256: Sha256Digest::from_hex_str(&row.content_sha256).map_err(|_| {
                ArtifactError::new("HISTORY_EVENT_INTEGRITY", "indexed content hash is invalid")
            })?,
            score,
            occurrences,
            excerpt,
            excerpt_complete,
            retrieval,
        });
    }

    results.sort_by_key(|result| {
        (
            Reverse(result.score.primary_micros),
            Reverse(result.event_sequence.unwrap_or(0)),
            result.result_id.to_string(),
            result.occurrences.first().map(|hit| hit.line).unwrap_or(0),
            result
                .occurrences
                .first()
                .map(|hit| hit.start_column)
                .unwrap_or(0),
        )
    });
    if let Some(cursor) = &cursor {
        results.retain(|result| strictly_after(result, cursor));
    }

    let limit = request.limit.min(PAGE_LIMIT_MAX) as usize;
    let has_more = limit > 0 && results.len() > limit;
    results.truncate(limit);
    let next_cursor = if has_more {
        let last = results
            .last()
            .expect("a full page has a final result")
            .clone();
        let (last_line, last_column) = last
            .occurrences
            .first()
            .map(|hit| (hit.line, hit.start_column))
            .unwrap_or((0, 0));
        Some(encode_cursor(
            &SessionSearchCursorV2 {
                cursor_schema_version: CURSOR_SCHEMA_VERSION,
                session_id,
                projection_through_sequence: snapshot,
                reset_epoch,
                request_sha256,
                last_primary_micros: last.score.primary_micros,
                last_event_sequence: last.event_sequence.unwrap_or(0),
                last_document_id: last.result_id.to_string(),
                last_line,
                last_column,
            },
            hmac_key,
        ))
    } else {
        None
    };

    Ok(SessionSearchPage {
        projection_through_sequence: snapshot,
        results,
        next_cursor,
    })
}

fn is_busy(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == rusqlite::ErrorCode::DatabaseBusy
    )
}

fn query_err(message: &str) -> ArtifactError {
    ArtifactError::new("HISTORY_SEARCH_QUERY", message)
}

fn check_cancel(cancel: &CancellationToken) -> Result<(), ArtifactError> {
    if cancel.is_cancelled() {
        return Err(ArtifactError::new("HISTORY_CANCELLED", "caller cancelled"));
    }
    Ok(())
}

fn validate_request(request: &SessionSearchRequest) -> Result<(), ArtifactError> {
    if request.limit == 0 {
        return Err(query_err("limit must be at least 1"));
    }
    let cursor_len = request.cursor.as_deref().map_or(0, str::len);
    if request.query.len().saturating_add(cursor_len) > CURSOR_TOTAL_MAX_BYTES {
        return Err(query_err("query and cursor exceed 64 KiB"));
    }
    if matches!(request.mode, SessionSearchMode::Fts) && request.case_sensitive {
        return Err(query_err("fts mode requires case-insensitive matching"));
    }
    let filters = &request.filters;
    let vector_lengths = [
        filters.source_kinds.len(),
        filters.event_kinds.len(),
        filters.event_ids.len(),
        filters.turn_ids.len(),
        filters.tool_names.len(),
        filters.artifact_ids.len(),
        filters.summary_segment_ids.len(),
        filters.state_ids.len(),
    ];
    if vector_lengths.iter().any(|len| *len > FILTER_MAX_VALUES) {
        return Err(query_err("a filter holds more than 100 values"));
    }
    if filters.path_globs.len() > PATH_GLOB_MAX_COUNT {
        return Err(query_err("path_globs holds more than 32 patterns"));
    }
    if filters
        .path_globs
        .iter()
        .any(|glob| glob.len() > PATH_GLOB_MAX_BYTES)
    {
        return Err(query_err("a path glob exceeds 4096 bytes"));
    }
    for kind in &filters.event_kinds {
        if !EVENT_KIND_TAGS.contains(&kind.as_str()) {
            return Err(query_err("event_kinds holds an unknown event kind"));
        }
    }
    let has_id_filter = !filters.event_ids.is_empty()
        || !filters.artifact_ids.is_empty()
        || !filters.summary_segment_ids.is_empty()
        || !filters.state_ids.is_empty();
    if request.query.is_empty() {
        if !matches!(request.mode, SessionSearchMode::Exact) || !has_id_filter {
            return Err(query_err(
                "an empty query requires Exact mode and an id filter",
            ));
        }
    } else if request.query.len() > QUERY_MAX_BYTES {
        return Err(query_err("query exceeds 4096 bytes"));
    }
    Ok(())
}

fn load_projection_context(
    conn: &rusqlite::Connection,
) -> Result<(SessionId, u32, u64), ArtifactError> {
    let payload: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM projection_checkpoints WHERE projection_name = ?1",
            [PROJECTION_NAME],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite)?;
    let payload = payload.ok_or_else(|| {
        ArtifactError::new(
            "HISTORY_EVENT_INTEGRITY",
            "projection checkpoint is missing",
        )
    })?;
    let checkpoint: HistoryDerivedCheckpointV1 = serde_json::from_str(&payload).map_err(|_| {
        ArtifactError::new(
            "HISTORY_EVENT_INTEGRITY",
            "projection checkpoint is corrupt",
        )
    })?;
    Ok((
        checkpoint.session_id,
        checkpoint.reset_epoch,
        checkpoint.applied_through_sequence,
    ))
}

fn sorted_dedup(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn source_kind_tag(kind: &SearchSourceKind) -> &'static str {
    match kind {
        SearchSourceKind::Event => "event",
        SearchSourceKind::Artifact => "artifact",
        SearchSourceKind::SummarySegment => "summary_segment",
        SearchSourceKind::State => "state",
    }
}

fn source_kind_from_tag(tag: &str) -> SearchSourceKind {
    match tag {
        "artifact" => SearchSourceKind::Artifact,
        "summary_segment" => SearchSourceKind::SummarySegment,
        "state" => SearchSourceKind::State,
        _ => SearchSourceKind::Event,
    }
}

fn mode_tag(mode: SessionSearchMode) -> &'static str {
    match mode {
        SessionSearchMode::Exact => "exact",
        SessionSearchMode::Regex => "regex",
        SessionSearchMode::Fts => "fts",
    }
}

fn compute_request_sha256(request: &SessionSearchRequest) -> Result<Sha256Digest, ArtifactError> {
    let filters = &request.filters;
    let filters_value = serde_json::json!({
        "artifact_ids": sorted_dedup(filters.artifact_ids.iter().map(ToString::to_string).collect()),
        "event_ids": sorted_dedup(filters.event_ids.iter().map(ToString::to_string).collect()),
        "event_kinds": sorted_dedup(filters.event_kinds.clone()),
        "include_prior_epochs": filters.include_prior_epochs,
        "path_globs": sorted_dedup(filters.path_globs.clone()),
        "sequence_end": filters.sequence_end,
        "sequence_start": filters.sequence_start,
        "source_kinds": sorted_dedup(filters.source_kinds.iter().map(|kind| source_kind_tag(kind).to_owned()).collect()),
        "state_ids": sorted_dedup(filters.state_ids.clone()),
        "summary_segment_ids": sorted_dedup(filters.summary_segment_ids.iter().map(ToString::to_string).collect()),
        "tool_names": sorted_dedup(filters.tool_names.clone()),
        "turn_ids": sorted_dedup(filters.turn_ids.iter().map(ToString::to_string).collect()),
    });
    let request_value = serde_json::json!({
        "case_sensitive": request.case_sensitive,
        "filters": filters_value,
        "mode": mode_tag(request.mode),
        "query": request.query,
        "search_schema_version": SEARCH_SCHEMA_VERSION,
    });
    let canonical = to_canonical_json_bytes(&request_value).map_err(|_| {
        ArtifactError::new("HISTORY_EVENT_INTEGRITY", "request hash input is invalid")
    })?;
    let mut input = Vec::with_capacity(canonical.len() + 25);
    input.extend_from_slice(b"praana-search-request-v1");
    input.push(0);
    input.extend_from_slice(&canonical);
    Ok(Sha256Digest::digest_bytes(&input))
}

fn compile_query_regex(request: &SessionSearchRequest) -> Result<Option<Regex>, ArtifactError> {
    if !matches!(request.mode, SessionSearchMode::Regex) {
        return Ok(None);
    }
    if request.query.len() > QUERY_MAX_BYTES {
        return Err(query_err("regex pattern exceeds 4096 bytes"));
    }
    RegexBuilder::new(&request.query)
        .multi_line(true)
        .dot_matches_new_line(false)
        .case_insensitive(!request.case_sensitive)
        .build()
        .map(Some)
        .map_err(|err| query_err(&format!("regex pattern is invalid: {err}")))
}

fn compile_path_globs(globs: &[String]) -> Result<Option<GlobSet>, ArtifactError> {
    if globs.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for pattern in globs {
        let glob = GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|_| query_err("path glob is invalid"))?;
        builder.add(glob);
    }
    builder
        .build()
        .map(Some)
        .map_err(|_| query_err("path glob set is invalid"))
}

struct CandidateRow {
    document_id: String,
    source_kind: String,
    source_field: String,
    event_id: Option<String>,
    event_sequence: Option<i64>,
    event_kind: Option<String>,
    turn_id: Option<String>,
    artifact_id: Option<String>,
    summary_segment_id: Option<String>,
    state_id: Option<String>,
    normalized_path: Option<String>,
    content_sha256: String,
    text: String,
    total_lines: Option<i64>,
    rowid: i64,
    bm25: Option<f64>,
}

const COLUMN_COUNT: usize = 14;

/// Same tokenizer and prefix indexes as `search_fts` (History §5.2). The copy
/// is content-bearing so `bm25()` statistics cover only the inserted rows.
const SNAPSHOT_FTS_SQL: &str = "\
CREATE VIRTUAL TABLE snapshot_fts USING fts5(\
text, \
tokenize='unicode61 remove_diacritics 2 tokenchars ''_./-''', \
prefix='2 3 4'\
)";

fn apply_snapshot_bm25(
    conn: &rusqlite::Connection,
    query: &str,
    snapshot: u64,
    cancel: &CancellationToken,
    cache: &mut SnapshotBm25Cache,
    candidates: &mut [CandidateRow],
) -> Result<(), ArtifactError> {
    if candidates.is_empty() || fts_index_is_snapshot(conn, snapshot)? {
        return Ok(());
    }
    if !cache.matches(query, snapshot) {
        check_cancel(cancel)?;
        let scores = snapshot_bm25_scores(conn, query, snapshot, cancel)?;
        cache.store(query, snapshot, scores);
    }
    for candidate in candidates.iter_mut() {
        let score = cache.scores.get(&candidate.rowid).copied().ok_or_else(|| {
            ArtifactError::new(
                "HISTORY_EVENT_INTEGRITY",
                "snapshot ranking missed an indexed row",
            )
        })?;
        candidate.bm25 = Some(score);
    }
    Ok(())
}

fn fts_index_is_snapshot(
    conn: &rusqlite::Connection,
    snapshot: u64,
) -> Result<bool, ArtifactError> {
    // search_documents_event_idx covers this probe. A row past P means live
    // bm25() statistics include documents the snapshot did not. COUNT(*) on
    // external-content search_fts reads search_documents, not the FTS index,
    // so it cannot tell a missing index row from a content row.
    let ahead: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM search_documents WHERE event_sequence > ?1 LIMIT 1",
            [snapshot as i64],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite)?;
    Ok(ahead.is_none())
}

fn snapshot_bm25_scores(
    conn: &rusqlite::Connection,
    query: &str,
    snapshot: u64,
    cancel: &CancellationToken,
) -> Result<HashMap<i64, f64>, ArtifactError> {
    let mut statement = conn
        .prepare("SELECT rowid, text FROM search_documents WHERE event_sequence <= ?1")
        .map_err(map_sqlite)?;
    let mut rows = statement.query([snapshot as i64]).map_err(map_sqlite)?;
    let mut docs = Vec::new();
    let mut index = 0usize;
    while let Some(row) = rows.next().map_err(map_sqlite)? {
        if index.is_multiple_of(CANCEL_CHECK_INTERVAL) {
            check_cancel(cancel)?;
        }
        index += 1;
        docs.push((
            row.get::<_, i64>(0).map_err(map_sqlite)?,
            row.get::<_, String>(1).map_err(map_sqlite)?,
        ));
    }
    drop(rows);
    drop(statement);
    if docs.is_empty() {
        return Ok(HashMap::new());
    }

    let mem = rusqlite::Connection::open_in_memory().map_err(map_sqlite)?;
    mem.execute_batch(SNAPSHOT_FTS_SQL).map_err(map_sqlite)?;
    {
        let mut insert = mem
            .prepare("INSERT INTO snapshot_fts(rowid, text) VALUES(?1, ?2)")
            .map_err(map_sqlite)?;
        for (offset, (rowid, text)) in docs.iter().enumerate() {
            if offset.is_multiple_of(CANCEL_CHECK_INTERVAL) {
                check_cancel(cancel)?;
            }
            insert
                .execute(rusqlite::params![rowid, text])
                .map_err(map_sqlite)?;
        }
    }
    let mut scores = HashMap::with_capacity(docs.len());
    let mut matched = mem
        .prepare(
            "SELECT rowid, bm25(snapshot_fts, 1.0) FROM snapshot_fts WHERE snapshot_fts MATCH ?1",
        )
        .map_err(|err| query_err(&format!("fts query is invalid: {err}")))?;
    let mut rows = matched
        .query([query])
        .map_err(|err| query_err(&format!("fts query is invalid: {err}")))?;
    while let Some(row) = rows.next().map_err(map_sqlite)? {
        scores.insert(
            row.get::<_, i64>(0).map_err(map_sqlite)?,
            row.get::<_, f64>(1).map_err(map_sqlite)?,
        );
    }
    Ok(scores)
}

fn fetch_candidates(
    conn: &rusqlite::Connection,
    request: &SessionSearchRequest,
    reset_epoch: u32,
    snapshot_sequence: u64,
    globs: &Option<GlobSet>,
    cancel: &CancellationToken,
) -> Result<Vec<CandidateRow>, ArtifactError> {
    let filters = &request.filters;
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();

    if !filters.include_prior_epochs {
        conditions.push("d.reset_epoch = ?".to_owned());
        params.push(SqlValue::Integer(reset_epoch as i64));
    }
    conditions.push("d.event_sequence <= ?".to_owned());
    params.push(SqlValue::Integer(snapshot_sequence as i64));
    let push_in = |column: &str,
                   values: &[String],
                   conditions: &mut Vec<String>,
                   params: &mut Vec<SqlValue>| {
        if !values.is_empty() {
            conditions.push(format!(
                "{column} IN ({})",
                vec!["?"; values.len()].join(", ")
            ));
            params.extend(values.iter().cloned().map(SqlValue::Text));
        }
    };
    if !filters.source_kinds.is_empty() {
        let tags: Vec<String> = filters
            .source_kinds
            .iter()
            .map(|kind| source_kind_tag(kind).to_owned())
            .collect();
        push_in("d.source_kind", &tags, &mut conditions, &mut params);
    }
    push_in(
        "d.event_kind",
        &filters.event_kinds,
        &mut conditions,
        &mut params,
    );
    let event_ids: Vec<String> = filters.event_ids.iter().map(ToString::to_string).collect();
    push_in("d.event_id", &event_ids, &mut conditions, &mut params);
    let turn_ids: Vec<String> = filters.turn_ids.iter().map(ToString::to_string).collect();
    push_in("d.turn_id", &turn_ids, &mut conditions, &mut params);
    push_in(
        "d.tool_name",
        &filters.tool_names,
        &mut conditions,
        &mut params,
    );
    let artifact_ids: Vec<String> = filters
        .artifact_ids
        .iter()
        .map(ToString::to_string)
        .collect();
    push_in("d.artifact_id", &artifact_ids, &mut conditions, &mut params);
    let segment_ids: Vec<String> = filters
        .summary_segment_ids
        .iter()
        .map(ToString::to_string)
        .collect();
    push_in(
        "d.summary_segment_id",
        &segment_ids,
        &mut conditions,
        &mut params,
    );
    push_in(
        "d.state_id",
        &filters.state_ids,
        &mut conditions,
        &mut params,
    );
    if let Some(start) = filters.sequence_start {
        conditions.push("d.event_sequence >= ?".to_owned());
        params.push(SqlValue::Integer(start as i64));
    }
    if let Some(end) = filters.sequence_end {
        conditions.push("d.event_sequence <= ?".to_owned());
        params.push(SqlValue::Integer(end as i64));
    }
    if !filters.path_globs.is_empty() {
        conditions.push("d.normalized_path IS NOT NULL".to_owned());
    }

    let fts = matches!(request.mode, SessionSearchMode::Fts);
    if fts {
        conditions.insert(0, "search_fts MATCH ?".to_owned());
        params.insert(0, SqlValue::Text(request.query.clone()));
    }

    let mut sql = if fts {
        "SELECT d.document_id, d.source_kind, d.source_field, d.event_id, \
                    d.event_sequence, d.event_kind, d.turn_id, d.artifact_id, \
                    d.summary_segment_id, d.state_id, d.normalized_path, \
                    d.content_sha256, d.text, a.result_line_count, d.rowid, \
                    bm25(search_fts, 1.0) \
             FROM search_fts \
             JOIN search_documents d ON d.rowid = search_fts.rowid \
             LEFT JOIN artifacts a ON a.artifact_id = d.artifact_id"
            .to_owned()
    } else {
        "SELECT d.document_id, d.source_kind, d.source_field, d.event_id, \
                    d.event_sequence, d.event_kind, d.turn_id, d.artifact_id, \
                    d.summary_segment_id, d.state_id, d.normalized_path, \
                    d.content_sha256, d.text, a.result_line_count, d.rowid \
             FROM search_documents d \
             LEFT JOIN artifacts a ON a.artifact_id = d.artifact_id"
            .to_owned()
    };
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }

    // History §12/§13: a busy timeout is `HISTORY_SQLITE_BUSY` on every path;
    // only a non-busy FTS failure is a query error.
    let map_read = |err: rusqlite::Error| {
        if is_busy(&err) {
            map_sqlite(err)
        } else if fts {
            query_err(&format!("fts query is invalid: {err}"))
        } else {
            map_sqlite(err)
        }
    };
    let mut statement = conn.prepare(&sql).map_err(map_read)?;
    let mut rows = statement
        .query(rusqlite::params_from_iter(params.iter()))
        .map_err(map_read)?;

    let mut candidates = Vec::new();
    let mut index = 0usize;
    while let Some(row) = rows.next().map_err(map_read)? {
        if index.is_multiple_of(CANCEL_CHECK_INTERVAL) {
            check_cancel(cancel)?;
        }
        index += 1;
        let candidate = CandidateRow {
            document_id: row.get(0).map_err(map_sqlite)?,
            source_kind: row.get(1).map_err(map_sqlite)?,
            source_field: row.get(2).map_err(map_sqlite)?,
            event_id: row.get(3).map_err(map_sqlite)?,
            event_sequence: row.get(4).map_err(map_sqlite)?,
            event_kind: row.get(5).map_err(map_sqlite)?,
            turn_id: row.get(6).map_err(map_sqlite)?,
            artifact_id: row.get(7).map_err(map_sqlite)?,
            summary_segment_id: row.get(8).map_err(map_sqlite)?,
            state_id: row.get(9).map_err(map_sqlite)?,
            normalized_path: row.get(10).map_err(map_sqlite)?,
            content_sha256: row.get(11).map_err(map_sqlite)?,
            text: row.get(12).map_err(map_sqlite)?,
            total_lines: row.get(13).map_err(map_sqlite)?,
            rowid: row.get(COLUMN_COUNT).map_err(map_sqlite)?,
            bm25: if fts {
                Some(row.get::<_, f64>(COLUMN_COUNT + 1).map_err(map_sqlite)?)
            } else {
                None
            },
        };
        if let Some(globs) = globs {
            match &candidate.normalized_path {
                Some(path) if globs.is_match(path) => {}
                _ => continue,
            }
        }
        candidates.push(candidate);
    }
    Ok(candidates)
}

enum MatchPlan<'a> {
    IdsOnly,
    Literal {
        needle: String,
        case_sensitive: bool,
    },
    Pattern(&'a Regex),
    Fts(Vec<String>),
}

fn match_ranges(text: &str, plan: &MatchPlan) -> Option<Vec<(usize, usize)>> {
    match plan {
        MatchPlan::IdsOnly => Some(Vec::new()),
        MatchPlan::Literal {
            needle,
            case_sensitive: true,
        } => {
            let ranges: Vec<(usize, usize)> = text
                .match_indices(needle)
                .map(|(start, _)| (start, start + needle.len()))
                .collect();
            (!ranges.is_empty()).then_some(ranges)
        }
        MatchPlan::Literal { needle, .. } => {
            let ranges = find_casefold_ranges(text, needle);
            (!ranges.is_empty()).then_some(ranges)
        }
        MatchPlan::Pattern(regex) => {
            let ranges: Vec<(usize, usize)> = regex
                .find_iter(text)
                .filter(|found| found.start() < found.end())
                .map(|found| (found.start(), found.end()))
                .collect();
            if ranges.is_empty() {
                None
            } else {
                Some(ranges)
            }
        }
        MatchPlan::Fts(positives) => {
            let mut ranges = Vec::new();
            for atom in positives {
                ranges.extend(find_casefold_ranges(text, atom));
            }
            Some(ranges)
        }
    }
}

/// Case-insensitive literal ranges over the original bytes, projected through
/// `default_casefold_v1` offset mapping (History §11.2).
fn find_casefold_ranges(text: &str, needle: &str) -> Vec<(usize, usize)> {
    let folded_needle = crate::unicode::default_casefold_v1(needle);
    if folded_needle.is_empty() {
        return Vec::new();
    }
    let (folded, offsets) = default_casefold_v1_with_offsets(text);
    let mut ranges = Vec::new();
    let mut from = 0usize;
    while from < folded.len() {
        match folded[from..].find(&folded_needle) {
            Some(relative) => {
                let start = from + relative;
                let end = start + folded_needle.len();
                ranges.push((offsets[start].0, offsets[end - 1].1));
                from = end;
            }
            None => break,
        }
    }
    ranges
}

/// Line content spans split at LF (LF excluded), matching section 6.2: a
/// trailing LF does not start a new line.
fn index_lines(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0usize;
    for (index, &byte) in bytes.iter().enumerate() {
        if byte == b'\n' {
            spans.push((start, index));
            start = index + 1;
        }
    }
    if start < bytes.len() {
        spans.push((start, bytes.len()));
    }
    spans
}

fn to_occurrences(text: &str, ranges: &[(usize, usize)]) -> Vec<SearchOccurrence> {
    if ranges.is_empty() {
        return Vec::new();
    }
    let lines = index_lines(text);
    if lines.is_empty() {
        return Vec::new();
    }
    let mut unique = std::collections::BTreeSet::new();
    for &(start, end) in ranges {
        let index = lines.partition_point(|&(line_start, _)| line_start <= start) - 1;
        let (line_start, content_end) = lines[index];
        let line_number = index as u64 + 1;
        let start_column = text[line_start..start.min(content_end)].chars().count() as u64 + 1;
        let end_column = if end > content_end {
            text[line_start..content_end].chars().count() as u64 + 1
        } else {
            text[line_start..end].chars().count() as u64 + 1
        };
        unique.insert((line_number, start_column, end_column));
    }
    unique
        .into_iter()
        .take(OCCURRENCE_CAP)
        .map(|(line, start_column, end_column)| SearchOccurrence {
            line,
            start_column,
            end_column,
        })
        .collect()
}

fn build_excerpt(text: &str, first_range: Option<(usize, usize)>) -> (String, bool) {
    let bytes = text.as_bytes();
    if bytes.len() <= EXCERPT_MAX_BYTES {
        return (text.to_owned(), true);
    }
    let (start_match, end_match) = first_range.unwrap_or((0, 0));
    let line_start = bytes[..start_match]
        .iter()
        .rposition(|&byte| byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let start = if end_match - line_start <= EXCERPT_MAX_BYTES {
        line_start
    } else {
        let lower = end_match.saturating_sub(EXCERPT_MAX_BYTES);
        let mut candidate = lower;
        while candidate < bytes.len() && !text.is_char_boundary(candidate) {
            candidate += 1;
        }
        if candidate <= start_match {
            candidate
        } else {
            start_match
        }
    };
    let mut end = (start + EXCERPT_MAX_BYTES).min(bytes.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    if end_match < end {
        if let Some(relative) = bytes[end_match..end]
            .iter()
            .rposition(|&byte| byte == b'\n')
        {
            end = end_match + relative + 1;
        }
    }
    (
        text[start..end].to_owned(),
        start == 0 && end == bytes.len(),
    )
}

fn line_byte_offset(text: &str, line: u64) -> usize {
    index_lines(text)
        .get(line.saturating_sub(1) as usize)
        .map(|(start, _)| *start)
        .unwrap_or(0)
}

fn build_retrieval(
    row: &CandidateRow,
    result_id: &SearchResultId,
    first_line: Option<u64>,
) -> SearchRetrieval {
    let line = first_line.unwrap_or(1);
    let start = line.saturating_sub(20).max(1);
    match row.source_kind.as_str() {
        "artifact" => {
            let total = row.total_lines.unwrap_or(1).max(1) as u64;
            let end = (line + 20).min(total);
            SearchRetrieval {
                tool: "retrieve_artifact".to_owned(),
                arguments: serde_json::json!({
                    "artifact_id": row.artifact_id.clone().unwrap_or_default(),
                    "line_range": { "start": start, "end": end },
                }),
            }
        }
        "event" | "state" => SearchRetrieval {
            tool: "read_session_source".to_owned(),
            arguments: serde_json::json!({
                "result_id": result_id.to_string(),
                "byte_offset": line_byte_offset(&row.text, start),
            }),
        },
        // summary_segment retrieval is owned by P5 (History §11.3).
        _ => SearchRetrieval {
            tool: String::new(),
            arguments: serde_json::Value::Null,
        },
    }
}

fn strictly_after(result: &SessionSearchResult, cursor: &SessionSearchCursorV2) -> bool {
    if result.score.primary_micros != cursor.last_primary_micros {
        return result.score.primary_micros < cursor.last_primary_micros;
    }
    let sequence = result.event_sequence.unwrap_or(0);
    if sequence != cursor.last_event_sequence {
        return sequence < cursor.last_event_sequence;
    }
    match result.result_id.to_string().cmp(&cursor.last_document_id) {
        std::cmp::Ordering::Greater => return true,
        std::cmp::Ordering::Less => return false,
        std::cmp::Ordering::Equal => {}
    }
    let (line, column) = result
        .occurrences
        .first()
        .map(|hit| (hit.line, hit.start_column))
        .unwrap_or((0, 0));
    (line, column) > (cursor.last_line, cursor.last_column)
}

fn parse_optional_id<T>(
    raw: Option<String>,
    parse: fn(&str) -> Result<T, HistoryError>,
) -> Result<Option<T>, ArtifactError> {
    raw.map(|value| {
        parse(&value).map_err(|_| {
            ArtifactError::new("HISTORY_EVENT_INTEGRITY", "indexed identifier is invalid")
        })
    })
    .transpose()
}

#[derive(Debug, Clone)]
enum FtsNode {
    Atom { text: String },
    Not(Box<FtsNode>),
    And(Vec<FtsNode>),
    Or(Vec<FtsNode>),
}

#[derive(Debug, Clone)]
enum FtsToken {
    Term(String),
    Phrase(String),
    LeftParen,
    RightParen,
    And,
    Or,
    Not,
}

fn tokenize_fts(query: &str) -> Result<Vec<FtsToken>, ArtifactError> {
    let mut tokens = Vec::new();
    let mut rest = query;
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        let first = rest.chars().next().expect("trimmed query is non-empty");
        match first {
            '(' => {
                tokens.push(FtsToken::LeftParen);
                rest = &rest[1..];
            }
            ')' => {
                tokens.push(FtsToken::RightParen);
                rest = &rest[1..];
            }
            '"' => {
                let body = &rest[1..];
                let bytes = body.as_bytes();
                let mut out = String::new();
                let mut cursor = 0usize;
                let mut closed = false;
                while cursor < bytes.len() {
                    if bytes[cursor] == b'"' {
                        if cursor + 1 < bytes.len() && bytes[cursor + 1] == b'"' {
                            out.push('"');
                            cursor += 2;
                            continue;
                        }
                        cursor += 1;
                        closed = true;
                        break;
                    }
                    let width = match bytes[cursor] {
                        0x00..=0x7f => 1,
                        0xc0..=0xdf => 2,
                        0xe0..=0xef => 3,
                        _ => 4,
                    };
                    out.push_str(&body[cursor..cursor + width]);
                    cursor += width;
                }
                if !closed {
                    return Err(query_err("fts query has an unterminated phrase"));
                }
                tokens.push(FtsToken::Phrase(out));
                rest = &body[cursor..];
            }
            _ => {
                let end = rest
                    .find(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == '"')
                    .unwrap_or(rest.len());
                let word = &rest[..end];
                rest = &rest[end..];
                if word.contains(':')
                    || word.contains('^')
                    || word.contains('{')
                    || word.contains('}')
                {
                    return Err(query_err("fts query contains unsupported syntax"));
                }
                let lower = word.to_ascii_lowercase();
                match lower.as_str() {
                    "and" => {
                        tokens.push(FtsToken::And);
                        continue;
                    }
                    "or" => {
                        tokens.push(FtsToken::Or);
                        continue;
                    }
                    "not" => {
                        tokens.push(FtsToken::Not);
                        continue;
                    }
                    "near" => return Err(query_err("NEAR is not supported")),
                    _ => {}
                }
                let text = if let Some(stripped) = word.strip_suffix('*') {
                    if stripped.contains('*') || stripped.is_empty() {
                        return Err(query_err("fts prefix term is invalid"));
                    }
                    stripped
                } else {
                    if word.contains('*') {
                        return Err(query_err("'*' is only allowed at the end of an fts term"));
                    }
                    word
                };
                tokens.push(FtsToken::Term(text.to_owned()));
            }
        }
    }
    Ok(tokens)
}

fn parse_fts_primary(tokens: &[FtsToken], position: &mut usize) -> Result<FtsNode, ArtifactError> {
    match tokens.get(*position) {
        Some(FtsToken::Term(text)) => {
            *position += 1;
            Ok(FtsNode::Atom { text: text.clone() })
        }
        Some(FtsToken::Phrase(text)) => {
            *position += 1;
            Ok(FtsNode::Atom { text: text.clone() })
        }
        Some(FtsToken::LeftParen) => {
            *position += 1;
            let inner = parse_fts_or(tokens, position)?;
            match tokens.get(*position) {
                Some(FtsToken::RightParen) => *position += 1,
                _ => return Err(query_err("fts query has unbalanced parentheses")),
            }
            Ok(inner)
        }
        Some(FtsToken::RightParen) => Err(query_err("fts query has an unexpected ')'")),
        Some(FtsToken::And) | Some(FtsToken::Or) | Some(FtsToken::Not) => {
            Err(query_err("fts query has a misplaced operator"))
        }
        None => Err(query_err("fts query ends with an operator")),
    }
}

fn parse_fts_unary(tokens: &[FtsToken], position: &mut usize) -> Result<FtsNode, ArtifactError> {
    if matches!(tokens.get(*position), Some(FtsToken::Not)) {
        *position += 1;
        let inner = parse_fts_unary(tokens, position)?;
        return Ok(FtsNode::Not(Box::new(inner)));
    }
    parse_fts_primary(tokens, position)
}

fn parse_fts_and(tokens: &[FtsToken], position: &mut usize) -> Result<FtsNode, ArtifactError> {
    let mut items = vec![parse_fts_unary(tokens, position)?];
    loop {
        match tokens.get(*position) {
            Some(FtsToken::And) => {
                *position += 1;
                items.push(parse_fts_unary(tokens, position)?);
            }
            Some(FtsToken::Term(_)) | Some(FtsToken::Phrase(_)) | Some(FtsToken::LeftParen) => {
                items.push(parse_fts_unary(tokens, position)?);
            }
            _ => break,
        }
    }
    if items.len() == 1 {
        Ok(items.pop().expect("one item"))
    } else {
        Ok(FtsNode::And(items))
    }
}

fn parse_fts_or(tokens: &[FtsToken], position: &mut usize) -> Result<FtsNode, ArtifactError> {
    let mut items = vec![parse_fts_and(tokens, position)?];
    while matches!(tokens.get(*position), Some(FtsToken::Or)) {
        *position += 1;
        items.push(parse_fts_and(tokens, position)?);
    }
    if items.len() == 1 {
        Ok(items.pop().expect("one item"))
    } else {
        Ok(FtsNode::Or(items))
    }
}

fn parse_fts_query(query: &str) -> Result<FtsNode, ArtifactError> {
    let tokens = tokenize_fts(query)?;
    if tokens.is_empty() {
        return Err(query_err("fts query is empty"));
    }
    let mut position = 0usize;
    let node = parse_fts_or(&tokens, &mut position)?;
    if position != tokens.len() {
        return Err(query_err("fts query has trailing syntax"));
    }
    Ok(node)
}

fn collect_positive_atoms(node: &FtsNode, negated: bool, out: &mut Vec<String>) {
    match node {
        FtsNode::Atom { text } => {
            if !negated {
                out.push(text.clone());
            }
        }
        FtsNode::Not(inner) => collect_positive_atoms(inner, !negated, out),
        FtsNode::And(items) | FtsNode::Or(items) => {
            for item in items {
                collect_positive_atoms(item, negated, out);
            }
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionSearchRequest {
    pub query: String,
    pub mode: SessionSearchMode,
    pub case_sensitive: bool,
    pub filters: SessionSearchFilters,
    pub limit: u32,
    pub cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionSearchMode {
    Exact,
    Regex,
    Fts,
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchSourceKind {
    Event,
    Artifact,
    SummarySegment,
    State,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionSearchFilters {
    pub source_kinds: Vec<SearchSourceKind>,
    pub event_kinds: Vec<String>,
    pub event_ids: Vec<crate::protocol::id::EventId>,
    pub turn_ids: Vec<crate::protocol::id::TurnId>,
    pub sequence_start: Option<u64>,
    pub sequence_end: Option<u64>,
    pub tool_names: Vec<String>,
    pub path_globs: Vec<String>,
    pub artifact_ids: Vec<crate::protocol::id::ArtifactId>,
    pub summary_segment_ids: Vec<crate::protocol::id::SummarySegmentId>,
    pub state_ids: Vec<String>,
    pub include_prior_epochs: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionSearchPage {
    pub projection_through_sequence: u64,
    pub results: Vec<SessionSearchResult>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionSearchResult {
    pub result_id: crate::protocol::id::SearchResultId,
    pub mode: SessionSearchMode,
    pub source_kind: SearchSourceKind,
    pub source_field: String,
    pub event_id: Option<crate::protocol::id::EventId>,
    pub event_sequence: Option<u64>,
    pub event_kind: Option<String>,
    pub turn_id: Option<crate::protocol::id::TurnId>,
    pub artifact_id: Option<crate::protocol::id::ArtifactId>,
    pub summary_segment_id: Option<crate::protocol::id::SummarySegmentId>,
    pub state_id: Option<String>,
    pub content_sha256: Sha256Digest,
    pub score: SearchScore,
    pub occurrences: Vec<SearchOccurrence>,
    pub excerpt: String,
    pub excerpt_complete: bool,
    pub retrieval: SearchRetrieval,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchScore {
    pub primary_micros: i64,
    pub raw_bm25_micros: Option<i64>,
    pub rank_reason: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchOccurrence {
    pub line: u64,
    pub start_column: u64,
    pub end_column: u64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SearchRetrieval {
    pub tool: String,
    pub arguments: serde_json::Value,
}
