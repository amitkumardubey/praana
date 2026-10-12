//! Compaction candidate type and strict parsing (Compaction spec §8 and §9).
//!
//! The model returns semantic content and evidence references only. Core owns
//! every ID, source range, hash, epoch, version, and token count, so any such
//! field in the output is an unknown field and fails the schema.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

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
    check_shape(&value, candidate_json_schema(), "")?;
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

/// Recursively checks `value` against the normalized schema before Serde runs.
///
/// Serde accepts a positional array for a derived struct and reads an omitted
/// `Option` key as `None`, so deserializing alone would admit `[segment, handoff]`
/// and omitted null keys. This pins JSON types, exact key sets (required keys
/// present, no extras), enum members, and array item shapes at every level.
fn check_shape(value: &Value, schema: &Value, path: &str) -> Result<(), CandidateIssue> {
    let at = |p: &str| {
        if p.is_empty() {
            "candidate".to_owned()
        } else {
            p.to_owned()
        }
    };
    let fail = |message: String| {
        Err(CandidateIssue::new(
            CandidateIssueCode::Schema,
            at(path),
            message,
        ))
    };

    if let Some(types) = schema.get("type") {
        let allowed: Vec<&str> = match types {
            Value::String(t) => vec![t.as_str()],
            Value::Array(ts) => ts.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !allowed.is_empty() && !allowed.iter().any(|t| json_type_is(value, t)) {
            return fail(format!(
                "expected {}, found {}",
                allowed.join(" or "),
                json_kind(value)
            ));
        }
    }
    if let Some(Value::Array(members)) = schema.get("enum") {
        if !members.contains(value) {
            return fail("value is not an allowed enum member".to_owned());
        }
    }
    match value {
        Value::Object(map) => {
            let props = schema.get("properties").and_then(Value::as_object);
            if let Some(Value::Array(required)) = schema.get("required") {
                for key in required.iter().filter_map(Value::as_str) {
                    if !map.contains_key(key) {
                        return fail(format!(
                            "required key `{key}` is missing (use null where allowed)"
                        ));
                    }
                }
            }
            let closed = schema.get("additionalProperties") == Some(&Value::Bool(false));
            for (key, child) in map {
                match props.and_then(|p| p.get(key)) {
                    Some(child_schema) => {
                        let child_path = if path.is_empty() {
                            key.clone()
                        } else {
                            format!("{path}.{key}")
                        };
                        check_shape(child, child_schema, &child_path)?;
                    }
                    None if closed => return fail(format!("unknown field `{key}`")),
                    None => {}
                }
            }
        }
        Value::Array(items) => {
            if let Some(item_schema) = schema.get("items") {
                for (i, item) in items.iter().enumerate() {
                    check_shape(item, item_schema, &format!("{path}[{i}]"))?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn json_type_is(value: &Value, name: &str) -> bool {
    match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "integer" => value.as_u64().is_some() || value.as_i64().is_some(),
        "number" => value.is_number(),
        _ => false,
    }
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
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

/// `output_schema_id` in the compactor control payload (§7.4).
pub const CANDIDATE_OUTPUT_SCHEMA_ID: &str = "praana.compaction_candidate.v1";

/// The provider-facing JSON Schema, normalized per Compaction §7.4: Draft
/// 2020-12, local `$defs` recursively inlined, `title` removed,
/// `additionalProperties: false` on every object, and each `required` array
/// sorted by ASCII bytes. Object-key order is fixed later by RFC 8785.
pub fn candidate_json_schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        let raw = serde_json::to_value(schemars::schema_for!(CompactionCandidateV1))
            .expect("candidate schema serializes");
        let defs = raw
            .get("$defs")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut root = inline_schema(&raw, &defs, 0);
        if let Some(map) = root.as_object_mut() {
            map.remove("$defs");
        }
        normalize_objects(&mut root);
        root
    })
}

/// RFC 8785 bytes of the normalized schema, with no trailing LF. These are the
/// checked-in file bytes and the input to `output_schema_sha256`.
pub fn candidate_schema_bytes() -> Vec<u8> {
    to_canonical_json_bytes(candidate_json_schema()).expect("candidate schema canonicalizes")
}

/// `output_schema_sha256` (§7.4).
pub fn candidate_schema_sha256() -> Sha256Digest {
    let digest: [u8; 32] = Sha256::digest(candidate_schema_bytes()).into();
    Sha256Digest::from_bytes(digest)
}

/// Candidate types are not recursive; this bound only guards a future change.
const MAX_INLINE_DEPTH: usize = 64;

fn inline_schema(node: &Value, defs: &Map<String, Value>, depth: usize) -> Value {
    assert!(depth < MAX_INLINE_DEPTH, "recursive candidate schema");
    match node {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| inline_schema(v, defs, depth + 1))
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = Map::new();
            if let Some(Value::String(reference)) = map.get("$ref") {
                let name = reference
                    .strip_prefix("#/$defs/")
                    .unwrap_or_else(|| panic!("non-local $ref {reference}"));
                let target = defs
                    .get(name)
                    .unwrap_or_else(|| panic!("dangling $ref {reference}"));
                if let Value::Object(resolved) = inline_schema(target, defs, depth + 1) {
                    out = resolved;
                }
            }
            for (key, value) in map {
                match key.as_str() {
                    "$ref" | "title" => {}
                    // A map of property name -> schema: names are data, not keywords.
                    "properties" => {
                        let props = value.as_object().map(|props| {
                            props
                                .iter()
                                .map(|(name, schema)| {
                                    (name.clone(), inline_schema(schema, defs, depth + 1))
                                })
                                .collect::<Map<_, _>>()
                        });
                        out.insert(
                            key.clone(),
                            props.map_or_else(|| value.clone(), Value::Object),
                        );
                    }
                    _ => {
                        out.insert(key.clone(), inline_schema(value, defs, depth + 1));
                    }
                }
            }
            out.remove("title");
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn normalize_objects(node: &mut Value) {
    match node {
        Value::Array(items) => items.iter_mut().for_each(normalize_objects),
        Value::Object(map) => {
            if map.get("type") == Some(&Value::String("object".to_owned())) {
                map.insert("additionalProperties".to_owned(), Value::Bool(false));
            }
            if let Some(Value::Array(required)) = map.get_mut("required") {
                required.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
            }
            for (key, child) in map.iter_mut() {
                if key == "properties" {
                    if let Value::Object(props) = child {
                        props.values_mut().for_each(normalize_objects);
                    }
                } else {
                    normalize_objects(child);
                }
            }
        }
        _ => {}
    }
}
