# Roadmap

What's being worked on and what's coming next. This covers the near term — roughly the next few months.

---

## Shipped

### v0.4.0 (2026-06-13)

**Context engine (opt-in — `context_engine.enabled`, off by default)**

- Phases 1–8: artifact store, distillers, session checkpoint, turn ledger, scored compilation, telemetry (#117)
- Classic mode — full verbatim transcript when the engine is disabled or unavailable
- Skill runtime — BM25 matching, hot/warm/cold residency (#103)
- Checkpoint narrative, plan history, decision rationale retention, implicit constraint extraction
- Per-section token ceilings with degraded fallback (#25)
- FOCUS opcode — pin one active state object first in prompt (#26)

**Terminal UI**

- Ink TUI with configurable screen mode (#104)
- Transcript overhaul — user blocks, tool rows, turn footers (#130)
- Markdown rendering and syntax highlighting in transcript (#126)
- Thinking stream toggle; simplified italic display (#135)
- Distinct tool-result lines; screen-flash fix (#123)

**Memory**

- Global and project scopes; recall merges both when a project session is active (#56)
- Session-end duplicate and contradiction detection (#20)
- Tool-outcome reinforcement for recalled memories (#45)
- Two-layer schema with per-kind half-life decay (#21)
- Consolidation processor and watermark history compression (#27, #29)
- Stale low-confidence pruning at session start (#22)
- Per-kind digest weights (#24) and `recall_min_score` filter (#23)
- RETRACT — `retract_task` and `forget_memory` with tombstone semantics

**Tools and safety**

- `search_code` — ripgrep-backed structured search (#105)
- `batch_write` and `batch_edit` for multi-file work (#106)
- Diff preview before `edit_file` / `write_file`
- `read_and_summarize` for file overviews
- Shell sandbox allowlist and real-time streaming output

**Session and observability**

- Project stack fingerprint auto-load at session start (polyglot manifests, #125)
- `/clear` and `/new` — reset session state without losing the session id
- Incognito mode — disable cross-session persistence (#11)
- Per-turn and cumulative token usage in `/stats`
- Pino system logs with daily rotation (#129)

### v0.3.0 (2026-05-30)

Phase-0 foundation and stabilization.

- Adaptive Context tiering (active / soft / hard) and auto-hydration
- Cognitive Memory — SQLite store, session-end summariser, scoped recall, session-start digest
- AGENTS.md / CLAUDE.md project context auto-load
- Semantic embedder `auto` strategy (Ollama probe → hash fallback); opt-in `transformers` and `llama-cpp`
- Global CLI via `npm link`, status bar, turn interrupt (`Esc`), polished readline output
- Session-end abort handling on clean `/exit` (#4); clearer `/stats` and `/state` (#9)
- CLI `--config` path handling (#68)

---

## In Progress

Nothing actively in flight right now. See [Up Next](#up-next).

---

## Up Next

- **Planner task graph** — upgrade tasks from flat objects to a goal-directed execution graph with dependencies (`depends_on`), blocked state/reasons, and explicit statuses (`todo`, `in_progress`, `blocked`, `done`) so long-running work does not drift.
- **Confidence reinforcement (ongoing)** — tool-outcome reinforcement shipped (#45); extend to broader “useful recall → stronger, ignored → fade” behaviour across sessions.
- **Duplicate handling (ongoing)** — session-end detection shipped (#20); reinforce confirmed patterns across sessions instead of re-storing near-duplicates.

---

## Later

- **LSP integration** — connect to the project's language server (typescript-language-server, pylsp, rust-analyzer, etc.) for two things: (1) *context loading* — at session start, inject current diagnostics (errors, warnings) into the system frame so the agent knows what's broken before the first turn; (2) *semantic tools* — `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols` for semantic navigation instead of grep.

- **Learned context engine** — *Research direction, not proven yet.* Replace or augment hand-tuned scoring (BM25, fixed pin/recency/relevance weights, keyword hydration) with lightweight ML only where session telemetry shows systematic failure: ranking context units, predictive hydration, learning from turn outcomes which material actually helped. Reactive to evidence, not a launch blocker — and does not replace the main LLM.
- **Intelligent model routing** — automatic selection of the right model and provider per task, learning from outcomes over time.
- **Tab completion** — slash commands, file paths.
- **Git tools** — `git_status`, `git_diff`, `git_commit`.

---

## Not Planned

- GUI / web interface — PRAANA is a terminal agent.
- Cloud sync — local-first, your data stays on your machine.
- Multi-user shared memory — single-user for now.
- Published benchmark claims — no performance table until real eval data exists.

---

Shaped by what users actually need. Open an issue if something is missing or wrong.
