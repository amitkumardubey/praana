//! Shared StateGraph transition function (StateGraph §4, §5, §4.1).

use crate::protocol::events::EventEnvelope;
use crate::protocol::id::StateId;
use crate::protocol::state_graph::*;

use super::StateServiceError;

const MAX_OPS: usize = 256;
const MAX_CURRENT: usize = 4096;
const MAX_ACTIVE: usize = 256;
const MAX_TAGS: usize = 16;
const TITLE_MAX: usize = 256;
const SHORT_MAX: usize = 512;
const MEDIUM_MAX: usize = 1024;
const LONG_MAX: usize = 4096;
const NOTE_MAX: usize = 8192;

pub fn apply_state_changed(
    graph: &mut StateGraphV1,
    envelope: &EventEnvelope,
    event: &StateChangedV1,
) -> Result<(), StateServiceError> {
    if event.operations.is_empty() || event.operations.len() > MAX_OPS {
        return Err(field_limit());
    }
    let mut next = graph.clone();
    next.objects.sort_by_key(|object| object.state_id);
    let before = next.clone();
    for operation in &event.operations {
        apply_operation(&mut next, envelope, &event.source, operation)?;
    }
    enforce_end_invariants(&next)?;
    enforce_counts(&next)?;
    next.objects.sort_by_key(|object| object.state_id);
    // §3.2 / §4.1: a same-value field or tier write is no change for that
    // object unless `touch` is set or another operation changes that object.
    for operation in &event.operations {
        if let Some((id, touch)) = same_value_target(operation) {
            if !touch && object_unchanged(&before, &next, id) {
                return Err(no_change(Some(id)));
            }
        }
    }
    if next.objects == before.objects && next.focus == before.focus {
        return Err(no_change(only_target(&event.operations)));
    }
    next.applied_through_sequence = envelope.sequence;
    *graph = next;
    Ok(())
}

fn apply_operation(
    graph: &mut StateGraphV1,
    envelope: &EventEnvelope,
    source: &StateSourceV1,
    operation: &StateOperationV1,
) -> Result<(), StateServiceError> {
    match operation {
        StateOperationV1::Create {
            state_id,
            tier,
            value,
        } => {
            validate_value(value)?;
            if let StateValueV1::Decision(decision) = value {
                if !matches!(decision.status, DecisionStatus::Active) {
                    return Err(StateServiceError::new(
                        "STATE_INVALID_TRANSITION",
                        "state transition is invalid",
                    )
                    .with_target(*state_id, None, None));
                }
            }
            if graph
                .objects
                .iter()
                .any(|object| object.state_id == *state_id)
            {
                return Err(StateServiceError::new(
                    "STATE_DUPLICATE_ID",
                    "state id already exists",
                )
                .with_target(*state_id, None, None));
            }
            graph.objects.push(StateObjectV1 {
                state_id: *state_id,
                revision: 1,
                tier: tier.clone(),
                lifecycle: ObjectLifecycle::Current,
                value: value.clone(),
                created_at_ms: envelope.timestamp_ms,
                created_sequence: envelope.sequence,
                updated_at_ms: envelope.timestamp_ms,
                updated_sequence: envelope.sequence,
                last_touched_at_ms: envelope.timestamp_ms,
                last_touched_sequence: envelope.sequence,
                last_touched_turn_ordinal: graph.committed_turn_ordinal,
                source: source.clone(),
                retracted_reason: None,
            });
            Ok(())
        }
        StateOperationV1::SetFocus { patch } => apply_focus(graph, envelope, patch),
        StateOperationV1::Touch {
            state_id,
            expected_revision,
        } => {
            let index = require_current(graph, *state_id, Some(*expected_revision), None)?;
            bump(
                &mut graph.objects[index],
                envelope,
                source,
                graph.committed_turn_ordinal,
                false,
                true,
            )?;
            Ok(())
        }
        other => apply_object_op(graph, envelope, source, other),
    }
}

