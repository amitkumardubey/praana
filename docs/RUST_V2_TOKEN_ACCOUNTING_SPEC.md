# PRAANA Rust v2 Token Accounting and Unicode Utility Specification

**Status:** Normative implementation specification

**Token estimator schema version:** 1

**Unicode utility version:** `praana-unicode-15.1-v1`

**Date:** 2026-08-31

## 1. Scope and Authority

This document is the direct and final authority for token estimation,
component accounting, estimator identity, rounding, provider-tokenizer
delegation, calibration, persisted token estimates, and the shared Unicode
utilities used by exact session search and StateGraph lexical matching.

The following systems MUST use this contract and MUST NOT define a local
estimator:

- History Storage artifact decisions at the effective
  `history.artifact_inline_tokens` and
  `history.artifact_batch_inline_tokens` boundaries.
- History Storage artifact preview bounds and persisted artifact estimates.
- StateGraph active-tail and object token bounds.
- Memory plugin bootstrap and digest token accounting.
- Request admission components, provider framing, and safety margin
  calibration.
- Compaction turn mass, segment bounds, handoff bounds, and persisted
  compaction estimates.

Provider specifications own literal wire formatting. History Storage owns
content-aware artifact preview generation. Compaction owns admission and
retirement policy. Those owners submit exact rendered components to this
estimator and do not redefine token weights, normalization, or rounding.
`docs/RUST_V2_CONFIG_SPEC.md` exclusively owns every configurable bound and
default named by this specification.

## 2. Versioned Types and Exact Serialization

All ID fields use protocol newtypes. Hash fields use protocol
`Sha256Digest`. The exact serialized estimate is:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TokenEstimateV1 {
    pub token_estimator_schema_version: u32,
    pub estimator_id: String,
    pub tokenizer_profile_id: Option<String>,
    pub input_sha256: Sha256Digest,
    pub content_tokens: u64,
    pub framing_tokens: u64,
    pub total_tokens: u64,
}
```

Every field is required in JSON. `tokenizer_profile_id` is present as JSON
`null` for the generic estimator. Canonical serializers MUST NOT use
`skip_serializing_if`. The schema version is `1`.

`input_sha256` is SHA-256 of the exact bytes submitted as the content input.
For a provider request component, those are the exact wire-equivalent content
bytes before transport encoding. For canonical JSON, they are RFC 8785 bytes.
For a rendered handoff, StateGraph tail, memory digest, or artifact preview,
they are the exact UTF-8 rendering bytes. Framing bytes or constants are bound
through the pinned tokenizer profile and are not appended to `input_sha256`.

Checked addition is mandatory and:

```text
total_tokens = content_tokens + framing_tokens
```

Overflow is `TOKEN_ACCOUNTING_OVERFLOW` and fails the enclosing admission or
bound check. Counts never use floating point.

## 3. Estimator Selection

One `TokenEstimatorV1` interface selects exactly one content estimator and one
framing profile for each estimation context:

```rust
pub trait TokenEstimatorV1: Send + Sync {
    fn estimator_id(&self) -> &str;

