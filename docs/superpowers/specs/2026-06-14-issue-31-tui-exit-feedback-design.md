# Issue #31 — TUI `/exit` immediate feedback and non-blocking shutdown

## Problem

`/exit` and `/quit` feel slow. The terminal goes blank for up to 5 s while the session-end summarizer LLM call runs, with no progress indicator.

### Current flow

TUI (`src/ui/tui/run.ts`):

1. `await waitUntilExit()` — user types `/exit`
2. `unmount()` — TUI disappears
3. `await controller.shutdown()` — blocks up to **5 seconds** waiting for summarizer
4. Epilogue prints to stdout

`shutdown()` in `src/app-controller.ts` calls `session.end(..., { memoryTimeoutMs: 5_000 })`. After `unmount()` the user sees a blank/frozen terminal with no feedback.

Readline at least prints `"Shutting down..."` (`src/ui/readline-ui.ts:198`) before `shutdown()`, but the underlying 5 s block remains.

## Goals

- Visible feedback within 200 ms of `/exit`
- TUI exits cleanly; session epilogue still prints
- No false error logs on clean exit (regression guard: `tests/memory-learning.test.ts`)
- If summarization continues in background, user is told explicitly

## Design

### 1. `Session.end()` returns a structured status

**File:** `src/session.ts`

```ts
export type SessionEndStatus = {
  memory: "completed" | "background" | "skipped" | "failed";
};

async end(
  reason: "clean" | "aborted" | "error",
  events?: SessionEvent[],
  opts?: { memoryTimeoutMs?: number }
): Promise<SessionEndStatus>
```

Behavioral logic is unchanged — same `waitForCompletion` race between `memoryStore.sessionEnd(...)` and the timeout. We just expose which path fired:

- `completed` — summarizer finished within `memoryTimeoutMs`
- `background` — timeout fired, summarizer continues in background (still attached to a `.catch()` so it can't produce an unhandled rejection)
- `skipped` — `memoryEnabled === false` or `memoryStore === null`
- `failed` — synchronously caught error from the summarizer

### 2. `AppController.shutdown()` returns the same status, default timeout = 2 s

**File:** `src/app-controller.ts`

```ts
export type ShutdownStatus = {
  memory: SessionEndStatus["memory"] | "noop";
};

async shutdown(): Promise<ShutdownStatus>
```

- Default `memoryTimeoutMs`: `2_000` (was `5_000`). Most summarizer calls finish in <1 s; 2 s gives headroom without feeling frozen.
- Source: `this.config.session.shutdown_memory_timeout_ms ?? 2_000`.
- If `sessionEnded` is already true (defensive double-call), returns `{ memory: "noop" }`.

### 3. New config key

**File:** `src/types.ts` — extend `SessionConfig`:

```ts
export interface SessionConfig {
  log_dir: string;
  /** Max ms to wait for session-end summarizer before backgrounding. Default: 2000. */
  shutdown_memory_timeout_ms?: number;
}
```

### 4. TUI shows feedback after `waitUntilExit()`

**File:** `src/ui/tui/run.ts`

```ts
await waitUntilExit();
unmount();
process.stderr.write("Saving session…\n");
const { memory } = await controller.shutdown();
if (memory === "background") {
  process.stderr.write("Memory save continuing in background…\n");
}
for (const line of formatSessionEpilogue(controller.session.id)) {
  console.log(line);
}
console.log(formatSessionEndSummary(controller.session));
```

stderr is used (not stdout) so the message doesn't pollute piped/captured output. `unmount()` runs first so Ink isn't intercepting the write. The "Saving session…" line appears within milliseconds of `/exit` and stays visible while the 2 s shutdown runs. The background message only appears when summarization actually times out.

### 5. Readline mirrors the same pattern

**File:** `src/ui/readline-ui.ts` — keep the existing `"Shutting down..."` line, add the `background` branch after `shutdown()` returns.

## Tests (TDD)

### Failing tests first, then implementation

1. **`tests/session-end.test.ts`** — update existing tests to use new return value; add:
   - returns `{ memory: "background" }` when summarizer exceeds `memoryTimeoutMs`
   - returns `{ memory: "completed" }` when summarizer finishes in time
   - returns `{ memory: "skipped" }` when `memoryEnabled === false`
   - returns `{ memory: "failed" }` when summarizer throws synchronously
2. **`tests/app-controller.test.ts`** — add:
   - `shutdown()` returns `{ memory: "background" }` and exits within `timeout + epsilon` when summarizer hangs
   - `shutdown()` reads `config.session.shutdown_memory_timeout_ms` when provided
   - `shutdown()` returns `{ memory: "noop" }` on the second call
3. **`tests/tui-run.test.ts`** (new) — fake Ink render, capture stderr/stdout writes, assert:
   - `"Saving session…"` is written within 200 ms of `waitUntilExit` resolving
   - `"Memory save continuing in background…"` is written when `shutdown()` reports `background`
   - Epilogue lines still print after
4. **`tests/memory-learning.test.ts`** — must continue to pass (no behavioural regression in the session-end path).

## Out of scope

- Switching to a faster summarizer model (separate concern)
- Real in-TUI spinner (the 2 s ceiling is short enough that a static line is sufficient)
- Restructuring the LLM call to stream progress (not feasible for the current summarizer)

## Acceptance criteria (from the issue)

- [x] Visible feedback within 200 ms of `/exit` — `Saving session…` on stderr, written right after `unmount()` and before `shutdown()`
- [x] TUI exits cleanly; session epilogue still prints — flow preserved
- [x] No false error logs on clean exit — existing `memory-learning.test.ts` continues to pass
