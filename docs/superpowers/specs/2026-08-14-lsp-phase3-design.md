# LSP Code Intelligence Tools Design (Issue #11 Phase 3)

**Date:** 2026-08-14
**Status:** Implemented on `feat/ad/issue-11-lsp-phase3`
**Depends on:** Issue #11 Phase 2 / `2026-08-12-lsp-phase2-design.md` (merged via #317)
**Related epic:** Issue #195 (deterministic tools harness)
**Follow-on:** Issue #11 Phase 4 — `2026-08-21-lsp-phase4-design.md`

## Purpose

Add agent-callable LSP intelligence on the Phase 2 client: hover, completions,
semantic definition/references, and list+apply code actions. Tree-sitter
`code_*` stays the fast no-server path. Phase 3 does **not** ship signature
help, command-only actions, `WorkspaceEdit` resource ops, or lifecycle restart.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Scope | Hover, completions, code actions, semantic definition + references |
| Def/refs vs `code_*` | Keep both. `code_*` = name-based in-project; `lsp_*` = position-based semantic |
| Code actions | Two tools: `lsp_code_actions` (list) + `lsp_apply_code_action` (apply by id) |
| Apply mutator | Text edits only (multi-file OK). Reject create / rename / delete |
| Resource ops follow-up | Comment on #11 + this spec’s deferred list (no extra issue) |
| Languages | TypeScript / JavaScript only (same mapping as Phase 2) |
| Completions | Cap 20; `label` / `kind` / `detail` only; no insert/snippet/apply |
| Def/refs input | Position-based: `path`, `line`, `col` (1-based) |
| Action identity | Opaque session-scoped `id`; stale if file mtime/version changed |
| Architecture | Capability-aware queries + `CodeActionCache` on `LspManager` |
| Config | No new `[lsp]` keys; no `code_intelligence` flag |
| Runtime | TypeScript in `src/lsp/` (not napi) |

## Architecture

```
Session
  └── LspManager (existing, session-scoped)
        ├── LspClient per language (stdio JSON-RPC)
        │     initialize capabilities:
        │       Phase 2: publishDiagnostics, formatting
        │       Phase 3: hover, completion, definition,
        │                references, codeAction, resolve
        └── CodeActionCache  (id → wire action + path + version)
```

No new process model. `[lsp] enabled` plus a configured TS/JS server remains
the gate. Missing / non-executable servers still soft-fail.

Tree-sitter and LSP stay separate:

| Concern | Tree-sitter (`code_*`) | LSP (`lsp_*`) |
|---|---|---|
| Input | Symbol name (def/refs) | File + 1-based position |
| Scope | Project walk, name match | Semantic, incl. stdlib / deps |
| Server | None | External language server |
| When to use | Fast in-project queries | Types, externals, quick fixes |

Prompt / tool descriptions must state that split. Do not wrap or hide `code_*`.

## Initialize (client → server)

Extend `LspClient.start` `initialize.capabilities.textDocument` with:

- `hover`: `{ contentFormat: ["markdown", "plaintext"] }`
- `completion`: `{ completionItem: { snippetSupport: false } }`
- `definition`: `{ linkSupport: true }`
- `references`: `{}`
- `codeAction`: `{ resolveSupport: { properties: ["edit"] } }`

Store boolean flags from `InitializeResult.capabilities` (same pattern as
`documentFormattingProvider`):

- `hoverProvider`
- `completionProvider`
- `definitionProvider`
- `referencesProvider`
- `codeActionProvider`
- `codeActionProvider.resolveProvider` (nested)

Missing capability → success with `skipped: "unsupported"` (or empty list),
never `protocol_error`.

## Agent-facing tools

Existing `lsp_diagnostics` / `lsp_format` are unchanged. Failure envelope is
the Phase 2 `LspErrorCode` set.

Coordinates are **1-based** at the tool boundary; convert to LSP 0-based
`Position` / `Range` in the client.

### Shared success / skip

When the server lacks the capability, or the method is otherwise not
applicable without a protocol failure:

```ts
{ ok: true, skipped: "unsupported", /* tool-specific empty payload */ }
```

Empty “not found” is **not** a skip: `ok: true` with `hover: null` or
`locations: []`.

### `lsp_hover(path, line, col)`

Read-only. Allowed in plan mode.

```ts
{
  ok: true,
  path: string,
  line: number,
  col: number,
  language: string | null,
  hover: { contents: string, kind: "markdown" | "plaintext" } | null,
  skipped?: "unsupported",
}
```

Normalize `Hover.contents` (MarkupContent, MarkedString, or array) into one
string. Truncate at **2000** characters. `kind` is `markdown` if any part was
markdown; otherwise `plaintext`.

### `lsp_completions(path, line, col)`

Read-only. Allowed in plan mode. **Not** an apply path — inserting text stays
`edit_file`.

```ts
{
  ok: true,
  path: string,
  line: number,
  col: number,
  language: string | null,
  completions: Array<{
    label: string,
    kind?: CompletionKind,  // string, not LSP number
    detail?: string,
  }>,
  truncated?: boolean,      // server sent more than 20
  skipped?: "unsupported",
}
```

