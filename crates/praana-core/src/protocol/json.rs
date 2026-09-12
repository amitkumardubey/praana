//! Strict JSON serialization and deserialization with duplicate key and bound checking.

use serde::{de, de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use std::collections::HashSet;

use crate::canonical_json::{to_canonical_json_bytes, to_canonical_json_string};
use crate::protocol::constants::*;
use crate::protocol::errors::HistoryError;

/// Serializes any protocol value into RFC 8785 canonical JSON bytes.
pub fn serialize_canonical<T: Serialize>(value: &T) -> Result<Vec<u8>, HistoryError> {
    to_canonical_json_bytes(value)
        .map_err(|_| HistoryError::new("E_EVENT_SCHEMA_INVALID", None, None, false))
}

/// Serializes any protocol value into RFC 8785 canonical JSON string.
pub fn serialize_canonical_string<T: Serialize>(value: &T) -> Result<String, HistoryError> {
    to_canonical_json_string(value)
        .map_err(|_| HistoryError::new("E_EVENT_SCHEMA_INVALID", None, None, false))
}

/// Serializes an event envelope to compact JSON with explicit nulls.
pub fn serialize_event_compact<T: Serialize>(value: &T) -> Result<String, HistoryError> {
    let json = serde_json::to_string(value)
        .map_err(|_| HistoryError::new("E_EVENT_SCHEMA_INVALID", None, None, false))?;
    if json.len() > MAX_EVENT_LINE_BYTES {
        return Err(HistoryError::new("E_EVENT_TOO_LARGE", None, None, false));
    }
    Ok(json)
}

/// Deserializes JSON string with strict checks:
/// 1. Maximum string length <= 16 MiB.
/// 2. No duplicate keys in any JSON object.
/// 3. Maximum nesting depth <= 64.
/// 4. Deserialization into T denying unknown fields.
pub fn deserialize_event_strict<T: DeserializeOwned>(json_str: &str) -> Result<T, HistoryError> {
    if json_str.len() > MAX_EVENT_LINE_BYTES {
        return Err(HistoryError::new("E_EVENT_TOO_LARGE", None, None, false));
    }
    check_raw_duplicate_keys_and_depth(json_str)?;

    let raw_val: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|_| HistoryError::new("E_EVENT_SCHEMA_INVALID", None, None, false))?;

    if let Some(n) = raw_val
        .get("schema_version")
        .and_then(|value| value.as_u64())
    {
        if n != EVENT_SCHEMA_VERSION as u64 {
            return Err(HistoryError::new(
                "E_SCHEMA_VERSION_UNSUPPORTED",
                None,
                None,
                false,
            ));
        }
    }

    let val: T = serde_json::from_value(raw_val).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("E_TOOL_CALL_ID_MISSING") {
            HistoryError::new("E_TOOL_CALL_ID_MISSING", None, None, false)
        } else {
            HistoryError::new("E_EVENT_SCHEMA_INVALID", None, None, false)
        }
    })?;
    Ok(val)
}

pub fn deserialize_bounded_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u64::deserialize(deserializer)?;
    if value > MAX_JSON_INTEGER {
        return Err(de::Error::custom("E_EVENT_SCHEMA_INVALID"));
    }
    Ok(value)
}

pub use deserialize_bounded_u64 as deserialize_sequence;

pub fn deserialize_optional_bounded_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<u64>::deserialize(deserializer)?;
    if value.is_some_and(|number| number > MAX_JSON_INTEGER) {
        return Err(de::Error::custom("E_EVENT_SCHEMA_INVALID"));
    }
    Ok(value)
}

pub fn deserialize_timestamp<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = i64::deserialize(deserializer)?;
    if !(MIN_JSON_TIMESTAMP_MS..=MAX_JSON_TIMESTAMP_MS).contains(&value) {
        return Err(de::Error::custom("E_EVENT_SCHEMA_INVALID"));
    }
    Ok(value)
}

enum Container {
    Object {
        keys: HashSet<String>,
        expecting_key: bool,
    },
    Array,
}

