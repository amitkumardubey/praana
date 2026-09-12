# PRAANA Rust v2 Implementation Handoff

**Status:** Normative packet index

**Date:** 2026-09-01

## 1. Purpose

This is the entry point for implementation models. Do not ask one model to
implement `RUST_V2_PLAN.md`. Give it exactly one packet row, the listed owner
sections, and the current repository. Architecture decisions are out of scope
for packet workers.

Every packet follows this loop:

1. Read only listed owners and direct imported type definitions.
2. Check a clean/understood worktree and run the packet baseline.
3. Add the named failing fixtures/tests first.
4. Run the named focused command and confirm the expected red reason.
5. Implement only the listed files/contracts.
6. Run focused green command, owner integration tests, fmt, clippy, workspace
   tests, and any platform command listed by the owner.
7. Return diff, commands/output, unresolved mismatch, and no unrelated refactor.

If an owner is contradictory or a required type is undefined, stop and escalate
to specification review. Do not choose a new schema, fallback, default, retry,
storage layout, or security rule while coding.

## 2. Global Gates

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
bun typecheck
bun test
```

Bun gates remain required while TypeScript is an oracle/client. A later packet
may remove them only at the Ratatui cutover gate.

## 3. Packet Dependency Order

```text
P0
 |
 +--> P1A --> P1B --> P1C
 |      |       |       |
 |      +--> P1D       +--> P2B
 |              |             |
 +--------------+--> P2A -----+
                              |
                 P3A --> P3B --> P3C
                                  |
                            P4A --> P4B
                                  |
                                 P5
                                  |
                                 P6
                                  |
                                 P7
                                  |
                       P8 (new specs first)
                                  |
                                 P9
