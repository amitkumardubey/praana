# Normative provider v1 fixtures (Phase 2)

Fixtures in this directory implement `docs/RUST_V2_OPENAI_SPEC.md`. They are
the normative wire-format authority for the Rust v2 provider runtime and may
intentionally differ from the legacy TypeScript observations under `../legacy-ts/`.

Rules for all `v1/` fixtures:

- Header names are lowercase.
- Authorization values are `[REDACTED]`.
- JSON uses UTF-8, two-space indentation, and exactly one trailing newline.
- JSON object key order is canonical only for readable diffs; semantic
  comparison parses JSON.
- SSE files preserve exact LF or CRLF bytes required by the case.
- Expected event files use one JSON object per LF-terminated line.
- No fixture contains a real credential, response ID, user path, username, or
  machine-specific value.

Do not make the normative fixtures pass through the legacy TypeScript driver
when the normative behavior is intentionally new, and do not copy legacy
outputs into this directory merely to populate its subdirectories.
