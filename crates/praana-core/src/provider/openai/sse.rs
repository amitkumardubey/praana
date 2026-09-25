//! Incremental, provider-independent SSE byte parser.

use super::error::ProviderErrorCode;

pub const MAX_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_EVENT_DATA_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_UNDECODED_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseFrame {
    pub event: Option<String>,
    pub id: Option<String>,
    pub data: String,
    pub retry_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseFailure {
    pub code: ProviderErrorCode,
}

pub struct SseParser {
    pending: Vec<u8>,
    bom_done: bool,
    event: Option<String>,
    id: Option<String>,
    data: Vec<String>,
    data_bytes: usize,
    retry_ms: Option<u64>,
    saw_field: bool,
}

impl Default for SseParser {
    fn default() -> Self {
        Self::new()
    }
}

impl SseParser {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
            bom_done: false,
            event: None,
            id: None,
            data: Vec::new(),
            data_bytes: 0,
            retry_ms: None,
            saw_field: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseFrame>, SseFailure> {
        if self.pending.len().saturating_add(chunk.len()) > MAX_UNDECODED_BYTES {
            return Err(fail(ProviderErrorCode::SseFrameTooLarge));
        }
        self.pending.extend_from_slice(chunk);
        self.drain(false)
    }

    pub fn finish(&mut self) -> Result<Vec<SseFrame>, SseFailure> {
        let frames = self.drain(true)?;
        if !self.pending.is_empty() || self.saw_field {
            return Err(fail(ProviderErrorCode::StreamTruncated));
        }
        Ok(frames)
    }

    fn drain(&mut self, eof: bool) -> Result<Vec<SseFrame>, SseFailure> {
        if !self.bom_done {
            if self.pending.starts_with(&[0xEF, 0xBB, 0xBF]) {
                self.pending.drain(..3);
            } else if !eof
                && self.pending.len() < 3
                && self.pending.iter().all(|b| *b == 0xEF || *b == 0xBB)
            {
                return Ok(Vec::new());
            }
            self.bom_done = true;
        }
        let mut frames = Vec::new();
        loop {
            let Some(split) = find_line_end(&self.pending, eof) else {
                if self.pending.len() > MAX_LINE_BYTES {
                    return Err(fail(ProviderErrorCode::SseFrameTooLarge));
                }
                break;
            };
            let (line_bytes, consumed) = split;
            if line_bytes > MAX_LINE_BYTES {
                return Err(fail(ProviderErrorCode::SseFrameTooLarge));
            }
            let raw = self.pending[..line_bytes].to_vec();
            self.pending.drain(..consumed);
            let line = std::str::from_utf8(&raw)
                .map_err(|_| fail(ProviderErrorCode::StreamInvalidUtf8))?;
            if line.is_empty() {
                if self.saw_field {
                    frames.push(self.take_frame());
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            self.saw_field = true;
            self.apply_field(line)?;
        }
        let _ = eof;
        Ok(frames)
    }

    fn apply_field(&mut self, line: &str) -> Result<(), SseFailure> {
        let (name, value) = match line.split_once(':') {
            Some((name, rest)) => {
                let value = rest.strip_prefix(' ').unwrap_or(rest);
                (name, value)
            }
            None => (line, ""),
        };
        match name {
            "data" => {
                let extra = value.len() + if self.data.is_empty() { 0 } else { 1 };
                if self.data_bytes.saturating_add(extra) > MAX_EVENT_DATA_BYTES {
                    return Err(fail(ProviderErrorCode::SseFrameTooLarge));
                }
                self.data_bytes += extra;
                self.data.push(value.to_owned());
            }
            "event" => self.event = Some(value.to_owned()),
            "id" => {
                if value.contains('\0') {
                    return Err(fail(ProviderErrorCode::ProtocolViolation));
                }
                self.id = Some(value.to_owned());
            }
            "retry" if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
                self.retry_ms = value.parse().ok();
            }
            _ => {}
        }
        Ok(())
    }

    fn take_frame(&mut self) -> SseFrame {
        let frame = SseFrame {
            event: self.event.take(),
            id: self.id.take(),
            data: self.data.join("\n"),
            retry_ms: self.retry_ms.take(),
        };
        self.data.clear();
        self.data_bytes = 0;
        self.saw_field = false;
        frame
    }
}

fn find_line_end(bytes: &[u8], eof: bool) -> Option<(usize, usize)> {
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\n' => return Some((index, index + 1)),
            b'\r' => {
                let consumed = if bytes.get(index + 1) == Some(&b'\n') {
                    index + 2
                } else if index + 1 == bytes.len() && !eof {
                    return None;
                } else {
                    index + 1
                };
                return Some((index, consumed));
            }
            _ => index += 1,
        }
    }
    None
}

fn fail(code: ProviderErrorCode) -> SseFailure {
    SseFailure { code }
}

pub fn parse_sse_bytes(bytes: &[u8]) -> Result<Vec<SseFrame>, SseFailure> {
    let mut parser = SseParser::new();
    let mut frames = parser.push(bytes)?;
    frames.extend(parser.finish()?);
    Ok(frames)
}
