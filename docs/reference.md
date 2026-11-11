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

Upgrade later with `praana upgrade` (alias `praana update`) — it checks GitHub first for the latest release, with npm as the fallback, and re-runs the installer into the current prefix (or `~/.local/bin` if you originally installed via bun/npm); if your shell still shows the old version, run `hash -r` (bash) or `rehash` (zsh). Interactive sessions toast when a newer npm version exists; `/settings set auto_update on` (off by default) applies that upgrade in the background and asks you to restart.

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

PRAANA pins `@opentui/core`, `@opentui/solid`, and `@opentui/keymap` to exactly `0.8.0` (no caret), and carries the eight `@opentui/core-<os>-<cpu>` native platform packages as `optionalDependencies` pinned to `0.8.0` so each platform installs (and bundles) only its own binary. OpenTUI's experimental native input parser is opt-in: try it with `OTUI_NATIVE_INPUT_PARSER=1`. Synchronized output uses OpenTUI's `auto` default (the wrapper is skipped in remote sessions that do not report mode 2026).

For terminals where streaming answers flicker, set `PRAANA_TUI_SYNC_OUTPUT` to `always` to force synchronized output or `never` to disable it. Values are case-insensitive; `auto`, an unset variable, or any other value uses OpenTUI's default.

While an assistant answer is still streaming, the transcript omits an unfinished list marker, trailing spaces on a list item, and trailing newlines from the markdown view. OpenTUI's streaming preview paints those tails as an extra row and the next frame removes it; following both heights bounced the viewport by one line. The finished answer is rendered in full.

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

### Per-turn step budget

A *step* is one model round-trip (it may contain several parallel tool calls). The `[turn]` section controls how long a single turn may keep calling tools:

| Key | Default | Meaning |
|---|---|---|
| `max_steps` | 25 | Hard cap on steps per user message when the session is **headless** (`praana run`, Harbor, CI) **or** the UI sink does not provide `onStepPause` (non-interactive sinks, subagents, tests). `--max-steps N` overrides it for one headless run. Reaching the cap executes the current tool batch, then runs the wrap-up. |
| `pause_after_steps` | 50 | When the sink provides `onStepPause`, the session pauses before executing the next tool batch every time steps used reaches a multiple of this value. |
| `hard_max_steps` | 300 | Absolute ceiling for those interactive sessions: reaching it stops *without asking* and writes the wrap-up summary. If this is not above `pause_after_steps` (lower or equal), PRAANA warns, keeps this ceiling, and disables the pause: the turn stops at the ceiling with a wrap-up and does not ask. |

The pause/ceiling path runs only when the sink provides `onStepPause`. Headless runs and every other sink use `max_steps` and never prompt.

When an interactive turn reaches a multiple of `pause_after_steps`, PRAANA stops the spinner and shows a small prompt: `Used N steps this turn. Continue?` In the TUI, **Enter** continues, **Esc** stops and asks for a short summary, and **Ctrl+C** aborts the turn without that summary. An Enter or Esc that is already in flight is ignored for a brief moment so the prompt does not continue or stop by accident. Ctrl+C is not delayed. A slash-result panel does not hold that prompt: it closes and the continue question opens immediately. Opening another interactive dialog (palette, model, login, logout, setup) while the prompt is up waits until you answer; it does not count as stop, and the other dialog opens afterwards. Closing the prompt answers only the prompt on screen, so a dialog requested while it was showing still opens, and the keyboard stays with that dialog until nothing is left open. Cancelling the turn closes the prompt. On the plain terminal the prompt says `Enter or y = continue, anything else = stop` — **Enter**, **y**, or **yes** continues, and any other line stops (readline has no Esc key). Ctrl+C there is the terminal interrupt: while a turn is running it aborts that turn and does not ask for a summary. The next pause is another `pause_after_steps` later. Focus returns to the input when the prompt closes and nothing else is open, and the spinner starts again if you continue.

**Wrap-up:** a turn that stops at a limit runs one final model call with **no tools**, asking for a short summary of what was done and what remains. While that request is in flight the spinner reads `wrapping up…` until the first text arrives, or until the request ends, fails, or is aborted. The summary streams like a normal reply, separated from the preceding step text by a blank line. The "do not call tools" instruction is sent only with that call and is not kept in the transcript. The summary is stored only when it has visible text (a thinking-only or blank reply is not stored). If the model still returns tool calls, they are dropped and not executed. If the wrap-up call fails, the error is reported the same way as any other model error (and, when nothing was streamed yet, the turn still ends with the normal banner). A summary that exists only on the final message of a failed wrap-up is not shown or stored, and the context token count includes a wrap-up reply only when that reply is kept. Ctrl+C during the wrap-up interrupts the turn and keeps whatever summary text was already streamed.

