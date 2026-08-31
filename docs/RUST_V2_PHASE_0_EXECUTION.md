# PRAANA Rust v2 Phase 0 Execution Packet

Status: Approved execution packet for Phase 0 only

Date: 2026-08-31

Authority: This packet narrows Phase 0 of `docs/RUST_V2_PLAN.md`. If the two documents conflict, the architecture decisions and non-goals in `RUST_V2_PLAN.md` win. Provider wire behavior is governed by `docs/RUST_V2_OPENAI_SPEC.md`. Rust v2 application configuration is governed only by `docs/RUST_V2_CONFIG_SPEC.md`, but Phase 0 does not implement or load it.

Audience: An implementation agent that should favor small, reversible changes over broad redesign.

## 1. Goal

Establish a four-crate Rust workspace and deterministic test foundation without changing the running TypeScript product.

Phase 0 has five deliverables:

1. Capture deterministic, redacted OpenAI/OpenRouter fixture evidence from the current TypeScript drivers without making a network request.
2. Extract reusable native code into a pure Rust `praana-native-core` crate.
3. Keep `praana-natives` as a thin N-API wrapper with the same JavaScript exports and result shapes.
4. Add non-operational `praana-core` and `praana-cli` skeletons.
5. Add deterministic clock and ID injection points and run Rust workspace gates in CI.

Success means the repository has a safe foundation for Phase 1. It does not mean that a Rust agent, provider client, event store, or replacement CLI exists.

## 2. Non-Goals

Do not implement any of the following in Phase 0:

- Provider networking in Rust.
- HTTP, SSE, retry, auth, or provider adapters in Rust.
- A new conversation history, event log, projection, compaction, or resume path.
- Conversion or migration of current sessions, events, config, SQLite databases, or Cognitive Memory.
- A memory plugin or any cross-session memory behavior.
- New embedding behavior, model downloads, or default ONNX use.
- A headless Rust turn loop.
- Tool execution, safety hooks, shell supervision, LSP, or verification in Rust.
- TypeScript/OpenTUI IPC.
- Ratatui or Crossterm.
- Release packaging changes.
- Renaming or removing any current N-API export.
- Fixing native search, parser, symbol, import, or embedding behavior while moving it.
- Broad dependency upgrades.
- Formatting unrelated TypeScript or documentation.

Do not use Phase 0 as an excuse to create all future `praana-core` modules. Empty provider, history, memory, tool, or UI modules create false progress and are forbidden here.

## 3. Prerequisites and Stop Conditions

### 3.1 Required tools

- Git.
- Bun 1.4 or newer.
- A stable Rust toolchain with `cargo`, `rustfmt`, and `clippy`.
- Node.js 22 for the existing napi-rs build path when reproducing CI.
- The existing package dependencies installed with the frozen lockfile.

Run from `/home/amit/projects/praana`:

```bash
bun --version
rustc --version
cargo --version
cargo clippy --version
rustfmt --version
bun install --frozen-lockfile
```

Do not install or upgrade packages unless a missing prerequisite is confirmed. Do not update package manifests unrelated to the Rust workspace.

### 3.2 Worktree rules

- Inspect `git status --short` before every checkpoint.
- Preserve unrelated user or agent changes.
- Do not reset, clean, checkout, or restore the worktree.
- Do not commit unless the user separately requests a commit.
- Use `apply_patch` for manual edits.
- Stop and ask if another change directly conflicts with a target file.

### 3.3 Baseline commands

Run these before editing and retain the terminal results:

```bash
cargo test -p praana-natives
bun typecheck
bun test tests/native-loader.test.ts tests/code-intel-tools.test.ts tests/search-code.test.ts
```

If a native addon can be built on the host, also run:

```bash
bun run natives:build:debug
bun run natives:smoke
PRAANA_REQUIRE_NATIVE=1 bun test tests/native-loader.test.ts tests/code-intel-tools.test.ts
```

Known baseline condition: as of 2026-08-31, `cargo fmt --all -- --check` reports formatting diffs in the existing Rust crate. Do not stop for that known failure and do not create a preliminary formatting-only change. Run `cargo fmt --all` once after the extraction has removed the old mixed modules, inspect that diff, and require the check to pass at the final gate.

Stop before implementation if any other baseline command fails. Record whether the failure reproduces before edits; do not hide it with unrelated fixes.

## 4. Current File Map

### 4.1 Workspace and package entry points