```

## 4. Packet Index

### P0: Workspace and Oracle Fixtures

- Owner: `RUST_V2_PHASE_0_EXECUTION.md` complete document.
- Output: workspace crates, pure native split, deterministic clock/monotonic ID
  foundation, provider/safety/UI fixture inventories; no runtime protocol.
- Focused commands: exact Phase 0 commands and gates in that document.

### P1A: Config, Unicode, Token Foundation

- Owners: `RUST_V2_CONFIG_SPEC.md` sections 1-18;
  `RUST_V2_TOKEN_ACCOUNTING_SPEC.md` sections 1-14.
- Output: strict Config loader/snapshot/digest, pinned Unicode utilities,
  generic estimator and profile loader. Provider network is absent.
- Focused tests: `config_v1`, `token_accounting_v1`, `unicode_v15_1`.
- Red reason: unresolved config/token/unicode modules only.

### P1B: Canonical Protocol and Event Store

- Owners: `RUST_V2_PROTOCOL_SPEC.md` sections 1-18;
  `RUST_V2_HISTORY_STORAGE_SPEC.md` Phase 1 packet.
- Depends: P1A.
- Output: exact canonical DTOs, event append/recovery, accepted projection,
  attempts/turns/tool state validation, interruption capsules; no provider HTTP
  and no SQLite-derived search/artifacts.
- Focused tests: `protocol_v2`, `history_phase1`.

### P1C: Permanent UI Contract and Operation Idempotency

- Owners: `RUST_V2_UI_CONTRACT.md` sections 1-14;
  History sections 5.3 and 16.1.
- Depends: P1B.
- Output: semantic commands/results/events, sink policy, session/host operation
  ledgers and crash recovery. No IPC or Ratatui.
- Focused tests: `ui_contract_v1`, `ui_sink_backpressure`,
  `operation_idempotency`.

### P1D: System and Project Context

- Owner: `RUST_V2_SYSTEM_CONTEXT_SPEC.md`.
- Depends: P1A.
- Output: exact stable policy, AGENTS/project/stack/skills discovery and slot
  bytes. No provider wire formatting.
- Focused test: `system_context_v1`.

### P2A: Provider Registry, Credentials, and Setup

- Owners: `RUST_V2_PROVIDER_CATALOG_CREDENTIAL_SPEC.md`; Config provider fields;
  UI setup/auth/catalog DTOs.
- Depends: P1A, P1C.
- Output: closed OpenAI/OpenRouter registry, model profiles/live cache,
  credentials, setup/login/logout. No chat completion.
- Focused tests: `provider_registry_v1`, `credentials_v1`, `setup_v1`.

### P2B: OpenAI/OpenRouter Runtime and Hard Admission

- Owners: `RUST_V2_OPENAI_SPEC.md` sections 1-25; Compaction sections 2-4;
  Token request components; Protocol provider continuation.
- Depends: P1B, P1D, P2A.
- Output: pure request/SSE conversions then fake-server transport, local
  Responses continuation, current OpenAI encrypted reasoning/phase behavior,
  pre-emission retry, exact resolved output reserve and hard admission. No
  pressure compaction.
- Focused test: `openai_v1` plus protocol provider fixtures.

### P3A: Redaction and Common Tool Runtime

- Owners: `RUST_V2_REDACTION_SPEC.md`; `RUST_V2_TOOL_RUNTIME_SPEC.md` common
  runtime packet.
- Depends: P1B.
- Output: redaction, typed/erased tools, strict schemas, registry, intents,
  hook pipeline, locks, process supervision, canonical result serialization.
  No built-in tool is enabled yet.
- Focused tests: `redaction_v1`, `redaction_stream_v1`,
  `tool_runtime_phase3`.

### P3B: Artifact and Journal Substrate

- Owner: `RUST_V2_HISTORY_STORAGE_SPEC.md` Phase 3 packet.
- Depends: P3A.
- Output: exact SQLite schema, canonical result artifactization, preview,
  spools/journals, recovery. No FTS/search/StateGraph.
- Focused test: `history_artifacts`.

### P3C: Phase 3 Built-ins and Headless Loop

- Owners: `RUST_V2_BUILTIN_TOOL_CATALOG_SPEC.md` Phase 3 sections;
  Tool Runtime orchestration; Plan Phase 3.
- Depends: P2B, P3A, P3B.
- Output: file/edit/search/test/git-read/shell tools and provider-independent
  headless turn loop. No Phase 4/6/8 tools.
- Focused tests: `builtin_tools_phase3`, tool fault/process tests, scripted fake
  provider end-to-end.

### P4A: History Retrieval and Search

- Owner: `RUST_V2_HISTORY_STORAGE_SPEC.md` Phase 4 packet; Built-in history
  tools.
- Depends: P3C.
- Output: binary-safe retrieval, exact/regex/FTS search, authenticated cursors,
  rebuild and deletion.
- Focused test: `history_search`.

### P4B: StateGraph

- Owners: `RUST_V2_STATE_GRAPH_SPEC.md`; Built-in state tools.
- Depends: P4A.
- Output: event-derived graph, transitions/revisions, checkpoint, active tail,
  automation, state tools/search integration.
- Focused test: `state_graph_v1`.

### P5: Pressure and Compaction

- Owner: `RUST_V2_COMPACTION_SPEC.md` complete document.
- Depends: P2B, P4A, P4B.
- Output: pressure/hysteresis, exact control prompt/schema, committed and
  interrupted closed-unit selection, immutable segment/handoff, activation,
  emergency retry and calibration.
- Focused test: `compaction_v1` plus history/protocol fault fixtures.

### P6: Optional Memory Plugin

- Owner: `RUST_V2_MEMORY_PLUGIN_SPEC.md` complete document.
- Depends: P4B, P5.
- Output: default none, full plugin contract, explicit builtin SQLite,
  deterministic recall/digest/extraction/maintenance and capability tools.
- Focused tests: `memory_contract_v1`, `memory_builtin_sqlite_v1`,
  `memory_extraction_v1`.

### P7: Temporary OpenTUI IPC

- Owner: `RUST_V2_IPC_SPEC.md`; UI Contract conversion fixtures.
- Depends: P1C and headless Phases 1-6.
- Output: framing/handshake/conversion/ack/backpressure/restart and TypeScript
  presentation adapter. No semantic DTO duplication.
- Focused tests: `ipc_ui_contract_v1`, `ipc_framing`, `ipc_backpressure`,
  `ipc_restart`, OpenTUI PTY suite.

### P8: Provider and Tool Parity

- Owner: a new approved provider spec and Built-in Tool Catalog schema 2 for
  each provider/tool family before coding. Plan Phase 8 is not itself an
  implementation packet.
- Depends: P7.
- Stop condition: do not implement reserved Phase 8 names from prose or the
  TypeScript oracle alone.

### P9: Ratatui and Cutover

- Owner: `RUST_V2_RATATUI_SPEC.md`; UI Contract only for semantics.
- Depends: all approved P8 parity/deletion decisions.
- Output: in-process Ratatui, virtual transcript, editor/overlays, platform and
  performance gates, standalone release, then TypeScript deletion.
- Focused gates: reducer/snapshot/PTY suites and reference-class benchmark.

## 5. Review Checklist for Every Packet

- Diff changes only listed files or an owner-required fixture/data file.
- Tests failed for the expected missing behavior before implementation.
- Exact IDs, hashes, JSON bytes, ordering, and errors match owner fixtures.
- No secret, opaque reasoning, unredacted tool bytes, or absolute test path was
  added to fixtures/logs.
- Crash/cancellation tests cover every new durability boundary.
- Full gates pass; skipped platform work is explicitly reported.
- Documentation owner is updated when evidence changes a contract.
- Implementation did not add compatibility, fallback, config key, provider,
  tool, plugin, or UI behavior outside the packet.
