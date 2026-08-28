# AGENTS.md — PRAANA

PRAANA is a TypeScript CLI coding agent built around two systems:

- **Adaptive Context** — within-session working memory. State objects (tasks, decisions, constraints, notes) are tiered: `active` (full detail), `soft` (one-line stub), `hard` (ID only). Tiers are managed automatically based on idle turn count. The deterministic prompt compiler assembles a token-budgeted context window on every turn.

- **Cognitive Memory** — cross-session persistent knowledge. SQLite-backed. At session end, an LLM summariser extracts learnings from the transcript (facts, preferences, decisions, patterns, mistakes, constraints), skipping anything already in the loaded project context (AGENTS.md / README). Each learning is classified as **project-level** (scoped to the working directory) or **global** (applies across all projects) and stored with the appropriate scope set. Memories decay over time. At session start, a ranked digest is injected into the prompt.

These are separate systems. The compiler consumes a memory digest as one of its five sections; it does not merge with memory otherwise.

---

## Setup & Build

```bash
bun install
bun typecheck    # TypeScript type-check (no emit)
bun dev          # Run without build step
bun test         # 177 files, 2095 tests, ~15s
bun run test:parallel  # opt-in: bun test --parallel tests/
```

Requires **Bun ≥1.4**. Native dependencies are optional (see Embedder Config and Native Addon below).

---

### Global CLI (`bun link`)

`package.json` exposes `praana` via `bin/praana.js` (registers a **package-scoped** OpenTUI Solid JSX transform before loading `src/` — stock `@opentui/solid/preload` skips `node_modules`, which breaks `bun add -g`). Run `bun link` and add `$(bun pm bin -g)` to your PATH.

### Standalone binary (`bun run build:compile`)

For a single-file executable (no Bun install required on the target machine beyond what the binary embeds):

```bash
bun run build:compile                 # → dist/praana (host platform)
bun run build:compile -- --target bun-linux-x64
bun run build:compile -- --outfile dist/praana-macos --target bun-darwin-arm64
```

Uses `@opentui/solid/bun-plugin` and sets `compile.autoloadBunfig = false` so launching from this repo (or any cwd with an OpenTUI `bunfig.toml` preload) does not fail with `preload not found`. Output lands in `dist/` (gitignored). Prefer `bin/praana.js` for `bun add -g` / npm-style installs.

Baked `--version` string: exact git tag `v{package.json version}` with a clean tree → that version (e.g. `0.12.0`); otherwise `{version}-dev.<shortsha>[.dirty]` so branch builds are not mistaken for a release.

Release CI (`release-please.yml`) compiles five targets (linux x64/arm64, darwin arm64/x64 on matching runners, windows-x64 on `windows-latest`; darwin-x64 and windows-x64 use **native** host compiles without `--target`), packs `praana-<os>-<arch>.tar.gz` or `praana-windows-x64.zip` + `SHA256SUMS` via `bun run package:binaries --allow-missing` (each archive is the platform executable plus `praana-natives.node`; skips any target whose binary did not build), and uploads them to the GitHub Release. `loadNative()` tries `@praana/natives` first, then `praana-natives.node` next to `process.execPath`. Standalone install (no Bun): `install.sh` → `~/.local/bin` on Linux/macOS; `install.ps1` → `%USERPROFILE%\.local\bin` on Windows (PowerShell; cmd users invoke via `powershell -Command "irm … | iex"`).

## Running

```bash
# Start a new session
bun start

# Global CLI (after bun link)
praana
praana resume <session_id>

# Resume a previous session
bun start -- resume <session_id>

# Headless one-shot (no TTY — Harbor / CI / scripts)
praana run "fix the failing tests"
praana run --prompt "install deps" --max-steps 40

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
- Amazon Bedrock: AWS credentials (`AWS_ACCESS_KEY_ID` / `AWS_PROFILE` / web identity / container role), or `AWS_BEARER_TOKEN_BEDROCK` / a Bedrock API key stored via `/login`. Optional `llm.region` (else `AWS_REGION` / `AWS_DEFAULT_REGION` / `us-east-1`).
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
- `auto` — uses Transformers.js (`@huggingface/transformers`, shipped as a dependency). Model weights download on first run to `~/.praana/models/` after a one-time consent prompt.
- `transformers` — in-process ONNX via `@huggingface/transformers` (Xenova/all-MiniLM-L6-v2, 384-dim). Models cache in `~/.praana/models/`.
- `transformers-nomic` — 768-dim variant (Xenova/nomic-embed-text-v1) for higher-quality recall.
- `ollama` — opt-in; requires running Ollama daemon. Run `ollama pull nomic-embed-text` first.

When no semantic embedder is available, recall uses **keyword-only search** (FTS) — never fake vectors.

When adding embedder support, implement the `Embedder` interface in `src/memory/types.ts`. The interface has two fields: `dim: number` and `embed(text: string): Promise<Float32Array>`.

### Native Addon (`@praana/natives`)

Tree-sitter code intel (`code_*` tools) loads the optional napi addon. Configure in `[native]`:

```toml
[native]
enabled = true   # false = never load addon; code_* tools return unavailable
require = false  # reserved; Phase 1 never aborts session start on missing addon
```

Availability is probed once at session start via `loadNative()` and surfaced in the boot banner (`native: available (0.x.y)` / `disabled via config` / `unavailable: reason`), `/stats`, `praana doctor`, and the compiled system frame (`## Native Addon` section when unavailable so the agent avoids `code_*` and prefers `search_code` or `find_files`).

