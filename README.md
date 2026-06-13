# PRAANA

[![npm](https://img.shields.io/npm/v/praana)](https://www.npmjs.com/package/praana)
[![GitHub](https://img.shields.io/badge/github-amitkumardubey/praana-blue)](https://github.com/amitkumardubey/praana)

**A terminal coding agent with adaptive context and cross-session memory.**

PRAANA is experimental software. It runs in your terminal, calls an LLM, executes tools, and tries to keep long sessions usable by compressing old context instead of stuffing everything into the prompt. Between sessions it can extract learnings from transcripts and store them in a local SQLite database.

We have **not** benchmarked PRAANA against other agents. Treat memory and the context engine as ideas we're still proving in real use—not solved problems.

> **Status:** v0.5.0 <!-- x-release-please-version --> — experimental. Core flows work; long or messy tasks will hit rough edges.

> **How it was built:** Entirely vibecoded—this codebase was written by coding agents with human direction and review, not hand-coded line by line.

---

## Quick Start

### Install from npm (recommended)

```bash
# Install globally
npm install -g praana

# Or run without installing
npx praana
```

Set up your config file and API key:

```bash
cp praana.config.example.toml praana.config.toml
export OPENROUTER_API_KEY="sk-or-v1-..."   # or another provider — see config example

# Launch the agent
praana
```

> **First time?** Default UI is the Ink TUI when stdout is a TTY (`[ui] mode = "tui"`); use `praana --ui readline` for the classic interface.
> Requires **Node 22+**.

### Global CLI alias

After installing with `npm install -g praana`, both `praana` and `pran` are on your PATH automatically. If you use `fnm` or `nvm`, make sure your npm global bin directory is in your PATH:

```bash
export PATH="$(npm config get prefix)/bin:$PATH"
praana    # or the short alias: pran
```

### Build from source (for development)

```bash
git clone https://github.com/amitkumardubey/praana.git
cd praana
npm install && npm run build

cp praana.config.example.toml praana.config.toml
export OPENROUTER_API_KEY="sk-or-v1-..."

node dist/main.js
```

### Configuration

See [`praana.config.example.toml`](./praana.config.example.toml) for providers, memory, and engine settings.

---

## What it does

**Two compile modes** (see `[context_engine] enabled` in config):

| Mode | Default? | Behaviour |
|---|---|---|
| **Classic** | Yes (`enabled = false`) | Full verbatim transcript in the prompt. Same general shape as many coding agents. |
| **Engine** | Opt-in | Tiered working memory, tool-output distillation, session checkpoint, scored prompt compilation, progressive skills. |

**Cross-session memory** (optional, `[memory] enabled = true`):

- At `/exit`, a summariser extracts facts, decisions, patterns, mistakes, preferences, and constraints from the transcript.
- Next session starts with a ranked digest in the prompt.
- Project-scoped and global scopes; both are queried and merged in project sessions (#56).

**Project context:** loads `AGENTS.md` / `CLAUDE.md` plus an optional stack fingerprint (`package.json`, `go.mod`, etc.) on session start.

**Skills:** in engine mode, discovers `SKILL.md` files and loads them by relevance; in classic mode, lists paths only.

Architecture details: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) · [docs/concepts.md](./docs/concepts.md)

---

## Known limitations (honest)

These are real gaps today—not a roadmap dressed up as marketing.

| Area | What's weak |
|---|---|
| **Memory recall** | Without Ollama or another semantic embedder, `hash` fallback is not meaningfully semantic. Global and project memories merge in project sessions, but near-duplicate or conflicting entries are not automatically reconciled. |
| **Context engine** | Off by default. Enabling it adds complexity; fallback to classic if init fails. |
| **Long sessions** | Tiering and distillation help but don't guarantee the model stays on track. |
| **Hydration** | Demoted state can be hidden until you mention it or the agent calls `hydrate`—the model doesn't always recover context proactively. |
| **Summariser** | Session-end learning needs a configured summariser and API access; can run in background on exit. |
| **Shell tool** | Optional path/command sandbox (`[shell]` in config); **off by default**. When disabled, runs with your user permissions. |
| **Comparison** | No published evals. We don't know if memory beats a plain transcript agent for your workflows. |

If cross-session memory doesn't help you after a few real projects, that's useful feedback—not a surprise.

---

## Slash commands

| Command | Purpose |
|---|---|
| `/help` | Full list |
| `/exit` | End session (runs summariser when memory is on) |
| `/clear`, `/new` | Reset working memory (engine state / checkpoint) |
| `/state` | Working-memory objects (engine mode) |
| `/digest` | Cross-session memory digest |
| `/recall <query>` | Search persistent memory |
| `/stats` | Session + memory stats |
| `/events` | Last 20 session log events |
| `/model <name>` | Switch model |
| `/sessions` | List sessions to resume |
| `/thinking <on\|off>` | Show or hide reasoning text |
| `/incognito <on\|off>` | Disable cross-session memory writes |
| `/debug` | Verbose tooling + saved prompts |
| `/why <id>` | Why a context unit was included (engine + debug) |

---

## Development

```bash
npm run dev
npm run build
npm test
```

---

## What's next

See [ROADMAP.md](./ROADMAP.md). High level: planner task graph, ongoing confidence reinforcement, LSP integration.

Issues and PRs welcome.

---

## License

MIT — [LICENSE](./LICENSE). Version history: [CHANGELOG.md](./CHANGELOG.md) (auto-generated by release-please on each release).