Cap **20** items. Drop `insertText`, `textEdit`, `additionalTextEdits`,
snippets, and documentation. `detail` truncated at 200 chars.

`CompletionKind` is the LSP `CompletionItemKind` number mapped to a string
(unknown / missing / out of range → omit `kind`):

| LSP | kind | LSP | kind |
|---|---|---|---|
| 1 | `text` | 14 | `keyword` |
| 2 | `method` | 15 | `snippet` |
| 3 | `function` | 16 | `other` (Color) |
| 4 | `constructor` | 17 | `file` |
| 5 | `field` | 18 | `other` (Reference) |
| 6 | `variable` | 19 | `folder` |
| 7 | `class` | 20 | `enumMember` |
| 8 | `interface` | 21 | `constant` |
| 9 | `module` | 22 | `struct` |
| 10 | `property` | 23 | `other` (Event) |
| 11 | `other` (Unit) | 24 | `operator` |
| 12 | `other` (Value) | 25 | `typeParameter` |
| 13 | `enum` | | |

### `lsp_definition(path, line, col)` / `lsp_references(path, line, col)`

Read-only. Allowed in plan mode.

```ts
{
  ok: true,
  path: string,
  line: number,
  col: number,
  language: string | null,
  locations: Array<{
    path: string,
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
  }>,
  truncated?: boolean,
  skipped?: "unsupported",
}
```

Accept `Location`, `Location[]`, `LocationLink[]`, or `null`. For
`LocationLink`, use `targetSelectionRange` (fallback `targetRange`) and
`targetUri`. Reject / drop URIs outside the workspace root (do not return them).

Caps: definition **20**, references **50**. `textDocument/references` uses
`context.includeDeclaration: true` (LSP default). No extra tool params.

### `lsp_code_actions(path, startLine, startCol, endLine, endCol)`

Read-only. Allowed in plan mode. Point ranges (`start === end`) are valid.

```ts
{
  ok: true,
  path: string,
  language: string | null,
  range: { startLine, startCol, endLine, endCol },
  actions: Array<{
    id: string,             // opaque, e.g. ca_1
    title: string,
    kind?: string,          // server kind, e.g. "quickfix"
    preferred?: boolean,
  }>,
  truncated?: boolean,      // more than 20 applicable actions
  skipped?: "unsupported",
}
```

Cap **20**. **Only list actions we can apply:**

- already has a text `edit` / `documentChanges` with only text edits, or
- has `data` and the server advertised `resolveProvider`

Omit command-only actions (`command` without an edit and without resolvable
`data`). Do not call `workspace/executeCommand` in this phase.

Replace that path’s cached actions on each list call (previous ids for that
path become invalid).

### `lsp_apply_code_action(id)`

Mutating. Blocked in plan mode. Write-path serialized.

```ts
{
  ok: true,
  id: string,
  changed: boolean,
  files: Array<{ path: string, changed: boolean }>,
  skipped?: "unsupported" | "no_edits",
}
```

Stale / unknown id → `{ ok: false, code: "invalid_argument", error }` telling
the agent to list again. Do not apply.

## CodeActionCache

Session-scoped on `LspManager`. Not persisted to the event log. Cleared on
`shutdown`.

Entry:

```ts
{
  id: string,
  language: string,
  path: string,       // originating file from the list call
  mtimeMs: number,
  version: number,    // LSP document version at list time
  action: unknown,    // wire CodeAction (never shown to the agent)
}
```

Ids are `ca_<n>`, unique per session, never reused.

**Stale if** the originating file’s mtime or the manager’s document version
no longer matches the entry. After resolve, if the edit set includes other
files, those files must also still match a last-known mtime captured at list
time when we already knew them; newly revealed files after resolve are
checked immediately before write (must exist, in workspace/sandbox).

`lsp_apply_code_action`:

1. Lookup id; missing → `invalid_argument`.
2. Stale originating file → `invalid_argument`.
3. If no `edit`, and `resolveProvider`, call `codeAction/resolve` (same
   `timeout_ms`). Still no edit → `ok: true`, `skipped: "unsupported"`,
   `changed: false`.
4. Flatten text edits (below). Reject resource ops.
5. Acquire remaining write locks; apply atomically; sync docs; `clearReadPath`
   for every written path; drop cache entries whose `path` or edit targets
   include those paths.

## Apply safety

1. Flatten `WorkspaceEdit.changes` and `documentChanges` **text** edits
   (`TextDocumentEdit.edits`). Ignore `annotationId`.
2. Any `CreateFile` / `RenameFile` / `DeleteFile` in `documentChanges` →
   reject entire apply, files unchanged, `ok: true`, `skipped: "unsupported"`.
3. URI outside workspace root or sandbox → `invalid_argument`, nothing written.
4. Overlapping or out-of-bounds edits on a file → `protocol_error`, **no
   partial write** (all files or none). Reuse Phase 2 `applyTextEdits`.
