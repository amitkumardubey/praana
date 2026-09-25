//! Bounded streaming redaction.
//!
//! Retention is an incremental UTF-8 tail (at most 3 bytes), one logical line
//! capped at 65,536 bytes, 512 bytes of token overlap, and a PEM spool after
//! 65,536 bytes. The complete input is not retained.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

use super::{
    apply_complete, summary_from_digests, RedactedText, RedactionError, SecretKind,
    DETECTOR_INPUT_LIMIT,
};

const MAX_LINE: usize = 65_536;
const TOKEN_OVERLAP: usize = 512;
const PEM_LINE_LIMIT: usize = 80;
const PEM_ALGORITHMS: [&str; 4] = [
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
];

/// P3B implements this to persist invalid UTF-8. The redactor never returns those bytes.
pub trait BinarySpool: Send {
    fn write_all(&mut self, bytes: &[u8]) -> Result<(), RedactionError>;
}

/// Invalid UTF-8 tool text. Byte length is metadata; the bytes themselves are not here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinaryArtifactPending {
    pub byte_count: u64,
}

#[derive(Debug)]
pub enum StreamFinish {
    Text(RedactedText),
    Binary(BinaryArtifactPending),
}

struct PemState {
    alg: &'static str,
    current: Vec<u8>,
    retained: usize,
    file: Option<std::fs::File>,
    path: Option<PathBuf>,
}

impl PemState {
    fn start(alg: &'static str) -> Self {
        Self {
            alg,
            current: Vec::new(),
            retained: 0,
            file: None,
            path: None,
        }
    }

    fn push_bytes(&mut self, bytes: &[u8]) -> Result<(), RedactionError> {
        self.current.extend_from_slice(bytes);
        self.drain_complete_lines(false)
    }

    fn drain_complete_lines(&mut self, eof: bool) -> Result<(), RedactionError> {
        while let Some(nl) = self.current.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.current.drain(..=nl).collect();
            if Self::is_end(&line[..line.len() - 1], self.alg) {
                self.current.splice(0..0, line);
                return Ok(());
            }
            self.spill(&line)?;
        }
        if eof {
            return Ok(());
        }
        if self.current.len() > PEM_LINE_LIMIT && !self.current.starts_with(b"-----END") {
            let rest = std::mem::take(&mut self.current);
            self.spill(&rest)?;
        }
        Ok(())
    }

    fn take_end(&mut self) -> bool {
        let Some(nl) = self.current.iter().position(|byte| *byte == b'\n') else {
            return false;
        };
        if !Self::is_end(&self.current[..nl], self.alg) {
            return false;
        }
        let _ = self.current.drain(..=nl);
        true
    }

    fn is_end(line: &[u8], alg: &str) -> bool {
        line == format!("-----END {alg}-----").as_bytes()
    }

    fn spill(&mut self, bytes: &[u8]) -> Result<(), RedactionError> {
        if self.retained + bytes.len() <= MAX_LINE && self.file.is_none() {
            self.retained += bytes.len();
            return Ok(());
        }
        if self.file.is_none() {
            let path = std::env::temp_dir().join(format!(
                "praana-pem-{}-{}.bin",
                std::process::id(),
                Sha256::digest(bytes)[0]
            ));
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&path).map_err(|_| RedactionError::Failed)?;
            file.write_all(bytes).map_err(|_| RedactionError::Failed)?;
            self.file = Some(file);
            self.path = Some(path);
        } else if let Some(file) = self.file.as_mut() {
            file.write_all(bytes).map_err(|_| RedactionError::Failed)?;
        }
        self.retained = self.retained.saturating_add(bytes.len());
        Ok(())
    }

    fn retained_len(&self) -> usize {
        self.current.len()
    }
}

impl Drop for PemState {
    fn drop(&mut self) {
        self.file.take();
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub struct StreamingRedactor {
    pending: Vec<u8>,
    line: Vec<u8>,
    pem: Option<PemState>,
    discard_until_newline: bool,
    input_hasher: Sha256,
    output_hasher: Sha256,
    kinds: Vec<SecretKind>,
    replacements: usize,
    warnings: Vec<String>,
    failed: bool,
    binary_bytes: u64,
    spool: Option<Box<dyn BinarySpool>>,
}

impl StreamingRedactor {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            line: Vec::new(),
            pem: None,
            discard_until_newline: false,
            input_hasher: Sha256::new(),
            output_hasher: Sha256::new(),
            kinds: Vec::new(),
            replacements: 0,
            warnings: Vec::new(),
            failed: false,
            binary_bytes: 0,
            spool: None,
        }
    }

