# Circuit Breakers Design (Issue #301)

**Date:** 2026-08-23
**Status:** Approved
**Depends on:** #297 turn-loop hooks; #294 / #223 (nudges inform; this forces)
**Related epic:** #195 (deterministic tools harness)
**Related:** `toolErrorKey` / `toolErrorBaseKey` in `src/context-engine/error-tracker.ts`;
`isTestCommand` in `src/domain/coding-domain.ts`; `detectShellReads` in
`src/tools/shell-read-detect.ts`

## Purpose

Stop a session that is repeating the same **mutating** strategy, and give
headless runs a graceful wrap-up when token or wall-clock caps are hit.
Nudges stay informational. This issue **blocks** and **injects a constraint**.

The loop heuristic is byte-level (tool name + args / error key). It cannot see
intent. v1 therefore **never gates reads or test commands**, so intentional
re-checks (`git status`, `read_file`, `bun test`) are not treated as stuck.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Default | Loop gate always on. No disable hatch |
| Threshold | `3` — allow 2, block the 3rd (both triggers) |
| Triggers | Same `toolErrorBaseKey` (tool+args) **or** same error base (2 recorded failures → block 3rd) |
| Reads / tests | Never loop-blocked; never incremented |
| Constraint | Once per fingerprint: state-graph constraint + `session.circuitNotes` (classic) |
| Headless budgets | `[circuit] max_tokens` / `max_wall_ms`; `0` = off. TTY ignores these |
| On budget exceed | One wrap-up LLM call, drop tool calls, keep text. No cheaper-model hop |
| `--max-steps` | Unchanged |
| Mechanism | `pre_tool_call` + `post_tool_call`. No new agent-facing tools |
| Pre-block result | `{ ok: false, error }` (`isError: true`) |
| Hook order (pre) | plan → validate → risk → **circuit** → write-path acquire |
| Hook order (post) | unchanged extras, plus **circuit error-count** before write-path release |

Circuit sits **after** validate and risk so a typo or declined confirm does not
count as a loop hit, and **before** write-path so a block cannot leak a lock.

## Loop gate

### Fingerprints

Reuse existing helpers (do not fork the string format):

- **Args key** = `toolErrorBaseKey(tool, args)` → `tool:command|path|JSON`
- **Error key** = `toolErrorKey(tool, args, message)` for bookkeeping
- **Error base** (what pre checks) = `toolErrorBaseKey` so a later call with
  the same tool + path/command is blocked even when other args differ
  (e.g. `edit_file` same path, different `oldText`, same failure class)

Session maps: `argHits: Map<string, number>`, `errorHits: Map<string, number>`.

### Allow 2, block the 3rd

**Same args**

1. `pre_tool_call`: if not exempt, increment `argHits[argsKey]`.
2. If that count `>= loop_threshold`, block.

**Same error**

1. `post_tool_call`: if the call ran and `isError`, increment `errorHits[argsKey]`.
2. Later `pre_tool_call` (not exempt): if `errorHits[argsKey] >= loop_threshold - 1`
   (already 2 failures), block the 3rd attempt on that base key.

Two successes of the same mutating args → 3rd blocked (even if they "worked").
Two failures on the same path/command → 3rd attempt blocked even if args JSON
differs.

### Exempt (never increment, never block)

**Named read tools:** `read_file`, `read_and_summarize`, `search_code`,
`retrieve_artifact`, `recall`, `search_session_log`, `search_turn_events`,
`git_status`, `git_diff`, `git_log`, `git_branches`, `lsp_diagnostics`,
`lsp_hover`, `lsp_definition`, `lsp_references`, `lsp_completions`,
`lsp_code_actions`, `code_parse`, `code_imports`, `code_symbols`,
`code_definition`, `code_references`.

**Read-equivalent `shell`:** existing `detectShellReads` (`cat`, `head`, `rg`,
`git status`, …). Compound/unparsed shell is **not** exempt.

**Test `shell`:** `isTestCommand(command)`. Extend that helper to include
`bun test` (missing today). Shared with `ErrorTracker`.

