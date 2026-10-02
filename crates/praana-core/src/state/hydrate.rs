//! Pure matching and selection for StateGraph auto-hydration.
//!
//! Normative owner: `docs/RUST_V2_STATE_GRAPH_SPEC.md` §10.1 and §10.2.

use crate::protocol::constants::EVENT_SCHEMA_VERSION;
use crate::protocol::events::{CanonicalEvent, EventEnvelope};
use crate::protocol::id::{EventId, SessionId, StateMutationId, TurnId};
use crate::protocol::state_graph::{
    AutomationScoreV1, AutomationSignal, ObjectLifecycle, StateChangeReason, StateChangedV1,
    StateGraphV1, StateObjectV1, StateOperationV1, StateSourceKind, StateSourceV1, StateTier,
    StateValueV1,
};
use crate::state::apply::apply_state_changed;
use crate::state::StateServiceError;
use crate::unicode::{is_letter_or_number_v15_1, nfkc_casefold_v1};

pub const STOP_WORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on",
    "or", "that", "the", "this", "to", "with",
];

/// Extracts object text per §10.1:
/// | Kind | Fields |
/// |---|---|
/// | Task | `state_id`, `title`, `description`, `blocker` |
/// | Decision | `state_id`, `summary`, `rationale` |
/// | Constraint | `state_id`, `text`, `status_reason` |
/// | Note | `state_id`, `text`, then each tag in stored order |
/// | Error | `state_id`, `message`, `code`, `tool_name`, `command_label`, `resolution` |
pub fn object_text(obj: &StateObjectV1) -> String {
    let id_str = obj.state_id.as_str();
    let mut fields: Vec<&str> = Vec::new();
    fields.push(&id_str);

    match &obj.value {
        StateValueV1::Task(task) => {
            fields.push(task.title.as_str());
            if let Some(desc) = &task.description {
                fields.push(desc.as_str());
            }
            if let Some(blocker) = &task.blocker {
                fields.push(blocker.as_str());
            }
        }
        StateValueV1::Decision(decision) => {
            fields.push(decision.summary.as_str());
            fields.push(decision.rationale.as_str());
        }
        StateValueV1::Constraint(constraint) => {
            fields.push(constraint.text.as_str());
            if let Some(status_reason) = &constraint.status_reason {
                fields.push(status_reason.as_str());
            }
        }
        StateValueV1::Note(note) => {
            fields.push(note.text.as_str());
            for tag in &note.tags {
                fields.push(tag.as_str());
            }
        }
        StateValueV1::Error(error) => {
            fields.push(error.message.as_str());
            if let Some(code) = &error.code {
                fields.push(code.as_str());
            }
            if let Some(tool_name) = &error.tool_name {
                fields.push(tool_name.as_str());
            }
            if let Some(command_label) = &error.command_label {
                fields.push(command_label.as_str());
            }
            if let Some(resolution) = &error.resolution {
                fields.push(resolution.as_str());
            }
        }
    }

    fields.join("\n")
}

