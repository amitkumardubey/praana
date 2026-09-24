//! Complete-text secret detector implementing Redaction specification
//! sections 3 and 4 exactly, in report-only form (P1D).
//!
//! Selection semantics (Redaction section 3): scan valid UTF-8 left-to-right;
//! at one byte offset choose the matching detector with the lowest priority
//! number, then the longest byte match, then the kind name ASCII; select one
//! maximal non-overlapping match and continue after it.
//!
//! Key-assignment rules (Redaction section 4) are per logical line; a matching
//! line claims its value span, anchored at the value start so higher-priority
//! token detectors at the same offset win the tie-break. Over-limit lines
//! (longer than 65,536 bytes including LF) claim from after the separator
//! through line end because proving exemption absence is impossible.
//!
//! Streaming (P3A) must make chunked processing observationally equivalent to
//! this complete-input function.

use super::SecretKind;

/// A `(start, end)` byte range, where `end` excludes the trailing LF.
type ByteRange = (usize, usize);

/// One selected high-confidence secret match with byte offsets into the input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretMatchV1 {
    pub kind: SecretKind,
    pub start_byte: usize,
    pub end_byte: usize,
}

const PEM_ALGORITHMS: [&str; 4] = [
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
];
const AWS_PREFIXES: [&str; 8] = [
    "AKIA", "ASIA", "AIDA", "AROA", "AIPA", "ANPA", "ANVA", "ASCA",
];
const GITHUB_SHORT_PREFIXES: [&str; 5] = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"];
const ASSIGNMENT_KEY_SUBSTRINGS: [&str; 9] = [
    "apikey",
    "accesstoken",
    "authtoken",
    "bearertoken",
    "clientsecret",
    "password",
    "passwd",
    "credential",
    "privatekey",
];

/// Logical line budget from Redaction section 4 (including a terminating LF).
const MAX_LINE_BYTES: usize = 65536;

/// Token characters `[A-Za-z0-9_-]`; a token boundary neighbor is outside this set.
fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn at_token_boundary(bytes: &[u8], index: usize) -> bool {
    index == 0 || !is_token_byte(bytes[index - 1])
}

fn ends_at_token_boundary(bytes: &[u8], end: usize) -> bool {
    end == bytes.len() || !is_token_byte(bytes[end])
}

/// Maximal run length of `allowed` bytes starting at `start`.
fn run_len(bytes: &[u8], start: usize, allowed: fn(u8) -> bool) -> usize {
    let mut end = start;
    while end < bytes.len() && allowed(bytes[end]) {
        end += 1;
    }
    end - start
}

fn is_upper_digit(b: u8) -> bool {
    b.is_ascii_digit() || b.is_ascii_uppercase()
}

fn is_github_run_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_key_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.'
}

/// Detect high-confidence secrets in complete valid UTF-8 text.
///
/// Returns selected non-overlapping byte spans in replacement order. No
/// replacement text is generated and the input is never logged or persisted.
pub fn detect_secret_matches_v1(input: &str) -> Vec<SecretMatchV1> {
    let bytes = input.as_bytes();
    let (pem_spans, line_starts, pem_consumed) = pem_scan(bytes);
    let assignment_claims = assignment_claims(bytes, &line_starts, &pem_consumed);

    let mut selected = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let mut candidates: Vec<(u8, usize, SecretKind, usize, usize)> = Vec::new();
        if let Some(&(s, e)) = pem_spans.iter().find(|(s, _)| *s == offset) {
            candidates.push((
                SecretKind::PrivateKey.priority(),
                e - s,
                SecretKind::PrivateKey,
                s,
                e,
            ));
        }
        for (kind, s, e) in fixed_token_candidates(bytes, offset) {
            candidates.push((kind.priority(), e - s, kind, s, e));
        }
        if let Some(&(vs, ve)) = assignment_claims.iter().find(|(s, _)| *s == offset) {
            candidates.push((
                SecretKind::KeyAssignment.priority(),
                ve - vs,
                SecretKind::KeyAssignment,
                vs,
                ve,
            ));
        }
        if let Some(best) = candidates.iter().min_by(|a, b| {
            a.0.cmp(&b.0)
                .then(b.1.cmp(&a.1))
                .then(a.2.name().cmp(b.2.name()))
        }) {
            selected.push(SecretMatchV1 {
                kind: best.2.clone(),
                start_byte: best.3,
                end_byte: best.4,
            });
            offset = best.4;
            continue;
        }
        offset += 1;
    }
    selected
}

