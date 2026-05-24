# AGENTS.md — ARIA MVP Handoff

**ARIA** (Agent with Retrieval, Intent, and Action) is the working name. This document is the complete specification for an MVP. Hand it to any AI coding agent to implement.

## What We're Building

A single-process CLI coding agent that combines two memory systems:

1. **Within-session context management** (from the cnk spec): structured state objects (tasks, decisions, constraints) with active/soft/hard tiers, rendered into a deterministic prompt every turn. Event-sourced via an append-only JSONL log.

2. **Cross-session knowledge base** (from bodha): persistent SQLite-backed memory with confidence decay, semantic recall, and LLM-driven summarization that extracts learnings from completed sessions.

The MVP is a TypeScript CLI. Single process. No daemon, no JSON-RPC, no adapters for other agents. The goal is to prove both ideas work before committing to a larger architecture.

## Directory

```
experiments/agent/        ← this directory (CREATE IT)
experiments/bodha/        ← existing, used as a local dependency
experiments/cnk/          ← existing spec, for reference only (do not import)
```

## MVP Scope (Yes/No)

**YES — build these:**
- CLI loop accepting user input, streaming LLM responses
- JSONL event log (append-only, one file per session)
- In-memory state graph (StateObjects with tiers)
- Deterministic compiler producing the prompt from state + bodha digest + recent turns
- Tools: `shell`, `read_file`, `write_file`, `edit_file`
- Memory tools: `create_task`, `complete_task`, `add_constraint`, `decide`, `soft_unload`, `hydrate`, `recall`, `remember`
- Rule-based tier management (idle timer → demote)
- Integration with bodha: session-start digest injection, `recall`/`remember` tools, session-end summarization

**NO — skip these:**
- Daemon / JSON-RPC / HTTP server
- Multi-session concurrency
- Three-stage Intent Parser (router + local LLM + cloud LLM)
- Post-hoc Extractor (LLM-driven state extraction after turns)
- `candle` / local LLM inference
- Skills system and projectors
- Replay/correctness tooling
- Adapters for Pi/Claude Code/Cursor/etc.
- Cross-SDK conformance tests
- Sub-agents / task delegation

## Architecture

```
User types input
     │
     ▼
┌────────────────────────────────────────────────┐
│  Turn Loop (main.ts)                           │
│                                                │
│  1. Append user_message to JSONL event log     │
│  2. Run Compiler:                              │
│     - Read state graph (in-memory)             │
│     - Read bodha digest (session-start cached) │
│     - Read recent N events from event log      │
│     - Build deterministic prompt string        │
│  3. Send prompt to LLM via Vercel AI SDK       │
│     (OpenRouter default, any provider swappable)│
│  4. SDK handles tool calls → execute → log     │
│  5. SDK resumes LLM with tool results          │
│  6. Append agent_message to event log          │
│  7. Run tier-management rules                  │
└────────────────────────────────────────────────┘
```

### Data Flow at Session Boundaries

```
SESSION START:
  bodha.sessionStart(context) → digest (markdown string)
  Cache digest, inject into compiled prompt
  Create session directory, open events.log

EACH TURN:
  Event log (append) → State graph (mutate via tools)
  State graph + bodha digest + recent events → Compiler → Prompt → LLM

SESSION END:
  bodha.sessionEnd("clean")
  bodha summarizer runs (async, extracts learnings from transcript)
  Close event log
```

## State Model

### StateObject

```typescript
interface StateObject {
  id: string;          // ULID
  kind: "task" | "decision" | "constraint" | "note";
  tier: "active" | "soft" | "hard";
  payload: Record<string, unknown>;
  created: number;     // unix ms
  updated: number;
  lastTouched: number; // for idle-timer tier management
}

// Kind-specific payloads:
interface TaskPayload {
  title: string;
  description?: string;
  status: "todo" | "doing" | "done";
}

interface DecisionPayload {
  summary: string;
  rationale: string;
}

interface ConstraintPayload {
  text: string;
}

interface NotePayload {
  text: string;
}
```

### Event Log

JSONL file at `~/.aria/sessions/<session_id>/events.log`.

```typescript
interface Event {
  event_id: string;    // ULID, monotonic within session
  session_id: string;
  timestamp: number;   // unix ms
  kind: "user_message" | "agent_message" | "tool_call" | "tool_result" |
        "context_action" | "system_note";
  actor: "user" | "agent" | "kernel" | "tool";
  payload: Record<string, unknown>;
}
```

