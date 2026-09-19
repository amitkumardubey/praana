//! UI-crossing IDs, selectors, cursors, and session locators.
//!
//! Every canonical or semantic entity ID crossing the UI boundary serializes
//! as a raw uppercase 26-character Crockford ULID. `op_` and other prefixes
//! are forbidden. [`ResumeSelector`] is a 12-character selector derived from
//! the first 12 characters of the canonical [`SessionId`](crate::protocol::id::SessionId)
//! string; it is never accepted in a canonical-ID field.

use serde::{de, Deserialize, Deserializer, Serialize};
use std::fmt;
use std::str::FromStr;
use ulid::Ulid;

use crate::protocol::id::SessionId;

pub(crate) const CROCKFORD_UPPER: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Validate a raw uppercase 26-character Crockford ULID string.
pub fn validate_crossing_ulid(s: &str) -> Result<Ulid, String> {
    if s.len() != 26 {
        return Err(format!(
            "invalid ULID length {}: expected 26 characters",
            s.len()
        ));
    }
    for &b in s.as_bytes() {
        if !CROCKFORD_UPPER.contains(&b) {
            return Err(format!("invalid ULID character: {s:?}"));
        }
    }
    Ulid::from_string(s).map_err(|_| format!("invalid ULID value: {s:?}"))
}

macro_rules! define_crossing_id {
    ($name:ident) => {
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub Ulid);

        impl $name {
            pub fn from_canonical_str(s: &str) -> Result<Self, String> {
                validate_crossing_ulid(s).map(Self)
            }

            pub fn to_ulid(&self) -> Ulid {
                self.0
            }

            pub fn as_str(&self) -> String {
                self.0.to_string()
            }
        }

        impl crate::id::ProtocolUlidId for $name {
            fn from_validated_ulid(value: Ulid) -> Self {
                Self(value)
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

define_crossing_id!(OperationId);
define_crossing_id!(TranscriptGroupId);
define_crossing_id!(TranscriptEntryId);
define_crossing_id!(AssistantBlockId);
define_crossing_id!(ConfirmationId);
define_crossing_id!(ConsentId);
define_crossing_id!(AuthFlowId);
define_crossing_id!(NoticeId);

/// 12-character resume selector: the first 12 characters of the canonical
/// session ID string. A selector, never an ID.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ResumeSelector(pub String);

impl ResumeSelector {
    pub fn from_canonical_str(s: &str) -> Result<Self, String> {
        if s.len() != 12 {
            return Err(format!(
                "invalid resume selector length {}: expected 12 characters",
                s.len()
            ));
        }
        for &b in s.as_bytes() {
            if !CROCKFORD_UPPER.contains(&b) {
                return Err(format!("invalid resume selector character: {s:?}"));
            }
        }
        Ok(Self(s.to_string()))
    }

    /// Derive the selector from a canonical session ID.
    pub fn derive_from_session(session: &SessionId) -> Self {
        let s = session.to_string();
        Self(s[..12].to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ResumeSelector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for ResumeSelector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ResumeSelector({})", self.0)
    }
}

impl FromStr for ResumeSelector {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::from_canonical_str(s)
    }
}

impl<'de> Deserialize<'de> for ResumeSelector {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Self::from_canonical_str(&s).map_err(de::Error::custom)
    }
}

macro_rules! define_cursor {
    ($name:ident) => {
        /// Opaque server-issued ASCII cursor, 1 through 512 bytes.
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn from_canonical_str(s: &str) -> Result<Self, String> {
                if s.is_empty() || s.len() > 512 {
                    return Err(format!(
                        "invalid cursor length {}: expected 1 through 512 bytes",
                        s.len()
                    ));
                }
                if !s.is_ascii() {
                    return Err("invalid cursor: expected ASCII".to_string());
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

define_cursor!(TranscriptCursor);
define_cursor!(ModelCatalogCursor);
define_cursor!(SlashCatalogCursor);
define_cursor!(PathCompletionCursor);
define_cursor!(ContentCursor);

/// Session locator: canonical ID bypasses selector lookup; selector requires
/// disambiguation against session manifests.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum SessionLocator {
    Id(SessionId),
    ResumeSelector(ResumeSelector),
}

// Re-exported protocol-owned IDs reused directly by the UI contract.
pub use crate::protocol::id::{
    ArtifactId as ProtocolArtifactId, AttemptId as ProtocolAttemptId, EventId as ProtocolEventId,
    MessageId as ProtocolMessageId, SessionId as ProtocolSessionId, StepId as ProtocolStepId,
    ToolBatchId as ProtocolToolBatchId, ToolExecutionId as ProtocolToolExecutionId,
    TurnId as ProtocolTurnId,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing_ids_reject_lowercase_and_prefixes() {
        assert!(OperationId::from_canonical_str("01J8Z3NDEK0000000000000001").is_ok());
        assert!(OperationId::from_canonical_str("01j8z3ndek0000000000000001").is_err());
        assert!(OperationId::from_canonical_str("op_01J8Z3NDEK0000000000000001").is_err());
        // Ambiguous Crockford letters are rejected.
        assert!(OperationId::from_canonical_str("01J8Z3NDEK0000000000OOOOO1").is_err());
        assert!(OperationId::from_canonical_str("01J8Z3NDEK0000000000IIIII1").is_err());
        assert!(OperationId::from_canonical_str("01J8Z3NDEK0000000000LLLLL1").is_err());
        assert!(OperationId::from_canonical_str("01J8Z3NDEK0000000000UUUUU1").is_err());
        assert!(OperationId::from_canonical_str("01J8Z3NDEK00000000000001").is_err());
    }

    #[test]
    fn resume_selector_is_twelve_chars_and_derives_from_session() {
        let session = SessionId::from_str_canonical("01J8Z3NDEK0000000000000001").unwrap();
        let selector = ResumeSelector::derive_from_session(&session);
        assert_eq!(selector.as_str(), "01J8Z3NDEK00");
        assert!(ResumeSelector::from_canonical_str("01J8Z3NDEK00").is_ok());
        assert!(ResumeSelector::from_canonical_str("01J8Z3NDEK0000000000000001").is_err());
    }
}
