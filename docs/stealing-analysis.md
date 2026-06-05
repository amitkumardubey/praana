# What ARIA Can Steal from Headroom and MemPalace

> Analysis of external projects against ARIA's current architecture to identify high-value features we can adopt.
> Date: 2026-06-05
> Sources: [chopratejas/headroom](https://github.com/chopratejas/headroom) | [MemPalace/mempalace](https://github.com/MemPalace/mempalace)

---

## ARIA Baseline (what we are today)

- **Adaptive Context**: within-session tiered working memory (active → soft → hard) with auto-hydration
- **Cognitive Memory**: cross-session SQLite-backed persistent memory with vector search, confidence decay, and LLM-based summarization at session end
- **Deterministic prompt compiler** with token budgets, event logs, and `AGENTS.md` context injection
- **Blunt truncation**: shell output 500 chars, file output 200 chars — one-way and permanent

---

## From Headroom

### 1. Reversible Compression (CCR) — highest impact
Headroom stores originals in a local cache when compressing tool outputs. The LLM can call `ccr_retrieve("hash")` to get the full data back.

**ARIA gap**: Compiler truncation is permanent. If the LLM later needs the full file, it must re-execute the tool.
**Steal**: Add a local LRU cache keyed by tool-call hash and expose a `retrieve_original` tool so the LLM can fetch un-truncated data without re-running the command.

### 2. Cache Aligner — free performance
Headroom moves dynamic content (dates, session IDs, UUIDs) to the end of the system prompt, stabilizing the prefix so Anthropic `cache_control` and OpenAI prefix caching actually hit.

**ARIA gap**: The system prompt is re-compiled every turn with dynamic content interspersed.
**Steal**: Detect dynamic fields (session ID, timestamp) in the compiler and relocate them to a trailing `[Context: ...]` block. If the provider is Anthropic, add `cache_control: { type: "ephemeral" }` to the stable prefix.

### 3. Smart Crusher for JSON arrays
Headroom uses statistical sampling (Kneedle algorithm, variance analysis, anomaly preservation) on JSON arrays instead of blunt truncation, achieving 83–95% token reduction.

**ARIA gap**: All tool outputs are truncated to fixed character limits regardless of structure.
**Steal**: When `shell` or `read_file` returns JSON arrays (ripgrep results, listings, test output), apply a lightweight crusher that keeps schema-representative items, errors, and outliers.

### 4. `headroom learn` — failure mining
Headroom mines failed sessions and writes corrections to `CLAUDE.md` / `AGENTS.md`.

**ARIA gap**: The summarizer extracts generic facts and mistakes, but does not specifically target writing corrections to `AGENTS.md`.
**Steal**: Add a learning mode that, when a session contains compilation errors or test failures, extracts the fix and appends it to `./AGENTS.md` as a constraint. Make the project context self-healing.

### 5. Cross-agent memory (SharedContext)
Headroom shares memory across Claude, Codex, Cursor, Aider with agent provenance.

**ARIA gap**: Memory is scoped to `user:<sha256>`, `agent:aria`, `context:<cwd>`. Other agents cannot read it.
**Steal**: Optionally write global-scope memories to a shared format (standard SQLite schema or MCP-accessible store) so Claude Code and Cursor can read ARIA's learnings.

---

## From MemPalace

### 6. Verbatim storage — do not only summarize
MemPalace stores conversation history as **verbatim text** with semantic search. It does not summarize. Benchmark: 96.6% R@5 on LongMemEval with zero API calls.

**ARIA gap**: Only summarized entries live in Cognitive Memory. The original transcript is in `events.jsonl` but is not searchable via `recall`.
**Steal**: Store verbatim transcript chunks in the SQLite DB alongside summaries. Search both summary vectors and verbatim chunks during `recall`. This solves the "what exactly did we say about X?" problem.

### 7. Structured hierarchy (Wings / Rooms / Halls)
MemPalace organizes memory into `wings` (projects/people), `rooms` (topics), `halls` (categories: facts, events, discoveries, preferences, advice), and `drawers` (original chunks).

**ARIA gap**: Flat entries with scopes and kinds.
**Steal**: Map `kind` to `hall`, add `wing` (project) and `room` (feature/module) as structured metadata. Enable scoped queries like `recall("auth migration", { wing: "myproject", room: "backend" })`.

### 8. Hybrid retrieval pipeline
MemPalace combines semantic search + keyword boosting + temporal proximity + preference-pattern extraction. Raw 96.6%, hybrid 98.4%, LLM rerank ≥99%.

**ARIA gap**: Vector distance + confidence decay + recency boost.
**Steal**: Add `FTS5` keyword search to the existing SQLite DB. Add temporal proximity boosting (memories from the same time window as the query score higher). ARIA already uses `sqlite-vec`; `FTS5` is a small schema addition.

### 9. MCP server exposure
MemPalace exposes 29 MCP tools for reads/writes, knowledge graph, cross-wing navigation, and drawer management.

**ARIA gap**: ARIA is a CLI agent that uses tools, but does not expose its own memory as MCP tools.
**Steal**: Build an `aria-mcp` package that exposes `aria_recall`, `aria_remember`, `aria_list_sessions`, `aria_get_transcript`. Let other agents use ARIA as the memory backend for the entire workflow.

### 10. Temporal knowledge graph with validity windows
MemPalace tracks when facts were true and when they were superseded (`add`, `query`, `invalidate`, `timeline`).

**ARIA gap**: Decisions are stored as state objects that expire at session end. No temporal tracking or invalidation.
**Steal**: Add `supersede` and `validity_window` to memory entries. When a new memory contradicts an old one, mark the old as superseded and link them. Prevent stale facts from poisoning recall.

### 11. `mine` and `wake-up` workflow
MemPalace uses `mempalace mine ~/projects/myapp` to ingest files and `mempalace wake-up` to load context for a new session.

**ARIA gap**: Sessions start fresh unless the user manually runs `/recall`.
**Steal**: Add a `mine` command that auto-ingests `README.md`, `package.json`, and previous transcripts into memory before the first turn. Add a `wake-up` slash command that auto-recalls the most relevant memories for the current working directory on session start.

### 12. Contradiction detection
MemPalace detects when new memories contradict old ones.

**ARIA gap**: No contradiction detection. Two sessions could write contradictory facts and both would be recalled with equal confidence.
**Steal**: Before storing a new memory, run a lightweight similarity search against existing memories. If cosine similarity is high but content differs, flag as a potential contradiction and offer to supersede the old one.

---

## Prioritized Implementation Order

1. **FTS5 keyword search in Cognitive Memory** — easy, big recall boost
2. **Verbatim transcript chunk storage** — schema change, high value
3. **Cache Aligner in compiler** — tiny change, free performance
4. **Reversible compression for tool outputs** — cache tool results, add `retrieve` tool
5. **Structured hierarchy (wing/room/hall)** — schema + recall logic
6. **`headroom learn` style AGENTS.md auto-updates** — summarizer enhancement
7. **MCP server for ARIA memory** — new package, unlocks cross-agent usage
8. **Temporal KG + contradiction detection** — larger feature, prevents memory rot