One JSON object per line, `\n` terminated. Append-only. No updates, no deletes.

### Tiers

| Tier | In prompt |
|---|---|
| `active` | Full payload rendered |
| `soft` | One-line stub: `[id] [kind]: [summary]` |
| `hard` | Minimal anchor: `[id] [kind]` |

### Tier Management (rule-based, no LLM)

Run after each turn:

1. For each active object where `(now - lastTouched) > IDLE_SOFT_THRESHOLD` (default: 20 turns) → set tier to `soft`
2. For each soft object where `(now - lastTouched) > IDLE_HARD_THRESHOLD` (default: 50 turns) → set tier to `hard`
3. If compiled prompt exceeds token budget, demote: hard → drop, then soft → hard, then active → soft (least-recently-touched first)

## Compiler (deterministic, pure code)

### Inputs

- State graph (all objects, filtered by tier)
- Bodha digest (cached from session start)
- Recent events from JSONL event log (last N, default N=10)
- Current user input
- Tool schemas (from tool registry)
- Token budget (default: 100,000)

### Output

A single string: the complete system + conversation prompt.

### Section Order

The compiled prompt has exactly these sections, in this order:

```
1. SYSTEM FRAME
   - Fixed text: "You are ARIA, a coding agent with persistent memory."
   - The current working directory
   - The current session ID
   - List of available tools with their schemas

2. CROSS-SESSION MEMORY
   - Inject bodha digest markdown verbatim
   - If bodha digest is empty/not available, omit this section entirely (not "empty" placeholder)
   - Include: "Use recall('query') to search your knowledge base for more."

3. ACTIVE STATE (tier: active objects only)
   For each active object, grouped by kind:

   ## Tasks
   - [id] [status] title
     description (if present)

   ## Decisions
   - [id] summary
     Rationale: rationale

   ## Constraints
   - [id] text

   ## Notes
   - [id] text

   If no active objects: "No active state."

4. PERIPHERAL STUBS (tier: soft and hard)
   - Soft: "[id] [kind]: [summary]" (extract summary from payload: title for tasks, summary for decisions, first 80 chars for notes/constraints)
   - Hard: "[id] [kind]" only
   - Include: "Use hydrate('<id>') to bring any of these into active memory."
   - If no peripheral objects, omit this section entirely.

5. RECENT TURNS (last N events from event log, N configurable, default 10 events)
   Format each event naturally:
   - user_message: "User: text"
   - agent_message: "ARIA: text" (truncate to first 2000 chars if longer)
   - tool_call: "Tool call: tool_name(args)"
   - tool_result: "Result: summary" (truncate to first 500 chars)
   Skip context_action and system_note events.

6. CURRENT INPUT
   - "User: <the current message>"
   - This is the last thing in the prompt so the LLM responds to it.
```

### Determinism Rules

- Iteration order over state objects: sort by `created` ascending, then by `id` (ULID) as tiebreaker.
- No timestamps from `Date.now()` in the compiler output. If a timestamp appears, it comes from a StateObject payload or event, never from the compiler itself.
- Same inputs → byte-identical output. Testable.

## Tools

All tools return a result object `{ ok: boolean, output?: string, error?: string }`.

### Memory Tools (mutation tools for within-session state)

```typescript
// Creates a task with tier: active
create_task({ title: string, description?: string }): { id: string, ok: true }

// Updates task status. Status "done" also changes tier to soft after N turns.
complete_task({ id: string }): { ok: true }
// (Sets task.status = "done", updates lastTouched)

// Creates a constraint with tier: active
add_constraint({ text: string }): { id: string, ok: true }

// Creates a decision with tier: active
decide({ summary: string, rationale: string }): { id: string, ok: true }

// Creates a note with tier: active
add_note({ text: string }): { id: string, ok: true }

// Demotes to soft tier
soft_unload({ id: string }): { ok: true }

// Demotes to hard tier
hard_unload({ id: string }): { ok: true }

// Promotes to active tier, updates lastTouched
hydrate({ id: string }): { ok: true, payload?: object }

// Lists all state objects with id, kind, tier, summary
list_state(): { objects: Array<{id, kind, tier, summary}> }
```

### Cross-Session Knowledge Tools

