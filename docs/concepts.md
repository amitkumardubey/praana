# Core Concepts in PRAANA

This document explains the key ideas behind PRAANA's two adaptive systems.

---

## Adaptive Context

**Adaptive Context** is PRAANA's within-session working memory, active in **engine mode only**. Rather than treating all prior state equally, PRAANA organises state objects into three tiers. The result: what you're actively working on gets full representation; older context compresses to stubs. The model always gets a clean, high-signal context window — not a growing dump of everything that has happened.

In **classic mode**, Adaptive Context is not exposed — no StateGraph tools, no tier sections in the prompt. The full event log serves as working memory instead.

### State Objects

State objects are the units of working memory. Four kinds:

| Kind | What it tracks |
|---|---|
| `task` | A piece of work: title, description, status |
| `decision` | An architectural or design choice with rationale |
| `constraint` | A rule that must always hold |
| `note` | A general observation or reference |

### Tiers

Every state object lives in one of three tiers:

| Tier | What the model sees | When |
|---|---|---|
| **Active** | Full payload | Currently relevant |
| **Soft** | One-line summary | Idle for N turns (default: 20) |
| **Hard** | ID only — minimal anchor | Idle for N turns (default: 50) |

Demotion happens automatically at the end of each turn based on how many turns have passed since the object was last touched. The thresholds are configurable (`idle_soft_after_turns`, `idle_hard_after_turns`).

Promotion (`hard` or `soft` → `active`) happens in two ways:
- **Automatic** — before each prompt, PRAANA extracts keywords from your input and matches them against peripheral objects. Matches promote automatically.
- **Manual** — the agent can call `hydrate(id)` to explicitly promote an object.

### Why This Matters

A session with 50 state objects, rendered flat, would consume thousands of tokens on every turn. With tiering, only the active objects (typically 5–15) get full representation. The rest exist as stubs or anchors — still accessible via `hydrate` or keyword auto-promotion, but not repeated in full every turn.

### Retraction (Tombstone Semantics)

When the agent or user wants an object gone from working memory — a stale task, a wrong decision, a duplicate — the `retract_task(id)` tool tombstones it instead of deleting it. The object is hidden from all reads (`getActive`, `getPeripheral`, `list`, prompt compilation), but the row stays in the event log and in-memory map so:

- `praana resume <session_id>` can replay history faithfully.
- The action is auditable: a `retract` `context_action` event is logged with the object ID and kind.

The same tombstone pattern applies in Cognitive Memory via `forget_memory(id)` — the `retracted` column is set to 1, the row is excluded from recall and digest, and it remains in the database for audit.

---

## Session Checkpoint (Context Engine)

When `context_engine.enabled = true`, PRAANA maintains a **SessionCheckpoint** — a structured within-session summary reconciled after every turn from a deterministic `TurnDigest`. Unlike Adaptive Context (tiered state objects the agent manages via tools), the checkpoint is assembled automatically and pinned in the prompt so it survives when older turns fall out of the verbatim window.

### Checkpoint sections

| Section | What it preserves |
|---|---|
| Active request | The latest user intent |
| Session narrative | A rolling prose "story so far" from meaningful turns (decisions, file writes, errors, intent changes) |
| Plan | Current plan plus superseded plans with completion hints |
| Constraints | Append-only rules — never dropped. Includes auto-extracted "not X, Y" corrections. Other preferences ("let's use", "we use") rely on the system prompt nudge directing the LLM to call `add_constraint` |
| Decisions | Architectural choices with rationale (rationale survives age-based compaction) |
| Files / findings / errors / activity | Structured operational state |

### Conversational context

Turns 0–2 appear verbatim in the prompt. Turns 3–6 appear as scored digests. From turn 7 onward, information only survives if the checkpoint captured it. The narrative, plan history, retained decision rationale, and implicit constraint extraction address the most common gaps where conversational knowledge was previously lost.

