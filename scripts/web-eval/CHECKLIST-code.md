# Runner implementation checklist

Scope: runners, scoring/reporting and offline-safe CLI. Task sets and `verify.ts`
are owned separately. No live backend evaluations, terms verdicts or rankings.

- [x] B1 Base contract, taxonomy, local fetch and Jina Reader; offline fixtures.
  Verified: 5 adapter tests; harness TypeScript check; full gate 3331 pass / 0 fail.
- [ ] B2 Officially documented search/MCP adapters; offline fixtures.
- [ ] C1 Pure scoring, confidence intervals and JSON/Markdown reporting.
- [ ] C2 Budgeted, paced CLI and offline fake-runner tests.
- [ ] D0 Usage, runner/env list, politeness, Terms check placeholder.
- [ ] F `bun typecheck && bun test tests/`, plus harness TypeScript check.

Each item gets a separate additive `chore(web-eval): ...` commit. Long commands
run in the background with logs under `$HOME/.cache/logs/`.
