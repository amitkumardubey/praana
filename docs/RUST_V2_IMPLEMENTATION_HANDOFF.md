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
 +--> P1A --> P1B --> P1C --> P2A --> P2B ------+
 |              |                               |
 |              +--> P1D --> P3A --> P3B -------+--> P3C --> P3D --> P4A --> P4B
                                                                              |
                                                                             P5
                                                                              |
                                                                             P6
                                                                              |
                                                                        W403 --> W402
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
- Property tests: `cargo test -p praana-core properties::` (§17.2; fixture-seeded
  proptest suite in `crates/praana-core/src/properties.rs`, including one-mutation
  invalid traces with narrow expected codes).
- Phase 3 artifact fixtures (`12_*`, `e22_*`, `e23_*`) are present under
  `tests/fixtures/protocol_v2/` but skipped by Phase 1 runners until the
  artifact packet owns them.
- Fuzz targets (§17.3) are not yet checked in; `cargo-fuzz` is not part of the
  default toolchain gate for this packet.
- Implementation modules: `crates/praana-core/src/protocol/*`,
  `crates/praana-core/src/history/{event_log,replay,projection,recovery}.rs`.
  `operation_ledger.rs` is P1C.

### P1C: Permanent UI Contract and Operation Idempotency

- Owners: `RUST_V2_UI_CONTRACT.md` sections 1-14;
  History sections 5.3 and 16.1.
- Depends: P1B.
- Output: semantic commands/results/events, sink policy, session/host operation
  ledgers and crash recovery. No IPC or Ratatui.
- Focused tests: `ui_contract_v1`, `ui_sink_backpressure`,
  `operation_idempotency`.
- Implementation modules: `crates/praana-core/src/ui_contract/*`,
  `crates/praana-core/src/history/operation_ledger.rs`.
- `execute_core_command` returns honest `Unavailable` until later packets own
  effects. IPC is P7; Ratatui is P9. This packet does not depend on Syntect;
  `syntax_theme` membership is the Syntect 5.2 `ThemeSet::load_defaults` names.

### P1D: System and Project Context

- Owner: `RUST_V2_SYSTEM_CONTEXT_SPEC.md`.
- Depends: P1A, P1B. P1B supplies the immutable `meta.json` write/read boundary;
  P1D supplies its project-context provenance value. P3A depends on P1D because
  it reuses P1D's report-only detector.
- Output: exact stable policy, AGENTS/project/stack/skills discovery, slot bytes,
  immutable project-context source provenance in session metadata, and the
  report-only high-confidence secret detector. No replacement, streaming,
  structured redaction, tool hook, or provider wire formatting.
- Focused test: `system_context_v1` only, including detector and metadata-resume
  cases. Expected initial red reason: unresolved `system_context` and
  `redaction::detectors` modules/API.
- Focused command: `cargo test -p praana-core --test system_context_v1`.
- Acceptance gate: this command is green; exact source/discovery/render/hash and
  changed-on-resume fixtures pass; and no P1D code formats an OpenAI request or
  transforms a secret.
- Spec reconciliation note (evidence-changed contract): Redaction §2 declares
  `SecretKind::OpenAiKey` under `#[serde(rename_all = "kebab-case")]` while §3's
  precedence table lists the kind as `openai-key`. serde's default kebab-case
  yields `open-ai-key`, contradicting the §3 table. P1D resolves this in favor of
  the normative §3 table (the canonical kind enumeration used by the
  `[REDACTED:<kind>]` replacement format) by pinning
  `#[serde(rename = "openai-key")]` on the `OpenAiKey` variant, so the
  serialized `kind` value equals the §3 table string. This is documented in
  `RUST_V2_REDACTION_SPEC.md` §2 and reflected in `cases.json`.
- P1D gates status: green. `cargo test -p praana-core --test system_context_v1`
  (13/13), `cargo fmt --all -- --check`, and
  `cargo clippy --workspace --all-targets -- -D warnings` all pass; full
  `cargo test --workspace` passes.
- P2B owns deferred OpenAI integration: `openai_v1` request-body/slot-placement
  fixtures consume P1D's unchanged `InstructionSlotsV1` bytes.

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
- Output: pure request/SSE conversions then local `tokio::net::TcpListener`
  transport, local Responses continuation, current OpenAI encrypted
  reasoning/phase behavior, pre-emission retry for approved transient
  failures, exact resolved output reserve and hard admission. Phase 2 does
  not retry provider context-length responses and does not send
  `previous_response_id`. No pressure compaction.
- Prerequisite packet, before the OpenAI runtime: minimal
  `crates/praana-core/src/tools/` contract and `tool_contract_p2b` tests;
  protocol `Sha256Digest::digest_bytes` and removal of token-owned
  `Sha256Digest` / `TurnId` shadows; provider and token profile fields and
  tests; Tokio `net` / `io-util` and Reqwest `stream` features; Config
  runnable model IDs `gpt-5.6-sol` and `openai/gpt-5.6-sol`; provider fixture
  kind `provider-v1` and the inventory checker. Normative §21 fixtures under
  `tests/fixtures/rust-v2/providers/v1/` are authorized for the later P2B
  runtime, not this prerequisite packet. Tool execution and other P3A
  runtime work are not authorized.
