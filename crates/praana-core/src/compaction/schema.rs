//! Compaction candidate type and strict parsing (Compaction spec §8 and §9).
//!
//! The model returns semantic content and evidence references only. Core owns
//! every ID, source range, hash, epoch, version, and token count, so any such
//! field in the output is an unknown field and fails the schema.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::canonical_json::to_canonical_json_bytes;
use crate::protocol::compaction::{HistoricalHandoffContentV1, SummarySegmentContentV1};
use crate::protocol::id::Sha256Digest;
use crate::protocol::json::check_raw_duplicate_keys_with_max_depth;

/// Maximum JSON nesting depth in a candidate (§8).
pub const MAX_CANDIDATE_JSON_DEPTH: usize = 16;
/// Guard against scanning an unbounded provider response. The 64 KiB bound in
/// §8.4 applies to canonical JSON and is enforced by `validate_candidate`.
pub const MAX_RAW_CANDIDATE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CompactionCandidateV1 {
    pub segment: SummarySegmentContentV1,
    pub handoff: HistoricalHandoffContentV1,
}

/// Which §21 code a candidate failure maps to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateIssueCode {
    /// `COMPACTION_PARSE`: not strict candidate JSON.
    Parse,
    /// `COMPACTION_SCHEMA`: structure or bounds invalid.
    Schema,
    /// `COMPACTION_PROVENANCE`: evidence references invalid.
    Provenance,
}

impl CandidateIssueCode {
    pub fn code(self) -> &'static str {
        match self {
            Self::Parse => "COMPACTION_PARSE",
            Self::Schema => "COMPACTION_SCHEMA",
            Self::Provenance => "COMPACTION_PROVENANCE",
        }
    }
}

/// One validation failure. The repair request carries these and the candidate
/// hash, so `path` is stable and human-readable (`segment.user_goals[0].text`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateIssue {
    pub code: CandidateIssueCode,
    pub path: String,
    pub message: String,
}

impl CandidateIssue {
    pub fn new(
        code: CandidateIssueCode,
        path: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            path: path.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CandidateIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at {}: {}", self.code.code(), self.path, self.message)
    }
}

impl std::error::Error for CandidateIssue {}

/// Statement lists whose `uncertainty` is a required key (null when absent).
const SEGMENT_STATEMENT_LISTS: [&str; 7] = [
    "user_goals",
    "scope_changes",
    "completed_work",
    "constraints",
    "failed_approaches",
    "unresolved_errors",
    "unresolved_questions",
];
const HANDOFF_STATEMENT_LISTS: [&str; 7] = [
    "current_goals",
    "completed_milestones",
    "active_constraints",
    "unresolved_errors",
    "open_questions",
    "failed_approaches_to_avoid",
    "next_actions",
];

/// Parses a provider response into a candidate under the §8 rules: valid UTF-8
/// without NUL, no duplicate keys, nesting at most 16, exact key set, and no
/// omitted `Option` key.
pub fn parse_candidate(raw: &[u8]) -> Result<CompactionCandidateV1, CandidateIssue> {
    let parse =
        |message: &str| CandidateIssue::new(CandidateIssueCode::Parse, "candidate", message);
    if raw.len() > MAX_RAW_CANDIDATE_BYTES {
        return Err(parse("response exceeds the raw size guard"));
    }
    if raw.contains(&0) {
        return Err(parse("response contains NUL"));
    }
    let text = std::str::from_utf8(raw).map_err(|_| parse("response is not valid UTF-8"))?;
    check_raw_duplicate_keys_with_max_depth(text, MAX_CANDIDATE_JSON_DEPTH)
        .map_err(|_| parse("duplicate key, malformed JSON, or nesting over 16"))?;
    let value: Value =
        serde_json::from_str(text).map_err(|e| parse(&format!("malformed JSON: {e}")))?;
    if let Some(path) = find_nul_string(&value, "candidate") {
        return Err(CandidateIssue::new(
            CandidateIssueCode::Parse,
            path,
            "string contains NUL",
        ));
    }
    require_option_keys(&value)?;
    serde_json::from_value(value)
        .map_err(|e| CandidateIssue::new(CandidateIssueCode::Schema, "candidate", e.to_string()))
}

fn find_nul_string(value: &Value, path: &str) -> Option<String> {
    match value {
        Value::String(s) if s.contains('\0') => Some(path.to_owned()),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .find_map(|(i, v)| find_nul_string(v, &format!("{path}[{i}]"))),
        Value::Object(map) => map.iter().find_map(|(k, v)| {
            if k.contains('\0') {
                Some(format!("{path}.{k}"))
            } else {
                find_nul_string(v, &format!("{path}.{k}"))
            }
        }),
        _ => None,
    }
}

/// Serde reads a missing `Option` as `None`, so the spec's "required keys that
/// serialize as null" needs this pre-Serde check (§8).
fn require_option_keys(value: &Value) -> Result<(), CandidateIssue> {
    let missing = |path: String, key: &str| {
        CandidateIssue::new(
            CandidateIssueCode::Schema,
            path,
            format!("required key `{key}` is missing (use null)"),
        )
    };
    for (side, lists) in [
        ("segment", &SEGMENT_STATEMENT_LISTS),
        ("handoff", &HANDOFF_STATEMENT_LISTS),
    ] {
        let Some(section) = value.get(side).and_then(Value::as_object) else {
            continue;
        };
        for list in lists.iter() {
            let Some(items) = section.get(*list).and_then(Value::as_array) else {
                continue;
            };
            for (i, item) in items.iter().enumerate() {
                if let Some(obj) = item.as_object() {
                    if !obj.contains_key("uncertainty") {
                        return Err(missing(format!("{side}.{list}[{i}]"), "uncertainty"));
                    }
                }
            }
        }
    }
    if let Some(items) = value
        .get("segment")
        .and_then(|s| s.get("contradictions"))
        .and_then(Value::as_array)
    {
        for (i, item) in items.iter().enumerate() {
            if let Some(obj) = item.as_object() {
                if !obj.contains_key("resolution") {
                    return Err(missing(
                        format!("segment.contradictions[{i}]"),
                        "resolution",
                    ));
                }
            }
        }
    }
    Ok(())
}

/// RFC 8785 canonical bytes. The 64 KiB bound and `candidate_hash` use these.
pub fn canonical_candidate_bytes(
    candidate: &CompactionCandidateV1,
) -> Result<Vec<u8>, CandidateIssue> {
    to_canonical_json_bytes(candidate)
        .map_err(|e| CandidateIssue::new(CandidateIssueCode::Schema, "candidate", e.to_string()))
}

/// SHA-256 over the canonical candidate bytes: `HistoryCompactedV1.candidate_hash`.
pub fn candidate_hash(candidate: &CompactionCandidateV1) -> Result<Sha256Digest, CandidateIssue> {
    let bytes = canonical_candidate_bytes(candidate)?;
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    Ok(Sha256Digest::from_bytes(digest))
}

/// JSON Schema for the provider's strict structured output. The checked-in
/// copy is `schemas/compaction_candidate_v1.schema.json`.
pub fn candidate_json_schema() -> Value {
    serde_json::to_value(schemars::schema_for!(CompactionCandidateV1))
        .expect("candidate schema serializes")
}
