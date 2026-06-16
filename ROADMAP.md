# Roadmap

Where PRAANA is heading. This is **direction, not promises** — PRAANA is experimental, and we don't give dates or claim results we can't show.

> For what works today and its rough edges, see **[Known limitations](./README.md#known-limitations-honest)** in the README. Version history lives in [CHANGELOG.md](./CHANGELOG.md).

---

## What PRAANA is

A terminal coding agent that aims to get more useful the more you use it — by keeping long sessions on track and carrying knowledge across sessions. Whether that meaningfully beats a plain transcript agent for your workflow is something we're **still proving in real use**. We don't publish benchmark claims we can't back up.

---

## Available today

These exist and work — we're not claiming they're solved problems, just that they're there:

- **Terminal UI** — markdown rendering, syntax highlighting, themes, status bar, mid-session model switching
- **Many providers** — OpenRouter, OpenAI, DeepSeek, Groq, xAI, Fireworks, and more
- **Tools** — code search, multi-file edits, diff preview before writes, optional shell sandbox
- **Two context modes** — *classic* (full transcript, like most agents) and an opt-in *engine* (tiered working memory, tool-output distillation, session checkpoint, skills)
- **Cross-session memory** (optional) — extracts learnings at the end of a session and surfaces a ranked digest at the start of the next; project and global scopes

---

## In progress — making memory and context actually pay off

The honest gap today is that PRAANA *stores and recalls*, but we want it to genuinely *learn*. That's the focus:

- **Memory that learns from use** — strengthening what actually helps you and letting go of what doesn't, instead of just piling up notes.
- **Better recall out of the box** — semantic search by default, with no separate service to install.
- **Context that adapts to the task** — surfacing the right things for what you're doing right now, and staying fast on long sessions.
- **Knowing whether it helps** — building the measurement to tell, honestly, whether memory and the engine beat a plain agent. We won't claim they do until we can show it.

---

## Next

Smaller, concrete improvements:

- Git tools (`git_status`, `git_diff`, `git_commit`)
- Quality-of-life: searchable command picker, named sessions, session cost in the status bar, settings that persist
- Clean-install testing on fresh environments

---

## Not planned

- **GUI / web interface** — PRAANA is a terminal agent
- **Cloud sync** — local-first; your data stays on your machine
- **Multi-user shared memory** — single-user for now
- **Published benchmark claims** — no performance numbers until we have real eval data

---

## Contributing

Issues and PRs welcome. The most useful feedback right now: **after a few real projects, does cross-session memory actually help you?** If it doesn't, tell us — that's exactly the signal we need.
