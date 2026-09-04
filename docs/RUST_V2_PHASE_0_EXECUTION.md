# PRAANA Rust v2 Phase 0 Execution Packet

Status: Approved execution packet for Phase 0 only

Date: 2026-08-31

Authority: This packet narrows Phase 0 of `docs/RUST_V2_PLAN.md`. If the two documents conflict, the architecture decisions and phase boundaries in `RUST_V2_PLAN.md` win. `docs/RUST_V2_PROTOCOL_SPEC.md` owns canonical IDs and monotonic ULID use. Provider wire behavior is governed by `docs/RUST_V2_OPENAI_SPEC.md`. `docs/RUST_V2_TOOL_RUNTIME_SPEC.md` owns the future Rust tool-result and safety-pipeline contracts. `docs/RUST_V2_UI_CONTRACT.md` owns the permanent UI schema and its exact fixture inventory. Rust v2 application configuration is governed only by `docs/RUST_V2_CONFIG_SPEC.md`. Phase 0 captures evidence and authority-owned fixtures but implements none of those later runtime contracts.

Audience: An implementation agent that should favor small, reversible changes over broad redesign.

## 1. Goal

Establish a four-crate Rust workspace and deterministic test foundation without changing the running TypeScript product.

Phase 0 has seven deliverables:

1. Capture deterministic, redacted OpenAI/OpenRouter fixture evidence from the current TypeScript drivers without making a network request.
2. Capture deterministic, redacted safety-hook ordering and tool-result evidence from the current TypeScript turn path.
3. Check in the UI Contract schema-1 fixtures and exhaustive mapping owned by `RUST_V2_UI_CONTRACT.md`, without implementing any UI type.
4. Extract reusable native code into a pure Rust `praana-native-core` crate.
5. Keep `praana-natives` as a thin N-API wrapper with the same JavaScript exports and result shapes.
6. Add non-operational `praana-core` and `praana-cli` skeletons with deterministic clock and monotonic ULID foundations.
7. Run Rust workspace gates in CI.

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
- Protocol event envelopes, protocol-owned ID newtypes, tool-runtime DTOs, safety-pipeline types, or provider adapter types in Rust.
- TypeScript/OpenTUI IPC.
- `praana-core::ui_contract`, permanent UI DTOs, IPC DTOs, UI sinks, operation ledgers, or Ratatui action/effect types. Phase 0 adds fixture data only.
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

Run from `/home/amit/projects/personal/praana`:

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
- `src/llm/drivers/base.ts`
- `src/llm/sse.ts`
- `src/llm/tool-accumulator.ts`
- `src/llm/retry.ts`
- `src/llm/auth.ts`
- `src/llm/url.ts`
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

### 4.4 Current safety-hook and tool-result oracle

The safety fixture harness may import and exercise, but must not change, these production files:

- `src/turn.ts`, specifically the only production path that runs pre-hooks, executes or blocks a tool, runs post-hooks after execution, and preserves provider call order when publishing results.
- `src/session.ts`, which constructs the builtin registry used by a real session.
- `src/hooks/index.ts`, which fixes builtin registration order.
- `src/hooks/registry.ts`, which defines pre-hook short-circuiting and post-hook patch/error behavior.
- `src/hooks/types.ts` and `src/hooks/block-result.ts`, which define the current dispatch and pre-block result shapes.
- `src/hooks/handlers/plan-mode.ts`.
- `src/hooks/handlers/validate.ts`.
- `src/hooks/handlers/risk.ts`.
- `src/hooks/handlers/circuit.ts`.
- `src/hooks/handlers/write-path.ts`.
- `src/hooks/handlers/lsp.ts`.
- `src/hooks/handlers/verify.ts`.
- `src/hooks/handlers/redact.ts`.
- `src/plan-mode.ts`, `src/validate/fuzzy-path.ts`, `src/validate/shell-check.ts`, `src/risk/classify.ts`, `src/risk/classes.ts`, `src/circuit/loop-gate.ts`, and `src/redact/secrets.ts`.

The existing comparison tests are:

- `tests/hooks.test.ts`.
- `tests/validate-hook.test.ts`.
- `tests/risk-hook.test.ts`.
- `tests/circuit-hook.test.ts`.
- `tests/redact-hook.test.ts`.
- `tests/verify-hook.test.ts`.
- `tests/turn.test.ts`.

