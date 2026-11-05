# Web evaluation (incomplete)

This directory currently contains only the beginning of the task-validation work.
It is **not an evaluation harness** and must not be used to rank backends. The
search set has six verified examples, not the required 60; the fetch set and all
runners, scoring, terms checks and results are still missing.

Validate a candidate set and check its expected strings against its authoritative
pages with:

```sh
bun scripts/web-eval/verify.ts search scripts/web-eval/tasks/search.json
# Likewise, pass `fetch` and a fetch-task JSON file.
```

The verifier checks page text, reports failures, and exits nonzero if any
expectation is absent or inaccessible. It does not update `verified_at`: review
successful output and update dates explicitly. It waits at least one second
between requests, including redirects, and retries 429/5xx responses at most
twice with exponential delays. It does not evade bot protection. Inaccessible
pages, including tier-3 bot walls, cannot be verified from that vantage point;
a missing probe is not evidence that a page lacks it.

`tasks/schema.json` describes the basic JSON shape; `tasks.ts` is the
more restrictive executable validator (including actual calendar dates and
HTTP(S)-only URLs). Neither currently checks the required full-set counts or
category distribution. The schema is generated from the Zod definitions.
