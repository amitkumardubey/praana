# AGENTS.md — PRAANA

PRAANA is a TypeScript CLI coding agent built around two systems:

- **Adaptive Context** — state objects (tasks, decisions, constraints, notes) are tiered `active` / `soft` / `hard` by idle turn count; a deterministic compiler assembles a token-budgeted context window every turn.
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
bun run test:parallel  # same suite, files across CPU cores (opt-in)
```

Requires **Bun ≥1.4**. Native dependencies are optional (see Architecture). Rust dev profile (`debug = "line-tables-only"`) keeps full test builds ~4 GB; in throwaway worktrees use `CARGO_INCREMENTAL=0` and `cargo clean` once merged.

**Global CLI (`bun link`):** `package.json` exposes `praana` via `bin/praana.js` (registers a package-scoped OpenTUI Solid JSX transform before loading `src/`; stock preload skips `node_modules`, breaking `bun add -g`). Run `bun link` and add `$(bun pm bin -g)` to PATH.

**Standalone binary:** `bun run build:compile` → `dist/praana` (host platform); options `--target bun-linux-x64`, `--outfile …`. Baked `--version`: exact tag `v{package.json version}` on a clean tree → that version; otherwise `{version}-dev.<shortsha>[.dirty]`. Prefer `bin/praana.js` for npm-style installs. Full release/packaging details: docs/ARCHITECTURE.md.

## Running

```bash
bun start                    # start a new session
praana                       # global CLI (after bun link)
praana resume <session_id>   # resume (no id → most recent session for this cwd)
bun start -- resume <session_id>
praana run "fix the failing tests"   # headless one-shot (no TTY — Harbor / CI)
praana upgrade               # install latest GitHub Release (binary + sidecar)
bun start --debug            # save compiled prompts per turn + verbose tool blocks
praana --config /path/to/praana.config.toml
```

## Configuration

Config is deep-merged, later overrides earlier: `~/.praana/praana.config.json` → `~/.praana/config.toml` → `./praana.config.json` → `./praana.config.toml`.

Config tables: `llm`, `memory`, `compiler`, `tiers`, `session`, `consolidation`, `shell`, `edit`, `risk`, `circuit`, `tools`, `native`, `lsp`, `verify`, `skills`, `ui`, `context_engine` (with `distiller` / `scoring` / `pressure`), `project_detection`, `turn`. Keys and defaults: docs/reference.md and `praana.config.example.toml`.

Key env vars: provider API keys (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …); Bedrock via AWS creds (`AWS_ACCESS_KEY_ID` / `AWS_PROFILE` / web identity / container role), `AWS_BEARER_TOKEN_BEDROCK` or stored key, region `llm.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`; `PRAANA_MODEL`, `PRAANA_SUMMARIZER_MODEL`, `PRAANA_NO_UPDATE_CHECK=1`. Debug mode is `--debug` / `/debug`: it saves compiled prompts under `~/.praana/sessions/<session_id>/prompts/` and prints verbose tool blocks.

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

**`/model` resolution order:** native curated catalog (`src/llm/catalog.ts`) → live provider `/models` API via `src/provider-catalog.ts` (6h disk cache) → reject with a toast if still unknown. Syntax `/model [provider] <model-id>` (space-separated provider only); routing prefixes are stripped before API calls; overrides persist to the event log and restore on resume. Ollama accepts any local model name.

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
  compile-classic.ts / compiler.ts — classic compiler; legacy budget-band compiler (tests only)
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

**Rust v2:** `crates/` holds a work-in-progress Rust next-generation core (`praana-core`, `praana-cli`, `praana-natives`, `praana-native-core`, `praana-xtask`). Not user-facing — the TypeScript CLI is what ships today. Specs are private and not in this tree.

**Native addon (`@praana/natives`):** optional cdylib providing tree-sitter `code_*`, `search_code` / `find_files`, and ONNX embeddings. Availability is probed once at session start (`loadNative()`), surfaced in the boot banner and the compiled system frame (so the agent avoids `code_*` when unavailable). Native grep is synchronous — blocks the event loop and cannot be aborted; use `shell rg` outside the project root.

**Harbor / Terminal-Bench** adapter: `harbor_eval/README.md` — installed agent that runs `praana run --incognito` inside the task container.

## Behaviours agents must know

- **Hook pipeline (always-on):** pre-tool-call = plan-mode → validate (missing paths, unread `edit_file`, shell cwd/PATH) → risk confirm (destructive/outward classes; TTY `[y/N]`, headless deny unless in `[risk].allow`) → circuit loop gate (3rd identical mutating tool+args, or 3rd attempt after two errors on the same path/command; reads/tests never gated) → write-path acquire. Post-tool-call = LSP post-edit → verify (opt-in `[verify]`) → enrich → redact → circuit error-count → write-path release.
- Concurrent mutating writes to the same path fail fast — serialize dependent mutations.
- `/plan on` blocks `write_file` / `edit_file` / `batch_*` / `git_commit` / LSP edit tools / branch-creating shell until an approval word (`go`/`execute`/`proceed`/`continue`) or `/plan execute`.
- Repeat-read interceptor: a second read of an unchanged file returns the artifact card (configurable `[tools] block_repeat_reads`); in engine mode use `retrieve_artifact(id)` instead of re-reading.
- Skills: catalog (name + description) injected every turn; `load_skill(skill_id)` fetches the body on demand (engine mode also tracks loads, evicts stale skills, ranks by usefulness).
- Memory scopes: default `user:<sha256>`, `agent:praana`, `context:<sha256_of_cwd>`; project memories carry all three, global `user` + `agent` only; recall enforces AND-scoping.

## Common Gotchas

- `edit_file` requires exact unique text match — whitespace-sensitive; fails on duplicate code blocks or trailing-space differences.
- Event log `fsyncSync` on every write — intentional for durability; affects throughput on fast tool loops.
- After code reviews or multi-issue analysis, call `add_note` immediately — otherwise findings disappear when recent turns truncate.
- Session resume replays `context_action` events to rebuild the state graph; a truncated or corrupted log rebuilds empty state — not an error, just blank state.
- Config merge order is global-first, local-last; `./praana.config.toml` always wins. Array allowlists (`[shell] allowed_paths`, etc.) **append-merge** across layers instead of replacing.
- Embedder dimension matters: switching dims (transformers 384 vs nomic/ollama 768) triggers re-embedding in `openMemoryDb()`; `entries_vec` is a plain BLOB table with cosine kNN in TypeScript — no sqlite-vec. A legacy `vec0` ghost table is kept; new vectors go to `entries_vec_blob`. First ONNX weight download prompts for consent.
- `applyTierManagement()` runs after every turn — objects demote from `touchedTurn` vs `currentTurn`; new state tools must call `stateGraph.setTier()` or the object won't register as touched.
- **bun:sqlite `:memory:` gotcha:** `new Database(":memory:")` creates a real on-disk file named `:memory:` (also for cwd-joined forms like `/project/:memory:`). Always open `:memory:` databases through `openDatabase()` in `src/sqlite.ts`; `new Database(realPath)` with a genuine path is fine.
- **Concurrent DB access:** `openMemoryDb()` and `openContextEngineDb()` set WAL mode plus `busy_timeout` via `applyConcurrencyPragmas()` in `src/sqlite.ts`. Skipping the pragmas makes parallel sessions fail with `SQLITE_BUSY` instead of retrying.
- Shell timeouts kill the process **group** (SIGTERM→SIGKILL) so orphaned children like `find` cannot hang the session. Do not replace with `Bun.spawn` / `Bun.Terminal` unless process-tree cancellation is equivalent; `Bun.Terminal` is reserved for a future interactive PTY shell.

## Docs

- `docs/ARCHITECTURE.md` — detailed internals (turn flow, compiler, tools, memory, hooks, config).
- `docs/concepts.md` — key terms.
- `docs/reference.md` — install options, configuration, commands, limitations for the current release; `website/` builds the Astro docs site from `docs/` + README.
- `praana.config.example.toml` — annotated config with defaults.
- `harbor_eval/README.md` — Harbor / Terminal-Bench adapter.
