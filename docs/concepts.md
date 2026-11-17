# Core Concepts in PRAANA

This document explains the key ideas behind PRAANA's two adaptive systems.

---

## Adaptive Context

**Adaptive Context** is PRAANA's within-session working memory, active in **engine mode**. Engine mode is the default; classic mode is available by setting `[context_engine] enabled = false` or when engine initialization fails. Rather than treating all prior state equally, PRAANA organises state objects into three tiers. The result: what you're actively working on gets full representation; older context compresses to stubs. The model always gets a clean, high-signal context window — not a growing dump of everything that has happened.

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

Promotion (`hard` or `soft` → `active`) happens in three ways:
- **Substring keyword match** — before each prompt, PRAANA extracts keywords from your input (alphanumeric strings ≥3 chars, filtering common stop words) and matches them against peripheral objects. Matches promote automatically.
- **BM25 relevance match** — peripheral objects with no substring keyword match are scored with `bm25Relevance(query, text)`. Objects above threshold (0.15) promote automatically, catching fuzzy overlap like "S3 upload" ↔ "AWS bucket".
- **Manual** — the agent can call `hydrate(id)` to explicitly promote an object.

### Why This Matters

A session with 50 state objects, rendered flat, would consume thousands of tokens on every turn. With tiering, only the active objects (typically 5–15) get full representation. The rest exist as stubs or anchors — still accessible via `hydrate` or keyword auto-promotion, but not repeated in full every turn.

### Retraction (Tombstone Semantics)

When the agent or user wants an object gone from working memory — a stale task, a wrong decision, a duplicate — the `retract_task(id)` tool tombstones it instead of deleting it. The object is hidden from all reads (`getActive`, `getPeripheral`, `list`, prompt compilation), but the row stays in the event log and in-memory map so:

- `praana resume <session_id>` can replay history faithfully.
- The action is auditable: a `retract` `context_action` event is logged with the object ID and kind.

File Memory has no tombstones: `forget_memory({ name, scope? })` hard-deletes the memory file.

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

Turns aged 0–2 appear verbatim in the prompt; turns aged 3–6 can appear as scored digests. Older content may leave the prompt unless captured by the checkpoint, but canonical session records remain searchable with `search_transcript`, including compacted/stubbed turns (current reset epoch by default; `include_previous_resets=true` accesses earlier `/clear` epochs). The narrative, plan history, retained decision rationale, and implicit constraint extraction keep useful context in the prompt without replacing transcript recovery.

The checkpoint is written from `TurnDigest` data only — never by the LLM — to prevent summarisation drift. For deep reasoning chains or full exploration history, use `search_transcript` to search canonical records or fetch full/ranged content and neighbors by ID; `search_turn_events` searches turn summaries and `retrieve_artifact` retrieves stored tool output. Legacy sessions without a canonical transcript must use `search_session_log` instead. Transcript search excludes assistant messages calling `search_transcript` and `search_transcript` results (ID fetch still works); artifact-backed results use logged output paired by tool and call ID in the same reset epoch and retain `artifactId`.

### Current status (honest)

Engine mode is **on by default** (`context_engine.enabled = true`). We have not benchmarked it against classic mode or other agents. The table below reflects real behaviour today, not a marketing claim.

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
| Cross-session continuity | File Memory | Within-session checkpoint does not replace File Memory for the next session |

Classic mode remains the simpler fallback: full verbatim transcript, no checkpoint or tiering. Disable the engine when you want the plain transcript baseline; expect rough edges on long conversational threads in either mode.

---

## Classic Mode

When `context_engine.enabled = false` (or enabled but the engine fails to initialize), PRAANA runs in **classic mode** via `src/compile-classic.ts`.

Classic mode is intentionally simple:

- **Full verbatim history** — every user message, agent reply, and tool result from the session event log, with no token-budget truncation.
- **No Adaptive Context** — no `create_task`, `decide`, tier demotion, or auto-hydrate. Working memory is the transcript itself.
- **No context engine** — no distillers, artifact store, checkpoint, turn ledger, or scored compilation.
- **Skills as catalog** — discovered skill names and descriptions are listed in the prompt; the agent loads bodies with `load_skill` when needed. No residency tiers or eviction tracking.
- **File Memory works the same** — `recall` / `remember` / `forget_memory` and the session-start index are shared with engine mode.
- **No auto-compaction yet** — until the compiler cutover, `compiler.auto_compact_at` and `compiler.compact_chunk_fraction` have no effect in classic mode.