- Focused test: `openai_v1` plus protocol provider fixtures. Prerequisite
  focused tests: `tool_contract_p2b`, `provider_registry_v1`,
  `token_accounting_v1`, `config_v1`, and
  `tests/rust-v2-provider-fixtures.test.ts`.
- Runtime packet lands in `crates/praana-core/src/provider/openai/`
  (`mod`, `chat`, `responses`, `sse`, `error`, `usage`, and `attempt` for
  durable attempt ordering), `crates/praana-core/tests/openai_v1.rs`,
  `crates/praana-core/tests/openai_matrix.rs`, and the normative §21 files
  under `tests/fixtures/rust-v2/providers/v1/`. Schema v1 still does not send
  `previous_response_id`. `openai_matrix` is a second test binary, so both
  `cargo test -p praana-core --test openai_v1` and `--test openai_matrix`
  are required. `RetryLedger` fsyncs each retry before send in its own log
  under three fixed attempt ids; a turn loop cannot append those retries
  onto a caller-supplied session store through this type.

### P3A: Redaction and Common Tool Runtime

- Owners: `RUST_V2_REDACTION_SPEC.md`; `RUST_V2_TOOL_RUNTIME_SPEC.md` common
  runtime packet.
- Depends: P1B, P1D.
- Output: redaction transformation, typed/erased tools, strict schemas, registry,
  intents, hook pipeline, locks, process supervision, canonical result
  serialization. It reuses P1D's `redaction::detectors::detect_secret_matches_v1`
  rather than implementing a second detector. No built-in tool is enabled yet.
- Focused tests: `redaction_v1`, `redaction_stream_v1`,
  `tool_runtime_phase3`.
- Landed in `praana-core`: streaming redaction with a bounded line and PEM
  spool, the fixed hook pipeline, canonical path locks, Unix process-group
  supervision, and a Windows Job Object supervisor. `ResultCommit` is the
  post-release seam P3B fills. This packet does not write start/finish events
  or claim crash recovery. `ErasedTool::execute_erased` stays on the public
  trait. The Windows path is implemented and has not been executed on the
  Linux authoring host. An uncooperative side-effect timeout reports status
  uncertain with `E_TOOL_SIDE_EFFECT_UNCERTAIN` in `error.details`; the DTO
  `error.code` field remains `TOOL_INTERNAL`.

### P3B: Artifact and Journal Substrate

- Owner: `RUST_V2_HISTORY_STORAGE_SPEC.md` Phase 3 packet.
- Depends: P3A.
- Output: exact SQLite schema, canonical result artifactization, preview,
  spools/journals, recovery. No FTS/search/StateGraph.
- Focused test: `history_artifacts`.
- Landed in `praana-core`: `history::{artifact,db,error,journal,preview,spool}`
  plus recovery integration. A fresh `history.db` is schema v1, including the
  unused FTS tables, so P4A does not need a migration to add retrieval.
  Artifactization follows provider `call_index` order. A referencing finish is
  appended only after the artifact transaction commits. Recovery proves an
  orphan before rolling a journal back, and a spool is removed only after the
  child, one supervisor, and the process tree are proved dead.
- Still open, and not chosen by this packet: the history schema accepts only
  UTF-8 `application/vnd.praana.tool-result+json;version=1`, while Tool Runtime
  §18.5 also describes `application/octet-stream`. A dangling finish stays in
  `events.jsonl`. `projection()` replays that prefix and does not drop the
  result. P3C must stop on a failed `run_recovery` and must not present
  `projection()` as accepted history after `E_ARTIFACT_MISSING` or
  `E_ARTIFACT_HASH_MISMATCH`.

### P3C: Phase 3 Built-ins and Headless Loop

- Owners: `RUST_V2_BUILTIN_TOOL_CATALOG_SPEC.md` Phase 3 sections;
  Tool Runtime orchestration; Plan Phase 3.
- Depends: P2B, P3A, P3B.
- Output: file/edit/search/test/git-read/shell tools and provider-independent
  headless turn loop. No Phase 4/6/8 tools.
- Focused tests: `builtin_tools_phase3`, `crash_recovery`, tool fault/process
  tests, scripted fake provider end-to-end.
