# AGENTS.md — PRAANA

PRAANA is a TypeScript CLI coding agent built around two systems:

- **Adaptive Context** — state objects (tasks, decisions, constraints, notes) are tiered `active` / `soft` / `hard` by idle turn count; in engine mode a compiler assembles a token-budgeted context window every turn.
- **Cognitive Memory** — cross-session persistent knowledge (SQLite); at session end an LLM summariser extracts concise learnings, scoped project/global, decaying over time; at session start a ranked digest is injected into the prompt. The compiler consumes the memory digest as one prompt section.

## Public repository

This repository is public. Design specs, implementation plans, owner decisions and amendment logs are kept outside it (a private repository) and must not be added here. Issues/PRs describe what changed and why in technical terms, citing spec sections by name only. Code comments may cite a spec by file name (e.g. `RUST_V2_CONFIG_SPEC.md §5.1`) but the files are not in this tree; set `PRAANA_SPEC_DIR` to their directory to run the spec cross-check test.

## Git Conventions

- **Commits:** conventional commits — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:` (release-please uses these for `CHANGELOG.md`).
- **Changelog:** don't edit `CHANGELOG.md` by hand; release-please opens a version PR from commit history — merge it.
  - **Exception:** curate the release PR's generated section/body once, immediately before merging; any push to `main` regenerates it, so push nothing to `main` until merged. Commit internal Rust v2 work as `chore(rust-v2)` (not `feat(rust-v2)`) so it stays out of the changelog.
- **Tags:** semver (release-please creates tags). **Branch:** `main`.
- **Issue work:** dedicated branch per GitHub issue before code changes (example: `feat/phase1-issue-56`).
- **Before commit:** `bun typecheck && bun test` — both must pass clean.

## Setup & Build

```bash
bun install
bun typecheck    # TypeScript type-check (no emit)
bun dev          # run without build step
bun test         # full suite (tests/)
```

Requires **Bun ≥1.4**.

**Global CLI / standalone:** `bun link` exposes `praana` via `bin/praana.js` (registers a package-scoped OpenTUI Solid JSX transform before loading `src/`; stock preload skips `node_modules`, breaking `bun add -g`); add `$(bun pm bin -g)` to PATH. `bun run build:compile` → `dist/praana` (host platform; `--target` / `--outfile` options); baked `--version`: exact tag `v{package.json version}` on a clean tree → that version, else `{version}-dev.<shortsha>[.dirty]`. Prefer `bin/praana.js` for npm-style installs. Release packaging: docs/reference.md.

**Installers (`install.sh` / `install.ps1` / `scripts/postinstall.js`):** ASCII-only PowerShell; install self-checks under a throwaway `PRAANA_HOME`; `/dev/tty` opened without `O_CREAT`.

## Running

```bash
bun start                    # start a new session
praana                       # global CLI (after bun link)
praana resume <session_id>   # resume (no id → most recent session for this cwd)
praana run "fix the failing tests"   # headless one-shot (no TTY — Harbor / CI)
praana upgrade               # install latest GitHub Release (binary + sidecar)
praana --config /path/to/praana.config.toml
```

## Configuration

Config deep-merge, later overrides earlier: `~/.praana/praana.config.json` → `~/.praana/config.toml` → `./praana.config.json` → `./praana.config.toml`. Only `[shell] allowed_paths` / `[risk] allow` arrays append-merge; other arrays replace.

Config tables: `llm`, `memory`, `compiler`, `tiers`, `session`, `consolidation`, `shell`, `edit`, `risk`, `circuit`, `tools`, `native`, `lsp`, `verify`, `skills`, `ui`, `context_engine`, `project_detection`, `turn`; optional `[providers]` / `[search_code]` tables are validated but have no defaults. Keys and defaults: docs/reference.md and `praana.config.example.toml`.

Key env vars: provider API keys (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …); Bedrock via AWS creds or `AWS_BEARER_TOKEN_BEDROCK` / stored key, region `llm.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`; `PRAANA_MODEL`, `PRAANA_SUMMARIZER_MODEL`, `PRAANA_NO_UPDATE_CHECK=1`. Debug mode (`--debug` / `/debug`) saves compiled prompts under `~/.praana/sessions/<session_id>/prompts/` (plus `scores.jsonl` in engine mode).

## Slash Commands

| Command | Description |
|---|---|
| `/exit` (alias `/quit`) | End session |
| `/sessions` | List past sessions |
| `/clear` | Reset in-session context |
| `/new` | Start a new session |
| `/state` | List state objects/tiers |
| `/stats` | Session + memory stats |
| `/scorecard` | Telemetry scorecard |
| `/events` | Last 20 log entries |
| `/why <unit-id>` | Explain context-unit scoring |
| `/digest` | Show memory digest |
| `/recall <query>` | Search Cognitive Memory manually |
| `/incognito <on\|off>` | Toggle memory persistence |
| `/memory` | Manage Cognitive Memory |
| `/model [provider] <id>` | Switch model (bare `/model` opens selector) |
| `/reasoning <level>` | Set reasoning effort |
| `/thinking <on\|off>` | Toggle reasoning stream |
| `/settings` | View/update settings |
| `/login [provider]` | Add/update a provider credential |
| `/logout [provider]` | Remove credentials |
| `/shell <cmd>` | Run a shell command (also `! <cmd>`) |
| `/plan <on\|off\|execute\|go>` | Toggle plan mode |
| `/debug` | Toggle debug mode |
| `/help` | All commands |

Typing `/` opens the slash palette (fuzzy filter; non-destructive first; Enter runs no-arg commands, Tab/Enter inserts arg-taking ones).

**`/model` resolution order:** native curated catalog (`src/llm/catalog.ts`) → live provider `/models` API via `src/provider-catalog.ts` (6h disk cache) → reject with a toast if still unknown. Syntax `/model [provider] <model-id>` (space-separated provider only); overrides persist to the event log and restore on resume.

## Testing

`bun test` (full suite; `bun run test:parallel` opt-in). Tests live in `tests/`; keep the suite passing before committing and add tests for new logic. In-memory SQLite (`:memory:`) tests must use `openDatabase()` (`src/sqlite.ts`), never raw `new Database(":memory:")`. `bunfig.toml` preloads `tests/helpers/solid-client.ts` under `bun test` (client build of solid-js + Solid JSX transform) so OpenTUI Solid UI tests are reactive. `bunfig.toml` also preloads `tests/helpers/isolated-home.ts`, which points `HOME`/`USERPROFILE`/`PRAANA_HOME` at a per-run temp dir and clears provider credential env vars so the suite never reads or writes your real `~/.praana`; set `PRAANA_TEST_REAL_HOME=1` to opt out for a rare live test.

## Code Conventions

TypeScript strict mode; NodeNext modules — `.js` extensions in imports (`import { Foo } from "./bar.js"`); target ES2022. Named exports preferred (default exports only for entry points). `async/await` throughout — no raw `.then()` chains. Don't swallow errors: log with context, then rethrow or return `{ ok: false, error }`. No Prettier/ESLint config — match surrounding style manually.

## Security

- **Shell tool:** runs arbitrary commands with the user's permissions. Optional sandbox allowlist via `[shell]` (`enabled`, `allowed_paths`); off by default.
- **Event log / recall:** `~/.praana/sessions/<session_id>/events.jsonl`; tool results and logged tool-call args are always-on redacted (`[REDACTED:<kind>]`), user/agent chat is not. `search_session_log` reads this session; `recall` searches cross-session Cognitive Memory only.
- **Memory DB:** `~/.praana/memory.db` — plaintext SQLite, no encryption.
- **Provider keys:** credential store (`~/.praana/credentials.json`, mode 0600) preferred; env vars as fallback. Never hardcode or log. Codex subscription login (`/login openai-codex`) uses browser or device-code flow with a manual paste prompt — `src/oauth-codex.ts`; saves are atomic (`src/credentials.ts`: a corrupt store is copied aside, never replaced before the atomic save) under SQLite-based OS advisory locks (`src/credential-lock.ts`, single-flight refresh). Refresh failures never become assistant messages and a failed credential does not count as a turn.

## Architecture

Full detail: docs/ARCHITECTURE.md. Key terms: docs/concepts.md.

```
src/
  main.ts / app-controller.ts / headless-run.ts — CLI entry, TUI, headless run
  turn.ts / session.ts — per-turn orchestration, lifecycle, memory init
  compile-classic.ts / compiler.ts — classic compiler (full history); legacy budget-band compiler (test-only)
  llm/ — native engine: drivers/ (anthropic, openai, azure, google, bedrock, responses) + resolver/catalog/sse/stream/retry/auth
  llm.ts / provider-registry.ts — provider/model facade + definitions (incl. user-declared)
  model-resolver.ts / model-listing.ts / provider-catalog.ts / bedrock/ — /model resolution; live `/models` catalogs (6h disk cache)
  credentials.ts / credential-lock.ts / user-settings.ts / config.ts / oauth.ts / oauth-codex.ts / oauth-browser.ts — credential store + config deep-merge
  hooks/ + validate/ risk/ circuit/ redact/ verify/ plan-mode.ts — hook registry + always-on hooks
  native/ — lazy loader for `@praana/natives` (npm package or sidecar)
  lsp/ — JSON-RPC LSP client + manager (opt-in `[lsp]`)
  setup/ interactive-setup.ts — wizard; update/ — version check, install-kind, upgrade
  memory/ — MemoryStore, SQLite schema + vectors, embedders, summariser
  context-engine/ — compiler, scoring, checkpoint, distillers, telemetry
  skills/ — skill discovery, load tracking, usefulness stats
  tools/ — registry: system, git, knowledge, memory, search-code, find-files, code-intel, lsp, run-tests + test-runner/
  ui/tui/ — OpenTUI + Solid terminal shell
  event-log.ts / state-graph.ts / state-graph-checkpoint.ts / sqlite.ts — event log, tiered state + resume snapshot, SQLite helpers