Classic mode is a simpler alternative when the context engine is disabled or unavailable. Set `measurement_mode = true` to record engine-style telemetry while running classic (for internal debugging only).

---

## File Memory

**File Memory** is PRAANA's cross-session knowledge, stored as markdown files instead of database rows. Global memories live in `~/.praana/memory`; project memories in `~/.praana/projects/<key>/memory` (the key derives from the real git root — or the real cwd outside git — as a readable basename plus a six-character hash suffix). Each file has YAML frontmatter (`name`, `scope`, `type`, `description`, `updated`) and a body, with lowercase-slug names. Memories are dated observations, not instructions: the compiled index opens with a trust caveat ("a memory is an observation at its date; verify files, functions and flags it names before recommending them").

### Tools

The agent saves deliberately with `remember({ scope, type, name, description, body })` (`scope` is `global` or `project`; nothing is saved automatically). `recall({ query })` searches both scopes and returns up to five `{ name, scope, description, snippet }` matches; `recall({ name, scope? })` reads one memory in full. `forget_memory({ name, scope? })` hard-deletes a memory file.

### Incognito

`/incognito on` blocks memory writes and deletes while keeping reads, `recall`, and the index available. `[memory] enabled = false` is the only "fully off" switch: no store, no tools, no index, no policy text.

### Index

At session start (and on resume) PRAANA builds the prompt index exactly once: the newest memories across both scopes, capped at 200 lines / 25,600 bytes. The index is never rebuilt after in-session writes or incognito toggles. A store with nothing readable adds no index section.

### No session-end memory work

There is no session-end summariser, consolidation, or automatic promotion of notes, constraints, decisions, or high-value artifacts. Anything worth keeping must be saved during the session with `remember`.

---

## Tooling

PRAANA's tool surface is small and deliberately shared across modes. The goal: every tool the agent reaches for returns a **structured, bounded response** — never a wall of unparsed text. Distillers downstream of these tools keep large outputs from polluting the context.