/// Tokenize text per §10.1 steps 1–6.
pub fn tokenize(text: &str) -> Vec<String> {
    let folded = nfkc_casefold_v1(text);
    let mut raw_pieces = Vec::new();
    let mut current = String::new();
    for c in folded.chars() {
        if !is_letter_or_number_v15_1(c) && c != '_' && c != '-' && c != '.' && c != '/' {
            if !current.is_empty() {
                raw_pieces.push(std::mem::take(&mut current));
            }
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() {
        raw_pieces.push(current);
    }

    let mut tokens = Vec::new();
    for piece in raw_pieces {
        let trimmed = piece.trim_matches(|c| c == '_' || c == '-' || c == '.' || c == '/');
        if trimmed.is_empty() {
            continue;
        }
        let scalar_count = trimmed.chars().count();
        let has_digit_or_punct = trimmed
            .chars()
            .any(|c| c.is_ascii_digit() || c == '_' || c == '-' || c == '.' || c == '/');
        let all_ascii_digits = trimmed.chars().all(|c| c.is_ascii_digit());

        let is_identifier = scalar_count >= 2 && has_digit_or_punct && !all_ascii_digits;
        let is_ordinary = scalar_count >= 3 && !STOP_WORDS.contains(&trimmed);
        if is_identifier || is_ordinary {
            tokens.push(trimmed.to_string());
        }
    }

    let mut unique_tokens = Vec::new();
    for token in tokens {
        if !unique_tokens.contains(&token) {
            unique_tokens.push(token);
        }
    }
    unique_tokens
}

/// Returns true if a token is classified as an identifier per §10.1 step 4:
/// has at least 2 Unicode scalars, contains an ASCII digit or one of `_`, `-`, `.`, `/`,
/// and is not made only of ASCII digits.
pub fn is_identifier_token(token: &str) -> bool {
    let scalar_count = token.chars().count();
    let has_digit_or_punct = token
        .chars()
        .any(|c| c.is_ascii_digit() || c == '_' || c == '-' || c == '.' || c == '/');
    let all_ascii_digits = token.chars().all(|c| c.is_ascii_digit());
    scalar_count >= 2 && has_digit_or_punct && !all_ascii_digits
}

/// Trims ASCII whitespace (U+0009 through U+000D, and U+0020) at both ends per §10.1.
pub fn trim_ascii_whitespace(s: &str) -> &str {
    s.trim_start_matches(|c| matches!(c, '\x09'..='\x0D' | ' '))
        .trim_end_matches(|c| matches!(c, '\x09'..='\x0D' | ' '))
}

/// Computes integer fixed overlap score per §10.2:
/// largest integer `s` in `0..=1000` satisfying:
/// `s * s * max(1, |Q| * |D|) <= 1_000_000 * shared * shared`
pub fn fixed_overlap_score(
    shared: usize,
    q_len: usize,
    d_len: usize,
) -> Result<u32, StateServiceError> {
    let shared = shared as u128;
    let denom = (q_len as u128)
        .checked_mul(d_len as u128)
        .ok_or_else(|| {
            StateServiceError::new(
                "STATE_PROJECTION_INTEGRITY",
                "overflow in fixed_overlap_score denominator",
            )
        })?
        .max(1);
    let target = 1_000_000u128
        .checked_mul(shared)
        .and_then(|t| t.checked_mul(shared))
        .ok_or_else(|| {
            StateServiceError::new(
                "STATE_PROJECTION_INTEGRITY",
                "overflow in fixed_overlap_score target",
            )
        })?;

    let mut low = 0u32;
    let mut high = 1000u32;
    let mut best = 0u32;

    while low <= high {
        let mid = low + (high - low) / 2;
        let s = mid as u128;
        let lhs = s
            .checked_mul(s)
            .and_then(|s2| s2.checked_mul(denom))
            .ok_or_else(|| {
                StateServiceError::new(
                    "STATE_PROJECTION_INTEGRITY",
                    "overflow in fixed_overlap_score lhs",
                )
            })?;
        if lhs <= target {
            best = mid;
            low = mid + 1;
        } else {
            if mid == 0 {
                break;
            }
            high = mid - 1;
        }
    }
    Ok(best)
}

#[derive(Clone, Debug)]
pub struct HydrateCandidate<'a> {
    pub obj: &'a StateObjectV1,
    pub score: u32,
    pub signal: AutomationSignal,
}

/// Scores a single candidate object against pre-tokenized query and folded query per §10.2.
/// Returns `(score, signal, qualifies)`.
pub fn score_candidate(
    q_tokens: &[String],
    folded_query: &str,
    obj: &StateObjectV1,
) -> Result<(u32, AutomationSignal, bool), StateServiceError> {
    let obj_text = object_text(obj);
    let d_tokens = tokenize(&obj_text);
    let folded_obj = nfkc_casefold_v1(&obj_text);

    let mut shared_tokens = Vec::new();
    for q in q_tokens {
        if d_tokens.contains(q) {
            shared_tokens.push(q.as_str());
        }
    }
    let shared = shared_tokens.len();
    let identifier = shared_tokens.iter().any(|t| is_identifier_token(t));
    let phrase = folded_query.chars().count() >= 5
        && q_tokens.len() >= 2
        && folded_obj.contains(folded_query);

    if identifier {
        Ok((1000, AutomationSignal::ExactIdentifier, true))
    } else if phrase {
        Ok((900, AutomationSignal::Phrase, true))
    } else {
        let score = fixed_overlap_score(shared, q_tokens.len(), d_tokens.len())?;
        let qualifies = shared >= 2 && score >= 250;
        Ok((score, AutomationSignal::LexicalOverlap, qualifies))
    }
}

/// Selects qualifying candidates and applies greedy fit per §10.2.
///
/// Returns `(candidate_count, selected_operations, scores_millis)`.
#[allow(clippy::too_many_arguments)]
pub fn select_auto_hydrate_candidates(
    graph: &StateGraphV1,
    query: &str,
    auto_hydrate_max: u32,
    active_max_tokens: u64,
    current_sequence: u64,
    trigger_event_id: EventId,
    trigger_sequence: u64,
    turn_id: TurnId,
    cancelled: &dyn Fn() -> bool,
) -> Result<(u32, Vec<StateOperationV1>, Vec<AutomationScoreV1>), StateServiceError> {
    if cancelled() {
        return Err(StateServiceError::new("STATE_CANCELLED", "cancelled"));
    }

    let active_count = graph
        .objects
        .iter()
        .filter(|o| o.lifecycle == ObjectLifecycle::Current && o.tier == StateTier::Active)
        .count();
    let slots = 256usize.saturating_sub(active_count);
    let slot_cap = (auto_hydrate_max as usize).min(slots);

    let soft_objects: Vec<&StateObjectV1> = graph
        .objects
        .iter()
        .filter(|o| o.lifecycle == ObjectLifecycle::Current && o.tier == StateTier::Soft)
        .collect();
    let candidate_count = soft_objects.len() as u32;

    if candidate_count == 0 || slot_cap == 0 {
        return Ok((candidate_count, Vec::new(), Vec::new()));
    }

    let q_tokens = tokenize(query);
    let folded_query_raw = nfkc_casefold_v1(query);
    let folded_query = trim_ascii_whitespace(&folded_query_raw);

    if cancelled() {
        return Err(StateServiceError::new("STATE_CANCELLED", "cancelled"));
    }

    let mut qualifying = Vec::new();
    for obj in &soft_objects {
        if cancelled() {
            return Err(StateServiceError::new("STATE_CANCELLED", "cancelled"));
        }
        let (score, signal, qualifies) = score_candidate(&q_tokens, folded_query, obj)?;
        if qualifies {
            qualifying.push(HydrateCandidate { obj, score, signal });
        }
    }

    // Sort qualifying candidates: score descending, updated sequence descending, state ID ascending
    qualifying.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.obj.updated_sequence.cmp(&a.obj.updated_sequence))
            .then_with(|| a.obj.state_id.cmp(&b.obj.state_id))
    });

    let mut selected_candidates = Vec::new();
    let mut selected_ops = Vec::new();

    for cand in qualifying {
        if selected_candidates.len() >= slot_cap {
            break;
        }

        if cancelled() {
            return Err(StateServiceError::new("STATE_CANCELLED", "cancelled"));
        }

        let op = StateOperationV1::SetTier {
            state_id: cand.obj.state_id,
            expected_revision: cand.obj.revision,
            tier: StateTier::Active,
            touch: true,
        };

        let mut candidate_ops = selected_ops.clone();
        candidate_ops.push(op.clone());

        // The trial envelope and StateChanged event use placeholder IDs/timestamps/automation because
        // render_state_tail only inspects the projected state graph objects (their tiers, revisions,
        // and contents), none of which depend on mutation_id, event_id, session_id, timestamp_ms,
        // or automation. Thus, the resulting token estimate is exact and identical to the real commit.
        let trial_event = StateChangedV1 {
            state_schema_version: 1,
            mutation_id: StateMutationId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAV").unwrap(),
            expected_graph_sequence: current_sequence,
            reason: StateChangeReason::AutoHydrate,
            source: StateSourceV1 {
                source_kind: StateSourceKind::UserMessage,
                event_id: trigger_event_id,
                sequence: trigger_sequence,
                turn_id: Some(turn_id),
                attempt_id: None,
                tool_call_id: None,
                artifact_id: None,
                summary_segment_id: None,
            },
            automation: None,
            operations: candidate_ops,
        };

        let trial_envelope = EventEnvelope {
            schema_version: EVENT_SCHEMA_VERSION,
            event_id: EventId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAW").unwrap(),
            session_id: SessionId::from_str_canonical("01ARZ3NDEKTSV4RRFFQ69G5FAX").unwrap(),
            sequence: current_sequence + 1,
            timestamp_ms: 0,
            turn_id: None,
            attempt_id: None,
            event: CanonicalEvent::StateChanged(trial_event.clone()),
        };

        let mut step_trial_graph = graph.clone();
        apply_state_changed(&mut step_trial_graph, &trial_envelope, &trial_event).map_err(
            |_| {
                StateServiceError::new(
                    "STATE_PROJECTION_INTEGRITY",
                    "candidate trial failed apply_state_changed",
                )
            },
        )?;

        let tail = crate::state::render::render_state_tail(&step_trial_graph);
        let estimate = crate::state::render::estimate_tail(&tail).map_err(|_| {
            StateServiceError::new("STATE_PROJECTION_INTEGRITY", "token estimate failed")
        })?;

        if estimate.total_tokens <= active_max_tokens {
            selected_candidates.push(cand);
            selected_ops.push(op);
        }
    }

    let scores_millis: Vec<AutomationScoreV1> = selected_candidates
        .into_iter()
        .map(|cand| AutomationScoreV1 {
            state_id: cand.obj.state_id,
            score_millis: cand.score,
            signal: cand.signal,
        })
        .collect();

    Ok((candidate_count, selected_ops, scores_millis))
}
