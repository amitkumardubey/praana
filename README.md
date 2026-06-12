# ARIA

**A terminal coding agent with adaptive context, structured checkpoints, and persistent memory.**

ARIA organises working state into three tiers that compress automatically as a session grows. A multi-resolution context engine distills tool outputs, tracks decisions and errors across turns, and compiles a scored prompt that keeps what matters in full view without blowing up the context window. Between sessions it learns from transcripts: extracting decisions, patterns, and mistakes so the next session starts informed instead of blank.

> **Status:** v0.3.0 — experimental. The core systems work. Expect rough edges on long or complex tasks.

---

## Quick Start

```bash
git clone https://github.com/yourusername/aria.git
cd aria
npm install && npm run build

cp aria.config.example.toml aria.config.toml
# Edit aria.config.toml: set provider and model
export OPENROUTER_API_KEY="sk-or-v1-..."

node dist/main.js
```

### Global install (`aria` on your PATH)

From the repo after building:

```bash
npm run build
npm link
```

Ensure npm’s global `bin` directory is on your PATH (required for [fnm](https://github.com/Schniz/fnm) and similar version managers):

```bash
export PATH="$(npm config get prefix)/bin:$PATH"
# Add the line above to ~/.bashrc or ~/.zshrc
```

Verify:

```bash
which aria
aria --help
```

If `aria` is still not found, use `~/.local/bin` instead:

```bash
mkdir -p ~/.local/bin
ln -sf "$(pwd)/bin/aria.js" ~/.local/bin/aria
export PATH="$HOME/.local/bin:$PATH"
```

Three commands to your first session. Drop-in config via `aria.config.toml` or use zero config defaults.

Or with any other supported provider — see [Provider Support](#provider-support).

---

## What Makes It Different

### Context Engine — distillation, checkpoint, and scored compilation

Most agents treat context as a flat window. Every tool output, every decision, every error competes equally for the same tokens. As a session grows, the model drowns in history.

ARIA's context engine (enabled via `context_engine.enabled = true`) replaces naive truncation with a multi-resolution approach:

**Distillation** — Tool outputs are compressed at the boundary by specialised distillers (git diff, npm test, tsc errors, ripgrep results, logs). Raw content is stored in an artifact store and retrievable via `retrieve_artifact`. Errors are never compressed.

**Checkpoint** — A structured `SessionCheckpoint` is reconciled after every turn from a deterministic `TurnDigest`. Sections include: active request, session narrative (rolling prose of meaningful turns), plan history (current + superseded with completion hints), constraints (append-only, never dropped), decisions (rationale retained even after age-based compaction), errors (open → full detail, fixed → one-liner), files in play, findings, and recent activity. Casual user preferences matching correction patterns (e.g. "not npm, pnpm") are auto-extracted into constraints. Written from `TurnDigest` — never by the LLM — to prevent drift.

**Scored compilation** — Context units are scored with a 3-term model (pin + recency + relevance) and compiled against budget bands. Pinned content (system frame, checkpoint, last 2 verbatim turns) always fits. Scored content (turn digests, artifact cards, activity entries) fills remaining budget by score. Pressure monitoring triggers compaction or emergency mode when the prompt exceeds thresholds.

When the context engine is disabled, ARIA runs in **classic mode** — full verbatim conversation history, no StateGraph tools, skills loaded as a metadata catalog only. This is the same way other agents like Claude Code and pi work, and serves as the baseline for A/B measurement.

### Adaptive Context — three-tier working memory

Most agents treat context as a flat window. Every prior decision, task, and note competes equally for the same tokens. As a session grows, the model drowns in history.

ARIA organises state objects into tiers:

| Tier | What the model sees | When |
|---|---|---|
| **Active** | Full content | Currently relevant |
| **Soft** | One-line summary | Idle for 20+ turns |
| **Hard** | ID only | Idle for 50+ turns |

Demotion is automatic. When you mention something related to a peripheral object — a task title, a decision keyword — it auto-promotes back to active before the prompt is compiled. You don't manage this manually.

**Measured:** In a session with 100+ state objects, tiering reduces context tokens for peripheral state by 70–88% compared to flat rendering. [Benchmark](./docs/benchmarks/token-benchmark.ts).

### Cognitive Memory — learning that persists

At session end, ARIA sends the full transcript to a summariser and extracts learnings. Six kinds:

| Kind | What it stores |
|---|---|
| `fact` | Verifiable knowledge about this project |
| `preference` | How you and ARIA prefer to work |
| `decision` | Architectural or design choices made |
| `pattern` | Recurring approaches that work here |
| `mistake` | A failure + the lesson extracted from it |
| `constraint` | A rule that must always hold |

Memories exist at two levels:

- **Project-level** — scoped to the current codebase. `fact`, `decision`, and most `pattern` entries live here. "This API uses JWT." "The auth middleware is in `src/lib/auth`." Invisible to other projects.
- **Global** — applies across every project you work on. Preferences, personal constraints, universal patterns. "Always write tests before implementation." "Never use `any` in TypeScript." These follow you into every session.

At session start, ARIA builds a ranked digest from memory in scope for the current session.

**Honest note on current state:** Semantic recall is available via `embedder` strategies (`auto`, `ollama`, `transformers`, `llama-cpp`) with graceful fallback to hash when semantic backends are unavailable. Global+project recall merging is still in progress.

### Project Context — AGENTS.md

At session start, ARIA automatically loads project context from `AGENTS.md` files and injects it into the system prompt. This is how a project communicates its conventions, architecture, and constraints to any AI agent — not just ARIA.

Load order (all found files are merged):
1. `~/.aria/AGENTS.md` — your personal global instructions, applied to every project
2. `<git root>/AGENTS.md` — project-wide context
3. `<cwd>/AGENTS.md` — subdirectory context (if you're in a subdirectory)
4. `CLAUDE.md` — compatibility fallback if no `AGENTS.md` found

Combined content is capped at ~4000 tokens. ARIA prints `[context] Loaded project context (~N tokens)` on session start when context is found.

The agent can create or update `AGENTS.md` via `write_file` as it discovers useful project knowledge.

### Skills — progressive agent capabilities

ARIA discovers [Agent Skills](https://agentskills.io/) (`SKILL.md` files) from standard locations and loads them progressively so the prompt stays within budget:

| Tier | What the model sees | When |
|---|---|---|
| **Hot** | Planner section (full body if no sections) | Matched to your query |
| **Warm** | One-line stub | Recently relevant, standing by |
| **Cold** | Name + description in catalog | Discovered but not active |

Search paths (project overrides user when names collide):

- `<git root>/.agents/skills`, `.aria/skills`, `.cursor/skills`, `skills/`
- `~/.agents/skills`, `~/.aria/skills`, `~/.claude/skills`

Skills are ranked per turn with BM25 + synonym expansion. Execution and recovery sections hydrate when tools run or fail. The status bar shows residency counts (`HOT · WARM · COLD`). Residency resets on session resume — skills are re-discovered, not persisted.

Optional metadata in `.aria/skills-meta.json` (project or `~/.aria/`): tags, triggers, neighbors, per-skill token budgets, custom section headings.

---

## Slash Commands

| Command | What it does |
|---|---|
| `/state` | List session state objects (or explain how to start tracking) |
| `/digest` | Show the cross-session memory digest |
| `/recall <query>` | Search memory manually |
| `/stats` | Session metadata plus working/persistent memory stats |
| `/events` | Last 20 events in the session log |
| `/why <id>` | Explain why a context unit was included or excluded (requires engine mode) |
| `/model <name>` | Switch models mid-session |
| `/sessions` | List past sessions for resuming |
| `/debug` | Toggle verbose tool tracing (saves compiled prompts to disk) |
| `/thinking <on\|off>` | Toggle model reasoning stream |
| `/exit` | End session cleanly (triggers learning extraction) |
| `/help` | All commands |

---

## Tools

**Adaptive Context** (working memory for this session):
`create_task` · `complete_task` · `add_constraint` · `decide` · `add_note` · `hydrate` · `soft_unload` · `hard_unload` · `list_state`

**Cognitive Memory** (cross-session knowledge):
`recall` · `remember`

**Context Engine** (artifact retrieval and session navigation — engine mode only):
`retrieve_artifact` · `context_summary` · `search_turn_events` · `event_lineage`

**System** (filesystem and shell):
`shell` · `read_file` · `write_file` · `edit_file`

---

## Provider Support

| Provider | Env var |
|---|---|
| OpenRouter | `OPENROUTER_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together | `TOGETHER_API_KEY` |
| OpenCode Zen | `OPENCODE_API_KEY` |
| Ollama | *(none — local)* |
| AWS Bedrock | *(AWS credentials)* |

Switch mid-session: `/model deepseek/deepseek-v4-pro` or set `ARIA_MODEL`.

---

## Configuration

```toml
[llm]
provider = "openrouter"
model = "deepseek/deepseek-v4-flash:free"  # free tier default

[memory]
enabled = true
summarizer = "openrouter"       # uses google/gemini-2.5-flash by default
db_path = "~/.aria/memory.db"

[compiler]
token_budget = 100000
recent_turns = 10
recent_turns_token_budget = 30000
agents_budget_ratio = 0.3   # AGENTS.md section ceiling (share of token_budget)

[skills]
enabled = true
max_token_budget_ratio = 0.2   # skills section ceiling (share of token_budget)
active_skill_idle_turns = 5    # hot → warm after N idle turns
warm_skill_eviction_turns = 20  # warm → cold after N idle turns

[tiers]
idle_soft_after_turns = 20
idle_hard_after_turns = 50

[context_engine]
enabled = false                    # true = engine mode (checkpoint, distillation, scoring)
measurement_mode = false           # write telemetry in classic mode for A/B comparison
artifact_inline_threshold = 400    # tokens; below this, output appears verbatim
artifact_ttl_turns = 50           # turns before artifact eviction
checkpoint_enabled = true          # SessionCheckpoint: narrative, plan, constraints, decisions w/ rationale
scoring_enabled = true             # scored multi-resolution compiler

[context_engine.distiller]
default_intensity = "full"         # lite | full

[context_engine.scoring]
w_pin = 1.0                        # pinned unit boost
w_recency = 0.5                    # recency decay weight
w_relevance = 0.3                  # BM25 relevance weight

[context_engine.pressure]
compact_at = 0.70                  # pressure ratio for compaction
emergency_at = 0.85                # pressure ratio for emergency mode

[session]
log_dir = "~/.aria/sessions"
```

Config is merged from four locations, lowest to highest precedence:
`~/.aria/aria.config.json` → `~/.aria/config.toml` → `./aria.config.json` → `./aria.config.toml`

**Environment variable overrides:**

| Variable | Overrides |
|---|---|
| `ARIA_MODEL` | `llm.model` |
| `ARIA_SUMMARIZER_MODEL` | summarizer model |
| `ARIA_CONTEXT_ENGINE` | `context_engine.enabled` |
| `ARIA_MEASUREMENT_MODE` | `context_engine.measurement_mode` |

---

## How It Works

**Engine mode** (`context_engine.enabled = true`):

```
User input
  → auto-hydrate peripheral objects matching query keywords
  → match skills (BM25) and update hot/warm/cold residency
  → ingest tool results through distillers (compressed at boundary, raw to artifact store)
  → compile prompt from budget bands:
      system frame · skills · checkpoint · verbatim recent turns · scored context · active state · memory digest
  → stream LLM response with tool calls
  → log all events to append-only JSONL
  → extract TurnDigest (deterministic, no LLM)
  → reconcile SessionCheckpoint from digest
  → apply tier demotion (idle objects compress)
  → print session banner

Session end (/exit)
  → send transcript to summariser
  → extract learnings (facts, decisions, patterns, mistakes, constraints)
  → store to SQLite with confidence scores
  → close event log + context engine
```

**Classic mode** (`context_engine.enabled = false`):

```
User input
  → compile prompt with full verbatim conversation history
  → stream LLM response with tool calls
  → log all events to append-only JSONL
  → apply tier demotion
  → print session banner
```

The context and memory systems are domain-agnostic at their core. Coding is the first application.

Full architecture: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) · Key concepts: [docs/concepts.md](./docs/concepts.md)

---

## Development

```bash
npm run dev     # run with tsx (no build step)
npm run build   # compile TypeScript
npm test        # unit tests
```

Node 22+. TypeScript throughout.

---

## What's Next

The core works. What needs to come next, in order:

- **Classic mode implementation** — full verbatim conversation history, no StateGraph, skills as metadata catalog. The A/B measurement baseline.
- **Global + project recall merge** — query both scopes and combine results with project-aware precedence
- **Confidence reinforcement** — wire the feedback loop so recalled memories that help get stronger; unused ones fade faster
- **Multi-file operations** — create multiple files in one turn instead of three
- **Diff preview** — show a unified diff before applying `edit_file`
- **Project context auto-load** — read `package.json`, `tsconfig.json`, `README.md` on session start so the agent knows your stack before you explain it
- **Evaluation framework** — 30-task benchmark against a stateless baseline to measure whether the memory actually helps

Nothing is promised. Issues and PRs welcome.

---

## License

MIT — see [LICENSE](./LICENSE). See [CHANGELOG.md](./CHANGELOG.md) for version history.