/// PEM block scan (priority 1): from a complete `-----BEGIN <alg>-----` line
/// through the matching complete `-----END <alg>-----` line. A block that is
/// still open at end of input claims through the end of input (the streaming
/// EOF behavior of Redaction section 5). Returns the selected spans, the
/// logical line table, and the set of line indices consumed by PEM blocks.
fn pem_scan(bytes: &[u8]) -> (Vec<ByteRange>, Vec<ByteRange>, Vec<usize>) {
    let mut line_starts: Vec<ByteRange> = Vec::new(); // (start, end excluding LF)
    let mut start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            line_starts.push((start, index));
            start = index + 1;
        }
    }
    line_starts.push((start, bytes.len()));

    let mut spans = Vec::new();
    let mut consumed = Vec::new();
    let mut i = 0usize;
    while i < line_starts.len() {
        let (s, e) = line_starts[i];
        let line = &bytes[s..e];
        let mut matched_alg = None;
        for alg in PEM_ALGORITHMS {
            if line == format!("-----BEGIN {alg}-----").as_bytes() {
                matched_alg = Some(alg);
                break;
            }
        }
        let Some(alg) = matched_alg else {
            i += 1;
            continue;
        };
        let end_line = format!("-----END {alg}-----");
        let mut j = i + 1;
        let mut found = None;
        while j < line_starts.len() {
            let (js, je) = line_starts[j];
            if &bytes[js..je] == end_line.as_bytes() {
                found = Some(j);
                break;
            }
            j += 1;
        }
        match found {
            Some(j) => {
                let (_, fe) = line_starts[j];
                spans.push((s, fe));
                for k in i..=j {
                    consumed.push(k);
                }
                i = j + 1;
            }
            None => {
                spans.push((s, bytes.len()));
                for k in i..line_starts.len() {
                    consumed.push(k);
                }
                i = line_starts.len();
            }
        }
    }
    (spans, line_starts, consumed)
}

/// Per-line key-assignment claims (Redaction section 4), keyed by the claimed
/// value's start byte. Lines inside PEM blocks are not candidates.
fn assignment_claims(
    bytes: &[u8],
    line_starts: &[(usize, usize)],
    pem_consumed: &[usize],
) -> Vec<(usize, usize)> {
    let mut claims = Vec::new();
    for (index, &(start, end)) in line_starts.iter().enumerate() {
        if pem_consumed.contains(&index) {
            continue;
        }
        let line = &bytes[start..end];
        let includes_lf = end < bytes.len(); // LF exists when this is not the final line
        let line_len_incl_lf = (end - start) + if includes_lf { 1 } else { 0 };
        if let Some((value_start, value_end)) = match_assignment(line, line_len_incl_lf) {
            claims.push((start + value_start, start + value_end));
        }
    }
    claims
}

/// Match one logical line against Redaction section 4. Returns offsets
/// relative to the line start (excluding any LF) of the claimed value.
fn match_assignment(line: &[u8], line_len_incl_lf: usize) -> Option<(usize, usize)> {
    let over_limit = line_len_incl_lf > MAX_LINE_BYTES;
    let n = line.len();
    let mut p = 0usize;
    while p < n && matches!(line[p], b' ' | b'\t') {
        p += 1;
    }
    if line.len() >= p + 6
        && &line[p..p + 6] == b"export"
        && p + 6 < n
        && matches!(line[p + 6], b' ' | b'\t')
    {
        p += 6;
        while p < n && matches!(line[p], b' ' | b'\t') {
            p += 1;
        }
    }
    let key_start = p;
    while p < n && is_key_byte(line[p]) {
        p += 1;
    }
    let key_len = p - key_start;
    if !(1..=128).contains(&key_len) {
        return None;
    }
    let key = std::str::from_utf8(&line[key_start..p]).ok()?;
    let normalized = normalize_assignment_key(key);
    if !ASSIGNMENT_KEY_SUBSTRINGS
        .iter()
        .any(|needle| normalized.contains(needle))
    {
        return None;
    }
    while p < n && matches!(line[p], b' ' | b'\t') {
        p += 1;
    }
    if p >= n || (line[p] != b'=' && line[p] != b':') {
        return None;
    }
    p += 1;
    while p < n && matches!(line[p], b' ' | b'\t') {
        p += 1;
    }
    if over_limit {
        // Replace after the separator; proving exemption absence is impossible.
        let mut vs = p;
        while vs < n && matches!(line[vs], b' ' | b'\t') {
            vs += 1;
        }
        if vs >= n {
            return None;
        }
        return Some((vs, n));
    }
    let raw_start = p;
    let raw = &line[p..];
    let mut quote_stripped = 0usize;
    let mut raw = raw;
    if raw.len() >= 2 {
        let first = raw[0];
        if (first == b'\'' || first == b'"') && first == raw[raw.len() - 1] {
            raw = &raw[1..raw.len() - 1];
            quote_stripped = 1;
        }
    }
    let trimmed_start = raw.iter().position(|b| !matches!(b, b' ' | b'\t'));
    let trimmed_end = raw.iter().rposition(|b| !matches!(b, b' ' | b'\t'));
    let (Some(ts), Some(te)) = (trimmed_start, trimmed_end) else {
        return None;
    };
    let core = &raw[ts..=te];
    if core.len() < 8 || core.len() > 4096 {
        return None;
    }
    if core.iter().any(|b| b.is_ascii_whitespace()) {
        return None;
    }
    let value = std::str::from_utf8(core).ok()?;
    if is_assignment_exempt(value) {
        return None;
    }
    let value_start = raw_start + quote_stripped + ts;
    Some((value_start, value_start + core.len()))
}

