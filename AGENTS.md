# AGENTS.md — ARIA MVP Handoff (Current Implementation)

This document describes the **actual ARIA MVP architecture currently implemented** in this repo.

## What ARIA Is

ARIA is a single-process TypeScript CLI coding agent with two adaptive memory systems:

1. **Adaptive Context** — within-session working memory
- In-memory state graph (`task`, `decision`, `constraint`, `note`)
- Tiered retention (`active`, `soft`, `hard`)
- Event-sourced via append-only JSONL (`context_action` events)

2. **Adaptive Memory** — cross-session persistent memory
- SQLite-backed memory store in `src/memory/`
- Confidence/recency ranking + scope filtering
- Session digest generation at session start
- Optional summarizer-driven learning extraction at session end

No daemon, no RPC server, no multi-process coordination.

## Current Directory

```text
experiments/agent/
  src/
    main.ts
    turn.ts
    session.ts
    compiler.ts
    event-log.ts
    state-graph.ts
    tools/
    memory/
```

## Runtime Architecture

```text
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

```text
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

## State Model

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

Tier behavior in prompts:
- `active`: full payload
- `soft`: summarized one-liner
- `hard`: minimal anchor

Tier management in `turn.ts`:
- active → soft after `idle_soft_after_turns`
- active/soft → hard after `idle_hard_after_turns`

## Event Log

Location:

```text
~/.aria/sessions/<session_id>/events.log
```

Each line is one JSON event:
- `user_message`
- `agent_message`
- `tool_call`
- `tool_result`
- `context_action`
- `system_note`

Append protocol is durable (`writeSync` + `fsyncSync` on open fd).

## Compiler

`src/compiler.ts` builds deterministic prompt sections:
1. System
2. Adaptive Memory digest (if present)
3. Active State
4. Peripheral State (if present)
5. Recent Turns (skips `context_action`/`system_note`)
6. Current Input (when passed)

Notes:
- Deterministic ordering (state by created/id)
- Token estimation support via `compileWithMetrics()`
- Recent-turns section has its own token budget (`recent_turns_token_budget`)

## Tools

Defined with Vercel AI SDK `tool()` + Zod schemas.

Adaptive Context tools:
- `create_task`, `complete_task`
- `add_constraint`, `decide`, `add_note`
- `soft_unload`, `hard_unload`, `hydrate`
- `list_state`

Adaptive Memory tools:
- `recall`
- `remember`

System tools:
- `shell` (async spawn with timeout handling)
- `read_file`
- `write_file`
- `edit_file` (exact-match, unique replacement)

## Adaptive Memory (`src/memory`)

Implemented as internal ARIA module (not external Bodha dependency).

Key components:
- `MemoryStore` (`store.ts`)
- SQLite layer (`db.ts`)
- embedder (`embeddings.ts`)
- summarizer adapter (`openai-summarizer.ts`)
- extraction logic (`summarizer.ts`)

Session lifecycle API:
- `sessionStart(context) -> Digest`
- `recall(query, options)`
- `remember(content, options)`
- `sessionEnd(reason, events?)`

If memory init fails:
- ARIA continues with memory disabled
- digest is omitted
- `recall`/`remember` return unavailable errors

## Config

Config files loaded (merge order, later overrides earlier):
1. `~/.aria/aria.config.json`
2. `~/.aria/config.toml`
3. `./aria.config.json`
4. `./aria.config.toml`

Main config shape:

```toml
[llm]
provider = "openrouter"   # openrouter | openai | ollama
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

Backward-compat note:
- Legacy `[bodha]` config is still mapped to `[memory]` if `[memory]` is missing.

## Environment Variables

- `OPENROUTER_API_KEY` (required for `provider=openrouter`)
- `OPENAI_API_KEY` (required for `provider=openai`, also used by summarizer if OpenRouter key absent)
- `ANTHROPIC_API_KEY` (accepted by generic provider path)
- `ARIA_MODEL` (overrides configured model)
- `ARIA_SUMMARIZER_MODEL` (summarizer model override)

No `BODHA_SUMMARIZER_MODEL` fallback anymore.

## CLI Commands

Startup:
- `aria`
- `aria resume <session_id>`
- `aria --help`

Slash commands:
- `/exit`, `/quit`
- `/state`
- `/stats`
- `/digest`
- `/events`
- `/recall <query>`
- `/model <provider/model>`
- `/sessions`
- `/debug`
- `/help`

## Key Operational Details

- Session-start banner shows: session id, cwd, memory count, digest length, model.
- Per-turn banner shows: state counts, digest chars, recall hits, auto-hydrates, prompt token estimate.
- Session-end summary shows: turns, state object count, successful memory stores.
- Model override is persisted to event log (`system_note`) and restored on resume.

## Build/Test

- `npm run build`
- `npm test`

Current baseline should pass with Node 22+ and valid provider keys.
