//! Leaf DTOs: JSON data, digests, provider/model/tool identifiers.
//!
//! No UI-contract field uses `serde_json::Value`; [`JsonData`] is the only
//! generic JSON carrier.

use serde::{de, Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

/// Interoperable JSON integer range (2^53 - 1).
pub const MAX_JSON_INTEGER: i64 = 9_007_199_254_740_991;
pub const MIN_JSON_INTEGER: i64 = -9_007_199_254_740_991;

/// Generic JSON carrier in the exact tagged form. Untagged objects are
/// rejected: known structures never use `serde_json::Value`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum JsonData {
    Null,
    Bool(bool),
    Integer(i64),
    Unsigned(u64),
    String(String),
    Array(Vec<JsonData>),
    Object(BTreeMap<String, JsonData>),
}

impl<'de> Deserialize<'de> for JsonData {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(tag = "type", content = "data", rename_all = "snake_case")]
        enum Raw {
            Null,
            Bool(bool),
            Integer(i64),
            Unsigned(u64),
            String(String),
            Array(Vec<JsonData>),
            Object(BTreeMap<String, JsonData>),
        }
        let raw = Raw::deserialize(deserializer)?;
        let value = match raw {
            Raw::Null => JsonData::Null,
            Raw::Bool(b) => JsonData::Bool(b),
            Raw::Integer(i) => JsonData::Integer(i),
            Raw::Unsigned(u) => JsonData::Unsigned(u),
            Raw::String(s) => JsonData::String(s),
            Raw::Array(items) => JsonData::Array(items),
            Raw::Object(map) => JsonData::Object(map),
        };
        value.validate().map_err(de::Error::custom)?;
        Ok(value)
    }
}

impl JsonData {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            JsonData::Null | JsonData::Bool(_) => Ok(()),
            JsonData::Integer(v) => {
                if !(MIN_JSON_INTEGER..=MAX_JSON_INTEGER).contains(v) {
                    return Err(format!("integer out of interoperable range: {v}"));
                }
                Ok(())
            }
            JsonData::Unsigned(v) => {
                if !(0..=MAX_JSON_INTEGER as u64).contains(v) {
                    return Err(format!("unsigned out of interoperable range: {v}"));
                }
                Ok(())
            }
            JsonData::String(s) => {
                if s.contains('\0') {
                    return Err("string contains NUL".to_string());
                }
                Ok(())
            }
            JsonData::Array(items) => items.iter().try_for_each(|i| i.validate()),
            JsonData::Object(map) => {
                for (k, v) in map {
                    if k.contains('\0') {
                        return Err("object key contains NUL".to_string());
                    }
                    v.validate()?;
                }
                Ok(())
            }
        }
    }
}

/// SHA-256 digest: exactly 64 lowercase hexadecimal characters.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(pub String);

impl Sha256Digest {
    pub fn from_hex_str(s: &str) -> Result<Self, String> {
        if s.len() != 64 {
            return Err(format!("invalid SHA-256 length {}: expected 64", s.len()));
        }
        if !s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err("invalid SHA-256: expected 64 lowercase hex".to_string());
        }
        Ok(Self(s.to_string()))
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        let mut s = String::with_capacity(64);
        for b in bytes {
            s.push(hex_char(b >> 4));
            s.push(hex_char(b & 0x0F));
        }
        Self(s)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn hex_char(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'a' + nibble - 10) as char,
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sha256Digest({})", self.0)
    }
}

impl FromStr for Sha256Digest {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_hex_str(s)
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Self::from_hex_str(&s).map_err(de::Error::custom)
    }
}

macro_rules! define_label {
    ($name:ident, $min:expr, $max:expr) => {
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn from_canonical_str(s: &str) -> Result<Self, String> {
                let len = s.len();
                if !($min..=$max).contains(&len) {
                    return Err(format!(
                        "invalid {} length {len}: expected {} through {} bytes",
                        stringify!($name),
                        $min,
                        $max
                    ));
                }
                Ok(Self(s.to_string()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.0)
            }
        }

        impl FromStr for $name {
            type Err = String;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::from_canonical_str(s)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let s = String::deserialize(deserializer)?;
                Self::from_canonical_str(&s).map_err(de::Error::custom)
            }
        }
    };
}

define_label!(ProviderId, 1, 256);
define_label!(ModelId, 1, 256);

/// Tool name following the Tool Runtime grammar (shared with the protocol
/// validator): 1 through 64 bytes, lowercase start, lowercase/digit/`_`.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ToolName(pub String);

impl ToolName {
    pub fn from_canonical_str(s: &str) -> Result<Self, String> {
        let bytes = s.as_bytes();
        if bytes.is_empty() || bytes.len() > 64 {
            return Err(format!("invalid tool name length {}", bytes.len()));
        }
        if !bytes[0].is_ascii_lowercase() {
            return Err(format!("invalid tool name start: {s:?}"));
        }
        if !bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
        {
            return Err(format!("invalid tool name characters: {s:?}"));
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for ToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ToolName({})", self.0)
    }
}

impl FromStr for ToolName {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_canonical_str(s)
    }
}

impl<'de> Deserialize<'de> for ToolName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Self::from_canonical_str(&s).map_err(de::Error::custom)
    }
}

/// Provider-owned opaque tool call ID: 1 through 256 bytes, no ASCII control.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ToolCallId(pub String);

impl ToolCallId {
    pub fn from_canonical_str(s: &str) -> Result<Self, String> {
        if s.is_empty() || s.len() > 256 {
            return Err(format!("invalid tool call ID length {}", s.len()));
        }
        if s.bytes().any(|b| b < 0x20 || b == 0x7F) {
            return Err("invalid tool call ID: ASCII control character".to_string());
        }
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ToolCallId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for ToolCallId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ToolCallId({})", self.0)
    }
}

impl FromStr for ToolCallId {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_canonical_str(s)
    }
}

impl<'de> Deserialize<'de> for ToolCallId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Self::from_canonical_str(&s).map_err(de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_data_rejects_nul_and_out_of_range_integers() {
        assert!(JsonData::String("a\0b".to_string()).validate().is_err());
        assert!(JsonData::Integer(MAX_JSON_INTEGER + 1).validate().is_err());
        assert!(JsonData::Unsigned(MAX_JSON_INTEGER as u64 + 1)
            .validate()
            .is_err());
        assert!(JsonData::Integer(42).validate().is_ok());
    }

    #[test]
    fn sha256_requires_lowercase_hex() {
        assert!(Sha256Digest::from_hex_str(&"a".repeat(64)).is_ok());
        assert!(Sha256Digest::from_hex_str(&"A".repeat(64)).is_err());
        assert!(Sha256Digest::from_hex_str("abc").is_err());
    }
}