- Root `Cargo.toml` uses resolver 2 and contains only `crates/praana-natives`.
- Root `Cargo.toml` has release LTO and symbol stripping.
- `package.json` exposes the TypeScript/Bun CLI through `bin/praana.js`.
- `package.json` runs native tests with `cargo test -p praana-natives` plus `tests/native-loader.test.ts`.
- `packages/praana-natives/package.json` builds `crates/praana-natives/Cargo.toml` with napi-rs and emits the `.node` file in `packages/praana-natives/`.
- `packages/praana-natives/smoke.ts` checks version, ping, TypeScript/Rust parsing, symbols, and grep.

### 4.2 Current mixed Rust crate

`crates/praana-natives/Cargo.toml` currently contains all of these dependency groups:

- N-API: `napi`, `napi-derive`, `napi-build`.
- Code intelligence: `tree-sitter` and five language grammars.
- Search: `ignore`, `regex`, `globset`.
- Embeddings: `tokenizers`, `tract-onnx`, `ndarray`.
- Tests: `tempfile`.

Current source ownership is:

| File | Current responsibility | Phase 0 owner |
|---|---|---|
| `crates/praana-natives/src/lib.rs` | N-API exports plus direct native calls | N-API wrapper only |
| `crates/praana-natives/src/types.rs` | N-API DTOs and result envelopes | N-API wrapper only |
| `crates/praana-natives/src/lang.rs` | Language detection and grammar lookup | `praana-native-core` |
| `crates/praana-natives/src/parse.rs` | File read, parse, diagnostics, ranges | `praana-native-core` |
| `crates/praana-natives/src/symbols.rs` | Symbol/import/reference queries | `praana-native-core` |
| `crates/praana-natives/src/project.rs` | Project tree walk and definition/reference search | `praana-native-core` |
| `crates/praana-natives/src/search.rs` | Grep and file search | `praana-native-core` |
| `crates/praana-natives/src/embed.rs` | Tokenization and ONNX embedding | optional `praana-native-core` feature |
| `crates/praana-natives/build.rs` | napi-rs build setup | N-API wrapper only |

There is no independent project-root detector in the current Rust crate. `project.rs` means project-wide symbol queries. Do not invent a new root detector in Phase 0.

### 4.3 Current provider oracle

The fixture capture step may read and exercise, but must not change, these production files:

- `src/llm/drivers/openai.ts`
- `src/llm/drivers/responses.ts`
- `src/llm/sse.ts`
- `src/llm/tool-accumulator.ts`
- `src/llm/retry.ts`
- `src/llm/auth.ts`
- `src/llm/wire-config.ts`
- `src/llm/resolver.ts`
- `src/llm/stream.ts`
- `src/llm/types.ts`
- `src/provider-registry.ts`

Relevant oracle tests are:

- `tests/native-llm.test.ts`
- `tests/native-llm-wiring.test.ts`
- `tests/provider-compat.test.ts`
- `tests/provider-registry.test.ts`
- `tests/llm-oauth.test.ts`
- `tests/llm-fallback.test.ts`
- `tests/native-loader.test.ts`
- `tests/code-intel-tools.test.ts`
- `tests/search-code.test.ts`

The current TypeScript Responses driver does not preserve encrypted reasoning items or response continuation state. Capture that fact as legacy evidence; do not make it the v2 contract.

### 4.4 Current CI

- `.github/workflows/ci.yml` runs Bun install, typecheck, and all Bun tests on Ubuntu.
- `.github/workflows/natives.yml` triggers the native reusable workflow for Rust/native paths.
- `.github/workflows/natives-build.yml` builds six native targets, runs `cargo test -p praana-natives` on Linux x64, runs native smoke tests on supported hosts, and runs a required native test slice.

## 5. Exact Target Layout After Phase 0

No other new Rust source files are permitted in Phase 0.

```text
Cargo.toml
Cargo.lock
crates/
  praana-native-core/
    Cargo.toml
    src/
      lib.rs
      error.rs
      types.rs
      lang.rs
      parse.rs
      symbols.rs
      project.rs
      search.rs
      embed.rs
    tests/
      native_contract.rs
      fixtures/
        code-intel/
          clean.ts
          syntax-error.ts
          symbols.py
          symbols.go
          symbols.rs
        search/
          src/
            alpha.ts
            probe.txt
          node_modules/
            ignored.ts
  praana-natives/
    Cargo.toml
    build.rs
    src/
      lib.rs
      convert.rs
      types.rs
    tests/
      napi_contract.rs
  praana-core/
    Cargo.toml
    src/
      lib.rs
      clock.rs
      id.rs
    tests/
      deterministic_runtime.rs
  praana-cli/
    Cargo.toml
    src/
      main.rs
tests/
  rust-v2-provider-fixtures.test.ts
  fixtures/
    rust-v2/
      providers/
        README.md
        legacy-ts/
          openai-chat/
            basic.request.json
            multimodal-tools.request.json
            parallel-tools.stream.sse
            parallel-tools.events.jsonl
          openai-responses/
            basic.request.json
            tool-call.stream.sse
            tool-call.events.jsonl
          openrouter-chat/
            basic.request.json
            basic.headers.json
            reasoning.stream.sse
            reasoning.events.jsonl
        v1/
          README.md
          common-sse/
            multiline-crlf.sse
            utf8.sse
            invalid-json.sse
          openai-chat/
            requests/
            streams/
            events/
          openai-responses/
            requests/
            streams/
            events/
          openrouter-chat/
            requests/
            streams/
            events/
```