The source oracle is the behavior reached through `src/turn.ts` and the production registry, not comments or a test-only reimplementation of the desired Rust pipeline. The legacy TypeScript result objects are evidence only. They are not `ToolResultDto`, canonical protocol messages, or UI-contract DTOs, and Phase 0 must not define those later Rust types to make fixture tests compile.

### 4.5 Current CI

- `.github/workflows/ci.yml` runs Bun install, typecheck, and all Bun tests on Ubuntu.
- `.github/workflows/natives.yml` triggers the native reusable workflow for Rust/native paths.
- `.github/workflows/natives-build.yml` builds six native targets, runs `cargo test -p praana-natives` on Linux x64, runs native smoke tests on supported hosts, and runs a required native test slice.

## 5. Exact Target Layout After Phase 0

No other new Rust source files are permitted in Phase 0. In particular, do not create `protocol/`, `provider/`, `tools/`, `hooks/`, `history/`, `ui_contract/`, `ipc/`, or `tui/` source modules. The UI fixture directory below contains exactly the files listed in `RUST_V2_UI_CONTRACT.md` Section 13; that owner is intentionally not duplicated here.

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
      fixtures/
        ui_contract_v1/
          manifest.json
          mapping.json
          commands/
          results/
          events/
          rejections/
  praana-cli/
    Cargo.toml
    src/
      main.rs
tests/
  rust-v2-provider-fixtures.test.ts
  rust-v2-safety-fixtures.test.ts
  rust-v2-ui-contract-fixtures.test.ts
  fixtures/
    rust-v2/
      providers/
        README.md
        manifest.json
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
      safety/
        README.md
        manifest.json
        legacy-ts/
          pipeline/
            success.json
            plan-block.json
            validation-block.json
            risk-decline.json
            circuit-block.json
            write-conflict.json
            post-enrich-redact-release.json
          tool-results/
            pre-block-with-suggestions.json
            success-redacted.json
            enriched-error-redacted.json
            post-handler-throw.json
```

Git does not track empty directories. In Phase 0, `v1/README.md` is the only required file below `v1/`; create the request/stream/event directories when their first normative fixture is added. Do not add `.gitkeep` files.

The `legacy-ts` fixtures record current behavior. The `v1` fixtures implement `RUST_V2_OPENAI_SPEC.md` and may intentionally differ. A fixture must never be shared between those meanings.

The safety fixtures are also `legacy-ts` evidence. Their shape and strings do not predeclare the future Tool Runtime contract. The UI Contract fixtures are normative authority-owned data, but their presence does not permit Phase 0 Rust UI types or serializers.

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
getrandom = "0.4"
ulid = { version = "3", default-features = false }
```