    pub fn set_spool(&mut self, spool: Box<dyn BinarySpool>) {
        self.spool = Some(spool);
    }

    /// Bytes still held for an undecided boundary. Not the bytes already emitted.
    pub fn retained_len(&self) -> usize {
        self.pending.len()
            + self.line.len()
            + self.pem.as_ref().map(PemState::retained_len).unwrap_or(0)
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<String, RedactionError> {
        if self.failed {
            return Err(RedactionError::Failed);
        }
        self.input_hasher.update(chunk);
        if self.binary_bytes > 0 {
            return self.keep_binary(chunk);
        }
        self.pending.extend_from_slice(chunk);
        if self.pending.len() > 3 && std::str::from_utf8(&self.pending).is_err() {
            let err = std::str::from_utf8(&self.pending).unwrap_err();
            if err.error_len().is_some() || err.valid_up_to() + 3 < self.pending.len() {
                return self.fail_binary();
            }
        }
        let mut emitted = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    let owned = text.to_owned();
                    self.pending.clear();
                    emitted.push_str(&self.consume_text(&owned)?);
                    break;
                }
                Err(err) if err.error_len().is_some() => return self.fail_binary(),
                Err(err) => {
                    let valid = err.valid_up_to();
                    if valid == 0 {
                        if self.pending.len() > 3 {
                            return self.fail_binary();
                        }
                        break;
                    }
                    let owned = std::str::from_utf8(&self.pending[..valid])
                        .map_err(|_| RedactionError::InvalidUtf8)?
                        .to_owned();
                    self.pending.drain(..valid);
                    emitted.push_str(&self.consume_text(&owned)?);
                }
            }
        }
        self.output_hasher.update(emitted.as_bytes());
        Ok(emitted)
    }

    pub fn finish(self) -> Result<RedactedText, RedactionError> {
        match self.finish_stream()? {
            StreamFinish::Text(text) => Ok(text),
            StreamFinish::Binary(_) => Err(RedactionError::InvalidUtf8),
        }
    }

    pub fn finish_stream(mut self) -> Result<StreamFinish, RedactionError> {
        if self.failed && self.binary_bytes == 0 {
            return Err(RedactionError::Failed);
        }
        if self.binary_bytes > 0 || std::str::from_utf8(&self.pending).is_err() {
            let count = self.binary_bytes.max(self.pending.len() as u64);
            self.pending.clear();
            self.line.clear();
            self.pem.take();
            if self.spool.is_some() {
                return Ok(StreamFinish::Binary(BinaryArtifactPending {
                    byte_count: count,
                }));
            }
            return Err(RedactionError::InvalidUtf8);
        }
        let mut tail = String::new();
        if !self.pending.is_empty() {
            let owned = std::str::from_utf8(&self.pending)
                .map_err(|_| RedactionError::InvalidUtf8)?
                .to_owned();
            self.pending.clear();
            tail.push_str(&self.consume_text(&owned)?);
        }
        if let Some(pem) = self.pem.take() {
            let ended = PemState::is_end(&pem.current, pem.alg);
            tail.push_str("[REDACTED:private-key]");
            self.note_kind(SecretKind::PrivateKey);
            self.replacements = self.replacements.saturating_add(1);
            if !ended {
                let warning = "REDACTION_UNTERMINATED_PRIVATE_KEY".to_owned();
                if !self.warnings.contains(&warning) {
                    self.warnings.push(warning);
                }
            }
            drop(pem);
        } else if self.discard_until_newline {
            self.line.clear();
        } else if !self.line.is_empty() {
            let text = std::str::from_utf8(&self.line).map_err(|_| RedactionError::InvalidUtf8)?;
            let redacted = apply_complete(text)?;
            self.observe(&redacted);
            tail.push_str(&redacted.text);
            self.line.clear();
        }
        self.output_hasher.update(tail.as_bytes());
        let summary = summary_from_digests(
            self.input_hasher.clone(),
            self.output_hasher.clone(),
            self.replacements,
            std::mem::take(&mut self.kinds),
        )?;
        Ok(StreamFinish::Text(RedactedText {
            text: tail.clone(),
            tail,
            summary,
            warnings: self.warnings,
        }))
    }

    fn keep_binary(&mut self, chunk: &[u8]) -> Result<String, RedactionError> {
        self.binary_bytes = self.binary_bytes.saturating_add(chunk.len() as u64);
        if let Some(spool) = self.spool.as_mut() {
            spool.write_all(chunk)?;
            Ok(String::new())
        } else {
            self.pending.clear();
            self.line.clear();
            Err(RedactionError::InvalidUtf8)
        }
    }

    fn fail_binary(&mut self) -> Result<String, RedactionError> {
        self.binary_bytes = self
            .binary_bytes
            .saturating_add((self.pending.len() + self.line.len()) as u64);
        if let Some(spool) = self.spool.as_mut() {
            let pending = std::mem::take(&mut self.pending);
            let line = std::mem::take(&mut self.line);
            spool.write_all(&pending)?;
            spool.write_all(&line)?;
            Ok(String::new())
        } else {
            self.pending.clear();
            self.line.clear();
            self.failed = true;
            Err(RedactionError::InvalidUtf8)
        }
    }

    fn consume_text(&mut self, text: &str) -> Result<String, RedactionError> {
        if text.len() > DETECTOR_INPUT_LIMIT {
            return Err(RedactionError::Failed);
        }
        let mut out = String::new();
        for byte in text.bytes() {
            if self.discard_until_newline {
                if byte == b'\n' {
                    self.discard_until_newline = false;
                    out.push('\n');
                }
                continue;
            }
            if let Some(pem) = self.pem.as_mut() {
                pem.push_bytes(&[byte])?;
                if pem.take_end() {
                    self.pem.take();
                    out.push_str("[REDACTED:private-key]");
                    self.note_kind(SecretKind::PrivateKey);
                    self.replacements = self.replacements.saturating_add(1);
                    out.push('\n');
                }
                continue;
            }
            self.line.push(byte);
            if byte == b'\n' {
                out.push_str(&self.flush_complete_line()?);
            } else if self.line.len() > MAX_LINE {
                out.push_str(&self.flush_over_limit()?);
            }
        }
        Ok(out)
    }

    fn flush_complete_line(&mut self) -> Result<String, RedactionError> {
        let line = std::mem::take(&mut self.line);
        let text = std::str::from_utf8(&line).map_err(|_| RedactionError::InvalidUtf8)?;
        let without_nl = &text[..text.len() - 1];
        if let Some(alg) = begin_algorithm(without_nl.as_bytes()) {
            self.pem = Some(PemState::start(alg));
            return Ok(String::new());
        }
        let redacted = apply_complete(text)?;
        self.observe(&redacted);
        Ok(redacted.text)
    }

    fn flush_over_limit(&mut self) -> Result<String, RedactionError> {
        let mut probe = self.line.clone();
        probe.push(b'\n');
        let text = std::str::from_utf8(&probe).map_err(|_| RedactionError::InvalidUtf8)?;
        let redacted = apply_complete(text)?;
        if redacted.summary.kinds.contains(&SecretKind::KeyAssignment) {
            let marker = redacted.text.trim_end_matches('\n').to_owned();
            self.observe(&redacted);
            self.line.clear();
            self.discard_until_newline = true;
            return Ok(marker);
        }
        let hold = TOKEN_OVERLAP.min(self.line.len());
        let mut cut = self.line.len() - hold;
        while cut > 0 && std::str::from_utf8(&self.line[..cut]).is_err() {
            cut -= 1;
        }
        let preview = std::str::from_utf8(&self.line).map_err(|_| RedactionError::InvalidUtf8)?;
        let matches = crate::redaction::detect_secret_matches_v1(preview);
        if let Some(found) = matches
            .iter()
            .find(|item| item.start_byte < cut && item.end_byte > cut)
        {
            cut = found.start_byte;
        }
        let prefix = preview[..cut].to_owned();
        let redacted = apply_complete(&prefix)?;
        self.observe(&redacted);
        self.line.drain(..cut);
        Ok(redacted.text)
    }

    fn observe(&mut self, redacted: &RedactedText) {
        self.replacements = self
            .replacements
            .saturating_add(redacted.summary.replacement_count as usize);
        for kind in &redacted.summary.kinds {
            self.note_kind(kind.clone());
        }
        for warning in &redacted.warnings {
            if !self.warnings.contains(warning) {
                self.warnings.push(warning.clone());
            }
        }
    }

    fn note_kind(&mut self, kind: SecretKind) {
        if !self.kinds.contains(&kind) {
            self.kinds.push(kind);
        }
    }
}

impl Default for StreamingRedactor {
    fn default() -> Self {
        Self::new()
    }
}

fn begin_algorithm(line: &[u8]) -> Option<&'static str> {
    for alg in PEM_ALGORITHMS {
        if line == format!("-----BEGIN {alg}-----").as_bytes() {
            return Some(alg);
        }
    }
    None
}