`praana` depends on `@praana/natives` via `optionalDependencies` (lockstep npm version). Release CI builds platform `.node` leaves (`linux-x64-gnu/musl`, `linux-arm64-gnu`, `darwin-arm64/x64`, `win32-x64-msvc`) and publishes leaves, then `@praana/natives`, then `praana`. Users do not need a Rust toolchain. **Prerequisite:** npm org `praana` must exist so `NPM_TOKEN` can publish `@praana/*`; the first release 404s without it.

Standalone GitHub Release archives include a matching `praana-natives.node` sidecar (glibc linux-arm64 included). The loader dlopens it from `dirname(process.execPath)` when the npm package is absent. Do not move the `.node` away from the binary.

### fff — In-Process File Search (`@ff-labs/fff-bun`)

`search_code` and `find_files` are powered by fff, an in-process file search index (native Rust library via Bun FFI — **not** pure JS). The `FileFinder` is created lazily per `cwd` and shared between both tools. The initial scan runs in the background; the first search waits up to `[search_code] scan_timeout_ms` (default 5000).

**Standalone binaries:** the platform `libfff_c` native library must be **embedded at compile time** via `src/fff-embed.ts` (static `type: "file"` import on the `main.ts` chain). `scripts/compile.ts` asserts the matching `@ff-labs/fff-bin-*` package is present, passes `FFF_LIBC` on Linux (`gnu` default), and smoke-tests `praana doctor` from `/tmp` (no `node_modules` fallback). Unlike `@praana/natives`, fff does **not** ship as a sidecar.

fff availability is probed at session start and surfaced in the boot banner (`search: available` / `search: unavailable`), `/stats`, and `praana doctor` (operational create probe, not dlopen-only).

**Known tradeoff:** fff's `grep()` is synchronous — it blocks the event loop while searching. An `AbortSignal` cannot interrupt a running grep. For very large codebases, this may cause brief TUI freezes. Use `shell rg` for searching outside the project root or when interactive abort is needed.</think>

### LSP (`[lsp]`, issue #11 Phases 2–4)

Opt-in Language Server Protocol client for diagnostics and formatting. Speaks
JSON-RPC over stdio. Disabled by default (`enabled = false`).

When enabled, language servers for TypeScript, JavaScript, Python, Go, Rust,
JSON, YAML, TOML, and HTML/CSS **activate automatically without manual configuration**. If a server
is not present on the system `PATH`, it is automatically downloaded and cached in
`~/.praana/lsp/` (zero-config, OpenCode style; `auto_install = true` by default).
Custom server overrides in `[lsp.servers]` always take precedence.

```toml
[lsp]
enabled = false
diagnostics = true
format_on_edit = false # opt-in post-edit formatting for edit_file / batch_edit
timeout_ms = 5000
max_file_lines = 10000
auto_install = true    # auto-download missing default servers into ~/.praana/lsp

[lsp.servers]
# Optional overrides (defaults to auto-detection from built-in registry):
# typescript = ["typescript-language-server", "--stdio"]
# python = ["pyright-langserver", "--stdio"]
```

Tools: `lsp_diagnostics(path)`, `lsp_format(path)`, `lsp_hover(path, line, col)`,
`lsp_completions(path, line, col)`, `lsp_definition(path, line, col)`,
`lsp_references(path, line, col)`, `lsp_code_actions(path, range)`,
`lsp_apply_code_action(id)`. Soft-fail when disabled or the server is missing.
A dead language-server process is respawned (max 3 restarts per root, backoff
1s/2s/4s). Files in JS workspace packages or nested git repos get their own
server instance (cap 8, LRU). `javascript` shares the `typescript` server when
no `javascript` entry is set.

