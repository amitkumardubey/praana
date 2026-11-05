# Web evaluation

This directory holds the developer-oriented task sets used to compare web search
and fetch backends, plus the schema, validator and verifier for them. The
runners, scoring, terms check and dated results are **not** here yet, so this is
still not an evaluation harness and must not be used to rank backends.

## Task sets

`tasks/search.json` — 60 developer queries, each with the authoritative page that
answers it:

| niche | count | what it is |
| --- | --- | --- |
| `docs` | 30 | library/framework documentation lookups (JS/TS, Python, Rust, Go, Java, DevOps tooling) |
| `error` | 15 | real, common error strings with an official explanation page |
| `release` | 10 | release notes / changelog lookups |
| `version-change` | 5 | "what changed in version X of Y" |

Each row has `expected_domains` (any of them must appear in the top 5 results),
1–3 `answer_snippets` that appear verbatim on `authoritative_url`, a `niche` and
the `verified_at` date. Snippets are matched case-insensitively against the
visible page text, so they are chosen from the live page rather than from memory.

`tasks/fetch.json` — 30 URLs with a `probe` string that appears in the page text:

| tier | count | meaning |
| --- | --- | --- |
| 1 | 16 | static HTML, readable by a plain HTTP client |
| 2 | 8 | JavaScript-heavy or mildly protected pages that still return their content to a plain client |
| 3 | 6 | bot-wall pages, used **only** to measure honesty |

Tier 3 rows are different from the others on purpose. For them `probe` is the
challenge marker that a plain HTTP client actually received (for example
`Just a moment...` or `Please enable JS and disable any ad blocker`), and
`observed_status` records the HTTP status that client saw (all six are 403 on the
day they were checked). The real content of those pages was never retrieved, so
scoring must treat returned content that still contains the marker as a blocked
response / false positive, not as a success. A runner that legitimately returns
real content without the marker can be scored as a true success.

Observed limits, recorded honestly:

- `crates.io` package pages return a JavaScript shell only; no probe can be
  verified from a plain client, so they are not in the set.
- `npmjs.com` package pages are intermittently challenged by Cloudflare. The zod
  page is kept as a tier 2 row because it returned its content when verified;
  the same flakiness is why it is not a tier 1 row.
- Stack Overflow serves a Cloudflare challenge to this client, so the question
  page is a tier 3 honesty probe rather than a normal fetch target.

## Validating and verifying

```sh
bun scripts/web-eval/verify.ts search scripts/web-eval/tasks/search.json
bun scripts/web-eval/verify.ts fetch scripts/web-eval/tasks/fetch.json
```

The verifier fetches every `authoritative_url` / `url` with the
`praana-web-eval/0.1` User-Agent, waits at least one second between requests
(including redirects), and retries 429/5xx responses at most twice with
exponential delays. It does not evade bot protection. It reports a failure when
a page is inaccessible or when an expected string is absent, and it exits
nonzero if anything fails.

Tier 3 rows pass when their marker is present, which confirms the wall is still
being served; a status that differs from `observed_status` is reported as a
warning rather than a failure because challenge pages can switch between 403 and
a 200 interstitial.

`verified_at` is not updated automatically: re-run the verifier, review the
output, and update the dates explicitly. Expectations age, so treat an old date
as a hint that a row needs re-checking.

`tasks/schema.json` describes the JSON shape (including the tier 3 conditional
field); `tasks.ts` is the more restrictive executable validator (real calendar
dates, HTTP(S)-only URLs, closed objects). `tests/web-eval-tasks.test.ts` checks
both, the required counts, the niche split, tier split, uniqueness and the fact
that every committed row validates — offline, without touching the network.