The checkpoint is written from `TurnDigest` data only — never by the LLM — to prevent summarisation drift. For deep reasoning chains or full exploration history, the agent should still use `search_turn_events` or `retrieve_artifact`.

### Current status (honest)

Engine mode is **off by default** (`context_engine.enabled = false`). We have not benchmarked it against classic mode or other agents. The table below reflects real behaviour today, not a marketing claim.

| Area | Status | Notes |
|---|---|---|
| Tool output management | Works | Distillation at ingestion, artifact store, `retrieve_artifact` when the card is not enough |
| Structured checkpoint state | Works | Constraints (append-only), errors (open vs fixed), decisions, files, activity |
| Session narrative & plan history | Works | Rolling prose and superseded plans from deterministic `TurnDigest` |
| Decision rationale | Works | Rationale retained after compaction (capped per entry) |
| Implicit user corrections | Improved | Auto-extraction of "not X, use Y" patterns into constraints; agent should still call `add_constraint` for important rules |
| Old user intent (full text) | Partial | Only the latest request in **Active request**; earlier intent may survive in narrative if captured |
| Deep reasoning chains | Gap | Narrative captures *what* happened, not full multi-step *why* — use `search_turn_events` or `retrieve_artifact` |
| Contradiction detection | Gap | Old and new decisions can coexist in the checkpoint without an explicit alert |
| Cross-session continuity | Memory layer | Within-session checkpoint does not replace Cognitive Memory for the next session |

Classic mode remains the simpler baseline: full verbatim transcript, no checkpoint or tiering. Enable the engine when you want structured session state and distillation; expect rough edges on long conversational threads.

---

## Classic Mode

When `context_engine.enabled = false` (or enabled but the engine fails to initialize), PRAANA runs in **classic mode** via `src/compile-classic.ts`.

Classic mode is intentionally simple:

- **Full verbatim history** — every user message, agent reply, and tool result from the session event log, with no token-budget truncation.
- **No Adaptive Context** — no `create_task`, `decide`, tier demotion, or auto-hydrate. Working memory is the transcript itself.
- **No context engine** — no distillers, artifact store, checkpoint, turn ledger, or scored compilation.
- **Skills as catalog** — discovered skill names and paths are listed in the prompt; the agent reads `SKILL.md` files with `read_file` when needed. No BM25 matching or hot/warm/cold residency.
- **Cognitive Memory unchanged** — cross-session `recall` / `remember` and the session-start digest still work.

Classic mode is a simpler alternative when the context engine is disabled or unavailable. Set `measurement_mode = true` to record engine-style telemetry while running classic (for internal debugging only).

---

## Cognitive Memory

**Cognitive Memory** is PRAANA's cross-session persistence layer.

### Memory Kinds

Six kinds of knowledge, each with distinct semantics:

| Kind | What it stores | Example |
|---|---|---|
| `fact` | Verifiable project knowledge | `"Uses Vitest for testing"` |
| `preference` | Working style preferences | `"Prefers functional components over classes"` |
| `decision` | Architectural choices made | `"JWT over session cookies — simpler for this API"` |
| `pattern` | Recurring approaches that work | `"Zod validation before every DB write"` |
| `mistake` | A failure and the lesson extracted | `"Forgot await on verify() → 401s on all routes"` |
| `constraint` | A rule that must always hold | `"Never commit .env files"` |

`pattern`, `mistake`, and `constraint` are particularly valuable — they encode *what was learned from experience*, not just what happened.

### Memory Levels

Entries exist at two levels:

**Project-level** — scoped to the current working directory. Only visible in sessions started from that project. Most `fact`, `decision`, and `pattern` entries belong here.

> `"Uses Vitest for testing"` · `"JWT over session cookies for this API"` · `"Auth middleware lives in src/lib/auth"`

**Global** — scoped to the user across all projects. Preferences, personal constraints, and universal working patterns that apply everywhere.

> `"Always write tests before implementation"` · `"Never use any in TypeScript"` · `"Prefer functional over class-based components"`

At session start, PRAANA builds a ranked digest from memory in scope for the current session.

