//! Canonical Rust-v2 protocol DTOs.
//!
//! StateGraph and compaction payloads are defined in their owner modules and
//! embedded directly by [`events::CanonicalEvent`]; no protocol-local aliases
//! are provided.

pub mod compaction;
pub mod constants;
pub mod continuation;
pub mod errors;
pub mod events;
pub mod hashes;
pub mod id;
pub mod json;
pub mod messages;
pub mod models;
pub mod recovery;
pub mod state_graph;
pub mod tool_result;