Git does not track empty directories. In Phase 0, `v1/README.md` is the only required file below `v1/`; create the request/stream/event directories when their first normative fixture is added. Do not add `.gitkeep` files.

The `legacy-ts` fixtures record current behavior. The `v1` fixtures implement `RUST_V2_OPENAI_SPEC.md` and may intentionally differ. A fixture must never be shared between those meanings.

## 6. Cargo Manifests and Dependency Decisions

### 6.1 Root `Cargo.toml`

Set the workspace members exactly to:

```toml
[workspace]
resolver = "2"
members = [
  "crates/praana-native-core",
  "crates/praana-natives",
  "crates/praana-core",
  "crates/praana-cli",
]

[profile.release]
lto = true
strip = "symbols"
```

Do not add workspace-wide dependency aliases in Phase 0. Only `praana-native-core` and `praana-natives` share dependencies, and their boundary is clearer with an explicit path dependency. Do not set an MSRV without a separate CI decision.

### 6.2 `praana-native-core/Cargo.toml`

Use package version `0.1.0`, edition `2021`, license `MIT`, and `publish = false`.

Use these dependencies at the versions already present in `praana-natives`:

```toml
[features]
default = []
embeddings = ["dep:tokenizers", "dep:tract-onnx", "dep:ndarray"]

[dependencies]
tree-sitter = "0.25"
tree-sitter-typescript = "0.23"
tree-sitter-javascript = "0.25"
tree-sitter-python = "0.25"
tree-sitter-go = "0.25"
tree-sitter-rust = "0.24"
ignore = "0.4"
regex = "1"
globset = "0.4"
tokenizers = { version = "0.21", default-features = false, features = ["onig"], optional = true }
tract-onnx = { version = "0.21", optional = true }
ndarray = { version = "0.16", optional = true }

[dev-dependencies]
tempfile = "3"
```

Rationale:

- Tree-sitter and search are the purpose of this crate and remain unconditional.
- ONNX dependencies are optional so future Rust binaries do not pull them by default.
- The temporary N-API crate enables `embeddings`, preserving the current JavaScript API.
- `tempfile` moves with the pure tests.
- Do not add `serde`; Phase 0 core DTOs are Rust values, not a wire format.
- Do not add `thiserror`; the small native error type can implement `Display` and `Error` manually.
- Do not add async or runtime crates; all extracted functions are synchronous today.

### 6.3 `praana-natives/Cargo.toml`

Keep its package metadata, crate types, N-API versions, and `napi-build`. Its runtime dependencies become exactly:

```toml
[dependencies]
napi = { version = "3", default-features = false, features = ["napi8"] }
napi-derive = "3"
praana-native-core = { path = "../praana-native-core", features = ["embeddings"] }

[build-dependencies]
napi-build = "2"
```

It needs no dev dependency after pure tests move. Do not change `NATIVE_API_VERSION` from `0.3.0`; extraction is not an API change.

### 6.4 `praana-core/Cargo.toml`

Use package version `0.1.0`, edition `2021`, license `MIT`, and `publish = false`.

Dependencies:

```toml
[dependencies]
praana-native-core = { path = "../praana-native-core" }
ulid = "1"
```

Do not enable `praana-native-core/embeddings`. Do not add Tokio, Reqwest, Serde, SQLite, tracing, Schemars, SHA-256, regex, or plugin dependencies until the phase that uses them.

### 6.5 `praana-cli/Cargo.toml`

Use package version `0.1.0`, edition `2021`, license `MIT`, and `publish = false`.

```toml
[dependencies]
clap = { version = "4", features = ["derive"] }
praana-core = { path = "../praana-core" }

[[bin]]
name = "praana"
path = "src/main.rs"
```

Clap is justified now only to lock the eventual executable name and standard `--help`/`--version` behavior. Add no subcommands in Phase 0. The existing `bin/praana.js` remains the production CLI, so this Cargo binary is not packaged or linked.

