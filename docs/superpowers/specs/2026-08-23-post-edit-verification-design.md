# Automatic Post-Edit Verification Design (Issue #299)

**Date:** 2026-08-23
**Status:** Implemented on `feat/ad/issue-299-post-edit-verification`
**Depends on:** #297 turn-loop hooks, #11 Phase 1 tree-sitter (`parseFile` / `listImports`)
**Related epic:** #195 (deterministic tools harness)
**Related:** #321 (on-demand `run_tests` — out of scope)

## Purpose

After a successful write/edit, attach deterministic verification to the **same
tool result**: tree-sitter syntax, scoped `tsc --noEmit`, and reverse-import
test-impact. The agent no longer has to choose `bun typecheck` / `bun test`
one turn later.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Default | Opt-in: `[verify] enabled = false` |
| Triggers | `write_file`, `edit_file`, `batch_write`, `batch_edit` only |
| Never | `lsp_format`, `lsp_apply_code_action` |
| Fail-fast | Syntax or typecheck errors → do not run tests (`skipped: "errors_present"`) |
| Soft-fail | Missing native / no tsconfig / no tests / timeout never flip `ok: true` |
| Agent tools | None. Payload is `result.verify` |
| Distillers | Not used in the prompt. Capped structured payload only |
| Hook order | LSP post-edit → verify → write-path release |

## Configuration

```toml
[verify]
enabled = false
syntax = true
typecheck = true
tests = true
timeout_ms = 30000
max_test_files = 20
```

Invalid `timeout_ms` / `max_test_files` warn and fall back. Boolean keys that
are not booleans warn and fall back to the defaults above.

## Payload

```ts
result.verify = {
  cached?: true,
  syntax?: { diagnostics: ParseDiagnostic[], skipped?: string },
  typecheck?: { errors: Array<{ file, line, col, message }>, skipped?: string },
  tests?: {
    passed?: number,
    failed?: number,
    files?: string[],
    failures?: Array<{ name, file, message }>,
    skipped?: string,
    graph_truncated?: boolean,
  },
}
```

## Syntax

`loadNative().parseFile` (same as `code_parse`). Cap 20 diagnostics.
Native unavailable → `syntax.skipped = "native_unavailable"`; typecheck still
runs for TS files.

## Scoped typecheck

Nearest `tsconfig.json` walking from the file toward the session git root.
Spawn `bun x tsc --noEmit -p <dir>` if `bun` is on PATH, else `npx tsc --noEmit -p <dir>`.
TS extensions only (`.ts` / `.tsx` / `.mts` / `.cts`).
No tsconfig → `skipped: "no_tsconfig"`. Cap 20 errors. Timeout = `timeout_ms`.

## Test-impact

Build a reverse import graph from `listImports` under `resolveLspRoot` (or
session root). Relative specifiers only. Affected tests = `*.test.*` /
`*.spec.*` importers plus the file itself if it is a test.

More than `max_test_files` → `skipped: "too_many"` (list first N paths).
Runner v1: `bun test <files>` if `bun` exists, else `skipped: "no_runner"`.
None affected → `skipped: "none_affected"`.

## Hash cache

SHA-256 of file bytes. After a verify with no syntax/tsc errors and tests not
failed (or `none_affected`), remember the hash. Same hash next time →
`verify.cached = true` and skip work.

## Testing

Inject `parseFile`, `listImports`, `runTypecheck`, `runTests`. Unit tests do
not spawn real `tsc` / `bun test` or require `@praana/natives`.

## Explicit non-goals

- #321 `run_tests` tool
- Full-suite auto-run, Nx/Turbo graphs
- Default-on `[verify]`
- Prompt-side distillers
