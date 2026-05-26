# AGENTS.md — ARIA

ARIA is a TypeScript CLI coding agent with two adaptive memory systems: Adaptive Context (tiered working memory) and Adaptive Memory (cross-session persistence).

## Setup & Build

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Dev mode (no build step)
npm run dev
```

Requires Node 22+. No other runtime dependencies.

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
```

### Configuration

Config loaded from (later overrides earlier):
1. `~/.aria/aria.config.json`
2. `~/.aria/config.toml`
3. `./aria.config.json`
4. `./aria.config.toml`

Key env vars:
- `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or provider-specific key
- `ARIA_MODEL` — override model (e.g. `anthropic/claude-sonnet-4`)
- `ARIA_SUMMARIZER_MODEL` — override summarizer model

### Slash Commands

| Command | Function |
|---------|----------|
| `/exit` | End session (saves session and prints summary) |
| `/state` | List state objects and their tiers |
| `/stats` | Session stats and memory tier counts |
| `/digest` | Show current cross-session memory digest |
| `/events` | Show last 20 events |
| `/recall <query>` | Search cross-session memory |
| `/model <provider/model>` | Switch models mid-session |
| `/sessions` | List past sessions |
| `/debug` | Toggle debug mode |
| `/thinking <on\|off>` | Toggle thinking visibility |
| `/help` | Show available slash commands |

## Testing

```bash
# Full suite
npm test

# Single file
npx vitest run tests/compiler.test.ts

# Single test by name
npx vitest run -t "should compile prompt with empty state"

# Watch mode (development)
npx vitest
```

Test framework: Vitest. Tests live in `tests/`. Currently 23 tests across 6 files.

**Patterns:**
- Add tests for any new functionality before committing.
- Use in-memory DB (`:memory:`) for memory-layer tests.
- Integration tests for session lifecycle go in `tests/resume.test.ts`.
- State graph unit tests go in `tests/state-graph.test.ts`.

## Code Conventions

- **Language:** TypeScript, strict mode
- **Module system:** NodeNext (`import` with `.js` extensions, e.g. `import { Foo } from "./bar.js"`)
- **Target:** ES2022
- **Formatting:** No Prettier/eslint config yet — keep code clean manually
- **Naming:**
  - Files: `kebab-case.ts`
  - Functions/variables: `camelCase`
  - Types/interfaces: `PascalCase`
  - Private methods: no `_` prefix, use TypeScript `#` private fields if needed
- **Imports:** Prefer named exports. Default exports only for main entry points.
- **Error handling:** Don't swallow errors silently. Log context, then rethrow or return gracefully.
- **Async:** Use `async/await`. No raw `.then()` chains.

## Architecture

For the full architecture deep-dive (state model, session lifecycle, event log, compiler, memory systems, tools), see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). For a glossary of key terms, see [docs/concepts.md](./docs/concepts.md).

Key source tree:

```
src/
  main.ts        — CLI entry point, readline loop, and slash commands
  turn.ts        — Per-turn orchestration (prompt → LLM → tools → banners)
  session.ts     — Session lifecycle (create/resume/end) & memory init
  compiler.ts    — Deterministic prompt assembly with token budgeting & metrics
  state-graph.ts — Tiered state management (active/soft/hard) & keyword auto-hydrate
  event-log.ts   — Append-only JSONL event persistence with fsyncSync durability
  llm.ts         — Provider connection and model building via pi-ai
  config.ts      — Multi-source config loading (JSON/TOML) & deep-merge
  types.ts       — Core shared TypeScript types
  ui.ts          — CLI output formatting, banners, and text colors
  tools/         — Tool definitions (shell, file, memory, knowledge)
  memory/        — SQLite, HashEmbedder, and LLM summarizer logic
```

## Security

- **Secrets:** The state graph stores arbitrary payloads. Avoid storing API keys, tokens, or secrets in state objects — they get logged to the event log.
- **Shell tool:** `shell` commands run with the user's permissions. No sandboxing. Use `timeout` field to prevent runaway processes.
- **Memory DB:** SQLite file at `~/.aria/memory.db` by default. Contains all stored memories in plaintext. No encryption at rest.
- **Provider keys:** Read from environment variables. Never checked into the repo.

## Git Conventions

- **Commits:** Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`)
- **Tags:** Releases follow semver (`v0.2.0`)
- **Branch:** All work on `main` for now
- **Before commit:** Run `npm test` and `npm run build` to verify

## Common Gotchas

- Event log uses `fsyncSync` on every write — affects performance for high-frequency tool calls.
- Memory store uses offline 384-dimensional unit-sphere float32 vectors (`HashEmbedder`) — deterministic but not semantic. Good for approximate dedup, bad for similarity search.
- Config merge order: local `./aria.config.toml` overrides global `~/.aria/config.toml`. Global JSON -> Global TOML -> Local JSON -> Local TOML.
- Session resume replays `context_action` events — if the event log is missing or corrupted, state rebuilds empty.
- `edit_file` tool requires exact unique text match — whitespace-sensitive.