```typescript
// Searches bodha KB. Wraps bodha's recall().
recall({ query: string, mode?: "standard" | "causal_chain", kinds?: string[] }): {
  ok: true,
  entries: Array<{id, kind, content, confidence, scopes}>
}

// Stores in bodha KB. Wraps bodha's remember().
remember({ content: string, kind?: "preference" | "context_fact" | "decision" | "mistake" | "pattern", certainty?: "high" | "medium" | "low" }): { ok: true, id: string }
```

### System Tools

```typescript
shell({ command: string, timeout?: number }): { ok: boolean, stdout?: string, stderr?: string, exitCode?: number }

read_file({ path: string, offset?: number, limit?: number }): { ok: boolean, content?: string, error?: string }

write_file({ path: string, content: string }): { ok: true }

edit_file({ path: string, oldText: string, newText: string }): { ok: true | false, error?: string }
// Must find exact match of oldText in file. Fails if not unique.
```

### Tool Schemas for the LLM

Use the **Vercel AI SDK's `tool()` helper** from `ai`. Each tool is defined with a `description`, a Zod `parameters` schema, and an `execute` function. The SDK handles provider-specific formatting (Anthropic tool-use blocks, OpenAI function calls, etc.) transparently. No manual JSON Schema wrangling.

Example:

```typescript
import { tool } from "ai";
import { z } from "zod";

const createTask = tool({
  description: "Create a new task in working memory",
  parameters: z.object({
    title: z.string().describe("Task title"),
    description: z.string().optional().describe("Optional details"),
  }),
  execute: async ({ title, description }) => {
    // ... create StateObject, log event, return result
    return { ok: true, id: newId };
  },
});
```

The Zod schema is the single source of truth — the SDK converts it to JSON Schema for whichever provider is active.

## Bodha Integration

### Setup

`bodha` is a local dependency. In `package.json`:

```json
{
  "dependencies": {
    "bodha": "file:../bodha/packages/core"
  }
}
```

Import and configure at startup:

```typescript
import { InProcessClient, SqliteMemoryBackend, openDatabase, 
         StubEmbeddingsProvider, DisabledSummarizer } from "bodha";

// For MVP: use DisabledSummarizer (no auto-extraction).
// The summarizer is triggered manually at session end.
// If the user has Ollama running, use OllamaSummarizer instead — 
// detect via config or environment variable ARIA_SUMMARIZER=ollama.
```

### Session Start

```typescript
const digest = await bodha.sessionStart({
  agent: "aria",
  user_id: hash(os.userInfo().username),  // sha256 of username
  time: Date.now(),
  context_id: hash(cwd),                  // sha256 of cwd path
  context_label: path.basename(cwd),
  working_context: {
    repo: {
      root: cwd,
      name: path.basename(cwd),
      // git remote URL if available, else null
    }
  }
});
// Cache digest.markdown for all turns in this session.
```

### Tools

`recall` and `remember` call bodha's `recall()` and `remember()` methods directly. Log each call as a `tool_call` + `tool_result` event pair.

### Session End

```typescript
await bodha.sessionEnd(reason); // "clean" | "aborted" | "error"

// If a summarizer is configured (Ollama), trigger summarization.
// If DisabledSummarizer, just close cleanly.
// The summarizer runs async — fire and forget.
```

### Fallback: No Bodha

If `bodha` fails to load or initialize (missing sqlite, whatever), the agent MUST still work. Skip section 2 in the compiler, disable `recall` and `remember` tools, log a warning. Graceful degradation.

## Event Log

### Location

```
~/.aria/sessions/<session_id>/events.log
```

Where `<session_id>` is a ULID generated at session start. Also write `meta.json`:

```json
{
  "session_id": "...",
  "started_at": 1717000000000,
  "cwd": "/home/user/projects/foo",
  "agent": "aria"
}
```

### Append Protocol

```typescript
function appendEvent(logPath: string, event: Event): void {
  // 1. fill event_id (ULID), session_id, timestamp if missing
  // 2. serialize to JSON (single line, no pretty-print)
  // 3. append + '\n' to file
  // 4. fsync the fd
}
```

No lock needed for single-process MVP. Events are never read during the session except by the compiler (which reads the last N lines).

### Never, Ever

- Delete an event
- Rewrite an event
- Update an event in-place
- Truncate the log

A correction is a new event that supersedes the prior one.

## Session Lifecycle

