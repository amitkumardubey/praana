# Reference

Install options, configuration, commands and known limitations for the current release. For how PRAANA is built, see [Architecture](https://amitkumardubey.github.io/praana/architecture/) and [Concepts](https://amitkumardubey.github.io/praana/concepts/).

## Install

### Installer scripts (no Bun)

**Linux / macOS** (bash, zsh, WSL):

```bash
curl -fsSL https://raw.githubusercontent.com/amitkumardubey/praana/main/install.sh | bash
```

**Windows** (PowerShell — use this instead of `curl | bash`):

```powershell
irm https://raw.githubusercontent.com/amitkumardubey/praana/main/install.ps1 | iex
```

From **cmd.exe**:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/amitkumardubey/praana/main/install.ps1 | iex"
```

Installs `praana` (or `praana.exe` on Windows), `praana-natives.node`, and `praana-natives.json` into `~/.local/bin` / `%USERPROFILE%\.local\bin`. Keep these files in the same directory — search, tree-sitter `code_*`, and native embeddings load the sidecar next to the binary. The scripts on `main` always download the **latest GitHub Release**, which can lag `main` by one version. Linux musl (Alpine) is not supported on this path; use `bun add -g praana` instead.

Upgrade later with `praana upgrade` (alias `praana update`) — it re-runs the installer into the current prefix (or `~/.local/bin` if you originally installed via bun/npm). Interactive sessions toast when a newer npm version exists; `/settings set auto_update on` (off by default) applies that upgrade in the background and asks you to restart.

### Install with Bun

```bash
# Install globally
bun add -g praana

# Or run without installing
bunx praana
```

Requires **Bun ≥ 1.4**. Install at [bun.sh/install](https://bun.sh/install).

Global `bun add -g` / `npm i -g` installs `@praana/natives` as an optional dependency (Tree-sitter `code_*` tools). `praana doctor` reports whether the addon loaded.

### Standalone binary (manual)

GitHub Releases attach `praana-{linux-x64,linux-arm64,darwin-arm64,darwin-x64}.tar.gz`, `praana-windows-x64.zip`, plus `SHA256SUMS`. Each archive contains the compiled executable, `praana-natives.node`, and `praana-natives.json` in the same folder (`praana` or `praana.exe` on Windows). Prefer [`install.sh`](https://github.com/amitkumardubey/praana/blob/main/install.sh) on Linux/macOS or [`install.ps1`](https://github.com/amitkumardubey/praana/blob/main/install.ps1) on Windows unless you need a custom layout.

```bash
# Example: Linux x64
curl -fsSL -o praana-linux-x64.tar.gz \
  https://github.com/amitkumardubey/praana/releases/latest/download/praana-linux-x64.tar.gz
curl -fsSL -o SHA256SUMS \
  https://github.com/amitkumardubey/praana/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
tar xzf praana-linux-x64.tar.gz
./praana --version
praana doctor   # native: available (…)
```

### PATH for global install

After `bun add -g praana`, ensure Bun's global bin directory is on your PATH:

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

Optional standalone binary (embeds Bun + app; Solid JSX via `@opentui/solid/bun-plugin`). Prefer a GitHub Release archive (see Standalone binary above) unless you are iterating on compile itself:

```bash
bun run build:compile   # → dist/praana
./dist/praana
```

Unreleased / dirty trees bake `--version` as `{package}-dev.<shortsha>[.dirty]` (exact release tag + clean tree stays the package version).

## First run

```bash
export ANTHROPIC_API_KEY="sk-ant-..."    # or any supported provider below
praana
```

PRAANA auto-detects which provider key is set. On first run with no config file, it runs an interactive setup wizard. The interactive UI is a terminal UI built on OpenTUI, with slash-command autocomplete, transcript rendering, and full thinking-text display when `/thinking on` is enabled.

## Configuration

No config file is needed to start. To customise, run the setup wizard:

```bash
praana setup   # Interactive provider/config setup wizard (also `praana init` alias)
```

Other CLI entry points: `praana run "<instruction>"` (headless one-shot for Harbor/CI), `praana resume` (continues your most recent session for the current project when given no id), `praana upgrade` (installs the latest GitHub Release binary + sidecar; alias `praana update`), `praana doctor` (checks config + provider keys), `praana providers` (lists configured providers; `--all` includes unconfigured), `praana models` (lists models), and `praana memory dedupe` (merges duplicate Cognitive Memory entries). See [`praana.config.example.toml`](https://github.com/amitkumardubey/praana/blob/main/praana.config.example.toml) for all settings. Harbor / Terminal-Bench: [`harbor_eval/README.md`](https://github.com/amitkumardubey/praana/blob/main/harbor_eval/README.md).

### Supported providers

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
| Cerebras | `CEREBRAS_API_KEY` |
| NVIDIA | `NVIDIA_API_KEY` |
| Poolside | `POOLSIDE_API_KEY` |
| Umans | `UMANS_API_KEY` |
| OpenCode | `OPENCODE_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Amazon Bedrock | AWS credentials (`AWS_ACCESS_KEY_ID` / `AWS_PROFILE` / role) or `AWS_BEARER_TOKEN_BEDROCK` / Bedrock API key via `/login`. Optional `llm.region`. |
| Ollama | *(local — no key needed)* |
| GitHub Copilot | Sign in with `/login github-copilot` (OAuth) |
| OpenAI Codex | ChatGPT subscription sign-in with `/login openai-codex`: browser (default) or device code |

Provider resolution order: explicit config → credential store (`~/.praana/credentials.json`) → environment-detected key → interactive setup.

### ChatGPT subscription login

Run `/login openai-codex` and choose a method. After sign-in, the default
model is `gpt-6.1-sol`. `/model` lists the curated Codex models (`gpt-6.1-sol`,
`gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`). There is no bare `gpt-5.6` id.
`gpt-reserve` and `codex-auto-review` are not listed.

- **Browser login (default):** PRAANA opens the authorization URL and listens only
  on `127.0.0.1:1455`. The registered redirect is
  `http://localhost:1455/auth/callback`. Finish in the browser or paste the redirect
  URL, `code#state`, a query string containing `code=`, or a bare authorization code.
  A supplied state must match this login. The URL stays visible while paste input
  waits, as one copyable string (the overlay soft-wraps it; it is not broken with
  blank lines). The paste field stays on screen. Receiving the callback dismisses
  that input without cancelling login.
  Closing the paste prompt cancels login and does not replace a saved credential.
  A blank paste is refused. An invalid paste (typo, state mismatch, or empty code)
  is reported and asked for again. While the callback listener is running, a bad
  paste does not end the login. Cancelling still ends the login. When the callback
  port is unavailable and paste is the only path, PRAANA stops after five bad
  pastes. The paste prompt mentions finishing in the browser only when that
  listener is running.
  If the port is occupied (for example by Codex CLI), PRAANA reports manual-only
  mode. Any other bind failure is reported with its error code and still allows
  paste. Requests whose `Host` is not `localhost:1455` or `127.0.0.1:1455` are
  rejected. When login finishes or is cancelled, PRAANA closes the listener and
  drops open connections so port 1455 can be used again immediately. Browser
  authorization and exchange have a 10-minute overall timeout.
- **Device-code login:** open the displayed verification URL on any browser and
  enter the displayed code. No localhost callback is needed. PRAANA polls for up to
  15 minutes. HTTP 429, 502, 503, and 504 (including a non-JSON body) are retried
  until that deadline, waiting the poll interval or `Retry-After` seconds when
  present, capped at 30 seconds. Any other unexpected status stops the login.
  If the server does not offer device authorization, use browser login.

Signs in with your ChatGPT account via the Codex CLI sign-in.
PRAANA uses PKCE, validates the token's ChatGPT account id, and rotates refresh
tokens. A previously pasted credential is used as-is while it is unexpired if
the access token is a JWT that contains the ChatGPT account id. An opaque
pasted token, or a legacy credential that actually needs a refresh (no account
id, or the refresh token equals the access token), still requires
**`/login openai-codex` again**.

**WSL / SSH:** the browser must be able to reach the machine running PRAANA at the
localhost redirect above. WSL tries `wslview`, then
`powershell.exe -NoProfile -NonInteractive -Command Start-Process`, then `xdg-open`
if an opener fails to spawn. Windows uses `rundll32 url.dll,FileProtocolHandler`
so `&` in the authorize URL is not treated as a command separator. If opening fails
or the browser cannot reach the callback,
copy the visible URL and paste the final redirect, or choose device-code login.
Keep the listener on `127.0.0.1:1455`; do not expose it on `0.0.0.0`.

PRAANA refreshes an access token that is expired or inside 60 seconds of expiry
before a Codex request. Refresh tokens rotate, so overlapping refreshes for the
same sign-in share one request.

Saving a credential and refreshing a token are separate. A save (a new key, a
login, or a logout) is a short update: PRAANA locks the credentials file, re-reads
it, writes, and releases the lock before any network call. Another save waits at
most 2 seconds for that lock. The wait is short because the lock is never held
during a refresh.

A refresh takes its own lock for that provider and holds it while the refresh
request runs. Other sessions wait for that lock without freezing, checking about
every tenth of a second for up to 30 seconds. When the lock is free they re-read
the saved token. If another session already refreshed it, they use that token and
do not send a second refresh. If the wait runs out and the access token is still
usable, PRAANA uses it. If the access token is already expired, PRAANA reports
`another PRAANA session is refreshing; try again`. That is not a session expiry.

The lock is published together with its contents, so a lock that is still empty
is not treated as abandoned unless it is more than 5 seconds old. A lock whose
process is gone, or that is older than 60 seconds, is removed. PRAANA reads the
lock again immediately before removing it, so a lock that was just replaced is
left alone.

Cancelling one request does not cancel the refresh for anyone else. Once a refresh
request has started, PRAANA finishes it and saves the new token even if every
caller cancels. A logout or a newer login that lands before the refreshed token is
saved is left as it is.

If refresh fails and the stored access token is already expired, the turn stops
and reports `OpenAI Codex session expired and could not be refreshed: <reason>.
Run /login openai-codex again.` once, as an error, and the turn is still recorded.
If the access token is not yet expired, PRAANA keeps using it and logs a warning.

Codex requests identify PRAANA and the token's ChatGPT account, disable response
storage (`store: false`), and omit `max_output_tokens` and `temperature`. Codex
streams report backend failures, an incomplete response for any reason other than
`max_output_tokens`, or a missing terminal event as errors. A finished Codex
answer is terminal on `response.completed`, `response.incomplete`,
`response.done`, or a final `data: [DONE]` line. A `max_output_tokens` cutoff of
plain text finishes with the partial output and reason `length`. A cutoff while a
tool call is still being sent is an error: `The response was cut off while the
model was calling a tool.` Other Responses providers keep the previous stream
behaviour.

## Slash commands

| Command | Purpose |
|---|---|
| `/help` | Full list |
| `/exit` (alias `/quit`) | End session — runs summariser when memory is on |
| `/clear` | Reset in-session context (same session ID; clears working memory and model-visible history) |
| `/new` | Start a new session (new ID, reload config, background summariser) |
| `/state` | Working-memory objects (engine mode) |
| `/digest` | Cognitive Memory digest |
| `/recall <query>` | Search Cognitive Memory |
| `/memory dedupe` | Merge duplicate Cognitive Memory entries |
| `/stats` | Session + memory stats |
| `/scorecard` | Per-session telemetry signals |
| `/events` | Last 20 session log events |
| `/model [provider] <id>` | Switch model (bare `/model` opens a searchable selector) |
| `/reasoning <level>` | Set reasoning effort (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`) |
| `/sessions` | List sessions to resume |
| `/login [provider]` | Add or update a provider credential |
| `/logout [provider]` | Remove a provider's credentials |
| `/shell <cmd>` | Run a shell command inline (also `! <cmd>`) |
| `/plan <on\|off\|execute>` | Plan mode: block mutating tools until you approve |
| `/thinking <on\|off>` | Show or hide reasoning text |
| `/incognito <on\|off>` | Disable Cognitive Memory writes |
| `/settings` | View/set persistent preferences (`~/.praana/settings.json`) |
| `/debug` | Verbose tooling + saved prompts |
| `/why <id>` | Why a context unit was included (engine + debug) |

### `/model` syntax

```text
/model                          # searchable selector (or show current if non-TTY)
/model gpt-4o                   # model on current provider
/model openai gpt-4o            # switch to OpenAI native
/model opencode mimo-v2.5-free  # switch to OpenCode
/model openrouter openai/gpt-4o # route via OpenRouter
```

Unknown ids resolve against the bundled pi-ai catalog first, then against the provider's live catalog (HTTP `/models` or Bedrock control-plane APIs; cached 6 hours at `~/.praana/provider-catalog-cache.json`).

## Prompt keys

- **Enter** — send the message
- **Ctrl+J**, **Alt+Enter**, **Ctrl+Enter**, **Shift+Enter** — insert a newline (Shift+Enter only on terminals that report it distinctly)
- A trailing **`\` + Enter** — continue the line on the next line, but only when the caret is at the end of the current line (end of the buffer, or immediately before a newline). An odd run of trailing backslashes continues the line (one backslash is dropped and a real newline inserted); an even run — for example type two to send a literal trailing backslash — submits with all backslashes kept. A backslash elsewhere mid-line is submitted literally.

## Features

**Two compile modes** (set `[context_engine] enabled` in config):

| Mode | Default | Behaviour |
|---|---|---|
| **Engine** | Yes | Tiered working memory, stub artifact cards + retrieve on demand, session checkpoint, scored prompt compilation, progressive skills. |
| **Classic** | Fallback / explicit disable | Full verbatim transcript. Same shape as most coding agents. |

**Cognitive Memory** (on by default; turn it off with `[memory] enabled = false`, or pause writes for a session with `/incognito on`):

- At `/exit`, extracts facts, decisions, patterns, mistakes, preferences, and constraints from the transcript.
- Next session starts with a ranked digest in the prompt.
- Project sessions query both project-scoped and global memories and merge results.
- Entries decay over time with a half-life per kind: constraints never decay, mistakes 60 days, facts 90, preferences 180, decisions and patterns 365. Entries confirmed in two or more distinct sessions (with validity of at least 0.7) promote to deep memory (Layer 2), which decays four times slower.

**Skills:** discovers `SKILL.md` files in project and user paths. Compact catalog injected every turn, sorted by usefulness score. `load_skill(id)` fetches the full body on demand. Engine mode tracks whether each skill was used and updates its score in `memory.db`.

**Project context:** loads `AGENTS.md` / `CLAUDE.md` and an optional stack fingerprint on session start.

**Tools:** structured `search_code` and `find_files` (native addon) plus git tools (`git_status`, `git_diff`, `git_commit`), shell, file read/write/edit, and memory tools. Prefer the git tools over `shell git …` for agent decisions; `git_commit` is blocked in plan mode.

**Session safety:** plan mode gates mutating tools behind your approval; destructive or outward actions (`rm`, force-push, package installs, writes outside the project) ask for confirmation, and headless runs refuse them unless allowed in `[risk].allow`; known secret patterns are redacted from tool results and the event log; a loop breaker blocks a third identical mutating tool call, or a third attempt after two errors on the same file or command; a repeat-read interceptor warns or blocks re-reading unchanged files; `praana resume` with no id continues your most recent session for the current project.

## Known limitations

These are real gaps, not a roadmap dressed as marketing.

| Area | What's weak |
|---|---|
| **Memory reinforcement** | Memory stores, recalls, and applies time decay. Confidence boost on session success is wired but dormant until the session-success signal ships (#506). |
| **No published A/B evals** | Headless `praana run` and a Harbor / Terminal-Bench adapter exist. The fixed A/B task suite + scoring that would compare engine vs classic (#424) is not shipped. We don't publish benchmark claims we can't back. |
| **Semantic recall** | ONNX weights download on first run (about 90 MB for the default model, cached in `~/.praana/models/`) after a one-time consent prompt. Ollama is opt-in. Near-duplicate or conflicting memory entries are not automatically reconciled. |
| **Context engine** | On by default. Falls back to classic if initialization fails or if you set `[context_engine] enabled = false`. |
| **Background consolidation** | Runs about 30 seconds after a session ends (`[consolidation]`, on by default). It confirms, contradicts and promotes entries, but the wider learning loop is incomplete (see memory reinforcement). |
| **Model routing** | Not started. You choose the model; PRAANA does not pick one per task. |
| **Shell tool** | Runs with your user permissions. Optional path/command sandbox via `[shell]` in config — off by default. |

If Cognitive Memory doesn't help you after a few real projects, tell us. That's useful feedback, not a surprise.

## Development

```bash
bun dev          # run without build step
bun typecheck    # TypeScript type-check (no emit)
bun test
bun run test:parallel  # same suite, files across CPU cores (opt-in)
```

### Docs site (Astro)

GitHub Pages is built from [`website/`](https://github.com/amitkumardubey/praana/tree/main/website). Markdown sources in [`docs/`](https://github.com/amitkumardubey/praana/tree/main/docs) are rendered at build time.

```bash
cd website && bun install && bun run dev    # http://localhost:4321/praana/
cd website && bun run build                 # output → website/dist/
```
