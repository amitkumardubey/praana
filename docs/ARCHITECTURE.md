# PRAANA Architecture

PRAANA is a single-process TypeScript CLI coding agent built around two memory systems:

1. **Adaptive Context** — within-session working memory
2. **Cognitive Memory** — learns from experience across sessions, scores what's confirmed, forgets what's noise

No daemon, no RPC server, no multi-process coordination.

## Directory Structure

```
src/
  main.ts        — CLI entry point, readline loop, slash commands
  turn.ts        — Per-turn orchestration (prompt → LLM → tools → banners)
  session.ts     — Session lifecycle (create/resume/end) & memory init
  compile-classic.ts — Classic-mode prompt assembly (full verbatim history)
  compiler.ts    — Legacy budget-band compiler (unit tests only)
  state-graph.ts — Tiered state management (active/soft/hard) & two-pass auto-hydrate (substring + BM25)
  state-graph-checkpoint.ts — O(1) resume: persist/restore StateGraph snapshot (tiers, touchedTurn) after each turn
  event-log.ts   — Append-only JSONL event persistence with fsyncSync durability; in-memory parse cache (re-reads disk only on mtime/size change)
  token-estimate.ts — Unicode-aware token heuristic (Latin/CJK/emoji/ZWJ); canonical shared estimator for all budget calculations
  context-pressure.ts — Density-weighted effective-token accounting; raw-token safety net; resolves compaction config
  model-resolver.ts — /model parsing and provider+model resolution
  provider-catalog.ts — live /models fetch + 6h cache for OpenAI-compatible providers
  llm.ts         — Provider registry and model building via pi-ai
  config.ts      — Multi-source JSON/TOML config loading & deep-merge
  types.ts       — Core shared TypeScript types
  ui.ts          — CLI output formatting, banners, and text colors
  utils/
    bm25.ts      — Shared BM25 tokenization, scoring, and corpus statistics
  context-engine/
    index.ts       — ContextEngine facade (store, ledger, extraction, checkpoint, telemetry)
    types.ts       — Engine-level interfaces
    artifact-store.ts — Content-addressed blob store with distiller integration
    turn-ledger.ts — Append-only typed turn records with BM25 search
    distiller.ts   — DistillerRegistry, sync/deferred dispatch, intensity selection
    classify.ts    — Fast regex-based content-type classification
    summarize.ts   — Generic head/tail summarisation; re-exports estimateTokens from token-estimate.ts
    extraction.ts  — Post-turn deterministic extraction (TurnDigest, activity, errors)
    turn-digest.ts  — TurnDigest extraction and state-graph diffing
    activity-log.ts — ActivityEntry derivation and rolling buffer
    error-tracker.ts — Open error tracking and test-pass/fail detection
    checkpoint.ts  — SessionCheckpoint reconciliation, rendering, replay from digests
    state-snapshot.ts — StateGraph snapshot and diff for decision/constraint extraction
    scoring.ts     — 3-term scoring (pin + recency + relevance) and budget selection
    engine-compiler.ts — Multi-resolution budget-band compiler (engine mode)
    bm25.ts        — Re-exports shared BM25 utilities for context-unit and turn-search scoring
    density.ts     — SectionDensityKind → weight table; densityWeight() used by engine-compiler for weighted pressure
    turn-recorder.ts — Per-turn event recording for the turn ledger
    event-lineage.ts — Trace artifacts back to producing turns, decisions, files
    telemetry.ts   — Per-session telemetry: pressure events, retrieval rates, distiller savings
    db.ts          — SQLite schema and operations for all engine tables
  distillers/
    index.ts       — Default distiller registry factory
    git-diff.ts     — Diff hunk compaction with context reduction
    npm-test.ts     — Test output: collect failures, summarise passes
    tsc-errors.ts   — Build error deduplication
    rg-results.ts   — Search result dedup and top-k
    generic.ts      — Log template mining + generic head/tail
  tools/
    index.ts     — Tool registry (all tool definitions combined)
    tool-def.ts  — Type helper for defining tools
    system.ts    — shell, read_file, write_file, edit_file, read_and_summarize, batch_write, batch_edit
    search-code.ts — search_code: ripgrep-backed structured code search (rg --json → file:line:column matches with context)
    knowledge.ts — recall, remember, retrieve_artifact, context_summary, search_turn_events, event_lineage
    memory.ts    — Adaptive Context state-graph tools (tasks, decisions, constraints, notes)
  memory/
    index.ts     — Memory store exports
    store.ts     — High-level MemoryStore API (remember, recall, session start/end)
    db.ts        — SQLite schema and operations (entries, entry_scopes, sessions, entries_vec)
    embeddings.ts — Ollama embedder adapter (optional, opt-in)
    types.ts     — Memory-specific types
    summarizer.ts — LLM-based extraction logic (conversation transcript → learnings JSON)
    openai-summarizer.ts — Chat completion fetch adapter for summarization
```