```
aria                       # start session in cwd
aria resume <session_id>   # resume existing session
aria --help                # show usage
```

### New Session

1. Generate session ULID
2. Create `~/.aria/sessions/<session_id>/` directory
3. Create `meta.json`
4. Create empty `events.log`
5. Initialize bodha, call `sessionStart`, cache digest
6. Initialize empty state graph
7. Enter turn loop

### Resume Session

1. Read `meta.json` to verify session exists
2. Open `events.log`
3. Initialize bodha (no sessionStart — the digest was cached, but skip it for resumed sessions; or regenerate)
4. Rebuild state graph by replaying `context_action` events from the log
5. Enter turn loop

### Turn Loop

```
while (true) {
  userInput = await readUserInput();  // "> " prompt, readline
  if (!userInput || userInput === "/exit") break;
  
  // Handle slash commands
  if (userInput.startsWith("/")) {
    handleSlashCommand(userInput);
    continue;
  }
  
  await runTurn(userInput);
}
```

`/exit` — clean shutdown (calls sessionEnd, closes logs).

`/state` — calls list_state and prints to console.

`/digest` — prints the cached bodha digest.

### LLM Interaction

Use the **Vercel AI SDK** (`ai` + `@ai-sdk/openai` provider). The SDK gives provider-agnostic streaming, tool calling, and message management. **Start with OpenRouter** as the default provider — one API key gives access to hundreds of models. Swapping to a different provider later is a one-line config change.

**Environment variables:**
- `OPENROUTER_API_KEY` (required)
- `ARIA_MODEL` (default: `anthropic/claude-sonnet-4-20250514`)

All models use the OpenRouter model string format: `provider/model-name`. Examples:
- `anthropic/claude-sonnet-4-20250514`
- `openai/gpt-4o`
- `google/gemini-2.5-flash`
- `anthropic/claude-haiku-4.5`

**How it works:**

Configure the provider with a custom `baseURL` pointing to OpenRouter:

```typescript
import { createOpenAI } from "@ai-sdk/openai";

const openrouter = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  headers: {
    "HTTP-Referer": "https://github.com/aria",  // your app URL
    "X-Title": "ARIA",
  },
});
```

Use `streamText()` from `ai` — it handles streaming, tool calls, and multi-step execution automatically:

```typescript
import { streamText } from "ai";

const result = streamText({
  model: openrouter(process.env.ARIA_MODEL ?? "anthropic/claude-sonnet-4-20250514"),
  system: compiledSystemPrompt,
  messages: conversationHistory,
  tools: allToolDefinitions,
  maxSteps: 25,  // max tool-call rounds per turn
  onStepFinish: ({ stepNumber, text, toolCalls, toolResults }) => {
    // Log tool_call + tool_result events here
    // Track turn count for tier management
  },
});

// Stream text to stdout
for await (const delta of result.textStream) {
  process.stdout.write(delta);
}
```

### Tool-Result Loop

The Vercel AI SDK handles multi-step tool calling automatically via `maxSteps`. The flow is:

1. `streamText()` sends the prompt with tool definitions
2. When the model returns tool calls, the SDK pauses the stream
3. The SDK calls the `execute` function on each tool
4. **Inside each tool's `execute`:**
   - Log `tool_call` event BEFORE execution
   - Execute the actual tool logic
   - Log `tool_result` event AFTER execution
   - Return the result
5. The SDK appends tool results to the conversation and resumes the LLM
6. Repeats until the model produces a text response or `maxSteps` (25) is exhausted

**No manual message management needed.** The SDK appends tool results with the correct role for whichever provider is active.

After `streamText()` completes, log the final `agent_message` event. The accumulated text is available from `result.text` (await the promise).

The `onStepFinish` callback fires after each step (initial text generation + each tool-call round). Use it to increment the turn counter for tier management.

## Config

`~/.aria/config.toml` (TOML format, optional, all keys have defaults):

```toml
[llm]
provider = "openrouter"      # "openrouter" | "anthropic" | "openai" | "google"
model = "anthropic/claude-sonnet-4-20250514"
# base_url = "https://api.anthropic.com/v1"  # auto-set for openrouter, override for direct provider

[bodha]
enabled = true               # false to disable cross-session memory entirely
summarizer = "disabled"      # "disabled" | "ollama"

[compiler]
token_budget = 100000
recent_turns = 10

[tiers]
idle_soft_after_turns = 20
idle_hard_after_turns = 50

[session]
log_dir = "~/.aria/sessions"
```

