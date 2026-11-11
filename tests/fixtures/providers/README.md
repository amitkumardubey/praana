# Provider fixtures

This directory holds two distinct kinds of evidence for the provider drivers.
A fixture must never be shared between the two meanings below.

## `legacy-ts/` — TypeScript observations

Files under `legacy-ts/` record what the current TypeScript drivers
(`src/llm/drivers/openai.ts`, `src/llm/drivers/responses.ts`) put on the wire
today. They are captured with a mocked `globalThis.fetch` — no network request
is ever made. The current Responses driver does not preserve encrypted reasoning
items or response continuation state, and these fixtures record that fact.

Rules for `legacy-ts/` fixtures:

- Method, absolute URL, lowercase header names, and parsed JSON body are
  compared semantically after parsing.
- Header maps are captured with every authorization, API-key, cookie, and
  configured secret-header value replaced by the exact string `[REDACTED]`.
- JSON files are pretty-printed with two ASCII spaces and end with exactly one
  trailing LF.
- `.stream.sse` files preserve the exact bytes fed to the driver (LF-terminated).
- `.events.jsonl` files contain one JSON object per LF-terminated line.
- Fixed model names, call IDs, ULIDs, timestamps, and content only; nothing is
  read from the environment, host clock, random source, or checkout path.
- Tests assert the manifest SHA-256 digests; they never rewrite goldens.

## `v1/` — fixed-format fixtures

Files under `v1/` pin the wire formats (request bodies, SSE streams, event
JSONL) the drivers consume and emit, and may intentionally differ from legacy
behavior. They serve as the regression oracle for those formats.
