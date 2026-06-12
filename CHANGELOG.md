# Changelog

## [Unreleased]

### Context Engine
- Session checkpoint now retains decision rationale after age-based compaction.
- Added session narrative section (rolling prose from TurnDigest, replaces volatile).
- Added plan history with superseded plans and completion hints.
- Auto-extract implicit constraints from user correction/preference patterns.
- System frame nudges agent to capture preferences via `add_constraint` / `add_note`.

## [0.3.0] — 2026-05-30

Phase-0 foundation, stabilization, and UX release.

### CLI & UX
- Added global `aria` CLI installation flow via `npm link` / `bin/aria.js`.
- Added session status bar above the prompt for faster context awareness.
- Added turn interruption support via `Esc Esc` and `Ctrl+C`.
- Separated thinking stream from response text rendering for cleaner output.
- Added polished terminal rendering with `chalk`, `ora`, `boxen`, and markdown rendering support.
- Added in-session event log search and legacy log migration handling.
- `/stats` now separates session metadata, working memory, and persistent memory details; `/state` now has actionable empty-state guidance (#9).
- CLI startup now honors explicit `--config` / `-c` path selection and reports the loaded config source.

### Memory & Recall
- Added semantic embedding strategy foundation with `auto` behavior (Ollama probe → hash fallback).
- Added Ollama summarizer support for session-end learnings.
- Improved recall quality with hybrid FTS + vector candidate retrieval.
- Separated recall match scoring from confidence and added runtime memory kind validation.
- Hardened vector re-embedding migration behavior with retry safety.
- Session-end flow now tolerates summarizer abort errors and avoids false failure logs on clean `/exit` (#4).
- Added timeout-safe session end behavior to avoid blocking shutdown on long summarizer calls.

### LLM / Provider Support
- Added OpenCode Zen provider support and provider-registry test coverage.

### Reliability & Tooling
- Fixed default limit behavior for `search_session_log`.
- Fixed thinking block state reset before tool-call output.
- Added stricter JSON/TOML content validation in `write_file`.

### Testing
- Expanded automated coverage substantially across turn orchestration, rendering/UI, memory behavior, status bar, event log, interrupt handling, embedder/summarizer factories, and CLI argument parsing.

### Documentation
- Added and evolved `ROADMAP.md` for phase tracking and priorities.
- Updated `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, and `docs/concepts.md` for current behavior.
- Marked semantic embedder auto strategy status and recorded Phase-0 completion items (`#4`, `#9`, `#18`).

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
