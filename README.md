# PRAANA

[![npm](https://img.shields.io/npm/v/praana)](https://www.npmjs.com/package/praana)
[![GitHub](https://img.shields.io/badge/github-amitkumardubey/praana-blue)](https://github.com/amitkumardubey/praana)

**A terminal coding agent with adaptive context and cross-session memory.**

PRAANA is experimental software. It runs in your terminal, calls an LLM, executes tools, and tries to keep long sessions usable by compressing old context instead of stuffing everything into the prompt. Between sessions it can extract learnings from transcripts and store them in a local SQLite database.

We have **not** benchmarked PRAANA against other agents. Treat memory and the context engine as ideas we're still proving in real use—not solved problems.

> **Status:** v0.6.0 <!-- x-release-please-version --> — experimental. Core flows work; long or messy tasks will hit rough edges.

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

Set up your API key and launch:

```bash
# Set any provider API key (PRAANA auto-detects which one)
export ANTHROPIC_API_KEY="sk-ant-..."       # or
export OPENAI_API_KEY="sk-..."              # or
export OPENROUTER_API_KEY="sk-or-v1-..."    # or many others

# Launch the agent
praana
```

> **First time?** PRAANA auto-detects your provider from the environment. If no key is found, it runs an interactive setup wizard (TTY) or shows clear instructions.
> Default UI is the Ink TUI when stdout is a TTY (`[ui] mode = "tui"`); use `praana --ui readline` for the classic interface.
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

# Create a config file (auto-detects provider from environment)
node dist/main.js init

# Set your API key and launch
export ANTHROPIC_API_KEY="sk-ant-..."
node dist/main.js
```

### Configuration

PRAANA auto-detects provider API keys from the environment. No config file is needed to get started.

If you want to customize settings, create a config file:

```bash
praana init   # Creates praana.config.toml with detected provider
```

See [`praana.config.example.toml`](./praana.config.example.toml) for all available settings.

#### Supported Providers

| Provider | Environment Variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together | `TOGETHER_API_KEY` |
| OpenCode | `OPENCODE_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Ollama | *(local, no key needed)* |

Provider resolution precedence:
1. Explicit config file setting
2. Environment-detected key (in the order above)
3. Interactive setup (TTY) or clear instructions (non-TTY)

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
| `/model [provider] <id>` | Switch model and optionally provider mid-session |
| `/sessions` | List sessions to resume |
| `/thinking <on\|off>` | Show or hide reasoning text |
| `/incognito <on\|off>` | Disable cross-session memory writes |
| `/debug` | Verbose tooling + saved prompts |
| `/why <id>` | Why a context unit was included (engine + debug) |

### `/model` syntax

Switch the active model on the current provider, or switch provider and model together:

```text
/model                          # show current provider/model
/model gpt-4o                     # model on current provider
/model openai gpt-4o            # switch to OpenAI native
/model opencode mimo-v2.5-free  # switch to OpenCode Zen
/model openrouter openai/gpt-4o # route via OpenRouter
```

Unknown ids are validated against the bundled pi-ai catalog first, then against the provider's live `/models` list (cached 6 hours at `~/.praana/provider-catalog-cache.json`). OpenAI-compatible providers with live catalogs: OpenRouter, OpenCode, OpenAI, DeepSeek, Groq, xAI, Fireworks, Together, and Ollama. Anthropic, Google, Mistral, and Bedrock still rely on the static pi-ai catalog.

---

## Development

```bash
npm run dev
npm run build
npm test
```

---

## What's next

See [ROADMAP.md](./ROADMAP.md). High level: making cross-session memory and the context engine actually pay off, semantic recall by default, and the measurement to tell honestly whether they help.

Issues and PRs welcome.

---

## License

MIT — [LICENSE](./LICENSE). Version history: [CHANGELOG.md](./CHANGELOG.md) (auto-generated by release-please on each release).
