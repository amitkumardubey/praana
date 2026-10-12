//! Candidate structural and provenance validation (Compaction spec §8.1, §8.4, §9.2).
//!
//! Validation collects every issue in document order (segment, then handoff) so
//! the single permitted repair request can carry all of them. It proves shape
//! and that references resolve. It does not claim a statement is true.

use std::collections::BTreeSet;

use crate::compaction::schema::{
    canonical_candidate_bytes, CandidateIssue, CandidateIssueCode, CompactionCandidateV1,
};
use crate::protocol::compaction::{
    CommandOutcomeV1, CompactionOmissionV1, ContradictionV1, DecisionSummaryV1, EvidenceRefV1,
    FileChangeV1, HistoricalStatementV1, StatementConfidence, SummarySegmentV1,
};
use crate::protocol::id::{ArtifactId, EventId, StateId, SummarySegmentId};
use crate::token::{FramingProfileV1, TokenEstimationContext, TokenEstimatorV1};

/// Schema v1 safety limits (§8.4). The two token limits are config values and
/// are checked by `check_segment_tokens` and `render::check_rendered_handoff_tokens`.
pub const MAX_CANDIDATE_CANONICAL_BYTES: usize = 64 * 1024;
pub const MAX_STATEMENT_TEXT_BYTES: usize = 600;
pub const MAX_DETAIL_BYTES: usize = 800;
pub const MAX_PATH_BYTES: usize = 4096;
pub const MAX_SYMBOL_BYTES: usize = 256;
pub const MAX_ITEMS_PER_CATEGORY: usize = 64;
pub const MAX_EVIDENCE_IDS_PER_KIND: usize = 16;
pub const MAX_OMISSION_CATEGORIES: usize = 16;

/// Host-supplied records the model may cite, frozen with the compaction snapshot.
/// A reference outside the relevant set is `COMPACTION_PROVENANCE`; a valid ULID
/// from another session is simply absent from these sets.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReferenceUniverse {
    /// Events in the selected source range (§9.2 item 2).
    pub source_event_ids: BTreeSet<EventId>,
    /// Artifacts produced in the range or referenced by a selected source event (item 3).
    pub source_artifact_ids: BTreeSet<ArtifactId>,
    /// StateGraph objects that existed by the source end (item 4).
    pub source_state_ids: BTreeSet<StateId>,
    /// Immutable segments already in the lineage.
    pub prior_segment_ids: BTreeSet<SummarySegmentId>,
    /// Events in prior immutable segments' source ranges (handoff only, item 5).
    pub lineage_event_ids: BTreeSet<EventId>,
    /// Every artifact in the session (handoff only).
    pub session_artifact_ids: BTreeSet<ArtifactId>,
    /// The current StateGraph (handoff only).
    pub current_state_ids: BTreeSet<StateId>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Segment,
    Handoff,
}

impl Side {
    fn event(self, u: &ReferenceUniverse, id: &EventId) -> bool {
        match self {
            Side::Segment => u.source_event_ids.contains(id),
            Side::Handoff => u.source_event_ids.contains(id) || u.lineage_event_ids.contains(id),
        }
    }
    fn artifact(self, u: &ReferenceUniverse, id: &ArtifactId) -> bool {
        match self {
            Side::Segment => u.source_artifact_ids.contains(id),
            Side::Handoff => u.session_artifact_ids.contains(id),
        }
    }
    fn state(self, u: &ReferenceUniverse, id: &StateId) -> bool {
        match self {
            Side::Segment => u.source_state_ids.contains(id),
            Side::Handoff => u.current_state_ids.contains(id) || u.source_state_ids.contains(id),
        }
    }
}

struct Checker<'a> {
    universe: &'a ReferenceUniverse,
    side: Side,
    issues: Vec<CandidateIssue>,
}

