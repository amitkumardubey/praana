# Developer web search/fetch evaluation

Tool-level, deterministic evaluation for Bun: no LLM, no search-engine HTML
scraping, no browser, no stealth or protection bypass. This directory holds the
task sets and their verifier, the runners for the candidate backends, scoring
and reports, and a polite, budgeted CLI. The terms review and the real backend
runs are **not done yet**, so there is no backend ranking: do not use this to
rank backends until the dated results exist.

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
- `npmjs.com` package pages are intermittently challenged by Cloudflare (real
  content on some requests, `Just a moment...` on others); no stable probe could
  be kept, so they are not in the set either.
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

## Usage

From the repository root:

```sh
# Fully offline: inspect the plan using tiny hand-written fixtures.
bun scripts/web-eval/run.ts --dry-run --tasks tests/fixtures/web-eval --out /tmp/web-eval-plan

# Inspect a single adapter without making requests.
bun scripts/web-eval/run.ts --only firecrawl --dry-run --tasks tests/fixtures/web-eval --out /tmp/web-eval-plan

# After the separate terms/task review, a real run would use:
# bun scripts/web-eval/run.ts --only <runner> --max-requests 100 --tasks <task-dir> --out <output-dir>

bun scripts/web-eval/run.ts --help
```

Options:

- `--only <runner>`: one exact ID from the list below. Unknown IDs fail before I/O
  to any backend. Without it all configured runners are planned, in enumeration
  order (not ranking order).
- `--dry-run`: load/validate tasks, list planned task counts and skip reasons,
  write reports, **zero backend requests**. It does not test credentials or
  availability. Constructors never contact endpoints.
- `--max-requests N`: global HTTP budget, default **100**, non-negative safe
  integer; `0` makes no requests. Includes initialization, notifications, retries
  and redirects, not just scored tasks. Exhausted/unattempted tasks are skipped.
- `--tasks <dir>`: directory containing `search.json` and `fetch.json`, default
  `scripts/web-eval/tasks/`. Both arrays must satisfy `tasks.ts`; an empty array
  is allowed. Category/count verification belongs to the task-set workstream.
- `--out <dir>`: output directory, default `scripts/web-eval/results/`. Writes a
  timestamped, collision-resistant `.json` (raw normalized observations, scores,
  plan, HTTP attempt metadata and task digest) and `.md` report. Dry-run files
  are labelled as such. Reports contain untrusted web data; do not follow any
  instructions found in retrieved content.

Search requests ask for five results. Fetch output is capped at 20,000 characters.
Compare runs only with identical task SHA-256 digests and adapter versions.

## Runners

| ID | Operations | Required environment | Notes |
| --- | --- | --- | --- |
| `local-fetch` | fetch | none | Plain HTTP + simple HTML text extraction; no JavaScript execution. |
| `jina` | fetch | none | Jina Reader `https://r.jina.ai/<url>`; no search adapter. |
| `exa-mcp` | search | none | Hosted keyless MCP, `web_search_exa`. |
| `parallel-mcp` | search | none | **Skipped: endpoint not verified** — output format blocker below. |
| `tavily-keyless` | search | none | Explicit documented keyless header; live operation untested, terms review pending. |
| `firecrawl-mcp` | search, fetch | none | Officially documented keyless hosted Search/Scrape tools. |
| `tavily` | search | `TAVILY_API_KEY` | Basic search, no generated answer or raw page content. |
| `brave` | search | `BRAVE_API_KEY` | Brave Web Search API with extra snippets. |
| `exa` | search | `EXA_API_KEY` | Exa API with highlights, not full page text. |
| `firecrawl` | search, fetch | `FIRECRAWL_API_KEY` | Requires `fc-` prefix; separate Search/Scrape calls. |

