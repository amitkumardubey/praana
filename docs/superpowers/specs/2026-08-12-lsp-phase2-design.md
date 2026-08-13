# LSP Diagnostics + Formatting Design (Issue #11 Phase 2)

**Date:** 2026-08-12
**Status:** Implemented on `feat/ad/issue-11-lsp-phase2` (pending PR)
**Depends on:** Issue #11 Phase 1 / `2026-08-12-tree-sitter-code-intel-design.md`
**Related epic:** Issue #195 (deterministic tools harness)
**Related:** Issue #299 (post-edit verification — can consume LSP diagnostics later)

## Purpose

Add an **opt-in** Language Server Protocol (LSP) tier for diagnostics and
formatting. Tree-sitter (`code_*`) remains the fast, no-server syntax / name
query tier. Phase 2 does **not** ship hover, completions, or code actions
(those are Phase 3).

## Decisions (locked)

| Decision | Choice |
|---|---|
| Default enabled | `false` — must opt in via `[lsp]` |
| Format on edit | Opt-in: `format_on_edit = false` by default |
| First tested language | TypeScript / JavaScript only |
| Runtime location | TypeScript in `src/lsp/` (not napi / Rust) |
| Lifecycle ownership | One `LspManager` per `Session` |
| Workspace root | Single git root (or cwd if not a git repo) |
| Restart / backoff / multi-root | Deferred to Phase 4 |
| CLI fallback formatters (`prettier`, etc.) | Out of scope for Phase 2 |
| Automated post-edit pipeline | `edit_file` / `batch_edit` only (not `write_file` / `batch_write`) |

## Architecture

```
Session
  └── LspManager (lazy, session-scoped)
        └── LspClient per language (stdio JSON-RPC)
              └── configured server process (e.g. typescript-language-server)

Turn loop
  pre_tool_call  → write-path lock → (optional) LSP diagnostic snapshot
  tool execute   → edit_file / batch_edit / lsp_*
  post_tool_call → LSP post-edit (format + diag diff) → release write-path lock
  session_end    → LspManager.shutdown()
```

Tree-sitter and LSP stay separate:

| Concern | Tree-sitter (`code_*`) | LSP (`lsp_*` + post-edit) |
|---|---|---|
| Startup | ~ms, in-process | ~1–5s, child process |
| Diagnostics | Syntax / parse errors | Type / lint / workspace |
| Formatting | No | Yes (`textDocument/formatting`) |
| Missing dependency | Soft-fail `unavailable` | Soft-fail `unavailable` |

## Configuration

```toml
[lsp]
enabled = false
diagnostics = true
format_on_edit = false
timeout_ms = 5000
# Max lines per file for diagnostics / format requests (issue #11: 10k)
max_file_lines = 10000

# Language id → argv (first element is executable). Empty / omit = no server.
# Example (user installs typescript-language-server themselves):
# servers = { typescript = ["typescript-language-server", "--stdio"] }
[lsp.servers]
# typescript = ["typescript-language-server", "--stdio"]
# javascript maps to the same server via language aliases in code
```

Defaults when `[lsp]` is omitted: all of the above defaults apply; `servers` is
empty. Missing / non-executable server commands soft-fail — never abort session
start.

Validation (warn, do not throw):

- `timeout_ms` must be a positive integer (clamp or warn + fall back to 5000)
- `max_file_lines` must be a positive integer
- `servers` values must be non-empty string arrays

## Agent-facing tools

### `lsp_diagnostics(path)`

Read-only. Allowed in plan mode.

Success:

```ts
{
  ok: true,
  path: string,           // absolute
  language: string | null,
  diagnostics: LspDiagnostic[],
  truncated?: boolean,    // true if file exceeded max_file_lines
}
```

### `lsp_format(path)`

Mutating. Blocked in plan mode. Uses write-path serialization.

Success:

```ts
{
  ok: true,
  path: string,
  language: string | null,
  changed: boolean,
  // present when formatting was skipped for a soft reason
  skipped?: "unsupported" | "unavailable" | "oversized" | "no_edits",
}
```

Failure envelope (both tools):

```ts
{ ok: false, error: string, code: LspErrorCode }
```

```ts
type LspErrorCode =
  | "unavailable"
  | "disabled"
  | "invalid_argument"
  | "io_error"
  | "timeout"
  | "unsupported"
  | "protocol_error"
  | "cancelled"
  | "internal";
```

### Coordinates

Agent-facing ranges are **1-based** (match `code_*` / `search_code`). Convert
to/from LSP’s 0-based `Position` at the client boundary.

```ts
interface LspDiagnostic {
  path: string;
  message: string;
  severity: "error" | "warning" | "information" | "hint" | "unknown";
  source?: string;
  code?: string | number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}
```

## Post-edit pipeline (`edit_file` / `batch_edit`)

Only when `lsp.enabled` and diagnostics or `format_on_edit` apply to the
edited path’s language:

1. **Pre** (after write-path lock acquired): if `diagnostics`, snapshot current
   LSP diagnostics for each edited path (open/sync document as needed). Soft
   skip on unavailable server.