| Category | Tools | Mode |
|---|---|---|
| Codebase exploration | `read_file`, `read_and_summarize`, `search_code` (native grep), `find_files` (fuzzy file search), `code_*` (tree-sitter), `lsp_diagnostics` (opt-in LSP). Repeat reads of unchanged files return the existing artifact card / hard-block (configurable via `[tools] block_repeat_reads`); engine mode injects a **Files Read This Session** index | Both |
| Git | `git_status`, `git_diff`, `git_commit`, `git_branches`, `git_log` (structured JSON; prefer over `shell git …`). `git_commit` is blocked in plan mode. Large diffs are lossless artifacts with stub cards — retrieve via `retrieve_artifact` | Both |
| File mutation | `write_file`, `edit_file`, `batch_write`, `batch_edit` (concurrent batches OK; same-path mutators fail). Missing/unread `edit_file` is fail-fast with fuzzy suggestions (#577). Opt-in `[verify]` (issue #576) attaches syntax / scoped tsc / affected-test results on the same tool result | Both |
| Shell | `shell` (with optional sandbox allowlist; timeout kills the process group). First-token PATH / cwd checked before execute (#577) | Both |
| Session search | `search_session_log` (other in-session events), `search_transcript` (BM25 + substring over canonical session records, including compacted/stubbed turns; current reset epoch by default, `include_previous_resets=true` crosses `/clear`; full/ranged content and neighbors by ID) | Both |
| File Memory | `remember`, `recall`, `forget_memory` | Both |
| Adaptive Context | `create_task`, `decide`, `add_constraint`, `add_note`, `hydrate`, `soft_unload`, `hard_unload`, `list_state` | Engine |
| Context engine | `retrieve_artifact`, `context_summary`, `search_turn_events`, `event_lineage` | Engine |

`search_code` and `find_files` are powered by `@praana/natives` (same sidecar as tree-sitter). `search_code` returns `{ matches: [{ file, line, column, text, context_before, context_after }], stats: { totalMatches, filesWithMatches, truncated } }` — file:line:column matches with optional context, glob include/exclude, and `max_results` truncation. `find_files` returns file paths with metadata via typo-resistant fuzzy or pure glob mode. Grep is synchronous; use `shell rg` for huge trees or interactive abort.

Tree-sitter `code_*` tools (#418 Phase 1) provide syntax diagnostics and name-based symbol queries via `@praana/natives`. The opt-in LSP tier (#418 Phases 2–4) adds diagnostics, formatting, hover, completions, semantic definition/references, and list+apply code actions against external servers configured under `[lsp]` (disabled by default; `format_on_edit` is also opt-in). A crashed language server is respawned (max 3 restarts per root, exponential backoff). Files in JS workspace packages or nested git repos use a dedicated server process (cap 8, LRU). Use `code_*` for fast in-project name queries; `lsp_definition` / `lsp_references` when you need types, stdlib, or `node_modules`.

Opt-in post-edit verification (#576, `[verify] enabled = false`) runs after a successful write/edit: tree-sitter parse, scoped `tsc --noEmit` from the nearest `tsconfig.json`, then reverse-import selection of `*.test.*` / `*.spec.*` (runner v1: `bun test`). Results attach as `result.verify`. Syntax or type errors skip tests. Missing native / no tsconfig / no affected tests / timeout never flip the edit’s `ok`. `lsp_format` and `lsp_apply_code_action` do not trigger verify. No new agent-facing tools.

Structured git tools (#432 + #586) are the harness's git surface under epic #533. They return verified JSON instead of porcelain text. Large `git_diff` output is stored losslessly and shown as a stub card in the prompt; `DiffDistiller` may still fill the stored `summary` for stats / memory promotion, but it is not the prompt size-control path.

## Plan Mode

Plan mode (#547) is an opt-in safety gate. When armed via `/plan on`, **mutating tools are blocked** — `write_file`, `edit_file`, `batch_*`, `git_commit`, `lsp_format`, `lsp_apply_code_action`, and branch-creating shell — until you approve (`/plan execute` or an approval word). Read-only tools stay available. There is no forced Plan-Before-Execute system-frame rule and no intent auto-detection. The gate is a `pre_tool_call` hook on `Session.planMode` (`src/plan-mode.ts`). A separate always-on **risk confirm** hook (#580) prompts on TTY (or fail-closes in headless unless `[risk].allow`) for destructive/outward actions plan mode does not cover (`rm`, force-push, `gh` close/merge, package installs, writes outside cwd). Plan mode persists across resume via a `system_note` event.

Always-on **secret redaction** (#579) walks tool results and a copy of logged tool-call args before they enter the compiled prompt, `events.jsonl`, or the TUI. Known key prefixes, PEM blocks, and high-entropy `KEY=value` assignments become `[REDACTED:<kind>]`. User and agent chat text are not redacted; tools still execute the original args.

Always-on **circuit breakers** (#578) block a mutating tool call that repeats identical arguments a third time within a turn and inject a constraint into the next compile; repeated failures on the same file or command add a re-read advisory to the result instead of blocking. Counts reset each turn. Reads and test commands are not gated. Headless runs can also wrap up (one final no-tool reply) when `[circuit] max_tokens` or `max_wall_ms` is hit.

---

## How the Two Systems Relate

Adaptive Context and File Memory are complementary but distinct:

| | Adaptive Context | File Memory |
|---|---|---|
| Scope | Within a session | Across sessions |
| Storage | In-memory (StateGraph) | Markdown files under `~/.praana` |
| Managed by | Agent tools + automatic demotion | Agent tools (`remember` / `forget_memory`) |
| Purpose | Curate what the model sees *right now* | Preserve what was learned *over time* |

At session start, the index from File Memory is injected into the context compiled by Adaptive Context. The two systems share the same context window — memory takes up one section of the compiled prompt alongside active state, peripheral stubs, and recent turns (engine mode), or alongside the full verbatim transcript (classic mode).
