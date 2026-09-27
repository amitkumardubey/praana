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

#[cfg(all(feature = "failpoints", not(debug_assertions)))]
compile_error!("the failpoints feature is test-only and cannot build a release artifact");

pub mod canonical_json;
pub mod clock;
pub mod config;
#[cfg(feature = "failpoints")]
pub(crate) mod crash_point;

/// Arms one process-abort boundary for the dedicated crash-recovery test
/// executable. Production entrypoints never call this function, and failpoints
/// cannot be armed through process environment variables.
#[cfg(feature = "failpoints")]
#[doc(hidden)]
pub fn arm_test_failpoint(label: &str) -> Result<(), &'static str> {
    crash_point::arm_for_test(label)
}
pub mod credentials;
pub mod history;
pub mod hooks;
pub mod id;
pub mod process;
pub mod protocol;
pub mod provider;
pub mod redaction;
pub mod setup;
pub mod system_context;
pub mod token;
pub mod tools;
pub mod turn;
pub mod ui_contract;
pub mod unicode;

#[cfg(test)]
mod properties;
