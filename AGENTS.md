# AGENTS.md — PRAANA

PRAANA is a TypeScript CLI coding agent built around two systems:

- **Adaptive Context** — state objects (tasks, decisions, constraints, notes) are tiered `active` / `soft` / `hard` by idle turn count; in engine mode a compiler assembles a token-budgeted context window every turn (classic mode appends full history).
- **Cognitive Memory** — cross-session persistent knowledge (SQLite); at session end an LLM summariser extracts concise learnings, scoped project/global, decaying over time; at session start a ranked digest is injected into the prompt. Separate systems: the compiler consumes a memory digest as one prompt section; it does not merge with memory otherwise.

## Public repository

This repository is public. Design specs, implementation plans, owner decisions and amendment logs are kept outside it (a private repository) and must not be added here. Issues and PRs describe what changed and why in technical terms and cite spec sections by name only. Code comments may cite a spec by file name (for example `RUST_V2_CONFIG_SPEC.md §5.1`) but the files are not in this tree; set `PRAANA_SPEC_DIR` to the directory that holds them to run the one test that cross-checks a spec (`defaults_match_normative_toml`).

## Git Conventions

- **Commits:** conventional commits — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:` (release-please uses these for `CHANGELOG.md`).
- **Changelog:** do not edit `CHANGELOG.md` by hand for releases. Release-please opens a version PR from commit history; merge that PR to cut a release.
  - **Exception:** the release PR's generated section and PR body may be curated by hand once, immediately before merging it (for example, collapsing many internal `rust-v2` entries into one line). Any push to `main` regenerates the release PR and discards the edit, so curate last and push nothing to `main` until it is merged. Commit internal Rust v2 work as `chore(rust-v2)`, not `feat(rust-v2)`, so it stays out of the changelog.
- **Tags:** semver — `v0.4.0` (release-please creates tags). **Branch:** `main`.
- **Issue work:** create a dedicated branch for each GitHub issue before making code changes (example: `feat/phase1-issue-56`).
- **Before commit:** `bun typecheck && bun test` — both must pass clean.

## Setup & Build

```bash
bun install
bun typecheck    # TypeScript type-check (no emit)
bun dev          # run without build step
bun test         # full suite (tests/)
```

Requires **Bun ≥1.4**. Native dependencies are optional (see Architecture).

**Global CLI (`bun link`):** `package.json` exposes `praana` via `bin/praana.js` (registers a package-scoped OpenTUI Solid JSX transform before loading `src/`; stock preload skips `node_modules`, breaking `bun add -g`). Run `bun link` and add `$(bun pm bin -g)` to PATH.

**Standalone binary:** `bun run build:compile` → `dist/praana` (host platform); options `--target bun-linux-x64`, `--outfile …`. Baked `--version`: exact tag `v{package.json version}` on a clean tree → that version; otherwise `{version}-dev.<shortsha>[.dirty]`. Prefer `bin/praana.js` for npm-style installs.

## Running

```bash
bun start                    # start a new session
praana                       # global CLI (after bun link)
praana resume <session_id>   # resume (no id → most recent session for this cwd)
bun start -- resume <session_id>
praana run "fix the failing tests"   # headless one-shot (no TTY — Harbor / CI)
praana upgrade               # install latest GitHub Release (binary + sidecar)
bun start --debug            # save compiled prompts per turn
praana --config /path/to/praana.config.toml
```

## Configuration

Config is deep-merged, later overrides earlier: `~/.praana/praana.config.json` → `~/.praana/config.toml` → `./praana.config.json` → `./praana.config.toml`.

Config tables: `llm`, `memory`, `compiler`, `tiers`, `session`, `consolidation`, `shell`, `edit`, `risk`, `circuit`, `tools`, `native`, `lsp`, `verify`, `skills`, `ui`, `context_engine` (with `distiller` / `scoring` / `pressure`), `project_detection`, `turn`; optional `[providers]` / `[search_code]` tables are validated but have no defaults. Keys and defaults: docs/reference.md and `praana.config.example.toml`.

Key env vars: provider API keys (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …); Bedrock via AWS creds (`AWS_ACCESS_KEY_ID` / `AWS_PROFILE` / web identity / container role), `AWS_BEARER_TOKEN_BEDROCK` or stored key, region `llm.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`; `PRAANA_MODEL`, `PRAANA_SUMMARIZER_MODEL`, `PRAANA_NO_UPDATE_CHECK=1`. Debug mode is `--debug` / `/debug`: it saves compiled prompts under `~/.praana/sessions/<session_id>/prompts/` (plus `scores.jsonl` in engine mode).

## Slash Commands

| Command | Description |
|---|---|
| `/exit` (alias `/quit`) | End session (summariser, epilogue, resume id) |
| `/sessions` | List past sessions for this directory |
| `/clear` | Reset in-session context (same ID) |
| `/new` | Start a new session (new ID, reload config) |
| `/state` | List state objects and tiers |
| `/stats` | Session metadata + memory stats |
| `/scorecard` | Per-session telemetry scorecard |
| `/events` | Last 20 event-log entries |
| `/why <unit-id>` | Explain context-unit scoring (engine mode) |
| `/digest` | Show current Cognitive Memory digest |
| `/recall <query>` | Search Cognitive Memory manually |
| `/incognito <on\|off>` | Toggle Cognitive Memory persistence |
| `/memory` | Manage Cognitive Memory (`dedupe` merges near-duplicates) |
| `/model [provider] <id>` | Switch model (bare `/model` opens selector) |
| `/reasoning <level>` | Set reasoning effort (`off\|minimal\|low\|medium\|high\|xhigh`) |
| `/thinking <on\|off>` | Toggle reasoning stream visibility |
| `/settings` | View/update persistent settings (set/reset) |
| `/login [provider]` | Add or update a provider credential |
| `/logout [provider]` | Remove a provider's credentials |
| `/shell <cmd>` | Run a shell command inline (also `! <cmd>`) |
| `/plan <on\|off\|execute\|go>` | Toggle plan mode (blocks mutating tools) |
| `/debug` | Toggle debug mode |
| `/help` | All commands |

Typing `/` opens the slash palette (fuzzy filter; Enter runs no-arg commands, Tab/Enter inserts arg-taking ones).

**`/model` resolution order:** native curated catalog (`src/llm/catalog.ts`) → live provider `/models` API via `src/provider-catalog.ts` (6h disk cache) → reject with a toast if still unknown. Syntax `/model [provider] <model-id>` (space-separated provider only); overrides persist to the event log and restore on resume.

## Testing

Commands as above (`bun test` / `bun run test:parallel`). Tests live in `tests/`; keep the full suite passing before committing and add tests for new logic. In-memory SQLite (`:memory:`) tests must go through `openDatabase()` (`src/sqlite.ts`), never raw `new Database(":memory:")`. Session lifecycle → `tests/resume.test.ts`; state graph → `tests/state-graph.test.ts`; compiler → `tests/compiler.test.ts`, `tests/compile-classic.test.ts`.

## Code Conventions

- **Language:** TypeScript strict mode. **Modules:** NodeNext — use `.js` extensions in imports (`import { Foo } from "./bar.js"`). **Target:** ES2022.
- **Naming:** `kebab-case.ts` files, `camelCase` functions/vars, `PascalCase` types.
- **Exports:** named exports preferred; default exports only for entry points.
- **Errors:** don't swallow silently — log with context, then rethrow or return `{ ok: false, error }`.
- **Async:** `async/await` throughout; no raw `.then()` chains.
- **No Prettier/ESLint config** — keep style consistent with surrounding code manually.

## Security

- **Shell tool:** runs arbitrary commands with the user's permissions. Optional sandbox allowlist via `[shell]` (`enabled`, `allowed_paths`); off by default.
- **Event log:** `~/.praana/sessions/<session_id>/events.jsonl`. Tool results and logged tool-call args run through always-on secret redaction (`[REDACTED:<kind>]`); user/agent chat is not. Do not log API keys or secrets through tools.
- **In-session recall:** use `search_session_log` for earlier turns in the current session; `recall` searches cross-session Cognitive Memory only.
- **Memory DB:** `~/.praana/memory.db` — plaintext SQLite, no encryption at rest.
- **Provider keys:** credential store (`~/.praana/credentials.json`, mode 0600) preferred; env vars as fallback. Never hardcode or log.

## Architecture

Full detail: docs/ARCHITECTURE.md. Key terms: docs/concepts.md.

```
src/
  main.ts / app-controller.ts / headless-run.ts — CLI entry, TUI orchestration, headless run
  turn.ts / session.ts — per-turn orchestration; lifecycle, `loadAgentsContext()`, memory init
  compile-classic.ts / compiler.ts — classic compiler (full history); shared prompt-section builders + legacy budget-band compiler (only `compile()` / `compileWithMetrics()` are test-used)
  llm/ — native LLM engine (no external SDKs): drivers/ (anthropic, openai, azure, google, bedrock, responses), resolver.ts, catalog.ts, sse.ts, stream.ts, retry.ts, auth.ts
  llm.ts / provider-registry.ts — provider/model facade + definitions (incl. user-declared)
  model-resolver.ts / model-listing.ts / provider-catalog.ts / bedrock/ — /model resolution; live `/models` catalogs (6h disk cache)
  credentials.ts / user-settings.ts / config.ts / oauth.ts / oauth-browser.ts — credential store, OAuth PKCE sign-in, UX prefs, config deep-merge
  hooks/ + validate/ risk/ circuit/ redact/ verify/ plan-mode.ts — hook registry + always-on safety hooks
  native/ — lazy loader for `@praana/natives` (npm package, or sidecar next to binary)
  lsp/ — JSON-RPC LSP client + manager (opt-in `[lsp]`)
  setup/ interactive-setup.ts — wizard; update/ — version check, install-kind, upgrade
  memory/ — MemoryStore, SQLite schema + vectors, embedders (ONNX/Ollama), summariser
  context-engine/ — engine compiler, scoring, checkpoint, distillers, telemetry, workflow-tracker
  skills/ — skill discovery, load tracking, usefulness stats
  tools/ — registry: system, git, knowledge (recall/remember), memory, search-code, find-files, code-intel, lsp, run-tests + test-runner/
  ui/tui/ — OpenTUI + Solid terminal shell
  event-log.ts / state-graph.ts / state-graph-checkpoint.ts / sqlite.ts — events.jsonl (fsyncSync), tiered state + resume snapshot, openDatabase()/WAL pragmas