/// ASCII-lowercase and remove `.`/`-`/`_` from an assignment key.
fn normalize_assignment_key(key: &str) -> String {
    key.bytes()
        .filter(|b| *b != b'.' && *b != b'-' && *b != b'_')
        .map(|b| b.to_ascii_lowercase() as char)
        .collect()
}

/// Exemptions: exactly 40 or 64 hexadecimal characters (either case), or an
/// uppercase Crockford ULID of length 26.
fn is_assignment_exempt(value: &str) -> bool {
    let len = value.len();
    if (len == 40 || len == 64) && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return true;
    }
    if len == 26
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
        && !value
            .bytes()
            .any(|b| matches!(b, b'I' | b'L' | b'O' | b'U'))
    {
        return true;
    }
    false
}

/// Fixed-token detector candidates (priorities 2-6) anchored at `offset`.
fn fixed_token_candidates(bytes: &[u8], offset: usize) -> Vec<(SecretKind, usize, usize)> {
    let mut out = Vec::new();
    if !at_token_boundary(bytes, offset) {
        return out;
    }
    for prefix in AWS_PREFIXES {
        if bytes[offset..].starts_with(prefix.as_bytes()) {
            if run_len(bytes, offset + 4, is_upper_digit) == 16
                && ends_at_token_boundary(bytes, offset + 20)
            {
                out.push((SecretKind::AwsAccessKey, offset, offset + 20));
            }
            break;
        }
    }
    for prefix in GITHUB_SHORT_PREFIXES {
        if bytes[offset..].starts_with(prefix.as_bytes()) {
            let run = run_len(bytes, offset + 4, is_github_run_byte);
            if (36..=255).contains(&run) && ends_at_token_boundary(bytes, offset + 4 + run) {
                out.push((SecretKind::GithubToken, offset, offset + 4 + run));
            }
            break;
        }
    }
    if bytes[offset..].starts_with(b"github_pat_") {
        let run = run_len(bytes, offset + 11, is_github_run_byte);
        if (22..=255).contains(&run) && ends_at_token_boundary(bytes, offset + 11 + run) {
            out.push((SecretKind::GithubToken, offset, offset + 11 + run));
        }
    }
    if bytes[offset..].starts_with(b"glpat-") {
        let run = run_len(bytes, offset + 6, is_token_byte);
        if (20..=255).contains(&run) && ends_at_token_boundary(bytes, offset + 6 + run) {
            out.push((SecretKind::GitlabToken, offset, offset + 6 + run));
        }
    }
    if bytes[offset..].starts_with(b"sk-ant-") {
        let run = run_len(bytes, offset + 7, is_token_byte);
        if (20..=255).contains(&run) && ends_at_token_boundary(bytes, offset + 7 + run) {
            out.push((SecretKind::AnthropicKey, offset, offset + 7 + run));
        }
    }
    if bytes[offset..].starts_with(b"sk-") && !bytes[offset..].starts_with(b"sk-ant-") {
        // Redaction §3 priority 6: `sk-`, an optional `proj-` or `svcacct-`
        // label, then 20..255 token bytes. The optional label is not counted
        // inside the 20..255 run, and `sk-ant-` is excluded above.
        let body_start = if bytes[offset + 3..].starts_with(b"proj-") {
            offset + 3 + 5
        } else if bytes[offset + 3..].starts_with(b"svcacct-") {
            offset + 3 + 8
        } else {
            offset + 3
        };
        let run = run_len(bytes, body_start, is_token_byte);
        if (20..=255).contains(&run) && ends_at_token_boundary(bytes, body_start + run) {
            out.push((SecretKind::OpenAiKey, offset, body_start + run));
        }
    }
    out
}