## Slash Commands

```
/exit           End session (calls bodha.sessionEnd, closes logs)
/state          Print all state objects with tier and summary
/digest         Print the bodha digest for this session
/events         Print last 20 events from the log
/recall <query> Manual recall search (for debugging)
/model <name>   Switch model mid-session (e.g. /model openai/gpt-4o)
/help           Show available commands
```

## Package.json

```json
{
  "name": "aria",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/main.js",
    "dev": "tsx src/main.ts"
  },
  "dependencies": {
    "bodha": "file:../bodha/packages/core",
    "better-sqlite3": "^11.0.0",
    "ai": "^4.0.0",
    "@ai-sdk/openai": "^1.0.0",
    "zod": "^3.23.0",
    "ulid": "^2.3.0",
    "toml": "^3.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.16.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0"
  }
}
```

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

## Implementation Order

The files you create, in order. Each file should be complete before moving to the next.

### Phase 1: Skeleton (Day 1)

1. **`package.json`** and **`tsconfig.json`** — as above
2. **`src/types.ts`** — all TypeScript interfaces and types (StateObject, Event, all tool input/output types, Config type)
3. **`src/config.ts`** — load config from `~/.aria/config.toml`, merge with defaults
4. **`src/event-log.ts`** — EventLog class:
   - `constructor(sessionId, logDir)`: create directory and events.log
   - `append(event)`: append JSON line + fsync
   - `readLast(n)`: read last N events from log
   - `replayContextActions()`: return all context_action events (for state rebuild on resume)
   - `close()`: close fd

### Phase 2: State Graph (Day 1-2)

5. **`src/state-graph.ts`** — StateGraph class:
   - `create(kind, payload)`: create StateObject, return it
   - `update(id, patch)`: update payload fields, bump updated/lastTouched
   - `setTier(id, tier)`: change tier, bump lastTouched
   - `get(id)`: get object by id
   - `getActive()`: all tier:active objects sorted by created asc, id asc
   - `getPeripheral()`: all tier:soft + tier:hard objects sorted by updated desc
   - `list()`: all objects with summary
   - `snapshot()`: all objects (for event logging)
   - `applyTierManagement(idleSoft, idleHard)`: apply idle-timer rules, return list of objects that changed tier

### Phase 3: Compiler (Day 2-3)

6. **`src/compiler.ts`** — pure function `compile(options) → string`:
   - Input: stateGraph, bodhaDigest, recentEvents, userInput, toolSchemas, cwd, sessionId, tokenBudget
   - Output: prompt string in the 6-section format specified above
   - Deterministic: same inputs → same string
   - If output exceeds tokenBudget, trim peripheral stubs then recent turns, return truncated prompt + log warning

### Phase 4: Tool Registry (Day 3-4)

7. **`src/tools/index.ts`** — builds the tool definitions for Vercel AI SDK:
   - Imports all tool modules
   - Returns an object of `{ toolName: tool({...}) }` ready to pass to `streamText()`
   - Each tool's `execute` function has access to the session context (event log, state graph, bodha client)

8. **`src/tools/memory.ts`** — state mutation tools (create_task, complete_task, add_constraint, decide, add_note, soft_unload, hard_unload, hydrate, list_state)
   - Each tool's `execute`: logs a `context_action` event, mutates state graph, returns result
   - Exports factory function `createMemoryTools(ctx)` where ctx has `{ eventLog, stateGraph }`

9. **`src/tools/knowledge.ts`** — bodha tools (recall, remember)
   - Each tool's `execute`: calls bodha client methods, logs `tool_call` + `tool_result` events
   - Falls back gracefully if bodha is disabled/unavailable
   - Exports factory function `createKnowledgeTools(ctx)` where ctx has `{ eventLog, bodhaClient, bodhaEnabled }`

10. **`src/tools/system.ts`** — system tools (shell, read_file, write_file, edit_file)
    - `shell`: spawn child process, capture stdout/stderr, timeout support
    - `read_file`: read file with optional offset/limit, handle missing file
    - `write_file`: create/overwrite file, create parent directories
    - `edit_file`: find exact oldText match, replace with newText, fail if not unique
    - Exports factory function `createSystemTools(ctx)` where ctx has `{ eventLog, cwd }`

### Phase 5: LLM Client (Day 4)