fn apply_focus(
    graph: &mut StateGraphV1,
    envelope: &EventEnvelope,
    patch: &FocusPatchV1,
) -> Result<(), StateServiceError> {
    match patch {
        FocusPatchV1::Clear => {
            graph.focus = None;
            Ok(())
        }
        FocusPatchV1::Set(state_id) => {
            let Some(object) = graph
                .objects
                .iter()
                .find(|object| object.state_id == *state_id)
            else {
                return Err(focus_invalid(*state_id));
            };
            if object.lifecycle != ObjectLifecycle::Current || object.tier != StateTier::Active {
                return Err(focus_invalid(*state_id));
            }
            if graph
                .focus
                .as_ref()
                .is_some_and(|focus| focus.state_id == *state_id)
            {
                return Ok(());
            }
            graph.focus = Some(FocusV1 {
                state_id: *state_id,
                set_at_ms: envelope.timestamp_ms,
                set_sequence: envelope.sequence,
            });
            Ok(())
        }
    }
}

fn apply_object_op(
    graph: &mut StateGraphV1,
    envelope: &EventEnvelope,
    source: &StateSourceV1,
    operation: &StateOperationV1,
) -> Result<(), StateServiceError> {
    let (state_id, expected, kind) = object_target(operation).expect("object operation");
    let index = require_current(graph, state_id, Some(expected), kind)?;
    if let StateOperationV1::SupersedeDecision { by_state_id, .. } = operation {
        if *by_state_id == state_id {
            return Err(invalid_transition(
                state_id,
                expected,
                graph.objects[index].revision,
            ));
        }
        let by_ok = graph.objects.iter().any(|candidate| {
            candidate.state_id == *by_state_id
                && candidate.lifecycle == ObjectLifecycle::Current
                && matches!(candidate.value, StateValueV1::Decision(_))
        });
        if !by_ok {
            return Err(supersede_by_error(graph, *by_state_id));
        }
    }
    let focused = graph
        .focus
        .as_ref()
        .is_some_and(|focus| focus.state_id == state_id);
    let mut clear_focus = false;
    let ordinal = graph.committed_turn_ordinal;
    let object = &mut graph.objects[index];
    let (payload_changed, touch) = match operation {
        StateOperationV1::UpdateTask { patch, touch, .. } => {
            let StateValueV1::Task(value) = &mut object.value else {
                return Err(kind_mismatch(state_id, expected, object.revision));
            };
            let previous = value.clone();
            if let Some(title) = &patch.title {
                require_text(title, TITLE_MAX)?;
                value.title = title.clone();
            }
            apply_optional_string(&mut value.description, &patch.description, LONG_MAX)?;
            if let Some(status) = &patch.status {
                if !task_transition_ok(&previous.status, status) {
                    return Err(invalid_transition(state_id, expected, object.revision));
                }
                value.status = status.clone();
            }
            apply_optional_string(&mut value.blocker, &patch.blocker, LONG_MAX)?;
            if focused
                && patch.status.as_ref().is_some_and(|status| {
                    matches!(status, TaskStatus::Done | TaskStatus::Cancelled)
                })
            {
                clear_focus = true;
            }
            (*value != previous, *touch)
        }
        StateOperationV1::ReopenTask { status, touch, .. } => {
            let StateValueV1::Task(value) = &mut object.value else {
                return Err(kind_mismatch(state_id, expected, object.revision));
            };
            if !matches!(value.status, TaskStatus::Done | TaskStatus::Cancelled) {
                return Err(invalid_transition(state_id, expected, object.revision));
            }
            value.status = match status {
                ReopenTaskStatus::Todo => TaskStatus::Todo,
                ReopenTaskStatus::InProgress => TaskStatus::InProgress,
            };
            value.blocker = None;
            (true, *touch)
        }
        StateOperationV1::UpdateDecision {
            summary,
            rationale,
            touch,
            ..
        } => {
            let StateValueV1::Decision(value) = &mut object.value else {
                return Err(kind_mismatch(state_id, expected, object.revision));
            };
            if !matches!(value.status, DecisionStatus::Active) {
                return Err(invalid_transition(state_id, expected, object.revision));
            }
            let previous = value.clone();
            if let Some(summary) = summary {
                require_text(summary, SHORT_MAX)?;
                value.summary = summary.clone();
            }
            if let Some(rationale) = rationale {
                require_text(rationale, LONG_MAX)?;
                value.rationale = rationale.clone();
            }
            (*value != previous, *touch)
        }
        StateOperationV1::SupersedeDecision {
            by_state_id, touch, ..
        } => {
            let StateValueV1::Decision(value) = &mut object.value else {
                return Err(kind_mismatch(state_id, expected, object.revision));
            };
            if !matches!(value.status, DecisionStatus::Active) {
                return Err(invalid_transition(state_id, expected, object.revision));
            }
            value.status = DecisionStatus::Superseded {
                by_state_id: *by_state_id,
            };
            (true, *touch)
        }
        StateOperationV1::UpdateConstraint { patch, touch, .. } => {
            let StateValueV1::Constraint(value) = &mut object.value else {
                return Err(kind_mismatch(state_id, expected, object.revision));
            };
            let previous = value.clone();
            if let Some(text) = &patch.text {
                require_text(text, LONG_MAX)?;
                value.text = text.clone();
            }
            if let Some(strength) = &patch.strength {
                value.strength = strength.clone();
            }
            if let Some(status) = &patch.status {
                if !constraint_transition_ok(&previous.status, status) {
                    return Err(invalid_transition(state_id, expected, object.revision));
                }
                value.status = status.clone();
            }
            apply_optional_string(&mut value.status_reason, &patch.status_reason, LONG_MAX)?;
            (*value != previous, *touch)
        }
        StateOperationV1::ReactivateConstraint { touch, .. } => {
            let StateValueV1::Constraint(value) = &mut object.value else {
                return Err(kind_mismatch(state_id, expected, object.revision));
            };
            if !matches!(
                value.status,
                ConstraintStatus::Satisfied | ConstraintStatus::Waived
            ) {
                return Err(invalid_transition(state_id, expected, object.revision));
            }
            value.status = ConstraintStatus::Active;
            value.status_reason = None;
            (true, *touch)
        }
        StateOperationV1::UpdateNote {
            text, tags, touch, ..
        } => {
            let StateValueV1::Note(value) = &mut object.value else {
                return Err(kind_mismatch(state_id, expected, object.revision));
            };
            let previous = value.clone();
            if let Some(text) = text {
                require_text(text, NOTE_MAX)?;
                value.text = text.clone();
            }
            if let Some(tags) = tags {
                require_tags(tags)?;
                value.tags = tags.clone();
            }
            (*value != previous, *touch)
        }
        StateOperationV1::UpdateError { patch, touch, .. } => {
            let StateValueV1::Error(value) = &mut object.value else {
                return Err(kind_mismatch(state_id, expected, object.revision));
            };
            let previous = value.clone();
            if let Some(message) = &patch.message {
                require_text(message, NOTE_MAX)?;
                value.message = message.clone();
            }
            apply_optional_string(&mut value.code, &patch.code, SHORT_MAX)?;
            if let Some(severity) = &patch.severity {
                value.severity = severity.clone();
            }
            if let Some(status) = &patch.status {
                if !error_transition_ok(&previous.status, status) {
                    return Err(invalid_transition(state_id, expected, object.revision));
                }
                value.status = status.clone();
            }
            apply_optional_string(&mut value.tool_name, &patch.tool_name, SHORT_MAX)?;
            apply_optional_string(&mut value.command_label, &patch.command_label, SHORT_MAX)?;
            apply_optional_string(&mut value.resolution, &patch.resolution, NOTE_MAX)?;
            if let Some(count) = patch.occurrence_count {
                if count < 1 {
                    return Err(field_limit());
                }
                value.occurrence_count = count;
            }
            if let Some(event_id) = patch.last_observed_event_id {
                value.last_observed_event_id = event_id;
            }
            (*value != previous, *touch)
        }
        StateOperationV1::ReopenError { touch, .. } => {
            let StateValueV1::Error(value) = &mut object.value else {
                return Err(kind_mismatch(state_id, expected, object.revision));
            };
            if !matches!(value.status, ErrorStatus::Resolved | ErrorStatus::Ignored) {
                return Err(invalid_transition(state_id, expected, object.revision));
            }
            value.status = ErrorStatus::Open;
            value.resolution = None;
            (true, *touch)
        }
        StateOperationV1::SetTier { tier, touch, .. } => {
            let changed = object.tier != *tier;
            object.tier = tier.clone();
            if focused && *tier != StateTier::Active {
                clear_focus = true;
            }
            (changed, *touch)
        }
        StateOperationV1::Retract { reason, .. } => {
            require_text(reason, MEDIUM_MAX)?;
            object.lifecycle = ObjectLifecycle::Retracted;
            object.retracted_reason = Some(reason.clone());
            if focused {
                clear_focus = true;
            }
            (true, true)
        }
        StateOperationV1::Create { .. }
        | StateOperationV1::SetFocus { .. }
        | StateOperationV1::Touch { .. } => unreachable!("handled above"),
    };
    if payload_changed || touch {
        bump(object, envelope, source, ordinal, true, touch)?;
    }
    if clear_focus {
        graph.focus = None;
    }
    Ok(())
}

