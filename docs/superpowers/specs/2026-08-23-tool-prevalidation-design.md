# Tool-Call Pre-Validation and Error Enrichment Design (Issue #300)

**Date:** 2026-08-23
**Status:** Implemented on `feat/ad/issue-300-tool-prevalidation`
**Depends on:** #297 turn-loop hooks (`pre_tool_call` / `post_tool_call`)
**Related epic:** #195 (deterministic tools harness)
**Related:** #299 (post-edit verify — different hook, after a successful write)

## Purpose

Fail-fast deterministic checks **before** a tool runs, and recovery context
**after** a tool fails — so a typo path or unread `edit_file` does not spend
an LLM round-trip on a bare `{ ok: false, error }`.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Default | Always on. No `[validate]` config key |
| Mechanism | Hooks only. No new agent-facing tools |
| Auto-correct | **Never** rewrite args. Block + `suggestions` |
| Pre-block result | `{ ok: false, error, suggestions? }` (`isError: true`) |
| Post-enrich | Patch a failed result with the same fields; never flip `ok` |
| Hook order (pre) | plan → **validate** → write-path acquire → LSP snapshot |
| Hook order (post) | LSP post-edit → verify → **enrich** → write-path release |
| Soft-fail | `git ls-files` / event-log lookup failure → no suggestions, original error only |

Validate sits **before** write-path acquire so a block cannot leak a lock.

## v1 checks (pre)

### `read_file`

If the resolved path does not exist: **block** with up to **5** fuzzy
suggestions from `git ls-files` plus the session read index (basename,
relative suffix, small edit-distance). Existing files pass through.

### `edit_file`

- File exists and was **not** read this session (`hasReadPath`): **hard-block**
  with `"read the file first"` (and the path). Symmetric with the repeat-read
  interceptor — `edit_file` needs exact text.
- Path missing: same fuzzy suggestions as `read_file`.
- `write_file`, `batch_*`, and creating a new file are **out of this check**.

### `shell`

- If `cwd` is passed and does not exist: **block**.
- If the first token is not in this closed builtin set and is not on `PATH`:
  **block**. Builtins: `cd`, `echo`, `printf`, `true`, `false`, `[`, `test`,
  `pwd`, `export`, `unset`, `alias`, `command`, `type`, `set`, `shift`,
  `source`, `.`, `eval`, `exec`, `exit`, `return`, `read`, `umask`, `ulimit`,
  `times`, `trap`, `wait`, `hash`, `help`, `history`, `fc`, `bg`, `fg`, `jobs`,
  `kill`, `bind`, `builtin`, `caller`, `compgen`, `complete`, `compopt`,
  `declare`, `typeset`, `dirs`, `enable`, `getopts`, `let`, `local`, `logout`,
  `mapfile`, `readarray`, `popd`, `pushd`, `shopt`, `suspend`.
- No pipeline / `&&` parsing. First token only.

## v1 enrich (post)

On a **failed** path-bearing tool (`read_file`, `edit_file`, `write_file`,
`search_code`, `lsp_*` with a `path` arg):

```ts
result.suggestions?: string[]   // cap 5
result.recent_writes?: Array<{ path: string; turn?: number }>  // from event log
```

Never flips `ok`. Soft-fail if the event log cannot be read.

## Hook contract

Extend the `pre_tool_call` block shape:

```ts
{ action: "block"; error: string; isError?: boolean; suggestions?: string[] }
```

`turn.ts` copies `suggestions` onto `{ ok: false, error, suggestions }`.

`HookSessionLike` grows only what validate needs: `hasReadPath?(abs)` and
optional `recentWritesForPath?(abs)` (session implements via scorecard /
event log). Do not import `Session` into the handler.

## Fuzzy matching

Pure helper `suggestPaths(query, candidates, cap = 5)`:

- Prefer basename equality, then suffix match, then Levenshtein on basename
  (cap distance 2 or 30% of length, whichever is larger).
- Candidates = `git ls-files` (injected in tests) ∪ session read-index paths.
- Skip `node_modules/` and paths outside the session root.

## Testing

Inject `listRepoFiles`, `hasReadPath`, `commandOnPath`, `pathExists`,
`recentWrites`. Unit tests do not spawn real `git` except optional marked
integration.

Acceptance:

- Missing `read_file` path → `{ ok: false, suggestions }` including a close
  filename; no disk read.
- `edit_file` of an unread existing file → block; after a `read_file` of that
  path, the same edit is allowed.
- `shell` with a nonsense first token → block; `echo hi` is allowed.
- Failed `write_file` (e.g. sandbox) still `ok: false` with optional
  `recent_writes`; `ok` unchanged.
- `git ls-files` throws → suggestions omitted, hook does not throw.

## Files

- Create: `src/hooks/handlers/validate.ts`, `src/validate/fuzzy-path.ts`,
  `src/validate/shell-check.ts`
- Modify: `src/hooks/types.ts` (block + session surface), `src/hooks/index.ts`,
  `src/hooks/registry.ts` (forward `suggestions`), `src/turn.ts`,
  `src/session.ts`
- Tests: `tests/validate-fuzzy.test.ts`, `tests/validate-hook.test.ts`,
  extend `tests/hooks.test.ts`
- Spec: this file
- Docs: `AGENTS.md`, `ARCHITECTURE.md`, `concepts.md`; comment on #300

## Explicit non-goals

- Silent path rewrite / auto-apply of a suggestion
- `batch_edit` / `batch_write` unread checks
- Pipeline-aware shell validation
- `[validate]` config / default-off
- New agent-facing tools
- Changing plan-mode or write-path semantics