11. **`src/llm.ts`** — LLM client using Vercel AI SDK:
    - `createProvider(config)`: creates the configured provider instance
      - OpenRouter: `createOpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey, headers })`
      - Direct OpenAI: `createOpenAI({ apiKey })`
      - Direct Anthropic: `createAnthropic({ apiKey })` (requires `@ai-sdk/anthropic` if added)
    - `createModel(provider, modelString)`: returns the model instance for `streamText()`
    - No manual stream handling, no provider-specific tool parsing — the SDK does it all

### Phase 6: Session & Turn Loop (Day 5)

12. **`src/session.ts`** — Session class:
    - `start()`: create session directory, event log, state graph, bodha init, digest
    - `resume(sessionId)`: rebuild state from event log
    - `end(reason)`: close bodha, close event log

13. **`src/turn.ts`** — `runTurn(session, userInput)` function:
    - Append user_message event
    - Compile prompt
    - Build tool definitions via tool registry
    - Call `streamText()` with compiled prompt + tools
    - Stream text output to stdout
    - Use `onStepFinish` to log tool events and track turn count
    - After stream completes, append agent_message event
    - Apply tier management
    - Return agent response text

### Phase 7: CLI Shell (Day 5-6)

14. **`src/main.ts`** — entry point:
    - Parse CLI args (`aria`, `aria resume <id>`)
    - Load config
    - Create/resume session
    - Readline loop
    - Handle `/` commands
    - Handle Ctrl+C (ask "/exit to save session")
    - On exit: session.end("clean")

### Phase 8: Test Drive & Fix (Day 6-7)

15. Use the agent on a real task. Fix bugs. Observe:
    - Does the compiler output look right?
    - Do tier-management rules trigger appropriately?
    - Does bodha recall return useful results?
    - Are tool calls being logged correctly?
    - Does the Vercel AI SDK stream smoothly through multiple tool-call rounds?

## Success Criteria

The MVP works when:

1. **Deterministic compilation**: same state + same events → byte-identical prompt. Write a test for this.
2. **Event log integrity**: every user message, agent response, tool call, tool result, and context action is logged. The log is human-readable JSONL.
3. **State persistence**: tasks, decisions, constraints survive across turns within a session. On resume, the state is rebuilt from the event log.
4. **Tier management works**: tasks idle for 20+ turns get SOFT_UNLOAD'd. The prompt shows them as one-liners. `hydrate()` brings them back.
5. **Bodha integration works**: digest appears at session start. `recall("query")` returns relevant past learnings. `remember("fact")` stores for future sessions.
6. **Graceful degradation**: if bodha fails to load, the agent still works (just without cross-session memory). No crashes.
7. **All tools work**: shell executes commands, read/write/edit manipulate files, memory tools update the state graph. Errors are handled and reported to the LLM.
8. **Streaming output**: the LLM's response streams to the terminal in real time via the SDK.
9. **Single `npm install && npm run build && npm start`** should work on any machine with Node 22+ and an `OPENROUTER_API_KEY`.
10. **Provider swap works**: changing `provider = "openai"` and setting `OPENAI_API_KEY` should work without code changes.

## Notes for the Implementing Agent

- **Keep it simple.** The goal is a working MVP, not a production system. Don't over-engineer error handling or edge cases.
- **Prefer working over perfect.** If a choice between "done today" and "beautiful abstraction," pick done today.
- **The cnk spec in `../cnk/SPEC.md` is for reference.** The MVP implements a simplified subset. Do not import from it. Do not replicate its full complexity.
- **The bodha package at `../bodha/packages/core` is already built and tested.** Use it as a dependency. Read its types from `../bodha/packages/core/src/index.ts` to understand the API surface.
- **Test the compiler first.** It's the core of the system. Write a unit test that verifies deterministic output before moving on.
- **Logging is your debugger.** Log every state mutation, every tool call, every compiler run. JSONL is both the canonical store and your debug trace.
- **The Vercel AI SDK docs are at https://sdk.vercel.ai/docs.** Reference them for `streamText()`, `tool()`, and provider setup. The package is `ai` on npm, providers are `@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.
- **OpenRouter's API is OpenAI-compatible.** That's why `@ai-sdk/openai` with a custom `baseURL` works. No special OpenRouter package needed (though `@openrouter/ai-sdk-provider` exists if you prefer a dedicated wrapper).
