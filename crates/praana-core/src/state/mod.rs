//! StateGraph v1 projection, checkpoint, and tool service (P4B-1).

mod apply;
mod checkpoint;
pub mod hydrate;
mod list;
pub mod render;
mod replay;
mod service;

pub use hydrate::{
    fixed_overlap_score, is_identifier_token, object_text, score_candidate,
    select_auto_hydrate_candidates, tokenize, trim_ascii_whitespace, HydrateCandidate, STOP_WORDS,
};

pub use apply::{apply_state_changed, validate_stored_graph};
#[cfg(feature = "failpoints")]
pub use checkpoint::fail_next_state_checkpoint;
pub use checkpoint::{
    load_checkpoint, write_checkpoint, CheckpointFault, StateGraphCheckpointV1,
    STATE_CHECKPOINT_NAME,
};
pub use list::{
    ListQuery, StateListCursorV1, StateListItemDto, StateListToolOutput, StateStatusFilter,
};
pub use render::{
    estimate_object_line, estimate_tail, largest_object_line, render_object_line,
    render_state_tail, sorted_active_objects, zero_framing,
};
pub use replay::{
    project_logged_event, replay_state, replay_state_from_checkpoint, state_search_rows,
    state_source_id, StateSearchRow,
};
#[cfg(feature = "failpoints")]
pub use service::fail_next_state_redaction;
#[cfg(feature = "failpoints")]
pub use service::{inject_commit_origin_error, reset_commit_origin_injection};
pub use service::{
    StateMutationObjectDto, StateMutationToolOutput, StateObjectToolOutput, StateObjectViewDto,
    StateService, StateWriteContext,
};

use crate::protocol::id::StateId;
use crate::tools::error::{ToolError, ToolErrorCode};

/// StateGraph section 11 service failure. Tool details are exactly the four keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateServiceError {
    pub state_code: String,
    pub message: String,
    pub state_id: Option<StateId>,
    pub expected_revision: Option<u64>,
    pub actual_revision: Option<u64>,
}

impl StateServiceError {
    pub fn new(code: &'static str, message: &'static str) -> Self {
        Self {
            state_code: code.to_owned(),
            message: message.to_owned(),
            state_id: None,
            expected_revision: None,
            actual_revision: None,
        }
    }

    pub fn with_target(
        mut self,
        state_id: StateId,
        expected_revision: Option<u64>,
        actual_revision: Option<u64>,
    ) -> Self {
        self.state_id = Some(state_id);
        self.expected_revision = expected_revision;
        self.actual_revision = actual_revision;
        self
    }

    pub fn details_json(&self) -> serde_json::Value {
        serde_json::json!({
            "actual_revision": self.actual_revision,
            "expected_revision": self.expected_revision,
            "state_code": self.state_code,
            "state_id": self.state_id.as_ref().map(ToString::to_string),
        })
    }

    pub fn to_tool_error(&self) -> ToolError {
        ToolError::new(outer_tool_code(&self.state_code), self.message.clone())
            .with_details(self.details_json())
    }
}

pub fn outer_tool_code(state_code: &str) -> ToolErrorCode {
    match state_code {
        "STATE_CANCELLED" => ToolErrorCode::ToolCancelled,
        "STATE_PERSISTENCE" | "STATE_PROJECTION_INTEGRITY" => ToolErrorCode::ToolInternal,
        "STATE_NOT_FOUND"
        | "STATE_RETRACTED"
        | "STATE_KIND_MISMATCH"
        | "STATE_INVALID_TRANSITION"
        | "STATE_INVALID_SOURCE"
        | "STATE_DUPLICATE_ID"
        | "STATE_NO_CHANGE"
        | "STATE_FOCUS_INVALID"
        | "STATE_FIELD_LIMIT"
        | "STATE_OBJECT_LIMIT"
        | "STATE_REVISION_CONFLICT"
        | "STATE_GRAPH_SEQUENCE_CONFLICT"
        | "STATE_CURSOR_STALE"
        | "STATE_ACTIVE_BUDGET_EXCEEDED" => ToolErrorCode::ToolValidationFailed,
        _ => ToolErrorCode::ToolInternal,
    }
}
