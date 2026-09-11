//! PRAANA Rust v2 core foundations.
//!
//! Phase 1A scope: native-core access, deterministic clock and monotonic-ID
//! foundations, strict configuration, pinned Unicode utilities, generic
//! token estimation, framing profiles, and RFC 8785 canonical serialization.

pub mod canonical_json;
pub mod clock;
pub mod config;
pub mod id;
pub mod token;
pub mod unicode;