impl Checker<'_> {
    fn schema(&mut self, path: &str, message: impl Into<String>) {
        self.issues.push(CandidateIssue::new(
            CandidateIssueCode::Schema,
            path,
            message,
        ));
    }

    fn provenance(&mut self, path: &str, message: impl Into<String>) {
        self.issues.push(CandidateIssue::new(
            CandidateIssueCode::Provenance,
            path,
            message,
        ));
    }

    fn count(&mut self, path: &str, len: usize, max: usize) {
        if len > max {
            self.schema(path, format!("{len} items, over the limit of {max}"));
        }
    }

    /// Required text: non-blank and at most `max` UTF-8 bytes.
    fn required_text(&mut self, path: &str, text: &str, max: usize) {
        if text.trim().is_empty() {
            self.schema(path, "text is required");
        }
        self.bounded(path, text, max);
    }

    fn bounded(&mut self, path: &str, text: &str, max: usize) {
        if text.len() > max {
            self.schema(
                path,
                format!("{} bytes, over the limit of {max}", text.len()),
            );
        }
    }

    fn evidence(&mut self, path: &str, e: &EvidenceRefV1) {
        let at = |kind: &str| format!("{path}.evidence.{kind}");
        for (kind, len) in [
            ("event_ids", e.event_ids.len()),
            ("artifact_ids", e.artifact_ids.len()),
            ("state_ids", e.state_ids.len()),
            ("summary_segment_ids", e.summary_segment_ids.len()),
        ] {
            self.count(&at(kind), len, MAX_EVIDENCE_IDS_PER_KIND);
        }
        let (side, u) = (self.side, self.universe);
        for (i, id) in e.event_ids.iter().enumerate() {
            if !side.event(u, id) {
                self.provenance(
                    &format!("{}[{i}]", at("event_ids")),
                    format!("event {id} is not citable here"),
                );
            }
        }
        for (i, id) in e.artifact_ids.iter().enumerate() {
            if !side.artifact(u, id) {
                self.provenance(
                    &format!("{}[{i}]", at("artifact_ids")),
                    format!("artifact {id} is not citable here"),
                );
            }
        }
        for (i, id) in e.state_ids.iter().enumerate() {
            if !side.state(u, id) {
                self.provenance(
                    &format!("{}[{i}]", at("state_ids")),
                    format!("state {id} is not citable here"),
                );
            }
        }
        for (i, id) in e.summary_segment_ids.iter().enumerate() {
            if !u.prior_segment_ids.contains(id) {
                self.provenance(
                    &format!("{}[{i}]", at("summary_segment_ids")),
                    format!("segment {id} is not in the lineage"),
                );
            }
        }
    }

    fn statements(&mut self, path: &str, items: &[HistoricalStatementV1]) {
        self.count(path, items.len(), MAX_ITEMS_PER_CATEGORY);
        for (i, s) in items.iter().enumerate() {
            let at = format!("{path}[{i}]");
            self.required_text(&format!("{at}.text"), &s.text, MAX_STATEMENT_TEXT_BYTES);
            if let Some(u) = &s.uncertainty {
                self.bounded(&format!("{at}.uncertainty"), u, MAX_DETAIL_BYTES);
            }
            let e = &s.evidence;
            if e.event_ids.is_empty()
                && e.artifact_ids.is_empty()
                && e.state_ids.is_empty()
                && e.summary_segment_ids.is_empty()
            {
                self.schema(
                    &format!("{at}.evidence"),
                    "at least one evidence id is required",
                );
            } else if s.confidence == StatementConfidence::Direct
                && e.event_ids.is_empty()
                && e.artifact_ids.is_empty()
            {
                self.schema(
                    &format!("{at}.evidence"),
                    "a direct statement needs a source event or artifact",
                );
            }
            if s.confidence != StatementConfidence::Direct
                && s.uncertainty.as_deref().is_none_or(|u| u.trim().is_empty())
            {
                self.schema(
                    &format!("{at}.uncertainty"),
                    "inferred and uncertain statements need a non-empty uncertainty",
                );
            }
            self.evidence(&at, e);
        }
    }

    fn files(&mut self, path: &str, items: &[FileChangeV1]) {
        self.count(path, items.len(), MAX_ITEMS_PER_CATEGORY);
        for (i, f) in items.iter().enumerate() {
            let at = format!("{path}[{i}]");
            self.required_text(&format!("{at}.path"), &f.path, MAX_PATH_BYTES);
            for (j, symbol) in f.symbols.iter().enumerate() {
                self.bounded(&format!("{at}.symbols[{j}]"), symbol, MAX_SYMBOL_BYTES);
            }
            self.required_text(&format!("{at}.change"), &f.change, MAX_STATEMENT_TEXT_BYTES);
            self.evidence(&at, &f.evidence);
        }
    }

    fn decisions(&mut self, path: &str, items: &[DecisionSummaryV1]) {
        self.count(path, items.len(), MAX_ITEMS_PER_CATEGORY);
        for (i, d) in items.iter().enumerate() {
            let at = format!("{path}[{i}]");
            self.required_text(
                &format!("{at}.decision"),
                &d.decision,
                MAX_STATEMENT_TEXT_BYTES,
            );
            self.bounded(&format!("{at}.rationale"), &d.rationale, MAX_DETAIL_BYTES);
            self.evidence(&at, &d.evidence);
        }
    }

    fn commands(&mut self, path: &str, items: &[CommandOutcomeV1]) {
        self.count(path, items.len(), MAX_ITEMS_PER_CATEGORY);
        for (i, c) in items.iter().enumerate() {
            let at = format!("{path}[{i}]");
            self.required_text(
                &format!("{at}.command_label"),
                &c.command_label,
                MAX_STATEMENT_TEXT_BYTES,
            );
            self.bounded(&format!("{at}.detail"), &c.detail, MAX_DETAIL_BYTES);
            self.evidence(&at, &c.evidence);
        }
    }

    fn contradictions(&mut self, path: &str, items: &[ContradictionV1]) {
        self.count(path, items.len(), MAX_ITEMS_PER_CATEGORY);
        for (i, c) in items.iter().enumerate() {
            let at = format!("{path}[{i}]");
            self.required_text(
                &format!("{at}.claim_a"),
                &c.claim_a,
                MAX_STATEMENT_TEXT_BYTES,
            );
            self.required_text(
                &format!("{at}.claim_b"),
                &c.claim_b,
                MAX_STATEMENT_TEXT_BYTES,
            );
            if let Some(resolution) = &c.resolution {
                self.bounded(&format!("{at}.resolution"), resolution, MAX_DETAIL_BYTES);
            }
            self.evidence(&at, &c.evidence);
        }
    }

    fn omissions(&mut self, path: &str, items: &[CompactionOmissionV1]) {
        self.count(path, items.len(), MAX_OMISSION_CATEGORIES);
        for (i, o) in items.iter().enumerate() {
            let at = format!("{path}[{i}]");
            self.required_text(
                &format!("{at}.category"),
                &o.category,
                MAX_STATEMENT_TEXT_BYTES,
            );
            if o.count > 0 {
                self.required_text(
                    &format!("{at}.recovery_query"),
                    &o.recovery_query,
                    MAX_STATEMENT_TEXT_BYTES,
                );
            } else {
                self.bounded(
                    &format!("{at}.recovery_query"),
                    &o.recovery_query,
                    MAX_STATEMENT_TEXT_BYTES,
                );
            }
        }
    }
}

