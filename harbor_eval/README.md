# Harbor + Terminal-Bench evaluation

PRAANA ships a Harbor **installed agent** that installs Bun + PRAANA inside the
task container and runs a headless one-shot:

```bash
praana run --incognito --max-steps N "<instruction>"
```

Headless runs set `Session.headless = true`, which omits the engine
**Plan-Before-Execute** prompt rule (no interactive user to approve a plan).

## Prerequisites

1. [Docker](https://docs.docker.com/get-docker/) running locally
2. Harbor CLI: `uv tool install harbor`
3. A provider API key (e.g. `OPENROUTER_API_KEY` or `UMANS_AI_CODING_PLAN_API_KEY`)

## Smoke run (1 task)

From the PRAANA repo root (`-l 1` limits to one task; `-n` is concurrency):

```bash
PYTHONPATH=. harbor run \
  -d terminal-bench@2.0 \
  -a harbor_eval.praana_agent:Praana \
  -m umans/umans-coder \
  -l 1 \
  -n 1 \
  --ae UMANS_AI_CODING_PLAN_API_KEY=$UMANS_AI_CODING_PLAN_API_KEY
```

OpenRouter example:

```bash
PYTHONPATH=. harbor run \
  -d terminal-bench@2.0 \
  -a harbor_eval.praana_agent:Praana \
  -m openrouter/anthropic/claude-sonnet-4 \
  -l 1 \
  -n 1 \
  --ae OPENROUTER_API_KEY=$OPENROUTER_API_KEY
```

## Agent kwargs (`--ak key=value`)

| Kwarg | Meaning |
|-------|---------|
| `max_steps=80` | Passed to `praana run --max-steps` (default 80) |
| `git_ref=main` | Git ref/tag to clone into the container |
| `context_engine=true` | Sets `PRAANA_CONTEXT_ENGINE` for A/B |
| `reasoning_effort=high` | Writes `llm.reasoning_effort` into praana config (`off\|minimal\|low\|medium\|high\|xhigh`) |
| `repo_url=…` | Override clone URL (default: this GitHub repo) |

Harbor `--version` (agent version) is also used as the git ref when `git_ref` is unset.

## Install-only check

Validate container install without running a full task:

```bash
PYTHONPATH=. harbor run \
  -d terminal-bench@2.0 \
  -a harbor_eval.praana_agent:Praana \
  -m umans/umans-coder \
  -l 1 \
  -n 1 \
  --install-only \
  --ae UMANS_AI_CODING_PLAN_API_KEY=$UMANS_AI_CODING_PLAN_API_KEY
```

## Adapter unit tests

```bash
uv run --with pytest python -m pytest harbor_eval/ -q
```

## Notes

- Runs use `--incognito` so Cognitive Memory does not persist across TB trials.
- Assistant text goes to stdout; the adapter tees the full stream to `/logs/agent/praana.txt`.
- Token/cost: `praana run` writes `/logs/agent/praana-usage.json`; Harbor loads it into
  `AgentContext` (`n_input_tokens`, `n_output_tokens`, `cost_usd` when priced).
  Metadata includes `praana_reasoning_effort` (preferred) and
  `praana_reasoning_effort_wire` (actual value sent to the provider, if any).
  After each trial Harbor prints a **praana summary** block to stderr and writes
  `agent/praana-summary.txt` plus trial-level `analysis.md` (shown in Harbor
  viewer agent-logs summary). The model column in the web UI includes
  `· effort=<level>` via `to_agent_info()`. Harbor’s metrics table still does
  **not** render arbitrary `AgentContext.metadata` keys.
  The agent also prepends `provider=… model=… reasoning_effort=…` to
  `/logs/agent/praana.txt`.
  **Important:** do not write `AgentContext.metadata` during `run()` — Harbor only
  calls `populate_context_post_run` when the context is still empty, so early
  metadata seeding drops token/cost import.
  **Requires a PRAANA build that includes usage export** (merged to `main`, or
  `--ak git_ref=<that-branch>` until then).
- Prefer pinning `git_ref` / Harbor `--version` to a known-good commit for reproducible leaderboard runs.
