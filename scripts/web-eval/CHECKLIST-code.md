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
- [ ] D0 Usage, runner/env list, politeness, Terms check placeholder.
- [ ] F `bun typecheck && bun test tests/`, plus harness TypeScript check.

Each item gets a separate additive `chore(web-eval): ...` commit. Long commands
run in the background with logs under `$HOME/.cache/logs/`.
