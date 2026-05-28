# Roadmap

What's being worked on and what's coming next. This covers the near term — roughly the next few months.

---

## Shipped

- **AGENTS.md support** — ARIA reads `AGENTS.md` (and `CLAUDE.md` as fallback) from the project root and global `~/.aria/AGENTS.md`, merging them into the system prompt on every session.

---

## In Progress

- **Semantic embeddings** — replacing the hash-based embedder with a local semantic model so recall actually works. Auto-detects Ollama; falls back gracefully.
- **Global memory** — memories that apply across all projects (preferences, personal constraints, universal patterns) alongside project-scoped memories.
- **Global + project recall merge** — query both global (`user+agent`) and project (`user+agent+context`) scopes, merge the result set, and make project-specific memories override global ones when they conflict.

---

## Up Next

- **Planner task graph** — upgrade tasks from flat objects to a goal-directed execution graph with dependencies (`depends_on`), blocked state/reasons, and explicit statuses (`todo`, `in_progress`, `blocked`, `done`) so long-running work does not drift.
- **Confidence reinforcement** — recalled memories that prove useful get stronger; unused ones fade faster. Completes the learning loop.
- **Duplicate and contradiction detection** — when the same pattern is confirmed across sessions, reinforce rather than duplicate. When new evidence contradicts an old belief, reduce its confidence.
- **Multi-file operations** — create or edit multiple files in one turn instead of sequential single-file calls.
- **Diff preview** — show a unified diff before applying `edit_file`. Silent file writes are too risky.
- **Project context auto-load** — read `package.json`, `tsconfig.json`, `README.md` on session start so the agent knows your stack before you explain it.
- **Skill context auto-load** — load and inject `skills/*.md` (project-local skill instructions), not only `AGENTS.md`/`CLAUDE.md`, with deterministic ordering and token-capped merge behavior.
- **Evaluation framework** — a 30-task benchmark against a stateless baseline to measure whether Cognitive Memory actually improves outcomes.

---

## Later

- **LSP integration** — connect to the project's language server (typescript-language-server, pylsp, rust-analyzer, etc.) for two things: (1) *context loading* — at session start, inject current diagnostics (errors, warnings) into the system frame so the agent knows what’s broken before the first turn; (2) *semantic tools* — `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_symbols` for semantic navigation instead of grep. Makes context higher signal and reduces wrong-file edits.

- **Background consolidation** — async session analysis that strengthens confirmed patterns, removes noise, and promotes durable knowledge. This is what makes the memory genuinely improve over time rather than just accumulate.
- **Intelligent model routing** — automatic selection of the right model and provider per task, learning from outcomes over time.
- **`/search` tool** — first-class grep/ripgrep for finding code by content without shelling out.
- **Tab completion** — slash commands, file paths.
- **Git tools** — `git_status`, `git_diff`, `git_commit`.

---

## Not Planned

- GUI / web interface — ARIA is a terminal agent.
- Cloud sync — local-first, your data stays on your machine.
- Multi-user shared memory — single-user for now.

---

Shaped by what users actually need. Open an issue if something is missing or wrong.