```

**Rust v2:** `crates/` holds a work-in-progress Rust next-generation core (`praana-core`, `praana-cli`, `praana-natives`, `praana-native-core`, `praana-xtask`). Not user-facing — the TypeScript CLI is what ships today.

**Native addon (`@praana/natives`):** optional cdylib providing tree-sitter `code_*`, `search_code` / `find_files`, and ONNX embeddings. Availability is probed once at session start (`loadNative()`), surfaced in the boot banner and the compiled system frame (so the agent avoids `code_*` when unavailable). Native grep is synchronous — blocks the event loop and cannot be aborted; use `shell rg` for huge trees or when you need abort. `search_code` accepts an absolute `path` (shell sandbox is off by default).

**Harbor / Terminal-Bench** adapter: `harbor_eval/README.md` — installed agent that runs `praana run --incognito` inside the task container.

## Behaviours agents must know

- `loadAgentsContext()` merges `~/.praana/AGENTS.md`, `<git root>/AGENTS.md`, `<cwd>/AGENTS.md` (if cwd ≠ root), then `CLAUDE.md` only if no project-root `AGENTS.md`; cut at 16,000 chars (~4,000 tokens).
- **Hook pipeline (always-on):** pre-tool-call = plan-mode → validate (missing paths, unread `edit_file`, shell cwd/PATH) → risk confirm (destructive/outward classes; TTY `[y/N]`, headless deny unless in `[risk].allow`) → circuit loop gate (3rd identical mutating tool+args, or 3rd attempt after two errors on the same path/command; reads/tests never gated) → write-path acquire. Post-tool-call = LSP post-edit → verify (opt-in `[verify]`) → enrich → redact → circuit error-count → write-path release.
- Concurrent mutating writes to the same path fail fast — serialize dependent mutations.
- `/plan on` blocks `write_file` / `edit_file` / `batch_*` / `git_commit` / LSP edit tools / branch-creating shell until an approval word (`go`/`execute`/`proceed`/`continue`) or `/plan execute`; plan mode is user-armed only (no intent detection), and approval words are ignored before deferrals like `continue reading` / `execute a search`.
- Repeat-read interceptor: a second read of an unchanged file returns the artifact card (configurable `[tools] block_repeat_reads`); in engine mode use `retrieve_artifact(id)` instead of re-reading.
- Skills: catalog (name + description) injected every turn, ranked by usefulness in both modes; `load_skill(skill_id)` fetches the body on demand (load tracking + stale eviction are engine mode only).
- Memory scopes: default `user:<prefix>`, `agent:praana`, `context:<prefix>` — 12-char SHA-256 prefixes (`hashString`) of `$USER` / cwd, `agent:praana` literal; project memories carry all three, global `user` + `agent` only; recall enforces AND-scoping.

## Common Gotchas

- `edit_file` requires exact unique text match — whitespace-sensitive; fails on duplicate code blocks or trailing-space differences.
- Event log `fsyncSync` on every write — intentional for durability; affects throughput on fast tool loops. Legacy `events.log` files are renamed or merged into `events.jsonl` on session open.
- After code reviews or multi-issue analysis, call `add_note` immediately — otherwise findings disappear when recent turns truncate.
- Session resume restores the state-graph checkpoint and replays later `context_action` events; a log failing JSON parsing clears the cache, and only a missing checkpoint anchor starts empty (warn, not an error).
- Config merge order is global-first, local-last; `./praana.config.toml` wins unless an explicit `--config` path replaces the chain. Only `[shell] allowed_paths` / `[risk] allow` arrays **append-merge**; other arrays replace.
- Embedder dimension matters: switching dims (transformers 384 vs nomic/ollama 768) triggers re-embedding in `openMemoryDb()`, as does changing `embedding_backend` at the same dimension; `entries_vec` is a plain BLOB table with cosine kNN in TypeScript — no sqlite-vec. `entries_vec_blob` is used only when a leftover sqlite-vec `vec0` table can't be dropped; new installs always use `entries_vec`. First ONNX weight download prompts for consent.
- `applyTierManagement()` demotes idle objects (engine mode only) from `touchedTurn` vs `currentTurn`; `create()`, `update()`, `setTier()`, `retractObject()` all mark an object touched.
- **bun:sqlite `:memory:` gotcha:** `new Database(":memory:")` creates a real on-disk file named `:memory:`. Always open `:memory:` databases through `openDatabase()` in `src/sqlite.ts`; `new Database(realPath)` with a genuine path is fine.
- **Concurrent DB access:** `openMemoryDb()` and `openContextEngineDb()` set WAL mode plus `busy_timeout` via `applyConcurrencyPragmas()` in `src/sqlite.ts`; without them, parallel sessions fail with `SQLITE_BUSY`.
- Shell timeouts kill the process **group** (SIGTERM→SIGKILL) so orphaned children like `find` cannot hang the session. Do not replace with `Bun.spawn` / `Bun.Terminal` unless process-tree cancellation is equivalent; `Bun.Terminal` is reserved for a future interactive PTY shell.

## Docs

- `docs/ARCHITECTURE.md` — detailed internals (turn flow, compiler, tools, memory, hooks, config).
- `docs/concepts.md` — key terms.
- `docs/reference.md` — install options, configuration, commands, limitations for the current release; `website/` builds the Astro docs site from `docs/` (`ARCHITECTURE.md`, `concepts.md`, `reference.md`); `index.astro` is hand-written.
- `praana.config.example.toml` — annotated config with defaults.