## 7. Pure Native Core Contract

### 7.1 Error boundary

`praana-native-core/src/error.rs` defines:

```rust
pub enum NativeErrorCode {
    InvalidArgument,
    UnsupportedLanguage,
    IoError,
    ParseError,
    Unavailable,
    Internal,
}

pub struct NativeError {
    pub code: NativeErrorCode,
    pub message: String,
}

pub type NativeResult<T> = Result<T, NativeError>;
```

`NativeErrorCode::as_str()` returns the existing exact strings:

- `invalid_argument`
- `unsupported_language`
- `io_error`
- `parse_error`
- `unavailable`
- `internal`

Implement `Display` and `std::error::Error` without another crate. Core code returns errors. Only the N-API wrapper creates `{ ok, error, code }` envelopes.

### 7.2 Core DTOs

`praana-native-core/src/types.rs` owns N-API-free equivalents of all payload values:

- `ParseDiagnostic`
- `SymbolHit`
- `ImportHit`
- `ProjectQueryOptions`
- `ParseFileOutput`
- `ListSymbolsOutput`
- `ListImportsOutput`
- `ProjectHitsOutput`
- `GrepOptions`
- `GrepMatch`
- `GrepOutput`
- `FindFilesOptions`
- `FindFilesMatch`
- `FindFilesOutput`
- `EmbedOutput`, behind `cfg(feature = "embeddings")`

Use Rust-native types:

- Paths accepted by functions are `&Path`.
- Paths in result DTOs remain `PathBuf`; conversion to lossy JavaScript strings belongs in `praana-natives`.
- File size is `u64`.
- Modified time remains milliseconds as `f64` at the N-API boundary; the core DTO may retain `f64` to avoid changing behavior.
- Embeddings are `Vec<f32>` in the core and converted to `Vec<f64>` by N-API, matching the current calculation.

Do not derive N-API or Serde traits in this crate.

### 7.3 Public functions

`praana-native-core/src/lib.rs` re-exports DTOs and exposes these exact entry points:

```rust
pub fn parse_file(path: &Path, language: Option<&str>) -> NativeResult<ParseFileOutput>;
pub fn list_symbols(path: &Path, language: Option<&str>) -> NativeResult<ListSymbolsOutput>;
pub fn list_imports(path: &Path, language: Option<&str>) -> NativeResult<ListImportsOutput>;
pub fn find_definition(
    root: &Path,
    symbol: &str,
    options: ProjectQueryOptions,
) -> NativeResult<ProjectHitsOutput>;
pub fn find_references(
    root: &Path,
    symbol: &str,
    options: ProjectQueryOptions,
) -> NativeResult<ProjectHitsOutput>;
pub fn grep(options: GrepOptions) -> NativeResult<GrepOutput>;
pub fn find_files(options: FindFilesOptions) -> NativeResult<FindFilesOutput>;
#[cfg(feature = "embeddings")]
pub fn embed_text(text: &str, model_dir: &Path) -> NativeResult<EmbedOutput>;
```

Options implement `Default`. Default constants and all current semantics stay in the same logical modules. An invalid grep regex continues to fall back to a literal and fills `regex_fallback`; it is not converted into an error during Phase 0.

### 7.4 N-API wrapper

`praana-natives/src/types.rs` keeps the existing N-API object names and field names. `convert.rs` contains only conversions between N-API DTOs and core DTOs plus success/error envelope construction.

`praana-natives/src/lib.rs` keeps these exact exports:

- `native_version`
- `ping`
- `parse_file`
- `list_symbols`
- `list_imports`
- `find_definition`
- `find_references`
- `grep`
- `find_files`
- `embed_text`

Rust snake_case continues to generate the existing JavaScript camelCase names. Do not hand-rename generated exports. Each wrapper must do only four things:

1. Convert JavaScript strings/options into core values.
2. Call one `praana_native_core` function.
3. Convert its output or error to the existing N-API result shape.
4. Return.

No file walking, parsing, regex, tree-sitter, tokenization, or ONNX code remains in the wrapper.

## 8. Deterministic Clock and ID Interfaces

### 8.1 Clock

`praana-core/src/clock.rs` defines:

```rust
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;
```

`SystemClock::now_ms()` returns signed Unix epoch milliseconds. Handle a pre-epoch system time without panicking. Do not expose `SystemTime` through the trait and do not make the trait async.

### 8.2 ID generator

`praana-core/src/id.rs` defines:

```rust
use ulid::Ulid;

pub trait ProtocolUlidId: Sized {
    fn from_validated_ulid(value: Ulid) -> Self;
}

pub trait IdGenerator: Send + Sync {
    fn next_id<T: ProtocolUlidId>(&self) -> T;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemIdGenerator;
```

