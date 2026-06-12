# ARIA Architecture

ARIA is a single-process TypeScript CLI coding agent with two cognitive memory systems:

1. **Adaptive Context** — within-session working memory
2. **Cognitive Memory** — cross-session persistent memory

No daemon, no RPC server, no multi-process coordination.

## Directory Structure

```
src/
  main.ts        — CLI entry point, readline loop, slash commands
  turn.ts        — Per-turn orchestration (prompt → LLM → tools → banners)
  session.ts     — Session lifecycle (create/resume/end) & memory init
  compiler.ts    — Legacy prompt assembly (used in classic mode)
  state-graph.ts — Tiered state management (active/soft/hard) & keyword auto-hydrate
  event-log.ts   — Append-only JSONL event persistence with fsyncSync durability
  llm.ts         — Provider registry and model building via pi-ai
  config.ts      — Multi-source JSON/TOML config loading & deep-merge
  types.ts       — Core shared TypeScript types
  ui.ts          — CLI output formatting, banners, and text colors
  context-engine/
    index.ts       — ContextEngine facade (store, ledger, extraction, checkpoint, telemetry)
    types.ts       — Engine-level interfaces
    artifact-store.ts — Content-addressed blob store with distiller integration
    turn-ledger.ts — Append-only typed turn records with BM25 search
    distiller.ts   — DistillerRegistry, sync/deferred dispatch, intensity selection
    classify.ts    — Fast regex-based content-type classification
    summarize.ts   — Token estimation and generic head/tail summarisation
    extraction.ts  — Post-turn deterministic extraction (TurnDigest, activity, errors)
    turn-digest.ts  — TurnDigest extraction and state-graph diffing
    activity-log.ts — ActivityEntry derivation and rolling buffer
    error-tracker.ts — Open error tracking and test-pass/fail detection
    checkpoint.ts  — SessionCheckpoint reconciliation, rendering, replay from digests
    state-snapshot.ts — StateGraph snapshot and diff for decision/constraint extraction
    scoring.ts     — 3-term scoring (pin + recency + relevance) and budget selection
    engine-compiler.ts — Multi-resolution budget-band compiler (engine mode)
    bm25.ts        — BM25 scoring for context unit relevance and turn search
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
    system.ts    — shell, read_file, write_file, edit_file
    knowledge.ts — recall, remember, retrieve_artifact, context_summary, search_turn_events, event_lineage
    memory.ts    — Adaptive Context state-graph tools (tasks, decisions, constraints, notes)
  memory/
    index.ts     — Memory store exports
    store.ts     — High-level MemoryStore API (remember, recall, session start/end)
    db.ts        — SQLite schema and operations (entries, entry_scopes, sessions, entries_vec)
    embeddings.ts — Hash-based pseudo-semantic embedder (MVP)
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
      2) auto-hydrate matching peripheral state (keyword matching)
      3) capture StateGraph snapshot (for post-turn diff)
      4) ingest tool results through distillers (engine mode) or pass through
      5) compile prompt:
         Engine mode:  compileEngineWithMetrics (budget bands + scored units + checkpoint)
         Classic mode: compileWithMetrics (legacy 5-section fixed allocator)
      6) piStream() with tools
      7) log tool_call / tool_result + context_action events
      8) append agent_message event
      9) flush deferred distillations, append turn record to ledger
     10) extract TurnDigest (deterministic, no LLM)
     11) reconcile SessionCheckpoint from digest
     12) apply tier demotion rules
     13) print per-turn memory/prompt banner
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
  → replay context_action events into StateGraph
  → restore model override from the last model_override system_note
  → re-init MemoryStore + regenerate digest

SESSION END:
  Session.end(reason, transcriptEvents)
  → memory.sessionEnd(reason, events)
  → if summarizer enabled: extractLearnings from transcript events
  → write learnings into cross-session memory
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

Before a turn prompt is compiled, `stateGraph.autoHydrate(userInput)` extracts keywords (alphanumeric strings $\ge 3$ characters, filtering common English stop words) and matches them against the searchable text representation of peripheral state objects. Matching stubs are promoted to `active` automatically and logged as `context_action` events with `reason: "auto_hydrate"`.

## Event Log

Location: `~/.aria/sessions/<session_id>/events.jsonl`

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

### Engine mode (`context_engine.enabled = true`)

`src/context-engine/engine-compiler.ts` constructs a multi-resolution prompt from budget bands:

1. **Band 1 (always):** System frame, AGENTS.md, skills — existing allocation.
2. **Band 2 (always):** Active user request + last 2 full turns verbatim — ~3000 tokens.
3. **Band 3 (always):** SessionCheckpoint (pinned) — ~2000 tokens. Reconciled deterministically from `TurnDigest` after each turn. Sections: active request, session narrative, plan history, constraints, decisions (with retained rationale), files, findings, errors, activity. See [Session Checkpoint](#session-checkpoint) below.
4. **Band 4 (scored):** Fact cards, artifact cards, activity entries — ~3000 tokens.
5. **Band 5 (scored):** Older turn digests — ~2000 tokens.
6. **Band 6 (remaining):** Memory digest, low-priority state — remainder.

Context units are scored with a 3-term model: `pin_boost × W_pin + recency(age) × W_recency + BM25(query, content) × W_relevance`. Default weights: `w_pin=1.0`, `w_recency=0.5`, `w_relevance=0.3`.

Pressure monitoring: `contextPressure = estimatedTokens / usableBudget`. `>0.70` triggers compaction (drop older digests). `>0.85` triggers emergency (keep only checkpoint + last 2 turns + current artifact cards).

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

Implicit knowledge capture has two layers: (1) the system frame nudges the agent to call `add_constraint` / `add_note` for preferences and corrections — this is the **primary** mechanism because the LLM is the language-understanding component, not regex; (2) `extractImplicitConstraints()` in `turn-digest.ts` is a **minimal safety net** that only captures the syntactically unambiguous "not X, Y" correction pattern. Patterns like "let's use", "we use", "I prefer", "how about" are NOT regex-matched because natural language is too variable — those are the LLM's responsibility via the nudge.

### Classic mode (`context_engine.enabled = false`)

`src/compiler.ts` constructs the prompt with the legacy 5-section fixed allocator:

1. **System Frame**: System prompt with current working directory, session ID, tool descriptions, working memory stats, and implicit-knowledge-capture guidance (preferences/conventions → `add_constraint`).
2. **Cross-Session Memory**: The active Cognitive Memory digest (rendered in markdown).
3. **Active State**: Full payloads grouped by kind (Tasks, Decisions, Constraints, Notes), sorted deterministically by creation time and ULID.
4. **Peripheral Memory**: Lists soft-tier objects as one-line stubs and hard-tier objects as minimal anchors (IDs). Includes instructions on how to `hydrate` them.
5. **Recent Turns**: Chronological transcript of recent events (filtering out `context_action` and `system_note`), truncated according to a specific budget (`recent_turns_token_budget`, defaulting to 30% of total budget).
6. **Current Input**: User's latest input message.

**Properties:**
- **Deterministic**: Sorted order for state objects (`created` then `id`).
- **Token Budgeting**: Characters are mapped to tokens roughly ($1 \text{ token} \approx 4 \text{ characters}$). `compileWithMetrics()` measures and exposes precise token metrics per section.
- **Truncation Limits**: To prevent context blow-up, tool outputs in the recent-turns list are truncated:
  - `shell` output is truncated to 500 characters.
  - `read_file`, `write_file`, and `show` outputs are truncated to 200 characters.
  - Other tool results are truncated to 500 characters.

## Tools

Defined in `src/tools/` using Zod schemas and normalized via `zod-to-json-schema`.

### Adaptive Context Tools (`src/tools/memory.ts`)
- `create_task(title, description?)` — creates a task in working memory
- `complete_task(id)` — marks a task as done, auto-demoting it to the `soft` tier
- `retract_task(id)` — tombstones a state object (any kind). The object is hidden from `getActive`/`getPeripheral`/`list` and from prompts, but is retained in the event log for audit and replay.
- `add_constraint(text)` — records a constraint rule/limitation
- `decide(summary, rationale)` — records an architectural/design decision
- `add_note(text)` — records a general note
- `soft_unload(id)` — demotes a state object to `soft`
- `hard_unload(id)` — demotes a state object to `hard`
- `hydrate(id)` — promotes a peripheral object back to `active`
- `list_state()` — lists all state objects with their IDs, kinds, tiers, and summaries

### Cognitive Memory Tools (`src/tools/knowledge.ts`)
- `recall(query, mode?, kinds?)` — searches cross-session memory and logs a `memory_recall` system note
- `remember(content, kind?, certainty?, scope?)` — writes facts, decisions, preferences, patterns, mistakes, or constraints directly to cross-session memory
- `forget_memory(id)` — tombstones a cross-session memory entry (`retracted = 1`). The entry is excluded from future recall and digest, but the row is retained for audit.

### Context Engine Tools (`src/tools/knowledge.ts` — engine mode only)
- `retrieve_artifact(id, options?)` — retrieves raw artifact content with optional grep/line/jsonPath selectors
- `context_summary()` — current checkpoint + open errors + recent activity + session stats
- `search_turn_events(query)` — BM25 search over turn ledger
- `event_lineage(artifactId)` — trace artifact → producing turn → decisions → related artifacts

### System Tools (`src/tools/system.ts`)
- `shell(command, timeout?)` — executes a bash command with timeout (default: 30s)
- `read_file(path, offset?, limit?)` — reads a file with optional pagination limits
- `write_file(path, content)` — writes or overwrites a file (creates parent directories)
- `edit_file(path, oldText, newText)` — replaces text based on exact, unique matching

## Cognitive Memory

### Key Components
- `MemoryStore` (`src/memory/store.ts`): Coordinates high-level cross-session memory operations, session starts, and session ends.
- SQLite Database (`src/memory/db.ts`): Maintains durable sqlite/vec0 tables under `~/.aria/memory.db`.
- Embedder (`src/memory/embeddings.ts` + `src/memory/embedder-factory.ts`): supports `auto`, `ollama`, `transformers`, `llama-cpp`, and `hash`. `auto` probes Ollama first and falls back to hash with a warning.
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
- Default scopes are constructed at session start: `["user:<hashed_username>", "agent:aria", "context:<hashed_cwd_path>"]`.
- The SQLite query layer enforces **AND-scoping**: recalled entries must match *all* requested query scopes.

```sql
SELECT e.* FROM entries e
JOIN entry_scopes es ON e.id = es.entry_id
WHERE es.scope IN (?, ?, ?)
GROUP BY e.id
HAVING COUNT(DISTINCT es.scope) = 3
ORDER BY e.last_seen_at DESC
```

### Ranking and Decay
The memory retrieval system fuses multiple signals into a unified search score:
- **Vector distance** (from `entries_vec` using `sqlite-vec`) maps candidate entries.
- **Confidence**: Base confidence is derived from extraction certainty (`high` = 0.8, `medium` = 0.5, `low` = 0.3) and decays at 5% per day: $\text{conf} \times 0.95^{\text{days}}$.
- **Recency**: Candidates receive a boost up to $+0.2$ based on how recently they were last accessed.
- **Pinned Flag**: Pinned memories receive a $+0.3$ score boost, ensuring they are always highly prioritized or visible in digests.

### Schema Migrations
The SQLite schema evolves through additive `ALTER TABLE` migrations applied at every `openMemoryDb()` call. `ensureLayerColumns()` inspects `PRAGMA table_info(entries)` and runs each `ALTER TABLE ... ADD COLUMN` only if the column is missing — making the migrations idempotent and safe for existing installs. New columns always carry a `DEFAULT` so existing rows are populated automatically. The `retracted` column (added with the RETRACT opcode) defaults to `0`, so all pre-existing entries remain visible until explicitly tombstoned.

## Configuration

Config files are deep-merged from lower to higher precedence (later overrides earlier):
1. Global JSON: `~/.aria/aria.config.json`
2. Global TOML: `~/.aria/config.toml`
3. Local JSON: `./aria.config.json`
4. Local TOML: `./aria.config.toml`

```toml
[llm]
provider = "openrouter"               # openrouter | openai | deepseek | groq | xai | fireworks | together | ollama | anthropic | google | mistral | amazon-bedrock
model = "deepseek/deepseek-v4-pro"    # any model supported by the chosen provider

