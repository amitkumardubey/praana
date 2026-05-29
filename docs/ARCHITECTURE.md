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
  compiler.ts    — Deterministic prompt assembly with token budgeting & metrics
  state-graph.ts — Tiered state management (active/soft/hard) & keyword auto-hydrate
  event-log.ts   — Append-only JSONL event persistence with fsyncSync durability
  llm.ts         — Provider registry and model building via pi-ai
  config.ts      — Multi-source JSON/TOML config loading & deep-merge
  types.ts       — Core shared TypeScript types
  ui.ts          — CLI output formatting, banners, and text colors
  tools/
    index.ts     — Tool registry (all tool definitions combined)
    tool-def.ts  — Type helper for defining tools
    system.ts    — shell, read_file, write_file, edit_file
    knowledge.ts — recall, remember tools (cross-session memory)
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
      3) compile prompt (compileWithMetrics)
      4) piStream() with tools
      5) log tool_call / tool_result + context_action events
      6) append agent_message event
      7) apply tier demotion rules
      8) print per-turn memory/prompt banner
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

`src/compiler.ts` constructs deterministic, token-budgeted prompt sections:

1. **System Frame**: System prompt with current working directory, session ID, tool descriptions, and working memory stats.
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

### System Tools (`src/tools/system.ts`)
- `shell(command, timeout?)` — executes a bash command with timeout (default: 30s)
- `read_file(path, offset?, limit?)` — reads a file with optional pagination limits
- `write_file(path, content)` — writes or overwrites a file (creates parent directories)
- `edit_file(path, oldText, newText)` — replaces text based on exact, unique matching

## Cognitive Memory

### Key Components
- `MemoryStore` (`src/memory/store.ts`): Coordinates high-level cross-session memory operations, session starts, and session ends.
- SQLite Database (`src/memory/db.ts`): Maintains durable sqlite/vec0 tables under `~/.aria/memory.db`.
- Embedder (`src/memory/embeddings.ts`): `HashEmbedder` generates deterministic 384-dimension float32 unit-sphere vectors via a hash-seeded projection. Fast and dependency-free, but **not semantic** — similar phrases with different words produce different vectors. The `Embedder` interface is swappable; `OllamaEmbedder` is planned.
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

[session]
log_dir = "~/.aria/sessions"
```

### Environment Variables
- `ARIA_MODEL` — overrides default model
- `ARIA_SUMMARIZER_MODEL` — overrides summarizer model (defaults to `google/gemini-2.5-flash` on OpenRouter)
- Provider-specific keys: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, etc.

## UI and Slash Commands

The interactive terminal (`src/main.ts`) runs a readline loop supporting slash commands:
- `/exit` — ends session, triggers summarizer, saves and quits
- `/state` — lists all state objects and their tiers
- `/stats` — lists memory tier distribution and DB paths
- `/digest` — prints the current cross-session markdown digest
- `/events` — lists the last 20 events in the event log
- `/recall <query>` — performs manual vector recall query
- `/model <name>` — switches active model on-the-fly (persisted to log)
- `/sessions` — lists last 15 historical sessions for easy resuming
- `/debug` — toggles detailed tool block tracing and compiles turns to files under `prompts/`
- `/thinking <on|off>` — toggles visibility of LLM reasoning stream
- `/help` — prints slash commands documentation
