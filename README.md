# PRAANA

**A terminal coding agent. Open source, runs on your machine, works with the model provider you already use.**

## Why use it

- **Bring your own model.** 18 providers, including Anthropic, OpenAI, Google, DeepSeek, Groq, OpenRouter and Amazon Bedrock, or run fully local with Ollama. Switch models mid-session with `/model`.
- **Asks before risky actions.** `rm`, force-push, package installs and writes outside your project need your OK. `/plan on` blocks every file change until you approve the plan.
- **Redacts secrets from tool output.** Known key and token patterns are masked in tool results and in the logged tool calls.
- **Works with what you already have.** Reads your `AGENTS.md` or `CLAUDE.md`, and loads `SKILL.md` skills from `.agents/skills`, `.cursor/skills` and `~/.claude/skills`.
- **Real code tools.** Native code search, symbol lookup, structured git, a test runner, and optional language-server diagnostics.
- **Scriptable.** `praana run "fix the failing tests"` runs one task without a terminal UI, for CI and scripts.
- **Your code goes only to your model provider.** Sessions and logs stay under `~/.praana`. MIT licensed.

## Install

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/amitkumardubey/praana/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/amitkumardubey/praana/main/install.ps1 | iex

# Or with Bun (>= 1.4)
bun add -g praana
```

Then set a provider key and start:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # or OPENAI_API_KEY, OPENROUTER_API_KEY, ...
praana
```

On first run without a config file, `praana` opens a short setup wizard. Update later with `praana upgrade`.

## Status

v0.16.0 <!-- x-release-please-version --> and experimental. PRAANA manages what the model sees on each turn, but we have not measured whether that beats a plain transcript agent, so we don't claim it does. Most of the code was written by coding agents under human direction and review. See the [known limitations](./docs/reference.md#known-limitations).

[Docs](https://amitkumardubey.github.io/praana/) · [Reference](./docs/reference.md) · [Roadmap](./ROADMAP.md) · [Feedback](./CONTRIBUTING.md) · [MIT license](./LICENSE)

## Prompt keys

- **Enter** — send the message
- **Ctrl+J**, **Alt+Enter**, **Ctrl+Enter**, **Shift+Enter** — insert a newline (Shift+Enter only on terminals that report it distinctly)
- A trailing **`\` + Enter** — insert a newline (double `\\` + Enter sends)