fn bump(
    object: &mut StateObjectV1,
    envelope: &EventEnvelope,
    source: &StateSourceV1,
    turn_ordinal: u64,
    update_updated: bool,
    touch: bool,
) -> Result<(), StateServiceError> {
    object.revision = object.revision.checked_add(1).ok_or_else(field_limit)?;
    object.source = source.clone();
    if update_updated {
        object.updated_at_ms = envelope.timestamp_ms;
        object.updated_sequence = envelope.sequence;
    }
    if touch {
        object.last_touched_at_ms = envelope.timestamp_ms;
        object.last_touched_sequence = envelope.sequence;
        object.last_touched_turn_ordinal = turn_ordinal;
    }
    Ok(())
}

fn require_current(
    graph: &StateGraphV1,
    state_id: StateId,
    expected: Option<u64>,
    kind: Option<StateKind>,
) -> Result<usize, StateServiceError> {
    let Some(index) = graph
        .objects
        .iter()
        .position(|object| object.state_id == state_id)
    else {
        return Err(
            StateServiceError::new("STATE_NOT_FOUND", "state object was not found")
                .with_target(state_id, expected, None),
        );
    };
    let object = &graph.objects[index];
    if object.lifecycle != ObjectLifecycle::Current {
        return Err(
            StateServiceError::new("STATE_RETRACTED", "state object is retracted").with_target(
                state_id,
                expected,
                Some(object.revision),
            ),
        );
    }
    if let Some(kind) = kind {
        if value_kind(&object.value) != kind {
            return Err(kind_mismatch(
                state_id,
                expected.unwrap_or(object.revision),
                object.revision,
            ));
        }
    }
    if let Some(expected) = expected {
        if object.revision != expected || expected == 0 {
            return Err(StateServiceError::new(
                "STATE_REVISION_CONFLICT",
                "state revision conflict",
            )
            .with_target(state_id, Some(expected), Some(object.revision)));
        }
    }
    Ok(index)
}