/// Validates a parsed candidate against §8.1, §8.4 and §9.2 items 1-7. Returns
/// every issue found; `Ok` means the candidate is structurally and referentially sound.
pub fn validate_candidate(
    candidate: &CompactionCandidateV1,
    universe: &ReferenceUniverse,
) -> Result<(), Vec<CandidateIssue>> {
    let mut issues = Vec::new();

    match canonical_candidate_bytes(candidate) {
        Ok(bytes) if bytes.len() > MAX_CANDIDATE_CANONICAL_BYTES => {
            issues.push(CandidateIssue::new(
                CandidateIssueCode::Schema,
                "candidate",
                format!(
                    "canonical candidate is {} bytes, over the {} byte limit",
                    bytes.len(),
                    MAX_CANDIDATE_CANONICAL_BYTES
                ),
            ))
        }
        Ok(_) => {}
        Err(issue) => issues.push(issue),
    }

    let s = &candidate.segment;
    let mut seg = Checker {
        universe,
        side: Side::Segment,
        issues: Vec::new(),
    };
    seg.statements("segment.user_goals", &s.user_goals);
    seg.statements("segment.scope_changes", &s.scope_changes);
    seg.statements("segment.completed_work", &s.completed_work);
    seg.files(
        "segment.files_and_symbols_changed",
        &s.files_and_symbols_changed,
    );
    seg.decisions("segment.decisions", &s.decisions);
    seg.statements("segment.constraints", &s.constraints);
    seg.commands("segment.commands_and_tests", &s.commands_and_tests);
    seg.statements("segment.failed_approaches", &s.failed_approaches);
    seg.statements("segment.unresolved_errors", &s.unresolved_errors);
    seg.statements("segment.unresolved_questions", &s.unresolved_questions);
    seg.contradictions("segment.contradictions", &s.contradictions);
    seg.omissions("segment.omissions", &s.omissions);
    issues.extend(seg.issues);

    let h = &candidate.handoff;
    let mut hand = Checker {
        universe,
        side: Side::Handoff,
        issues: Vec::new(),
    };
    hand.statements("handoff.current_goals", &h.current_goals);
    hand.statements("handoff.completed_milestones", &h.completed_milestones);
    hand.decisions("handoff.active_decisions", &h.active_decisions);
    hand.statements("handoff.active_constraints", &h.active_constraints);
    hand.files("handoff.files_in_play", &h.files_in_play);
    hand.commands("handoff.test_status", &h.test_status);
    hand.statements("handoff.unresolved_errors", &h.unresolved_errors);
    hand.statements("handoff.open_questions", &h.open_questions);
    hand.statements(
        "handoff.failed_approaches_to_avoid",
        &h.failed_approaches_to_avoid,
    );
    hand.statements("handoff.next_actions", &h.next_actions);
    hand.omissions("handoff.omissions", &h.omissions);
    issues.extend(hand.issues);

    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

/// Enforces `history.summary_segment_max_tokens` on a finalized segment. The
/// estimate covers the segment's RFC 8785 canonical JSON under the
/// `CompactionSegment` context. Returns the estimated tokens.
pub fn check_segment_tokens(
    segment: &SummarySegmentV1,
    estimator: &dyn TokenEstimatorV1,
    framing: &FramingProfileV1,
    max_tokens: u64,
) -> Result<u64, CandidateIssue> {
    let issue =
        |message: String| CandidateIssue::new(CandidateIssueCode::Schema, "segment", message);
    let bytes = crate::canonical_json::to_canonical_json_bytes(segment)
        .map_err(|e| issue(format!("segment cannot be serialized: {e}")))?;
    let estimate = estimator
        .estimate(TokenEstimationContext::CompactionSegment, &bytes, framing)
        .map_err(|e| issue(format!("segment cannot be estimated: {e}")))?;
    if estimate.total_tokens > max_tokens {
        return Err(issue(format!(
            "segment is {} tokens, over the {} token bound",
            estimate.total_tokens, max_tokens
        )));
    }
    Ok(estimate.total_tokens)
}
