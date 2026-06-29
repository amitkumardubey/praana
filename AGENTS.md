# AGENTS.md — PRAANA

PRAANA is a TypeScript CLI coding agent built around two systems:

- **Adaptive Context** — within-session working memory. State objects (tasks, decisions, constraints, notes) are tiered: `active` (full detail), `soft` (one-line stub), `hard` (ID only). Tiers are managed automatically based on idle turn count. The deterministic prompt compiler assembles a token-budgeted context window on every turn.

- **Cognitive Memory** — cross-session persistent knowledge. SQLite-backed. At session end, an LLM summariser extracts learnings from the transcript (facts, preferences, decisions, patterns, mistakes, constraints) and stores them with confidence scores. Memories decay over time. At session start, a ranked digest is injected into the prompt. Two scopes: **project-level** (scoped to the working directory) and **global** (applies across all projects).

These are separate systems. The compiler consumes a memory digest as one of its five sections; it does not merge with memory otherwise.

---

## Setup & Build

```bash
bun install
bun typecheck    # TypeScript type-check (no emit)
bun dev          # Run without build step
bun test         # 83 files, 1010 tests, ~8s
```

Requires **Bun ≥1.2**. Native dependencies are optional (see Embedder Config below).

---

### Global CLI (`bun link`)

`package.json` exposes `praana` and `pran` via `bin/praana.js`. Run `bun link` and add `$(bun pm bin -g)` to your PATH.

## Running

```bash
# Start a new session
bun start

# Global CLI (after bun link)
praana
pran
praana resume <session_id>

# Resume a previous session
bun start -- resume <session_id>

# Debug mode (saves compiled prompts, verbose tool blocks)
PRAANA_DEBUG=true bun start

# Explicit config file
praana --config /path/to/praana.config.toml
```

### Configuration

Config is deep-merged from (later overrides earlier):
1. `~/.praana/praana.config.json`
2. `~/.praana/config.toml`
3. `./praana.config.json`
4. `./praana.config.toml`

Key env vars:
- Provider API keys: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.
- `PRAANA_MODEL` — override model at runtime
- `PRAANA_SUMMARIZER_MODEL` — override summariser model
- `PRAANA_DEBUG=true` — saves compiled prompts per turn to `prompts/`

### Embedder Config

Cognitive Memory uses vector search for recall. The embedder strategy is configured in `[memory]`:

```toml
[memory]
embedder = "auto"            # default — transformers (model downloads on first run)
transformers_model = "Xenova/all-MiniLM-L6-v2"  # optional override
ollama_url = "http://localhost:11434"
ollama_model = "nomic-embed-text"
```

Strategies:
- `auto` — uses Transformers.js (`@huggingface/transformers`, shipped as a dependency). Model weights download on first run to `~/.praana/models/`.
- `transformers` — in-process ONNX via `@huggingface/transformers` (Xenova/all-MiniLM-L6-v2, 384-dim). Models cache in `~/.praana/models/`.
- `transformers-nomic` — 768-dim variant (Xenova/nomic-embed-text-v1) for higher-quality recall.
- `ollama` — opt-in; requires running Ollama daemon. Run `ollama pull nomic-embed-text` first.

When no semantic embedder is available, recall uses **keyword-only search** (FTS) — never fake vectors.

When adding embedder support, implement the `Embedder` interface in `src/memory/types.ts`. The interface has two fields: `dim: number` and `embed(text: string): Promise<Float32Array>`.

### Project Context (AGENTS.md)

On session start, PRAANA automatically loads and injects context from `AGENTS.md` files into the system prompt (System Frame, section 1). Load order:

1. `~/.praana/AGENTS.md` — global personal instructions
2. `<git root>/AGENTS.md` — project-wide context  
3. `<cwd>/AGENTS.md` — subdirectory context (if cwd ≠ git root)
4. `CLAUDE.md` — compatibility fallback if no `AGENTS.md` found at project root

All found files are merged. Combined content is capped at ~4000 tokens (16,000 chars). A truncation warning is printed if exceeded.

The agent can create or update `./AGENTS.md` via `write_file`. Token usage is tracked in `CompileMetrics.agentsContextTokens`.

