//! Protocol ID newtypes and validation.

use serde::{de, Deserialize, Deserializer, Serialize};
use std::fmt;
use std::str::FromStr;
use ulid::Ulid;

use crate::id::ProtocolUlidId;
use crate::protocol::constants::*;
use crate::protocol::errors::HistoryError;

const CROCKFORD_CHARS: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn validate_crockford_ulid_str(s: &str) -> Result<Ulid, HistoryError> {
    if s.len() != 26 {
        return Err(HistoryError::new(
            "E_EVENT_SCHEMA_INVALID",
            None,
            None,
            false,
        ));
    }
    for &b in s.as_bytes() {
        if !CROCKFORD_CHARS.contains(&b) {
            return Err(HistoryError::new(
                "E_EVENT_SCHEMA_INVALID",
                None,
                None,
                false,
            ));
        }
    }
    let parsed = Ulid::from_string(s)
        .map_err(|_| HistoryError::new("E_EVENT_SCHEMA_INVALID", None, None, false))?;
    Ok(parsed)
}

macro_rules! define_ulid_newtype {
    ($name:ident) => {
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub Ulid);

        impl $name {
            pub fn from_str_canonical(s: &str) -> Result<Self, HistoryError> {
                let u = validate_crockford_ulid_str(s)?;
                Ok(Self(u))
            }

            pub fn to_ulid(&self) -> Ulid {
                self.0
            }

            pub fn as_str(&self) -> String {
                self.0.to_string()
            }
        }

        impl ProtocolUlidId for $name {
            fn from_validated_ulid(value: Ulid) -> Self {
                Self(value)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0.to_string())
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.0.to_string())
            }
        }

        impl FromStr for $name {
            type Err = HistoryError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::from_str_canonical(s)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let s = String::deserialize(deserializer)?;
                Self::from_str_canonical(&s).map_err(de::Error::custom)
            }
        }
    };
}

define_ulid_newtype!(SessionId);
define_ulid_newtype!(TurnId);
define_ulid_newtype!(AttemptId);
define_ulid_newtype!(StepId);
define_ulid_newtype!(MessageId);
define_ulid_newtype!(EventId);
define_ulid_newtype!(ToolBatchId);
define_ulid_newtype!(ToolExecutionId);
define_ulid_newtype!(RecoveryNoticeId);
define_ulid_newtype!(ArtifactId);
define_ulid_newtype!(CompactionId);
define_ulid_newtype!(HandoffId);
define_ulid_newtype!(SummarySegmentId);
define_ulid_newtype!(StateId);
define_ulid_newtype!(StateMutationId);
define_ulid_newtype!(SearchResultId);
define_ulid_newtype!(DeletionId);

/// SHA-256 hex digest (64 lowercase hex characters).
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(pub String);

impl Sha256Digest {
    pub fn from_hex_str(s: &str) -> Result<Self, HistoryError> {
        if s.len() != 64 {
            return Err(HistoryError::new(
                "E_EVENT_SCHEMA_INVALID",
                None,
                None,
                false,
            ));
        }
        for b in s.bytes() {
            if !matches!(b, b'0'..=b'9' | b'a'..=b'f') {
                return Err(HistoryError::new(
                    "E_EVENT_SCHEMA_INVALID",
                    None,
                    None,
                    false,
                ));
            }
        }
        Ok(Self(s.to_string()))
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        let mut s = String::with_capacity(64);
        for b in bytes {
            use std::fmt::Write;
            let _ = write!(s, "{:02x}", b);
        }
        Self(s)
    }

    /// SHA-256 of arbitrary bytes. `from_bytes` remains the constructor for an
    /// already-computed digest.
    pub fn digest_bytes(bytes: &[u8]) -> Self {
        use sha2::{Digest, Sha256};
        Self::from_bytes(Sha256::digest(bytes).into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl fmt::Debug for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sha256Digest({})", self.0)
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

/// Projection ID, fixed for event schema version 2.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ProjectionId(pub String);

impl ProjectionId {
    pub fn from_str_canonical(s: &str) -> Result<Self, HistoryError> {
        if s != PROJECTION_VERSION {
            return Err(HistoryError::new(
                "E_EVENT_SCHEMA_INVALID",
                None,
                None,
                false,
            ));
        }
        Ok(Self(s.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ProjectionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str_canonical(&value).map_err(de::Error::custom)
    }
}

macro_rules! define_opaque_id_newtype {
    ($name:ident) => {
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn from_str_canonical(s: &str) -> Result<Self, HistoryError> {
                if s.is_empty() || s.len() > MAX_ID_BYTES {
                    return Err(HistoryError::new(
                        "E_EVENT_SCHEMA_INVALID",
                        None,
                        None,
                        false,
                    ));
                }
                for b in s.bytes() {
                    if b < 0x20 || b == 0x7F {
                        return Err(HistoryError::new(
                            "E_EVENT_SCHEMA_INVALID",
                            None,
                            None,
                            false,
                        ));
                    }
                }
                Ok(Self(s.to_string()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.0)
            }
        }

        impl FromStr for $name {
            type Err = HistoryError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::from_str_canonical(s)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let s = String::deserialize(deserializer)?;
                Self::from_str_canonical(&s).map_err(de::Error::custom)
            }
        }
    };
}

define_opaque_id_newtype!(ProviderItemId);
define_opaque_id_newtype!(ProviderResponseId);

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ToolCallId(pub String);

impl ToolCallId {
    pub fn from_str_canonical(s: &str) -> Result<Self, HistoryError> {
        if s.is_empty() {
            return Err(HistoryError::new(
                "E_TOOL_CALL_ID_MISSING",
                None,
                None,
                false,
            ));
        }
        if s.len() > MAX_ID_BYTES || s.bytes().any(|b| b < 0x20 || b == 0x7f) {
            return Err(HistoryError::new(
                "E_EVENT_SCHEMA_INVALID",
                None,
                None,
                false,
            ));
        }
        Ok(Self(s.to_owned()))
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
    type Err = HistoryError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_str_canonical(s)
    }
}

impl<'de> Deserialize<'de> for ToolCallId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_str_canonical(&value).map_err(de::Error::custom)
    }
}
