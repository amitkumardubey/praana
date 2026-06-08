# Core Concepts in ARIA

This document explains the key ideas behind ARIA's two adaptive systems.

---

## Adaptive Context

**Adaptive Context** is ARIA's within-session working memory. Rather than treating all prior state equally, ARIA organises state objects into three tiers. The result: what you're actively working on gets full representation; older context compresses to stubs. The model always gets a clean, high-signal context window — not a growing dump of everything that has happened.

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
- **Automatic** — before each prompt, ARIA extracts keywords from your input and matches them against peripheral objects. Matches promote automatically.
- **Manual** — the agent can call `hydrate(id)` to explicitly promote an object.

### Why This Matters

A session with 50 state objects, rendered flat, would consume thousands of tokens on every turn. With tiering, only the active objects (typically 5–15) get full representation. The rest exist as stubs or anchors — still accessible, but not burning tokens. Measured token savings on peripheral state: **70–88%** compared to flat rendering.

### Retraction (Tombstone Semantics)

When the agent or user wants an object gone from working memory — a stale task, a wrong decision, a duplicate — the `retract_task(id)` tool tombstones it instead of deleting it. The object is hidden from all reads (`getActive`, `getPeripheral`, `list`, prompt compilation), but the row stays in the event log and in-memory map so:

- `aria resume <id>` can replay history faithfully.
- The action is auditable: a `retract` `context_action` event is logged with the object ID and kind.

The same tombstone pattern applies in Cognitive Memory via `forget_memory(id)` — the `retracted` column is set to 1, the row is excluded from recall and digest, and it remains in the database for audit.

---

## Cognitive Memory

**Cognitive Memory** is ARIA's cross-session persistence layer.

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

At session start, ARIA builds a ranked digest from memory in scope for the current session.

### Scoping

Every memory entry carries scope labels: `user:<hash>`, `agent:aria`, and `context:<cwd_hash>`. Recall enforces strict AND-scoping — a memory is only returned if it carries *all* scopes in the query.

Project-level memories carry all three scopes — only visible within that project. Global memories carry only `user` and `agent` scopes, making them visible in any project session. Recall enforces AND-scoping in all cases; cross-scope merge behavior is still being completed.

### Ranking and Confidence

Recalled memories are ranked by a fusion of three signals:
- **Vector similarity** — how close the query is to the stored content
- **Confidence** — starts at `high` (0.8), `medium` (0.5), or `low` (0.3) based on extraction certainty, then decays at 5% per day
- **Recency** — entries accessed recently receive a small boost
- **Pinned** — explicitly pinned entries receive a strong boost and are always included in the digest

### Embeddings — Honest Note

ARIA supports multiple embedders: `auto` (Ollama probe then fallback), `ollama`, `transformers`, `llama-cpp`, and `hash`.

When `hash` is used, vectors are deterministic but **not semantically meaningful**. "Fix login bug" and "repair authentication defect" produce different vectors. When vector search returns nothing useful, ARIA falls back to scope-based retrieval.

### Session Lifecycle

**Session start:** ARIA queries the memory store for all entries in scope, ranks them, and builds a markdown digest. This digest is included in the system prompt on every turn.

**Session end** (`/exit`): ARIA sends the full transcript to a summariser model. The summariser extracts up to 5 learnings and returns them as structured JSON. Each learning is stored as a new memory entry with an initial confidence score. The summariser is configurable — disabled if no API key is available.

---

## How the Two Systems Relate

Adaptive Context and Cognitive Memory are complementary but distinct:

| | Adaptive Context | Cognitive Memory |
|---|---|---|
| Scope | Within a session | Across sessions |
| Storage | In-memory (StateGraph) | SQLite on disk |
| Managed by | Agent tools + automatic demotion | Session end extraction + agent tools |
| Purpose | Curate what the model sees *right now* | Preserve what was learned *over time* |

At session start, the memory digest from Cognitive Memory is injected into the context compiled by Adaptive Context. The two systems share the same context window — memory takes up one section of the compiled prompt alongside active state, peripheral stubs, and recent turns.
