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
  `amitkumardubey/praana#621`). Durable batch completion orders references by provider
  ordinal even when the caller supplies a permuted request vector. Linux and
  macOS CI execute the event and two-file journal crash matrices; Windows CI
  compiles the core and requires a real fast-fail, panic rejection, and the
  fail-closed write/catalog tests. Windows also runs non-durable
  `provider_ordinal_ordering_without_a_durable_session` (the same call-ordering
  helper used by durable completion) and the crash harness tests that do not
  create sessions. Only the named durable-session tests below
  are skipped on Windows under the owner-approved P3C capability gap: since
  P1B, Windows History session creation has failed closed without private ACLs.
  Durable Windows sessions remain unsupported until `amitkumardubey/praana#622`;
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
  [`#621`](https://github.com/amitkumardubey/praana/issues/621); Windows mutations
  remain unavailable until that packet lands.

  **Windows-only skips (each requires durable History session creation):**
  each entry is linked to the private-ACL gate and is explicitly excluded by
  the workflow's Windows-conditional capability step, not by an unconditional
  disabled step. The child harness and real-abort identity tests still run.

  - `auto_hydrate_controller_failure_projection_integrity` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `auto_hydrate_controller_other_error_warning_and_continue` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_accepted_marked_step_cancels_without_starting_body` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_accepted_mixed_step_replays_safe_peer_and_cancels_marked_call` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_accepted_step_runs_unstarted_calls_once` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_artifact_blob_before_commit` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_artifact_commit_before_event_recovers_exact_result` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_attempt_started_durable_before_provider` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_attempt_started_write_before_fsync` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_batch_complete_write_before_fsync` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_batch_completed_runtime_boundary` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_event_write_before_fsync_is_a_real_process_abort` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_every_event_fsync_boundary` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_finish_event_write_before_fsync_preserves_exact_result` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_first_tool_start_marks_mutation_uncertain_and_skips_peer` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_later_tool_start_preserves_first_result` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_redaction_before_artifact` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_state_changed_before_finish_is_uncertain` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_terminal_step_before_commit` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_tool_body_before_redaction` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_after_turn_committed` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_auto_hydrate_recovery_matrix` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_during_fragmented_provider_output_never_accepts_partial` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_during_batch_edit_validation_leaves_workspace_unchanged` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_during_recovery_is_idempotent` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `crash_during_supersession_repair_is_idempotent` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `environment_alone_cannot_arm_failpoints` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `malformed_tail_recovers_exact_valid_prefix` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `replacement_acceptance_crash_repairs_supersession_once_in_fresh_process` ([#622](https://github.com/amitkumardubey/praana/issues/622))
  - `durable_batch_completion_uses_provider_ordinals_not_input_vector_order` ([#622](https://github.com/amitkumardubey/praana/issues/622))

### P3D: Headless CLI and Real StepProvider Binding (`amitkumardubey/praana#624`)

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
deferral. Issue amitkumardubey/praana#624 records accepted-step streaming and the narrower secret
claim. P5 still owns whether pre-Phase-5 sessions can later compact; P3D
makes no such request.

**Implementation note (P3D).** The headless CLI implements this grammar with
a hand-rolled parser in `crates/praana-cli/src/main.rs` (no clap), so the
exact informational forms, duplicate-flag rejection, resume-only flag set, and
usage-to-stderr exit 2 match this contract byte for byte. `HeadlessLoop::create`
derives the session id from a canonical `<session.root>/<SessionId>/` directory
name when present and falls back to the id generator for legacy layouts, so
the printed resume selector always derives from the committed meta manifest.

**Implementation note (P3D, review round 2).** The first review of this packet
rejected the commit and raised eight defects; this revision closes them inside
the same allowlist, with no new out-of-list source file.

*No raw provider body is durable.* A non-2xx response is still classified
(`classify_http` needs the body to detect a context-length error) and then
dropped: the durable `ProtocolError` message is the fixed
`provider responded with HTTP <status>`. Both arms of
`provider_protocol_error` then run the report-only secret detector — including
the common arm, because `ProviderError::to_protocol_error` copies
`safe_message` verbatim, so transport and stream strings are redacted before
they can reach events or stderr. Neither a credential nor an `Authorization`
echo can reach `events.jsonl`.

*Responses fidelity.* `StepOutcome.phase` now carries the parsed
`commentary`/`final_answer` phase onto the accepted message, reasoning-summary
blocks are ordered ahead of the visible text (and never reach stdout, which
only accepts `Text`), and tool calls travel as explicit blocks so they survive
once any non-text block is present. The live emission barrier treats
`response.output_item.added` for a `function_call` as emission, matching
`attempt.rs::crosses_emission`, and `observable_delta` is set only for
user-visible text or a reasoning summary — a refusal crosses emission without
claiming a visible delta.

*Project context (System Context §7.1).* `praana run`/`resume` discover the
context once, compile the instruction slots with the real session id
(`bind_session` recompiles from the bound session directory), and pass the same
context to the session, so `meta.json` records the
`project_context_source_sha256` of the sources the request was built from
rather than the empty-provenance digest. On resume the creation digest stays
immutable; a difference prints `PROJECT_CONTEXT_CHANGED_SINCE_CREATE` before
the next provider request, carrying only the code.

*Admitted bytes are the uploaded bytes.* The admitted body is serialized once
with the RFC 8785 canonical encoder; `AdmittedRequest::authorize_bytes`
verifies that exact buffer against the durable `request_hash` **before** the
socket write, so a differently serialized value (or a single flipped bit) never
reaches the socket. The value-level `authorize_send` remains only for the
scripted test providers.

*Retry.* The 1-based `attempt_number` is passed straight through, so the first
retry uses the 500 ms jitter cap and the second 1000 ms, and the loop
accumulates retry wall time against the 60 s cap: no further send is scheduled
once the spent time plus the next delay reaches it.

*Completion wins (OpenAI §19).* A terminal event that was fully parsed before
cancellation is accepted; the post-completion cancel check that discarded it is
gone. A cancel observed before the terminal event still fails the attempt as
`E_CANCELLED`.

*Admission arithmetic.* `W - Rout - Rreason - margin` underflow is again
`ADMISSION_ARITHMETIC_OVERFLOW` (E_ADMISSION_ACCOUNTING, exit 1). A reserve that
merely does not fit the window remains an ordinary context reject
(`E_ACTIVE_TURN_TOO_LARGE`, exit 2). Restoring the underflow exposed a real
P3D bug: the binding ignored the configured `llm.max_output_tokens` cap when
resolving the output reserve and reserved the bundled profile's whole 128k
output budget, which underflowed every small-window session. `resolve_profile`
still hands back the bundled `max_output_tokens` — the override is applied in
`prepare_admitted`, where `.min(self.config.llm.max_output_tokens)` bounds the
requested reserve and `admit` clamps that same value, so the body and the
reserve agree. `oversized_request_rejects_...` now fails for
`E_ACTIVE_TURN_TOO_LARGE` because the prompt genuinely does not fit, and
`reserve_larger_than_the_window_is_an_admission_accounting_error` pins the
underflow branch (nothing else in the tree asserts `E_ADMISSION_ACCOUNTING`).

*Windows smoke.* `windows_resume_fails_closed_before_session_lock` now uses a
canonical 26-character session id under the effective `session.root`, so the
run reaches the Windows fail-closed guard (exit 1) instead of selector
validation (exit 2), and additionally asserts no session lock and no events.

**macOS diagnostic (P3D, open gate).** `crash-matrix-macos` fails at
`resume` after `drop(loop_)` with `E_SESSION_LOCKED`, and the failing test moves
between attempts (attempt 1: `lost_attempt_within_budget_...` in
`fake_provider_e2e`; attempt 2: `resume_never_replays_...` in
`step_provider_p3d`), so the loser changes between runs. Linux is green
throughout, and this diff touches neither `crates/praana-core/src/history/`
nor `fake_provider_e2e.rs`, so the lock primitive itself is unchanged. An
owner amendment adds a second macOS step that runs those two binaries with
`--test-threads=1 --nocapture` after the existing parallel
`cargo test --workspace`, which stays authoritative. Because a failed step
skips later steps by default, the diagnostic step carries
`if: success() || failure()`, so a red workspace step cannot skip it. The
condition also runs it on a green parallel step — run 36547412454 did exactly
that, and the result says nothing about the race, because `E_SESSION_LOCKED`
never appeared. Only a red parallel run paired with its serialized result can
show whether the race survives serialization. Both binaries always run: the
shell accumulates the exit code and
fails the step if either did, since the failure has already moved between
those two binaries. A green serialized step
is a diagnostic result and **not** a fix; if that step also fails, the race
survives serialization and the next change belongs to the lock lifetime,
which is outside this packet's allowlist until that result exists.

The Linux crash matrix later failed the same way in
`deletion_keeps_a_locked_or_recent_session`: after `delete_session` dropped its
writer, the next `create_or_open` returned `E_SESSION_LOCKED`. `flock` stays
with a child that inherited the descriptor across `fork` until that child
execs. `EventLogStore` now unlocks `session.lock` before closing it, so the
next writer can take the lock while that child is still between fork and exec.

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
- Contract (amended 2026-09-29): History §5.2 `history_derived` checkpoint and
  `document_id`, §10.3 `read_session_source`, §11.1.1 source-field vocabulary,
  §11.2 filter semantics and request hash, §11.3 occurrences, excerpt and
  retrieval, §11.5 implementation manifest, §14 library-only deletion; catalog
  §6.1 inputs, §6.3 order 120, §6.4 error mapping; Protocol Appendix A rows for
  `HISTORY_SOURCE_NOT_FOUND` and `HISTORY_SELECTOR_UNSUPPORTED`.
- Files: `history/{retrieve,search,cursor,checkpoint}.rs`, `history/rebuild.rs` (§9.4
  rebuild) and `history/deletion.rs` (§14 whole-session deletion), turn/search
  changes in `history/projection.rs`, `tools/builtin/history.rs` (orders 100, 110,
  120),
  the `tools/error.rs` extension that keeps Appendix A.4 class and retryability
  for History codes on the tool surface (catalog §6.4), `tools/runtime.rs`
  wiring so `ToolErrorDto.retryable` and result status read that mapping,
  schema snapshots and manifest rows, `tests/history_search.rs`, history cases of
  `tests/builtin_tools_phase4.rs`, and `history_search` fixtures.
- P4A decisions (recorded here because they are not derivable from the code):
  - §5.2 checkpoint validation recomputes `payload_hash` from the stored
    `payload_json` and compares the stored prefix hash against the log's prefix
    chain **at the checkpoint's own applied sequence**. A row that is absent is
    a first projection; a row that is present but fails any §5.2 check (parse,
    row columns, `projection_version`, `search_schema_version`, `payload_hash`,
    session, sequence, or prefix) is *invalid* and takes the §9.4 rebuild — it is
    never repaired in place, because an in-place replay cannot remove a derived
    row the new projector does not re-emit. A valid checkpoint behind the log
    head is *stale* and replays normally.
  - §5.2 replay is idempotent by construction: documents insert with
    `ON CONFLICT(document_id) DO NOTHING` plus a full-row comparison, and turns
    upsert on `turn_id`. Because a document row is immutable, the §8 FTS
    delete-before-update path has no producer in P4A; new rows insert FTS text
    at the content rowid inside the same transaction.
  - §9.4 rebuild copies canonical artifact tables with `ATTACH`, so the copy and
    the hash verification read one snapshot. The old `-wal`/`-shm` sidecars are
    renamed together with the old database; leaving them would let the next
    opener replay the old log into the rebuilt file. An interrupted step-6
    rename is completed on the next database open.
  - §10.2 binary content requires an explicit `complete_result` selector; an
    omitted selector is `Default` and is rejected.
  - §14 `delete_session` returns `SessionRetention` (`Deleted`/`Pinned`/
    `Active`) rather than a new `HISTORY_*` code: §13 reserves
    `HISTORY_SESSION_LOCKED` for another mutating owner, and a pinned or
    non-inactive session is a retention decision, not a storage failure. The
    writer lock is taken first and held through the rename, and the pin,
    activity, and integrity checks all run under it.
  - §12 tool paths open a separate read-only connection and never take the
    writer mutex. Access telemetry is non-authoritative (§2.1) and is a no-op on
    a read-only handle.
  - §6.2 line identity is `1 + LF count`, so a trailing LF leaves a final empty
    line; the line count and `line_spans` share that definition.
- Also gated: `builtin_tools_phase4`; the failpoint crash matrix adds
  `history_search` for History §15.2 points 11, 12, 13, 15, and 16.
- Deferred acceptance: History §18 items 9 and 12 are checked in P4A for turns,
  search documents, and reset only. The summary, StateGraph-checkpoint, and
  compaction-epoch parts close in P4B and P5. No CLI grammar is added.

### P4B: StateGraph

- Owners: `RUST_V2_STATE_GRAPH_SPEC.md`; Built-in state tools.
- Depends: P4A.
- Output: event-derived graph, transitions/revisions, checkpoint, active tail,
  automation, state tools/search integration.
- Focused test: `state_graph_v1`.
- Split (StateGraph §16.1), decided 2026-10-01:
  - **P4B-1:** the core graph, the single transition function (replay
    delegates to it), checkpoint, the eleven tools (catalog §7), the
    provider-ordered queue on the batch driver (StateGraph §14.1), `state`
    search rows, and `read_session_source` for state rows.
  - **P4B-2a** (amended 2026-10-01): the exact tail bytes, per-request
    rendering, the `state_graph`/`system` admission split, the mutation-time
    bound, the request-time budget guard, and production registration of
    the history and state tools (StateGraph §16.1, catalog §1.1).
  - **P4B-2b** (amended 2026-10-02): the Unicode letter/number table (Token
    Accounting §10.3) and lexical auto-hydration (StateGraph §10.1, §10.2).
  - **P4B-2c** (amended 2026-10-03): idle tiering and telemetry
    (StateGraph §10.3, §10.5, §15.4, §16.1).
- Decisions:
  - P4B-2 decisions (Amit, 2026-10-01):
    - Register the history and state tools in production in P4B-2a.
    - An over-budget tail at request time should demote unprotected objects,
      largest first. Review showed it cannot happen in v1: resume keeps
      `state.*` from creation, and v1 has only the generic estimator. So
      P4B-2a ships a visible guard only, and the demotion is deferred
      (StateGraph §8.3; §4A row).
    - The tail header drops `projection_sequence`.
    - The idle-tier source kind is `system`.
    - No new config key: automation disabled means `auto_hydrate = false`.
    - The lexical object text includes the `state_id`.
  - P4B-2b decisions (Amit, 2026-10-02):
    - Split the automation work into P4B-2b (Unicode table and
      auto-hydration) and P4B-2c (idle tiering and telemetry).
    - Telemetry ships pinned counters, with tail tokens before and after as
      samples. The reversal metric is deferred.
    - A candidate that would push the tail over the budget is skipped, and the
      next one is tried (greedy fit).
    - A phrase match needs at least 2 query tokens, so a one-word follow-up
      such as `continue` never phrase-matches.
    - A token made only of ASCII digits is not an identifier. It is an
      ordinary token if it has at least 3 scalars (`2024`), and is dropped
      otherwise (`10`).
  - P4B-2b amendment choices (coordinator, 2026-10-02):
    - Tokens lose their leading and trailing `_`, `-`, `.`, and `/` before
      classification, so a path at the end of a sentence still matches
      (StateGraph §10.1 step 3).
    - Phrase text trims ASCII whitespace only, not `str::trim`, so the result
      does not follow the toolchain's Unicode version.
    - Non-tool commits go through a new `StateService::commit_origin`, which
      P4B-2c idle tiering will reuse. It takes a live cancellation predicate,
      not a snapshot.
    - The match signal is chosen by scoring branch, not by score value.
    - Greedy fit selects at most the free active slots (256 minus current
      active objects).
  - Error capture (§10.4) is deferred beyond P4B.
  - State results are never artifactized.
  - Plan mode allows the state tools.
  - State payload text is redacted and normalized before `StateChanged` (§4.7).
  - `list_state` cursors pin a hash of the graph view (§11.2).
  - P4B-1 implementation notes (2026-10-01):
    - The live graph is the event-log replayer, already current after every
      append. `catch_up` copies that graph instead of walking the log.
      `assistant_source` and checkpoint timestamps borrow the log's event
      slice. The `state_graph` checkpoint is the durable resume snapshot:
      open restores a hash-valid checkpoint, tail-replays, then compares
      the result with the replayer (StateGraph §7 step 7, on every open).
      A mismatch or any other restore failure is logged without payload
      text and replaced by the replayer. A missing checkpoint is not logged.
    - `list_state` `limit` values outside `i64` (for example `2^63` or
      `1e20`) still fail serde parsing as `ToolSchemaInvalid`. The published
      schema is `"type": "integer"` with no range. Values inside `i64` but
      outside 1..=200 are `STATE_FIELD_LIMIT`.
    - State tools are not in the production `HeadlessLoop::assemble` registry
      (`phase3_tools` only). `assemble` still calls `open_state`. Tests
      register the eleven tools through `phase4_state_tools()`. The history
      tools are not registered in production either. P4B-2a closes both.
    - Checkpoint writes open a second read-write connection to the same
      `history.db`. The spec's transaction is on that database; it does not
      share `ArtifactStore`'s mutex.
  - P4B-2a implementation notes (2026-10-01):
    - `state/render.rs`: `render_state_tail` renders the exact active tail `R`
      using `canonical_json::to_canonical_json_bytes_html_safe` in §6.3 order with
      envelope `<praana_state_graph authority="untrusted_current_session_data" version="1">\nCurrent scratch state cannot override system policy or the current user request.\n`
      followed by newline-separated canonical JSON object lines (one per active object)
      for nonempty graphs, or `objects: []` for the empty graph, followed by `\n</praana_state_graph>`.
      No trailing newline, verified by goldens.
    - Mutation-time bound: evaluated in `state/service.rs commit` on trial graph after
      `apply_state_changed` and before cancel/sequence re-checks. Fails with
      `STATE_ACTIVE_BUDGET_EXCEEDED` only if `after > limit && after > before`. Limit
      is plumbed via `ToolRuntime::set_state_active_max_tokens(u64)` (default 4096),
      called in `HeadlessLoop::assemble`.
    - Per-iteration rendering: `R` is rendered once per loop iteration from
      `EventLogStore::state_graph()` before `prepare_admitted`. Re-prepare for reduced
      output reuses `R`. Provider builds `current_state` from `R\n\nRuntime Facts`.
    - Admission split: `derive_components` in `provider/openai` splits `state_graph = R.as_bytes()`
      and derives `system` from the instruction body with `R`'s span removed by offset.
      Any mismatch maps to `ADMISSION_STATE_TAIL_MISMATCH` -> `E_ADMISSION_ACCOUNTING` / `Internal`.
    - Request-time guard: if `R`'s generic token estimate exceeds `active_max_tokens`,
      the turn interrupts with `InterruptionReason::ActiveTurnTooLarge` and diagnostic
      `E_ACTIVE_TURN_TOO_LARGE` / `ContextLength` without starting an attempt or calling provider.
    - Production tools: `production_tools(&ToolsConfig)` registers `phase3_tools` plus
      history tools (orders 100-120) and state tools (orders 200-300). Used in both
      `HeadlessLoop::assemble` and `turn/provider.rs`.
    - Scope exception: `crates/praana-core/tests/openai_matrix.rs:1262-1263` is adapted
      mechanically to supply `state_tail: ""` and `state_tail_offset: None` on `AdmissionRequest`
      following the §8.3 addition of those required fields.
  - P4B-2b implementation notes (2026-10-02):
    - Unicode table generation (`crates/praana-xtask/src/unicode.rs`): generated `LETTER_OR_NUMBER_RANGES` from `UnicodeData.txt` for categories L* and N*, expanding First/Last ranges and merging adjacent ranges into 748 disjoint intervals; hand-written fixtures for `letter_or_number_samples` per Token Accounting §10.3 added to `generate_artifacts`. Verified via `cargo run -p praana-xtask -- unicode verify --offline`. Added `is_letter_or_number_v15_1` and fixture assertions.
    - Pure matching (`crates/praana-core/src/state/hydrate.rs`): tokenization (steps 1–6) using NFKC casefolding, ASCII edge punct trimming, 21 stop words, digit/punct rules; integer candidate scoring with exact identifier (1000), phrase match (900), and fixed overlap score using §10.2 integer binary search: largest s with s²·max(1,|Q||D|) ≤ 1e6·shared²; greedy fit ordering (score desc, updated_sequence desc, state_id asc) capped at `min(auto_hydrate_max, 256 - active)`. Takes live cancellation closure at each evaluation step.
    - State service (`crates/praana-core/src/state/service.rs`): added `commit_origin` accepting reason, source, automation metadata, operations, and live cancellation closure; `catch_up` updated to return `StateServiceError` and mapped via `to_tool_error()`.
    - Tool runtime (`crates/praana-core/src/tools/runtime.rs`): added `ToolRuntime::auto_hydrate` and `AutoHydrateOutcome`, holding state mutex for duration, validating UMA trigger and turn_id, returning `STATE_PROJECTION_INTEGRITY` on invalid state/trigger.
    - Controller placement (`crates/praana-core/src/turn/mod.rs`): placed in `HeadlessLoop::drive` after `open_turn` and cancel check, guarded by `auto_hydrate` enabled and `auto_hydrate_max > 0`, running only if no AssistantAttemptStarted for current turn and no prior `StateChanged` with `auto_hydrate` reason for the trigger. Failure mapping: CANCELLED skips auto-hydrate; PERSISTENCE / unhealthy log maps to `TurnError::Durability`; PROJECTION_INTEGRITY maps to `TurnError::failed`; any other error logs warning and continues.
  - P4B-2c decisions (Amit, 2026-10-03):
    - `candidate_count` is the unprotected, non-hard, non-retracted objects
      evaluated, including those too young to move.
    - `scores_millis` is one entry per operation, signal `idle_soft` or
      `idle_hard`, `score_millis` 0.
    - Every split chunk repeats the full `candidate_count`.
      `selected_count` is that chunk's operation count.
    - An active object with `idle_turns >= idle_hard_after_turns` moves
      straight to hard in one `SetTier`. Evaluation is a pure function of
      `(graph, committed_turn_ordinal)`. No marker. One open evaluation
      covers every missed turn.
    - Counters are the pinned StateGraph §10.5 list and nothing else.
      Per-kind/status breakdowns and the score bucket join the deferred
      reversal metric.
    - Tail-token samples are written only when that evaluation appended at
      least one `StateChanged`. `dimensions_json` is exactly
      `{"automation":"idle_tier"|"auto_hydrate","policy_version":"<effective>"}`.
      `event_sequence` is the trigger event.
    - A protected object increments one counter, in priority order: focus,
      then active hard constraint, then open error, then active task.
    - Double-counting telemetry on a repeated evaluation is accepted.
    - Idle events store the effective `state.automation_policy_version`
      (`state-lexical-v1`).
    - After a durable `TurnCommitted`, an idle-tier error logs
      `state idle-tier skipped: <state_code>` and the turn still returns
      `Ok`. Exit is 0. A failed idle-event fsync leaves the log unhealthy,
      so that committed-turn exit is 0 with no resume ID. That is the P3D
      committed-turn row.
  - P4B-2c amendment choices (coordinator, 2026-10-03):
    - Source and envelope fields are the StateGraph §10.3 table. The tierer
      reads the ordinal after the projector's `TurnCommitted` apply and
      does not increment it.
    - Live `commit` after the append, and once at the end of `assemble`.
      `recovery.rs` does not tier. No new checkpoint write.
    - A live cancellation predicate. Already cancelled means no event, no
      telemetry, exit 0, and the next open tiers.
    - Sample names are `state.active_tail_tokens_before` and
      `state.active_tail_tokens_after`, because the closed
      `dimensions_json` cannot carry before/after.
    - Transition counters count operations this call appended. A call
      cancelled before any append writes no telemetry.
    - Failpoints are the existing `state_changed` fsync labels plus
      `state.idle_tier.at_open`.
    - The CLI case lives in a new `headless_cli_p4b2c.rs`, not in the P3D
      test file.
    - The no-resume-ID row is the committed-turn path (`finish_report`
      already skips the ID when the log is unhealthy). A ready `praana
      resume` keeps its existing printer, which writes the ID without
      consulting log health. `praana-cli/src/main.rs` stays unchanged.

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

### W403: Windows Private History ACLs (`amitkumardubey/praana#622`)

- Owner: `RUST_V2_HISTORY_STORAGE_SPEC.md` private History permissions.
- Depends: P1B; may be implemented after P3C/P4A/P5/P6 on other platforms.
- Output: private, verifiable Windows History session/ledger/artifact/spool
  creation without a create-then-insecure window; durable session creation and
  recovery remain fail-closed until this packet lands.
- Gate: pass the Windows durable crash matrix with actual fast-fail evidence.

### W402: Windows Handle-Anchored File Mutations (`amitkumardubey/praana#621`)

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

## 4A. Deferred Work Register

Every deliberate deferral is recorded here with its owner and tracker link.
Remove a row only when the linked work has merged. A packet that defers
anything adds a row before it merges.

| Deferred item | Decided | Owner / closes in | Tracker |
|---|---|---|---|
| History `path_globs` filter is inert: `artifacts.normalized_path` is always NULL | 2026-09-29, P4A amendment | Follow-up packet (Tool Runtime + History artifact write) | `amitkumardubey/praana#627` |
| CLI for session deletion, orphan GC, inspect, and derived rebuild; P4A is library-only (History §14) | 2026-09-29, P4A amendment | Later CLI packet; needs branding decision | `amitkumardubey/praana#628` |
| Catalog §9 `TOOL_*` names do not exist in the implemented `ToolErrorCode`; history (§6.4) and StateGraph (§7.3) tools reconciled; file, search, process, and git tools remain | 2026-09-29, P4A amendment; narrowed 2026-10-01, P4B amendment | Docs | `amitkumardubey/praana#629` |
| Request-time demotion of unprotected active objects, largest first, in one durable `StateChanged` (Amit's decision). Unreachable in v1, so P4B-2a ships only the visible guard (StateGraph §8.3). Needs the event shape (reason `system`, source, null envelope IDs), non-tool append-failure mapping, and a checkpoint point | 2026-10-01, P4B-2 amendment review | The packet that adds a non-generic estimator | none |
| After the guard fires, a session cannot recover by itself (the model gets no request); only a new session helps, because nothing produces `ResetBoundary` in v1 | 2026-10-01, P4B-2 amendment review | Same packet as request-time demotion | none |
| Slash-command origins for StateGraph mutations (StateGraph §14.1, §16.1) | 2026-10-01, P4B-2 amendment review | Later packet with the Rust slash-command surface | none |
| No `ResetBoundary` producer exists in v1 (`/clear` equivalent); replay only consumes it | 2026-10-01, P4B-2 amendment review | Later CLI/UI packet | none |
| A recovered `TurnStarted` records the session's last toolset hash, not the runtime's current catalog hash (`history/recovery.rs`). Visible now that P4B-2a grows the catalog | 2026-10-01, P4B-2 amendment review | Follow-up recovery packet | none |
| StateGraph telemetry deferred from §10.5: manual reversal within three turns of an automatic change; per-kind and per-status idle-transition counts; auto-hydrate score buckets | 2026-10-02, Amit; widened 2026-10-03, P4B-2c amendment | Later telemetry packet | none |
| No v1 producer writes `TaskStatus::Cancelled`. `complete_task` sets done and soft. `apply.rs` accepts the cancelled transition, and idle tiering treats a cancelled task as unprotected, but no tool emits it | 2026-10-03, P4B-2c amendment | Later state-tool packet | none |
| Idle tiering has no CLI effect at the default thresholds. `praana run` commits one user turn. `praana resume` takes no prompt: it continues an active turn, or prints the resume ID and exits 0. One committed turn yields `idle_turns = 1`, below `idle_soft_after_turns = 20`. A configured threshold of 1 demotes on that commit | 2026-10-03, P4B-2c amendment | P3E | `amitkumardubey/praana#632` |
| `praana-cli` `headless_cli_p3d` signal tests (`sigint`/`sigterm_during_stream`) failed once under load (6 s `wait_for_send` wait); both passed alone and in two full reruns | 2026-10-02, P4B-2b baseline | Test hygiene | none |
| The state tool commit path snapshots cancellation once (`StateWriteContext.cancelled = cancel.is_cancelled()`, `tools/runtime.rs`), so its pre-append re-check (`state/service.rs`) cannot see a later cancellation. P4B-2b's `commit_origin` takes a live predicate; the tool path should do the same | 2026-10-02, P4B-2b amendment review | Later state packet | none |
| StateGraph §4.7 payload normalization trims with Rust `str::trim`, so its `White_Space` set follows the toolchain's Unicode version, not 15.1. Pinning it changes stored payloads, so it needs a schema decision | 2026-10-02, P4B-2b amendment review | Later state packet | none |
| Provider-tokenizer estimators: the dual `Tstate` check (StateGraph §8.3) collapses to the generic estimator in v1; a request-time demotion after a model or estimator switch is untested until a non-generic estimator exists | 2026-10-01, P4B-2 amendment | Token Accounting §5 owner packet | none |
| The memory and handoff instruction slots are still counted inside the `system` admission component (Token Accounting §7.3) | 2026-10-01, P4B-2 amendment | P5 (handoff), P6 (memory) | P5 / P6 packets |
| StateGraph deterministic error capture (§10.4): undefined `normalized_command_or_path`/`stable_error_code`, raw command text, no resolve tool | 2026-10-01, Amit | Later packet with its own amendment; its output bound must also be defined (an Error object can exceed 64 KiB of JSON) | none |
| StateGraph compaction/handoff/engine/memory items: §13.1, §13.4, §13.5, §15.2 "at compaction", §15.6, §16 step 9, §18 item 9 | 2026-10-01, P4B amendment | P5, P6, Phase 10 | P5 / P6 packets |
| Crash after a durable `StateChanged` but before its tool finish is reported as uncertain; recovery does not prove the outcome from the matching `StateChanged` | 2026-10-01, P4B amendment | Follow-up recovery improvement | none |
| StateGraph retracted objects are unbounded (the 4,096 limit counts current objects only), so the graph and its checkpoint grow without limit in a long session | 2026-10-01, P4B amendment review | StateGraph owner decision (bound, or exclude retracted payloads from the checkpoint) | none |
| `tests/main.test.ts` entrypoint guard tests time out under load | 2026-09-29 | Bun test hygiene | `amitkumardubey/praana#626` |
| Per-batch cap on history-tool results (`4 * 64 KiB`, History §6.1 rule 5) awaits Amit's confirmation | 2026-09-29 | Amit, in the review of PR `amitkumardubey/praana#625` | `amitkumardubey/praana#625` |
| `summary_segment` search rows and retrieval, summary projections | 2026-09-29, P4A scope | P5 | P5 packet |
| History §18 items 9 and 12: summary, StateGraph-checkpoint, and compaction-epoch parts (P4A checks turns, search, and reset only) | 2026-09-29, P4A scope | P4B and P5 | P4B / P5 packets |
| `HISTORY_EVENT_INTEGRITY` canonical is conditional (Protocol A.4): narrow replay `E_JSONL_*`/`E_EVENT_*`/`E_REFERENCE_*` is never classified at the tool boundary; always the otherwise branch `E_SESSION_INTEGRITY_FAILED` | 2026-09-29, P4A | Follow-up (needs replay classification context at the error site) | none |
| `HISTORY_DANGLING_ARTIFACT` canonical is conditional (Protocol A.4): always `E_ARTIFACT_MISSING`; the `E_ARTIFACT_HASH_MISMATCH` branch is never classified | 2026-09-29, P4A | Follow-up (`ArtifactError` carries no hash evidence) | none |
| `HISTORY_IO` canonical is conditional (Protocol A.4): always `E_HISTORY_PERSISTENCE`; the `E_EVENT_DURABILITY_UNCERTAIN` append-began branch is never classified | 2026-09-29, P4A | Follow-up (append-began state not plumbed to the error site) | none |


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