fn supersede_by_error(graph: &StateGraphV1, by_state_id: StateId) -> StateServiceError {
    let Some(object) = graph
        .objects
        .iter()
        .find(|object| object.state_id == by_state_id)
    else {
        return StateServiceError::new("STATE_NOT_FOUND", "state object was not found")
            .with_target(by_state_id, None, None);
    };
    if object.lifecycle != ObjectLifecycle::Current {
        return StateServiceError::new("STATE_RETRACTED", "state object is retracted").with_target(
            by_state_id,
            None,
            Some(object.revision),
        );
    }
    if !matches!(object.value, StateValueV1::Decision(_)) {
        return kind_mismatch(by_state_id, object.revision, object.revision);
    }
    invalid_transition(by_state_id, object.revision, object.revision)
}

fn enforce_end_invariants(graph: &StateGraphV1) -> Result<(), StateServiceError> {
    for object in graph
        .objects
        .iter()
        .filter(|object| object.lifecycle == ObjectLifecycle::Current)
    {
        match &object.value {
            StateValueV1::Task(value) => {
                let blocked = matches!(value.status, TaskStatus::Blocked);
                if blocked != value.blocker.as_ref().is_some_and(|text| !text.is_empty()) {
                    return Err(invalid_transition(
                        object.state_id,
                        object.revision,
                        object.revision,
                    ));
                }
            }
            StateValueV1::Constraint(value) => {
                let needs_reason = matches!(
                    value.status,
                    ConstraintStatus::Satisfied | ConstraintStatus::Waived
                );
                if needs_reason
                    != value
                        .status_reason
                        .as_ref()
                        .is_some_and(|text| !text.is_empty())
                {
                    return Err(invalid_transition(
                        object.state_id,
                        object.revision,
                        object.revision,
                    ));
                }
            }
            StateValueV1::Error(value) => {
                let needs_resolution =
                    matches!(value.status, ErrorStatus::Resolved | ErrorStatus::Ignored);
                if needs_resolution
                    != value
                        .resolution
                        .as_ref()
                        .is_some_and(|text| !text.is_empty())
                {
                    return Err(invalid_transition(
                        object.state_id,
                        object.revision,
                        object.revision,
                    ));
                }
            }
            StateValueV1::Decision(_) | StateValueV1::Note(_) => {}
        }
    }
    if let Some(focus) = &graph.focus {
        let Some(object) = graph
            .objects
            .iter()
            .find(|object| object.state_id == focus.state_id)
        else {
            return Err(focus_invalid(focus.state_id));
        };
        if object.lifecycle != ObjectLifecycle::Current || object.tier != StateTier::Active {
            return Err(focus_invalid(focus.state_id));
        }
    }
    Ok(())
}