[memory]
enabled = true
summarizer = "openrouter"             # openrouter | disabled
db_path = "~/.aria/memory.db"

[compiler]
token_budget = 100000
recent_turns = 10
recent_turns_token_budget = 30000

[tiers]
idle_soft_after_turns = 20
idle_hard_after_turns = 50

[context_engine]
enabled = false                    # true = engine mode (checkpoint, distillation, scoring)
measurement_mode = false           # write telemetry in classic mode for A/B comparison
artifact_inline_threshold = 400
artifact_ttl_turns = 50
checkpoint_enabled = true          # narrative, plan history, constraints, decisions w/ rationale
scoring_enabled = true

[context_engine.distiller]
default_intensity = "full"         # lite | full

[context_engine.scoring]
w_pin = 1.0
w_recency = 0.5
w_relevance = 0.3

[context_engine.pressure]
compact_at = 0.70
emergency_at = 0.85

[session]
log_dir = "~/.aria/sessions"
```

### Environment Variables
- `ARIA_MODEL` — overrides default model
- `ARIA_SUMMARIZER_MODEL` — overrides summarizer model (defaults to `google/gemini-2.5-flash` on OpenRouter)
- `ARIA_CONTEXT_ENGINE` — overrides `context_engine.enabled`
- `ARIA_MEASUREMENT_MODE` — overrides `context_engine.measurement_mode`
- Provider-specific keys: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, etc.

## UI and Slash Commands

The interactive terminal (`src/main.ts`) runs a readline loop supporting slash commands:
- `/exit` — ends session, triggers summarizer, saves and quits
- `/state` — lists all state objects and tiers, or prints an empty-state guidance message
- `/stats` — prints session metadata plus working-memory and persistent-memory stats
- `/digest` — prints the current cross-session markdown digest
- `/events` — lists the last 20 events in the event log
- `/recall <query>` — performs manual vector recall query
- `/model <name>` — switches active model on-the-fly (persisted to log)
- `/sessions` — lists last 15 historical sessions for easy resuming
- `/debug` — toggles detailed tool block tracing and compiles turns to files under `prompts/` (and `scores.jsonl` in engine mode)
- `/thinking <on|off>` — toggles visibility of LLM reasoning stream
- `/why <id>` — explains why a context unit was included or excluded from the last compiled prompt (engine mode only)
- `/help` — prints slash commands documentation
