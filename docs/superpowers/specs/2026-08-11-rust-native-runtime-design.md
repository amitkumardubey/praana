# Rust Native Capability Runtime Design (Issue #313)

**Date:** 2026-08-11
**Status:** Approved (implementation in progress)
**Prerequisite for:** Issue #11 Phase 1 (tree-sitter code intel)
**Related epic:** Issue #195 (deterministic tools harness)

## Purpose

Add a **Rust/napi-rs native capability layer** that PRAANA loads from Bun via
prebuilt platform binaries, modeled after Oh My Pi’s split:

- **TypeScript** owns the agent loop, tool registry, Zod schemas, plan mode,
  sandbox policy, write-path locks, hooks, event log, artifacts, telemetry, and UI.
- **Rust** owns measured, deterministic hot-path primitives (AST/parse, later
  search/walk, and only after a separate threat model: process helpers).

This is **not** a rewrite of the tool registry into Rust.

## Motivation

1. **#11** needs tree-sitter for TS/JS, Python, and Go. Doing that in a native
   crate avoids WASM grammar packaging and gives a shared parse/import API for
   **#299** (post-edit verification).
2. Epic **#195** already anticipates “later native components.” Establishing the
   runtime boundary once prevents each new harness tool from inventing its own
   FFI/process bridge.
3. Bun implements Node-API and can load `.node` addons; napi-rs is the same path
   OMP uses. PRAANA still gates releases on **its own** Bun matrix.

## Architecture

```
Agent turn (src/turn.ts)
  → createAllTools / ToolDefinition.execute (TypeScript)
  → pre_tool_call hooks (plan mode, write-path locks)
  → tool facade (Zod + sandbox + path policy)
  → src/native/ bindings (lazy load)
  → @praana/natives .node addon (napi-rs)
  → Rust primitives (typed JSON-friendly structs)
  → tool result → artifacts / telemetry / TUI (TypeScript)
```

### Ownership rules

| Concern | Owner |
|---|---|
| Tool name, description, Zod parameters | TypeScript |
| Plan mode / sandbox / confirm / path locks | TypeScript |
| AbortSignal coordination | TypeScript (may pass cancel token into native) |
| Artifact type, command label, scorecard | TypeScript |
| Parse / symbol index / ignore-aware walk / search | Rust (when migrated) |
| Generic shell execution | TypeScript until a dedicated threat-model ADR |

Native functions are **capability-specific**. They must not expose a free-form
“run arbitrary shell” or “read any path” escape hatch that bypasses TS policy.
Callers pass already-validated absolute paths and bounded options.

## Package layout

```
crates/praana-natives/     # Rust cdylib (napi-rs)
packages/praana-natives/   # JS loader + package.json + optional platform leaves
src/native/                # PRAANA adapter (NativeBindings, lazy load, errors)
```

Root `package.json` depends on `@praana/natives` (workspace or published version).
The CLI entry remains Bun (`bin/praana.js` → `src/main.ts`).

## API contract (v1)

### Versioning

- Export `nativeVersion(): string` — semver of the addon API (not npm package alone).
- Export `NATIVE_API_VERSION` constant mirrored in TypeScript.
- On load, TypeScript checks major compatibility. Mismatch →
  `NativeUnavailableError` with code `version_mismatch`; tools fall back or
  return `{ ok: false, error }`.

### Error envelope

Native throws or returns structured errors that the TS adapter maps to:

```ts
type NativeErrorCode =
  | "unavailable"        // addon missing / failed to dlopen
  | "version_mismatch"
  | "invalid_argument"
  | "io_error"
  | "parse_error"
  | "unsupported_language"
  | "cancelled"
  | "internal";

class NativeUnavailableError extends Error {
  code: NativeErrorCode;
  causeMessage?: string;
}
```

Tool facades never crash the turn on native failure. Prefer:
1. fallback implementation (when one exists), else
2. `{ ok: false, error: "…" }` with a stable scannable string.

### v1 exports (skeleton)

| Export | Purpose |
|---|---|
| `nativeVersion()` | API version string |
| `ping()` | Smoke test; returns `"pong"` |

### First production exports (#11 Phase 1 — after skeleton)