2. **Execute** the edit as today.
3. **Post** (before write-path release):
   - Sync document content with the server (`didChange` full text).
   - If `format_on_edit`: request formatting; apply safe edits; invalidate
     read-path / artifact index when the file changes.
   - If `diagnostics`: collect after diagnostics; compute **introduced** =
     after − before (same path + range + severity + message + code).
4. Patch the successful tool result with a bounded `lsp` object. LSP failures
   become soft fields / warnings — they **never** roll back a successful edit
   and never flip `ok: true` → `ok: false`.

```ts
{
  ok: true,
  // …existing edit fields…
  lsp?: {
    formatted?: boolean;
    format_skipped?: string;
    diagnostics?: LspDiagnostic[];      // after, capped
    introduced?: LspDiagnostic[];       // newly introduced, capped
    warning?: string;                   // soft LSP failure
  }
}
```

Caps: return at most **50** diagnostics / introduced entries (document
truncation in the envelope if needed).

`write_file` / `batch_write` are **not** auto-instrumented in Phase 2. Agents
can still call `lsp_diagnostics` / `lsp_format` explicitly.

## Lifecycle

- **Lazy start:** first tool / post-edit request for a language with a
  configured server spawns the process and runs `initialize` / `initialized`.
- **Reuse:** one client per `(session, language)` for the session lifetime.
- **Timeout:** every request uses `timeout_ms` (default 5000). Timed-out
  requests reject with `timeout`; the client remains usable unless the process
  has exited.
- **Shutdown:** on `session_end`, send `shutdown` + `exit`, then SIGTERM the
  child if still alive after a short grace period. Shutdown errors are logged
  and do not fail session end.
- **No Phase 2 restart:** if the process crashes, subsequent calls return
  `unavailable` (or a one-shot re-init attempt is **not** required). Documented
  Phase 4 work.

## Language mapping (Phase 2)

| Extensions | Language id for `[lsp.servers]` |
|---|---|
| `.ts`, `.tsx`, `.mts`, `.cts` | `typescript` |
| `.js`, `.jsx`, `.mjs`, `.cjs` | `javascript` → falls back to `typescript` server entry if no `javascript` key |

Other languages: manager returns soft `unavailable` / `unsupported` until a
server is configured **and** Phase 2+ coverage exists. Architecture stays
language-keyed so Python / Go / Rust can plug in later without redesign.

## Safety

- Sandbox (`[shell] allowed_paths` when enabled) checked **before** spawning
  requests or writing formatted content — same path rules as `code_*` /
  `edit_file`.
- `lsp_format` joins plan-mode blocked tools and write-path serialization.
- Reject overlapping / out-of-bounds `TextEdit`s from the server; leave file
  unchanged and return `protocol_error` or soft skip for post-edit.
- Apply text edits in descending document order (end → start) so offsets stay
  valid.
- Do not trust server-returned URIs outside the workspace root / sandbox.
- Kill only the owned child process group on timeout / shutdown — no new global
  signal handlers.

## Hook / lock ordering

Registration order for builtins:

1. `pre_tool_call`: plan-mode → write-path acquire → LSP pre-snapshot
2. `post_tool_call`: LSP post-edit → write-path release

This keeps formatting under the same path lock as the original edit so a
concurrent `read_file` / second writer cannot race the formatter write.

## Explicit non-goals (Phase 2)

- Hover, completions, signature help, code actions (Phase 3)
- Semantic `lsp_definition` / `lsp_references` (Phase 3+)
- Crash restart with exponential backoff (Phase 4)
- Multi-root / per-package workspace folders (Phase 4)
- Bundling or auto-installing language servers
- CLI fallback formatters (`prettier`, `rustfmt`, …)
- Changing Tree-sitter `code_*` semantics or native API version
- Auto post-edit pipeline for `write_file` / `batch_write`

## Testing strategy

Deterministic **fake stdio LSP fixture** (small Node/Bun script in
`tests/fixtures/` or `scripts/`) that speaks Content-Length JSON-RPC:

- `initialize` / `initialized`
- `textDocument/didOpen` / `didChange`
- `publishDiagnostics` (scripted payloads)
- `textDocument/formatting` (scripted edits, including overlapping / empty)
- delayed responses (timeouts)
- malformed frames
- clean `shutdown` / `exit`

CI must **not** require a globally installed `typescript-language-server`.
Optional manual / local real-server smoke can be documented but is not a gate.

Coverage matrix: config, client framing, manager lifecycle, tools, sandbox,
plan mode, post-edit diff, write-lock ordering, session shutdown.

## Documentation updates (implementation PR)

- Spec (this file) + implementation plan
- `AGENTS.md` — `[lsp]` config + tools
- `docs/ARCHITECTURE.md` / `docs/concepts.md` — two-tier code intel
- `praana.config.example.toml` — commented `[lsp]` block
- Phase 1 spec status note: Phase 2 design exists

## Acceptance criteria

1. With `[lsp] enabled = true` and a configured TS server (or fixture), first
   `lsp_diagnostics` / `lsp_format` starts one process; later calls reuse it;
   session end shuts it down.
2. Disabled / missing server soft-fails without aborting the session.
3. Successful `edit_file` / `batch_edit` can attach `lsp.introduced` diagnostics;
   formatting runs only when `format_on_edit = true`.
4. Tree-sitter tools remain unchanged in behavior.
5. Full focused LSP tests pass without external language servers; typecheck clean.