## Runtime Architecture (Turn Flow)

```
User input
  → main.ts readline loop
  → runTurn(session, input) in turn.ts
      1) append user_message event
      2) select mode:
         Engine: context_engine.enabled=true AND ContextEngine initialized
         Classic: everything else (disabled, or enabled but init failed)
      3) [engine only] auto-hydrate matching peripheral state (two-pass: substring keyword + BM25 relevance)
      4) [engine only] capture StateGraph snapshot (for post-turn diff)
      5) [engine only] ingest tool results through distillers; classic passes through
      6) compile prompt:
         Engine:  compileEngineWithMetrics (budget bands + scored units + checkpoint)
         Classic: compileClassicWithMetrics (system frame + skill catalog + full history)
      7) piStream() with tools (tool set varies by mode — see Tools)
      8) log tool_call / tool_result + context_action events
      9) append agent_message event
     10) [engine only] flush deferred distillations, append turn record to ledger
     11) [engine only] extract TurnDigest (deterministic, no LLM)
     12) [engine only] reconcile SessionCheckpoint from digest
     13) increment turn count
     14) [engine only] apply tier demotion rules + skill residency endTurn
     15) persist state graph checkpoint (session.persistStateGraphCheckpoint())
     16) print per-turn memory/prompt banner
```

## Session Boundary Flow

```
SESSION START:
  Session.create()
  → init EventLog + StateGraph
  → init MemoryStore (if enabled)
  → memory.sessionStart(context)
  → cache digest markdown

SESSION RESUME:
  Session.resume(sessionId)
  → load state_graph_checkpoint.json if present → O(1) StateGraph restore (tiers + touchedTurn preserved)
  → replay only context_action events that occurred after the checkpoint's last_event_id
  → restore model override from the last model_override system_note
  → re-init MemoryStore + regenerate digest

SESSION END:
  Session.end(reason, transcriptEvents)
  → memory.sessionEnd(reason, events)
  → if summarizer enabled: extractLearnings from transcript events
  → write learnings into Cognitive Memory
  → close event log
```

## State Model (Adaptive Context)

Defined in `src/types.ts`:

```ts
export type StateObjectKind = "task" | "decision" | "constraint" | "note";
export type StateTier = "active" | "soft" | "hard";

export interface StateObject {
  id: string; // ULID
  kind: StateObjectKind;
  tier: StateTier;
  payload: StatePayload; // TaskPayload | DecisionPayload | ConstraintPayload | NotePayload
  created: number; // unix ms
  updated: number; // unix ms
  lastTouched: number; // unix ms
}
```

### Tier Behavior in Prompts

| Tier   | Prompt Representation | When                           |
|--------|-----------------------|--------------------------------|
| Active | Full payload          | Current working set            |
| Soft   | Summarized one-liner  | Recently idle                  |
| Hard   | Minimal anchor (ID)   | Older context, available via hydrate |

### Tier Demotion

Managed dynamically after each turn in `src/turn.ts`:
- `active` → `soft` after `idle_soft_after_turns` (default: 20 turns since last touched)
- `active` / `soft` → `hard` after `idle_hard_after_turns` (default: 50 turns since last touched)