fn enforce_counts(graph: &StateGraphV1) -> Result<(), StateServiceError> {
    let current = graph
        .objects
        .iter()
        .filter(|object| object.lifecycle == ObjectLifecycle::Current)
        .count();
    let active = graph
        .objects
        .iter()
        .filter(|object| {
            object.lifecycle == ObjectLifecycle::Current && object.tier == StateTier::Active
        })
        .count();
    if current > MAX_CURRENT || active > MAX_ACTIVE {
        return Err(StateServiceError::new(
            "STATE_OBJECT_LIMIT",
            "state object limit",
        ));
    }
    Ok(())
}

fn validate_value(value: &StateValueV1) -> Result<(), StateServiceError> {
    match value {
        StateValueV1::Task(value) => {
            require_text(&value.title, TITLE_MAX)?;
            require_optional(value.description.as_deref(), LONG_MAX)?;
            require_optional(value.blocker.as_deref(), LONG_MAX)?;
        }
        StateValueV1::Decision(value) => {
            require_text(&value.summary, SHORT_MAX)?;
            require_text(&value.rationale, LONG_MAX)?;
        }
        StateValueV1::Constraint(value) => {
            require_text(&value.text, LONG_MAX)?;
            require_optional(value.status_reason.as_deref(), LONG_MAX)?;
        }
        StateValueV1::Note(value) => {
            require_text(&value.text, NOTE_MAX)?;
            require_tags(&value.tags)?;
        }
        StateValueV1::Error(value) => {
            require_fingerprint(&value.fingerprint)?;
            require_text(&value.message, NOTE_MAX)?;
            require_optional(value.code.as_deref(), SHORT_MAX)?;
            require_optional(value.tool_name.as_deref(), SHORT_MAX)?;
            require_optional(value.command_label.as_deref(), SHORT_MAX)?;
            require_optional(value.resolution.as_deref(), NOTE_MAX)?;
            if value.occurrence_count < 1 {
                return Err(field_limit());
            }
        }
    }
    Ok(())
}

pub fn normalize_text(input: &str) -> String {
    input
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_owned()
}

fn require_text(text: &str, max: usize) -> Result<(), StateServiceError> {
    if normalize_text(text) != text || text.is_empty() || text.len() > max {
        return Err(field_limit());
    }
    Ok(())
}

fn require_optional(text: Option<&str>, max: usize) -> Result<(), StateServiceError> {
    match text {
        None => Ok(()),
        Some(text) => require_text(text, max),
    }
}

fn apply_optional_string(
    target: &mut Option<String>,
    patch: &OptionalStringPatch,
    max: usize,
) -> Result<(), StateServiceError> {
    match patch {
        OptionalStringPatch::Keep => Ok(()),
        OptionalStringPatch::Clear => {
            *target = None;
            Ok(())
        }
        OptionalStringPatch::Set(value) => {
            require_text(value, max)?;
            *target = Some(value.clone());
            Ok(())
        }
    }
}

fn require_tags(tags: &[String]) -> Result<(), StateServiceError> {
    if tags.len() > MAX_TAGS {
        return Err(field_limit());
    }
    let mut previous: Option<&str> = None;
    for tag in tags {
        if !tag_matches(tag) {
            return Err(field_limit());
        }
        if previous.is_some_and(|previous| tag.as_str() <= previous) {
            return Err(field_limit());
        }
        previous = Some(tag.as_str());
    }
    Ok(())
}

