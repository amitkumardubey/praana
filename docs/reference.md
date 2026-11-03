# Reference

Install options, configuration, commands and known limitations for the current release. For how PRAANA is built, see [Architecture](https://amitkumardubey.github.io/praana/architecture/) and [Concepts](https://amitkumardubey.github.io/praana/concepts/).

## Install

### Installer scripts (no Bun)

**Linux / macOS** (POSIX `sh`; works from bash, zsh and WSL):

```bash
curl -fsSL https://raw.githubusercontent.com/amitkumardubey/praana/main/install.sh | sh
```

The installer needs `curl`, `tar` and the standard POSIX tools (`sha256sum` or `shasum`) on `PATH` (bare Debian/Ubuntu: `apt-get install -y curl tar coreutils`). Alpine/musl is not supported on this path; use `bun add -g praana` instead.

**Windows** (PowerShell — use this instead of `curl | sh`):

```powershell
irm https://raw.githubusercontent.com/amitkumardubey/praana/main/install.ps1 | iex
```

From **cmd.exe**:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/amitkumardubey/praana/main/install.ps1 | iex"
```

Installs `praana` (or `praana.exe` on Windows), `praana-natives.node`, and `praana-natives.json` into `~/.local/bin` / `%USERPROFILE%\.local\bin`. Keep these files in the same directory — search, tree-sitter `code_*`, and native embeddings load the sidecar next to the binary. The scripts on `main` always download the **latest GitHub Release**, which can lag `main` by one version.

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

`praana doctor` exits non-zero when a check fails or configuration warnings were printed. A run where every check passes but some printed a `⚠` (for example embedder weights not downloaded yet) ends with `All checks passed (N warnings).` N counts every warning line, indented or not. Configuration warnings are indented (`  ⚠ …`) and fail the run, so that summary stays `Some checks failed.`

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

### LLM stream timeouts

These keys live in `[llm]`. A value that is not a non-negative integer warns and the provider default is used instead. `0` turns that timer off. An explicit value applies to every provider. Omitting a key does not change timeouts for other streams in the process; each request resolves its own budget.

Connect time is time until the first response headers. Local and self-hosted servers often spend that time loading a model or prefilling the prompt, so they get a longer budget than hosted APIs. Idle time is silence from the server after the response has started, including a reasoning model that has not emitted a token yet. It is not reset by the client being slow to read a chunk it already received.

| Key | Default | Behaviour |
|---|---|---|
| `connect_timeout_ms` | `60000` for `anthropic`, `openai`, `google`, `vertex`, and `amazon-bedrock`; `300000` for every other provider (user-declared endpoints, Ollama, LM Studio, vLLM, and the rest of the registry). A user-declared id uses `300000` even when that id is also in the hosted list. | Abort the request if response headers have not arrived. The failure is retried before any tokens are emitted. |
| `stream_idle_timeout_ms` | `300000` | Abort if the server stays silent this long. The timer resets when an upstream chunk arrives, including SSE comment keep-alives, and pauses while that chunk is processed. The stream ends with reason `timeout`. Partial text is kept when the assistant message has no unpaired tool call, and the turn reports `The model stopped responding (idle timeout after Ns).` A user abort is still reason `abort`. |

A non-OK response body is read under the same idle budget, capped at 15 seconds (or 15 seconds when idle is disabled). If that body never arrives, the error is the HTTP status plus `response body timed out`.

### LLM stream end check

`stream_end_check` lives in `[llm]`. A value other than `auto`, `strict`, or `lenient` warns and falls back to `auto`.

| Key | Default | Behaviour |
|---|---|---|
| `stream_end_check` | `auto` | What to do when a stream closes cleanly without the provider's final signal (Anthropic `message_stop` / `stop_reason`, OpenAI-compatible `finish_reason` or `[DONE]`, Google `finishReason`, Bedrock `messageStop`). `strict` returns an error. `lenient` treats the close as a normal finish (text received so far, same reason mapping as a completed stream) and writes a debug log: `<provider>: stream ended without a final event; accepted (lenient)`. `auto` is strict for `anthropic`, `openai`, `google`, `vertex`, and `amazon-bedrock`, and lenient for every other provider, including user-declared `[providers.<id>]` endpoints and local servers. A user-declared id is lenient under `auto` even if that id is also in the strict list. |

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
  that input without cancelling login. Dismissing the paste prompt on its own
  rejects that prompt with a dedicated error instead of leaving it pending.
  Login continues when the browser callback can still finish it. When paste is
  the only path, that error ends the login.
  Closing the paste prompt, the method list, or the device-code screen with Esc
  cancels login and does not replace a saved credential. In the setup wizard,
  Esc returns to the previous step and does not show a failed login.
  A blank paste is refused. An invalid paste (typo, state mismatch, or empty code)
  is reported and asked for again. While the callback listener is running, a bad
  paste does not end the login. Cancelling still ends the login. When the callback
  port is unavailable and paste is the only path, PRAANA stops after five bad
  pastes. The paste prompt mentions finishing in the browser only when that
  listener is running.
  If the port is occupied (for example by Codex CLI), PRAANA reports manual-only
  mode. Any other bind failure is reported with its error code and still allows
  paste. If the listener fails after it has started, PRAANA reports that failure
  and keeps waiting for a paste. That error does not cancel login while paste can
  still finish it. A provider rejection in the redirect, such as `access_denied`,
  ends the login immediately with the provider's message. Requests whose `Host` is not `localhost:1455` or `127.0.0.1:1455` are
  rejected. When login finishes or is cancelled, PRAANA closes the listener and
  drops open connections so port 1455 can be used again immediately. Browser
  authorization and exchange have a 10-minute overall timeout.
- **Device-code login:** open the displayed verification URL on any browser and
  enter the displayed code. No localhost callback is needed. PRAANA polls for up to
  15 minutes. HTTP 429, 502, 503, and 504 (including a non-JSON body) are retried
  until that deadline, waiting at least the poll interval, or `Retry-After`
  when that is longer, capped at 30 seconds. A network failure while polling (connection
  reset, DNS, timeout) is retried the same way. Ten of those failures in a row
  stop the login and report that error. Any other unexpected status stops the login.
  If the server does not offer device authorization, use browser login.

Signs in with your ChatGPT account via the Codex CLI sign-in.
PRAANA uses PKCE, validates the token's ChatGPT account id, and rotates refresh
tokens. A refresh response is saved even when the new access token is not a JWT
or has no account id: the stored account id is kept, and a missing `refresh_token`
keeps the previous refresh token. Those fields are written before a refresh is
reported as failed, because the provider has already rotated the token. An
authorization-code exchange still requires an access token, a refresh token, a
numeric expiry, and an account id inside the access token. A previously pasted
credential is used as-is while it is unexpired if
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
request runs. PRAANA reads the saved token under the short credentials lock
first, including when this process has not cached the file yet or another
process has rewritten it. If the access token is still outside the 60-second
refresh window, that token is used immediately and the refresh lock is not
taken. Other sessions wait for the refresh lock only when a refresh is actually
needed. They wait without freezing, checking a few times a second for up to 30
seconds, including when another refresh in this process already holds the lock.
When the lock is free they re-read the saved token. If another session
already refreshed it, they use that token and do not send a second refresh. If
the wait runs out and the access token is still usable, PRAANA uses it and does
not ask you to log in again. If the access token is already expired, PRAANA
waits for that same bound once more. If it is still expired, PRAANA reports
`another PRAANA session is refreshing; try again in a moment`. That is not a
session expiry and it does not say to run `/login` again.

The lock is held by the operating system for the life of the process that took
it. When that process exits, crashes, or is killed, the system releases the lock
at once. PRAANA does not decide that a lock has gone stale, and it does not
replace a lock another live process still holds. A lock file that is not a
database is retried a few times, then replaced once if it is still the same file.
An empty file is left alone, because SQLite treats it as a new database. If it
is still not a database, or it cannot be replaced, the wait fails with that
error instead of retrying until the timeout.

A save re-reads the credentials file under the lock before writing, edits a copy,
and replaces the in-memory cache only after that write succeeds. If the file
cannot be read, PRAANA leaves it unchanged and the save fails. If the file is
not valid JSON, PRAANA copies it to `credentials.json.corrupt-<timestamp>`
(mode 0600) and then replaces the original with the new store. The original
path changes only when that save succeeds. If the save fails, the original
file and the cached credentials stay as they were, and the backup copy is
left beside them. A missing file is still created. The cache treats the file
as unchanged only when the device,
inode, size, and timestamps still match the read that filled it.

Cancelling one request does not cancel the refresh for anyone else. Aborting
while still waiting for another session's refresh lock stops that wait only;
the session that holds the lock is left alone, and any other waiter keeps
waiting. Once a refresh request has started, PRAANA finishes it and saves the
new token even if every caller cancels. The 15-second limit applies until
response headers arrive. Reading
the body may then take up to 60 seconds, so a slow body does not discard a refresh
token the provider has already rotated. A logout or a newer login that lands before
the refreshed token is saved is left as it is.

If refresh fails and the stored access token is already expired, the turn stops
and reports `OpenAI Codex session expired and could not be refreshed: <reason>.
Run /login openai-codex again.` once, as an error line. That text is not saved as
the assistant's reply. The turn is not counted, no tokens are charged, and that
user message is left out of the next prompt. A refresh that saves a new refresh
token but leaves an expired access token does not hand that access token to the
model. If the access token is not yet expired, PRAANA keeps using it and logs a warning.

Codex requests identify PRAANA and the ChatGPT account saved with the
credential. When that saved account id is present, PRAANA sends it even if the
access token's own account id is missing or different. A different token supplied
for one request, and no account id with it, uses the account id inside that
token. Codex requests disable response
storage (`store: false`), and omit `max_output_tokens` and `temperature`. Codex
streams report backend failures, an incomplete response for any reason other than
`max_output_tokens`, or a missing terminal event as errors. A finished Codex
answer is terminal on `response.completed`, `response.incomplete`,
`response.done`, or a final `data: [DONE]` line. A `response.done` whose payload
status is `failed` or `cancelled`, or that carries an error, is a failure, the
same as `response.failed`. A `max_output_tokens` cutoff of
plain text finishes with the partial output and reason `length`. A cutoff while a
tool call is still being sent is an error: `The response was cut off while the
model was calling a tool.` That check is the same for `response.incomplete`,
`response.done`, and `response.completed` when the status is incomplete.
A tool call that has already finished is still published. Other Responses providers keep the previous stream
behaviour.

## Slash command palette

Typing `/` in the prompt opens the palette. With an empty query it lists commands by usefulness, not alphabetically: `/help`, `/model`, `/sessions`, `/settings`, `/stats`, … first, and the session-ending or state-wiping commands (`/logout`, `/new`, `/clear`, `/exit`/`/quit`) last — so `/` + Enter never quits or wipes anything. Typing a query ranks by match quality instead (typing `exit` still puts `/exit` first).

## Exit codes

A normal quit — `/exit`, or Ctrl+C with an empty prompt — exits `0` when a session exists, including the first session created by the first-run setup wizard, and when setup was not needed. Exit code `1` is used only when shutdown happens with no session and setup was cancelled, failed, pending, or succeeded but the session never started.

## Slash commands

| Command | Purpose |
|---|---|
| `/help` | Slash commands (grouped, with aliases), prompt keys, and the status-bar legend. Command-line commands stay on `praana --help` |
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
- **Esc** — close autocomplete, leave transcript focus, or dismiss an overlay
- **`!<command>`** — run a shell command directly, the same as `/shell <command>` (a bare `!` shows `Usage: !<command>`)
- **Mouse** — clicking or drag-selecting text in the transcript never takes the keyboard away from the prompt: you can keep typing (and paste) right after a selection. `F9` is the deliberate exception: it hands the keyboard to the transcript for entry navigation until `Esc`.
- **Ctrl+C** — copies the selected text when something is selected (any non-empty selection counts, including whitespace-only selections). It uses a native clipboard tool when one is available (wl-copy/xclip/xsel on Linux, pbcopy on macOS, clip.exe on Windows/WSL) and otherwise falls back to the terminal clipboard via OSC 52 — which depends on your terminal supporting it; in that case the toast says “Sent N characters to the terminal clipboard (OSC 52)”. Without a selection it interrupts a running turn, clears the input, or exits when idle with an empty input. A selection copies in the palette, model, and slash overlays too; in the palette and model overlays Ctrl+C with no selection closes the overlay (like Escape) and additionally interrupts a running turn when one is in progress; the modal setup / consent / login / logout screens keep their own Ctrl+C (cancel).
- **F9** — focus the transcript (Up/Down move the selection, Enter expands a tool row, Esc returns to the prompt)

`/help` prints this same key list. The result overlay scrolls with Up/Down/PageUp/PageDown when the text is taller than the frame (`↑↓ scroll · enter/esc close`); scroll keys never dismiss the overlay — only Esc/Enter or any other key does.

## Status bar

The footer abbreviations, also listed by `/help`:

| Label | Meaning |
|---|---|
| `ctx` | Tokens in use / model window, plus how full the window is |
| `%w` | Weighted fill percent in engine mode. Classic mode shows a plain `%` |
| `wm` | Working memory tiers: `nA` active, `nS` soft, `nH` hard. Hidden when all are zero |
| `skills` | Loaded skills, or the catalog size when none are loaded |
| `think` | Reasoning effort (`think medium`), or the stream when thinking is on |
| `engine` | Context engine is on |
| `mem` | Cognitive Memory writes are on or off. Incognito replaces this with `incognito` |
| `debug` | Debug mode is on |
| `plan` | Plan mode is on: mutating tools are blocked |
| `update` | A newer version is available |
| `restart` | An update was installed; restart to apply it |
| `(N% raw)` | Raw fill percent, shown when it diverges from the weighted % by more than 15 points |
| `compact` / `emergency` | Context pressure mode, shown when not normal |
| `in` / `out` | Session input and output tokens, when cost display is on |

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