Implementation: `loadAgentsContext()` in `src/session.ts`. Uses `git rev-parse --show-toplevel` to find the git root; falls back to `cwd` if not in a git repo.

---

### Slash Commands

| Command | Function |
|---|---|
| `/exit` | End session cleanly (triggers summariser, prints summary) |
| `/state` | List state objects and tiers, or show empty-state guidance |
| `/stats` | Session metadata + working-memory + Cognitive Memory stats |
| `/scorecard` | Per-session telemetry scorecard (numeric signals only; issue #99) |
| `/digest` | Show current Cognitive Memory digest |
| `/events` | Show last 20 events in the event log |
| `/recall <query>` | Search Cognitive Memory manually |
| `/model [provider] <id>` | Switch model and optionally provider mid-session |
| `/sessions` | List past sessions for resuming |
| `/debug` | Toggle debug mode |
| `/thinking <on\|off>` | Toggle LLM reasoning stream visibility |
| `/incognito <on\|off>` | Toggle Cognitive Memory persistence |
| `/clear`, `/new` | Clear working-memory state (engine checkpoint + StateGraph) |
| `/why <id>` | Explain context-unit scoring (engine mode, debug) |
| `/help` | All commands |

**`/model` resolution order:** pi-ai static catalog → live provider `/models` API (6h cache) → reject with toast if still unknown. Parse as `/model [provider] <model-id>` (space-separated provider only). Strip routing prefixes like `openrouter/` or `opencode/` before API calls. Persist `modelOverride` and `providerOverride` to the event log; restore both on resume. Ollama accepts any local model name without a catalog hit.

---

## Testing

```bash
bun test                                              # Full suite
bun test tests/compiler.test.ts                       # Single file
bun test --test-name-pattern "should compile prompt"  # Single test
bun test --watch                                      # Watch mode
```

Tests live in `tests/`. Keep the full suite passing before committing.

**Conventions:**
- Add tests for any new logic before committing.
- Use in-memory SQLite (`:memory:`) for memory-layer tests — always via `openDatabase()` (see Common Gotchas), never a real db path.
- Integration tests for session lifecycle → `tests/resume.test.ts`
- State graph unit tests → `tests/state-graph.test.ts`
- Compiler tests → `tests/compiler.test.ts`, `tests/compile-classic.test.ts`

---

## Architecture

Full details: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). Key terms: [docs/concepts.md](./docs/concepts.md).

```
src/
  main.ts        — CLI entry: TUI (default) or readline, slash commands
  turn.ts        — Per-turn orchestration: prompt → LLM → tools → tier management
  session.ts     — Session lifecycle (create/resume/end), embedder selection, memory init
  compile-classic.ts — Classic-mode compiler (full verbatim history, no truncation)
  compiler.ts    — Legacy budget-band compiler (unit tests only)
  state-graph.ts — Tiered state (active/soft/hard), auto-demotion, two-pass auto-hydrate (substring + BM25)
  state-graph-checkpoint.ts — O(1) resume: persist/restore StateGraph snapshot after each turn
  event-log.ts   — Append-only events.jsonl, fsyncSync durability; in-memory parse cache
  token-estimate.ts — Canonical Unicode-aware token heuristic (Latin/CJK/emoji/ZWJ)
  context-pressure.ts — Density-weighted effective-token accounting and raw-token safety net
  llm.ts         — Provider registry, model building via pi-ai
  config.ts      — Multi-source JSON/TOML config loading, deep-merge
  types.ts       — Shared TypeScript types
  ui/
    readline-ui.ts — Classic readline loop
    tui/           — Ink TUI (default when TTY): transcript, status bar, thinking blocks
  skills/
    index.ts     — SkillRuntime: discovery, load tracking, telemetry (engine mode only)
    types.ts     — Skill metadata, runtime state, telemetry types
  tools/
    index.ts     — Tool registry
    memory.ts    — Adaptive Context tools (create_task, decide, add_constraint, search_session_log, etc.)
    knowledge.ts — Cognitive Memory tools (recall, remember)
    system.ts    — System tools (shell, read_file, write_file, edit_file)
    search-code.ts — search_code: ripgrep-backed structured code search (rg --json → file:line:column matches with context, globs, max_results)
  memory/
    store.ts     — MemoryStore: remember, recall, digest, session lifecycle
    db.ts        — SQLite schema, CRUD, vector search
    embeddings.ts — OllamaEmbedder
    transformers-embedder.ts — Transformers.js in-process semantic embedder
    transformers-models.ts — Model presets (MiniLM, nomic)
    summarizer.ts — extractLearnings: transcript → structured learnings via LLM
    types.ts     — Memory-specific types
```