`SystemIdGenerator` uses `Ulid::new()` internally and immediately constructs the
requested protocol-owned newtype. The protocol module implements
`ProtocolUlidId` for each local ULID newtype; external implementations are not
exported by `praana-core`. Runtime code introduced in
later phases receives `&dyn Clock` and a generic `&impl IdGenerator`; core
boundaries never return raw `Ulid` or `String`. Runtime code must not call
`SystemTime::now()`, `Date.now()`, `Ulid::new()`, or random ID helpers directly.

### 8.3 Test implementations

Define test-only fakes inside `tests/deterministic_runtime.rs`, not production source:

- `FixedClock { now_ms: i64 }` returns one fixed value.
- `SequenceIdGenerator` owns a `Mutex<VecDeque<Ulid>>` internally and returns
  each supplied value wrapped in the requested protocol ID newtype.

The tests use literal ULID strings. No snapshot or fixture test may generate an ID or timestamp at runtime. Do not add a `test-support` Cargo feature in Phase 0.

Required tests:

- `fixed_clock_returns_exact_epoch_ms`
- `sequence_id_generator_returns_ids_in_order`
- `system_clock_is_callable_without_panicking`
- `system_id_generator_returns_valid_distinct_ulids`

The last two are smoke tests only and must not assert wall-clock values or sort order.

## 9. Fixture Rules

### 9.1 Legacy TypeScript fixture capture

`tests/rust-v2-provider-fixtures.test.ts` uses mocked `globalThis.fetch` and current TypeScript drivers. It must never contact a real provider.

For each request fixture, capture:

- Method.
- Absolute URL.
- Lowercase header names.
- Header values with all credentials replaced by `[REDACTED]`.
- Parsed JSON body, pretty-printed with two spaces and one trailing newline.

For each stream fixture, feed fixed SSE bytes to the current parser/driver and write the expected normalized event sequence as JSON Lines. Fixture tests read and compare committed files; tests never rewrite golden files.

Required legacy scenarios:

- OpenAI Chat basic text request.
- OpenAI Chat system plus multimodal user message plus two tools.
- OpenAI Chat fragmented parallel tool calls plus usage.
- OpenAI Responses basic request.
- OpenAI Responses fragmented function call.
- OpenRouter URL and attribution headers.
- OpenRouter reasoning text and cache usage fields currently recognized by the driver.

Use fixed model names, tool IDs, timestamps, and content. Do not use `Date.now()`, `Math.random()`, environment credentials, host temp paths, or platform path separators in fixture content.

### 9.2 Normative v1 fixture directory

`tests/fixtures/rust-v2/providers/v1/README.md` states that:

- Fixtures implement `docs/RUST_V2_OPENAI_SPEC.md`.
- Header names are lowercase.
- Authorization values are `[REDACTED]`.
- JSON uses UTF-8, two-space indentation, and one trailing newline.
- JSON object key order is canonical only for readable diffs; semantic comparison parses JSON.
- SSE files preserve exact LF or CRLF bytes required by the case.
- Expected event files use one JSON object per LF-terminated line.
- No fixture contains a real credential, response ID, user path, username, or machine-specific value.

Do not make the normative fixtures pass through the legacy TypeScript driver when the normative behavior is intentionally new.

## 10. Exact File-by-File Execution Sequence

Follow this order. Do not combine later steps to save time.

### Step 1: Baseline and inventory

Read the files listed in Sections 4.1 through 4.4. Run the baseline commands in Section 3.3. Inspect `git status --short` and `git diff -- Cargo.toml Cargo.lock crates packages/praana-natives tests`.

Expected result: native tests and TypeScript checks pass; only the known rustfmt check may fail.

Checkpoint A: No files changed.

### Step 2: Add fixture evidence first

Add, in order:

1. `tests/fixtures/rust-v2/providers/README.md`
2. All `legacy-ts` request, stream, and expected event files listed in Section 5.
3. `tests/fixtures/rust-v2/providers/v1/README.md`
4. `tests/rust-v2-provider-fixtures.test.ts`

Run:

```bash
bun test tests/rust-v2-provider-fixtures.test.ts tests/native-llm.test.ts tests/native-llm-wiring.test.ts
```

Expected initial failures:

- Header case may differ because `Headers` normalizes names.
- JSON body property order may differ if raw strings are compared.
- Current Responses fixtures will have no continuation or encrypted reasoning events.

Minimal correction:

- Normalize header names in the test harness.
- Parse JSON before semantic comparison.
- Record the current Responses omission in `legacy-ts`; do not alter production drivers.

