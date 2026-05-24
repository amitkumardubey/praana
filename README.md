# ARIA

**A terminal coding agent that remembers.**

ARIA is an open-source CLI coding agent with two adaptive memory systems: **Adaptive Context** — working memory that automatically compresses stale state into compact stubs — and **Adaptive Memory** — cross-session persistence that carries learnings across conversations.

It runs in your terminal, works with 12+ LLM providers, and saves 70–88% on context tokens for peripheral state — meaning you get more useful context per token.

> **Status:** v0.2.0 — experimental. Works today, but expect rough edges. Not yet as polished as established AI coding agents.

## Quick Start

```bash
# Clone and build
git clone https://github.com/yourusername/aria.git
cd aria
npm install && npm run build

# Set your API key (OpenRouter, or any of 12+ supported providers)
export OPENROUTER_API_KEY="sk-..."

# Run
npm start
```

Three commands to your first session. Drop-in config via `aria.config.toml` or use zero config defaults.

### Slash commands while in session:

| Command | What it does |
|---------|-------------|
| `/state` | View working memory state |
| `/digest` | Show adaptive memory digest |
| `/recall <query>` | Search adaptive memory |
| `/model <provider/model>` | Switch models mid-session |
| `/stats` | Session statistics |
| `/sessions` | List past sessions |
| `/exit` | End session (triggers learning extraction) |

## What Makes ARIA Different

Most coding agents treat context as a flat window — everything competes for the same tokens. ARIA doesn't.

**Adaptive Context** — State objects (tasks, decisions, constraints, notes) live in three tiers:

| Tier | Prompt Representation | Use Case |
|------|----------------------|----------|
| **Active** | Full content | What you're working on right now |
| **Soft** | One-line stub | Recently completed, might be relevant |
| **Hard** | Minimal anchor | Older context, available via hydrate |

Objects automatically demote after configurable idle thresholds. The result: your active objects get full representation, while stale context compresses to stubs. When you mention something related, ARIA auto-promotes matching peripherals back to active — no manual `hydrate()` calls needed.

**Measured:** In a session with 100+ state objects, tiering saved ~12,700 tokens vs. flat rendering. [See the benchmark.](./docs/benchmarks/token-benchmark.ts)

**Adaptive Memory** — SQLite-backed, scored by relevance and recency, persists between sessions. At session start, ARIA generates a digest of what it knows. At session end, it optionally summarizes learnings and reinforces confidence for memories that proved useful. Scope filtering keeps global preferences separate from project-specific facts.

> **Honest note:** Both systems work today, but they're early. Adaptive Context uses basic idle thresholds and keyword matching for auto-hydrate — no semantic understanding yet. Adaptive Memory stores and recalls, but the reinforcement loop (updating confidence based on which memories actually helped) isn't wired yet. These are foundations, not finished products.

## Features

- **Adaptive Context** — tiered working memory that compresses stale state automatically
- **Adaptive Memory** — cross-session persistence with confidence scoring and reinforcement
- **12+ LLM providers** — OpenRouter, OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Mistral, xAI, Fireworks, Together, Ollama, AWS Bedrock
- **Deterministic prompt compilation** — every prompt is built from the same state, same order, same rules. No surprises in generated output.
- **Auto-hydrate** — mentioning a peripheral object in conversation automatically promotes it to active. No LLM discipline required.
- **Session resume** — pick up exactly where you left off, including model override.
- **Tools** — shell (async, timeout-safe), file read/write, exact-match edit, Adaptive Context management, Adaptive Memory recall/remember.
- **Event-sourced** — every turn logged as append-only JSONL. Debug, replay, or analyze session history.
- **Tiered config** — `~/.aria/config.toml` → `./aria.config.toml`, later overrides earlier.

## Provider Support

ARIA proxies through [pi-ai](https://github.com/earendil-works/pi-ai), which bundles native SDKs for all major providers:

| Provider | Env Key | API Type |
|----------|---------|----------|
| OpenRouter | `OPENROUTER_API_KEY` | OpenAI-compatible |
| OpenAI | `OPENAI_API_KEY` | OpenAI-compatible |
| Anthropic | `ANTHROPIC_API_KEY` | Anthropic Messages |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` | Google Generative AI |
| DeepSeek | `DEEPSEEK_API_KEY` | OpenAI-compatible |
| Groq | `GROQ_API_KEY` | OpenAI-compatible |
| Mistral | `MISTRAL_API_KEY` | Mistral Conversations |
| xAI (Grok) | `XAI_API_KEY` | OpenAI-compatible |
| Fireworks | `FIREWORKS_API_KEY` | OpenAI-compatible |
| Together | `TOGETHER_API_KEY` | OpenAI-compatible |
| Ollama | *none* | OpenAI-compatible (local) |
| AWS Bedrock | *AWS credentials* | Bedrock Converse |

Switch providers or models at any time with `/model <provider/model>` or `ARIA_MODEL` env var.

## How It Works (Briefly)

```
User input
  → append user_message to event log
  → auto-hydrate matching peripheral state
  → compile deterministic prompt (system + digest + active + peripherals + history + input)
  → stream LLM response with tool calls
  → log tool calls and results
  → append agent_message
  → apply tier demotion rules
  → print memory banner
```

The full architecture is documented in [AGENTS.md](./AGENTS.md).

## Configuration

Copy the example and edit:

```bash
cp aria.config.example.toml aria.config.toml
```

Key options:

```toml
[llm]
provider = "openrouter"
model = "deepseek/deepseek-v4-pro"

[memory]
enabled = true
summarizer = "openrouter"
db_path = "~/.aria/memory.db"

[compiler]
token_budget = 100000
recent_turns = 10
```

See [aria.config.example.toml](./aria.config.example.toml) for the full reference.

## What's Next

ARIA is early. The core — Adaptive Context, Adaptive Memory, auto-hydrate — is solid, but there's plenty to build. Some areas being explored:

- **MCP (Model Context Protocol) support** — connecting to databases, APIs, and developer tools through the community MCP ecosystem
- **Skill/plugin system** — extending ARIA with community-built capabilities without forking
- **TUI (terminal UI)** — richer interface for session management, diffs, and debugging
- Multi-file edit operations with diff preview
- Project-level context indexing
- Better error recovery and retry logic
- Performance profiling and optimization

Nothing here is promised or scheduled. The direction is shaped by what users actually need. Open issues, send PRs, or just tell us what's missing.

## Development

```bash
npm run dev     # Run with tsx (no build step)
npm run build   # TypeScript compile
npm test        # 21 tests, <500ms
```

Requires Node 22+. Uses TypeScript throughout.

## License

MIT — see [LICENSE](./LICENSE).