Keys are read **only from environment variables**. No key in CLI flags, files,
reports, URLs or logs. A keyed runner without a key returns `skipped: no key`;
there is no automatic fallback to anonymous access. Provider error bodies are
classified then discarded, and env-key echoes in report strings are redacted.
Do not put credentials into task URLs/queries. The CLI suppresses raw unexpected
exceptions rather than printing potentially credential-bearing diagnostics.

Firecrawl search deliberately omits `scrapeOptions`, avoiding per-result scrape
billing. Fetch calls are separate. `credits` captures provider-reported usage per
call, including `creditsUsed` when present; unknown credits stay absent, **not
zero**. Scrape/MCP output may not report credits. No account-wide usage queries
or feedback/refund calls are made.

## Politeness and safety

- Global sequential task execution: concurrency is **one per backend or less**,
  including response-body consumption. Keyed/keyless adapters of one vendor
  share a pacing queue.
- At least **1 second between HTTP request starts globally** (stronger than
  per-backend pacing), including MCP setup, notification, redirects and retries. User-Agent: `praana-web-eval/0.1`.
- Keyed HTTP 429/5xx: at most two retries, exponential waits of 2s then 4s;
  `Retry-After` can lengthen these waits. Timeout/transport failures and other
  4xx responses are not retried. HTTP attempt metadata preserves rate limits
  even if a retry later succeeds.
- **Keyless endpoints are rate limited per IP.** No keyless retries. A keyless
  429/5xx stops subsequent keyless traffic to that backend for the entire run.
  In-band MCP rate/server errors also stop it, even when HTTP status is 200.
  It never rotates identities, sessions, proxies, addresses or credentials.
- The global budget is enforced at each actual HTTP dispatch. No traffic when
  skipped or dry-running. MCP has no hidden reconnect/session-recovery retries.
- A request has a 30-second timeout. Redirects are manual and bounded at five;
  each is paced/budgeted. Credentialed cross-origin redirects, HTTPS downgrades
  and POST redirects are refused. No cookies or browser state are stored.
- Bot-wall hints are reported as blocked, not successful fetches. Detection is
  heuristic; the independent task probe remains the content oracle. This is a
  dev harness for reviewed public URLs, **not** the product SSRF-safe fetch tool.

## Metrics and interpretation

Pure functions live in `scoring.ts`; `report.ts` produces JSON and Markdown.
Skipped observations are excluded from denominators, and zero-sample cells are
unknown (`null` / `—`), not a zero-quality score.

**Search:** expected-domain recall@5 (exact host or subdomain, not substring),
answer-in-snippet precision (fraction of returned top-five snippets containing
any expected answer substring), answer coverage per query, any-result coverage,
weak/empty honesty, median/p90 latency, returned tokens/query and tokens/recall
hit, failure and rate-limit rates. Titles do not count as snippet evidence.
Weak means missing a domain hit or an answer snippet. Weak/empty honesty credits
explicit failure/weak flags or an empty result list on such queries; it is a
transparent oracle-based diagnostic, not provider confidence calibration.

**Fetch:** per-tier retrieval rates, tier-weighted score (T3×3, T2×2, T1×1),
TP/FP/TN/FN, false-positive rates, median/p90 latency, total returned tokens per
successful retrieval (including waste on failures), and failure/rate-limit rates.
T1/T2 retrieval requires the case-insensitive content probe and no detected wall.
For T3 the probe is a challenge marker: marker content or a detected wall is not
retrieval; non-empty content without either counts as retrieval. Retrieval is
scored independently of `ok`: an `ok` claim without retrieval is a false positive.
Missing T1/T2 probes can reflect changed pages, truncation or extraction failure,
not necessarily a wall. The separate bot-wall/protected false-positive rate uses
detected walls and non-retrieved T3 tasks. T3 non-marker content is only a
heuristic for success, since the real page content was not verified.