Checkpoint B: Fixture tests pass, no production source changed, and a secret scan of fixture paths returns no credential-like values.

### Step 3: Add workspace and crate skeletons

Edit root `Cargo.toml`, then add these manifests:

1. `crates/praana-native-core/Cargo.toml`
2. `crates/praana-core/Cargo.toml`
3. `crates/praana-cli/Cargo.toml`

Add minimal source files in this order:

1. `crates/praana-native-core/src/error.rs`
2. `crates/praana-native-core/src/types.rs`
3. `crates/praana-native-core/src/lib.rs`
4. `crates/praana-core/src/clock.rs`
5. `crates/praana-core/src/id.rs`
6. `crates/praana-core/src/lib.rs`
7. `crates/praana-cli/src/main.rs`

At this point `praana-native-core/lib.rs` exports only the error and types modules. `praana-core/lib.rs` exports only `clock` and `id`. `praana-cli/main.rs` derives a zero-subcommand Clap parser and provides help/version; with no arguments it prints `Rust v2 core is not operational in Phase 0.` and exits successfully. It must not initialize sessions, read PRAANA config, access credentials, open databases, or call a provider.

Run:

```bash
cargo check --workspace
cargo run -p praana-cli -- --help
cargo run -p praana-cli -- --version
```

Expected initial failure: `Cargo.lock` must change because the workspace and Clap/ULID dependencies are new. This is expected during implementation. No JavaScript lockfile may change.

Checkpoint C: All four crates resolve; the current N-API crate still owns all implementation modules.

### Step 4: Add deterministic tests before implementation completion

Add `crates/praana-core/tests/deterministic_runtime.rs` with the four tests from Section 8.3 before completing `SystemClock` and `SystemIdGenerator`.

Run:

```bash
cargo test -p praana-core --test deterministic_runtime
```

Expected initial failures:

- Missing trait methods or public exports.
- Missing `SystemClock` implementation.
- Missing `SystemIdGenerator` implementation.

Implement only enough in `clock.rs`, `id.rs`, and `lib.rs` to pass. Do not add event envelopes or runtime dependency containers.

Checkpoint D: Deterministic interfaces and tests pass.

### Step 5: Lock the current N-API contract

First add the committed fixture files under `crates/praana-native-core/tests/fixtures/`. Then add `crates/praana-natives/tests/napi_contract.rs` before changing the wrapper. Test the Rust-callable public exports and exact error codes for:

- Version and ping.
- Clean parse and syntax diagnostics.
- Symbols and imports.
- Definition and reference search.
- Grep context, invalid-regex literal fallback, and ignored `node_modules`.
- Fuzzy and glob file search.
- Missing embedding model returns `unavailable`.

Use those committed fixture files by repository-relative paths. Do not create an independent N-API fixture copy.

Do not assert directory-walk order unless current behavior already guarantees it. Match records by stable identifying fields.

Checkpoint E: The new contract test passes against the old mixed implementation before any wrapper delegation.

### Step 6: Add pure core fixtures and tests first

Add `crates/praana-native-core/tests/native_contract.rs` referencing the public functions specified in Section 7.3 and the fixture files from Step 5.

Run:

```bash
cargo test -p praana-native-core --test native_contract
```

Expected initial failure: the public functions and implementation modules do not exist. A compile failure is the intended red step.

Checkpoint F-red: Confirm the failure is only missing Phase 0 API, not a manifest or toolchain failure.

### Step 7: Move language and parsing logic

Add, in order:

1. `crates/praana-native-core/src/lang.rs`
2. `crates/praana-native-core/src/parse.rs`

Adapt imports from wrapper DTOs to core DTOs and `NativeError`. Add `parse_file` in core `lib.rs`. Move the existing unit tests with their implementation; do not leave duplicate unit tests in `praana-natives`.

Run:

```bash
cargo test -p praana-native-core
cargo test -p praana-natives
```

The N-API implementation is still independent at this checkpoint. This intentional duplication makes rollback safe.

Checkpoint G: Core language/parse tests and untouched wrapper tests pass.

### Step 8: Move symbol and project query logic

Add, in order:

1. `crates/praana-native-core/src/symbols.rs`
2. `crates/praana-native-core/src/project.rs`

Add `list_symbols`, `list_imports`, `find_definition`, and `find_references` to core `lib.rs`. Preserve current default limits, skip rules, exported-symbol heuristics, one-based positions, and parse-error skipping during project scans.

Run:

```bash
cargo test -p praana-native-core
cargo test -p praana-natives
```

Checkpoint H: Both independent implementations pass equivalent tests.

