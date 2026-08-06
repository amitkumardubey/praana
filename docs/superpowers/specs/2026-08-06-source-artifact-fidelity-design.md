# Source Artifact Fidelity Design (Issue #293)

**Date:** 2026-08-06
**Status:** Approved

## Problem

Adaptive Context compaction/distillation degraded precise code artifacts in
session `01KZ6AFBCCS5BWM6Q54PKX5227`. Task-critical source reads were summarised
or stored as JSON transport envelopes (`{"ok":true,"content":...}`) rather than
exact source bytes, forcing the agent to fall back to shell commands for small
slices. Additional gaps:

- **Small reads are never stored.** Outputs at or below `artifact_inline_threshold`
  are inlined and lost once history compacts; nothing backs them for retrieval.
- **Repeat-read index is path-only.** A `read_file` with a different `offset`/`limit`
  is treated as a repeat of an earlier read of the same path, returning a card
  (or block) instead of reading the requested range.
- **TTL eviction can delete raw source.** `evictStaleArtifacts()` removes whole
  rows — including lossless source bytes — based on access age/count.
- **No fidelity telemetry.** Raw size, prompt size, retention class, and
  compaction/eviction reason are not distinguishable.

## Design

### Fidelity classification

Artifacts are classified at ingest:

- **`lossless`** — `read_file` results. Raw bytes are the source of truth,
  byte/line equivalent to the original read. Never distilled, never evicted
  by TTL while the session exists.
- **`summarizable`** — everything else (shell output, diffs, logs, prose).
  Existing storage/card/eviction behavior is unchanged.

### Lossless source artifacts

- Every successful `read_file` result is stored as an artifact, bypassing
  `artifact_inline_threshold`. Small reads get a card instead of inline text.
- The stored `rawText` is the tool result's `content` field (the exact slice
  the agent saw), never the JSON envelope.
- Each source artifact records its original file line range
  (`sourceLineStart`, `sourceLineEnd` from the `read_file` `offset`/`limit`),
  giving a stable line map for retrieval.

### Range-aware repeat detection

- Repeat-read keys are `absPath + offset + limit`. Reading a different range of
  the same file is a fresh read (disk I/O), not a blocked/carded repeat.
- Re-reading the identical path + range returns the existing artifact card and
  counts as a repeat read, unchanged.
- Writes/edits and mtime changes invalidate the path — all range keys for that
  path are cleared.

### Retrieval

- `retrieve_artifact` keeps returning raw bytes.
- For lossless source artifacts with a stored range, `lineStart`/`lineEnd`
  slice using the stored line map (file-relative lines). Requests outside the
  stored range fail with a clear error telling the agent to re-read the file.
- For artifacts without a range (shell output, legacy rows), slicing stays
  relative to the stored content — unchanged behavior.

### Retention and eviction

- `evictStaleArtifacts()` skips `fidelity = 'lossless'` rows: source bytes
  survive for the full session, including resumed sessions.
- Compaction/emergency pressure only drops prompt cards and scored units; it
  never mutates stored artifacts (already true, now tested).
- Deduplication by sha256 and the retrieve-envelope nesting guard are unchanged.

### Telemetry

- Per-artifact metrics: raw token count, prompt-card token count, fidelity,
  retention state, retention reason (`session-source` for lossless,
  `ttl` for summarizable).
- Session summary exposes lossless vs summarizable counts and retained raw
  bytes. No file paths or content enter telemetry/scorecard rows.

## Acceptance criteria mapping

| Criterion | Mechanism |
|---|---|
| Source range byte/line equivalent after compaction | Lossless raw bytes + line map; compaction never touches stored rows |
| Duplicates evicted before primary code | Existing dedup; TTL now skips lossless rows |
| No shell fallback forced by summarised artifacts | `read_file` content stored raw; retrieval returns exact bytes |
| Telemetry distinguishes retention vs summarisation | `fidelity`, `promptTokens`, `retentionReason`, summary totals |

## Out of scope

- Cross-session retention policy for terminated sessions (DB growth is bounded
  by user pruning of session data).
- Distiller behaviour for `summarizable` artifacts.
- `read_and_summarize` (deliberately returns derived summaries; issue #219 scope).
