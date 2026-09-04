# PRAANA Rust v2 Secret Redaction Specification

**Status:** Normative implementation specification

**Redaction version:** `praana-redaction-v1`

**Date:** 2026-09-01

## 1. Authority

This document owns secret detection, replacement precedence, streaming state,
structured traversal, redaction metadata, canary tests, and surface policy.
Tool Runtime owns where redaction runs in its hook order. History hashes and
stores only finalized post-redaction tool results. Provider credentials are
handled by the credential specification and never enter this detector.

Redaction never changes tool execution input. It operates on copies used for
canonical/log/UI tool-call arguments and on finalized tool results before their
canonical serialization. User and accepted assistant conversation text are not
silently rewritten; the UI warns that chat history is stored as entered.

## 2. Types

```rust
pub const REDACTION_VERSION: &str = "praana-redaction-v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SecretKind {
    PrivateKey,
    AwsAccessKey,
    GithubToken,
    GitlabToken,
    AnthropicKey,
    OpenAiKey,
    KeyAssignment,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RedactionSummaryV1 {
    pub redaction_version: String,
    pub replacement_count: u32,
    pub kinds: Vec<SecretKind>,
    pub input_sha256: Sha256Digest,
    pub output_sha256: Sha256Digest,
}
```

Replacement is exactly `[REDACTED:<kind>]`, using the enum's kebab-case value.
Kinds sort by the precedence below and appear once in metadata.

## 3. Text Detector Precedence

Scan valid UTF-8 left-to-right. At one byte offset choose the matching detector
with the lowest precedence number, then the longest byte match, then the kind
name ASCII. Replace one maximal non-overlapping match and continue after it.

| Priority | Kind | Exact detection |
|---:|---|---|
| 1 | `private-key` | Stateful PEM block from a complete line `-----BEGIN ` followed by one of `PRIVATE KEY`, `RSA PRIVATE KEY`, `EC PRIVATE KEY`, `OPENSSH PRIVATE KEY`, then `-----`, through the matching complete `-----END ...-----` line. |
| 2 | `aws-access-key` | ASCII token boundary, prefix `AKIA`, `ASIA`, `AIDA`, `AROA`, `AIPA`, `ANPA`, `ANVA`, or `ASCA`, followed by exactly 16 uppercase ASCII letters/digits, then token boundary. |
| 3 | `github-token` | ASCII token boundary and either `ghp_`, `gho_`, `ghu_`, `ghs_`, or `ghr_` followed by 36..255 ASCII alphanumeric/underscore bytes, or `github_pat_` followed by 22..255 ASCII alphanumeric/underscore bytes. |
| 4 | `gitlab-token` | ASCII token boundary, `glpat-`, then 20..255 ASCII alphanumeric/underscore/hyphen bytes. |
| 5 | `anthropic-key` | ASCII token boundary, `sk-ant-`, then 20..255 ASCII alphanumeric/underscore/hyphen bytes. |
| 6 | `openai-key` | ASCII token boundary, `sk-`, optional `proj-` or `svcacct-`, then 20..255 ASCII alphanumeric/underscore/hyphen bytes; `sk-ant-` is excluded. |
| 7 | `key-assignment` | Section 4. |

ASCII token boundaries mean start/end or a neighboring byte outside
`[A-Za-z0-9_-]`. Detector input is capped at 16 MiB per value; larger values use
the streaming algorithm. Regex implementations must be anchored equivalents of
this table and cannot add heuristic entropy detectors.

## 4. Key Assignment

Process one logical line at a time, maximum 65,536 bytes including LF. Match:

```text
optional whitespace
optional ASCII "export" plus whitespace
key
optional whitespace
one separator from = or :
optional whitespace
value through line end
```

`key` is 1..128 ASCII `[A-Za-z0-9_.-]` bytes. After ASCII lowercase and removing
`.`/`-`/`_`, it must contain one of `apikey`, `accesstoken`, `authtoken`,
`bearertoken`, `clientsecret`, `password`, `passwd`, `credential`, or
`privatekey`. Value removes one matching outer single/double quote and trims
ASCII space/tab. It must be 8..4096 bytes and contain no whitespace after trim.
Do not redact values matching exactly lowercase/uppercase hexadecimal length 40
or 64, or an uppercase Crockford ULID of length 26. Replace only value bytes,
preserving key, separator, quotes, whitespace, and LF.

