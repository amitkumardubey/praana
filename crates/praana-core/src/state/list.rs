//! `list_state` selection, summaries, and cursors (StateGraph §11.2).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::canonical_json::to_canonical_json_bytes;
use crate::history::cursor::{base64url_decode, base64url_no_pad, constant_time_eq, hmac_sha256};
use crate::protocol::id::{SessionId, Sha256Digest, StateId};
use crate::protocol::state_graph::*;

use super::StateServiceError;

pub const LIST_RESULT_MAX_BYTES: usize = 65_536;
const EXCERPT_SCALARS: usize = 160;

#[derive(
    Clone, Copy, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(rename_all = "snake_case")]
pub enum StateStatusFilter {
    Todo,
    InProgress,
    Blocked,
    Done,
    Cancelled,
    Active,
    Superseded,
    Satisfied,
    Waived,
    Open,
    Resolved,
    Ignored,
}

impl StateStatusFilter {
    fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::InProgress => "in_progress",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
            Self::Active => "active",
            Self::Superseded => "superseded",
            Self::Satisfied => "satisfied",
            Self::Waived => "waived",
            Self::Open => "open",
            Self::Resolved => "resolved",
            Self::Ignored => "ignored",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateListCursorV1 {
    pub cursor_schema_version: u32,
    pub session_id: SessionId,
    pub view_sha256: Sha256Digest,
    pub request_sha256: Sha256Digest,
    pub next_offset: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateListItemDto {
    pub id: StateId,
    pub kind: StateKind,
    pub tier: StateTier,
    pub lifecycle: ObjectLifecycle,
    pub status: Option<String>,
    pub focused: bool,
    pub revision: u64,
    pub updated_sequence: u64,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StateListToolOutput {
    pub projection_sequence: u64,
    pub items: Vec<StateListItemDto>,
    pub next_cursor: Option<String>,
}

pub struct ListQuery {
    pub kinds: Vec<StateKind>,
    pub tiers: Vec<StateTier>,
    pub statuses: Vec<StateStatusFilter>,
    pub include_retracted: bool,
    pub limit: i64,
    pub cursor: Option<String>,
}

pub fn list_page(
    graph: &StateGraphV1,
    query: &ListQuery,
    session_id: &SessionId,
    hmac_key: &[u8; 32],
) -> Result<StateListToolOutput, StateServiceError> {
    if query.limit < 1 || query.limit > 200 {
        return Err(StateServiceError::new(
            "STATE_FIELD_LIMIT",
            "state field limit",
        ));
    }
    let view = view_sha256(graph)?;
    let request = request_sha256(query)?;
    let selected = select(graph, query);
    let start = match &query.cursor {
        None => 0usize,
        Some(cursor) => {
            decode_cursor(cursor, hmac_key, session_id, &view, &request)?.next_offset as usize
        }
    };
    if start > selected.len() {
        return Err(stale());
    }
    let mut count = 0usize;
    let room = (selected.len() - start).min(query.limit as usize);
    while count < room {
        let candidate = page_output(
            graph,
            &selected,
            start,
            count + 1,
            session_id,
            &view,
            &request,
            hmac_key,
        )?;
        let bytes = to_canonical_json_bytes(&candidate).map_err(|_| stale())?;
        if bytes.len() > LIST_RESULT_MAX_BYTES {
            break;
        }
        count += 1;
    }
    if count == 0 && room > 0 {
        return Err(StateServiceError::new(
            "STATE_FIELD_LIMIT",
            "state field limit",
        ));
    }
    page_output(
        graph, &selected, start, count, session_id, &view, &request, hmac_key,
    )
}

#[allow(clippy::too_many_arguments)]
fn page_output(
    graph: &StateGraphV1,
    selected: &[StateId],
    start: usize,
    count: usize,
    session_id: &SessionId,
    view: &Sha256Digest,
    request: &Sha256Digest,
    hmac_key: &[u8; 32],
) -> Result<StateListToolOutput, StateServiceError> {
    let end = start + count;
    let next_cursor = if end < selected.len() {
        Some(encode_cursor(
            &StateListCursorV1 {
                cursor_schema_version: 1,
                session_id: *session_id,
                view_sha256: view.clone(),
                request_sha256: request.clone(),
                next_offset: end as u32,
            },
            hmac_key,
        )?)
    } else {
        None
    };
    let items = selected[start..end]
        .iter()
        .map(|id| item(graph, *id))
        .collect();
    Ok(StateListToolOutput {
        projection_sequence: graph.applied_through_sequence,
        items,
        next_cursor,
    })
}

fn select(graph: &StateGraphV1, query: &ListQuery) -> Vec<StateId> {
    let tiers = resolved_tiers(&query.tiers);
    let mut objects: Vec<&StateObjectV1> = graph
        .objects
        .iter()
        .filter(|object| {
            (query.kinds.is_empty() || query.kinds.contains(&value_kind(&object.value)))
                && tiers.contains(&object.tier)
                && status_matches(&object.value, &query.statuses)
                && (object.lifecycle == ObjectLifecycle::Current
                    || (query.include_retracted && object.lifecycle == ObjectLifecycle::Retracted))
        })
        .collect();
    let focus = graph.focus.as_ref().map(|focus| focus.state_id);
    objects.sort_by_key(|object| {
        (
            u8::from(focus != Some(object.state_id)),
            u8::from(object.lifecycle == ObjectLifecycle::Retracted),
            kind_rank(value_kind(&object.value)),
            status_rank(&object.value),
            std::cmp::Reverse(object.updated_sequence),
            object.state_id,
        )
    });
    objects.into_iter().map(|object| object.state_id).collect()
}

fn item(graph: &StateGraphV1, id: StateId) -> StateListItemDto {
    let object = graph
        .objects
        .iter()
        .find(|object| object.state_id == id)
        .expect("selected id");
    let status = status_string(&object.value);
    let summary = if object.tier == StateTier::Hard {
        None
    } else {
        Some(summary_text(object))
    };
    StateListItemDto {
        id,
        kind: value_kind(&object.value),
        tier: object.tier.clone(),
        lifecycle: object.lifecycle.clone(),
        status,
        focused: graph
            .focus
            .as_ref()
            .is_some_and(|focus| focus.state_id == id),
        revision: object.revision,
        updated_sequence: object.updated_sequence,
        summary,
    }
}

fn summary_text(object: &StateObjectV1) -> String {
    match &object.value {
        StateValueV1::Task(value) => {
            format!("{}: {}", status_name_task(&value.status), value.title)
        }
        StateValueV1::Decision(value) => {
            format!("{}: {}", decision_tag(&value.status), value.summary)
        }
        StateValueV1::Constraint(value) => format!(
            "{}/{}: {}",
            strength_name(&value.strength),
            constraint_name(&value.status),
            excerpt(&value.text)
        ),
        StateValueV1::Note(value) => excerpt(&value.text),
        StateValueV1::Error(value) => format!(
            "{}/{}: {}",
            severity_name(&value.severity),
            error_name(&value.status),
            excerpt(&value.message)
        ),
    }
}

fn excerpt(text: &str) -> String {
    let mut chars = text.chars();
    let mut out = String::new();
    for _ in 0..EXCERPT_SCALARS {
        match chars.next() {
            Some(ch) => out.push(ch),
            None => return text.to_owned(),
        }
    }
    if chars.next().is_some() {
        out.push_str("...");
    }
    out
}

fn status_matches(value: &StateValueV1, statuses: &[StateStatusFilter]) -> bool {
    if statuses.is_empty() {
        return true;
    }
    let Some(status) = status_string(value) else {
        return false;
    };
    statuses.iter().any(|filter| filter.as_str() == status)
}

fn status_string(value: &StateValueV1) -> Option<String> {
    Some(match value {
        StateValueV1::Task(value) => status_name_task(&value.status).to_owned(),
        StateValueV1::Decision(value) => decision_tag(&value.status).to_owned(),
        StateValueV1::Constraint(value) => constraint_name(&value.status).to_owned(),
        StateValueV1::Note(_) => return None,
        StateValueV1::Error(value) => error_name(&value.status).to_owned(),
    })
}

fn resolved_tiers(tiers: &[StateTier]) -> Vec<StateTier> {
    if tiers.is_empty() {
        vec![StateTier::Active, StateTier::Soft]
    } else {
        let mut out = tiers.to_vec();
        out.sort_by_key(|tier| tier_name(tier).to_owned());
        out.dedup();
        out
    }
}

fn request_sha256(query: &ListQuery) -> Result<Sha256Digest, StateServiceError> {
    #[derive(Serialize)]
    struct Request<'a> {
        include_retracted: bool,
        kinds: Vec<&'a str>,
        statuses: Vec<&'a str>,
        tiers: Vec<&'a str>,
    }
    let mut kinds: Vec<&str> = query.kinds.iter().map(kind_name).collect();
    kinds.sort_unstable();
    kinds.dedup();
    let mut statuses: Vec<&str> = query
        .statuses
        .iter()
        .copied()
        .map(StateStatusFilter::as_str)
        .collect();
    statuses.sort_unstable();
    statuses.dedup();
    let tiers = resolved_tiers(&query.tiers);
    let tier_names: Vec<&str> = tiers.iter().map(tier_name).collect();
    let bytes = to_canonical_json_bytes(&Request {
        include_retracted: query.include_retracted,
        kinds,
        statuses,
        tiers: tier_names,
    })
    .map_err(|_| stale())?;
    Ok(prefixed_sha(b"praana-state-list-request-v1", &bytes))
}

fn view_sha256(graph: &StateGraphV1) -> Result<Sha256Digest, StateServiceError> {
    #[derive(Serialize)]
    struct View<'a> {
        focus: &'a Option<FocusV1>,
        objects: &'a [StateObjectV1],
        reset_epoch: u32,
    }
    let bytes = to_canonical_json_bytes(&View {
        focus: &graph.focus,
        objects: &graph.objects,
        reset_epoch: graph.reset_epoch,
    })
    .map_err(|_| stale())?;
    Ok(prefixed_sha(b"praana-state-list-view-v1", &bytes))
}

fn encode_cursor(
    cursor: &StateListCursorV1,
    hmac_key: &[u8; 32],
) -> Result<String, StateServiceError> {
    let bytes = to_canonical_json_bytes(cursor).map_err(|_| stale())?;
    let mut message = b"praana-state-list-cursor-v1\0".to_vec();
    message.extend_from_slice(&bytes);
    let tag = hmac_sha256(hmac_key, &message);
    Ok(format!(
        "{}.{}",
        base64url_no_pad(&bytes),
        base64url_no_pad(&tag)
    ))
}

fn decode_cursor(
    encoded: &str,
    hmac_key: &[u8; 32],
    session_id: &SessionId,
    view: &Sha256Digest,
    request: &Sha256Digest,
) -> Result<StateListCursorV1, StateServiceError> {
    let Some((body, tag)) = encoded.split_once('.') else {
        return Err(stale());
    };
    let Some(body) = base64url_decode(body) else {
        return Err(stale());
    };
    let Some(tag) = base64url_decode(tag) else {
        return Err(stale());
    };
    let mut message = b"praana-state-list-cursor-v1\0".to_vec();
    message.extend_from_slice(&body);
    let expected = hmac_sha256(hmac_key, &message);
    if !constant_time_eq(&tag, &expected) {
        return Err(stale());
    }
    let cursor: StateListCursorV1 = serde_json::from_slice(&body).map_err(|_| stale())?;
    if cursor.cursor_schema_version != 1
        || cursor.session_id != *session_id
        || cursor.view_sha256 != *view
        || cursor.request_sha256 != *request
    {
        return Err(stale());
    }
    Ok(cursor)
}

fn prefixed_sha(prefix: &[u8], body: &[u8]) -> Sha256Digest {
    let mut input = Vec::with_capacity(prefix.len() + 1 + body.len());
    input.extend_from_slice(prefix);
    input.push(0);
    input.extend_from_slice(body);
    Sha256Digest::digest_bytes(&input)
}

fn stale() -> StateServiceError {
    StateServiceError::new("STATE_CURSOR_STALE", "state cursor is stale")
}

fn value_kind(value: &StateValueV1) -> StateKind {
    match value {
        StateValueV1::Task(_) => StateKind::Task,
        StateValueV1::Decision(_) => StateKind::Decision,
        StateValueV1::Constraint(_) => StateKind::Constraint,
        StateValueV1::Note(_) => StateKind::Note,
        StateValueV1::Error(_) => StateKind::Error,
    }
}

fn kind_rank(kind: StateKind) -> u8 {
    match kind {
        StateKind::Constraint => 0,
        StateKind::Error => 1,
        StateKind::Task => 2,
        StateKind::Decision => 3,
        StateKind::Note => 4,
    }
}

fn status_rank(value: &StateValueV1) -> u8 {
    match value {
        StateValueV1::Constraint(value) => match value.status {
            ConstraintStatus::Active => 0,
            ConstraintStatus::Satisfied => 1,
            ConstraintStatus::Waived => 2,
        },
        StateValueV1::Error(value) => match value.status {
            ErrorStatus::Open => 0,
            ErrorStatus::Resolved => 1,
            ErrorStatus::Ignored => 2,
        },
        StateValueV1::Task(value) => match value.status {
            TaskStatus::InProgress => 0,
            TaskStatus::Blocked => 1,
            TaskStatus::Todo => 2,
            TaskStatus::Done => 3,
            TaskStatus::Cancelled => 4,
        },
        StateValueV1::Decision(value) => match value.status {
            DecisionStatus::Active => 0,
            DecisionStatus::Superseded { .. } => 1,
        },
        StateValueV1::Note(_) => 0,
    }
}

fn kind_name(kind: &StateKind) -> &'static str {
    match kind {
        StateKind::Task => "task",
        StateKind::Decision => "decision",
        StateKind::Constraint => "constraint",
        StateKind::Note => "note",
        StateKind::Error => "error",
    }
}