fn check_raw_duplicate_keys_and_depth(json_str: &str) -> Result<(), HistoryError> {
    let bytes = json_str.as_bytes();
    let mut i = 0;
    let len = bytes.len();
    let mut stack: Vec<Container> = Vec::new();

    while i < len {
        let b = bytes[i];
        match b {
            b' ' | b'\t' | b'\n' | b'\r' => {
                i += 1;
            }
            b'{' => {
                if stack.len() >= MAX_JSON_DEPTH {
                    return Err(HistoryError::new(
                        "E_EVENT_SCHEMA_INVALID",
                        None,
                        None,
                        false,
                    ));
                }
                stack.push(Container::Object {
                    keys: HashSet::new(),
                    expecting_key: true,
                });
                i += 1;
            }
            b'}' => {
                match stack.pop() {
                    Some(Container::Object { .. }) => {}
                    _ => {
                        return Err(HistoryError::new(
                            "E_EVENT_SCHEMA_INVALID",
                            None,
                            None,
                            false,
                        ))
                    }
                }
                i += 1;
            }
            b'[' => {
                if stack.len() >= MAX_JSON_DEPTH {
                    return Err(HistoryError::new(
                        "E_EVENT_SCHEMA_INVALID",
                        None,
                        None,
                        false,
                    ));
                }
                stack.push(Container::Array);
                i += 1;
            }
            b']' => {
                match stack.pop() {
                    Some(Container::Array) => {}
                    _ => {
                        return Err(HistoryError::new(
                            "E_EVENT_SCHEMA_INVALID",
                            None,
                            None,
                            false,
                        ))
                    }
                }
                i += 1;
            }
            b',' => {
                if let Some(Container::Object {
                    ref mut expecting_key,
                    ..
                }) = stack.last_mut()
                {
                    *expecting_key = true;
                }
                i += 1;
            }
            b':' => {
                if let Some(Container::Object {
                    ref mut expecting_key,
                    ..
                }) = stack.last_mut()
                {
                    *expecting_key = false;
                }
                i += 1;
            }
            b'"' => {
                // Parse string
                i += 1;
                let start = i;
                let mut is_escaped = false;
                let mut string_val: Option<String> = None;
                let mut has_escapes = false;
                let mut closed = false;

                while i < len {
                    let sb = bytes[i];
                    if is_escaped {
                        is_escaped = false;
                        i += 1;
                    } else if sb == b'\\' {
                        is_escaped = true;
                        has_escapes = true;
                        i += 1;
                    } else if sb == b'"' {
                        let raw = &json_str[start..i];
                        if has_escapes {
                            let quoted = format!("\"{}\"", raw);
                            let parsed: String = serde_json::from_str(&quoted).map_err(|_| {
                                HistoryError::new("E_EVENT_SCHEMA_INVALID", None, None, false)
                            })?;
                            string_val = Some(parsed);
                        } else {
                            string_val = Some(raw.to_string());
                        }
                        closed = true;
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }

                if !closed {
                    return Err(HistoryError::new(
                        "E_EVENT_SCHEMA_INVALID",
                        None,
                        None,
                        false,
                    ));
                }

                if let Some(Container::Object {
                    ref mut keys,
                    expecting_key,
                }) = stack.last_mut()
                {
                    if *expecting_key {
                        if let Some(k) = string_val {
                            if !keys.insert(k) {
                                return Err(HistoryError::new(
                                    "E_EVENT_SCHEMA_INVALID",
                                    None,
                                    None,
                                    false,
                                ));
                            }
                        }
                    }
                }
            }
            _ => {
                i += 1;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::check_raw_duplicate_keys_and_depth;

    fn nested_arrays(depth: usize) -> String {
        format!("{}null{}", "[".repeat(depth), "]".repeat(depth))
    }

    #[test]
    fn json_nesting_depth_64_is_accepted() {
        check_raw_duplicate_keys_and_depth(&nested_arrays(64)).unwrap();
    }

    #[test]
    fn json_nesting_depth_65_is_rejected() {
        let err = check_raw_duplicate_keys_and_depth(&nested_arrays(65)).unwrap_err();
        assert_eq!(err.code(), "E_EVENT_SCHEMA_INVALID");
    }
}