### Scoping

Every memory entry carries scope labels: `user:<hash>`, `agent:praana`, and `context:<cwd_hash>`. Recall enforces strict AND-scoping — a memory is only returned if it carries *all* scopes in the query.

Project-level memories carry all three scopes — only visible within that project. Global memories carry only `user` and `agent` scopes, making them visible in any project session. In project sessions, recall and the session-start digest query both scopes and merge results (global entries never carry `context:`). Ranking is unified; there is no automatic override when a global preference and a project fact disagree — both can appear until one is retracted or decays.

### Ranking and Confidence

Recalled memories are ranked by a fusion of three signals:
- **Vector similarity** — how close the query is to the stored content
- **Confidence** — starts at `high` (0.8), `medium` (0.5), or `low` (0.3) based on extraction certainty, then decays at 5% per day
- **Recency** — entries accessed recently receive a small boost
- **Pinned** — explicitly pinned entries receive a strong boost and are always included in the digest
- **Tool outcomes** — memories recalled before a successful tool call receive a confidence boost (#45); broader “useful → stronger, ignored → fade” behaviour is still ongoing

### Embeddings — Honest Note

PRAANA supports multiple embedders: `auto` (Transformers.js when installed, else keyword-only), `transformers`, `transformers-nomic`, and `ollama`.

When no semantic embedder is available, recall uses **keyword-only search** (FTS) — never fake vectors.

### Session Lifecycle

**Session start:** PRAANA queries the memory store for all entries in scope, ranks them, and builds a markdown digest. This digest is included in the system prompt on every turn.

**Session end** (`/exit`): PRAANA sends the full transcript to a summariser model. The summariser extracts up to 5 learnings and returns them as structured JSON. Each learning is stored as a new memory entry with an initial confidence score. The summariser is configurable — disabled if no API key is available.

---

## Tooling

PRAANA's tool surface is small and deliberately shared across modes. The goal: every tool the agent reaches for returns a **structured, bounded response** — never a wall of unparsed text. Distillers downstream of these tools keep large outputs from polluting the context.

| Category | Tools | Mode |
|---|---|---|
| Codebase exploration | `read_file`, `read_and_summarize`, `search_code` (ripgrep-backed, JSON output) | Both |
| File mutation | `write_file`, `edit_file`, `batch_write`, `batch_edit` | Both |
| Shell | `shell` (with optional sandbox allowlist) | Both |
| Session search | `search_session_log` (in-session events) | Both |
| Cognitive Memory | `recall`, `remember`, `forget_memory` | Both |
| Adaptive Context | `create_task`, `decide`, `add_constraint`, `add_note`, `hydrate`, `soft_unload`, `hard_unload`, `list_state` | Engine |
| Context engine | `retrieve_artifact`, `context_summary`, `search_turn_events`, `event_lineage` | Engine |

`search_code` (#105) is the newest addition. It wraps `rg --json` and returns `{ matches: [{ file, line, column, text, context_before, context_after }], stats: { totalMatches, filesWithMatches, truncated } }` — file:line:column matches with optional context, glob include/exclude, and `max_results` truncation. Ripgrep is resolved from `$PATH` by default; the `[search_code] rg_path` config overrides the binary. Large outputs flow through the ripgrep distiller automatically.

---

## How the Two Systems Relate

Adaptive Context and Cognitive Memory are complementary but distinct:

| | Adaptive Context | Cognitive Memory |
|---|---|---|
| Scope | Within a session | Across sessions |
| Storage | In-memory (StateGraph) | SQLite on disk |
| Managed by | Agent tools + automatic demotion | Session end extraction + agent tools |
| Purpose | Curate what the model sees *right now* | Preserve what was learned *over time* |

At session start, the memory digest from Cognitive Memory is injected into the context compiled by Adaptive Context. The two systems share the same context window — memory takes up one section of the compiled prompt alongside active state, peripheral stubs, and recent turns (engine mode), or alongside the full verbatim transcript (classic mode).