Tool results on that no-tools request include text only (image and other non-text parts are omitted). Each result is cut at 2,000 characters and ends with `[truncated]` when it was cut. Adjacent user messages are merged so the request alternates roles.

What is already in history depends on which limit fired:

- **Soft-pause stop** and **hard ceiling** (`hard_max_steps`): the model has already asked for a tool batch, but that batch is **not executed** (stopping must not edit files). Each pending tool call is recorded as an error result: `Not executed: the step budget was reached and the turn was stopped.` Then the wrap-up runs.
- **Headless cap** and **any sink without `onStepPause`** (`max_steps`): the last tool batch **runs first**, its results stay in history, and then the wrap-up runs.

Set any of the three keys to `0` (or use a non-positive value) to fall back to the default; invalid values log a config warning and use the default. A NaN, fraction, or negative that reaches a turn without going through config loading is clamped to the same default and does not warn again.

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

### First-party OpenAI API routing

With provider `openai`, no configured `llm.base_url`, and the built-in
`https://api.openai.com/v1` endpoint, PRAANA uses **Responses** (`/v1/responses`)
for bare model ids in these families:

- `gpt-5.4` and later **5.x** minor versions, including hyphenated variants and
  dated ids (for example `gpt-5.4-mini`, `gpt-5.6-sol`).
- `gpt-6` and its dotted/hyphenated variants (for example `gpt-6-luna`,
  `gpt-6.1-terra`).