fn tier_name(tier: &StateTier) -> &'static str {
    match tier {
        StateTier::Active => "active",
        StateTier::Soft => "soft",
        StateTier::Hard => "hard",
    }
}

fn status_name_task(status: &TaskStatus) -> &'static str {
    match status {
        TaskStatus::Todo => "todo",
        TaskStatus::InProgress => "in_progress",
        TaskStatus::Blocked => "blocked",
        TaskStatus::Done => "done",
        TaskStatus::Cancelled => "cancelled",
    }
}

fn decision_tag(status: &DecisionStatus) -> &'static str {
    match status {
        DecisionStatus::Active => "active",
        DecisionStatus::Superseded { .. } => "superseded",
    }
}

fn constraint_name(status: &ConstraintStatus) -> &'static str {
    match status {
        ConstraintStatus::Active => "active",
        ConstraintStatus::Satisfied => "satisfied",
        ConstraintStatus::Waived => "waived",
    }
}

fn strength_name(strength: &ConstraintStrength) -> &'static str {
    match strength {
        ConstraintStrength::Soft => "soft",
        ConstraintStrength::Hard => "hard",
    }
}

fn error_name(status: &ErrorStatus) -> &'static str {
    match status {
        ErrorStatus::Open => "open",
        ErrorStatus::Resolved => "resolved",
        ErrorStatus::Ignored => "ignored",
    }
}

fn severity_name(severity: &ErrorSeverity) -> &'static str {
    match severity {
        ErrorSeverity::Info => "info",
        ErrorSeverity::Warning => "warning",
        ErrorSeverity::Error => "error",
        ErrorSeverity::Fatal => "fatal",
    }
}
