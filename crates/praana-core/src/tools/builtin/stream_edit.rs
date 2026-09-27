//! Bounded-memory streaming substring replace, validate, and hash.
//!
//! Handle-anchored edit targets are not capped by the read_file-specific
//! ceiling (owner decision 3), so an edit target can be far larger than the
//! process should hold in memory at once. This module finds the sole
//! occurrence of `old` in a byte stream and substitutes `new` while hashing
//! both the source and the destination, using a sliding window bounded by
//! `old.len()` plus one read chunk -- never the whole source. NUL bytes and
//! invalid UTF-8 are rejected incrementally rather than after materializing
//! the whole file.

use std::io::{Read, Write};

use sha2::{Digest, Sha256};

use crate::protocol::id::Sha256Digest;
use crate::tools::error::{ToolError, ToolErrorCode};

const CHUNK: usize = 8192;

fn unsupported() -> ToolError {
    ToolError::new(ToolErrorCode::ToolUnsupported, "unsupported encoding")
}

fn io_failed(message: &str) -> ToolError {
    ToolError::new(ToolErrorCode::ToolIoFailed, message)
}

/// Outcome of one streamed replace pass.
#[derive(Debug, Clone)]
pub struct StreamEditOutcome {
    /// Non-overlapping occurrences of `old`, scanned left to right -- the
    /// same count `str::matches(old).count()` would report.
    pub matches: usize,
    pub source_sha256: Sha256Digest,
    pub source_len: u64,
    pub dest_sha256: Sha256Digest,
    pub dest_len: u64,
}

struct Hashing<'a> {
    inner: &'a mut dyn Write,
    hasher: Sha256,
    len: u64,
}

impl Write for Hashing<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.hasher.update(&buf[..written]);
        self.len += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Streams `source` to `dest`, replacing the sole occurrence of `old` with
/// `new`. Holds at most `old.len()` plus one read chunk in memory
/// regardless of source size. `matches != 1` is not an error here -- the
/// caller decides whether that count is acceptable and whether to keep
/// `dest` (this function always fully drains `source` so the count and both
/// hashes are exact).
pub fn stream_replace(
    source: &mut dyn Read,
    dest: &mut dyn Write,
    old: &[u8],
    new: &[u8],
) -> Result<StreamEditOutcome, ToolError> {
    if old.is_empty() {
        return Err(ToolError::new(
            ToolErrorCode::ToolInternal,
            "old_text must not be empty",
        ));
    }
    let mut source_hasher = Sha256::new();
    let mut source_len = 0u64;
    let mut dest = Hashing {
        inner: dest,
        hasher: Sha256::new(),
        len: 0,
    };
    let mut window: Vec<u8> = Vec::new();
    let mut buffer = vec![0u8; CHUNK];
    let mut matches = 0usize;
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| io_failed("read failed"))?;
        let eof = read == 0;
        if !eof {
            source_hasher.update(&buffer[..read]);
            source_len += read as u64;
            window.extend_from_slice(&buffer[..read]);
        }
        // Drain every complete, non-overlapping match already confirmable in
        // the window. Byte equality never changes once observed, so any
        // position where the full pattern already fits is a final match.
        loop {
            if window.len() < old.len() {
                break;
            }
            let last_start = window.len() - old.len();
            let found = (0..=last_start).find(|&p| window[p..p + old.len()] == *old);
            let Some(pos) = found else { break };
            if matches == 0 {
                emit_validated(&window[..pos], &mut dest, &mut carry, false)?;
                dest.write_all(new)
                    .map_err(|_| io_failed("temp write failed"))?;
            } else {
                emit_validated(&window[..pos + old.len()], &mut dest, &mut carry, false)?;
            }
            matches += 1;
            window.drain(..pos + old.len());
        }
        if eof {
            emit_validated(&window, &mut dest, &mut carry, true)?;
            return Ok(StreamEditOutcome {
                matches,
                source_sha256: Sha256Digest::from_bytes(source_hasher.finalize().into()),
                source_len,
                dest_sha256: Sha256Digest::from_bytes(dest.hasher.finalize().into()),
                dest_len: dest.len,
            });
        }
        // No further confirmable match exists right now (or the window is
        // shorter than `old`). Flush everything except the last
        // `old.len() - 1` bytes, which might still combine with the next
        // chunk to start a match.
        let retain = old.len() - 1;
        if window.len() > retain {
            let safe = window.len() - retain;
            emit_validated(&window[..safe], &mut dest, &mut carry, false)?;
            window.drain(..safe);
        }
    }
}