Everything else (writes, `git_commit`, `lsp_format`, `lsp_apply_code_action`,
non-read non-test `shell`) is gated.

### Constraint (once per fingerprint)

On the **first** block for a key, and only then:

- `stateGraph.create("constraint", { text })` — engine Active State / checkpoint
- Append the same line to `session.circuitNotes` — classic compile (no Adaptive
  Context) and a belt-and-suspenders engine section

Text:

```
Circuit breaker: {tool} with the same arguments repeated or failed 3 times; required: different approach or ask the user.
```

Both compilers render `circuitNotes` (short **Circuit Breakers** section or
appended system-frame lines) so the acceptance test holds in classic and engine.

Later repeats of the same fingerprint stay blocked; do not create another
constraint.

### Resume

Rebuild `argHits` / `errorHits` / `circuitNotes` from `events.jsonl`
(`tool_call` + `tool_result` / pre-block results) on session open. Same idea
as the repeat-read index. Do not persist a separate snapshot file.

### Parallel batch

Count in `pendingToolCalls` order. Two identical mutating calls in one batch
run; a third in that batch is blocked.

## Headless budgets

```toml
[circuit]
loop_threshold = 3   # TTY + headless
max_tokens = 0       # 0 = off; input+output accumulated this run
max_wall_ms = 0      # 0 = off; from runHeadless start
```

- Enforced only when `session.headless === true`.
- Token total = session-accumulated input + output for this run (already
  tracked on the session / usage path).
- Wall clock starts in `runHeadless` (inject `startedAt` on the session or
  pass through `runTurn` options).
- Check after each LLM/tool step, **before** executing the next pending batch.
- On exceed: do not execute that batch; append a wrap-up instruction
  (`Circuit budget exceeded (tokens|time). Reply with a final summary. Do not call tools.`);
  one more stream; **drop** any tool calls from that wrap-up; keep text.
- `--max-steps` still stops the tool loop with its existing banner. Budget
  wrap-up is an extra path, not a replacement.

TTY sessions ignore `max_tokens` / `max_wall_ms`. The loop gate still applies.

## Scorecard

| Counter | Meaning |
|---|---|
| `circuitLoopBlocks` | Blocked mutating calls this session |
| `circuitBudgetWrapups` | Wrap-up streams started (expect 0 or 1) |

Numeric only. No command text in the DB.

## Testing

- Unit: increment/block/exempt reads, exempt `bun test` / `npm test`, constraint once.
- Turn: 3× same mutating `shell` → 3rd `{ ok: false }`; `circuitNotes` in the
  next classic **and** engine compile.
- Turn: 3rd `git status` / `read_file` / `bun test` **not** blocked.
- Turn: 2× `edit_file` same path, different `oldText`, both `isError` → 3rd
  same-path edit blocked.
- Headless: tiny `max_tokens` or `max_wall_ms` → wrap-up, no further tools.
- Scorecard counters increment.
- Resume: rebuilt maps still block the next identical mutating call.

## Files

- Create: `src/circuit/loop-gate.ts`, `src/circuit/budget.ts`,
  `src/hooks/handlers/circuit.ts`
- Modify: `src/hooks/index.ts`, `src/turn.ts`, `src/headless-run.ts`,
  `src/compile-classic.ts`, engine compile (circuit notes section),
  `src/types.ts`, `src/config.ts`, `src/context-engine/telemetry.ts`,
  `src/domain/coding-domain.ts` (`bun test`)
- Tests: `tests/circuit-loop.test.ts`, `tests/circuit-hook.test.ts`,
  headless wrap-up case in `tests/headless-run.test.ts`, turn cases in
  `tests/turn.test.ts`
- Spec: this file
- Docs: `AGENTS.md`, `ARCHITECTURE.md`, `concepts.md`; comment on #301

## Explicit non-goals

- Cheaper-model fallback
- Disable hatch / `[circuit] enabled = false`
- Loop-gating reads, read-equivalent shell, or test commands
- Changing `--max-steps` semantics
- User / agent chat circuit
- Persisting breaker state outside the event log
