# ARIA Architecture

ARIA is a single-process TypeScript CLI coding agent with two adaptive memory systems:

1. **Adaptive Context** — within-session working memory
2. **Adaptive Memory** — cross-session persistent memory

No daemon, no RPC server, no multi-process coordination.

## Directory Structure

```
src/
  main.ts        — CLI entry point, readline loop, session lifecycle
  turn.ts        — Per-turn orchestration (prompt → LLM → tools → logging)
  session.ts     — Session lifecycle (create/resume/end)
  compiler.ts    — Deterministic prompt assembly with token budgeting
  state-graph.ts — Tiered state management (active/soft/hard)
  event-log.ts   — Append-only JSONL event persistence
  llm.ts         — Provider connection layer
  config.ts      — Multi-source config loading
  types.ts       — Shared TypeScript types
  tools/
    index.ts     — Tool registry (all tool definitions)
    system.ts    — Shell, read_file, write_file, edit_file
    knowledge.ts — recall/remember tools (memory)
  memory/
    index.ts     — MemoryStore export
    store.ts     — Session lifecycle, recall, remember, digest generation
    db.ts        — SQLite operations (entries, embeddings, scopes)
    embeddings.ts — Hash-based embedder (MVP), upgrade path to semantic
    types.ts     — Memory-specific types (MemoryEntry, RecallOptions, etc.)
    summarizer.ts — Extraction logic (conversation → learnings)
    openai-summarizer.ts — LLM adapter for summarization
```

## Runtime Architecture (Turn Flow)

```
User input
  → main.ts readline loop
  → runTurn(session, input)
      1) append user_message event
      2) auto-hydrate matching peripheral state
      3) compile prompt (compileWithMetrics)
      4) streamText() with tools
      5) log tool_call/tool_result + context actions
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
  → restore model override from system_note
  → re-init MemoryStore + regenerate digest

SESSION END:
  Session.end(reason, transcriptEvents)
  → memory.sessionEnd(reason, events)
  → optional summarizer extracts learnings
  → close event log
```

## State Model (Adaptive Context)

```ts
interface StateObject {
  id: string;
  kind: "task" | "decision" | "constraint" | "note";
  tier: "active" | "soft" | "hard";
  payload: Record<string, unknown>;
  created: number;
  updated: number;
  lastTouched: number;
}
```

### Tier Behavior in Prompts

| Tier   | Prompt Representation | When                           |
|--------|-----------------------|--------------------------------|
| Active | Full payload          | Current working set            |
| Soft   | Summarized one-liner  | Recently idle                  |
| Hard   | Minimal anchor        | Older context, available via hydrate |

### Tier Demotion

Managed in `turn.ts`:
- `active` → `soft` after `idle_soft_after_turns` (default: 20)
- `active`/`soft` → `hard` after `idle_hard_after_turns` (default: 50)

Auto-hydrate promotes peripheral objects back to active when the user mentions something related (keyword matching on payload content).

## Event Log

Location: `~/.aria/sessions/<session_id>/events.log`

Each line is one JSON event:
- `user_message`
- `agent_message`
- `tool_call`
- `tool_result`
- `context_action`
- `system_note`

Append protocol is durable: `writeSync` + `fsyncSync` on an open file descriptor.

## Compiler

`src/compiler.ts` builds deterministic prompt sections:

1. System prompt (from `prompts/system.txt` or built-in default)
2. Adaptive Memory digest (if present)
3. Active State (full tier objects)
4. Peripheral State (soft/hard tier objects)
5. Recent Turns (skips `context_action`/`system_note` events)
6. Current Input (when passed)

**Properties:**
- Deterministic ordering — state objects sorted by `created` then `id`
- Token estimation via `compileWithMetrics()`
- Recent-turns section has its own token budget (`recent_turns_token_budget`)
- Each tool type has specific result truncation limits (shell: 500 chars, write_file: 200 chars, etc.)

