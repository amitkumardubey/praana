# AGENTS.md — ARIA

ARIA is a TypeScript CLI coding agent built around two systems:

- **Adaptive Context** — within-session working memory. State objects (tasks, decisions, constraints, notes) are tiered: `active` (full detail), `soft` (one-line stub), `hard` (ID only). Tiers are managed automatically based on idle turn count. The deterministic prompt compiler assembles a token-budgeted context window on every turn.

- **Cognitive Memory** — cross-session persistent knowledge. SQLite-backed. At session end, an LLM summariser extracts learnings from the transcript (facts, preferences, decisions, patterns, mistakes, constraints) and stores them with confidence scores. Memories decay over time. At session start, a ranked digest is injected into the prompt. Two scopes: **project-level** (scoped to the working directory) and **global** (applies across all projects).

These are separate systems. The compiler consumes a memory digest as one of its five sections; it does not merge with memory otherwise.

---

## Setup & Build

```bash
npm install
npm run build    # TypeScript compile → dist/
npm run dev      # Run with tsx (no build step)
npm test         # 19 files, 226 tests, ~<1s
```

Requires Node 22+. Native dependencies are optional (see Embedder Config below).

---

### Global CLI (`npm link`)

`package.json` exposes `aria` via `bin/aria.js`. After `npm run build`, run `npm link` and add `$(npm config get prefix)/bin` to your PATH (fnm/nvm users often need this explicitly).

## Running

```bash
# Start a new session
npm start

# Global CLI (after npm run build && npm link)
aria
aria resume <session_id>

# Resume a previous session
npm start -- resume <session_id>

# Debug mode (saves compiled prompts, verbose tool blocks)
ARIA_DEBUG=true npm start

# Explicit config file
aria --config /path/to/aria.config.toml
```

### Configuration

Config is deep-merged from (later overrides earlier):
1. `~/.aria/aria.config.json`
2. `~/.aria/config.toml`
3. `./aria.config.json`
4. `./aria.config.toml`

Key env vars:
- Provider API keys: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.
- `ARIA_MODEL` — override model at runtime
- `ARIA_SUMMARIZER_MODEL` — override summariser model
- `ARIA_DEBUG=true` — saves compiled prompts per turn to `prompts/`

### Embedder Config

Cognitive Memory uses vector search for recall. The embedder strategy is configured in `[memory]`:

```toml
[memory]
embedder = "auto"            # default — tries Ollama first, falls back to hash
ollama_url = "http://localhost:11434"
ollama_model = "nomic-embed-text"
```

Strategies:
- `auto` — checks Ollama availability at startup (2s timeout). Uses it if running, otherwise HashEmbedder + warning.
- `ollama` — explicitly requires Ollama. Run `ollama pull nomic-embed-text` first.
- `transformers` — in-process ONNX via `@huggingface/transformers`. No daemon. Requires `npm install @huggingface/transformers` (~266MB ONNX runtime).
- `llama-cpp` — native bindings via `node-llama-cpp`. Fastest. Requires `npm install node-llama-cpp` and build tools.
- `hash` — deterministic, non-semantic, zero deps. Default fallback. Not suitable for production recall quality.

When adding embedder support, implement the `Embedder` interface in `src/memory/embeddings.ts`. The interface has two fields: `dim: number` and `embed(text: string): Promise<Float32Array>`.

### Project Context (AGENTS.md)

On session start, ARIA automatically loads and injects context from `AGENTS.md` files into the system prompt (System Frame, section 1). Load order:

1. `~/.aria/AGENTS.md` — global personal instructions
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
| `/stats` | Session metadata + working-memory + persistent-memory stats |
| `/digest` | Show current Cognitive Memory digest |
| `/events` | Show last 20 events in the event log |
| `/recall <query>` | Search Cognitive Memory manually |
| `/model <name>` | Switch models mid-session |
| `/sessions` | List past sessions for resuming |
| `/debug` | Toggle debug mode |
| `/thinking <on\|off>` | Toggle LLM reasoning stream |
| `/help` | All commands |

---

## Testing

```bash
npm test                                          # Full suite
npx vitest run tests/compiler.test.ts             # Single file
npx vitest run -t "should compile prompt"         # Single test
npx vitest                                        # Watch mode
```

Tests live in `tests/`. Keep the full suite passing before committing.

**Conventions:**
- Add tests for any new logic before committing.
- Use in-memory SQLite (`:memory:`) for memory-layer tests — never use a real db path.
- Integration tests for session lifecycle → `tests/resume.test.ts`
- State graph unit tests → `tests/state-graph.test.ts`
- Compiler tests → `tests/compiler.test.ts`

---

## Architecture

Full details: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). Key terms: [docs/concepts.md](./docs/concepts.md).

