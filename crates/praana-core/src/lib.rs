//! PRAANA Rust v2 core foundations.
//!
//! Phase 1A scope: native-core access, deterministic clock and monotonic-ID
//! foundations, strict configuration, pinned Unicode utilities, generic
//! token estimation, framing profiles, and RFC 8785 canonical serialization.
//!
//! Phase 1B scope: exact schema-2 protocol DTOs (`protocol`), the canonical
//! event store with startup repair (`history::event_log`), pure replay
//! validation (`history::replay`), accepted-conversation projection
//! (`history::projection`), and idempotent crash recovery
//! (`history::recovery`).

pub mod canonical_json;
pub mod clock;
pub mod config;
pub mod history;
pub mod id;
pub mod protocol;
pub mod token;
pub mod unicode;

#[cfg(test)]
mod properties;
