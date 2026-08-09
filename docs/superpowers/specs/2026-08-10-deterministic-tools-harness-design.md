# Deterministic Tools Harness Design (Issue #195)

**Date:** 2026-08-10
**Status:** Approved
**First ship:** Issue #26 (`git_status` / `git_diff` / `git_commit`)

## Purpose

Move accuracy-critical operations out of free-form `shell` parsing and into
dedicated tools that return **verified structured facts**. The LLM orchestrates;
deterministic subsystems produce the ground truth.

Memory and Adaptive Context should store what tools cannot recompute (conventions,
decisions, preferences). Everything else — working-tree state, diffs, diagnostics —
should come from tools.

This epic does **not** add a separate Goal Planner / Tool Planner. Planning stays
inline in the turn loop, wrapped by deterministic gates (plan mode, write-path
guards, future hook consumers).

## Tool contract

Every harness tool MUST:

1. Live in a dedicated module under `src/tools/` (or a focused subdomain module)
   and register via a factory merged in `createAllTools`.
2. Validate arguments with Zod; reject invalid args with
   `{ ok: false, error: string }`.
3. Return a typed success/error union — never dump raw process stdout into the
   TUI, and never rely on the model to parse porcelain text.
4. Degrade gracefully when preconditions fail (not a git repo, missing binary,
   path outside sandbox) with a stable, scannable `error` string.
5. Export pure helpers (parsers, arg builders) for unit tests without spawning
   when possible; integration tests use temp fixtures.

## Context integration

Tool results still flow through the existing engine path:

`turn.ts` → `contextEngine.ingestToolResult(...)` → lossless `rawText` + stub card.

Rules:

- **Prompt size control** is the artifact stub card + `retrieve_artifact`. Do
  **not** embed distilled summaries in the prompt. Post-#275/#290, distillers
  may still fill the stored `summary` field for stats / memory promotion only.
- New tools that emit diffs, search hits, build errors, or test output MUST
  teach `inferContentTypeFromTool` so classification stays correct.
- Extend `toolCommandFromArgs` when the default `command` / `path` / `query`
  fields are insufficient for a useful artifact card label.

## Mutating vs read-only

| Class | Examples | Gates |
|---|---|---|
| Read-only | `git_status`, `git_diff`, `search_code` | Allowed in plan mode |
| Mutating | `git_commit`, `write_file`, `edit_file` | Must be listed in `PLAN_MODE_BLOCKED_TOOLS` (and future `pre_tool_call` hooks) |

Optional TTY confirmation for high-impact mutators may reuse `edit.confirm`
(same pattern as `edit_file`) rather than inventing a parallel config key unless
a tool needs distinct UX.

## First ship (#26)

`git_status`, `git_diff`, and `git_commit` establish the harness shape:

- Subprocess `git` only (no new git library dependency).
- Structured JSON responses documented in tool descriptions.
- `git_commit` blocked in plan mode; optional confirm via `edit.confirm`.
- Large diffs become `"diff"` artifacts with stub cards — **not** a prompt-side
  git-diff distiller path.

## Next consumers

1. **#11 Phase 1** — tree-sitter / code intelligence tools using this contract.
2. Hook consumers (#299, #300, #302, #303) that act on structured tool facts.
3. Later native components: build-system integration, static analysis, runtime tools.

## Explicit non-goals

- Replacing `shell` for advanced git (rebase, push, merge, hosting APIs).
- Prompt-embedded distillers as the primary size-control mechanism.
- A separate planner subsystem that selects tools outside the LLM turn loop.
- Full LSP server lifecycle in the #26 ship.
