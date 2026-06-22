---
layout: default
title: Home
---

# PRAANA

**A terminal coding agent with adaptive context and cross-session memory.**

PRAANA runs in your terminal, calls an LLM, executes tools, and tries to keep long sessions usable by compressing old context instead of stuffing everything into the prompt. Between sessions it can extract learnings from transcripts and store them in a local SQLite database.

<p align="center">
  <img src="{{ '/assets/demo.png' | relative_url }}" alt="PRAANA terminal demo" width="720" />
</p>

## Install

```bash
npm install -g praana
export ANTHROPIC_API_KEY="sk-ant-..."   # or OPENAI_API_KEY, OPENROUTER_API_KEY, ...
praana
```

Requires **Node 22+**. See the [README](https://github.com/amitkumardubey/praana#quick-start) for all providers and config options.

## Documentation

| Doc | Description |
|-----|-------------|
| [Architecture](./ARCHITECTURE.md) | Systems design — adaptive context, cognitive memory, turn flow |
| [Concepts](./concepts.md) | Glossary and mental model |
| [Roadmap](https://github.com/amitkumardubey/praana/blob/main/ROADMAP.md) | Direction and honest limitations |
| [Contributing](https://github.com/amitkumardubey/praana/blob/main/CONTRIBUTING.md) | Dev setup, tests, PR workflow |

## Why PRAANA?

| | Typical transcript agent | PRAANA |
|---|--------------------------|--------|
| **Long sessions** | Full history in prompt; context fills up | Opt-in **engine mode**: tiered working memory, distillation, checkpoint |
| **Next day** | Starts cold unless you paste notes | **Cognitive memory**: ranked digest from past sessions (project + global scope) |
| **Honesty** | Often marketed as solved | [Known limitations](https://github.com/amitkumardubey/praana#known-limitations-honest) published upfront — no benchmark claims we can't back |

## Community

- [GitHub Discussions](https://github.com/amitkumardubey/praana/discussions) — Q&A, ideas, release announcements
- [Issues](https://github.com/amitkumardubey/praana/issues) — bugs and feature tracking
- [npm](https://www.npmjs.com/package/praana) — `npm install -g praana`

## License

MIT — [GitHub](https://github.com/amitkumardubey/praana) · [CHANGELOG](https://github.com/amitkumardubey/praana/blob/main/CHANGELOG.md)
