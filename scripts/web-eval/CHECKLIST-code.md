# Runner implementation checklist

Scope: runners, scoring/reporting and offline-safe CLI. Task sets and `verify.ts`
are owned separately. No live backend evaluations, terms verdicts or rankings.

- [x] B1 Base contract, taxonomy, local fetch and Jina Reader; offline fixtures.
  Verified: 5 adapter tests; harness TypeScript check; full gate 3331 pass / 0 fail.
- [ ] B2 **BLOCKED (Parallel output format only)**. All other requested API/
  Exa MCP/Firecrawl MCP adapters and offline fixtures are implemented.
  Verified: full gate 3350 pass / 0 fail; 24 adapter tests, harness typecheck.
  **BLOCKED (Parallel only):** official quickstart verifies endpoint and arguments
  but not MCP result encoding. Required `endpoint not verified` skip stub committed;
  needs an official output example/schema, not a guessed REST wrapper. README links
  the checked official sources. Live keyless checks are deferred by scope, not run.
  Firecrawl scrape credits are unknown when not supplied by the response.
- [x] C1 Pure scoring, confidence intervals and JSON/Markdown reporting.
  Verified: 9 hand-made scoring/report tests; harness typecheck; full gate
  3359 pass / 0 fail. Weighted uncertainty is labelled descriptive per-tier
  Wilson bounds (weights never inflate independent sample counts).
- [x] C2 Budgeted, paced CLI and offline fake-runner tests.
  Verified: 12 scheduler/CLI tests; 46 new tests total; harness typecheck;
  full gate 3372 pass / 0 fail. Global 1-second pacing is stronger than the
  per-backend minimum. Budget covers MCP setup/notifications, retries, redirects.
  Actual fixture-only CLI dry-run wrote JSON/Markdown with 0 HTTP requests.
  Self-review added regressions for split-CRLF SSE, 504 classification and
  redirect accounting; no extra agents or live backends were used.
- [x] D0 Usage, runner/env list, politeness, Terms check placeholder.
  README documents metrics/denominators, confidence limitations, offline usage,
  official adapter-format sources and the Parallel blocker. No terms table,
  permissions verdict, live-result artifacts or final ranking was added.
- [x] F `bun typecheck && bun test tests/`, plus harness TypeScript check.
  Final gate: **3373 pass, 0 fail**, 265 files, 21670 assertions.
  New offline harness suite: **47 pass, 0 fail** across four files.
  Supplemental harness TypeScript check and `git diff --check` are clean.
  Final self-review added a red/green regression for HTTP-200 in-band MCP
  rate limits: classified keyless rate/server errors stop later backend calls,
  not just HTTP 429/5xx. All-runner CLI dry-run with keys unset used 0 requests.
  Evidence: `$HOME/.cache/logs/web-eval-final-verified.log` and
  `$HOME/.cache/logs/web-eval-all-plan.log`.
  Scope check: no changes to `src/`, `CHANGELOG.md`, `tasks/*` or `verify.ts`.
  No new dependencies, terms verdicts, real-backend runs, pushes or history rewrites.

Remaining external blocker: B2 Parallel's official hosted MCP output format.
The safe skip stub and the reason are committed; everything else in scope is done.

Each item gets a separate additive `chore(web-eval): ...` commit. Long commands
run in the background with logs under `$HOME/.cache/logs/`.
