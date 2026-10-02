//! Authenticated search cursors (History §11.2–§11.3).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::error::ArtifactError;
use crate::canonical_json::to_canonical_json_bytes;
use crate::protocol::id::{SessionId, Sha256Digest};

pub const CURSOR_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionSearchCursorV2 {
    pub cursor_schema_version: u32,
    pub session_id: SessionId,
    pub projection_through_sequence: u64,
    pub reset_epoch: u32,
    pub request_sha256: Sha256Digest,
    pub last_primary_micros: i64,
    pub last_event_sequence: u64,
    pub last_document_id: String,
    pub last_line: u64,
    pub last_column: u64,
}

fn stale() -> ArtifactError {
    ArtifactError::new("HISTORY_SEARCH_CURSOR_STALE", "cursor is not valid")
}

pub fn encode_cursor(payload: &SessionSearchCursorV2, hmac_key: &[u8; 32]) -> String {
    let bytes = to_canonical_json_bytes(payload).expect("cursor payload serializes");
    let tag = hmac_sha256(hmac_key, &bytes);
    format!("{}.{}", base64url_no_pad(&bytes), base64url_no_pad(&tag))
}

pub fn decode_cursor(
    encoded: &str,
    hmac_key: &[u8; 32],
    expected_request_sha256: &Sha256Digest,
    current_reset_epoch: u32,
    current_applied_sequence: u64,
    session_id: &SessionId,
) -> Result<SessionSearchCursorV2, ArtifactError> {
    let (body, tag) = encoded.split_once('.').ok_or_else(stale)?;
    let body = base64url_decode(body).ok_or_else(stale)?;
    let tag = base64url_decode(tag).ok_or_else(stale)?;
    let expected = hmac_sha256(hmac_key, &body);
    if !constant_time_eq(&tag, &expected) {
        return Err(stale());
    }
    let payload: SessionSearchCursorV2 = serde_json::from_slice(&body).map_err(|_| stale())?;
    if payload.cursor_schema_version != CURSOR_SCHEMA_VERSION
        || payload.session_id != *session_id
        || payload.request_sha256 != *expected_request_sha256
        || payload.reset_epoch != current_reset_epoch
        || payload.projection_through_sequence > current_applied_sequence
    {
        return Err(stale());
    }
    Ok(payload)
}

pub(crate) fn hmac_sha256(key: &[u8; 32], message: &[u8]) -> [u8; 32] {
    let mut pad = [0u8; 64];
    pad[..key.len()].copy_from_slice(key);
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for index in 0..64 {
        ipad[index] ^= pad[index];
        opad[index] ^= pad[index];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    outer.finalize().into()
}

/// Constant-time comparison over a fixed-length window (History §11.3). A
/// length mismatch sets the accumulator without returning early, so no
/// comparison-count signal is exposed. The flag is a full byte: folding the
/// raw length xor through `u8` would accept a 256-byte extension.
pub(crate) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut diff = u8::from(left.len() != right.len());
    let length = left.len().max(right.len());
    for index in 0..length {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        diff |= a ^ b;
    }
    diff == 0
}

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub(crate) fn base64url_no_pad(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64URL[(triple >> 18) as usize & 0x3f] as char);
        out.push(B64URL[(triple >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(B64URL[(triple >> 6) as usize & 0x3f] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL[triple as usize & 0x3f] as char);
        }
    }
    out
}

pub(crate) fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4 + 2);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for &byte in bytes {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        } as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    if bits > 0 && buffer != 0 {
        return None;
    }
    Some(out)
}