Tree-sitter `code_*` stays the fast in-project name path. Use `lsp_definition` /
`lsp_references` when you need types, stdlib, or node_modules. Completions are
labels only (cap 20) — insert via `edit_file`. Apply is text edits only.

### Post-edit verification (`[verify]`, issue #299)

Opt-in checks after a successful `write_file` / `edit_file` / `batch_write` /
`batch_edit`. No new agent tools — results hang off the existing tool result as
`verify` (alongside the optional `lsp` key). Disabled by default. Never runs
for `lsp_format` / `lsp_apply_code_action`. Soft-fail: missing native addon,
no `tsconfig`, no affected tests, or runner timeout never flips the edit’s
`ok: true`. Syntax or typecheck errors skip tests (`tests.skipped = "errors_present"`).

```toml
[verify]
enabled = false
syntax = true
typecheck = true
tests = true
timeout_ms = 30000
max_test_files = 20
```

Pipeline: tree-sitter `parseFile` → scoped `tsc --noEmit` (nearest `tsconfig.json`
toward the session root) → reverse-import affected `*.test.*` / `*.spec.*` via
`bun test`. Unchanged file hash → `verify.cached = true`. More than
`max_test_files` → `tests.skipped = "too_many"` (lists the first N paths).

### Tool pre-validation (issue #300)

Always-on `pre_tool_call` / `post_tool_call` hooks. No config key, no new tools,
never rewrite args. Missing `read_file` / `edit_file` paths block with up to 5
fuzzy `suggestions` (`git ls-files` + session reads). `edit_file` of an existing
file that was not read this session hard-blocks (`Read the file first`). `shell`
blocks a missing `cwd` or a first token that is not a builtin and not on PATH.
Failed path-bearing tools may get `suggestions` and `recent_writes`. Validate
runs after plan-mode and before risk confirm and write-path acquire so a block
cannot leak a lock.

### Risk-tiered action gating (issue #303)

Always-on `pre_tool_call` confirm for destructive / outward actions. Never
rewrites args. Workspace writes inside cwd are free. Confirm-tier classes:
`rm`, `git_reset`, `git_force_push`, `git_clean`, `gh_issue_close`,
`gh_pr_merge`, `package_install`, `write_outside_cwd`. TTY: inline `[y/N]`.
Headless: deny unless the class is in `[risk].allow` (default `[]`,
append-merge). Hook order: plan → validate → **risk** → write-path acquire.

```toml
[risk]
allow = []  # headless-only; does not skip TTY confirm
```

### Secret redaction (issue #302)

Always-on. No `[redact]` config, no new tools, never flips `ok` / `isError`.
A `post_tool_call` handler walks tool results after enrich and replaces known
secret patterns with `[REDACTED:<kind>]`. The same walker runs on a **copy** of
tool-call args for `events.jsonl` `tool_call`, the TUI pending row, and the
turn recorder. `execute` / `pre.args` stay original. Kinds: `aws-access-key`,
`github-token`, `gitlab-token`, `openai-key`, `anthropic-key`, `private-key`,
`key-assignment` (hex SHA 40/64 and Crockford ULID 26 skipped). User/agent chat
is not redacted. Hook order (post): LSP → verify → enrich → **redact** →
circuit → write-path release.

### Circuit breakers (issue #301)

Always-on loop gate for **mutating** tools. Allow 2, block the 3rd identical
tool+args, or the 3rd attempt after two errors on the same path/command.
Reads, read-equivalent `shell`, and test commands (`isTestCommand`, including
`bun test`) are never gated. First block writes a constraint plus
`circuitNotes` (classic and engine). Headless `[circuit] max_tokens` /
`max_wall_ms` (`0` = off) skip the pending batch and run one no-tool wrap-up.
TTY ignores token/time caps. `--max-steps` is unchanged. No cheaper-model hop.
Hook order (pre): plan → validate → risk → **circuit** → write-path.