`getrandom` supplies the production 80-bit entropy source. `ulid` is used only for `Ulid::from_parts`, parsing, and value access; do not enable its random-generating `std` feature and do not call `Ulid::generate` or `ulid::Generator`. Do not enable `praana-native-core/embeddings`. Do not add Tokio, Reqwest, Serde, SQLite, tracing, Schemars, SHA-256, regex, or plugin dependencies until the phase that uses them.

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
use std::time::Duration;

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub trait Sleeper: Send + Sync {
    fn sleep(&self, duration: Duration);
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

#[derive(Debug, Default, Clone, Copy)]
pub struct ThreadSleeper;
```

`SystemClock::now_ms()` returns signed Unix epoch milliseconds. A pre-epoch value is negative and never panics; conversion saturates only if the magnitude cannot fit `i64`. `ThreadSleeper::sleep()` calls `std::thread::sleep`. Do not expose `SystemTime` through either trait and do not make these traits async. The separate sleeper makes the ULID overflow path deterministic without teaching a fake clock to block.

### 8.2 Exact monotonic ULID API

`praana-core/src/id.rs` defines:

```rust
use std::sync::{Arc, Mutex};

use ulid::Ulid;

use crate::clock::{Clock, Sleeper, SystemClock, ThreadSleeper};

pub const ULID_MAX_TIMESTAMP_MS: u64 = (1_u64 << 48) - 1;
pub const ULID_MAX_RANDOM: u128 = (1_u128 << 80) - 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdGenerationError {
    ClockBeforeUnixEpoch { observed_ms: i64 },
    ClockBeyondUlidRange { observed_ms: i64 },
    EntropyUnavailable,
    EntropyOutOfRange { value: u128 },
    TimestampExhausted,
    StatePoisoned,
}

pub trait RandomSource: Send {
    fn next_random_80(&mut self) -> Result<u128, IdGenerationError>;
}

#[derive(Debug, Default)]
pub struct OsRandomSource;

pub trait ProtocolUlidId: Sized {
    fn from_validated_ulid(value: Ulid) -> Self;
}

pub trait IdGenerator: Send + Sync {
    fn next_id<T: ProtocolUlidId>(&self) -> Result<T, IdGenerationError>;
}

struct GeneratorState {
    last: Option<Ulid>,
    random: Box<dyn RandomSource>,
}

pub struct MonotonicUlidGenerator {
    clock: Arc<dyn Clock>,
    sleeper: Arc<dyn Sleeper>,
    state: Mutex<GeneratorState>,
}

impl MonotonicUlidGenerator {
    pub fn new(
        clock: Arc<dyn Clock>,
        sleeper: Arc<dyn Sleeper>,
        random: Box<dyn RandomSource>,
    ) -> Self {
        Self {
            clock,
            sleeper,
            state: Mutex::new(GeneratorState { last: None, random }),
        }
    }

    pub fn system() -> Self {
        Self::new(
            Arc::new(SystemClock),
            Arc::new(ThreadSleeper),
            Box::new(OsRandomSource),
        )
    }
}

impl Default for MonotonicUlidGenerator {
    fn default() -> Self {
        Self::system()
    }
}
```

`OsRandomSource::next_random_80()` fills exactly ten bytes with
`getrandom::fill`, interprets them as one big-endian 80-bit integer, and maps any
OS entropy failure to `EntropyUnavailable` without changing generator state.
Every `RandomSource` value is checked against `ULID_MAX_RANDOM`; an invalid test
or alternate source returns `EntropyOutOfRange`.

`MonotonicUlidGenerator::system()` injects `SystemClock`, `ThreadSleeper`, and
`OsRandomSource`. Implement `Display` and `std::error::Error` for
`IdGenerationError` without another dependency.
Neither the production implementation nor tests call `Ulid::generate`,
`ulid::Generator`, `SystemTime::now()` outside `SystemClock`, or any random-ID
helper. Construct values only with `Ulid::from_parts(timestamp_ms, random)`.

The `ProtocolUlidId` trait is the only Phase 0 adapter for later protocol-owned
newtypes. Do not define `SessionId`, `EventId`, `TurnId`, `OperationId`, or any
other Protocol/UI ID in Phase 0. In Phase 1 and later, each owner-defined local
ULID newtype implements `ProtocolUlidId` in its owner module and allocation uses
`next_id`. Raw `Ulid` is allowed only inside this foundation and its tests; it
must not appear in a protocol, tool, history, provider, or UI boundary. Runtime
consumers take a generic `&impl IdGenerator`, because the generic `next_id`
method intentionally makes the trait non-object-safe.

### 8.3 State transition and overflow contract

`next_id()` holds the `GeneratorState` mutex for the complete allocation,
including any overflow wait. This serializes all callers and guarantees one
strictly increasing sequence per generator instance. The later composition root
must construct one shared `Arc<MonotonicUlidGenerator>` and inject it into every
local-ID allocator; it must not construct a generator per event or subsystem.
Mutex poisoning returns
`StatePoisoned`; it is not silently recovered.

Under that lock, run this exact algorithm:

1. Read `clock.now_ms()` once. With no prior ID, reject a negative value with
   `ClockBeforeUnixEpoch` and a value above `ULID_MAX_TIMESTAMP_MS` with
   `ClockBeyondUlidRange`.
2. With no prior ID, draw one 80-bit random value, construct the ULID, store it
   as `last`, and return it.
3. With a prior ID and an observed timestamp strictly greater than
   `last.timestamp_ms()`, validate the timestamp, draw fresh 80-bit randomness,
   construct/store/return the new ULID.
4. With an equal or backward clock, keep `last.timestamp_ms()` and increment
   `last.random()` by one. Do not draw entropy. This preserves strict monotonicity
   without fabricating a newer wall-clock timestamp.
5. If the same/backward-clock increment would exceed `ULID_MAX_RANDOM`, do not
   wrap and do not commit the `ulid` crate's synthetic next-millisecond overflow.
   If the retained timestamp is already `ULID_MAX_TIMESTAMP_MS`, return
   `TimestampExhausted`.
6. Otherwise call `sleeper.sleep(Duration::from_millis(1))`, then read the clock
   again. Repeat while the observed value is less than or equal to the retained
   timestamp. The loop sleeps before every retry and therefore never busy-spins.
   Once a strictly later in-range millisecond is observed, draw fresh entropy,
   construct/store/return the new ULID. A value above the 48-bit range returns
   `ClockBeyondUlidRange` without changing `last`.
7. Any validation, entropy, or state error leaves the last successfully emitted
   ULID unchanged. A frozen or permanently backward injected clock can block at
   overflow by contract; cancellation belongs to later async runtime layers.

This ordering property is useful metadata, but Protocol replay continues to use
canonical `sequence`, never ULID or timestamp order.

### 8.4 Deterministic test implementations

Define test-only fakes inside `tests/deterministic_runtime.rs`, not production source:

- `TestId(Ulid)` implements `ProtocolUlidId` and exposes its inner value only to
  these foundation tests.
- `FixedClock { now_ms: i64 }` returns one fixed value.
- `ManualClock` stores its current millisecond in an atomic integer.
- `AdvancingSleeper` records every duration and advances `ManualClock` according
  to a fixed queue, so overflow tests never sleep in real time.
- `SequenceRandom` owns a `VecDeque<Result<u128, IdGenerationError>>` and fails
  if the generator consumes more entropy than the scenario permits.
- `PanickingRandom` panics once while the state lock is held, solely to prove
  the next caller receives `StatePoisoned`.

No deterministic test uses current time, OS entropy, random scheduling as an
assertion input, or real sleep. Do not add a `test-support` Cargo feature.

Required tests:

- `fixed_clock_returns_exact_epoch_ms`
- `first_id_uses_injected_clock_and_randomness`
- `same_millisecond_increments_random_component_without_entropy`
- `new_millisecond_draws_fresh_random_component`
- `backward_clock_keeps_last_timestamp_and_increments`
- `random_overflow_waits_for_a_strictly_later_millisecond`
- `random_overflow_never_busy_spins`
- `maximum_timestamp_overflow_returns_timestamp_exhausted`
- `initial_pre_epoch_clock_is_rejected`
- `initial_timestamp_above_48_bits_is_rejected`
- `entropy_failure_does_not_advance_state`
- `out_of_range_entropy_does_not_advance_state`
- `protocol_ulid_adapter_wraps_generated_value`
- `poisoned_state_returns_state_poisoned`
- `concurrent_generation_is_unique_and_strictly_ordered`
- `system_clock_is_callable_without_panicking`
- `system_generator_returns_valid_strictly_increasing_ulids`

The concurrency test shares one generator across at least 64 threads under a
fixed clock, sorts the returned values, and proves uniqueness plus contiguous
random increments. It does not claim thread scheduling order. The last two are
smoke tests only; they assert no wall-clock value and no fixed random value.

Tests are added before implementation. The red command is:

```bash
cargo test -p praana-core --test deterministic_runtime
```

Expected red result: compilation fails only because `Clock`, `Sleeper`,
`IdGenerationError`, `RandomSource`, `IdGenerator`, or
`MonotonicUlidGenerator` is not yet defined/exported. After implementing only
`clock.rs`, `id.rs`, and their `lib.rs` exports, run the same command. Expected
green result: all named deterministic and smoke tests pass with exit status 0.

## 9. Fixture Rules

### 9.1 Manifests, hashes, and sanitization

Provider and safety evidence each has a `manifest.json` with exactly this shape:

```json
{
  "fixture_schema_version": 1,
  "fixture_kind": "provider-phase-0",
  "oracle_sha256_by_file": {},
  "fixture_sha256_by_file": {}
}
```

The provider manifest uses fixture kind `provider-phase-0`; the safety
manifest uses `legacy-typescript-safety`. Each map key is an ASCII,
repository-relative path with `/` separators and each value is the lowercase
64-hex SHA-256 of the exact file bytes. `oracle_sha256_by_file` contains every
production source file named in Section 4.3 or 4.4 for that fixture family.
`fixture_sha256_by_file` contains `README.md` and every committed data fixture
below the same fixture root, excluding `manifest.json` to avoid a self-hash.
No map contains directories, the test harness, or another manifest. Keys are
lexicographically sorted. Tests enumerate disk files, reject missing/unlisted
files, and recompute every digest; they never trust or rewrite the manifest.

Apply these sanitization rules before comparison and before writing a fixture:

- Replace every authorization, API-key, cookie, and configured secret-header
  value with the exact string `[REDACTED]` in provider fixtures.
- Run the production `redactSecrets` behavior over legacy safety result values.
  Expected typed redaction markers such as `[REDACTED:aws-access-key]` are retained;
  the canary that produced one is never committed.
- Normalize only path-valued fields: replace the injected workspace root with
  `/workspace/praana`, replace an injected outside root with `/outside`, and use
  `/` separators. Do not normalize arbitrary prose or tool output.
- Use fixed model names, call IDs, ULIDs, timestamps, durations, retry counts,
  and content. Never read them from the environment, host clock, random source,
  temporary directory, username, or current checkout path.
- Pretty-print JSON with two ASCII spaces and one trailing LF. Preserve array
  order. Compare semantic request JSON after parsing, but compare header maps,
  trace arrays, result objects, JSONL lines, and SSE bytes according to their
  owning fixture rule.
- Reject a fixture containing a credential-like value, PEM delimiter,
  machine-specific absolute path, backslash path separator in a path field,
  CR outside an SSE case that requires it, non-finite number, or encrypted
  reasoning content.

The implementation step computes real hashes after the fixed fixture bytes are
captured. Do not insert fake digests, all-zero values, shortened hashes, or a
command that updates goldens during normal tests.

### 9.2 Legacy TypeScript provider capture

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

### 9.3 Normative provider v1 fixture directory

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

Phase 0 creates only `v1/README.md`. The normative request/stream/event files
and Rust provider tests listed in `RUST_V2_OPENAI_SPEC.md` belong to Phase 2.
Do not copy legacy outputs into `v1/` merely to populate its directories.

### 9.4 Legacy safety-hook and tool-result capture

`tests/rust-v2-safety-fixtures.test.ts` drives production handlers with injected
filesystem, risk, circuit, LSP, verification, logger, and tool-body fakes. It
makes no workspace mutation, subprocess call, prompt, or network request. It
captures the exact files listed under `safety/legacy-ts/` in Section 5 and no
others.

Every pipeline file contains exactly these top-level keys:

```json
{
  "scenario": "success",
  "tool_name": "edit_file",
  "args": {},
  "pre_trace": [],
  "execute": "ran",
  "post_trace": [],
  "dispatch": {
    "pre": {},
    "post": {}
  },
  "result": {}
}
```

`pre_trace` uses only `plan`, `validate`, `risk`, `circuit`, `write_path`, and
`lsp_snapshot`.
`post_trace` uses only `lsp`, `verify`, `enrich`, `redact`, `circuit_accounting`,
and `write_path_release`. The trace is test-harness observation metadata, not a
new production API. `execute` is exactly `ran` or `skipped`. `dispatch` is the
exact current pre/post dispatch result; `post` is `null` when the body never
runs. `result` is the exact current agent-facing legacy TypeScript result after
the path in `src/turn.ts` completes.

The seven pipeline fixtures prove these bounded facts:

- `success.json`: all enabled stages preserve production order; the tool body
  runs; optional LSP snapshot follows lock acquisition; circuit accounting sees
  the post-hook `isError`; release is last.
- `plan-block.json`: plan blocks first; validate, risk, circuit, lock, body, and
  all post stages are absent.
- `validation-block.json`: validate runs after plan and blocks before risk,
  circuit, lock, body, and post.
- `risk-decline.json`: risk runs after validation and blocks before circuit,
  lock, body, and post.
- `circuit-block.json`: circuit runs after risk and blocks before lock, body,
  and post.
- `write-conflict.json`: write-path is the final pre stage, returns the current
  non-error block flag, and acquires no second lease.
- `post-enrich-redact-release.json`: enrichment output is redacted, circuit
  accounting receives the final error flag, and the lease is available only
  after release runs last.

The four tool-result fixtures prove exact current shapes for a pre-block with
suggestions, a successful result containing a secret canary after redaction, an
enriched failed result after redaction, and a thrown post handler that is logged
while later post handlers continue. A pre-hook block is converted through
`toolResultFromPreBlock` and does not run the post pipeline in the current turn
path. The logger fake records only hook point, safe message, and safe error text;
it excludes `Error.cause`, stack, timestamp, and host path. Capture these facts
without treating them as the future Rust behavior.

The `pre-block-with-suggestions.json` scenario must pass through `runTurn` with a
fixed fake LLM tool call and fake tool body, proving the production orchestration
path publishes the block result and never invokes the body or post hooks. The
remaining scenarios may drive `createBuiltinHookRegistry` directly so each
observable ordering fact stays isolated and deterministic.

The test asserts all committed files and manifest hashes. It also runs its
scenario twice in one process and compares bytes to prove determinism. It never
updates fixtures. Expected companion tests are:

```bash
bun test tests/rust-v2-safety-fixtures.test.ts tests/hooks.test.ts tests/validate-hook.test.ts tests/risk-hook.test.ts tests/circuit-hook.test.ts tests/redact-hook.test.ts tests/verify-hook.test.ts
```

### 9.5 UI Contract fixture freeze without implementation

Create every file in the exact inventory at `RUST_V2_UI_CONTRACT.md` Section 13
under `crates/praana-core/tests/fixtures/ui_contract_v1/`. Its owner-defined
`manifest.json` shape, complete command/result/event/rejection lists,
`mapping.json` rows, per-file hashes, complete ULIDs, complete SHA-256 values,
redacted setup/auth values, and retry sequences are final. Do not add a second
manifest shape here.

`tests/rust-v2-ui-contract-fixtures.test.ts` is a static data validator. It:

- Enumerates the authority's exact inventory and rejects missing or extra files.
- Recomputes every `sha256_by_file` value except the manifest's self-hash.
- Checks schema version 1, all exact Section 11 mapping rows, ASCII dotted IPC
  names, complete uppercase ULIDs, complete lowercase SHA-256 values, and the
  required redacted auth/setup fixtures.
- Checks the four required retry/reconciliation JSONL sequences and the
  `memory_enabled.jsonl` fixture without importing or defining a semantic Rust
  type.
- Rejects credential-like values, prefixed semantic IDs, and a `Recall` role.

Its expected red command, before fixture data is added, is:

```bash
bun test tests/rust-v2-ui-contract-fixtures.test.ts
```

Expected red result: the exact missing inventory is reported. Expected green
result after fixture authoring: all static inventory, mapping, hash, ID, and
sanitization checks pass. Do not add `crates/praana-core/tests/ui_contract_v1.rs`
or any `praana-core::ui_contract` source in Phase 0; those are later
implementation steps owned by the UI Contract.

## 10. Exact File-by-File Execution Sequence

Follow this order. Do not combine later steps to save time.

### Step 1: Baseline and inventory

Read the files listed in Sections 4.1 through 4.5. Run the baseline commands in Section 3.3. Inspect `git status --short` and `git diff -- Cargo.toml Cargo.lock crates packages/praana-natives tests`.

Expected result: native tests and TypeScript checks pass; only the known rustfmt check may fail.

Checkpoint A: No files changed.

### Step 2: Add provider evidence test first

Add `tests/rust-v2-provider-fixtures.test.ts` first with the exact Section 5
inventory, mocked `globalThis.fetch`, manifest/hash checks, and a guard that
fails on any real fetch target. Run:

```bash
bun test tests/rust-v2-provider-fixtures.test.ts
```

Expected red result: the test reports the missing `providers/README.md`,
`providers/manifest.json`, every listed `legacy-ts` golden, and
`providers/v1/README.md`. It must not fail because of DNS or credentials.

Then add, in order:

1. `tests/fixtures/rust-v2/providers/README.md`.
2. All `legacy-ts` request, stream, and expected event files listed in Section 5.
3. `tests/fixtures/rust-v2/providers/v1/README.md`.
4. `tests/fixtures/rust-v2/providers/manifest.json` after all bytes are final.

Normalize lowercase headers in the harness, compare request JSON semantically,
and record the current Responses continuation/encrypted-reasoning omission only
under `legacy-ts`. Do not alter a production driver. Run:

```bash
bun test tests/rust-v2-provider-fixtures.test.ts tests/native-llm.test.ts tests/native-llm-wiring.test.ts
```

Expected green result: all fixture, no-network, manifest, and companion tests
pass.

Checkpoint B: Provider evidence passes, no production source changed, and the fixture secret scan passes.

### Step 3: Add safety-hook and tool-result evidence test first

Add `tests/rust-v2-safety-fixtures.test.ts` with the exact Section 5 inventory,
oracle hashes, production-handler harness, deterministic double-run, and
sanitization checks. Run:

```bash
bun test tests/rust-v2-safety-fixtures.test.ts
```

Expected red result: the test reports the missing safety README, manifest,
seven pipeline fixtures, and four tool-result fixtures.

Add `tests/fixtures/rust-v2/safety/README.md`, then the eleven exact legacy data
files, then `manifest.json` after their bytes and oracle hashes are final. The
README states that these are non-normative TypeScript observations and points to
`RUST_V2_TOOL_RUNTIME_SPEC.md` for future behavior. Run the command in Section
9.4.

Expected green result: all fixture, order, short-circuit, redaction, release,
manifest, and existing companion tests pass without a source edit.

Checkpoint C: Safety/tool-result evidence is deterministic, redacted, and source-hash-bound.

### Step 4: Freeze UI Contract fixture data first

Add `tests/rust-v2-ui-contract-fixtures.test.ts` first and run its red command
from Section 9.5. Then author exactly the UI Contract Section 13 inventory under
`crates/praana-core/tests/fixtures/ui_contract_v1/`, writing `manifest.json`
last. Run the same command again.

Expected green result: inventory, mapping, hashes, complete IDs/digests,
rejections, retry/reconciliation sequences, and secret scans pass. There is no
Rust UI-contract test or source module.

Checkpoint D: UI Contract schema-1 fixture data is frozen with no UI implementation.

### Step 5: Add workspace and crate skeletons

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

Expected initial failure: `Cargo.lock` must change because the workspace and Clap/ULID/getrandom dependencies are new. This is expected during implementation. No JavaScript lockfile may change.

Checkpoint E: All four crates resolve; the current N-API crate still owns all implementation modules.

### Step 6: Add deterministic tests before implementation completion

Add `crates/praana-core/tests/deterministic_runtime.rs` with every test from
Section 8.4 before completing `SystemClock`, `ThreadSleeper`, entropy, or
`MonotonicUlidGenerator`.

Run:

```bash
cargo test -p praana-core --test deterministic_runtime
```

Expected initial failures:

- Missing trait methods or public exports.
- Missing `SystemClock` implementation.
- Missing monotonic generator, injected entropy/sleeper, error, or state behavior.

Implement only enough in `clock.rs`, `id.rs`, and `lib.rs` to pass. Do not add event envelopes or runtime dependency containers.

Checkpoint F: Clock-injected monotonic IDs and deterministic tests pass.

### Step 7: Lock the current N-API contract

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

Checkpoint G: The new contract test passes against the old mixed implementation before any wrapper delegation.

### Step 8: Add pure core fixtures and tests first

Add `crates/praana-native-core/tests/native_contract.rs` referencing the public functions specified in Section 7.3 and the fixture files from Step 7.

Run:

```bash
cargo test -p praana-native-core --test native_contract
```

Expected initial failure: the public functions and implementation modules do not exist. A compile failure is the intended red step.

Checkpoint H-red: Confirm the failure is only missing Phase 0 API, not a manifest or toolchain failure.

### Step 9: Move language and parsing logic

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

Checkpoint I: Core language/parse tests and untouched wrapper tests pass.

### Step 10: Move symbol and project query logic

Add, in order:

1. `crates/praana-native-core/src/symbols.rs`
2. `crates/praana-native-core/src/project.rs`

Add `list_symbols`, `list_imports`, `find_definition`, and `find_references` to core `lib.rs`. Preserve current default limits, skip rules, exported-symbol heuristics, one-based positions, and parse-error skipping during project scans.

Run:

```bash
cargo test -p praana-native-core
cargo test -p praana-natives
```

Checkpoint J: Both independent implementations pass equivalent tests.

### Step 11: Move search logic

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

Checkpoint K: Search behavior passes in both implementations.

### Step 12: Move embedding logic behind a feature

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

Checkpoint L: Optional embedding logic passes and the future core remains lightweight.

### Step 13: Convert `praana-natives` to delegation

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

Checkpoint M: Every N-API export delegates to core; old implementation files still exist but are no longer imported.

### Step 14: Delete duplicate wrapper implementation modules

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

Checkpoint N: There is one implementation of each native capability, and the wrapper contains only N-API code.

### Step 15: Format once and inspect

Run:

```bash
cargo fmt --all
cargo fmt --all -- --check
git diff --check
```

Inspect every formatting change. Formatting inside deleted/moved Rust implementation is expected. No TypeScript, JSON fixture content, package file, or existing documentation should be reformatted.

Checkpoint O: rustfmt and whitespace checks pass.

### Step 16: Build and smoke the actual N-API addon

Run:

```bash
bun run natives:build:debug
bun run natives:smoke
PRAANA_REQUIRE_NATIVE=1 bun test tests/native-loader.test.ts tests/code-intel-tools.test.ts tests/search-code.test.ts
bun typecheck
```

Inspect generated `packages/praana-natives/index.js` and `index.d.ts` only if napi-rs regenerates them. Their public exports and result field names must be unchanged. Do not accept a generated API diff merely because compilation succeeded.

Checkpoint P: The real `.node` addon loads and behaves as before.

### Step 17: CI changes

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

Checkpoint Q: Workflow syntax is valid and local equivalents pass.

### Step 18: Final gates

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

Checkpoint R: Phase 0 exit review.

## 11. Tests First and Expected Failure Table

| Test addition | Expected first failure | Allowed minimal implementation |
|---|---|---|
| Legacy provider fixture test | Exact provider inventory is missing | Test-only harness plus fixed legacy data/manifest |
| Legacy safety fixture test | Exact safety inventory is missing | Test-only production-handler harness plus fixed legacy data/manifest |
| UI Contract static fixture test | Exact owner-defined inventory is missing | Fixture data and static validator only; no Rust UI type |
| Deterministic runtime test | Missing clock/sleeper/entropy/monotonic ID APIs | `clock.rs`, `id.rs`, exports only |
| N-API contract test | Missing committed fixtures | Add fixed fixture files |
| Native core contract test | Missing core functions/modules | Move current pure implementation |
| Default-feature dependency assertion | ONNX leaks into default graph | Mark three embedding dependencies optional |
| N-API smoke after delegation | DTO/error conversion mismatch | Fix wrapper conversion only |
| Workspace clippy | Wrapper/core warning | Small local warning fix without behavior change |

Never make a red test pass by weakening the assertion, deleting a scenario, adding sleeps, using current time/random IDs, or changing a fixture to match an accidental implementation unless the fixture was demonstrably wrong under its stated legacy/spec authority.

## 12. Rollback-Safe Checkpoints

No checkpoint requires a commit. Each passing checkpoint is a suggested small
commit boundary only if the user separately authorizes commits during execution.
Without that authorization, inspect and retain the changes uncommitted. If
authorized, inspect `git status` and the checkpoint diff first, stage only that
slice, and use a conventional commit; do not combine several passing checkpoints
into one large migration commit merely to reduce commit count.

- A changes nothing.
- B through D change fixture/test data only.
- E through F add isolated crates and foundations without changing N-API behavior.
- G locks the current N-API boundary.
- H through L copy and adapt implementation while the old wrapper still runs independently.
- M switches one wrapper group at a time with a contract test after each group.
- N deletes old modules only after all delegation passes.
- O is formatting only after ownership is settled.
- P proves the consumer-facing native boundary.
- Q changes CI only after local commands are known to pass.
- R is the no-new-code exit review.

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
- Defining protocol, tool-runtime, safety-hook, UI-contract, IPC, or Ratatui DTOs in Phase 0 merely to deserialize fixtures.
- Calling `Ulid::generate`, `ulid::Generator`, or an ambient random-ID helper.
- Committing an overflow by inventing `last_timestamp_ms + 1` before the injected clock observes it.
- Releasing the monotonic generator mutex during overflow wait and permitting duplicate or reordered allocation state.
- Using a real API key or real network call to capture provider fixtures.
- Treating legacy safety result objects as the future Rust `ToolResultDto` contract.
- Using fake, shortened, stale, or self-referential manifest hashes.
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
- The ID foundation uses injected clock/sleeper/entropy, same-millisecond random increment, backward-clock retention, observed-time overflow waiting, one mutex-protected state sequence, and fallible exact APIs; no ambient ULID generation remains.
- No Rust protocol/event types, tool runtime, safety hooks, provider networking, history, memory, UI contract, IPC, or TUI behavior exists.
- Default `praana-core` dependency graph excludes tokenizers, ONNX, and ndarray.
- Legacy TypeScript provider fixtures are deterministic, redacted, and network-free.
- Legacy TypeScript safety-hook/tool-result fixtures are deterministic, redacted, source-hash-bound, and explicitly non-normative.
- Every UI Contract Section 13 fixture and mapping row is present with verified hashes, but no UI implementation type exists.
- Normative v1 fixture authority is documented separately from legacy fixtures.
- Rust format, clippy, and workspace tests pass.
- Bun typecheck and full tests pass.
- A freshly built real N-API addon passes smoke and required native integration tests.
- CI runs Rust workspace gates and preserves the existing native target matrix.
- No unrelated file was modified.

If any item is false, Phase 1 must not start.