- Landed in `praana-core`: Phase 3 built-ins register through the P3A catalog
  (`read_file` 400 through `shell` 1100). The headless loop admits through the
  existing `admit` function, appends `assistant_attempt_started` before the
  provider boundary, and publishes tool results through `ArtifactStore::publish_batch`.
  Disabled tools drop out of the provider catalog without renumbering. Non-UTF-8
  process output is stored as base64 `BinaryDataV1` inside the JSON tool result
  so P3B can artifactize it; history still accepts only that JSON media type.
  Overflow keeps draining, marks truncation, and keeps the bounded prefix.
  Non-UTF-8 captured output sets a binary marker so History stores it as a
  binary artifact with a non-textual preview, even when the JSON result is
  small. Admission derives component bytes from the canonical request body
  and ignores provider-supplied component arrays. `StepProvider::complete`
  can return success only with a send authorization for that exact body. This
  P3C adapter boundary verifies the body presented by the adapter; it does not
  own the provider socket or prove transmitted bytes, and transport retry
  within a live attempt remains an explicitly deferred packet. Recovery of a
  crash-lost provider attempt is in P3C: it creates a fresh, fully admitted
  attempt only while the configured total-attempt budget allows it; otherwise
  recovery interrupts the turn with `provider_failure`.
  Provider failure text is redacted and bounded before `assistant_attempt_failed`.
  Canonical tool-call arguments in `assistant_step_accepted` are a redacted
  copy; `raw_arguments` is the canonical JSON of that copy so replay equality
  holds, while execution uses the original in-memory arguments.
  `tool_execution_started.arguments_hash` is the hash of that redacted copy.
  A poisoned runtime rejects further turns before another user message or
  provider call. An uncertain side effect keeps its path lease until the task
  is proved stopped: on a live Tokio runtime the lease waits with the aborted
  task, and off that runtime drop blocks until the task ends. Unix atomic
  replace creates the temp mode `0600`, writes and syncs, then applies the
  destination mode immediately before rename. Literal nested `sh -c` / `bash -c`
  scripts are classified as command lists; a dynamic or unparsed shell script
  fails closed. A durable tool start is written when the call enters its
  parallel slot, so a call still waiting on that slot finishes without a start
  id. The Windows Job Object and direct-argv `CreateProcessW` path remain
  compiled and were not executed on the Linux host. Extra tools are registered
  only in crate tests, not on the public loop config.

  The process-abort hooks are compiled only by the test-only `failpoints`
  feature. Release compilation with that feature is a hard error. In debug
  builds the hooks are inert until the dedicated integration-test executable
  calls the hidden test arm; environment variables alone cannot arm them, and
  production entrypoints do not call that arm. Packaging therefore uses the
  normal no-feature build, while `crash_recovery` explicitly opts into the
  feature and arm. The focused matrix enumerates all 25 event fsyncs of its
  multi-cycle P3 scenario; recovery of a started read-only call with an
  unstarted peer completes that peer in the original batch without replaying
  finished calls. A two-file journal matrix aborts after prepare, replacement,
  entry durability, and commit, checking rollback and persistent conflicts.
  Windows write/edit/batch built-ins are omitted from the provider catalog
  and reject direct invocation under an approved temporary Built-in Catalog
  exception. Handle-anchored, reparse-safe Windows write/edit/batch operations
  are required before P7 and before any editor-client release (tracking issue
  `chronosiq/praana#402`). Durable batch completion orders references by provider
  ordinal even when the caller supplies a permuted request vector. Linux and
  macOS CI execute the event and two-file journal crash matrices; Windows CI
  compiles the core and requires a real fast-fail, panic rejection, and the
  fail-closed write/catalog tests. Windows also runs non-durable
  `provider_ordinal_ordering_without_a_durable_session` (the same call-ordering
  helper used by durable completion) and the crash harness tests that do not
  create sessions. Only the named durable-session tests below
  are skipped on Windows under the owner-approved P3C capability gap: since
  P1B, Windows History session creation has failed closed without private ACLs.
  Durable Windows sessions remain unsupported until `chronosiq/praana#403`;
  this is not a P3C defect. Do not bypass the ACL check. The Redaction owner
  approved the version-scoped per-leaf invariant: recovery executes an
  unstarted call only when every durable argument leaf lacks a marker;
  otherwise it cancels without running the body, independently of safe peers
  in the same batch. Acceptance fails closed on an unmarked argument mutation.
  After a replacement attempt is accepted, the live loop appends
  `attempt_superseded`; fresh-process recovery repairs a missing relation once.
  Existing `write_file`/`batch_write` targets, rollback before-images, and
  journal-staged payloads use bounded streaming hashing/comparison and
  restoration through confined, no-follow handles, without a 16 MiB
  existing-target ceiling; preflight (`check_planned`) validates an existing
  write target's hash the same way before any body runs. Journal commit and rollback verify the bytes they
  actually copy into the target-directory temp against the recorded digest in
  the same streamed pass that performs the copy (`confine::replace_file_from_reader_verified`),
  so there is no separate hash-then-copy window a concurrent write could slip
  through; a single-pass regression fails a design that would rewind and
  reread. `edit_file` and `batch_edit` reject any existing target above 16 MiB
  with the same stable validation error as `read_file`. They read each target
  through a confined handle, apply exact-once edits and same-path chains in
  memory, and install only the hashed result. `batch_edit` caps distinct
  target images at 32 MiB aggregate and transformed results at 48 MiB
  aggregate (including at most 16 MiB growth from batch input). Preflight
  checks target sizes before materializing images. Batch preflight is read-only;
  it creates no scratch or temporary workspace files before risk approval,
  the path lease, and the durable tool start. The batch journal verifies its
  staged digest against the transform result before reporting success;
  cross-path rollback remains unchanged. `ToolRuntime::set_session` canonicalizes the session
  root, mirroring `set_workspace`, so confined journal payload opens
  (staged/before-image files, both session-root-relative) cannot fail behind
  a symlinked path component (observed on macOS `TMPDIR`, where `/var`
  aliases `/private/var`); a same-platform regression opens the session
  through a manually created symlink. The 16 MiB `read_file` and edit-target
  limits and 16 MiB batch *input* limit remain owner-specified. The non-Unix
  `open_regular` fallback is
  not handle-anchored and stays tracked under
  [`#402`](https://github.com/chronosiq/praana/issues/402); Windows mutations
  remain unavailable until that packet lands.

  **Windows-only skips (each requires durable History session creation):**
  each entry is linked to the private-ACL gate and is explicitly excluded by
  the workflow's Windows-conditional capability step, not by an unconditional
  disabled step. The child harness and real-abort identity tests still run.

  - `crash_after_accepted_marked_step_cancels_without_starting_body` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_accepted_mixed_step_replays_safe_peer_and_cancels_marked_call` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_accepted_step_runs_unstarted_calls_once` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_artifact_blob_before_commit` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_artifact_commit_before_event_recovers_exact_result` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_attempt_started_durable_before_provider` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_attempt_started_write_before_fsync` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_batch_complete_write_before_fsync` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_batch_completed_runtime_boundary` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_event_write_before_fsync_is_a_real_process_abort` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_every_event_fsync_boundary` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_finish_event_write_before_fsync_preserves_exact_result` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_first_tool_start_marks_mutation_uncertain_and_skips_peer` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_later_tool_start_preserves_first_result` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_redaction_before_artifact` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_terminal_step_before_commit` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_tool_body_before_redaction` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_after_turn_committed` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_during_fragmented_provider_output_never_accepts_partial` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_during_batch_edit_validation_leaves_workspace_unchanged` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_during_recovery_is_idempotent` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `crash_during_supersession_repair_is_idempotent` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `environment_alone_cannot_arm_failpoints` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `malformed_tail_recovers_exact_valid_prefix` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `replacement_acceptance_crash_repairs_supersession_once_in_fresh_process` ([#403](https://github.com/chronosiq/praana/issues/403))
  - `durable_batch_completion_uses_provider_ordinals_not_input_vector_order` ([#403](https://github.com/chronosiq/praana/issues/403))

### P3D: Headless CLI and Real StepProvider Binding (`#405`)

- Owners: this packet's execution contract below; Config v1 §§2–3, 6–9, 12.3;
  Protocol §§8, 11–12, 14; OpenAI §§4, 7–9, 12–19; History §§2–4, 9, 12;
  Provider Catalog/Credential §§5–6; UI Contract §§1, 3, 6–7; Ratatui §6
  (sink separation only); P1D instruction slots and Phase 3 Tool Runtime risk.
- Depends: P3C; P4A depends on P3D. Implement P3D only after this packet's
  revision is on `main`. An unmerged working tree is not that gate.
- Output: a real P2B-backed `StepProvider` and a bounded Rust headless CLI.
  No IPC, TUI, setup wizard, new provider, new tools, new config key, P5
  compaction, or TypeScript replacement. Windows durable creation/resume stays
  fail-closed until W403; Windows mutation tools stay unavailable until W402.

**CLI grammar and configuration (P3D only).** The Rust executable accepts
`praana run "<task>" [options]` and `praana resume <session-id> [options]`.
Exactly one nonempty positional task (literal argument, not a shell command)
for `run`; exactly one canonical uppercase 26-character session ID or UI
Contract 12-character uppercase `ResumeSelector` for `resume`. Resolve the
selector against valid manifests under the *current effective* `session.root`;
zero matches fails, multiple matches fails with sorted full IDs (never choose
most recent). Resume takes no new task: continue an unfinished turn via P3C
recovery, or, if the session is Ready, report its ID and exit success without
calling the provider or creating a turn. `run` always creates a new session;
never implicitly resumes. Capture the process cwd as the absolute normalized
workspace before Config discovery; require an existing directory, do not create
it and do not silently substitute git root or session root. Paths for sessions
are `<effective session.root>/<canonical SessionId>/`; lock/manifest and
private permissions follow History. Never create a session until CLI, workspace,
Config and setup/phase validation pass. `run` loads Config v1 once with that cwd
and writes its non-secret snapshot and manifest before accepting the user turn.
`resume` loads and validates current sources, locates the existing manifest,
and verifies the creation snapshot and digest. It then applies Config §12.3
(`resolve_resume_config`) before History recovery and before accepted
projection: creation semantics stay frozen, current logging, retention, and
grace apply, incognito is the logical OR, and one warning lists changed key
names only. Recovery, including any fresh provider attempt, uses that frozen
composite. Resume cannot override a frozen field by CLI flag or by an
environment override.

The sole field overrides are Config §9: `--provider`, `--protocol`, `--model`,
`--context-window`, `--reasoning`, `--max-output-tokens`, `--max-steps`,
`--incognito`, `--debug`; `--config <path>` is a source selector, not a field
(or use `PRAANA_CONFIG` with CLI taking precedence). Accept these flags for
`run`; for `resume`, accept `--config` and `--debug` only, and reject every
other field flag rather than silently ignoring it. Flags may appear before or
after the single positional. A second positional is exit 2. `--` ends flag
parsing; the next argument is that positional even when it begins with `-`.
`--incognito` and `--debug` take no value. A value-taking flag without its
value, a duplicate flag, or an unknown flag is exit 2 before session creation.
Accepted informational forms are `praana --help`, `praana --version`, and those
same flags on `run` and `resume`. They write to stdout, exit 0, create no
session, and read no credential. Top-level `--help` names `run` and `resume`.
`--version` includes the `praana-cli` package version. Remaining help prose is
not golden. `--help` and `--version` are handled before the positional
requirement, so `praana run --help` does not also require a task. Any other
flag or positional beside that informational flag is exit 2. With no
subcommand, and for unknown commands, extra positionals,
`--prompt`, `--json`, `--quiet`, `--max-attempts`, `--yes`, `--allow-risk`,
`--cwd`, `--session`, `--no-*`, and every other option, write usage to stderr,
leave stdout empty, and exit 2 before session creation. No stdin task, implicit
interactive mode, default resume selector, automatic setup, or login. This
Rust grammar does not redefine the still-live TypeScript CLI.

**Outputs and process results.** Plain UTF-8 only. For `run` and `resume`,
stdout contains only assistant *accepted* text, in accepted block order (each
accepted step's text once; no tool calls, reasoning summaries, refusals, tool
outputs, provider metadata, ANSI, or boot banners). `--help` and `--version`
are the stdout exceptions above. Render an accepted text block's exact UTF-8
bytes; add one LF only if the last emitted byte is not LF before the next
block or the end of stdout. Do not flush optimistic deltas to stdout:
UI-contract provisional
`AssistantDelta` is reversible, pipes are not. Consume deltas in a bounded
per-attempt sink (or the UI Contract's `NullUiSink`); publish only after
`assistant_step_accepted` is durable. Never replay earlier accepted blocks to
stdout on `resume`; print only blocks newly accepted by this invocation.
Diagnostics go to stderr, one LF-terminated line each: `CONFIG_*` for Config
and setup, UI-contract `SessionNotFound` or `ResumeSelectorAmbiguous` for
selector lookup, and canonical `E_*` code plus class for provider and protocol
failures. The ambiguous selector then prints the sorted full session IDs, one
per line. No diagnostic contains a raw provider body, credential, secret,
opaque continuation, or unredacted tool bytes. `--debug` changes log level
only. When a resume ID is required, write
`Resume ID: <12-character selector>\n` to stderr exactly once, after
diagnostics, never to stdout. A ready resumed session writes no stdout. Its
only P3D status line is that resume ID. Config log records may also appear on
stderr when `logging.stderr` is true; they are not another resume ID.
No JSONL/stdout UI protocol is introduced; P7/P9 retain UI Contract semantics.

Exit status for `run` and `resume`. These commands never use Config's exit 78.

| Outcome | Exit | Resume ID |
|---|---|---|
| Committed turn, including one committed by recovery in this process | `0` | Yes, when the session is healthy |
| Ready session resumed with no new turn | `0` | Yes |
| CLI grammar, missing or non-directory workspace, selector lookup, Config, setup, or phase failure before session start is durable | `2` | No |
| Admission rejection before `assistant_attempt_started`, including durable `turn_interrupted` / `active_turn_too_large` after `turn_started` | `2` | Yes, when that interruption is durable and the session is healthy |
| Prepare or canonical-protocol failure before attempt start, after the open turn is interrupted | `1` | Yes, when that interruption is durable and the session is healthy |
| `incompatible_continuation`, provider or transport failure, credential or auth failure after durable attempt start, tool or runtime failure, History write failure, exhausted retry, or `step_limit` | `1` | Yes, when the session is healthy |
| Failed fsync of a terminal attempt or interruption event | `1` | No. Do not recover in-process merely to print an ID. A later successful `resume` recovers before any ID |
| Irrecoverable integrity or poisoned recovery | `1` | No. Retain the directory |
| SIGINT or other user cancellation | `130` | Yes, when the interruption or ready state is durable and the session is healthy |
| SIGTERM shutdown | `143` | Yes, under the same durability rule |

If the fsync of `turn_interrupted` or `assistant_attempt_failed` fails, the
failed-fsync row wins over an earlier exit-2 or exit-1 row: exit `1` and do
not print a resume ID. When cancellation is observed, the SIGINT or SIGTERM
row wins over admission, prepare, and provider rows. A turn already committed
still exits `0`.

A committed turn exits `0` even if a signal is observed only after
`turn_committed` is durable. Every `turn_interrupted` is nonzero. Once session
start is durable and History can open it, a nonzero exit keeps that session
directory for explicit resume. A valid interrupted turn follows P3C recovery
and bounded attempts, not a fresh user turn. Before durable session start
there is no ID and no resumable session. On irrecoverable recovery, do not
delete the directory or report success.

On SIGINT or SIGTERM, stop new attempts, cancel HTTP, backoff, and tool work,
wait up to `session.shutdown_grace_ms` for P3C interruption and durable
finishes, then terminate without accepting partial output. If grace expires,
leave the started attempt or batch for normal crash recovery; do not erase it.
A second signal may force exit but never writes a synthetic accepted step.
Both commands are headless even on a TTY: never prompt for risk. Tool Runtime
enforces `risk.allow` (Config arrays replace, not append). A denied
confirm-tier action returns a redacted denied tool result, with no external
action and no interactive fallback. Do not equate a model's final text with
successful completion when the turn is interrupted.

**StepProvider join (no parallel owners).** P3D extends the P3C boundary rather
than defining another request DTO, history log, or admission function. `prepare`
projects only accepted Protocol/History conversation, validates complete tool
batches/artifact hashes and compatible active continuation, fills P1D
`InstructionSlotsV1` and Phase 3 tool catalog, resolves P2A profile/capabilities,
and uses P2B `format_chat_body`/`format_responses_body` for the selected OpenAI
Chat, OpenAI Responses, or OpenRouter Chat profile. Chat tool results remain in
provider call order; Responses preserves output item order, encrypted reasoning
and phase in the Protocol-owned `ProviderContinuation` of the accepted step,
never in stdout. No `previous_response_id`, OpenRouter Responses, system
conversation message, second projection, or made-up provider call ID. The
request body is secret-free. P3C's admission must use this *exact final body*
for the token components and request hash, with trusted profile, image count,
framing and effective resolved output limit (including safe reduction). Format
again if the output reserve changes, then re-admit; never transmit the original
body with a different reserved limit. `PreparedRequest.component_bytes` is
not authority. One frozen `AdmittedRequest::body` is serialized for send;
`authorize_send` verifies that value/hash, and transport verifies the exact
serialized bytes it actually uploads. No credential or header construction
before admission. P2A credential-store row then exact provider env fallback
resolves only after admission **and durable attempt start**, immediately
before the send; absence fails safely with no network. No CLI/adapter-owned auth cache or secret in events.

The **session** P3C controller is the sole attempt allocator/writer: before
*each* network send (initial, tool continuation, retry, crash-recovery retry),
run the full OpenAI §17 admission pipeline, append/fsync Protocol
`assistant_attempt_started` with fresh `attempt_id`, contiguous attempt number,
`retry_of`, exact model/request hash/admission and recovery notices, then resolve
credential and allow network bytes. On failed credential resolution after start, append/fsync
`assistant_attempt_failed` with Protocol Appendix A's `E_PROVIDER_AUTH` /
`authentication` (`auth_missing` when no store row or environment fallback),
empty partial output and zero usage, `observable_delta_emitted = false`,
`provider_may_have_completed = false`, then append/fsync `turn_interrupted`
with `provider_failure` and the failed attempt ID. Do **not** retry, send,
accept a step or claim success. Exit 1 and print the resume selector on stderr
if both terminal events are durable and the session is healthy. If either
terminal append fails, exit 1 with no new network action; retain the session
for History recovery, but do not advertise it as resumable until recovery
succeeds. There is no credential preflight or exit-2 missing-key path. P2B's `RetryLedger` contains a
separate fixed-ID test log; `run_with_retry`/`dispatch_after_admission` as
currently shaped MUST NOT be called from the live loop (they own extra starts
and/or hidden sends). Reuse their pure HTTP/SSE/error/retry-classification and
delay helpers only. To retry, return a typed pre-emission retryable outcome to
P3C; it durably fails the old attempt, applies OpenAI §18 bounded jitter/hints
and 60-second wall cap under cancellation, then calls `prepare`/admit/start
again within `turn.max_attempts` (at most three per purpose). No retry after
first semantic emission, invalid output, context-length failure, auth error,
or cancellation. On crash, History/P3C first marks a started, unclosed attempt
lost, then makes a **fresh** admitted/start attempt only if budget allows;
never replay lost partial output. Do not count an in-memory resend as the same
canonical attempt. Failure to fsync start means no send; failure to fsync
terminal failure means no retry.

The P2B streaming parser converts Chat/Responses/OpenRouter deltas, complete
call IDs and JSON object arguments, finish reason and usage into Protocol-owned
accepted assistant message blocks/continuation through the P3C controller;
P2B never appends accepted events itself. P3C persists the full converted
step and any Responses continuation before executing tools; next request
uses only that accepted active continuation and completed ordered results.
Metadata/usage alone never count as emission or an accepted empty step. First
nonempty text, refusal, reasoning, tool-start, or argument delta crosses
OpenAI's emission barrier; provider retry is forbidden thereafter even if no
UI sink received it. Leave Protocol `observable_delta_emitted` false unless a
user-visible text or reasoning-summary delta was produced. A refusal,
tool-start, or argument delta still forbids retry and does not by itself rewind
a delta the sink never received. Buffer provisional text separately from
stdout. On partial
failure/cancel, fail attempt, issue UI-contract rewind when a UI sink is used,
interrupt without accepting partial blocks. Cancellation is observed during
upload, streaming and backoff, not only after a blocking whole-body read;
terminal fully parsed and accepted before cancellation wins. Never stream
unverified output or unredacted provider error text to stdout/stderr/events.
Redaction §1 expressly leaves user/accepted assistant conversation text intact:
stdout is accepted assistant text, not a guaranteed secret-free channel when
that text itself contains a secret. Tests guarantee no *application-owned*
credential/header/tool raw secret leaks, not that the model cannot repeat a
user-supplied secret. A stronger stdout guarantee requires separate Redaction
owner approval; do not silently rewrite canonical assistant text.

**Contradictions resolved for this packet (no silent implementation choices).**
Config §§6.4/6.6, Provider Catalog §7, and Compaction §§7.1/14.4 defer
compactor capability and credential checks for the default empty pair before
Phase 5, reject a complete non-empty pair with `CONFIG_FEATURE_NOT_IMPLEMENTED`,
and require compactor validation only for new Phase-5 sessions. A one-sided
pair remains `CONFIG_INVALID_VALUE`. Hard assistant admission remains active
before Phase 5; P3D never compacts. Pre-Phase-5 snapshots are not compacted
until P5 specifies their eligibility. Config §14 no longer uses exit 78 for
P3D `praana run` or `praana resume`; those commands use the exit table above.
OpenAI §17 describes credentials before send, but `dispatch_after_admission`
currently appends its own start after credential resolution, whereas P3C
starts first. For the live loop this packet's order is the precedence rule:
one P3C start, then credential lookup, then send. Do not call
`dispatch_after_admission`. The other OpenAI §17 steps are unchanged. P3C's
`AssistantDraft` drops ordered blocks,
refusals, reasoning summaries and Responses continuation; P3D must extend
this existing seam to carry the Protocol-owned result without inventing a
competing canonical message. OpenAI §18 and Protocol §12.1 differ on emission
barrier scope: any nonempty OpenAI semantic delta forbids retry; UI rewind
rules still apply to visible deltas. P3C currently stops on every provider
error and P2B retries inside a separate ledger; P3D routes typed retryable
failures back into the one P3C durable loop. P3C's current `admit_request`
passes `profile: None`, `image_count: 0`, returns the same body on
`ReduceOutput`, and its `prepare(step_index)` has no projection/context: these
are implementation gaps, not license for a new admission path. P2B's blocking
`http_exchange`/aggregate parser cannot prove live cancellation/partial
emission; use the existing P2B framing/conversion rules with cancellable
streaming transport, not an eager whole-body read that hides the barrier.

**Exact implementation allowlist.** Coding starts only after this revision is
on `main`. This list is then the boundary.
`crates/praana-cli/src/main.rs`; `crates/praana-core/src/turn/mod.rs` and
`crates/praana-core/src/turn/provider.rs` (new binding module);
`crates/praana-core/src/provider/openai/{mod,attempt,chat,responses,sse}.rs`
only for extracting/reusing transport and conversion primitives;
`crates/praana-core/src/config/validate.rs` only to enforce the pre-P5
compactor phase gate using the existing `ConfigError::FeatureNotImplemented`;
`crates/praana-core/src/setup/mod.rs` only to leave the compactor pair empty,
reject non-default selection before P5, and remove the pre-P5 strict-compactor
requirement;
`crates/praana-core/src/ui_contract/` only to wire an existing sink, not change
DTOs; `crates/praana-cli/Cargo.toml` and `crates/praana-core/Cargo.toml`
only for required existing workspace dependencies/features. Tests:
`crates/praana-cli/tests/headless_cli_p3d.rs`,
`crates/praana-core/tests/step_provider_p3d.rs`, and existing
`crates/praana-core/tests/{config_v1,setup_v1,openai_v1,openai_matrix,crash_recovery}.rs`.
Fixture additions only under `tests/fixtures/rust-v2/providers/v1/` (local
OpenAI Chat, Responses, OpenRouter Chat request/stream cases) and
`tests/fixtures/rust-v2/headless/p3d/` (CLI stdout/stderr/status and recovery
cases, no secrets or host-absolute paths). If P3D needs changes to any other
Config or Setup source file, or to Protocol, History or semantic UI DTOs/fixtures,
stop for owner amendment first.
**Owner amendment (P3D).** Two out-of-list files are authorized, narrowly:
`.github/workflows/rust-v2-crash-matrix.yml` only for the P3D CLI Windows
compile/fail-closed step and a `crates/praana-cli/**` PR path filter, and
`crates/praana-core/tests/fake_provider_e2e.rs` only for mechanical updates
required by the P3D seam changes (no behavioral edits). The Windows smoke
test itself stays in the already-allowlisted
`crates/praana-cli/tests/headless_cli_p3d.rs`. Every other file still stops
for owner amendment first.
Review gate: Amit approved the three P3D policy decisions (pre-P5 compactor
deferral, accepted-step-only stdout, and the application-owned-secret
guarantee) and these narrow Config/Setup implementation changes. This packet's
CLI grammar, process results, and StepProvider join are the normative
execution contract once this revision is on `main`. Config §§6.4/6.6/14,
Provider Catalog §7, and Compaction §§7.1/14.4 are reconciled with that
deferral. Issue #405 records accepted-step streaming and the narrower secret
claim. P5 still owns whether pre-Phase-5 sessions can later compact; P3D
makes no such request.

**Implementation note (P3D).** The headless CLI implements this grammar with
a hand-rolled parser in `crates/praana-cli/src/main.rs` (no clap), so the
exact informational forms, duplicate-flag rejection, resume-only flag set, and
usage-to-stderr exit 2 match this contract byte for byte. `HeadlessLoop::create`
derives the session id from a canonical `<session.root>/<SessionId>/` directory
name when present and falls back to the id generator for legacy layouts, so
the printed resume selector always derives from the committed meta manifest.

Focused red/green gates: `cargo test -p praana-core --test step_provider_p3d`,
`cargo test -p praana-cli --test headless_cli_p3d`,
`cargo test -p praana-core --test openai_v1`,
`cargo test -p praana-core --test openai_matrix`,
`cargo test -p praana-core --test config_v1`,
`cargo test -p praana-core --test setup_v1`, and
`cargo test -p praana-core --features failpoints --test crash_recovery`.
Config/setup focused assertions: before P5 the default empty compactor pair
needs no compactor credential or profile, a one-sided pair is
`CONFIG_INVALID_VALUE`, a complete non-empty pair is
`CONFIG_FEATURE_NOT_IMPLEMENTED`, and assistant admission still rejects
oversized requests. Add tests within these
existing binaries only; Phase-5 session creation gates belong to P5.
Local fake HTTP servers only; no real keys/public network. Test each protocol
with a multi-step tool cycle, ordered results and Responses crash-resume native
continuation; capture exact outgoing body/hash/limit and verify durable
admission+start precede **every** send and no send after failed fsync, missing
credential or rejected admission. Prove pre-emission retry fresh IDs/`retry_of`
and bounds, post-emission failure with no retry, SIGINT/SIGTERM during upload,
stream and backoff, no partial stdout/accepted history, both selector lookup
failure modes, changed-config freeze, workspace/Windows fail-closed, risk deny
and allow, step-limit, setup and all exit codes/ID placements. Assert the
credential is sent only in headers. The application must not write credential
values, authorization-header values, or raw tool arguments or results to
stdout, stderr, events, or logs. Accepted assistant text is copied unchanged
and is not scanned or rewritten, including when it repeats a user-supplied
secret. A missing credential after durable start yields exactly
one failed authentication attempt, one provider-failure interruption, zero
HTTP sends, exit 1, and the stderr resume ID, with empty stdout. A failed
terminal fsync exits 1 with no resume ID; the next successful `resume`
recovers before it prints one. Then run §2 global
gates and Linux/macOS crash matrix; Windows compile/fail-closed smoke only
until W403/W402. Any unowned mismatch blocks acceptance; no release claim
before these pass.

### P4A: History Retrieval and Search

- Owner: `RUST_V2_HISTORY_STORAGE_SPEC.md` Phase 4 packet; Built-in history
  tools.
- Depends: P3D.
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
- Activation gate: test that newly created Phase-5 provider-capable sessions
  enforce Config §6.4's validated/configured compactor requirements before
  session creation succeeds. Decide and test the compaction eligibility of
  pre-Phase-5 session snapshots before enabling compaction on their resumed turns.

### P6: Optional Memory Plugin

- Owner: `RUST_V2_MEMORY_PLUGIN_SPEC.md` complete document.
- Depends: P4B, P5.
- Output: default none, full plugin contract, explicit builtin SQLite,
  deterministic recall/digest/extraction/maintenance and capability tools.
- Focused tests: `memory_contract_v1`, `memory_builtin_sqlite_v1`,
  `memory_extraction_v1`.

### W403: Windows Private History ACLs (`chronosiq/praana#403`)

- Owner: `RUST_V2_HISTORY_STORAGE_SPEC.md` private History permissions.
- Depends: P1B; may be implemented after P3C/P4A/P5/P6 on other platforms.
- Output: private, verifiable Windows History session/ledger/artifact/spool
  creation without a create-then-insecure window; durable session creation and
  recovery remain fail-closed until this packet lands.
- Gate: pass the Windows durable crash matrix with actual fast-fail evidence.

### W402: Windows Handle-Anchored File Mutations (`chronosiq/praana#402`)

- Owner: `RUST_V2_BUILTIN_TOOL_CATALOG_SPEC.md` Phase 3 file tools;
  Tool Runtime confinement and History journal rollback.
- Depends: W403 (complete it first).
- Output: reparse-safe Windows write/edit/batch operations and journal recovery;
  restore their provider-visible descriptors only after safety tests pass.
- Gate: W403 then W402 MUST both land before P7 and before any editor-client
  release. The P3C approved Windows tool-catalog exception ends only then.

### P7: Temporary OpenTUI IPC

- Owner: `RUST_V2_IPC_SPEC.md`; UI Contract conversion fixtures.
- Depends: P1C, headless Phases 1-6, W403, and W402.
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