```
src/
  main.ts        — CLI entry, readline loop, slash commands
  turn.ts        — Per-turn orchestration: prompt → LLM → tools → tier management
  session.ts     — Session lifecycle (create/resume/end), embedder selection, memory init
  compiler.ts    — Deterministic prompt compiler, 5 sections, per-section token budgets
  state-graph.ts — Tiered state (active/soft/hard), auto-demotion, auto-hydrate
  event-log.ts   — Append-only events.jsonl, fsyncSync durability
  llm.ts         — Provider registry, model building via pi-ai
  config.ts      — Multi-source JSON/TOML config loading, deep-merge
  types.ts       — Shared TypeScript types
  ui.ts          — Terminal output, banners, formatting
  skills/
    index.ts     — SkillRuntime: discovery, BM25 matching, hot/warm/cold residency
    types.ts     — Skill metadata, runtime state, telemetry types
  tools/
    index.ts     — Tool registry
    memory.ts    — Adaptive Context tools (create_task, decide, add_constraint, search_session_log, etc.)
    knowledge.ts — Cognitive Memory tools (recall, remember)
    system.ts    — System tools (shell, read_file, write_file, edit_file)
  memory/
    store.ts     — MemoryStore: remember, recall, digest, session lifecycle
    db.ts        — SQLite schema, CRUD, vector search
    embeddings.ts — HashEmbedder + OllamaEmbedder; Embedder interface
    summarizer.ts — extractLearnings: transcript → structured learnings via LLM
    types.ts     — Memory-specific types
```

### Skills (issue #57)

On session start, `SkillRuntime` discovers `SKILL.md` files from project and user paths (`.agents/skills`, `.aria/skills`, `.cursor/skills`, `skills/`, plus user-level equivalents). Skills are ranked per turn via BM25 + synonyms; residency tiers are **hot** (loaded sections in prompt), **warm** (one-line stub), **cold** (catalog only). Config: `[skills]` in `aria.config.toml` (`enabled`, `max_token_budget_ratio`, idle/eviction turns, `max_depth`). Compiler uses `agents_budget_ratio` for AGENTS.md trimming and `skills.max_token_budget_ratio` for the skills section ceiling. **Resume re-discovers skills; residency does not persist across sessions.**

### Turn flow (per turn)

```
User input
  → auto-hydrate matching peripheral state (keyword matching)
  → skill matching (BM25) + residency promotion/demotion
  → compile prompt: system frame | skills | memory digest | active state | stubs | recent turns
  → stream LLM response with tool calls
  → log all events (tool_call, tool_result, agent_message)
  → increment turn count, run applyTierManagement()
  → print memory banner
```

### Memory scopes

Default scopes set at session start: `user:<sha256>`, `agent:aria`, `context:<sha256_of_cwd>`.

- **Project-level** memories carry all three scopes — only visible from that project directory.
- **Global** memories carry only `user` and `agent` scopes — visible in all project sessions.

Recall enforces AND-scoping: an entry is returned only if it carries *all* requested scopes. The recall pipeline should query both project and global scopes and merge results. **This merge is not yet implemented** — currently only project scope is queried.

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

- **Shell tool:** Runs arbitrary commands with user's permissions. No sandboxing. Respect the `timeout` field.
- **Event log:** `~/.aria/sessions/<session_id>/events.jsonl`. Contains all tool calls and results in plaintext. Do not log API keys or secrets through tools.
- **In-session recall:** Use `search_session_log` for earlier turns in the current session. `recall` searches cross-session Cognitive Memory only.
- **Memory DB:** `~/.aria/memory.db` — plaintext SQLite. No encryption at rest.
- **Provider keys:** Read from env vars only. Never hardcode or log.

---

## Common Gotchas

- `edit_file` requires exact unique text match — whitespace-sensitive. Will fail on duplicate code blocks or trailing whitespace differences.
- Event log `fsyncSync` on every write — intentional for durability, affects throughput on fast tool loops.
- Session log path is `events.jsonl` under `~/.aria/sessions/<session_id>/`. Legacy `events.log` files are migrated automatically on session open.
- After code reviews or multi-issue analysis, call `add_note` immediately — otherwise findings disappear when recent turns truncate.
- Session resume replays `context_action` events to rebuild state graph. If the log is truncated or corrupted, state rebuilds empty — not an error, just blank state.
- Config merge order is global-first, local-last. A `./aria.config.toml` always wins over `~/.aria/config.toml`.
- The embedder dimension matters for the vector table schema. Switching from `hash` (384-dim) to `ollama`/`transformers` (768-dim) requires a schema migration in `openMemoryDb()`. A migration is needed before shipping embedder switching.
- `applyTierManagement()` in `turn.ts` runs after every turn — objects demote based on `touchedTurn` vs `currentTurn`. If you add a new state tool, call `stateGraph.setTier()` or the object won't register as touched.

---

## Git Conventions

- **Commits:** Conventional commits — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **Tags:** Semver — `v0.2.0`
- **Branch:** `main`
- **Issue work:** Create a dedicated branch for each GitHub issue before making code changes (example: `feat/phase1-issue-56`).
- **Before commit:** `npm run build && npm test` — both must pass clean
