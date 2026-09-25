//! Structured redaction. Keys stay unchanged. Over-depth fails closed.

use serde_json::Value;

use super::assignment::{key_is_assignment, value_is_exempt};
use super::{apply_complete, summary_for, RedactionError, RedactionSummaryV1, SecretKind};
use crate::canonical_json::to_canonical_json_bytes;

const MAX_DEPTH: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub struct RedactedJson {
    pub value: Value,
    pub summary: RedactionSummaryV1,
}

pub fn redact_json_v1(value: &Value) -> Result<RedactedJson, RedactionError> {
    let original = to_canonical_json_bytes(value).map_err(|_| RedactionError::Failed)?;
    let mut kinds = Vec::new();
    let mut count = 0u32;
    let redacted = walk(value, 0, None, &mut kinds, &mut count)?;
    let output = to_canonical_json_bytes(&redacted).map_err(|_| RedactionError::Failed)?;
    kinds.sort_by_key(|kind| kind.priority());
    kinds.dedup();
    let summary = summary_for(&original, &output, count as usize, kinds)?;
    Ok(RedactedJson {
        value: redacted,
        summary,
    })
}

fn walk(
    value: &Value,
    depth: usize,
    parent_key: Option<&str>,
    kinds: &mut Vec<SecretKind>,
    count: &mut u32,
) -> Result<Value, RedactionError> {
    if depth > MAX_DEPTH {
        return Err(RedactionError::DepthExceeded);
    }
    match value {
        Value::String(text) => {
            if let Some(key) = parent_key {
                if key_is_assignment(key) && !value_is_exempt(text) {
                    remember(SecretKind::KeyAssignment, kinds);
                    *count = count.checked_add(1).ok_or(RedactionError::Failed)?;
                    return Ok(Value::String("[REDACTED:key-assignment]".to_owned()));
                }
            }
            let redacted = apply_complete(text)?;
            for kind in &redacted.summary.kinds {
                remember(kind.clone(), kinds);
            }
            *count = count
                .checked_add(redacted.summary.replacement_count)
                .ok_or(RedactionError::Failed)?;
            Ok(Value::String(redacted.text))
        }
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(walk(item, depth + 1, None, kinds, count)?);
            }
            Ok(Value::Array(out))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            let mut out = serde_json::Map::new();
            for key in keys {
                let child = walk(&map[key], depth + 1, Some(key), kinds, count)?;
                out.insert(key.clone(), child);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other.clone()),
    }
}

fn remember(kind: SecretKind, kinds: &mut Vec<SecretKind>) {
    if !kinds.contains(&kind) {
        kinds.push(kind);
    }
}