Over-limit lines are replaced after the separator with
`[REDACTED:key-assignment]` because proving absence is impossible; metadata
records one replacement.

## 5. Streaming

`StreamingRedactor` accepts arbitrary byte chunks and emits UTF-8 only after
boundaries are decidable. It keeps:

- an incremental UTF-8 decoder with at most 3 pending bytes;
- one logical line up to 65,536 bytes for assignment matching;
- at most 512 trailing bytes for fixed token detectors;
- a PEM state containing begin kind and bytes since begin, spooled to a
  restrictive temporary file after 65,536 bytes.

Fixed token maximum match length is 267 bytes; 512 is the normative overlap.
PEM is a state machine, not overlap regex. A matching end emits one replacement.
EOF inside a PEM block also emits one private-key replacement and a warning
`REDACTION_UNTERMINATED_PRIVATE_KEY`. Invalid UTF-8 tool text becomes binary
artifact data and is not replacement-decoded; structured metadata around it is
still redacted.

Chunking at every byte offset must produce exactly the same output/summary as a
single complete input.

## 6. Structured Traversal

For JSON-like tool arguments/results, visit object values in ASCII-sorted key
order and arrays in index order. Keys are not rewritten. String values run text
redaction. Before a string value, if its containing key satisfies assignment-key
normalization, treat the entire non-exempt value as `key-assignment` without
requiring `=`. Numbers/bools/null are unchanged. Nested depth is capped at 64;
over-depth tool output fails finalization rather than bypassing redaction.

Traversal preserves object keys, array order, numeric values, and all non-secret
string bytes. Tool Runtime then RFC-8785 serializes the finalized
`ToolResultDto`; History never reruns redaction.

## 7. Surface Matrix

| Surface | Input | Policy |
|---|---|---|
| Tool execution | original model arguments | no mutation |
| Canonical tool-call event | copied arguments | redact |
| Tool-result DTO/artifact/search | finalized result | redact before hash/store |
| UI/IPC tool rows | canonical redacted copy | no second mutation |
| Logs/errors/tracing fields | any dynamic string | redact, then length bound |
| User/assistant messages | accepted text | do not rewrite; restrict diagnostics |
| Project instructions | file bytes | report-only detector; block on high-confidence match |
| Credentials/opaque reasoning | must not enter detector | boundary violation if observed |

Redaction failure blocks persistence/provider continuation for that tool result;
it never stores unredacted bytes as fallback. A false positive is recoverable
only from the original workspace/external source, not History.

## 8. Version and Metadata

Changing a pattern, precedence, exemption, replacement, traversal, or streaming
rule requires a new redaction version. Artifacts persist the version and
summary. Rebuild/search uses stored redacted bytes and does not apply a newer
version retroactively.

## 9. Fixtures

Fixtures include every prefix at min/max/over length, token boundaries,
Anthropic/OpenAI overlap, quoted assignments, SHA/ULID exemptions, PEM variants,
unterminated PEM, 65,536/65,537-byte lines, invalid UTF-8, nested structures,
duplicate secret occurrences, and every one-byte streaming split. Canary values
are syntactically valid fake tokens generated only in tests and asserted absent
from output, events, artifacts, FTS, UI, logs, errors, and operation ledgers.

## 10. Bounded Implementation Packet

```text
crates/praana-core/src/redaction/mod.rs
crates/praana-core/src/redaction/detectors.rs
crates/praana-core/src/redaction/assignment.rs
crates/praana-core/src/redaction/stream.rs
crates/praana-core/src/redaction/json.rs
crates/praana-core/tests/redaction_v1.rs
crates/praana-core/tests/redaction_stream_v1.rs
```

1. Write complete and byte-split golden tests; expected red is unresolved
   `redaction`.
2. Implement fixed detectors/precedence and assignment exemptions until complete
   text tests pass.
3. Implement streaming UTF-8/line/PEM state and make all chunk partitions equal.
4. Implement structured traversal and Tool Runtime integration; run canary
   end-to-end tests.
5. Run fmt, clippy with warnings denied, workspace tests, and fuzz corpora.

Non-goals: redacting user chat, reversible vaulting, entropy guessing, credential
storage, or sanitizing terminal control sequences. Common mistakes: a blanket
`sk-` rule before Anthropic, fixed overlap for PEM, logging detector errors with
input, redacting hashes/ULIDs, and hashing tool results before redaction.