Every rate includes n and a two-sided 95% Wilson interval. Snippets in one query
are correlated, so their intervals are descriptive. Weighted score bounds are
weighted per-tier Wilson bounds, **not** a binomial interval treating weight as
additional independent samples. Latency includes adapter work, pacing, MCP setup
and retries; p90 is nearest rank, median averages the middle pair. Tokens are
returned characters/4, not model usage or provider billing. JSON also retains
HTTP attempts (no headers, bodies, keys or request URLs) so retries cannot hide
rate-limit pressure.

No final ranking from one run. Later measurements need the complete verified
task sets, terms review, repeated days/IPs, explicit keyless-limit observations,
and honest reporting of sample size and unknown credit usage.

## Offline tests

```sh
bun test tests/web-eval-runners.test.ts tests/web-eval-search.test.ts tests/web-eval-scoring.test.ts tests/web-eval-cli.test.ts
bun node_modules/typescript/bin/tsc -p scripts/web-eval/tsconfig.json
bun typecheck && bun test tests/
```

The root typecheck covers `src/` only; the additional config checks harness code
and new harness tests. All new tests inject transport and fake time: no network,
keys, real sleeps or live availability assumptions. Small response recordings
under `tests/fixtures/web-eval/` are hand-written representations of documented
wire formats, **not live captures**. Task fixtures there are synthetic too.
Do not replace them with production task sets or vendor credentials.

The separate verifier remains available as
`bun scripts/web-eval/verify.ts search <search-task-file>` (or `fetch`). It makes
real requests; it is not part of the offline test procedure and was not changed
by this implementation.

## Adapter verification sources

Official pages read with `curl` on **2026-11-05**, documentation only, not backend
evaluation requests:

- Exa: https://docs.exa.ai/reference/exa-mcp verifies the hosted keyless endpoint
  `https://mcp.exa.ai/mcp` and `web_search_exa`.
  Arguments and labelled output:
  https://github.com/exa-labs/exa-mcp-server/blob/master/src/tools/webSearch.ts .
  API endpoint/highlights: https://docs.exa.ai/reference/search .
- Parallel: https://docs.parallel.ai/integrations/mcp/quickstart and
  https://docs.parallel.ai/integrations/mcp/programmatic-use verify
  `https://mcp.parallel.ai/mcp` and `web_search(objective, search_queries)`.
  **BLOCKED:** these pages do not specify the hosted MCP result encoding; the
  REST Search sample does not prove MCP preserves that wrapper. Per the brief,
  `parallel-mcp` reports `skipped: endpoint not verified` (format not verified)
  without traffic. Needs an official MCP output example/schema to unblock.
- Tavily: https://docs.tavily.com/documentation/api-reference/endpoint/search and
  https://docs.tavily.com/documentation/keyless verify the keyed API and explicit
  `X-Tavily-Access-Mode: keyless` header with the same response schema. Live
  keyless behavior and the Search API Agreement conflict are deferred, not
  resolved by an offline fixture test.
- Brave: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started .
- Firecrawl: https://docs.firecrawl.dev/api-reference/endpoint/search and
  https://docs.firecrawl.dev/api-reference/endpoint/scrape . Hosted keyless access
  is **officially documented**, not merely a third-party claim:
  https://docs.firecrawl.dev/mcp-server/keyless and
  https://docs.firecrawl.dev/mcp-server/tools . Endpoint:
  `https://mcp.firecrawl.dev/v2/mcp`. Arguments:
  https://github.com/firecrawl/firecrawl-mcp-server#readme ; output envelopes
  checked against its `src/server.ts` and `src/tool-output.ts` (interfaces only,
  no vendor code vendored). Search preserves the API envelope; MCP scrape
  unwraps `data`. No live request was made to test either access mode.
- MCP HTTP transport:
  https://modelcontextprotocol.io/specification/2025-03-26/basic/transports .
- WRB style reference (read, not vendored):
  https://github.com/dondai44423/wrb .

## Terms check

Placeholder for the later terms-review task. No permissions verdict, terms
table, agreement-conflict resolution or real-backend results are supplied here.
Documentation of a keyless format is **not** a completed terms check. Complete
that work before scheduling live runs.
