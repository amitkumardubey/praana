//! Protocol canonical hashing and deterministic ID derivations.

use sha2::{Digest, Sha256};

use crate::protocol::errors::HistoryResult;
use crate::protocol::id::{RecoveryNoticeId, Sha256Digest};
use crate::protocol::json::serialize_canonical;
use crate::protocol::messages::ConversationMessage;
use crate::protocol::tool_result::ToolResultMessage;

/// Calculates SHA-256 of RFC 8785 canonical JSON for request wire body.
pub fn calculate_request_hash(body: &serde_json::Value) -> HistoryResult<Sha256Digest> {
    let bytes = serialize_canonical(body)?;
    Ok(Sha256Digest::from_bytes(Sha256::digest(&bytes).into()))
}

/// Calculates SHA-256 of RFC 8785 canonical JSON for tool arguments.
pub fn calculate_tool_arguments_hash(args: &serde_json::Value) -> HistoryResult<Sha256Digest> {
    let bytes = serialize_canonical(args)?;
    Ok(Sha256Digest::from_bytes(Sha256::digest(&bytes).into()))
}

/// Calculates SHA-256 of RFC 8785 canonical JSON for accepted conversation messages.
pub fn calculate_accepted_messages_hash(
    messages: &[ConversationMessage],
) -> HistoryResult<Sha256Digest> {
    let bytes = serialize_canonical(&messages)?;
    Ok(Sha256Digest::from_bytes(Sha256::digest(&bytes).into()))
}

/// Calculates SHA-256 of RFC 8785 canonical JSON for tool results.
pub fn calculate_result_messages_hash(
    results: &[ToolResultMessage],
) -> HistoryResult<Sha256Digest> {
    let bytes = serialize_canonical(&results)?;
    Ok(Sha256Digest::from_bytes(Sha256::digest(&bytes).into()))
}

/// Calculates SHA-256 over exact UTF-8 event lines, including each terminating LF.
pub fn calculate_source_hash(lines: &[String]) -> Sha256Digest {
    let mut hasher = Sha256::new();
    for line in lines {
        hasher.update(line.as_bytes());
    }
    Sha256Digest::from_bytes(hasher.finalize().into())
}

/// Calculates SHA-256 of raw bytes.
pub fn calculate_sha256(bytes: &[u8]) -> Sha256Digest {
    Sha256Digest::from_bytes(Sha256::digest(bytes).into())
}

/// Computes the next prefix hash Hi from Hi-1, sequence, and exact line bytes including LF.
/// H0 = 32 zero bytes
/// Li = SHA256(exact event line bytes for event i, including LF)
/// Hi = SHA256(Hi-1 || u64_be(sequence_i) || u64_be(line_length_i) || Li)
pub fn calculate_prefix_hash(prev_prefix: &[u8; 32], sequence: u64, line_bytes: &[u8]) -> [u8; 32] {
    let li = Sha256::digest(line_bytes);
    let mut hasher = Sha256::new();
    hasher.update(prev_prefix);
    hasher.update(sequence.to_be_bytes());
    hasher.update((line_bytes.len() as u64).to_be_bytes());
    hasher.update(li);
    hasher.finalize().into()
}

/// Derives a deterministic RecoveryNoticeId from kind and source keys using uppercase Crockford ULID.
/// First 16 bytes of SHA-256("praana-recovery-v2\0" || kind || "\0" || key0 || "\0" || key1 ...).
pub fn derive_recovery_notice_id(kind: &str, keys: &[&str]) -> RecoveryNoticeId {
    let mut hasher = Sha256::new();
    hasher.update(b"praana-recovery-v2\0");
    hasher.update(kind.as_bytes());
    for key in keys {
        hasher.update(b"\0");
        hasher.update(key.as_bytes());
    }
    let hash = hasher.finalize();
    let mut bytes16 = [0u8; 16];
    bytes16.copy_from_slice(&hash[..16]);
    let ulid_val = ulid::Ulid::from_bytes(bytes16);
    RecoveryNoticeId(ulid_val)
}
