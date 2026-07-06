# Design: `/shell` slash command and `!` prefix for direct execution

**Issue:** [#118](https://github.com/amitkumardubey/praana/issues/118)  
**Date:** 2026-07-06  
**Status:** Approved

## Summary

Add a user-facing `/shell <command>` slash command and a `!<command>` prefix that run a shell command directly, bypassing the LLM, and show the output inline in the TUI transcript. Execution must reuse the existing `shell` tool sandbox so direct user commands are subject to the same safety rules as agent-initiated commands.

## Motivation

Users currently have to ask the LLM to run shell commands such as `git status` or `npm test`. This consumes a turn and adds latency for operations the user could safely run themselves. A direct `/shell` command lets users execute quick commands without the LLM.

## Requirements

1. `/shell <command>` runs `<command>` in the session's working directory.
2. `!<command>` is a shorthand for `/shell <command>`.
3. Output is appended to the transcript inline as system lines (not a pop-up overlay).
4. The existing `shell` tool sandbox (`enabled`, dangerous-pattern block, `allowed_paths`) is applied.
5. Errors (missing command, sandbox block, non-zero exit) are shown inline; non-zero exits also use the error toast tone.
6. `/help` lists the new command.

## Architecture

```
TUI input
  ├─ starts with "!"      → rewrite to "/shell <rest>"
  └─ starts with "/shell" → controller.executeSlashCommand
       └─ slash-commands.ts `/shell` case
            └─ shell helper (reuses src/tools/system.ts sandbox + spawn logic)
                 └─ returns { ok, stdout, stderr, exitCode }
       └─ run.ts appends result lines to transcript via sink
```

## Components

### 1. Shell helper

A small function (extracted/refactored from `createSystemTools` in `src/tools/system.ts`) that:

- Accepts `command`, `cwd`, optional `timeout`, and the session's `SandboxConfig`.
- Runs the same dangerous-pattern checks and `allowed_paths` validation used by the agent's `shell` tool.
- Spawns `/bin/bash -c <command>` with buffered output.
- Returns `{ ok, stdout, stderr, exitCode }`.

### 2. Slash-command handler

`src/slash-commands.ts` gains a `/shell` case:

- Parse everything after the first whitespace as the command.
- If no command, return a toast error.
- Call the shell helper using `session.cwd` and `session.config.shell`.
- Format output:
  - First line: `$ <command>`
  - Then stdout/stderr lines
  - On non-zero exit, append `exit code: N`
- Return `display: "transcript"` and `toastTone: "error"` when the exit code is non-zero.

### 3. TUI input routing

`src/ui/tui/run.ts`:

- Before the existing `if (input.startsWith("/"))` check, detect `input.startsWith("!")`.
- If the rest is empty, show a toast error.
- Otherwise rewrite the input to `/shell <rest>` and fall through to the slash-command handler.
- For `/shell` results with `display === "transcript"`:
  - Call `sink.nextGroup()` so the command gets its own transcript group.
  - Append the user's raw input as a user entry (`sink.appendUser(input)`).
  - Append output lines via `sink.onSystemLines(result.lines)`.
  - Do not append a turn footer.

### 4. Help text

`src/app-banner.ts` adds:

```
  /shell <command>         Run a shell command directly
  !<command>               Shortcut for /shell
```

### 5. Event log

Optionally append a `system_note` event of type `shell_command` containing the command and exit code. This keeps the event log auditable without adding fake tool-call/tool-result entries. This is not required for transcript persistence because system-line transcript entries are already persisted as `ui_transcript` events.

## Error handling

| Scenario | Behavior |
|---|---|
| `/shell` with no command | Toast error: "Usage: /shell <command>" |
| `!` with no command | Toast error: "Usage: !<command>" |
| Sandbox blocks command | Inline error line: "Blocked by sandbox: ..." |
| Non-zero exit code | Output shown inline; toast tone error |
| Spawn failure | Inline error with `err.message` |

## Security

- Direct `/shell` commands use exactly the same sandbox as the agent's `shell` tool.
- No special privileges are granted to user-issued commands.
- If the sandbox is disabled, commands still run with the user's normal OS permissions.

## Testing

- `tests/slash-commands.test.ts`
  - `/shell` with no args returns usage error.
  - `/shell echo hello` returns success and output.
  - `/shell` outside `allowed_paths` returns a sandbox block when sandbox is enabled.
- `tests/tui-run.test.ts`
  - `!git status` is rewritten to `/shell git status` and handled as a slash command.

## Future work

- Add an optional timeout argument: `/shell --timeout 5000 <command>`.
- Render `/shell` output as a collapsible tool block instead of plain system lines.
- Add up-arrow history for `!` commands in the TUI input.