    fn estimate(
        &self,
        context: TokenEstimationContext,
        exact_content: &[u8],
        framing: &FramingProfileV1,
    ) -> Result<TokenEstimateV1, TokenAccountingError>;
}
```

Selection order is:

1. A provider/model tokenizer profile pinned as specified in section 5.
2. A provider-adapter estimate profile pinned as specified in section 6.
3. The generic estimator `praana-generic-unicode-15.1-v1` from section 4.

Selection is resolved once for an exact provider/protocol/model revision and
recorded in the capability-profile hash. Artifact, preview, StateGraph, and
memory bounds that are not associated with a target provider use the generic
estimator. A request for a known target provider uses that request's selected
estimator for all request components so component sums are comparable.

An estimator implementation, vocabulary, merge table, normalization rule,
framing rule, or Unicode data change requires a new `estimator_id`. Reusing an
ID for different behavior is non-conforming.

## 4. Generic Unicode Estimator

### 4.1 Input normalization

The generic estimator accepts valid UTF-8 only. It does not apply NFC, NFD,
NFKC, case folding, lowercasing, whitespace collapsing, or line-ending
normalization. The owning renderer must submit exactly the bytes whose bound is
being tested. This prevents token accounting from changing canonical content.

Provider adapters that normalize text before wire serialization submit the
post-normalization wire-equivalent text. Artifact decisions submit exact
post-redaction canonical result bytes. Invalid UTF-8 content is never estimated
as replacement text for inline admission; binary content is artifactized and
uses section 4.4.

### 4.2 Unicode data

Character classification is generated from Unicode 15.1.0 data checked into
the repository. The generated tables and their source manifest are part of
`praana-unicode-15.1-v1`. Runtime platform libraries, locale, ICU installation,
OS version, and Rust standard-library character predicates MUST NOT alter a
classification.

The manifest names and SHA-256 hashes these Unicode Character Database inputs:

```text
UnicodeData.txt
Scripts.txt
PropList.txt
DerivedCoreProperties.txt
emoji-data.txt
CaseFolding.txt
DerivedNormalizationProps.txt
NormalizationTest.txt
```

The build MUST use checked-in generated range/mapping tables. It MUST NOT fetch
Unicode data during a normal build or test.

### 4.3 Scalar weights and rounding

Each Unicode scalar contributes integer twelfths of a token. Classification is
first-match in this order:

| Class | Exact Unicode 15.1 property/range | Units |
|---|---|---:|
| Ignored format | U+200D, U+FE00..U+FE0F, U+E0100..U+E01EF | 0 |
| CJK script | Script is Han, Hiragana, Katakana, or Hangul | 8 |
| Symbol/emoji | `Extended_Pictographic` or General Category starts with `S` | 12 |
| Other scalar | Every other valid Unicode scalar, including whitespace and combining marks | 3 |

For one complete component:

```text
content_tokens = ceil(sum(scalar_units) / 12)
```

An empty component has zero content tokens. Rounding happens once per component,
never per scalar and never only after unrelated components are combined.

### 4.4 Binary input

Binary tool results are never inline. For persisted size telemetry only, their
generic estimate is:

```text
content_tokens = ceil(byte_count / 3)
```

The estimate represents a conservative base64-like transfer cost. It does not
authorize binary prompt injection. `input_sha256` still hashes the exact binary
bytes.

## 5. Provider Tokenizer Delegation

A provider tokenizer may replace generic content counting only when the model
capability profile pins all of:

- Provider, protocol, exact model ID, and model revision rule.
- `tokenizer_profile_id` and implementation version.
- Vocabulary/merge/config file SHA-256 values or an immutable provider library
  version.
- Text normalization and special-token policy.
- Message, image, tool schema, tool-call, tool-result, continuation, and request
  framing rules.
- A checked-in conformance fixture set.

The estimator ID has the form
`provider-tokenizer:<provider>:<tokenizer-profile>:<version>`. Model aliases that
can change tokenizer behavior without a revision cannot claim exact delegation.
An unavailable or fixture-failing tokenizer falls back to a pinned adapter
estimate or the generic estimator and records that fallback.

Tokenizers count the exact wire-equivalent component content. They MUST NOT
tokenize encrypted reasoning as plaintext. Opaque continuation uses the pinned
profile's explicit opaque-item estimate and is never assigned zero by default.

## 6. Adapter Estimate and Framing Profiles

A provider adapter may supply deterministic integer framing constants when an
exact tokenizer cannot account for protocol wrappers. The exact type is:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FramingProfileV1 {
    pub framing_profile_schema_version: u32,
    pub framing_profile_id: String,
    pub fixed_tokens: u64,
    pub per_item_tokens: u64,
    pub item_count: u64,
    pub additional_tokens: u64,
}
```

All JSON fields are required. Framing is calculated with checked arithmetic:

```text
framing_tokens = fixed_tokens
               + per_item_tokens * item_count
               + additional_tokens
```

`additional_tokens` is computed by the owning adapter only from a fixture-pinned
rule for typed non-text items such as images or opaque continuation. It is not a
free safety padding field. Safety margin is accounted separately by admission.

An adapter estimate ID has the form
`adapter-estimate:<provider>:<protocol>:<profile-version>`. Its checked-in
profile must state whether generic or provider-tokenizer content counting is
used. Framing profiles are immutable under one ID.

## 7. Component Boundaries

The following boundaries are normative.

### 7.1 Artifact decisions

History Storage serializes one finalized post-redaction `ToolResultDto` into its
exact complete canonical bytes and estimates that byte string as one component.
A result is over the per-result threshold only when
`TokenEstimateV1.total_tokens > history.artifact_inline_tokens`. Equality
remains eligible for inline storage.

For the `history.artifact_batch_inline_tokens` budget, process results in
provider call order and add
the complete estimate of each result that is individually eligible for inline
storage. A result remains inline only when the checked new sum is at most the
effective batch budget. Artifact preview estimates do not enter this sum, but each preview enters
request admission as part of its tool-result message.

The threshold decision persists `estimator_id`, `input_sha256`, and token count
with the body/provenance record. Re-estimation under a later estimator does not
rewrite a durable event.

### 7.2 Preview, StateGraph, memory, and compaction

- An artifact preview is estimated from its complete History-owned rendered
  preview, including retrieval instructions and framing owned by that renderer.
- A StateGraph bound is estimated from the complete deterministic candidate
  tail. Individual object diagnostics estimate each exact rendered object line.
