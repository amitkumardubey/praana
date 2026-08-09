# Roadmap

Where PRAANA is heading. This is **direction, not promises** — PRAANA is experimental, and we don't give dates or claim results we can't show.

> For what works today and its rough edges, see **[Known limitations](./README.md#known-limitations-honest)** in the README. Version history lives in [CHANGELOG.md](./CHANGELOG.md).

---

## What PRAANA is

A terminal coding agent that aims to get more useful the more you use it — by keeping long sessions on track and carrying knowledge across sessions. Whether that meaningfully beats a plain transcript agent for your workflow is something we're **still proving in real use**. We don't publish benchmark claims we can't back up.

---

## Available today

These exist and work — we're not claiming they're solved problems, just that they're there:

- **Easy onboarding** — auto-detects provider API keys; credential store (`~/.praana/credentials.json`); `praana setup` / `/setup` wizard; `/login` / `/logout`; `praana doctor`; `praana providers` / `praana models`
- **Terminal UI** — markdown rendering, syntax highlighting, themes, status bar, searchable `/model` selector, slash-command/file autocomplete
- **Many providers** — Anthropic, OpenAI, DeepSeek, Groq, Google, Mistral, xAI, Fireworks, Together, OpenCode, OpenRouter, Amazon Bedrock (live catalog + IAM or API key), Ollama (local), umans
- **Headless / eval** — `praana run` one-shot for CI; Harbor / Terminal-Bench installed-agent adapter (`harbor_eval/`)
- **Tools** — code search, structured git (`git_status` / `git_diff` / `git_commit`), multi-file edits, concurrent independent tool calls (write-path guards), optional shell sandbox
- **Two context modes** — default *engine* mode (tiered working memory, tool-output distillation, session checkpoint, skills) and a *classic* fallback/disable mode (full transcript, like most agents)
- **Cognitive Memory** (optional) — extracts concise key-point learnings at session end (skips AGENTS.md/README content; classifies project vs global); ranked digest at next start
- **Plan mode** — `/plan` gates mutating tools behind your approval so the agent plans before it changes files
- **Shell access** — `/shell` (or `!`) runs commands inline in the transcript
- **Session UX** — persistent `/settings`; `/reasoning` effort; repeat-read interceptor (files-read index); `praana resume` (12-char id or most recent for cwd); stale-task banner + scope confirmation on resume

---

## In progress — making memory and context actually pay off

The honest gap today is that PRAANA *stores and recalls*, but we want it to genuinely *learn*. That's the focus:

- **Memory that learns from use** — strengthening what actually helps you and letting go of what doesn't, instead of just piling up notes.
- **Better recall out of the box** — semantic search by default, with no separate service to install.
- **Context that adapts to the task** — surfacing the right things for what you're doing right now, and staying fast on long sessions.
- **Knowing whether it helps** — Harbor/`praana run` give a headless substrate; the fixed A/B task suite + scoring (#17) is still the missing step. We won't claim engine beats classic until we can show it.

---

## Next

Smaller, concrete improvements:

- ~~Git tools (`git_status`, `git_diff`, `git_commit`)~~ — shipped (#26); first child of deterministic tools harness (#195)
- Quality-of-life: searchable command picker, named sessions, session cost in the status bar

---

## Not planned

- **GUI / web interface** — PRAANA is a terminal agent
- **Cloud sync** — local-first; your data stays on your machine
- **Multi-user shared memory** — single-user for now
- **Published benchmark claims** — no performance numbers until we have real eval data

---

## Contributing

Issues and PRs welcome. The most useful feedback right now: **after a few real projects, does Cognitive Memory actually help you?** If it doesn't, tell us — that's exactly the signal we need.