| Export | Purpose |
|---|---|
| `parseFile(path, language?)` | Syntax diagnostics + language detection |
| `listImports(path)` | Structured imports |
| `listSymbols(path)` | Exported / top-level symbols |
| `findDefinition(root, symbol, opts?)` | Project-scoped definition hits |
| `findReferences(root, symbol, opts?)` | Project-scoped reference hits |

Exact Rust/TS signatures land with #11; they must remain JSON-serializable and
free of Node Buffer ownership traps where avoidable.

## Loading & fallback

1. Lazy load on first use of a native-backed operation (or explicit
   `ensureNative()` for tests).
2. Resolution order:
   1. Local development `.node` next to the package (napi build output)
   2. Platform optionalDependency selected by os/cpu/libc
3. If load fails: set `nativeAvailable = false`, log once at debug, continue.
4. Config (future):

```toml
[native]
enabled = true          # false = never load addon
require = false         # true = fail hard if unavailable (CI / debug only)
```

Default: `enabled = true`, `require = false`.

## Support matrix (initial)

| Target | Triple | Required for 1.0 native |
|---|---|---|
| Linux x64 glibc | `x86_64-unknown-linux-gnu` | Yes |
| Linux x64 musl | `x86_64-unknown-linux-musl` | Yes (Alpine / some containers) |
| macOS arm64 | `aarch64-apple-darwin` | Yes |
| macOS x64 | `x86_64-apple-darwin` | Yes |
| Windows x64 | `x86_64-pc-windows-msvc` | Yes |
| Linux arm64 | `aarch64-unknown-linux-gnu` | Later (when CI executes it) |

Users must **not** need Rust, node-gyp, or a C compiler. Prebuilt optional
packages ship with every release that includes a native bump.

## Release engineering

1. CI matrix builds the addon per target (napi-rs / cargo).
2. Each target runs Bun smoke: import → `nativeVersion()` → `ping()`.
3. Assemble optional npm leaf packages; publish leaves, then root
   `@praana/natives`.
4. Main `praana` package depends on a compatible `@praana/natives` version.
5. Clean-install e2e: install published tarball / local packed artifact, run
   smoke without a Rust toolchain.

Until multi-target publish is wired, **local/dev** builds via
`bun run natives:build` are sufficient; CI must at least build+test Linux x64
glibc on PRs that touch `crates/` or `packages/praana-natives/`.

## Migration policy

1. **Skeleton** (#313) — version + ping + loader + Bun smoke.
2. **#11 Phase 1** — tree-sitter TS/JS + Python + Go; shared API for #299.
3. **Search/walk** — only if benchmarks beat `rg` / current FS paths with
   parity tests; keep `rg` fallback for one release cycle.
4. **Shell/process** — blocked on a separate threat-model design (cancellation,
   process groups, sandbox, streaming, secrets).
5. **Retire fallbacks** only after two stable releases with platform evidence.

Do **not** migrate `git_*` or `search_code` solely because they shell out;
mature external binaries are acceptable until measured.

## Testing

| Layer | Command / location |
|---|---|
| Rust unit | `cargo test` in `crates/praana-natives` |
| Loader / fallback | `tests/native-loader.test.ts` |
| Bun addon smoke | `packages/praana-natives` + CI job |
| Tool contract | Existing `tests/tools*.test.ts` patterns; native path must preserve `{ ok }` shapes |
| Full suite | `bun typecheck && bun test` |

## Explicit non-goals (this ship)

- Moving Adaptive Context, Cognitive Memory, or the compiler into Rust.
- Replacing the TypeScript tool registry.
- Full LSP server lifecycle (#11 Phases 2–4).
- Native shell / embedded bash (OMP `pi-shell`) without a dedicated ADR.
- Requiring native for classic-mode or headless `praana run` when the addon is
  missing (unless `native.require = true`).

## Relation to #195 harness contract

Native-backed tools still obey
`docs/superpowers/specs/2026-08-10-deterministic-tools-harness-design.md`:

- Register via factories in `createAllTools`.
- Zod at the TS boundary.
- Typed success/error unions.
- Graceful precondition failures.
- Artifact classification via `inferContentTypeFromTool` / `toolCommandFromArgs`.

## Open follow-ups

- Benchmark report template for search/AST migrations.
- Whether `@praana/natives` versions independently of `praana` (likely yes).
- CPU-feature variants (baseline vs AVX2) — defer; OMP has them, we do not need
  them for v1.