- A memory digest is estimated from its complete deterministic rendered digest.
  Entry selection may estimate candidate rendered entries separately, but the
  final complete digest MUST be re-estimated before acceptance.
- Compaction turn mass estimates each projected turn's exact model-visible real
  messages as one named turn component under the target request estimator.
- Summary and handoff bounds estimate their complete deterministic renderings,
  not model candidate JSON.

Compaction `source_input_sha256` is SHA-256 of the RFC 8785 ordered JSON array of
selected per-turn `TokenEstimateV1` objects. Compaction `output_input_sha256` is
SHA-256 of the RFC 8785 two-element array containing the finalized segment and
handoff rendering estimates in that order. Their checked token sums are the
corresponding persisted source/output counts.

No owner may subtract shared wrapper text, round a partial field separately, or
silently switch estimators to make a value fit.

### 7.3 Request admission

Admission receives these separately rounded components:

```text
system
tool_schema
memory_bootstrap
handoff
retained_messages
state_graph
active_tool_cycle
continuation
provider_framing
```

The Compaction specification may combine adjacent components in its public
telemetry DTO, but the estimator computes and records every component above.
`provider_framing` has zero content tokens and the request framing profile's
framing tokens. Checked sum of all component totals is the estimated request
input occupancy.

The request estimate manifest is the ordered RFC 8785 canonical JSON array of
the nine complete `TokenEstimateV1` objects above, in exactly that order.
`estimated_input_sha256` in admission DTOs is SHA-256 of those manifest bytes.
It binds component bytes, estimator/framing identities, and rounding without
pretending the separately hashed provider wire request is one text component.

## 8. Persisted Estimates

Every canonical or derived persisted token estimate MUST be interpretable with:

- `token_estimator_schema_version`.
- Exact `estimator_id`.
- `tokenizer_profile_id`, present as null when absent.
- `input_sha256` of the estimated bytes.
- Rounded token count.

A table may normalize the schema version and estimator ID into session metadata
only when all rows in that table use one estimator. Model-specific turn-mass or
request estimates MUST carry their estimator and input hash per row/sample.
On read, a hash mismatch makes the estimate stale; it is never reused for
admission or compaction selection.

Persisted artifact threshold decisions are historical facts and remain valid
under the estimator recorded at finalization. Persisted derived request/turn
estimates may be recomputed when the target model or estimator changes.

## 9. Calibration