5. Per file: apply ranges descending (end → start). Then `didChange`,
   `clearReadPath`, drop related cache entries.
6. Apply is atomic across the file set: write all to memory first; if any
   file fails validation, write none. Then write files sequentially; if a
   write throws mid-way, return `io_error` (best-effort; do not invent a
   rollback journal). Validation-before-write is the guarantee we test.

### Write-path lock

`lsp_apply_code_action` joins `WRITE_TOOLS` and `PLAN_MODE_BLOCKED_TOOLS`.

Args are only `{ id }`, so the pre-hook cannot read paths from arguments:

- Pre: resolve the cache entry; `tryAcquire` the **originating** path. Cache
  miss → do not block in the hook; the tool returns `invalid_argument`.
- After resolve, before any disk write: `tryAcquire` any additional target
  paths. If any fail, release those extras, apply nothing, return the lock
  error.
- Post: release **all** paths this call acquired (originating + extras), not
  only something derived from args.

Implementation may attach the acquired set on the guard keyed by tool-call,
or have `LspManager` expose `pathsForAction(id)` plus
`acquireApplyTargets(paths)`.

## Language mapping

Unchanged from Phase 2:

| Extensions | `[lsp.servers]` key |
|---|---|
| `.ts`, `.tsx`, `.mts`, `.cts` | `typescript` |
| `.js`, `.jsx`, `.mjs`, `.cjs` | `javascript` → fallback to `typescript` |

Other extensions: `unsupported`. Python / Go / Rust mapping is deferred.

## Errors

Same codes as Phase 2. Mapping:

| Situation | Result |
|---|---|
| `[lsp] enabled = false` | `disabled` |
| No server / spawn fail / process dead | `unavailable` |
| Bad path / coords / unknown or stale id | `invalid_argument` |
| File unreadable | `io_error` |
| Request exceeds `timeout_ms` | `timeout` |
| No language mapping / oversized file | `unsupported` (or skip) |
| Malformed / overlapping edits | `protocol_error` |
| Session ending | `cancelled` / `unavailable` |

Apply never flips a *previous* successful `edit_file` in the session. It only
guarantees all-or-nothing **within that apply** for validation errors.

Crash restart shipped in Phase 4 (`2026-08-21-lsp-phase4-design.md`).

## Testing strategy

Deterministic fake stdio LSP fixture (`tests/fixtures/fake-lsp-server.ts`).
CI must **not** require `typescript-language-server`.

New scripted behavior (env-driven, same pattern as `FAKE_LSP_DIAGNOSTICS`):

- `textDocument/hover`, `completion`, `definition`, `references`, `codeAction`
- `codeAction/resolve` — `edit` present only after resolve
- `documentChanges` resource ops — apply must reject
- overlapping text edits — reject, no partial write
- capability off switches (`FAKE_LSP_NO_HOVER=1`, …)
- LocationLink payloads
- completion lists longer than 20 (assert `truncated`)
- stale apply: list → touch file → apply fails

Coverage: client methods + capability skip, manager cache / stale / resolve /
multi-file apply / resource-op reject, tools (plan mode, sandbox, 1-based
coords), write-path locking originating + extra targets, session shutdown
clears cache.

## Documentation updates (implementation PR)

- This spec + implementation plan
- `AGENTS.md` — Phase 3 tools; `code_*` vs `lsp_*` guidance
- `docs/ARCHITECTURE.md` / `docs/concepts.md`
- Tool catalog (`src/tools/index.ts`) and TUI icons
- Comment on GitHub issue #11 listing deferred items (no extra issue)
- Phase 2 spec: point follow-on at this file

## Explicit non-goals / deferred (track on #11)

- Full `WorkspaceEdit` resource ops (create / rename / delete)
- `workspace/executeCommand` / command-only code actions
- Signature help
- Language mapping beyond TS/JS
- Completions insert/apply (`insertText` / snippets / additionalTextEdits)
- `code_intelligence` config flag
- Phase 4: crash restart, exponential backoff, multi-root — see `2026-08-21-lsp-phase4-design.md`
- Bundling or auto-installing language servers
- CLI fallback formatters
- Auto post-edit pipeline for `write_file` / `batch_write`
- Changing Tree-sitter `code_*` semantics

## Acceptance criteria

1. With `[lsp] enabled` and a configured TS server (or fixture), the six new
   tools reuse the same `LspClient` as diagnostics/format; session end shuts
   it down and clears the action cache.
2. Disabled / missing server / missing capability soft-fails; session continues.
3. Completions never exceed 20 items and never include insert/snippet payloads.
4. `lsp_definition` / `lsp_references` are position-based; `code_*` unchanged.
5. `lsp_code_actions` returns opaque ids; apply by id writes text edits only;
   create/rename/delete and command-only actions are not applied.
6. Stale id (file changed after list) refuses to apply.
7. Plan mode blocks `lsp_apply_code_action` only among the new tools.
8. Focused LSP tests pass without a real language server; typecheck clean.