### Step 9: Move search logic

Add `crates/praana-native-core/src/search.rs` and expose `grep` and `find_files` from core `lib.rs`.

Preserve:

- Current skip directories.
- Gitignore behavior.
- Binary detection.
- Default limits and truncation flags.
- One-based line/column output.
- Invalid-regex literal fallback.
- Current fuzzy scoring.
- Millisecond modified times.

Do not optimize the blocking walk or add cancellation. Those are later design decisions.

Run the two crate suites again.

Checkpoint I: Search behavior passes in both implementations.

### Step 10: Move embedding logic behind a feature

Add `crates/praana-native-core/src/embed.rs` with `#![cfg(feature = "embeddings")]` or equivalent module gating. Expose `embed_text` only with that feature.

Run both configurations:

```bash
cargo test -p praana-native-core
cargo test -p praana-native-core --features embeddings
cargo tree -p praana-core
```

Expected assertions:

- The default native core builds without compiling or linking tokenizers/ONNX dependencies.
- The embedding feature preserves the missing-model `unavailable` behavior.
- `cargo tree -p praana-core` does not contain `tract-onnx`, `tokenizers`, or `ndarray`.

Checkpoint J: Optional embedding logic passes and the future core remains lightweight.

### Step 11: Convert `praana-natives` to delegation

Edit `crates/praana-natives/Cargo.toml`, then add `src/convert.rs`. Edit `src/types.rs` only to retain N-API DTOs and conversions needed by `convert.rs`. Edit `src/lib.rs` one export group at a time:

1. Parse.
2. Symbols/imports.
3. Definition/references.
4. Grep/find files.
5. Embedding.

After each group, run:

```bash
cargo test -p praana-natives --test napi_contract
```

Do not delete an old implementation module until its wrapper delegates to core and the contract test passes.

Checkpoint K: Every N-API export delegates to core; old implementation files still exist but are no longer imported.

### Step 12: Delete duplicate wrapper implementation modules

Delete only these files from `crates/praana-natives/src/`:

- `lang.rs`
- `parse.rs`
- `symbols.rs`
- `project.rs`
- `search.rs`
- `embed.rs`

Then run:

```bash
cargo test -p praana-native-core --all-features
cargo test -p praana-natives
cargo check -p praana-core
cargo check -p praana-cli
```

Checkpoint L: There is one implementation of each native capability, and the wrapper contains only N-API code.

### Step 13: Format once and inspect

Run:

```bash
cargo fmt --all
cargo fmt --all -- --check
git diff --check
```

Inspect every formatting change. Formatting inside deleted/moved Rust implementation is expected. No TypeScript, JSON fixture content, package file, or existing documentation should be reformatted.

Checkpoint M: rustfmt and whitespace checks pass.

### Step 14: Build and smoke the actual N-API addon

Run:

```bash
bun run natives:build:debug
bun run natives:smoke
PRAANA_REQUIRE_NATIVE=1 bun test tests/native-loader.test.ts tests/code-intel-tools.test.ts tests/search-code.test.ts
bun typecheck
```

Inspect generated `packages/praana-natives/index.js` and `index.d.ts` only if napi-rs regenerates them. Their public exports and result field names must be unchanged. Do not accept a generated API diff merely because compilation succeeded.

Checkpoint N: The real `.node` addon loads and behaves as before.

### Step 15: CI changes

Edit `.github/workflows/ci.yml` to add a separate `rust` job on `ubuntu-latest`:

1. Checkout.
2. Install stable Rust with `rustfmt` and `clippy`.
3. Run `cargo fmt --all -- --check`.
4. Run `cargo clippy --workspace --all-targets --all-features -- -D warnings`.
5. Run `cargo test --workspace --all-features`.

In `.github/workflows/natives-build.yml`, change the Linux full-test Cargo command from only `praana-natives` to:

```bash
cargo test -p praana-native-core --all-features -p praana-natives
```

Leave the six-target native build, smoke, upload, Bun setup, Node setup, and required native test slice unchanged. Do not add cross-target Rust test execution where binaries cannot run.

Checkpoint O: Workflow syntax is valid and local equivalents pass.

### Step 16: Final gates

