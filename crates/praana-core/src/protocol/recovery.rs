//! Protocol recovery notices and kinds.

use serde::{Deserialize, Serialize};

use crate::protocol::id::{EventId, RecoveryNoticeId};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum RecoveryKind {
    AttemptLost,
    ToolSideEffectUncertain,
    ToolResultRecovered,
    TurnInterrupted,
    TruncatedLogTail,
    ModelChanged,
    /// The derived history database could not be rebuilt at resume; the
    /// session continues with the durable log as authority.
    HistoryProjectionFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryNotice {
    pub notice_id: RecoveryNoticeId,
    pub kind: RecoveryKind,
    pub source_event_ids: Vec<EventId>,
    pub message: String,
    pub required_action: String,
}
