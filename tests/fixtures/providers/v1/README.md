# Provider v1 fixtures

Fixtures in this directory pin the wire formats (request bodies, SSE streams,
event JSONL) the TypeScript drivers consume and emit. They may intentionally
differ from the legacy observations under `../legacy-ts/`.

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

Do not make the v1 fixtures pass through the legacy TypeScript driver when the
v1 behavior is intentionally new, and do not copy legacy outputs into this
directory merely to populate its subdirectories.