This is a **routing floor, not a supported-model list**. It addresses OpenAI's
[documented Chat Completions limit](https://developers.openai.com/api/docs/guides/migrate-to-responses):
starting with GPT-5.4, tool calling is not supported with `reasoning_effort` other
than `none`. It does not establish that every id matching the floor exists or
that Responses accepts it.

**Older models remain on Chat Completions exactly as before:** GPT-3.5, GPT-4,
GPT-4o, GPT-4.1, o-series, and GPT-5 through GPT-5.3. Their Responses support has
not been verified for this routing change. Non-text-generation variants whose id
suffix contains `audio`, `realtime`, `transcribe`, `tts`, `image`, `embedding`,
`moderation`, `search`, or `chat-latest` also stay on Chat Completions. Unknown
ids (including future major versions outside GPT-6) stay on Chat Completions.
Model listing and context window lookup are unchanged; `/models` presence is not
endpoint-capability data.

Any explicit `llm.base_url` (even the built-in URL), explicit `endpointUrl`, or
user-declared provider disables this automatic routing. OpenRouter, Umans,
Poolside, Ollama, and other OpenAI-compatible providers are not migrated. A
user-declared provider's explicitly chosen `api` still wins. The separate
`openai-codex` subscription route is unchanged.

The first-party Responses request sends the system prompt as `instructions`,
flat function tool definitions, tool results as `function_call_output`, text/image
input parts, and `max_output_tokens`. It sends `store: false`, so OpenAI does not
retain requests and responses through the Responses API's default storage. Reasoning
items are not carried across turns or tool steps; supporting encrypted reasoning
content is a follow-up. It does not add Codex headers or default Codex instructions.
Unset temperature is omitted. PRAANA's enabled
reasoning levels `minimal`, `low`, `medium`, `high`, and `xhigh` map unchanged to
`reasoning.effort`: the upstream
[OpenAI SDK type](https://github.com/openai/openai-node/blob/master/src/resources/shared.ts)
also includes `none`, `max`, and `null`. This SDK-wide union does **not** guarantee
that each model accepts every level. On the first-party Responses route, PRAANA
resolves `/reasoning off` to `none` (the supported wire level); on other routes it
keeps the historical `minimal` mapping for inferred reasoning models. A stream
request with no effort omits `reasoning`.

Input/output/total usage and `input_tokens_details.cached_tokens` are retained
when reported. Session accounting still consumes input/output totals. Existing
headless-report limitations are unchanged: `n_cache_tokens` remains `0`, unknown
model prices produce `cost_usd: null`, and `reasoning_effort_wire` records the last
effort passed to the stream, not later Chat driver corrections (including fallback
to `none` with tools). The existing strict/lenient stream-end rules below still
apply: incomplete or failed responses do not authorize tool execution.

If Responses returns HTTP **404** with `error.code = "model_not_found"` or wording
that a model is **not supported**, PRAANA tries Chat Completions once, before
emitting any event, and remembers that model for that credential for one hour.
A different API key or a later attempt after the hour is not pinned; it retries
Responses. It never switches protocol after an event or after abort, and never
switches on an SSE error.
The SDK verifies the error envelope but not the exact endpoint-rejection wording;
this conservative 404 heuristic is **unverified live**. Arbitrary 400s (including
invalid reasoning levels), authentication failures, and generic endpoint 404s are
surfaced rather than guessed to be model incompatibility. Use the explicit Chat
override below if needed. The existing Chat Completions reasoning/tools workaround
is retained for both fallback and override.

### Force OpenAI Chat Completions

If a first-party model rejects Responses, force Chat Completions with the existing
user-provider override (no new `[llm]` key). Keep `llm.provider = "openai"` and your
chosen `llm.model`; add this provider table:

```toml
[providers.openai]
api = "openai-completions"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
```

This disables automatic Responses routing for **all** models under `openai` and
retains first-party `max_completion_tokens` handling and the existing
`reasoning_effort: "none"` tools workaround. Remove the table to restore automatic
routing. User-declared providers are lenient under `stream_end_check = "auto"`;
set `[llm] stream_end_check = "strict"` to keep strict first-party stream checks.

### LLM fallback

Set both `[llm]` `fallback_provider` and `fallback_model` to use another provider/model after an eligible stream failure or when the primary sign-in cannot be refreshed. An explicit session model or provider override disables automatic fallback. The fallback becomes the session model only after it produces a usable finished answer.

### LLM stream timeouts

These keys live in `[llm]`. A value that is not a non-negative integer warns and the provider default is used instead. An integer above `2147483647` is also rejected with a warning and the provider default is used: `setTimeout` overflows past that and the timer would fire immediately. `0` turns that timer off. An explicit value applies to every provider. Omitting a key does not change timeouts for other streams in the process; each request resolves its own budget.

Connect time is time until the first response headers. Local and self-hosted servers often spend that time loading a model or prefilling the prompt, so they get a longer budget than hosted APIs. Idle time is silence from the server after the response has started, including a reasoning model that has not emitted a token yet. It is not reset by the client being slow to read a chunk it already received.

| Key | Default | Behaviour |
|---|---|---|
| `connect_timeout_ms` | `60000` when the provider is `anthropic`, `openai`, `google`, `vertex`, or `amazon-bedrock` and the effective base URL is unset or is that provider's built-in host. `300000` when `base_url` points at any other host (including loopback and private addresses), for every other provider, and for a user-declared id even when that id is also in the hosted list. An explicit number always wins. | Abort the request if response headers have not arrived. A connect timeout is fetched at most twice (the first attempt plus one retry, with up to 1.2s of backoff). The turn recognises that failure from a connect-timeout marker on the error, not from the letters ETIMEDOUT in the message, and does not retry it again: if a fallback model is configured, that model is asked next. A mid-stream socket error that merely mentions ETIMEDOUT still gets the turn's one retry. Worst case before the fallback request starts is about 121s on the 60s budget and about 601s on the 300s budget. Other retryable errors still use up to three driver retries and one more turn attempt before the fallback model. An idle timeout does not get that extra turn attempt: the same model is not asked again, and a configured fallback is used when automatic fallback is allowed. No tokens have been emitted yet. |
| `stream_idle_timeout_ms` | `300000` | Abort if the server stays silent this long. The timer resets when an upstream chunk arrives, including SSE comment keep-alives, and pauses while that chunk is processed. Anthropic finishes at `message_stop` (usage already arrived on `message_delta`) and Google finishes at `finishReason` (usage arrives on that same chunk); both cancel the rest of the body. OpenAI-compatible streams keep reading after `finish_reason` until a usage chunk or `[DONE]`, and Bedrock keeps reading after `messageStop` until `metadata`. That wait ends when the trailer arrives, the body ends, or 2 seconds pass (the idle budget, when that is shorter; 2 seconds when idle is disabled), then the body is cancelled. A connection left open cannot use up the idle budget. The stream ends with reason `timeout` only when the server actually goes silent. Partial text is kept. Tool calls from a stream that did not finish normally are never executed, including tool calls that already looked complete. The turn reports `The model stopped responding (idle timeout after Ns).` and adds `The partial answer above was not completed.` only when some text was streamed. On the first step the turn does not retry the same model after an idle timeout. When a fallback model is configured and automatic fallback is allowed, that model is asked next; otherwise the idle-timeout error is shown immediately. Text already streamed still skips both the retry and the fallback. A premature stream end is still retried once on the same model. A user abort is still reason `abort`. |

A non-OK response body is read under one deadline: the idle budget, capped at 15 seconds (or 15 seconds when idle is disabled). Bytes that trickle in do not reset that deadline. The read also stops after 64 KiB. If the body has not finished by the deadline, the error is the HTTP status plus `response body timed out`. A 429 or other retryable status waits for a `Retry-After` header when one is present, instead of the jittered backoff, and that wait is still capped at 10 seconds. A user abort before the response headers, including one during that wait, ends the stream with reason `abort`, the same as an abort after text has started. After the provider's terminal event, a socket error while reading a usage trailer is treated as the body ending: the completion already in hand is kept, including any tool calls that terminal authorized.

### LLM stream end check

`stream_end_check` lives in `[llm]`. A value other than `auto`, `strict`, or `lenient` warns and falls back to `auto`.

| Key | Default | Behaviour |
|---|---|---|
| `stream_end_check` | `auto` | What to do when a stream closes cleanly without the provider's final signal (Anthropic `message_stop` / `stop_reason`, OpenAI-compatible `finish_reason` or `[DONE]`, Responses `response.completed` / `response.incomplete` / `response.done` / `[DONE]`, Google `finishReason`, Bedrock `messageStop`). `strict` returns an error whose event has `kind: "premature_end"` (the turn retries from that marker, not from the message text). `lenient` keeps text received so far. A tool call whose arguments parsed as sent may still run. A call that was still open, whose argument text is empty or does not start with `{`, or whose arguments had to be repaired, is not run; the stream ends with a non-retryable error (`The response was cut off while the model was calling a tool`) and the text already streamed is kept. A lenient accept writes a debug log: `<provider>: stream ended without a final event; accepted (lenient)`. `auto` uses the same hosted rule as the connect budget: strict when the base URL is unset or, ignoring surrounding whitespace, is the built-in host, lenient when `base_url` points at another host. A user-declared id is lenient under `auto` even if that id is also in the hosted list. Explicit `strict` or `lenient` always wins. Codex (`openai-codex`) still reports a missing terminal event as an error when `auto` would otherwise be lenient for that id. A partial SSE line left in the buffer when the socket closes is not dispatched, and that discard is logged once at warn level with its byte count only. |

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
A tool call that has already finished is still published. A function-call
argument delta with no announced call is a non-retryable error for Codex.
Other Responses providers buffer those deltas by `item_id` and complete the
call when `response.output_item.done` arrives with the name, call id, and
arguments. If that `done` never arrives, the stream ends with the same
non-retryable error and no assistant `done`. Those providers share the
connect and idle guard. A clean close with no terminal event stays a normal
finish unless `stream_end_check` resolves to strict; a strict close is
`kind: "premature_end"`. An `error` frame, `response.failed`, and a
`response.done` or `response.completed` whose status is `failed` or
`cancelled` are errors for every provider and every strictness. Strictness
does not turn a failed response into a normal finish.

When an attempt streams only reasoning and then ends empty, the turn retries that step and can fall back to another model. The reasoning may appear twice, or from two models. Answer text already shown prevents that retry.

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
| `/model [provider] <id>` | Switch model (bare `/model` opens a selector searchable by provider or model) |
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

### Choosing a model

`/model` with no argument opens a searchable picker; `/model [provider] <id>` switches straight to a model you already know. The picker pins the current model at the top, groups the rest by provider, and lists newest first within a provider when that provider reports creation times. Known non-chat models (embeddings, speech, image, video, moderation, legacy completions) are left out of live lists; built-in fallback lists keep their written order.

**Search** splits the query on spaces and `/`. A word that appears in a provider name narrows the list to that provider's models, and every other word fuzzy-matches model ids:

```text
anthropic          # everything Anthropic offers
openai gpt         # OpenAI models matching "gpt"
openrouter/claude  # OpenRouter models matching "claude"
```

Live model lists are cached for six hours. When a provider's live list cannot be fetched, the picker shows that provider's built-in list and adds a `live catalog unavailable` note naming the provider.

`/reasoning <level>` sets reasoning effort for the session (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). Claude 5 models use adaptive thinking, and the effort level maps onto it. On first-party OpenAI, gpt-6.1 models use reasoning effort `none` when tools are present due to a chat completions limitation.

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

**Tools:** structured `search_code` and `find_files` (native addon) plus git tools (`git_status`, `git_diff`, `git_commit`), shell, file read/write/edit, `web_fetch`, and memory tools. Prefer the git tools over `shell git …` for agent decisions; `git_commit` is blocked in plan mode. `web_fetch` is read-only and stays available in plan mode.

**Session safety:** plan mode gates mutating tools behind your approval; destructive or outward actions (`rm`, force-push, package installs, writes outside the project) ask for confirmation, and headless runs refuse them unless allowed in `[risk].allow`. In the TUI that question opens the same small overlay as the step pause and answers **y** = yes, **n** / **Enter** / **Esc** = no, **Ctrl+C** = abort the turn; on the plain terminal it stays a readline `[y/N]` line. `web_fetch` asks the first time each host is fetched in a session (the same keys answer it), then remembers that host, and a headless run refuses the host unless it matches `[tools.web].allow_domains` or `[risk].allow` includes `web_fetch_host`; a redirect is checked again on every hop, and a redirect to a different host stops for that same confirmation instead of following an open redirect; private and local addresses are always refused; known secret patterns, including URL query values named `token`, `key`, `secret`, `password`, `sig`, `auth`, `api_key`, `apikey`, `client_secret`, `access_token`, or an AWS `X-Amz-` signed parameter (and any name ending in `_token`, `_secret`, `_password`, `_signature`), are redacted from tool results and the event log, including when a control character splits the name; a loop breaker blocks a third identical mutating tool call, or a third attempt after two errors on the same file or command (reads, including `web_fetch`, are not gated); a repeat-read interceptor warns or blocks re-reading unchanged files; `praana resume` with no id continues your most recent session for the current project.

### web_fetch

`web_fetch(url, max_chars?, focus?)` GETs a public http(s) URL and returns readable text. HTML becomes markdown (scripts, styles, nav, footers, and cookie banners are dropped). Plain text and markdown are kept. JSON is rendered compact and bounded at `max_chars`, so a deeply nested response cannot expand into a much larger document. PDF and other binary types are refused. The page text is untrusted data: the tool result starts with a banner naming the host, and instructions inside the page must not be followed. Control characters other than newline and tab, and terminal escape sequences, are stripped from the text, focus excerpts, and error text before the result is returned. `focus` is capped (1000 characters, 20 distinct terms) so a large or repetitive focus cannot stall the page. A bot-wall marker blocks the page only when a challenge status, the `cf-mitigated` header, or a prominent title/heading corroborates it, so an article that merely embeds a captcha widget or mentions a vendor is still returned as content.

`[tools.web]` keys (defaults in parentheses): `enabled` (true), `allow_domains` ([]), `deny_domains` ([]), `timeout_ms` (15000, at most 2147483647), `max_chars` (20000, hard cap 100000). A domain rule matches the exact hostname or a subdomain (`example.com` matches `a.example.com` and does not match `notexample.com`). A leading `*.` is accepted and means the same suffix. Rules are stored and compared as punycode, the same conversion the URL parser applies, so a Unicode name such as `münchen.de` matches `xn--mnchen-3ya.de`. An entry that cannot be normalised disables `web_fetch` and is named in a warning, so a typo cannot silently drop a deny rule and weaken the policy. Deny wins. An empty `allow_domains` is not an allowlist. A non-empty list rejects every other host. Redirects are checked again on every hop. A redirect that stays on the same host is followed. A redirect to a different host is followed only when that host passes the domain rules and is already confirmed in this session, or is covered by `allow_domains` or a headless `web_fetch_host` entry in `[risk].allow`. Otherwise the fetch stops before contacting the new host and returns that URL so a later `web_fetch` can confirm it. A batch of fetches to the same new host asks once. The result banner and final URL name the host that was actually contacted. The download itself stops at 2 MiB, and the DNS lookup shares the `timeout_ms` deadline and is cancelled with the turn; each redirect hop gets a fresh window for its own lookup and download, and the turn abort still cancels in-flight work. Bot-wall and empty script shells come back as blocked, not as page text. Private, loopback, link-local, and the IANA special-purpose ranges that are not globally reachable (including 198.18.0.0/15, the TEST-NET ranges, and the IPv6 documentation and benchmarking ranges) are always refused, both as a literal address and as a DNS answer.

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