### Skills (issue #96)

**Pull model — engine & classic modes share a tiny catalog.** `discoverSkills()` scans project and user paths (`.agents/skills`, `.praana/skills`, `.cursor/skills`, `skills/`, plus user-level equivalents) and builds a lightweight `SkillRecord[]` catalog. The catalog is rendered into the prompt via `buildSkillMetadataCatalog()` in both modes: a list of `- **name**: description` lines with a `Load a skill with load_skill(skill_id)` header. No full bodies, no file paths, no residency tiers.

**Engine mode** additionally creates a `SkillRuntime` for load tracking + eviction:
- The new `load_skill(skill_id)` tool looks up the skill by name, reads `SKILL.md` from disk, and returns the body. It calls `SkillRuntime.trackLoad()` to record the load and enforce the `max_loaded_skills` budget (oldest-by-turn evicted).
- At each turn end, `cleanupStaleSkills(currentTurn)` evicts skills idle longer than `stale_threshold_turns`.
- Telemetry events (`skill_loaded`, `skill_reloaded`, `skill_evicted`) are drained per turn via `flushSkillTelemetry()` to the event log. Session-end summary (under `measurement_mode`) prints: `catalog=N loaded=M reloaded=R evicted=E under_load=U`.

**Classic mode** has no `SkillRuntime` — `load_skill` reads the body, no tracking, no eviction. Plain agent behavior (like pi/omp/opencode). When `measurement_mode=true`, classic sessions still record skill load/reload/token counters via `ScorecardTracker.trackSkillLoad()`.

Config `[skills]` keys: `enabled`, `max_token_budget_ratio` (section trim ceiling), `max_loaded_skills`, `stale_threshold_turns`, `max_depth`. Resume re-discovers skills; loaded state does **not** persist across sessions.

### Telemetry scorecard (issue #99)

**Local-only numeric signals** for comparing engine vs classic and before/after changes. Rows live in the context-engine SQLite `scorecard` table (one row per session). No prompts, file contents, or paths are stored — only counts, averages, path digests, and skill catalog ids for resume deduplication.