/// Validates `bytes` (combined with any carried-over incomplete UTF-8 tail)
/// for NUL bytes and UTF-8 validity, then writes the validated prefix. An
/// incomplete trailing sequence is carried to the next call unless
/// `final_flush` is set, in which case it is rejected as unsupported.
fn emit_validated(
    bytes: &[u8],
    dest: &mut dyn Write,
    carry: &mut Vec<u8>,
    final_flush: bool,
) -> Result<(), ToolError> {
    let mut combined = std::mem::take(carry);
    combined.extend_from_slice(bytes);
    if combined.is_empty() {
        return Ok(());
    }
    if combined.contains(&0) {
        return Err(unsupported());
    }
    match std::str::from_utf8(&combined) {
        Ok(_) => dest
            .write_all(&combined)
            .map_err(|_| io_failed("temp write failed")),
        Err(err) => {
            let valid_up_to = err.valid_up_to();
            if err.error_len().is_some() || final_flush {
                return Err(unsupported());
            }
            dest.write_all(&combined[..valid_up_to])
                .map_err(|_| io_failed("temp write failed"))?;
            *carry = combined[valid_up_to..].to_vec();
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn run(text: &str, old: &str, new: &str) -> (StreamEditOutcome, Vec<u8>) {
        let mut source = Cursor::new(text.as_bytes().to_vec());
        let mut dest = Vec::new();
        let outcome = stream_replace(&mut source, &mut dest, old.as_bytes(), new.as_bytes())
            .expect("stream_replace");
        (outcome, dest)
    }

    #[test]
    fn replaces_a_single_match_and_hashes_both_sides() {
        let (outcome, dest) = run("alpha beta gamma", "beta", "OMEGA");
        assert_eq!(outcome.matches, 1);
        assert_eq!(dest, b"alpha OMEGA gamma");
        assert_eq!(
            outcome.source_sha256,
            Sha256Digest::digest_bytes(b"alpha beta gamma")
        );
        assert_eq!(outcome.source_len, "alpha beta gamma".len() as u64);
        assert_eq!(outcome.dest_sha256, Sha256Digest::digest_bytes(&dest));
        assert_eq!(outcome.dest_len, dest.len() as u64);
    }

    #[test]
    fn reports_zero_matches_without_altering_the_stream() {
        let (outcome, dest) = run("alpha beta gamma", "missing", "x");
        assert_eq!(outcome.matches, 0);
        assert_eq!(dest, b"alpha beta gamma");
    }

    #[test]
    fn reports_every_non_overlapping_match_and_only_substitutes_the_first() {
        let (outcome, dest) = run("aaa", "aa", "X");
        // str::matches("aaa", "aa") also finds exactly one non-overlapping
        // match starting at 0, leaving a trailing "a".
        assert_eq!(outcome.matches, 1);
        assert_eq!(dest, b"Xa");
        let (outcome2, dest2) = run("abab ab", "ab", "Z");
        assert_eq!(outcome2.matches, 3);
        assert_eq!(dest2, b"Zab ab");
    }

    #[test]
    fn match_spans_a_chunk_boundary_at_the_configured_buffer_size() {
        let prefix = "x".repeat(CHUNK - 2);
        let text = format!("{prefix}NEEDLE-here");
        let (outcome, dest) = run(&text, "NEEDLE-here", "FOUND");
        assert_eq!(outcome.matches, 1);
        assert_eq!(dest, format!("{prefix}FOUND").into_bytes());
    }

    #[test]
    fn old_text_longer_than_the_copy_buffer_is_still_found() {
        let needle = "N".repeat(CHUNK * 2);
        let text = format!("before-{needle}-after");
        let (outcome, dest) = run(&text, &needle, "SHORT");
        assert_eq!(outcome.matches, 1);
        assert_eq!(dest, b"before-SHORT-after");
    }

    #[test]
    fn rejects_a_nul_byte() {
        let mut source = Cursor::new(b"a\0b".to_vec());
        let mut dest = Vec::new();
        let error = stream_replace(&mut source, &mut dest, b"a", b"x").unwrap_err();
        assert_eq!(error.code(), ToolErrorCode::ToolUnsupported);
    }

    #[test]
    fn rejects_invalid_utf8() {
        let mut source = Cursor::new(vec![0xff, 0xfe, b'a']);
        let mut dest = Vec::new();
        let error = stream_replace(&mut source, &mut dest, b"a", b"x").unwrap_err();
        assert_eq!(error.code(), ToolErrorCode::ToolUnsupported);
    }

    #[test]
    fn accepts_a_multi_byte_utf8_character_split_across_chunk_boundaries() {
        // A 4-byte UTF-8 character straddling the buffer boundary must
        // reassemble correctly through the incremental carry.
        let prefix = "y".repeat(CHUNK - 2);
        let text = format!("{prefix}\u{1F600}NEEDLE");
        let (outcome, dest) = run(&text, "NEEDLE", "X");
        assert_eq!(outcome.matches, 1);
        assert_eq!(dest, format!("{prefix}\u{1F600}X").into_bytes());
    }

    #[test]
    fn rejects_an_incomplete_trailing_sequence_at_true_eof() {
        // A 4-byte lead byte with no continuation bytes at all: invalid on
        // its own, not just "incomplete".
        let mut source = Cursor::new(vec![b'a', 0xf0]);
        let mut dest = Vec::new();
        let error = stream_replace(&mut source, &mut dest, b"a", b"x").unwrap_err();
        assert_eq!(error.code(), ToolErrorCode::ToolUnsupported);
    }
}