Calibration compares the exact preflight request estimate with comparable
provider-reported input occupancy:

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TokenCalibrationSampleV1 {
    pub token_calibration_schema_version: u32,
    pub provider: String,
    pub protocol: String,
    pub model: String,
    pub model_revision: Option<String>,
    pub estimator_id: String,
    pub request_hash: Sha256Digest,
    pub estimated_input_tokens: u64,
    pub reported_input_tokens: u64,
    pub signed_error_tokens: i64,
    pub positive_error_tokens: u64,
    pub cached_input_tokens: Option<u64>,
    pub compaction_epoch: u32,
    pub timestamp_ms: i64,
}
```

All fields are required in JSON and option fields are present as null.

```text
signed_error_tokens = reported_input_tokens - estimated_input_tokens
positive_error_tokens = max(0, signed_error_tokens)
```

The subtraction uses checked conversion to signed range. Cached input remains
part of occupancy unless the pinned provider profile documents otherwise.
Samples with placeholder zero usage, mismatched request hashes, changed
estimator IDs, or provider-documented non-comparable accounting are excluded
and counted as telemetry.

Maintain the latest 128 comparable samples for one exact provider, protocol,
model revision, and estimator ID. With at least 20 samples, calibration margin
`C` is the nearest-rank p95 of positive error plus 128 tokens. Before 20 samples,
`C` is zero. Changing estimator identity starts a new calibration bucket but
does not delete old telemetry.

Calibration is a runtime safety input, not evidence that an estimator is exact.
Release-quality rates are measurement targets until a checked-in corpus and
evaluator define their population and confidence method.

## 10. Shared Unicode Utilities

Token estimation itself performs no normalization. Search and StateGraph use
the following separate, versioned utilities from the same checked-in Unicode
15.1.0 tables.

### 10.1 `default_casefold_v1`

`default_casefold_v1` applies Unicode Default Case Folding from
`CaseFolding.txt`, using status `C` and `F` mappings, excluding Turkic-only `T`
mappings. It does not apply normalization before or after folding. It is locale
independent.

History exact search uses:

- Case-sensitive mode: literal Unicode scalar substring over original text.
- Case-insensitive mode: literal Unicode scalar substring after applying
  `default_casefold_v1` to both query and candidate.

Match offsets are mapped back to original source scalar boundaries through a
fold-expansion index built during folding. A match that starts or ends inside
one source scalar's expansion reports that complete source scalar range.

### 10.2 `nfkc_casefold_v1`

`nfkc_casefold_v1` applies the Unicode 15.1 `NFKC_Casefold` mapping from
`DerivedNormalizationProps.txt`, then canonical composition using the pinned
Unicode 15.1 normalization tables. It is locale independent.

StateGraph lexical matching applies `nfkc_casefold_v1` before its pinned token
split and stop-word rules. It MUST NOT call platform lowercase, locale-aware
case conversion, an unversioned regex Unicode class, or the host filesystem's
case behavior.

SQLite FTS is a ranked discovery facility, not the implementation of exact
search or StateGraph matching. Its SQLite build/version and tokenizer options
remain pinned by History Storage fixtures.

## 11. Required Fixtures

The checked-in token fixture format contains exact escaped input, UTF-8 input
hash, scalar classes/units, framing profile, and expected estimate. It includes
at least:

| Escaped input | Generic units | Content tokens |
|---|---:|---:|
| `` | 0 | 0 |
| `abcd` | 12 | 1 |
| `abcde` | 15 | 2 |
| `\u{4E2D}\u{6587}` | 16 | 2 |
| `\u{1F600}` | 12 | 1 |
| `\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}` | 48 | 4 |
| `\u{2764}\u{FE0F}` | 12 | 1 |
| `e\u{0301}` | 6 | 1 |
| `a\r\nb` | 12 | 1 |

The CRLF fixture proves that the generic estimator does not normalize line
endings. An owner that converts it to LF has a different `input_sha256` and
fixture.

Unicode utility fixtures include:

| Utility | Escaped input | Escaped output |
|---|---|---|
| `default_casefold_v1` | `Stra\u{00DF}e` | `strasse` |
| `default_casefold_v1` | `\u{03A3}\u{03C2}\u{03C3}` | `\u{03C3}\u{03C3}\u{03C3}` |
| `default_casefold_v1` | `\u{0130}I\u{0131}` | `i\u{0307}i\u{0131}` |
| `nfkc_casefold_v1` | `\u{212A}` | `k` |
| `nfkc_casefold_v1` | `\u{FB03}` | `ffi` |
| `nfkc_casefold_v1` | `\u{FF21}/\u{FF22}` | `a/b` |

Run all fixtures on Linux, macOS, and Windows. Output must be byte-identical.

Boundary fixtures are required for:

- Artifact decisions at one below, exactly at, and one above the effective
  per-result threshold: the first two remain inline when aggregate budget
  permits and the last artifactizes.
- Provider-ordered aggregate batches at one below, exactly at, and one above the
  effective batch budget, including reverse physical completion order.
- Artifact previews at their exact configured limit and one token over.
- StateGraph active tails and memory digests at their exact limits and one token
  over.
- Request components whose individual ceilings differ from ceiling after one
  combined sum.
- Provider tokenizer fallback and estimator-ID change invalidation.
- Calibration exclusion, bucket selection, nearest-rank p95, and checked
  arithmetic.

## 12. Errors

| Internal code | Meaning | Retryable |
|---|---|---|
| `TOKEN_INVALID_UTF8` | Text estimator input is not valid UTF-8 | No |
| `TOKEN_PROFILE_UNKNOWN` | Requested tokenizer/framing profile is absent | No |
| `TOKEN_PROFILE_FIXTURE_FAILED` | Pinned estimator failed self-check | No; fallback may be used |
| `TOKEN_ACCOUNTING_OVERFLOW` | Checked integer accounting overflowed | No |
| `TOKEN_INPUT_HASH_MISMATCH` | Persisted estimate does not match current bytes | Yes after re-estimation |
| `TOKEN_BOUND_EXCEEDED` | Exact rendered component exceeds owner bound | Depends on owner recovery |

These are internal token-accounting codes. They map through the normative error
mapping appendix in `RUST_V2_PROTOCOL_SPEC.md`; they are not required to be
identical to provider, tool, History, StateGraph, or IPC surface strings.

## 13. Acceptance Criteria

Token accounting is accepted only when:

1. Every scalar classification, integer sum, rounding point, and framing rule
   matches checked-in fixtures on every supported platform.
2. Every bounded subsystem records the estimator identity and input hash needed
   to reproduce its estimate.
3. Artifact threshold decisions are independent of parallel completion order.
4. Request component totals equal the checked sum supplied to admission.
5. A model, tokenizer, framing, renderer, or estimator version change prevents
   stale estimate reuse.
6. Exact search and StateGraph lexical fixtures do not vary with locale,
   platform, filesystem, Rust version, or installed Unicode libraries.
7. Provider usage calibration cannot retroactively admit a request and cannot
   mix incomparable samples.
8. No specialized subsystem contains another generic scalar-weight algorithm.