```

**Rust v2:** `crates/` holds a work-in-progress Rust next-generation core; not user-facing — the TypeScript CLI is what ships today.

**Native addon (`@praana/natives`):** optional cdylib providing tree-sitter `code_*`, `search_code` / `find_files`, and ONNX embeddings. Probed once at session start (`loadNative()`), surfaced in the boot banner and compiled system frame so the agent avoids `code_*` when unavailable. Native grep is synchronous — blocks the event loop and cannot be aborted; use `shell rg` for huge trees or when you need abort. `search_code` accepts an absolute `path` (shell sandbox is off by default).

## Behaviours agents must know

- `loadAgentsContext()` merges `~/.praana/AGENTS.md`, `<git root>/AGENTS.md`, `<cwd>/AGENTS.md` (if cwd ≠ root), then `CLAUDE.md` only if no project-root `AGENTS.md`; cut at 16,000 chars.
- **Hook pipeline (always-on):** pre-tool-call = plan-mode → validate (missing paths, unread `edit_file`, shell cwd/PATH) → risk confirm (destructive/outward classes; TTY `[y/N]`, headless deny unless in `[risk].allow`) → circuit loop gate (3rd identical mutating tool+args, or 3rd attempt after two errors on the same path/command; reads/tests never gated) → write-path acquire. Post-tool-call = LSP post-edit → verify (opt-in `[verify]`) → enrich → redact → circuit error-count → write-path release.
- Concurrent mutating writes to the same path fail fast — serialize dependent mutations.
- `/plan on` blocks `write_file` / `edit_file` / `batch_*` / `git_commit` / LSP edit tools / branch-creating shell until an approval word (`go`/`execute`/`proceed`/`continue`) or `/plan execute`; user-armed only, and approval words are ignored before deferrals like `continue reading` / `execute a search`.
- Repeat-read interceptor: a second read of an unchanged file returns the artifact card (configurable `[tools] block_repeat_reads`); in engine mode use `retrieve_artifact(id)` instead of re-reading.
- Skills: catalog (name + description) injected every turn, usefulness-ranked in both modes; `load_skill(skill_id)` fetches the body on demand (load tracking + stale eviction are engine mode only).
- Memory scopes: default `user:<prefix>`, `agent:praana`, `context:<prefix>` — 12-char SHA-256 prefixes (`hashString`) of `$USER` / cwd; project memories carry all three, global `user` + `agent` only; recall enforces AND-scoping.
- Responses driver: a function-call argument delta that does not extend a call announced by `output_item.added` ends the stream with a non-retryable error (all Responses providers). `tests/responses-driver.test.ts` compares against `tests/fixtures/openai-responses-main-golden.json` (regenerate with `PRAANA_UPDATE_RESPONSES_GOLDEN=1`).
- TUI (`src/ui/tui/`): Ctrl+C copies the selection (`clipboard.ts`); wizard Esc walks a visited-step history (`src/setup/wizard-nav.ts`); Esc in any OAuth prompt raises `OAuthUserCancelledError` (quiet step back) while other aborts are `AbortError`; mouse selection never steals prompt focus; `/help` and `praana --help` share one help source; exit codes: 0 after successful setup, 1 if setup succeeded but no session started.
- Windows: absolute-path decisions use `resolveAgainstCwd` / `path.isAbsolute` (`src/app-identity.ts`), never `startsWith("/")`; the app logger suppresses stderr while the TUI owns the terminal (`withStderrSuppressed`).

## Common Gotchas

- `edit_file` requires exact unique text match — whitespace-sensitive; fails on duplicate code blocks or trailing-space differences.
- Event log writes `fsyncSync` every event (durability over throughput); legacy `events.log` is renamed/merged into `events.jsonl` on open.
- After code reviews or multi-issue analysis, call `add_note` immediately — otherwise findings disappear when recent turns truncate.
- **bun:sqlite `:memory:` gotcha:** `new Database(":memory:")` creates a real on-disk file named `:memory:`; always go through `openDatabase()` (`src/sqlite.ts`).
- **Concurrent DB access:** `openMemoryDb()` / `openContextEngineDb()` set WAL + `busy_timeout` via `applyConcurrencyPragmas()` (`src/sqlite.ts`); without them parallel sessions fail with `SQLITE_BUSY`.
- Shell timeouts kill the process group (SIGTERM→SIGKILL) so orphaned children cannot hang the session; do not replace with `Bun.spawn`/`Bun.Terminal` unless process-tree cancellation is equivalent.