```toml
[circuit]
loop_threshold = 3
max_tokens = 0
max_wall_ms = 0
```

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
| `/exit` | End session cleanly (triggers summariser, prints honest epilogue + 12-char resume id) |
| `/state` | List state objects and tiers, or show empty-state guidance |
| `/stats` | Session metadata + working-memory + Cognitive Memory stats |
| `/scorecard` | Per-session telemetry scorecard (numeric signals only; issue #99) |
| `/digest` | Show current Cognitive Memory digest |
| `/events` | Show last 20 events in the event log |
| `/recall <query>` | Search Cognitive Memory manually |
| `/model [provider] <id>` | Switch model (bare `/model` opens searchable selector) |
| `/reasoning <level>` | Set reasoning effort (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`); also `llm.reasoning_effort` in config |
| `/sessions` | List past sessions for resuming |
| `/login [provider]` | Add or update a provider credential in `~/.praana/credentials.json` |
| `/logout [provider]` | Remove a provider's credentials; falls back to another authenticated provider or opens login |
| `/shell <cmd>` | Run a shell command inline in the transcript (also `! <cmd>` prefix) |
| `/plan <on\|off\|execute>` | Toggle plan mode: block mutating tools until you approve |
| `/debug` | Toggle debug mode |
| `/thinking <on\|off>` | Toggle LLM reasoning stream visibility |
| `/incognito <on\|off>` | Toggle Cognitive Memory persistence |
| `/settings` | View persistent settings (`model`, `provider`, `thinking`, `incognito`, `debug`, `theme`); `/settings set <key> <value>` / `/settings reset` |
| `/clear` | Reset in-session context (same session ID; clears working memory + model-visible history via a `reset_boundary` event) |
| `/new` | Start a new session (new ID, reload config, background summarizer) |
| `/why <id>` | Explain context-unit scoring (engine mode, debug) |
| `/help` | All commands |

Typing `/` in the TUI opens the slash command palette (centered list + detail pane; fuzzy filter; Enter runs no-arg commands, Tab/Enter inserts arg-taking ones). Path completion stays inline.

**`/model` resolution order:** pi-ai static catalog → live provider `/models` API (6h cache) → reject with toast if still unknown. Parse as `/model [provider] <model-id>` (space-separated provider only). Strip routing prefixes like `openrouter/` or `opencode/` before API calls. Persist `modelOverride` and `providerOverride` to the event log; restore both on resume. Ollama accepts any local model name without a catalog hit.

---

## Testing

```bash
bun test                                              # Full suite
bun run test:parallel                                 # Same suite, files across CPU cores (opt-in)
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
  main.ts        — CLI entry: TTY guard, slash commands, OpenTUI launch, headless `run` dispatch
  headless-run.ts — Non-TTY one-shot runner (`praana run`) for Harbor / CI
  headless-usage.ts — Export turn usage into Harbor AgentContext
  turn.ts        — Per-turn orchestration: prompt → LLM → concurrent tools → tier management
  session.ts     — Session lifecycle (create/resume/end), embedder selection, memory init
  compile-classic.ts — Classic-mode compiler (full verbatim history, no truncation)
  compiler.ts    — Legacy budget-band compiler (unit tests only)
  state-graph.ts — Tiered state (active/soft/hard), auto-demotion, two-pass auto-hydrate (substring + BM25)
  state-graph-checkpoint.ts — O(1) resume: persist/restore StateGraph snapshot after each turn
  event-log.ts   — Append-only events.jsonl, fsyncSync durability; in-memory parse cache
  token-estimate.ts — Canonical Unicode-aware token heuristic (Latin/CJK/emoji/ZWJ)
  context-pressure.ts — Density-weighted effective-token accounting and raw-token safety net
  cosine-similarity.ts — Cosine similarity for embedding vectors (context scoring + memory dedup)
  hash.ts        — Shared SHA-256 hashing utility (session scopes, skill scope keys)
  llm.ts         — Provider registry, model building via pi-ai
  credentials.ts — Credential store (`~/.praana/credentials.json`); key resolution order
  user-settings.ts — Persistent UX prefs (`~/.praana/settings.json`) applied as session defaults
  provider-catalog.ts — Live model catalogs (HTTP `/models` + Bedrock control plane); 6h disk cache
  bedrock/       — Amazon Bedrock region, credentials, live chat-model catalog helpers
  config.ts      — Multi-source JSON/TOML config loading, deep-merge (allowlists append-merge)
  plan-mode.ts   — Plan-mode helpers (`/plan on` gate); runtime gate is a pre_tool_call hook
  hooks/         — Internal turn-loop hook registry (pre/post tool-call, pre_compile, post_turn, session lifecycle; plan → validate → risk → circuit → write-path; LSP post-edit → verify → enrich → redact → circuit → write-path release)
  validate/      — Always-on pre-validation + error enrichment (issue #300; fuzzy path suggestions, unread edit_file, shell PATH)
  risk/          — #303 classify + confirm lock (pre_tool_call after validate)
  circuit/       — #301 loop gate + headless token/time wrap-up
  redact/        — #302 secret detectors (post_tool_call results + logged tool_call args)
  verify/        — Post-edit syntax / scoped tsc / reverse-import test-impact (issue #299; opt-in `[verify]`)
  interactive-setup.ts — Dispatches TTY OpenTUI setup wizard vs readline fallback
  setup/         — Modular setup: types, provider-options, config-writer, logic, setup-readline
  types.ts       — Shared TypeScript types
  ui/
    tui/           — OpenTUI + Solid terminal shell (Prompt, transcript, chrome, overlays, setup, consent, login)

  skills/
    index.ts          — SkillRuntime: discovery, load tracking, telemetry (engine mode only)
    skill-stats-store.ts — Cross-session skill effectiveness: boost/decay usefulness scores, flush to memory.db skill_stats table; dual-scope read mirrors memory recall
    types.ts          — Skill metadata, runtime state, telemetry types
  tools/
    index.ts     — Tool registry
    memory.ts    — Adaptive Context tools (create_task, decide, add_constraint, search_session_log, etc.)
    knowledge.ts — Cognitive Memory tools (recall, remember)
    system.ts    — System tools (shell, read_file, write_file, edit_file)
    search-code.ts — search_code: fff-backed structured code search (in-process grep → file:line:column matches with context, globs, max_results)
    find-files.ts — find_files: fuzzy file path search powered by fff (typo-resistant fuzzy or pure glob mode; returns file paths with git status)
    git.ts — git_status / git_diff / git_commit: structured git tools (issue #26; first #195 harness ship)
    run-tests.ts — run_tests: structured test runner with multi-language adapter dispatch (issue #321)
    test-runner/ — language-specific adapters (bun, npm/pnpm/yarn, go, cargo, pytest, generic)
    code-intel.ts — code_parse / code_imports / code_symbols / code_definition / code_references (tree-sitter via @praana/natives; TS/JS/Python/Go/Rust; issue #11 Phase 1)
    lsp.ts — lsp_diagnostics / lsp_format / hover / completions / definition / references / code actions (issue #11 Phases 2–4)
    git-context.ts — shared getGitContext / findGitRoot helpers
    native/ — lazy loader for @praana/natives (napi-rs); soft-fail when addon missing
    lsp/ — JSON-RPC LSP client + manager (stdio; crash restart + multi-root; soft-fail when disabled)
  memory/
    store.ts     — MemoryStore: remember, recall, digest, session lifecycle; project/global learning scope
    db.ts        — SQLite schema, CRUD, vector search; skill_stats + skill_cooccurrence tables
    embeddings.ts — OllamaEmbedder
    transformers-embedder.ts — Transformers.js in-process semantic embedder
    transformers-models.ts — Model presets (MiniLM, nomic)
    summarizer.ts — extractLearnings: transcript → concise key-point learnings via LLM (skips AGENTS.md/README)
    normalize-learning.ts — Normalize LLM learning content into scannable key points
    types.ts     — Memory-specific types
  context-engine/
    embedding-cache.ts  — Per-turn embedding cache: precomputes vectors for all context units concurrently; invalidated when unit set changes
    workflow-tracker.ts — Workflow pattern tracking: records tool sequences + artifact types per task type; persists to workflow_patterns table; renderWorkflowContext() injects a compact section before checkpoint
    (+ existing engine files: scoring.ts, engine-compiler.ts, db.ts, checkpoint.ts, telemetry.ts, …)
```

Harbor / Terminal-Bench adapter: [`harbor_eval/`](./harbor_eval/README.md) — installed agent that runs `praana run --incognito` inside the task container.
### Skills (issues #96, #77, #92)

**Pull model — engine & classic modes share a tiny catalog.** `discoverSkills()` scans project and user paths (`.agents/skills`, `.praana/skills`, `.cursor/skills`, `skills/`, plus user-level equivalents) and builds a lightweight `SkillRecord[]` catalog. Each `SkillRecord` carries a `scope` field (`context:<hash(gitRoot)>` for project skills, `""` for global). The catalog is rendered into the prompt via `buildSkillMetadataCatalog()` in both modes: a list of `- **name**: description` lines with a `Load a skill with load_skill(skill_id)` header. **Catalog order is sorted descending by usefulness score** when a usefulness map is available; falls back to discovery order. No full bodies, no file paths, no residency tiers.

**Engine mode** additionally creates a `SkillRuntime` for load tracking + eviction:
- The `load_skill(skill_id)` tool looks up the skill by name, reads `SKILL.md` from disk, and returns the body. It calls `SkillRuntime.trackLoad()` to record the load and enforce the `max_loaded_skills` budget (oldest-by-turn evicted).
- At each turn end, `cleanupStaleSkills(currentTurn)` evicts skills idle longer than `stale_threshold_turns`.
- Telemetry events (`skill_loaded`, `skill_reloaded`, `skill_evicted`) are drained per turn via `flushSkillTelemetry()` to the event log. Session-end summary (under `measurement_mode`) prints: `catalog=N loaded=M reloaded=R evicted=E under_load=U`.

**Classic mode** has no `SkillRuntime` — `load_skill` reads the body, no tracking, no eviction. Plain agent behavior (like pi/omp/opencode). When `measurement_mode=true`, classic sessions still record skill load/reload/token counters via `ScorecardTracker.trackSkillLoad()`.

**Skill effectiveness feedback loop** (`src/skills/skill-stats-store.ts`): At session start, `SkillStatsStore.loadUsefulness()` reads `skill_stats(skill_id, scope, usefulness, load_count, used_count)` from `memory.db` using dual-scope lookup (global first, project overrides). At session end (engine mode only), `flush()` applies a confidence-style boost (α=0.15) when a skill was used alongside non-load-skill tool calls, decay (β=0.05) when loaded but idle, or no change when never loaded. Co-occurrence pairs are recorded in `skill_cooccurrence(scope, skill_a, skill_b, count)` for future ranking (data-collection only; consumer in #161). The `scope` isolation prevents cross-project bleed — project skill scores are scoped to `context:<hash(gitRoot)>`.

Config `[skills]` keys: `enabled`, `max_token_budget_ratio` (section trim ceiling), `max_loaded_skills`, `stale_threshold_turns`, `max_depth`. Resume re-discovers skills; loaded state does **not** persist across sessions.

### Telemetry scorecard (issue #99)

**Local-only numeric signals** for comparing engine vs classic and before/after changes. Rows live in the context-engine SQLite `scorecard` table (one row per session). No prompts, file contents, or paths are stored — only counts, averages, path digests, and skill catalog ids for resume deduplication.

- **Active when:** `context_engine.enabled=true` (always persists) **or** `measurement_mode=true` (classic/debug — scorecard-only DB, no full engine).
- **Signals:** context (`retrieve_artifact`, repeat reads, turn-event searches, pressure/compaction), memory (recall calls, recall-used %, project-scoped validity/usefulness deltas), skills (unique loads, load events, reloads, underloads, token cost), churn (duplicate file access across read_file/shell/retrieve, artifact retrieval retries, churn interventions — issue #294), circuit (`circuitLoopBlocks`, `circuitBudgetWrapups` — issue #301).
- **Resume:** counters + memory start averages + read-path digests + skill ids restored from DB; `persistProgress()` after each turn.
- **Query:** `/scorecard` in-session; SQL against the context DB for cross-session A/B (#17).

### Workflow pattern tracking (issue #92)

At session end, the context engine records which tools were called and which artifact types were produced for the session's classified task type. These patterns survive to `workflow_patterns(task_type, tool_sequence, artifact_types, hit_count, last_seen_at)` in the context-engine DB (30-day expiry pruned on shutdown). At compile time, `renderWorkflowContext()` selects matching patterns by task type and injects a compact **Workflow Context** section just before the session checkpoint — giving the engine a prior over what context items will be needed before the session starts. Patterns are filtered by the current task type classification, so a coding session does not pollute a debugging session's prompt.

### Plan mode (issue #221) and risk gating (issue #303)

`/plan on` is **user-armed only** — there is no Plan-Before-Execute system-frame
rule and no intent auto-detection. `Session.planMode` is the source of truth
(`src/plan-mode.ts`); a `pre_tool_call` hook blocks the existing mutation set
until `/plan execute` or an approval word (`go` / `execute` / `proceed` /
`continue`, with the same deferral-phrase exceptions).

- `/plan <on|off|execute>` toggles the gate. Bare `/plan` prints current state.
- While armed, **mutating tools are blocked** (`write_file`, `edit_file`,
  `batch_*`, `git_commit`, `lsp_format`, `lsp_apply_code_action`, branch-creating
  shell). Read-only tools stay allowed.
- Plan mode persists via a `system_note` event replayed by `Session.resume`.
- Destructive actions plan mode does **not** cover (`rm`, force-push,
  `gh issue close` / `gh pr merge`, package installs, writes outside cwd) still
  hit the always-on risk confirm hook.
- **Headless:** `praana run` / Harbor sets `Session.headless = true`. Confirm-tier
  actions fail closed unless the class is in `[risk].allow`. Explicit `/plan on`
  is TTY-only.

### Repeat-read interceptor (issue #219)

`read_file` (and `read_and_summarize`) calls are intercepted within a session. A second read of an unchanged file returns the existing artifact card and skips the disk read. Behaviour is configurable:

```toml
[tools]
block_repeat_reads = false   # false = warn and return artifact card (default); true = hard-block repeat read_file of unchanged files
```

The read index is rebuilt on resume and invalidated on any write/edit, so post-edit reads stay allowed; re-reads are also permitted when the file's disk mtime changes. In engine mode the compiled prompt includes a **"Files Read This Session"** index (`path → artifact_id`) so the agent can use `retrieve_artifact(id)` instead of re-reading. When the scorecard counts more than `REPEAT_FILE_READS_THRESHOLD` repeat reads in a session, the count surfaces in the turn footer as a nudge.

### Read / retrieve churn detection (issue #294)

Cross-channel path access (read_file, read-equivalent shell commands, retrieve_artifact of file-read artifacts) is counted in the scorecard. At `CHURN_PATH_THRESHOLD` (3) accesses of the same path, a soft recovery `warning` is attached to the tool result and `churnInterventions` increments once per path. Identical `retrieve_artifact` calls (same id + filters) return a deterministic artifact card instead of re-emitting the full payload (`artifactRetrievalRetries`). Read-equivalent shell commands (`cat`/`head`/`tail`/`less`/`more`/`bat`/`sed -n`/`rg`/`grep`) are instrumented for telemetry only — never blocked. Parser: `src/tools/shell-read-detect.ts`. Helpers: `src/tools/read-churn.ts`. Post-edit `clearReadPath` resets the repeat-read index only; session churn counts still accumulate.

### Resume hardening (issues #185, #220)

- `praana resume` with no session id resolves the most recent session for the **current cwd**; if none exists it prints a short notice and starts a fresh session instead of exiting.
- On resume, a **stale-task banner** lists tasks/decisions left open in the previous session, and a **scope confirmation** step re-confirms the Cognitive Memory scopes (project vs global) before the session continues.

### Scorecard nudges and agent hints (issues #223, #224)

Beyond the `/scorecard` table, the telemetry loop feeds back into the live session:
- **Turn-footer nudges** surface when repeat reads pile up, no-op tool calls recur, recall hit-rate is low, or read/retrieve churn fires — prompting adjustment.
- **Engine-mode agent hints** are injected into the system frame when the repeat-read count crosses its threshold or recall-used % is low, steering the agent toward artifact-first reads and explicit correction capture. The repeat-read threshold is a single exported constant (`REPEAT_FILE_READS_THRESHOLD` in `compiler.ts`) shared by the engine hint and the TUI footer nudge.

### End-of-session epilogue (issue #181)

`/exit` (and natural shutdown) prints a single honest epilogue instead of a misleading consolidation header, returns snapshotted memory stats from shutdown, and prints a **12-char resume id** that uniquely identifies the session for `praana resume <id>`.

### Agent policy (shared, issue #228)

Engine and classic modes share one mode-neutral agent policy injected into the system frame: instruction precedence, treating tool output as untrusted data, evidence-first assertions, tool-safety guidance, and concise tool-use norms. The prose tool-schema list was removed from the system prompt — the structured tool definitions passed to the provider remain the authoritative interface. Adaptive Context instructions stay engine-only.

### Turn flow (per turn)

Compile mode is selected in `turn.ts`: engine when `context_engine.enabled=true` **and** `session.contextEngine` is initialized; otherwise classic.

**Engine mode:**

```
User input
  → auto-hydrate matching peripheral state (two-pass: substring keyword + BM25 relevance)
  → fetch all workflow patterns; classify task type
  → pre_compile hooks
  → compileEngineWithMetrics: system frame | skills catalog (usefulness-ranked) | workflow context (task-type-filtered) | checkpoint | verbatim turns | scored context (BM25 + semantic embeddings) | active state | memory digest
  → stream LLM response with tool calls
  → pre_tool_call hooks (plan-mode + validate + risk + circuit + write-path) then concurrent execute, then post_tool_call
  → log all events (tool_call, tool_result, agent_message)
  → extract TurnDigest (deterministic) + reconcile SessionCheckpoint
  → increment turn count, run applyTierManagement() + cleanupStaleSkills()
  → markResidentSkillsUsed() if non-load-skill tools ran
  → persist scorecard progress
  → post_turn hooks
  → print memory banner
```

**Classic mode:**

```
User input
  → pre_compile hooks
  → compileClassicWithMetrics: system frame | skills catalog | memory digest | full verbatim history
  → stream LLM response (shared + system + memory tools only)
  → pre_tool_call hooks (plan-mode + validate + risk + circuit + write-path) then concurrent execute, then post_tool_call
  → log all events
  → increment turn count (no tier management, no skill tracking)
  → post_turn hooks
  → print memory banner
```

### Memory scopes

Default scopes set at session start: `user:<sha256>`, `agent:praana`, `context:<sha256_of_cwd>`.

- **Project-level** memories carry all three scopes — only visible from that project directory.
- **Global** memories carry only `user` and `agent` scopes — visible in all project sessions.

The session-end summarizer extracts **concise key-point** learnings (one short sentence each), skips content already present in loaded project context (AGENTS.md / README), and classifies each learning as `project` or `global`. `project` learnings are written with the full default scopes (including `context:`); `global` learnings are written without the `context:` scope so they remain visible across projects. Explicit `remember(scope=[...])` calls still override this when a scope is provided.

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
- **Event log:** `~/.praana/sessions/<session_id>/events.jsonl`. Tool results and logged tool-call args run through always-on secret redaction (#302); user/agent chat is not. Do not log API keys or secrets through tools.
- **In-session recall:** Use `search_session_log` for earlier turns in the current session. `recall` searches cross-session Cognitive Memory only.
- **Memory DB:** `~/.praana/memory.db` — plaintext SQLite. No encryption at rest.
- **Provider keys:** Credential store (`~/.praana/credentials.json`) preferred; env vars as fallback. Never hardcode or log.

---

## Common Gotchas

- `edit_file` requires exact unique text match — whitespace-sensitive. Will fail on duplicate code blocks or trailing whitespace differences.
- Parallel tool calls are allowed, but concurrent `write_file` / `edit_file` / `batch_*` targeting the **same path** fail with a write-path `pre_tool_call` hook error — serialize dependent mutations.
- Event log `fsyncSync` on every write — intentional for durability, affects throughput on fast tool loops.
- Session log path is `events.jsonl` under `~/.praana/sessions/<session_id>/`. Legacy `events.log` files are migrated automatically on session open.
- After code reviews or multi-issue analysis, call `add_note` immediately — otherwise findings disappear when recent turns truncate.
- Session resume replays `context_action` events to rebuild state graph. If the log is truncated or corrupted, state rebuilds empty — not an error, just blank state.
- Config merge order is global-first, local-last. A `./praana.config.toml` always wins over `~/.praana/config.toml`. Array allowlists (`[shell] allowed_paths`, etc.) **append-merge** across layers instead of replacing.
- The embedder dimension matters for the vector table schema. Switching between backends with different dims (e.g. transformers 384-dim → ollama/transformers-nomic 768-dim) triggers re-embedding in `openMemoryDb()`. Backend changes at the same dimension also trigger re-embed via `embedding_backend` tracking in `memory_meta`. First Transformers.js download prompts for consent (#187).
- `applyTierManagement()` in `turn.ts` runs after every turn — objects demote based on `touchedTurn` vs `currentTurn`. If you add a new state tool, call `stateGraph.setTier()` or the object won't register as touched.
- **bun:sqlite `:memory:` gotcha:** `new Database(":memory:")` in bun creates a real on-disk file named `:memory:` instead of a true in-memory database. Any path whose basename is `:memory:` — including cwd-joined forms like `/project/:memory:` — hits the same bug. Always open `:memory:` databases through `openDatabase()` in `src/sqlite.ts`, which special-cases the basename and uses the no-arg `new Database()` constructor instead. `new Database(realPath)` with a genuine file path is fine.
- **Concurrent DB access:** Both `openMemoryDb()` and `openContextEngineDb()` configure WAL mode plus a `busy_timeout` via `applyConcurrencyPragmas()` in `src/sqlite.ts`. Don't open these databases with raw `new Database()` and then skip the pragmas — missing `busy_timeout` makes parallel sessions fail immediately with `SQLITE_BUSY` instead of retrying.
- Shell timeouts kill the process **group** (not just the parent) so orphaned children like `find` cannot hang the session. Do not replace this with `Bun.spawn` / `Bun.Terminal` unless process-tree SIGTERM→SIGKILL is equivalent; `Bun.Terminal` is reserved for a future interactive PTY shell, not the current tool.

---

## Git Conventions

- **Commits:** Conventional commits — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:` (release-please uses these for `CHANGELOG.md`)
- **Changelog:** Do not edit `CHANGELOG.md` by hand for releases. Release-please opens a version PR from commit history; merge that PR to cut a release.
- **Tags:** Semver — `v0.4.0` (release-please creates tags)
- **Branch:** `main`
- **Issue work:** Create a dedicated branch for each GitHub issue before making code changes (example: `feat/phase1-issue-56`).
- **Before commit:** `bun typecheck && bun test` — both must pass clean
