//! Reusable report-only secret detection (P1D).
//!
//! Ownership: the Redaction specification (`docs/RUST_V2_REDACTION_SPEC.md`)
//! owns the detection semantics; System Context section 8.1 assigns the
//! complete-text detector implementation to packet P1D so project-instruction
//! loading can block on high-confidence secrets before P3A exists.
//!
//! This module implements detection only: it returns non-overlapping byte
//! spans in replacement order and never allocates replacement text, streams,
//! traverses JSON, hooks tools, or persists results. P3A owns transformation
//! and MUST consume [`detectors::detect_secret_matches_v1`] unchanged.

use serde::{Deserialize, Serialize};

pub mod detectors;

pub use detectors::{detect_secret_matches_v1, SecretMatchV1};

/// Secret kinds, exactly as owned by the Redaction specification section 2.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SecretKind {
    PrivateKey,
    AwsAccessKey,
    GithubToken,
    GitlabToken,
    AnthropicKey,
    #[serde(rename = "openai-key")]
    OpenAiKey,
    KeyAssignment,
}

impl SecretKind {
    /// Selection priority from the Redaction specification section 3 table.
    pub(crate) fn priority(&self) -> u8 {
        match self {
            SecretKind::PrivateKey => 1,
            SecretKind::AwsAccessKey => 2,
            SecretKind::GithubToken => 3,
            SecretKind::GitlabToken => 4,
            SecretKind::AnthropicKey => 5,
            SecretKind::OpenAiKey => 6,
            SecretKind::KeyAssignment => 7,
        }
    }

    /// Kebab-case kind name used by the replacement format `[REDACTED:<kind>]`.
    pub(crate) fn name(&self) -> &'static str {
        match self {
            SecretKind::PrivateKey => "private-key",
            SecretKind::AwsAccessKey => "aws-access-key",
            SecretKind::GithubToken => "github-token",
            SecretKind::GitlabToken => "gitlab-token",
            SecretKind::AnthropicKey => "anthropic-key",
            SecretKind::OpenAiKey => "openai-key",
            SecretKind::KeyAssignment => "key-assignment",
        }
    }
}
