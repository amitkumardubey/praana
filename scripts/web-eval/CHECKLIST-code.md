# Runner implementation checklist

Scope: runners, scoring/reporting and offline-safe CLI. Task sets and `verify.ts`
are owned separately. No live backend evaluations, terms verdicts or rankings.

- [x] B1 Base contract, taxonomy, local fetch and Jina Reader; offline fixtures.
  Verified: 5 adapter tests; harness TypeScript check; full gate 3331 pass / 0 fail.
- [x] B2 Officially documented API/Exa MCP/Firecrawl MCP adapters; offline fixtures.
  Verified: full gate 3350 pass / 0 fail; 24 adapter tests, harness typecheck.
  **BLOCKED (Parallel only):** official quickstart verifies endpoint and arguments
  but not MCP result encoding. Required `endpoint not verified` skip stub committed;
  needs an official output example/schema, not a guessed REST wrapper. README links
  the checked official sources. Live keyless checks are deferred by scope, not run.
  Firecrawl scrape credits are unknown when not supplied by the response.
- [ ] C1 Pure scoring, confidence intervals and JSON/Markdown reporting.
- [ ] C2 Budgeted, paced CLI and offline fake-runner tests.
- [ ] D0 Usage, runner/env list, politeness, Terms check placeholder.
- [ ] F `bun typecheck && bun test tests/`, plus harness TypeScript check.

Each item gets a separate additive `chore(web-eval): ...` commit. Long commands
run in the background with logs under `$HOME/.cache/logs/`.
