# Tree-Sitter Code Intel Design (Issue #11 Phase 1)

**Date:** 2026-08-12
**Status:** Merged via #315; Rust grammar follow-up in #316
**Depends on:** Issue #313 / `2026-08-11-rust-native-runtime-design.md` (skeleton shipped)
**Related epic:** Issue #195 (deterministic tools harness)
**Related:** Issue #299 (post-edit verification — shared parse/import API)
**Follow-on:** Issue #11 Phase 2 — `2026-08-12-lsp-phase2-design.md`

## Purpose

Ship the first **production** consumer of `@praana/natives`: in-process tree-sitter
parsing for TypeScript/TSX, JavaScript/JSX, Python, Go, and Rust, exposed as read-only
harness tools. This is #11 Phase 1 only — no LSP servers.

## Agent-facing tools

Issue #11 originally named tools `lsp_*`. Phase 1 is tree-sitter, so tools use
the `code_*` prefix; `lsp_*` is reserved for Phases 2–4.

| Tool | Native export | Purpose |
|---|---|---|
| `code_parse` | `parseFile` | Language detection + syntax diagnostics |
| `code_imports` | `listImports` | Structured imports for a file |
| `code_symbols` | `listSymbols` | Top-level / exported symbols for a file |
| `code_definition` | `findDefinition` | Project-scoped name-based definition hits |
| `code_references` | `findReferences` | Project-scoped name-based reference hits |

All five are read-only (allowed in plan mode). Soft-fail when the native addon
is missing or `[native] enabled = false`:

```json
{ "ok": false, "error": "native unavailable: …", "code": "unavailable" }
```

## Native API (`NATIVE_API_VERSION` 0.2.0)

Major remains `0`. New exports (JSON-friendly napi objects):

### Shared shapes

```ts
type NativeErrorCode =
  | "unavailable" | "version_mismatch" | "invalid_argument"
  | "io_error" | "parse_error" | "unsupported_language"
  | "cancelled" | "internal";

interface ParseDiagnostic {
  message: string;
  startLine: number; // 1-based
  startCol: number;  // 1-based
  endLine: number;
  endCol: number;
}

interface SymbolHit {
  path: string;
  name: string;
  kind: string;       // function | class | method | interface | type | variable | constant | enum | struct | other
  exported: boolean;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

interface ImportHit {
  path: string;
  source: string;     // module specifier / import path string
  names: string[];    // imported binding names (may be empty for side-effect imports)
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

interface ProjectQueryOpts {
  language?: string;  // restrict walk to one language id
  maxFiles?: number;  // default 2000
  maxHits?: number;   // default 100
}
```

### Exports

| Export | Success shape |
|---|---|
| `parseFile(path, language?)` | `{ ok, language, diagnostics[] }` |
| `listImports(path, language?)` | `{ ok, language, imports: ImportHit[] }` |
| `listSymbols(path, language?)` | `{ ok, language, symbols: SymbolHit[] }` |
| `findDefinition(root, symbol, opts?)` | `{ ok, hits: SymbolHit[] }` |
| `findReferences(root, symbol, opts?)` | `{ ok, hits: SymbolHit[] }` |

Failure shapes always include `{ ok: false, error: string, code: NativeErrorCode }`.

Callers pass **already-validated absolute paths**. Native does not implement
sandbox policy.

## Languages

| Id | Extensions | Grammar crate |
|---|---|---|
| `typescript` | `.ts` | `tree-sitter-typescript` (typescript) |
| `tsx` | `.tsx` | `tree-sitter-typescript` (tsx) |
| `javascript` | `.js`, `.mjs`, `.cjs` | `tree-sitter-javascript` |
| `jsx` | `.jsx` | `tree-sitter-javascript` (JSX enabled) |
| `python` | `.py` | `tree-sitter-python` |
| `go` | `.go` | `tree-sitter-go` |
| `rust` | `.rs` | `tree-sitter-rust` |

Detection: explicit `language` override if provided, else extension. Unsupported
extension → `unsupported_language`.

Grammars are **compiled into** the `.node` binary. No runtime downloads.

## Query strategy

- Per-language tree-sitter **queries** extract definitions, imports, and
  identifier references.
- `listSymbols` prefers exported / top-level declarations; methods may be
  included when clearly nested under a class/type.
- `findDefinition` / `findReferences` are **name-based**, not type-aware:
  every declaration (or identifier use) whose text equals `symbol` is a hit.
  They do not resolve into `node_modules`, stdlib, or across package boundaries
  beyond the walk root.

## Project walk

- Root: absolute directory validated by TypeScript.
- Walker: `ignore` crate — respects `.gitignore` when present; always skips
  `.git`, `node_modules`, `target`, `dist`, `.praana`, build caches.
- Caps: `max_files` default **2000**, `max_hits` default **100**. Truncation
  is not an error; success still returns `ok: true` with the capped list
  (tools may surface `truncated: true` in the TS envelope).

## Config

```toml
[native]
enabled = true   # false = never load addon; tools return unavailable
require = false  # reserved; Phase 1 never aborts session start on missing addon
```

## TypeScript ownership

- Zod schemas + `defineTool` factory in `src/tools/code-intel.ts`
- Sandbox / cwd path resolution (same pattern as `search_code`)
- Lazy `loadNative()` via `src/native/`
- Artifact classification: `code_*` → `search_results`; command labels from
  path / symbol
- Classic and engine modes both register the tools

## Relation to other work

- **#195** — tools obey the harness contract (typed `{ ok }` unions, graceful
  preconditions, factory registration).
- **#299** — `parseFile` / `listImports` are the shared parse surface for
  future post-edit verification.
- **#11 Phases 2–4** — LSP lifecycle, formatting, hover/completions; out of
  scope here.

## Explicit non-goals

- LSP servers or language-server diagnostics/formatting
- Type-aware / cross-package resolution
- Multi-target npm leaf publish beyond existing Linux x64 CI smoke
- Native shell / free-form FS escape hatches

## Testing

- Rust unit tests with inline fixtures per language
- `tests/native-loader.test.ts` stubs include new exports
- `tests/code-intel-tools.test.ts` for unavailable / sandbox / happy path
- `packages/praana-natives/smoke.ts` exercises `listSymbols` on a tiny file
- Gate: `cargo test -p praana-natives`, natives build+smoke, `bun typecheck && bun test`
