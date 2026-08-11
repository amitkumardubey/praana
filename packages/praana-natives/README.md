# `@praana/natives`

Rust/napi-rs capability layer for PRAANA. Loaded lazily from Bun via Node-API.

See [`docs/superpowers/specs/2026-08-11-rust-native-runtime-design.md`](../../docs/superpowers/specs/2026-08-11-rust-native-runtime-design.md).

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
