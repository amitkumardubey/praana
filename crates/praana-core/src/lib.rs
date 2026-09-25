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

//! Phase 1C scope: permanent semantic UI contract (`ui_contract`), bounded
//! event sink policy, and History-owned session/host operation ledgers with
//! crash recovery (`history::operation_ledger`).

pub mod canonical_json;
pub mod clock;
pub mod config;
pub mod credentials;
pub mod history;
pub mod id;
pub mod protocol;
pub mod provider;
pub mod redaction;
pub mod setup;
pub mod system_context;
pub mod token;
pub mod tools;
pub mod ui_contract;
pub mod unicode;

#[cfg(test)]
mod properties;
