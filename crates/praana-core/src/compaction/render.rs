//! Deterministic handoff rendering and its token bound (Compaction spec §10).
//!
//! The renderer itself lives in `protocol::compaction` because Protocol §14.3
//! uses the same bytes for the `model_changed` notice and History already
//! projects them. It is re-exported here so compaction has one import path and
//! cannot grow a second copy of the byte layout.

pub use crate::protocol::compaction::render_historical_handoff;

use crate::compaction::schema::{CandidateIssue, CandidateIssueCode};
use crate::protocol::compaction::HistoricalHandoffV1;
use crate::token::{FramingProfileV1, TokenEstimateV1, TokenEstimationContext, TokenEstimatorV1};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderedHandoff {
    pub rendered: String,
    pub estimate: TokenEstimateV1,
}

/// Renders `handoff` and enforces `history.handoff_max_tokens` against the
/// estimate of the rendered bytes, not the raw candidate JSON (§8.4). The core
/// never truncates a string to make a handoff fit; an over-bound handoff is a
/// validation issue for the repair path.
pub fn check_rendered_handoff_tokens(
    handoff: &HistoricalHandoffV1,
    estimator: &dyn TokenEstimatorV1,
    framing: &FramingProfileV1,
    max_tokens: u64,
) -> Result<RenderedHandoff, CandidateIssue> {
    let issue =
        |message: String| CandidateIssue::new(CandidateIssueCode::Schema, "handoff", message);
    let rendered = render_historical_handoff(handoff)
        .map_err(|e| issue(format!("handoff cannot be rendered: {}", e.code())))?;
    let estimate = estimator
        .estimate(
            TokenEstimationContext::HistoricalHandoff,
            rendered.as_bytes(),
            framing,
        )
        .map_err(|e| issue(format!("handoff cannot be estimated: {e}")))?;
    if estimate.total_tokens > max_tokens {
        return Err(issue(format!(
            "rendered handoff is {} tokens, over the {} token bound",
            estimate.total_tokens, max_tokens
        )));
    }
    Ok(RenderedHandoff { rendered, estimate })
}