- **Active when:** `context_engine.enabled=true` (always persists) **or** `measurement_mode=true` (classic/debug — scorecard-only DB, no full engine).
- **Signals:** context (`retrieve_artifact`, repeat reads, turn-event searches, pressure/compaction), memory (recall calls, recall-used %, project-scoped validity/usefulness deltas), skills (unique loads, load events, reloads, underloads, token cost).
- **Resume:** counters + memory start averages + read-path digests + skill ids restored from DB; `persistProgress()` after each turn.
- **Query:** `/scorecard` in-session; SQL against the context DB for cross-session A/B (#17).

### Turn flow (per turn)

Compile mode is selected in `turn.ts`: engine when `context_engine.enabled=true` **and** `session.contextEngine` is initialized; otherwise classic.

**Engine mode:**

```
User input
  → auto-hydrate matching peripheral state (two-pass: substring keyword + BM25 relevance)
  → compileEngineWithMetrics: system frame | skills catalog | checkpoint | verbatim turns | scored context (BM25 + semantic embeddings) | active state | memory digest
  → stream LLM response with tool calls
  → log all events (tool_call, tool_result, agent_message)
  → extract TurnDigest (deterministic) + reconcile SessionCheckpoint
  → increment turn count, run applyTierManagement() + cleanupStaleSkills()
  → print memory banner
```

**Classic mode:**

```
User input
  → compileClassicWithMetrics: system frame | skills catalog | memory digest | full verbatim history
  → stream LLM response (shared + system + memory tools only)
  → log all events
  → increment turn count (no tier management, no skill tracking)
  → print memory banner
```

### Memory scopes

Default scopes set at session start: `user:<sha256>`, `agent:praana`, `context:<sha256_of_cwd>`.

- **Project-level** memories carry all three scopes — only visible from that project directory.
- **Global** memories carry only `user` and `agent` scopes — visible in all project sessions.

Recall enforces AND-scoping: an entry is returned only if it carries *all* scopes in the query. In project sessions, the store queries **both** the full project scopes (`user` + `agent` + `context`) and global-only scopes (`user` + `agent`), then merges and de-duplicates by entry id. Global-only queries exclude entries that carry a `context:` scope, so project facts stay project-local while preferences and cross-project patterns surface everywhere.

---

## Code Conventions

- **Language:** TypeScript strict mode
- **Modules:** NodeNext — use `.js` extensions in imports (`import { Foo } from "./bar.js"`)
- **Target:** ES2022
- **Naming:** `kebab-case.ts` files, `camelCase` functions/vars, `PascalCase` types
- **Exports:** Named exports preferred. Default exports only for entry points.
- **Errors:** Don't swallow silently. Log with context, then rethrow or return `{ ok: false, error }`.
- **Async:** `async/await` throughout. No raw `.then()` chains.
- **No Prettier/ESLint config** — keep style consistent with surrounding code manually.

---

## Security

- **Shell tool:** Runs arbitrary commands with the user's permissions. Optional sandbox allowlist via `[shell]` in config (`enabled`, `allowed_paths`); off by default.
- **Event log:** `~/.praana/sessions/<session_id>/events.jsonl`. Contains all tool calls and results in plaintext. Do not log API keys or secrets through tools.
- **In-session recall:** Use `search_session_log` for earlier turns in the current session. `recall` searches cross-session Cognitive Memory only.
- **Memory DB:** `~/.praana/memory.db` — plaintext SQLite. No encryption at rest.
- **Provider keys:** Read from env vars only. Never hardcode or log.

---

## Common Gotchas

- `edit_file` requires exact unique text match — whitespace-sensitive. Will fail on duplicate code blocks or trailing whitespace differences.
- Event log `fsyncSync` on every write — intentional for durability, affects throughput on fast tool loops.
- Session log path is `events.jsonl` under `~/.praana/sessions/<session_id>/`. Legacy `events.log` files are migrated automatically on session open.
- After code reviews or multi-issue analysis, call `add_note` immediately — otherwise findings disappear when recent turns truncate.
- Session resume replays `context_action` events to rebuild state graph. If the log is truncated or corrupted, state rebuilds empty — not an error, just blank state.
- Config merge order is global-first, local-last. A `./praana.config.toml` always wins over `~/.praana/config.toml`.
- The embedder dimension matters for the vector table schema. Switching between backends with different dims (e.g. transformers 384-dim → ollama/transformers-nomic 768-dim) triggers re-embedding in `openMemoryDb()`. Backend changes at the same dimension also trigger re-embed via `embedding_backend` tracking in `memory_meta`.
- `applyTierManagement()` in `turn.ts` runs after every turn — objects demote based on `touchedTurn` vs `currentTurn`. If you add a new state tool, call `stateGraph.setTier()` or the object won't register as touched.
- **bun:sqlite `:memory:` gotcha:** `new Database(":memory:")` in bun creates a real on-disk file named `:memory:` instead of a true in-memory database. Any path whose basename is `:memory:` — including cwd-joined forms like `/project/:memory:` — hits the same bug. Always open `:memory:` databases through `openDatabase()` in `src/sqlite.ts`, which special-cases the basename and uses the no-arg `new Database()` constructor instead. `new Database(realPath)` with a genuine file path is fine.

---

## Git Conventions

- **Commits:** Conventional commits — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:` (release-please uses these for `CHANGELOG.md`)
- **Changelog:** Do not edit `CHANGELOG.md` by hand for releases. Release-please opens a version PR from commit history; merge that PR to cut a release.
- **Tags:** Semver — `v0.4.0` (release-please creates tags)
- **Branch:** `main`
- **Issue work:** Create a dedicated branch for each GitHub issue before making code changes (example: `feat/phase1-issue-56`).
- **Before commit:** `bun typecheck && bun test` — both must pass clean