pub fn tag_matches(tag: &str) -> bool {
    let bytes = tag.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return false;
    }
    let first = bytes[0];
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    bytes[1..].iter().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_' || *byte == b'-'
    })
}

fn require_fingerprint(text: &str) -> Result<(), StateServiceError> {
    if text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Ok(());
    }
    Err(field_limit())
}

fn task_transition_ok(from: &TaskStatus, to: &TaskStatus) -> bool {
    if from == to {
        return true;
    }
    match from {
        TaskStatus::Todo => matches!(
            to,
            TaskStatus::InProgress | TaskStatus::Blocked | TaskStatus::Done | TaskStatus::Cancelled
        ),
        TaskStatus::InProgress => {
            matches!(
                to,
                TaskStatus::Blocked | TaskStatus::Done | TaskStatus::Cancelled
            )
        }
        TaskStatus::Blocked => matches!(
            to,
            TaskStatus::InProgress | TaskStatus::Done | TaskStatus::Cancelled
        ),
        TaskStatus::Done | TaskStatus::Cancelled => false,
    }
}

fn constraint_transition_ok(from: &ConstraintStatus, to: &ConstraintStatus) -> bool {
    if from == to {
        return true;
    }
    matches!(from, ConstraintStatus::Active)
        && matches!(to, ConstraintStatus::Satisfied | ConstraintStatus::Waived)
}

fn error_transition_ok(from: &ErrorStatus, to: &ErrorStatus) -> bool {
    if from == to {
        return true;
    }
    matches!(from, ErrorStatus::Open) && matches!(to, ErrorStatus::Resolved | ErrorStatus::Ignored)
}

