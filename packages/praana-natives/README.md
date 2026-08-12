# `@praana/natives`

Rust/napi-rs capability layer for PRAANA. Loaded lazily from Bun via Node-API.

- Runtime contract: [`docs/superpowers/specs/2026-08-11-rust-native-runtime-design.md`](../../docs/superpowers/specs/2026-08-11-rust-native-runtime-design.md)
- Tree-sitter code intel (#11 Phase 1): [`docs/superpowers/specs/2026-08-12-tree-sitter-code-intel-design.md`](../../docs/superpowers/specs/2026-08-12-tree-sitter-code-intel-design.md)

API `0.2.0` exports: `nativeVersion`, `ping`, `parseFile`, `listSymbols`,
`listImports`, `findDefinition`, `findReferences` (TS/JS/Python/Go/Rust grammars
compiled in).

## Develop

```bash
# from repo root
bun install
bun run natives:build:debug
bun run natives:smoke
cargo test -p praana-natives
```

Requires a Rust toolchain locally. End users receive prebuilt `.node` binaries
and do not need Rust.
