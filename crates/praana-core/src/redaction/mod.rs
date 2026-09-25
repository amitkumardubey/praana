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
use sha2::Digest;

use crate::protocol::id::Sha256Digest;

pub mod assignment;
pub mod detectors;
pub mod json;
pub mod stream;

pub use detectors::{detect_secret_matches_v1, SecretMatchV1};
pub use json::{redact_json_v1, RedactedJson};
pub use stream::StreamingRedactor;

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

pub const REDACTION_VERSION: &str = "praana-redaction-v1";

/// Complete-text detector calls stay at or below this size. Larger values use streaming.
pub const DETECTOR_INPUT_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RedactionSummaryV1 {
    pub redaction_version: String,
    pub replacement_count: u32,
    pub kinds: Vec<SecretKind>,
    pub input_sha256: Sha256Digest,
    pub output_sha256: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedactedText {
    pub text: String,
    /// Unemitted suffix from [`StreamingRedactor::finish`]. Equal to `text` for complete redaction.
    pub tail: String,
    pub summary: RedactionSummaryV1,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RedactionError {
    DepthExceeded,
    Failed,
    InvalidUtf8,
}

impl std::fmt::Display for RedactionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DepthExceeded => f.write_str("redaction failed: nested depth exceeded"),
            Self::Failed => f.write_str("redaction failed"),
            Self::InvalidUtf8 => f.write_str("redaction failed: invalid utf-8"),
        }
    }
}

impl std::error::Error for RedactionError {}

pub fn redact_text_v1(input: &str) -> Result<RedactedText, RedactionError> {
    if input.len() > DETECTOR_INPUT_LIMIT {
        let mut redactor = StreamingRedactor::new();
        let mut text = String::new();
        let mut offset = 0;
        while offset < input.len() {
            let end = (offset + 64 * 1024).min(input.len());
            text.push_str(&redactor.push(&input.as_bytes()[offset..end])?);
            offset = end;
        }
        let done = redactor.finish()?;
        text.push_str(&done.tail);
        return Ok(RedactedText {
            text,
            tail: done.tail,
            summary: done.summary,
            warnings: done.warnings,
        });
    }
    apply_complete(input)
}

pub(crate) fn apply_complete(input: &str) -> Result<RedactedText, RedactionError> {
    let matches = detect_secret_matches_v1(input);
    let (text, kinds, warnings) = apply_matches(input, &matches)?;
    let summary = summary_for(input.as_bytes(), text.as_bytes(), matches.len(), kinds)?;
    Ok(RedactedText {
        tail: text.clone(),
        text,
        summary,
        warnings,
    })
}

pub(crate) fn summary_from_digests(
    input: sha2::Sha256,
    output: sha2::Sha256,
    replacement_count: usize,
    mut kinds: Vec<SecretKind>,
) -> Result<RedactionSummaryV1, RedactionError> {
    let replacement_count = u32::try_from(replacement_count).map_err(|_| RedactionError::Failed)?;
    kinds.sort_by_key(|kind| kind.priority());
    kinds.dedup();
    Ok(RedactionSummaryV1 {
        redaction_version: REDACTION_VERSION.to_owned(),
        replacement_count,
        kinds,
        input_sha256: Sha256Digest::from_bytes(input.finalize().into()),
        output_sha256: Sha256Digest::from_bytes(output.finalize().into()),
    })
}

pub(crate) fn summary_for(
    input: &[u8],
    output: &[u8],
    replacement_count: usize,
    mut kinds: Vec<SecretKind>,
) -> Result<RedactionSummaryV1, RedactionError> {
    let replacement_count = u32::try_from(replacement_count).map_err(|_| RedactionError::Failed)?;
    kinds.sort_by_key(|kind| kind.priority());
    kinds.dedup();
    Ok(RedactionSummaryV1 {
        redaction_version: REDACTION_VERSION.to_owned(),
        replacement_count,
        kinds,
        input_sha256: Sha256Digest::digest_bytes(input),
        output_sha256: Sha256Digest::digest_bytes(output),
    })
}

fn apply_matches(
    input: &str,
    matches: &[SecretMatchV1],
) -> Result<(String, Vec<SecretKind>, Vec<String>), RedactionError> {
    let mut out = String::with_capacity(input.len());
    let mut last = 0usize;
    let mut kinds = Vec::new();
    let mut warnings = Vec::new();
    for matched in matches {
        if matched.start_byte < last
            || matched.end_byte > input.len()
            || !input.is_char_boundary(matched.start_byte)
            || !input.is_char_boundary(matched.end_byte)
        {
            return Err(RedactionError::Failed);
        }
        out.push_str(&input[last..matched.start_byte]);
        out.push_str("[REDACTED:");
        out.push_str(matched.kind.name());
        out.push(']');
        if matched.kind == SecretKind::PrivateKey {
            let body = &input[matched.start_byte..matched.end_byte];
            if !body.contains("-----END ") {
                let warning = "REDACTION_UNTERMINATED_PRIVATE_KEY".to_owned();
                if !warnings.contains(&warning) {
                    warnings.push(warning);
                }
            }
        }
        if !kinds.contains(&matched.kind) {
            kinds.push(matched.kind.clone());
        }
        last = matched.end_byte;
    }
    out.push_str(&input[last..]);
    Ok((out, kinds, warnings))
}