Run exactly:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
bun typecheck
bun test
bun run natives:build:debug
bun run natives:smoke
PRAANA_REQUIRE_NATIVE=1 bun test tests/native-loader.test.ts tests/code-intel-tools.test.ts tests/search-code.test.ts
git diff --check
```

Also run:

```bash
cargo tree -p praana-core
cargo tree -p praana-native-core
cargo tree -p praana-native-core --features embeddings
```

Confirm the default `praana-core` tree excludes ONNX/tokenizer dependencies and the feature-enabled tree includes them.

Checkpoint P: Phase 0 exit review.

## 11. Tests First and Expected Failure Table

| Test addition | Expected first failure | Allowed minimal implementation |
|---|---|---|
| Legacy provider fixture test | Golden normalization mismatch | Test-only header/JSON normalization |
| Deterministic runtime test | Missing Clock/ID APIs | `clock.rs`, `id.rs`, exports only |
| N-API contract test | Missing committed fixtures | Add fixed fixture files |
| Native core contract test | Missing core functions/modules | Move current pure implementation |
| Default-feature dependency assertion | ONNX leaks into default graph | Mark three embedding dependencies optional |
| N-API smoke after delegation | DTO/error conversion mismatch | Fix wrapper conversion only |
| Workspace clippy | Wrapper/core warning | Small local warning fix without behavior change |

Never make a red test pass by weakening the assertion, deleting a scenario, adding sleeps, using current time/random IDs, or changing a fixture to match an accidental implementation unless the fixture was demonstrably wrong under its stated legacy/spec authority.

## 12. Rollback-Safe Checkpoints

No checkpoint requires a commit.

- A through B change tests/fixtures only.
- C through D add isolated crates without changing N-API behavior.
- E locks the current N-API boundary.
- F through J copy and adapt implementation while the old wrapper still runs independently.
- K switches one wrapper group at a time with a contract test after each group.
- L deletes old modules only after all delegation passes.
- M is formatting only after ownership is settled.
- N proves the consumer-facing native boundary.
- O changes CI only after local commands are known to pass.

If a checkpoint fails, stop at the immediately preceding passing state and fix only the current slice. Do not revert unrelated worktree changes. Do not proceed with a half-delegated export group.

## 13. Common Mistakes

- Moving N-API structs into `praana-native-core`. The core must not depend on `napi` or `napi-derive`.
- Removing embeddings from `praana-natives`. The wrapper must enable the optional core feature until TypeScript retires.
- Enabling embeddings in `praana-core` by default.
- Bumping `NATIVE_API_VERSION` for an internal extraction.
- Changing JavaScript camelCase fields generated from Rust snake_case fields.
- Returning Rust errors across N-API instead of preserving the existing result envelopes.
- Changing path string conversion, one-based line/column indexing, default limits, or truncation flags.
- Sorting output that was not previously sorted and thereby creating an accidental behavior change.
- Fixing the current invalid-regex fallback during extraction.
- Adding async abstractions to synchronous native code.
- Adding `anyhow`, `thiserror`, `serde`, Tokio, Reqwest, or SQLite before they are used.
- Creating empty future modules to resemble the final architecture.
- Using a real API key or real network call to capture provider fixtures.
- Treating legacy TypeScript Responses omissions as normative v2 behavior.
- Letting custom fixture normalization hide material request differences.
- Using generated timestamps, random tool IDs, temp paths, or environment-dependent headers in goldens.
- Running rustfmt as an unrelated preliminary mass change instead of once after extraction.
- Changing `packages/praana-natives/package.json`, `package.json`, Bun lockfiles, release scripts, or production CLI wiring.
- Assuming `cargo test` proves the `.node` addon still exports the same JavaScript API.
- Committing without explicit user instruction.

## 14. Exit Criteria

Phase 0 is complete only when all statements are true:

- Root Cargo workspace contains exactly the four target crates.
- `praana-native-core` has no N-API dependency or annotation.
- Tree-sitter, project query, search, and optional embedding behavior have one implementation in `praana-native-core`.
- `praana-natives` contains only N-API exports, N-API DTOs/conversions, version checks, and build setup.
- The JavaScript native export set, `NATIVE_API_VERSION`, field names, error codes, and smoke behavior are unchanged.
- The current TypeScript CLI remains the production CLI.
- `praana-core` contains only native-core access plus deterministic Clock/ID foundations.
- `praana-cli` provides only help/version and is not packaged or linked into the Bun CLI.
- No Rust provider networking, history, memory, IPC, or TUI behavior exists.
- Default `praana-core` dependency graph excludes tokenizers, ONNX, and ndarray.
- Legacy TypeScript provider fixtures are deterministic, redacted, and network-free.
- Normative v1 fixture authority is documented separately from legacy fixtures.
- Rust format, clippy, and workspace tests pass.
- Bun typecheck and full tests pass.
- A freshly built real N-API addon passes smoke and required native integration tests.
- CI runs Rust workspace gates and preserves the existing native target matrix.
- No unrelated file was modified.

If any item is false, Phase 1 must not start.
