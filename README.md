# PRAANA

[![npm](https://img.shields.io/npm/v/praana)](https://www.npmjs.com/package/praana)
[![GitHub](https://img.shields.io/badge/github-amitkumardubey/praana-blue)](https://github.com/amitkumardubey/praana)
[![docs](https://img.shields.io/badge/docs-GitHub%20Pages-2ea44f)](https://amitkumardubey.github.io/praana/)

**A terminal coding agent that manages context like memory — curating what the model sees on every turn, and carrying learnings across sessions in a local database.**

<p align="center">
  <img src="docs/assets/demo.png" alt="PRAANA terminal — adaptive context and cognitive memory" width="720" />
</p>

Long coding sessions burn tokens faster as they grow. The prompt fills with stale tool output and repeated context, the model drifts, and you lose the thread. Come back the next day and you re-explain everything from scratch.

PRAANA takes a different approach. A deterministic compiler curates what the model sees on every turn — tiered working memory, tool-output distillation, and a session checkpoint — instead of stuffing the full transcript into the prompt. An optional Cognitive Memory extracts learnings when a session ends and surfaces a ranked digest the next time you start, in the same repo or anywhere.

Runs on Bun. One binary, pure TypeScript, local-first, any provider.

> **Status:** v0.10.0 <!-- x-release-please-version --> — experimental. The context engine and memory are ideas we're proving in real use, not solved problems. We publish [known limitations](#known-limitations-honest) and make no benchmark claims we can't back.

> **How it was built:** vibecoded — written by coding agents with human direction and review, not hand-coded line by line.

---

## Quick Start

### Install

```bash
# Install globally
bun add -g praana

# Or run without installing
bunx praana
```

Requires **Bun ≥ 1.2**. Install at [bun.sh/install](https://bun.sh/install).

### Set a provider key and launch

```bash
export ANTHROPIC_API_KEY="sk-ant-..."    # or any supported provider below
praana
```

PRAANA auto-detects which provider key is set. On first run with no config file, it runs an interactive setup wizard. The interactive UI is a terminal-native `pi-tui` shell with native scrollback, slash-command autocomplete, transcript rendering, and full thinking-text display when `/thinking on` is enabled.

### Global alias

Both `praana` and `pran` are on your PATH after a global install. If Bun's global bin directory isn't in your PATH:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

### Build from source

```bash
git clone https://github.com/amitkumardubey/praana.git
cd praana
bun install
export ANTHROPIC_API_KEY="sk-ant-..."
bun src/main.ts
```

### Configuration

No config file is needed to start. To customise:

```bash
praana init   # Creates praana.config.toml with detected provider
```

See [`praana.config.example.toml`](./praana.config.example.toml) for all settings.

#### Supported providers

| Provider | Environment variable |
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
| Ollama | *(local — no key needed)* |

Provider resolution order: explicit config → environment-detected key → interactive setup.

---

## Why PRAANA vs a plain transcript agent?

| | Typical transcript agent | PRAANA |
|---|---|---|
| **Long sessions** | Full history in the prompt; context window fills up | **Engine mode:** curates the prompt every turn — tiered state, tool-output distillation, session checkpoint |
| **Next session** | Starts cold unless you paste notes | **Cognitive Memory:** at `/exit` PRAANA extracts what you decided and learned; start tomorrow and it surfaces without re-explaining |
| **Skills** | Manual or always-on | Pull model: compact catalog injected every turn (usefulness-ranked); `load_skill` fetches body on demand; effectiveness scores persist across sessions |
| **Claims** | Often marketed as solved | Known limitations published upfront; no benchmark claims we can't back |

**Example workflow:** session 1 — `decide "use Vitest, in-memory SQLite in tests"` then `/exit`. Session 2, same repo — `/digest` surfaces the decision. Engine mode stubs yesterday's task graph instead of replaying every tool result.

---

## Five things that are genuinely different

1. **Per-turn deterministic compiler with per-section token budgets.** The prompt is assembled fresh every turn across five sections — system frame, memory digest, active state, peripheral stubs, recent turns — each with its own cap. Context pressure is density-weighted, not a raw token count.

2. **Tiered working memory with auto-hydration.** State objects (tasks, decisions, constraints, notes) demote from `active` to `soft` to `hard` based on idle turns. Two-pass hydration before each turn — substring keyword match, then BM25 — promotes them back when the current turn references them.

3. **Tool-output distillers with a content-addressed artifact store.** Git diffs, npm test output, TypeScript errors, ripgrep results hit built-in distillers at ingestion. The model sees a focused summary. Full bytes live in an artifact store; `retrieve_artifact` fetches them on demand.

4. **Session resume by O(1) checkpoint + event replay.** A deterministic checkpoint is written every turn — active request, rolling narrative, decisions with rationale, constraints. Resume restores the checkpoint and replays only post-checkpoint events.

5. **Agent-native cross-session memory in local SQLite.** At `/exit`, PRAANA's summariser extracts learnings from the transcript — not bolted-on notes, not an MCP plugin. Six taxonomy kinds: `fact`, `preference`, `decision`, `pattern`, `mistake`, `constraint`. Semantic search via Transformers.js (in-process, no sidecar). Project and global scopes queried and merged.

---

## What it does

**Two compile modes** (set `[context_engine] enabled` in config):

| Mode | Default | Behaviour |
|---|---|---|
| **Engine** | Yes | Tiered working memory, tool-output distillation, session checkpoint, scored prompt compilation, progressive skills. |
| **Classic** | Fallback / explicit disable | Full verbatim transcript. Same shape as most coding agents. |

**Cognitive Memory** (optional — `[memory] enabled = true`):

- At `/exit`, extracts facts, decisions, patterns, mistakes, preferences, and constraints from the transcript.
- Next session starts with a ranked digest in the prompt.
- Project sessions query both project-scoped and global memories and merge results.
- Confidence decays 5%/day. Entries confirmed across two or more sessions promote to Consolidated Memory (10x slower decay).

**Skills:** discovers `SKILL.md` files in project and user paths. Compact catalog injected every turn, sorted by usefulness score. `load_skill(id)` fetches the full body on demand. Engine mode tracks whether each skill was used and updates its score in `memory.db`.

**Project context:** loads `AGENTS.md` / `CLAUDE.md` and an optional stack fingerprint on session start.

Architecture details: [docs site](https://amitkumardubey.github.io/praana/) · [ARCHITECTURE.md](./docs/ARCHITECTURE.md) · [concepts.md](./docs/concepts.md)

---

## Known limitations (honest)

These are real gaps, not a roadmap dressed as marketing.

| Area | What's weak |
|---|---|
| **Memory reinforcement** | Memory stores, recalls, and applies time decay. Confidence boost on session success is wired but dormant until the session-success signal ships (#162). |
| **No published evals** | The telemetry scorecard is live. The A/B eval harness — comparing engine vs classic on a fixed task suite — doesn't exist yet. We don't know if engine mode beats classic for your workflows. |
| **Semantic recall** | `@huggingface/transformers` weights download on first run (~80MB, cached in `~/.praana/models/`). Ollama is opt-in. Near-duplicate or conflicting memory entries are not automatically reconciled. |
| **Context engine** | On by default. Falls back to classic if initialization fails or if you set `[context_engine] enabled = false`. |
| **Background Consolidation Processor** | Schema exists, not scalable yet. The learning loop is incomplete. |
| **Intelligent Router** | Not started. Planned for after memory is proven. |
| **Shell tool** | Runs with your user permissions. Optional path/command sandbox via `[shell]` in config — off by default. |

If Cognitive Memory doesn't help you after a few real projects, tell us. That's useful feedback, not a surprise.

---

## Slash commands

| Command | Purpose |
|---|---|
| `/help` | Full list |
| `/exit` | End session — runs summariser when memory is on |
| `/clear`, `/new` | Reset working memory |
| `/state` | Working-memory objects (engine mode) |
| `/digest` | Cognitive Memory digest |
| `/recall <query>` | Search Cognitive Memory |
| `/stats` | Session + memory stats |
| `/scorecard` | Per-session telemetry signals |
| `/events` | Last 20 session log events |
| `/model [provider] <id>` | Switch model or provider mid-session |
| `/sessions` | List sessions to resume |
| `/thinking <on\|off>` | Show or hide reasoning text |
| `/incognito <on\|off>` | Disable Cognitive Memory writes |
| `/debug` | Verbose tooling + saved prompts |
| `/why <id>` | Why a context unit was included (engine + debug) |

### `/model` syntax

```text
/model                          # show current provider/model
/model gpt-4o                   # model on current provider
/model openai gpt-4o            # switch to OpenAI native
/model opencode mimo-v2.5-free  # switch to OpenCode
/model openrouter openai/gpt-4o # route via OpenRouter
```

Unknown ids resolve against the bundled pi-ai catalog first, then against the provider's live `/models` list (cached 6 hours at `~/.praana/provider-catalog-cache.json`).

---

## Development

```bash
bun dev          # run without build step
bun typecheck    # TypeScript type-check (no emit)
bun test         # 997 tests across 83 files, ~11s
```

### Docs site (Astro)

GitHub Pages is built from [`website/`](./website/). Markdown sources in [`docs/`](./docs/) are rendered at build time.

```bash
cd website && bun install && bun run dev    # http://localhost:4321/praana/
cd website && bun run build                 # output → website/dist/
```

---

## What's next

See [ROADMAP.md](./ROADMAP.md). Short version: closing the memory reinforcement loop (#162), building the A/B eval harness (#17), and semantic tier management — the work that turns "stores and recalls" into a system that measurably improves with use.

**Contributing:** [CONTRIBUTING.md](./CONTRIBUTING.md) · [good first issues](https://github.com/amitkumardubey/praana/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) · [Discussions](https://github.com/amitkumardubey/praana/discussions)

Issues and PRs welcome.

---

## License

MIT — [LICENSE](./LICENSE). Version history: [CHANGELOG.md](./CHANGELOG.md) (auto-generated by release-please).