fn object_target(operation: &StateOperationV1) -> Option<(StateId, u64, Option<StateKind>)> {
    Some(match operation {
        StateOperationV1::UpdateTask {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::ReopenTask {
            state_id,
            expected_revision,
            ..
        } => (*state_id, *expected_revision, Some(StateKind::Task)),
        StateOperationV1::UpdateDecision {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::SupersedeDecision {
            state_id,
            expected_revision,
            ..
        } => (*state_id, *expected_revision, Some(StateKind::Decision)),
        StateOperationV1::UpdateConstraint {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::ReactivateConstraint {
            state_id,
            expected_revision,
            ..
        } => (*state_id, *expected_revision, Some(StateKind::Constraint)),
        StateOperationV1::UpdateNote {
            state_id,
            expected_revision,
            ..
        } => (*state_id, *expected_revision, Some(StateKind::Note)),
        StateOperationV1::UpdateError {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::ReopenError {
            state_id,
            expected_revision,
            ..
        } => (*state_id, *expected_revision, Some(StateKind::Error)),
        StateOperationV1::SetTier {
            state_id,
            expected_revision,
            ..
        }
        | StateOperationV1::Retract {
            state_id,
            expected_revision,
            ..
        } => (*state_id, *expected_revision, None),
        _ => return None,
    })
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

fn only_target(operations: &[StateOperationV1]) -> Option<StateId> {
    let mut ids = operations.iter().filter_map(|operation| match operation {
        StateOperationV1::Create { state_id, .. }
        | StateOperationV1::UpdateTask { state_id, .. }
        | StateOperationV1::ReopenTask { state_id, .. }
        | StateOperationV1::UpdateDecision { state_id, .. }
        | StateOperationV1::SupersedeDecision { state_id, .. }
        | StateOperationV1::UpdateConstraint { state_id, .. }
        | StateOperationV1::ReactivateConstraint { state_id, .. }
        | StateOperationV1::UpdateNote { state_id, .. }
        | StateOperationV1::UpdateError { state_id, .. }
        | StateOperationV1::ReopenError { state_id, .. }
        | StateOperationV1::SetTier { state_id, .. }
        | StateOperationV1::Touch { state_id, .. }
        | StateOperationV1::Retract { state_id, .. } => Some(*state_id),
        StateOperationV1::SetFocus { .. } => None,
    });
    let first = ids.next()?;
    if ids.all(|id| id == first) {
        Some(first)
    } else {
        None
    }
}

fn field_limit() -> StateServiceError {
    StateServiceError::new("STATE_FIELD_LIMIT", "state field limit")
}

fn same_value_target(operation: &StateOperationV1) -> Option<(StateId, bool)> {
    match operation {
        StateOperationV1::UpdateTask {
            state_id, touch, ..
        }
        | StateOperationV1::UpdateDecision {
            state_id, touch, ..
        }
        | StateOperationV1::UpdateConstraint {
            state_id, touch, ..
        }
        | StateOperationV1::UpdateNote {
            state_id, touch, ..
        }
        | StateOperationV1::UpdateError {
            state_id, touch, ..
        }
        | StateOperationV1::SetTier {
            state_id, touch, ..
        } => Some((*state_id, *touch)),
        _ => None,
    }
}

fn object_unchanged(before: &StateGraphV1, after: &StateGraphV1, id: StateId) -> bool {
    let left = before.objects.iter().find(|object| object.state_id == id);
    let right = after.objects.iter().find(|object| object.state_id == id);
    left == right
}

fn no_change(state_id: Option<StateId>) -> StateServiceError {
    let mut error = StateServiceError::new("STATE_NO_CHANGE", "state mutation has no effect");
    if let Some(state_id) = state_id {
        error = error.with_target(state_id, None, None);
    }
    error
}

fn focus_invalid(state_id: StateId) -> StateServiceError {
    StateServiceError::new("STATE_FOCUS_INVALID", "state focus is invalid")
        .with_target(state_id, None, None)
}

fn kind_mismatch(state_id: StateId, expected: u64, actual: u64) -> StateServiceError {
    StateServiceError::new("STATE_KIND_MISMATCH", "state kind does not match").with_target(
        state_id,
        Some(expected),
        Some(actual),
    )
}

fn invalid_transition(state_id: StateId, expected: u64, actual: u64) -> StateServiceError {
    StateServiceError::new("STATE_INVALID_TRANSITION", "state transition is invalid").with_target(
        state_id,
        Some(expected),
        Some(actual),
    )
}

/// Checkpoint load reuses the same field, count, and focus rules.
pub fn validate_stored_graph(graph: &StateGraphV1) -> Result<(), StateServiceError> {
    if graph.schema_version != 1 {
        return Err(StateServiceError::new(
            "STATE_PROJECTION_INTEGRITY",
            "state projection is invalid",
        ));
    }
    let mut seen = Vec::new();
    let mut previous: Option<StateId> = None;
    for object in &graph.objects {
        if object.revision == 0 {
            return Err(StateServiceError::new(
                "STATE_PROJECTION_INTEGRITY",
                "state revision is invalid",
            ));
        }
        if seen.contains(&object.state_id) {
            return Err(StateServiceError::new(
                "STATE_DUPLICATE_ID",
                "state id already exists",
            ));
        }
        if previous.is_some_and(|previous| object.state_id <= previous) {
            return Err(StateServiceError::new(
                "STATE_PROJECTION_INTEGRITY",
                "state projection is invalid",
            ));
        }
        previous = Some(object.state_id);
        seen.push(object.state_id);
        validate_value(&object.value)?;
        if let StateValueV1::Decision(decision) = &object.value {
            if let DecisionStatus::Superseded { by_state_id } = &decision.status {
                let resolved = graph.objects.iter().any(|other| {
                    other.state_id == *by_state_id
                        && other.state_id != object.state_id
                        && matches!(other.value, StateValueV1::Decision(_))
                });
                if !resolved {
                    return Err(StateServiceError::new(
                        "STATE_PROJECTION_INTEGRITY",
                        "state projection is invalid",
                    ));
                }
            }
        }
        require_optional(object.retracted_reason.as_deref(), MEDIUM_MAX)?;
        if object.lifecycle == ObjectLifecycle::Retracted && object.retracted_reason.is_none() {
            return Err(field_limit());
        }
        if object.lifecycle == ObjectLifecycle::Current && object.retracted_reason.is_some() {
            return Err(StateServiceError::new(
                "STATE_PROJECTION_INTEGRITY",
                "state projection is invalid",
            ));
        }
    }
    enforce_end_invariants(graph)?;
    enforce_counts(graph)?;
    Ok(())
}