## Tools

Defined with Vercel AI SDK `tool()` + Zod schemas.

### Adaptive Context Tools
- `create_task(title, description)` — create a task
- `complete_task(id)` — mark task done
- `add_constraint(text)` — add constraint
- `decide(topic, outcome)` — log a decision
- `add_note(text)` — add note
- `soft_unload(id)` — demote to soft
- `hard_unload(id)` — demote to hard
- `hydrate(id)` — promote to active
- `list_state(kind?, tier?)` — query state objects

### Adaptive Memory Tools
- `recall(query, limit?, scope?, kinds?)` — search cross-session memory
- `remember(content, kind?, certainty?, scope?)` — store to memory

### System Tools
- `shell(command, timeout?)` — async spawn with timeout (default: 30s, max: 120s)
- `read_file(path)` — read text file
- `write_file(path, content)` — write text file
- `edit_file(path, old_text, new_text)` — exact-match, unique replacement

## Adaptive Memory

### Key Components
- `MemoryStore` — session lifecycle, recall, remember, digest generation (`store.ts`)
- SQLite layer — entries, embeddings, scopes tables (`db.ts`)
- Embedder — deterministic hash vectors for MVP (`embeddings.ts`)
- Summarizer adapter — OpenAI-compatible LLM calls (`openai-summarizer.ts`)
- Extraction logic — conversation → structured learnings (`summarizer.ts`)

### Session Lifecycle API
- `sessionStart(context)` → `Digest`
- `recall(query, options)` → scored results
- `remember(content, options)` → stored entry
- `sessionEnd(reason, events?)` → optional summarization

If memory init fails, ARIA continues with memory disabled: digest is omitted, recall/remember return unavailable errors.

### Memory Schema
- **Entries:** ULID, kind, content, confidence, pinned flag, timestamps, session_id
- **Scopes:** entry_id → scope label (many-to-many)
- **Embeddings:** entry_id → 384-dim float32 buffer (F32 blob)

### Scope Isolation
Recall uses strict AND scope matching: returned entries must include ALL requested scopes. This prevents cross-context leakage.

> **Honest note:** The MVP uses hash embeddings (deterministic, not semantic). Upgrade path to real embedders (OpenAI, Ollama) is documented in `src/memory/embeddings.ts`. The reinforcement loop (updating confidence based on which memories actually helped) is not yet wired.

## Config

Config files loaded (merge order, later overrides earlier):
1. `~/.aria/aria.config.json`
2. `~/.aria/config.toml`
3. `./aria.config.json`
4. `./aria.config.toml`

```toml
[llm]
provider = "openrouter"   # openrouter | openai | ollama | etc.
model = "anthropic/claude-sonnet-4"

[memory]
enabled = true
summarizer = "openrouter" # or "disabled"
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

Legacy `[bodha]` config is still mapped to `[memory]` if `[memory]` is missing.

## CLI Commands

### Startup
- `aria` — new session
- `aria resume <session_id>` — resume session
- `aria --help` — usage

### Slash Commands (in-session)
`/exit`, `/state`, `/stats`, `/digest`, `/events`, `/recall <query>`, `/model <provider/model>`, `/sessions`, `/debug`, `/help`, `/thinking on|off`

## Key Operational Details

- Session-start banner shows: version, session id, cwd, memory count, digest length, model.
- Per-turn banner shows: state counts, digest chars, recall hits, auto-hydrates, prompt token estimate.
- Session-end summary shows: turns, state object count, successful memory stores.
- Model override is persisted to event log (`system_note`) and restored on resume.
- Memory stores are scoped by context — different projects don't leak into each other's recall.

## Build & Test

- `npm run build` — TypeScript compile (target: ES2022, module: NodeNext)
- `npm test` — Vitest suite (6 files, 23 tests, <500ms)
- Requires Node 22+ and valid provider API keys for full integration tests
