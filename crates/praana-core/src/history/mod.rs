//! History and event log management, replay validation, pure conversation projection, and startup crash recovery.
//!
//! Phase 3 adds the artifact substrate: exact `history.db` schema, canonical
//! result artifactization, previews, shell spools, and rollback journals.

pub mod artifact;
pub mod db;
pub mod error;
pub mod event_log;
pub mod journal;
pub mod operation_ledger;
pub mod preview;
pub mod projection;
pub mod recovery;
pub mod replay;
pub mod spool;

pub use error::ArtifactError;
