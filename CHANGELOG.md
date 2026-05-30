# Changelog

## [Unreleased]

## [0.3.0] — 2026-05-30

Phase-0 stabilization and documentation alignment release.

### Fixes
- Session-end lifecycle now tolerates summarizer aborts on clean `/exit` without logging false failures (#4).
- `/stats` now clearly separates session metadata, working memory, and persistent memory details; `/state` has actionable empty-state guidance (#9).
- CLI now honors `--config` / `-c` explicit config paths during startup and displays loaded config source correctly.

### Memory & Recall
- Semantic embedder auto strategy shipped and documented: probe Ollama first, fall back gracefully to hash embedder when unavailable (#18).

### Documentation
- Completed Phase-0 consistency pass across `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/concepts.md`, and `ROADMAP.md`.
- Roadmap now records Phase-0 completion items with concrete issue/PR references.

## [0.2.0] — 2026-05-24

First public release. Initial launch after extensive iteration and evaluation.

### Adaptive Context (Tiered Working Memory)
- State object model with three tiers: `active` (full payload), `soft` (one-line stub), `hard` (minimal anchor)
- Automatic tier demotion after configurable idle thresholds (`idle_soft_after_turns`, `idle_hard_after_turns`)
- Auto-hydration: keyword matching on user input promotes matching peripheral objects back to active
- Deterministic ordering for all state objects in prompt assembly
- Tools: `create_task`, `complete_task`, `add_constraint`, `decide`, `add_note`, `hydrate`, `soft_unload`, `hard_unload`, `list_state`

### Cognitive Memory (Cross-Session Persistence)
- SQLite-backed store with entry, scope, and embedding tables
- Hash-based embedder (FNV-1a seeded, 384-dim) for MVP — deterministic, no external API calls
- Session-scoped memory with AND-based scope isolation (no cross-project leakage)
- `recall` and `remember` tools for agent-driven memory management
- Session-start digest generation (relevant memories from current scope)
- Optional LLM-powered summarizer for extracting learnings at session end
- Configurable summarizer provider (OpenAI-compatible via OpenRouter or disabled)
- Confidence scores with recency decay; pinned memories receive ranking boost

### Prompt Compiler
- Deterministic prompt assembly: system → digest → active state → peripherals → recent turns → input
- Per-section token budgeting with metrics via `compileWithMetrics()`
- Independent token budget for recent-turns section
- Truncation limits per tool type (shell: 500 chars, read/write: 200 chars, etc.)
- Default tuned system prompt shipped (no external file dependency)

### LLM Provider Support
- Provider registry with native API support via [pi-ai](https://github.com/earendil-works/pi-ai)
- 12+ providers: OpenRouter, OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Mistral, xAI, Fireworks, Together, Ollama, AWS Bedrock
- Mid-session model switching via `/model <provider/model>` or `ARIA_MODEL` env var
- Summarizer uses independent provider config (defaults to `google/gemini-2.5-flash` on OpenRouter)

### CLI & Session Management
- Interactive readline loop with slash commands: `/state`, `/stats`, `/digest`, `/events`, `/recall`, `/model`, `/sessions`, `/debug`, `/thinking`, `/exit`, `/help`
- Session create, resume (by ID), and graceful end
- Session-end summary (turns, state objects, memory stores)
- Event-sourced session history (append-only JSONL, `fsyncSync`-durable)
- Model override persisted and restored on resume

### Tools
- **`shell`**: async subprocess with configurable timeout (default: 30s, max: 120s)
- **`read_file`**: text file reading with optional offset/limit
- **`write_file`**: write or overwrite (creates parent directories)
- **`edit_file`**: exact-match, single-occurrence replacement

### Debug & Observability
- `ARIA_DEBUG=true` — saves compiled prompts per turn to `prompts/`, prints verbose tool blocks
- `/debug` toggle for detailed tool call tracing
- Session event log replay for post-hoc analysis

### Configuration
- Multi-source config merge (global JSON → global TOML → local JSON → local TOML)
- Legacy `[bodha]` section backward-compatible (mapped to `[memory]`)
- Example config at `aria.config.example.toml`
- Environment variable overrides for model and API keys

### Documentation
- `README.md` — quickstart, features, provider matrix, configuration reference, "What's Next"
- `AGENTS.md` — AI agent instructions (build, test, conventions, security)
- `docs/ARCHITECTURE.md` — comprehensive architecture deep-dive
- `docs/concepts.md` — core concepts explainer
- `docs/benchmarks/token-benchmark.ts` — measured token savings (70–88% on peripheral state)

### Build & Test
- TypeScript, NodeNext module resolution, ES2022 target
- 23 tests across 6 files (Vitest, <250ms runtime)
- `npm run build` and `npm test` pass clean
- Zero vulnerabilities (`npm audit --omit=dev`)

### Fixes (pre-release)
- **Scope isolation** (P1): recall post-filter changed from OR to AND to enforce strict cross-context isolation
- **Vector deletion** (P2): replaced hazardous nearest-neighbor SQL with direct `entry_id`-based deletion
- **Dynamic version** (P3): banner now reads `version` from `package.json` instead of hardcoded `v0.1.0`

### License
- MIT — see [LICENSE](./LICENSE)

---

> **Honest note:** Both adaptive systems work today, but they're early. Adaptive Context uses basic idle thresholds and keyword auto-hydrate — no semantic understanding yet. Cognitive Memory stores and recalls correctly, but the reinforcement loop (updating confidence based on which memories actually helped) isn't wired. These are foundations, not finished products.