### Auto-Hydration

Before a turn prompt is compiled, `stateGraph.autoHydrate(userInput)` runs two passes against peripheral state objects:

1. **Substring keyword match** — extracts keywords (alphanumeric strings $\ge 3$ characters, filtering common English stop words) and matches them against the searchable text representation of peripheral objects. Fast and catches exact references.
2. **BM25 relevance** — scores remaining peripheral objects with `bm25Relevance(query, text)`. Objects scoring $\ge 0.15$ (the `BM25_HYDRATE_THRESHOLD`) are promoted even when no substring keywords matched. This catches fuzzy overlap that substring matching misses — for example, when a user mentions "S3 upload" and a peripheral object about "AWS bucket" gets promoted.

Returns `AutoHydrateResult[]` with `{ id, text, method }` (`method` is `"substring"` or `"bm25"`). The `text` field is passed through to context-unit scoring for `hydrate_boost` calculation (see [Scoring](#engine-mode-context_engineenabled--true-engine-initialized) below). Promotions are logged as `context_action` events with `reason: "auto_hydrate"` and `hydrate_method: "substring" | "bm25"`.

## Event Log

Location: `~/.praana/sessions/<session_id>/events.jsonl`

**In-memory cache:** After the first read, `EventLog` maintains a parsed event index in memory. On every subsequent `readAll`, `readLast`, `search`, or `replayContextActions` call it checks `mtime` and `size` via `statSync`; if unchanged it returns the cached array directly — no JSONL re-parsing. `append()` updates the cache inline before writing to disk, so the cache never drifts. `getLastEvent()` is O(1) direct cache access.

Each line is a single JSON line representing an `Event`:
- `user_message`
- `agent_message`
- `tool_call`
- `tool_result`
- `context_action`
- `system_note`

Writing uses `writeSync` followed by `fsyncSync` to guarantee durable persistence on every event. Rebuilding state on session resume replays `context_action` events.

Agents can search the full log in-session via the `search_session_log` tool (keyword AND/OR search). This is distinct from `recall`, which queries cross-session Cognitive Memory in SQLite.

## Compiler

PRAANA has two runtime compile paths. Selection happens in `turn.ts`:

```ts
const useEngineCompiler = contextEngineEnabled && !!session.contextEngine;
const classicMode = !useEngineCompiler;
```

- **Engine mode** — `context_engine.enabled = true` and `ContextEngine` initialized successfully at session start.
- **Classic mode** — engine disabled, or enabled but initialization failed (falls back to full classic behaviour).

`src/compiler.ts` (`compileWithMetrics`) is retained for unit tests only; it is not used at runtime.

### Engine mode (`context_engine.enabled = true`, engine initialized)

`src/context-engine/engine-compiler.ts` constructs a multi-resolution prompt from budget bands:

1. **Band 1 (always):** System frame, AGENTS.md, skills — existing allocation.
2. **Band 2 (always):** Active user request + last 2 full turns verbatim — ~3000 tokens.
3. **Band 3 (always):** SessionCheckpoint (pinned) — ~2000 tokens. Reconciled deterministically from `TurnDigest` after each turn. Sections: active request, session narrative, plan history, constraints, decisions (with retained rationale), files, findings, errors, activity. See [Session Checkpoint](#session-checkpoint) below.
4. **Band 4 (scored):** Fact cards, artifact cards, activity entries — ~3000 tokens.
5. **Band 5 (scored):** Older turn digests — ~2000 tokens.
6. **Band 6 (remaining):** Memory digest, low-priority state — remainder.

Context units are scored with a 4-term model: `pin_boost × W_pin + recency(age) × W_recency + BM25(query, content) × W_relevance + hydrate_boost × W_hydrate`. The hydrate boost is the maximum `bm25Relevance(ht, unitContent)` across all auto-hydrated object texts — it gives a lift to context units (e.g. older turn digests) that discuss the same objects the user just implicitly referenced. Default weights: `w_pin=1.0`, `w_recency=0.5`, `w_relevance=0.3`, `w_hydrate_boost=0.2`.

Pressure monitoring uses **density-weighted effective tokens**: `contextPressure = weightedTokens / usableBudget`. Each section kind has a hardcoded weight in `src/context-engine/density.ts` (decisions/constraints/plans = 1.0; open errors = 0.8; narrative/file/peripheral = 0.6; verbatim turns = 0.9; turn digests/artifacts = 0.4; findings/activity/fixed errors = 0.25). Low-density filler counts less toward pressure so a prompt full of error traces does not trigger compaction as aggressively as one full of architectural decisions. `>0.70` triggers compaction (drop older digests, tighten checkpoint findings/activity budgets). `>0.85` triggers emergency (keep checkpoint decisions/constraints/plans/open errors only — omit findings, activity, fixed errors — plus last 2 verbatim turns and current artifact cards). **Raw-token safety net:** when estimated raw prompt tokens exceed the usable budget or raw fill exceeds `emergency_at`, emergency mode is forced even if weighted pressure is lower. Section token caps (findings 300, scored bands 3000/2000) bound worst-case raw size; `/stats` shows both raw and weighted fill.

Score logging: in debug mode, `scores.jsonl` records every context unit's score breakdown per turn. Inspect via `/why <unit-id>`.

### Session Checkpoint

`src/context-engine/checkpoint.ts` maintains a structured within-session summary that survives when turns scroll out of the verbatim window (turns 7+). It is reconciled from `TurnDigest` data — never by the LLM — to prevent drift.

| Section | Behaviour |
|---|---|
| Active request | Latest user intent (overwritten each turn) |
| Session narrative | Rolling prose from meaningful turns (decisions, constraints, errors, file writes, intent changes). Max 20 entries, 400-token render budget |
| Plan | Current plan + superseded one-liners with completion hints. Extracted from assistant step lists via pattern matching. 400-token budget |
| Constraints | Append-only, never dropped. Includes implicit constraints auto-extracted from user messages |
| Decisions | Summary + rationale; compact after 10 idle turns but rationale is never dropped. 800-token budget |
| Files in play | Evicted after 10 idle turns |
| Findings | Rolling artifact refs, oldest evicted at 30 entries. 300-token budget |
| Errors | Open errors full detail; fixed errors one-liners |
| Activity | Rolling 15 entries from activity log |

Implicit knowledge capture has two layers: (1) the system frame nudges the agent to call `add_constraint` / `add_note` for preferences and corrections — this is the **primary** mechanism because the LLM is the language-understanding component, not regex; (2) `extractImplicitConstraints()` in `turn-digest.ts` is a **minimal safety net** that only captures the syntactically unambiguous "not X, Y" correction pattern. Patterns like "let's use", "we use", "I prefer", "how about" are NOT regex-matched because natural language is too varied — those are the LLM's responsibility via the nudge.

### Classic mode (`compile-classic.ts`)

When classic mode is active, `src/compile-classic.ts` builds a flat prompt with **no token-budget truncation** and **no Adaptive Context sections**:

1. **System frame** — cwd, session ID, tool descriptions, AGENTS.md project context, skills guidance (read `SKILL.md` via `read_file` when relevant).
2. **Skills catalog** — name + path metadata only (no BM25 residency, no hot/warm/cold sections).
3. **Cognitive Memory** — digest (if enabled).
4. **Conversation history** — **full verbatim** event log (`readAll()`), excluding `context_action` and `system_note`. Tool results are not truncated.
5. **Current input** — latest user message.

**Runtime differences from engine mode:**

| | Engine mode | Classic mode |
|---|---|---|
| Compiler | `compileEngineWithMetrics` | `compileClassicWithMetrics` |
| History | Budget bands + checkpoint + scored digests | Full verbatim log |
| StateGraph tools | Available | Hidden from tool list |
| Engine tools | Available | Hidden |
| SkillRuntime | BM25 match + hot/warm/cold | Static metadata catalog |
| Auto-hydrate / tier demotion | Yes | Skipped |
| TurnDigest / checkpoint | Yes | Skipped |
| `/why` scores | Available (debug) | N/A |

Classic mode matches how agents like Claude Code and pi operate — a growing transcript with no working-memory tiering. Set `measurement_mode = true` to write engine telemetry while running classic mode (development/debug only).

### Legacy compiler (`compiler.ts`)

The original 5-section budget-band allocator (`compileWithMetrics`) remains in the tree for regression tests only. It applied per-section token budgets, truncated recent turns, and included Adaptive Context active/peripheral sections. Runtime no longer uses this path.

## Tools

Defined in `src/tools/` using Zod schemas and normalized via `zod-to-json-schema`. The registered tool set depends on compile mode (`describeTools({ contextEngineEnabled, classicMode })`).

### Shared tools (classic and engine mode)
- `search_session_log(query, kinds?, limit?)` — keyword search over the current session event log

### System Tools (`src/tools/system.ts`)
- `shell(command, timeout?)` — executes a bash command with timeout (default: 30s); optional sandbox allowlist via `[shell]`
- `read_file(path, offset?, limit?)` — reads a file with optional pagination limits
- `read_and_summarize(path)` — structured file overview (size, line count, head/tail preview)
- `write_file(path, content)` — writes or overwrites a file (creates parent directories)
- `edit_file(path, oldText, newText)` — replaces text based on exact, unique matching (optional diff preview)
- `batch_write(files[])` / `batch_edit(edits[])` — multi-file create/replace in one turn

### Code Search (`src/tools/search-code.ts`)
- `search_code(pattern, path?, globs?, max_results?, ...)` — ripgrep-backed structured search (`rg --json` → file:line:column matches)

### Cognitive Memory Tools (`src/tools/knowledge.ts`)
- `recall(query, mode?, kinds?)` — searches Cognitive Memory and logs a `memory_recall` system note
- `remember(content, kind?, certainty?, scope?)` — writes facts, decisions, preferences, patterns, mistakes, or constraints directly to Cognitive Memory
- `forget_memory(id)` — tombstones a Cognitive Memory entry (`retracted = 1`). The entry is excluded from future recall and digest, but the row is retained for audit.

### Adaptive Context Tools (`src/tools/memory.ts` — engine mode only)
- `create_task(title, description?)` — creates a task in working memory
- `complete_task(id)` — marks a task as done, auto-demoting it to the `soft` tier
- `retract_task(id)` — tombstones a state object (any kind)
- `add_constraint(text)` — records a constraint rule/limitation in working memory and mirrors it to Cognitive Memory when enabled (not incognito)
- `decide(summary, rationale)` — records an architectural/design decision in working memory and mirrors it to Cognitive Memory as a `decision` entry
- `add_note(text)` — records a general note in working memory and mirrors it to Cognitive Memory as a `fact` entry
- `soft_unload(id)` / `hard_unload(id)` / `hydrate(id)` — tier management
- `list_state()` — lists all state objects with their IDs, kinds, tiers, and summaries

### Context Engine Tools (`src/tools/knowledge.ts` — engine mode only)
- `retrieve_artifact(id, options?)` — retrieves raw artifact content with optional grep/line/jsonPath selectors
- `context_summary()` — current checkpoint + open errors + recent activity + session stats
- `search_turn_events(query)` — BM25 search over turn ledger
- `event_lineage(artifactId)` — trace artifact → producing turn → decisions → related artifacts

## Cognitive Memory

### Key Components
- `MemoryStore` (`src/memory/store.ts`): Coordinates high-level Cognitive Memory operations, session starts, and session ends.
- SQLite Database (`src/memory/db.ts`): Maintains durable sqlite/vec0 tables under `~/.praana/memory.db`.
- Embedder (`src/memory/embeddings.ts` + `src/memory/embedder-factory.ts` + `src/memory/transformers-embedder.ts`): supports `auto`, `transformers`, `transformers-nomic`, and `ollama`. `auto` uses Transformers.js (shipped as a dependency); model weights cache in `~/.praana/models/`.
- Summarizer Adapter (`src/memory/openai-summarizer.ts`): Adapts chat completions to OpenAI-compatible endpoints (OpenAI or OpenRouter).
- Extraction Logic (`src/memory/summarizer.ts`): At session end, sends the full transcript to an LLM and extracts up to 5 structured learnings across six kinds: `fact`, `preference`, `decision`, `pattern`, `mistake`, `constraint`. Each learning includes a certainty level (`high` / `medium` / `low`) that maps to an initial confidence score.

### Memory Kinds

| Kind | What it stores |
|---|---|
| `fact` | Verifiable project knowledge |
| `preference` | Working style preferences |
| `decision` | Architectural choices with rationale |
| `pattern` | Recurring approaches that work |
| `mistake` | A failure and the lesson extracted from it |
| `constraint` | A rule that must always hold |

### Scope Isolation (Multi-Context Safety)
To prevent cross-project context leaks, all memory queries and writes are isolated using scopes:
- Default scopes are constructed at session start: `["user:<hashed_username>", "agent:praana", "context:<hashed_cwd_path>"]`.
- The SQLite query layer enforces **AND-scoping**: recalled entries must match *all* scopes in a single query.

In **project sessions**, `MemoryStore` runs two queries and merges by entry id:
1. Full project scopes (`user` + `agent` + `context`) — project-local facts and decisions.
2. Global-only scopes (`user` + `agent`) — entries without a `context:` scope (preferences, cross-project patterns).

Global-only queries exclude entries that carry `context:`, so project facts stay local. Ranking is unified across the merged set; semantic conflicts between global and project entries are not auto-resolved.

### Ranking and Decay
The memory retrieval system fuses multiple signals into a unified search score:
- **Vector distance** (from `entries_vec` using `sqlite-vec`) maps candidate entries.
- **Confidence**: Base confidence is derived from extraction certainty (`high` = 0.8, `medium` = 0.5, `low` = 0.3) and decays at 5% per day: $\text{conf} \times 0.95^{\text{days}}$.
- **Recency**: Candidates receive a boost up to $+0.2$ based on how recently they were last accessed.
- **Pinned Flag**: Pinned memories receive a $+0.3$ score boost, ensuring they are always highly prioritized or visible in digests.
- **Tool-outcome reinforcement** (#45): entries recalled before a successful tool invocation receive a confidence boost. More broadly, any entry **surfaced** in a session (via the session-start digest or `recall()`) is reinforced at session end — validity up, usefulness up if acted on / down if ignored — and an entry surfaced across ≥2 distinct sessions with validity ≥0.7 is **promoted from Layer 1 to Layer 2** (deep memory).

### Schema Migrations
The SQLite schema evolves through additive `ALTER TABLE` migrations applied at every `openMemoryDb()` call. `ensureLayerColumns()` inspects `PRAGMA table_info(entries)` and runs each `ALTER TABLE ... ADD COLUMN` only if the column is missing — making the migrations idempotent and safe for existing installs. New columns always carry a `DEFAULT` so existing rows are populated automatically. The `retracted` column (added with the RETRACT opcode) defaults to `0`, so all pre-existing entries remain visible until explicitly tombstoned.

## Configuration

Config files are deep-merged from lower to higher precedence (later overrides earlier):
1. Global JSON: `~/.praana/praana.config.json`
2. Global TOML: `~/.praana/config.toml`
3. Local JSON: `./praana.config.json`
4. Local TOML: `./praana.config.toml`

```toml
[llm]
provider = "openrouter"               # openrouter | openai | deepseek | groq | xai | fireworks | together | ollama | opencode | anthropic | google | mistral | amazon-bedrock
model = "deepseek/deepseek-v4-pro"    # any model supported by the chosen provider

[memory]
enabled = true
summarizer = "openrouter"             # openrouter | disabled
db_path = "~/.praana/memory.db"

[compiler]
token_budget = 100000
recent_turns = 10
recent_turns_token_budget = 30000

[tiers]
idle_soft_after_turns = 20
idle_hard_after_turns = 50

[context_engine]
enabled = false                    # true = engine mode (checkpoint, distillation, scoring)
measurement_mode = false           # write telemetry in classic mode (debug)
artifact_inline_threshold = 400
artifact_ttl_turns = 50
checkpoint_enabled = true          # narrative, plan history, constraints, decisions w/ rationale

[context_engine.distiller]
default_intensity = "full"         # lite | full

[context_engine.scoring]
w_pin = 1.0
w_recency = 0.5
w_relevance = 0.3
w_hydrate_boost = 0.2    # boost for context units overlapping auto-hydrated objects

[context_engine.pressure]
compact_at = 0.70
emergency_at = 0.85

[session]
log_dir = "~/.praana/sessions"
```

### Env Vars
- `PRAANA_MODEL` — overrides default model
- `PRAANA_SUMMARIZER_MODEL` — overrides summarizer model (defaults to `google/gemini-2.5-flash` on OpenRouter)
- `PRAANA_CONTEXT_ENGINE` — overrides `context_engine.enabled`
- `PRAANA_MEASUREMENT_MODE` — overrides `context_engine.measurement_mode`
- Provider-specific keys: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`, etc.

### Mid-session model switching

`/model` is handled by `model-resolver.ts` and validated before the switch toast appears.

**Syntax:** `/model [provider] <model-id>` — provider is optional and space-separated only (not `provider/model` as a single token unless it is the model id on the current provider).

**Resolution order:**
1. pi-ai static catalog (`getModel(provider, id)`)
2. Live provider catalog from `GET {baseUrl}/models` via `provider-catalog.ts` (6-hour disk cache at `~/.praana/provider-catalog-cache.json`)
3. Reject with an error toast if still unknown

**Live catalog providers** (OpenAI-compatible `/models`): OpenRouter, OpenCode, OpenAI, DeepSeek, Groq, xAI, Fireworks, Together, Ollama. Anthropic, Google, Mistral, and Bedrock rely on pi-ai only.

**Persistence:** successful switches write `model_override` and optionally `provider_override` system notes to the event log. `session.ts` restores the latest overrides on resume. Routing prefixes like `openrouter/` or `opencode/` are stripped before API calls.

## UI and Slash Commands

PRAANA supports two terminal interfaces (see `[ui] mode` in config):

- **TUI (default when TTY)** — Ink-based chat shell (`src/ui/tui/`): transcript replay, markdown rendering, status bar, thinking blocks, scroll window.
- **Readline** — classic line-at-a-time CLI (`src/ui/readline-ui.ts`). Used automatically when stdout is not a TTY, or via `praana --ui readline`.

Both support slash commands via `src/slash-commands.ts`:

- `/exit` — ends session, triggers summarizer, saves and quits
- `/clear`, `/new` — clears working-memory state (StateGraph + engine checkpoint)
- `/state` — lists all state objects and tiers, or prints an empty-state guidance message
- `/stats` — prints session metadata plus working-memory and Cognitive Memory stats
- `/digest` — prints the current Cognitive Memory markdown digest
- `/events` — lists the last 20 events in the event log
- `/recall <query>` — performs manual vector recall query
- `/model [provider] <id>` — switch model and optionally provider (persisted to log; validated via pi-ai + live catalog)
- `/sessions` — lists last 15 historical sessions for easy resuming
- `/incognito <on|off>` — toggles Cognitive Memory persistence
- `/debug` — toggles detailed tool block tracing and compiles turns to files under `prompts/` (and `scores.jsonl` in engine mode)
- `/thinking <on|off>` — toggles visibility of LLM reasoning stream
- `/why <id>` — explains why a context unit was included or excluded from the last compiled prompt (engine mode only)
- `/help` — prints slash commands documentation

CLI flags: `praana --incognito`, `praana --ui tui|readline`, `praana --config <path>`. See `src/app-banner.ts` for the full list.
