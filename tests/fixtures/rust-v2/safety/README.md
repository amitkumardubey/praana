# Rust v2 Phase 0 safety-hook and tool-result fixtures (legacy TypeScript)

These fixtures are **non-normative TypeScript observations** captured from the
current production hook pipeline and the `src/turn.ts` tool path. They record
today's behavior as evidence for the Rust v2 migration. They do not predeclare
the future Tool Runtime contract; that behavior is owned by
`docs/RUST_V2_TOOL_RUNTIME_SPEC.md`.

## `legacy-ts/pipeline/` — hook-pipeline ordering evidence

Each file records one bounded fact about the current pre/post hook pipeline
(plan → validate → risk → circuit → write-path acquire, then lsp → verify →
enrich → redact → circuit accounting → write-path release). Every file contains
exactly these top-level keys:

- `scenario`, `tool_name`, `args`
- `pre_trace` (only `plan`, `validate`, `risk`, `circuit`, `write_path`,
  `lsp_snapshot`) and `post_trace` (only `lsp`, `verify`, `enrich`, `redact`,
  `circuit_accounting`, `write_path_release`) — test-harness observation
  metadata, not a production API
- `execute` (`ran` or `skipped`)
- `dispatch` (the exact current pre/post dispatch results; `post` is `null`
  when the tool body never runs)
- `result` (the exact agent-facing legacy TypeScript result)

## `legacy-ts/tool-results/` — agent-facing result shapes

Exact current shapes for a pre-block with suggestions (captured through the
production `runTurn` orchestration path), a successful result containing a
secret canary after redaction, an enriched failed result after redaction, and a
thrown post handler that is logged while later post handlers continue.
`pre-hook blocks are converted through `toolResultFromPreBlock` and never run
the post pipeline.

## Capture rules

- Driven with injected filesystem, risk, circuit, LSP, verification, logger,
  and tool-body fakes. No workspace mutation, subprocess, prompt, or network.
- Secret canaries are never committed; only typed redaction markers such as
  `[REDACTED:aws-access-key]` appear.
- Path values use the injected workspace root in already-sanitized form
  (`/workspace/praana`).
- Fixed tool names, call ids, and content; nothing from the environment, host
  clock, or checkout path.
- `manifest.json` binds every oracle source file listed in the Phase 0 packet
  Section 4.4 plus every data fixture by SHA-256. Tests recompute all digests
  and never rewrite goldens.
