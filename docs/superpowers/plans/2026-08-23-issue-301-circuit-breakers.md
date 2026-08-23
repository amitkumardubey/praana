# Issue #301: Circuit Breakers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block the 3rd identical mutating tool/error with a compile-visible constraint, and wrap up headless runs when token or wall-clock caps are hit.

**Architecture:** Pure `LoopGate` + `isLoopExempt` in `src/circuit/`. Builtin pre/post hooks after risk and before write-path. Both compilers render `circuitNotes`. Headless `checkCircuitBudget` in `runTurn` triggers one no-tool wrap-up stream. Scorecard counters only.

**Tech Stack:** TypeScript (strict, NodeNext), Bun test.

**Spec:** [`docs/superpowers/specs/2026-08-23-circuit-breakers-design.md`](../specs/2026-08-23-circuit-breakers-design.md)

**Branch:** `feat/ad/issue-301-circuit-breakers`

**Out of scope:** cheaper-model fallback, disable hatch, gating reads/tests, changing `--max-steps`.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/circuit/loop-gate.ts` | `isLoopExempt`, `LoopGate`, `CIRCUIT_LOOP_PREFIX`, `renderCircuitNotes` |
| **Create** `src/circuit/budget.ts` | `checkCircuitBudget` |
| **Create** `src/hooks/handlers/circuit.ts` | pre increment/block + post error count |
| **Create** `tests/circuit-loop.test.ts` | Exempt + allow-2-block-3rd + constraint once + rebuild |
| **Create** `tests/circuit-hook.test.ts` | Registry order vs risk / write-path |
| **Modify** `src/domain/coding-domain.ts` | `bun test` in `isTestCommand` |
| **Modify** `src/hooks/types.ts` | Optional `observeCircuitPre` / `observeCircuitPost` / `circuitNotes` |
| **Modify** `src/hooks/index.ts` | Register circuit after risk, before write-path |
| **Modify** `src/session.ts` | Own `LoopGate`; rebuild on resume; `getStartedAt()` |
| **Modify** `src/types.ts` + `src/config.ts` | `[circuit]` defaults |
| **Modify** `src/compile-classic.ts` + engine compile | Render circuit notes |
| **Modify** `src/turn.ts` | Pass notes into compile; headless wrap-up |
| **Modify** `src/context-engine/telemetry.ts` + `db.ts` | `circuitLoopBlocks`, `circuitBudgetWrapups` |
| **Modify** `tests/turn.test.ts`, `tests/headless-run.test.ts`, `tests/coding-domain.test.ts` | Acceptance cases |
| **Modify** `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/concepts.md` | Document |

---

## Design Notes (locked)

### Exempt

```ts
const READ_TOOLS = new Set([
  "read_file", "read_and_summarize", "search_code", "retrieve_artifact",
  "recall", "search_session_log", "search_turn_events",
  "git_status", "git_diff", "git_log", "git_branches",
  "lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references",
  "lsp_completions", "lsp_code_actions",
  "code_parse", "code_imports", "code_symbols", "code_definition", "code_references",
]);
```

`shell` is exempt only when `detectShellReads(command)` is non-null **or**
`isTestCommand(command)`. Extend `isTestCommand` with `bun test`.

### Counters

Reuse `toolErrorBaseKey` from `src/context-engine/error-tracker.ts` as the
map key for **both** `argHits` and `errorHits`.

- `observePre`: if exempt, return. Else `argHits[key]++`. Block if
  `argHits[key] >= threshold` **or** `errorHits[key] >= threshold - 1`.
- `observePost`: if exempt or `!isError`, return. Else `errorHits[key]++`.

Threshold default `3`. First block for a key: push note, call `onFirstBlock`.

### Hook order (pre)

plan → validate → risk → **circuit** → write-path acquire

### Config

```toml
[circuit]
loop_threshold = 3
max_tokens = 0
max_wall_ms = 0
```

`0` token/time = off. Token/time enforced only when `session.headless`.

---

### Task 1: `isTestCommand` + `LoopGate`

**Files:**
- Modify: `src/domain/coding-domain.ts`
- Modify: `tests/coding-domain.test.ts`
- Create: `tests/circuit-loop.test.ts`
- Create: `src/circuit/loop-gate.ts`

- [ ] **Step 1: Extend the `isTestCommand` test**

In `tests/coding-domain.test.ts`, add `"bun test"` and `"bun test tests/foo.test.ts"` to the recognises list.

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/coding-domain.test.ts --test-name-pattern "isTestCommand"`

Expected: FAIL — `bun test` is false

- [ ] **Step 3: Add `bun test` to the regex**

In `src/domain/coding-domain.ts`:

```ts
export function isTestCommand(command: string): boolean {
  return /\b(npm test|pnpm test|yarn test|bun test|vitest|pytest|cargo test|go test)\b/i.test(
    command,
  );
}
```

- [ ] **Step 4: Write failing `LoopGate` tests**

```ts
import { describe, expect, it } from "bun:test";
import { isLoopExempt, LoopGate, CIRCUIT_LOOP_PREFIX } from "../src/circuit/loop-gate.js";

describe("isLoopExempt", () => {
  it("exempts reads and tests", () => {
    expect(isLoopExempt("read_file", { path: "a.ts" })).toBe(true);
    expect(isLoopExempt("git_status", {})).toBe(true);
    expect(isLoopExempt("shell", { command: "git status" })).toBe(true);
    expect(isLoopExempt("shell", { command: "bun test" })).toBe(true);
    expect(isLoopExempt("shell", { command: "npm test" })).toBe(true);
  });

  it("does not exempt mutating shell", () => {
    expect(isLoopExempt("edit_file", { path: "a.ts", oldText: "x", newText: "y" })).toBe(false);
    expect(isLoopExempt("shell", { command: "rm -rf /tmp/x" })).toBe(false);
  });
});

describe("LoopGate", () => {
  it("blocks the third identical mutating args and notes once", () => {
    const texts: string[] = [];
    const gate = new LoopGate({
      threshold: 3,
      onFirstBlock: (t) => texts.push(t),
    });
    const args = { command: "rm -rf /tmp/x" };
    expect(gate.observePre("shell", args)).toBeUndefined();
    expect(gate.observePre("shell", args)).toBeUndefined();
    const third = gate.observePre("shell", args);
    expect(third?.action).toBe("block");
    expect(third?.error).toContain(CIRCUIT_LOOP_PREFIX);
    expect(texts).toHaveLength(1);
    expect(gate.notes()).toHaveLength(1);
    expect(gate.observePre("shell", args)?.action).toBe("block");
    expect(texts).toHaveLength(1);
  });

  it("blocks the third attempt after two errors on the same path", () => {
    const gate = new LoopGate({ threshold: 3 });
    gate.observePre("edit_file", { path: "a.ts", oldText: "a", newText: "b" });
    gate.observePost("edit_file", { path: "a.ts", oldText: "a", newText: "b" }, true);
    gate.observePre("edit_file", { path: "a.ts", oldText: "c", newText: "d" });
    gate.observePost("edit_file", { path: "a.ts", oldText: "c", newText: "d" }, true);
    const third = gate.observePre("edit_file", { path: "a.ts", oldText: "e", newText: "f" });
    expect(third?.action).toBe("block");
  });

  it("does not count exempt calls", () => {
    const gate = new LoopGate({ threshold: 3 });
    for (let i = 0; i < 5; i++) {
      expect(gate.observePre("read_file", { path: "a.ts" })).toBeUndefined();
      expect(gate.observePre("shell", { command: "bun test" })).toBeUndefined();
    }
  });
});
```

- [ ] **Step 5: Run to verify fail**

Run: `bun test tests/circuit-loop.test.ts`

Expected: FAIL — module missing

- [ ] **Step 6: Implement `src/circuit/loop-gate.ts`**

```ts
import { toolErrorBaseKey } from "../context-engine/error-tracker.js";
import { isTestCommand } from "../domain/coding-domain.js";
import { detectShellReads } from "../tools/shell-read-detect.js";

export const CIRCUIT_LOOP_PREFIX = "Circuit breaker:";
export const DEFAULT_LOOP_THRESHOLD = 3;

const READ_TOOLS = new Set<string>([
  "read_file",
  "read_and_summarize",
  "search_code",
  "retrieve_artifact",
  "recall",
  "search_session_log",
  "search_turn_events",
  "git_status",
  "git_diff",
  "git_log",
  "git_branches",
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
  "lsp_completions",
  "lsp_code_actions",
  "code_parse",
  "code_imports",
  "code_symbols",
  "code_definition",
  "code_references",
]);

export function isLoopExempt(toolName: string, args: Record<string, unknown>): boolean {
  if (READ_TOOLS.has(toolName)) return true;
  if (toolName === "shell" && typeof args.command === "string") {
    return detectShellReads(args.command) !== null || isTestCommand(args.command);
  }
  return false;
}

export function circuitLoopError(toolName: string): string {
  return `${CIRCUIT_LOOP_PREFIX} ${toolName} with the same arguments repeated or failed 3 times; required: different approach or ask the user.`;
}

export function renderCircuitNotes(notes: string[]): string {
  if (notes.length === 0) return "";
  return ["## Circuit Breakers", "", ...notes.map((n) => `- ${n}`)].join("\n");
}

export type LoopPreResult =
  | { action: "block"; error: string; isError: true }
  | undefined;

export class LoopGate {
  private readonly argHits = new Map<string, number>();
  private readonly errorHits = new Map<string, number>();
  private readonly noted = new Set<string>();
  private readonly noteList: string[] = [];
  private readonly threshold: number;
  private readonly onFirstBlock?: (text: string) => void;

  constructor(opts?: { threshold?: number; onFirstBlock?: (text: string) => void }) {
    this.threshold = opts?.threshold ?? DEFAULT_LOOP_THRESHOLD;
    this.onFirstBlock = opts?.onFirstBlock;
  }

  notes(): string[] {
    return [...this.noteList];
  }

  observePre(toolName: string, args: Record<string, unknown>): LoopPreResult {
    if (isLoopExempt(toolName, args)) return;
    const key = toolErrorBaseKey(toolName, args);
    const next = (this.argHits.get(key) ?? 0) + 1;
    this.argHits.set(key, next);
    const errors = this.errorHits.get(key) ?? 0;
    if (next >= this.threshold || errors >= this.threshold - 1) {
      this.rememberBlock(key, toolName);
      return { action: "block", error: circuitLoopError(toolName), isError: true };
    }
    return;
  }

  observePost(toolName: string, args: Record<string, unknown>, isError: boolean): void {
    if (!isError || isLoopExempt(toolName, args)) return;
    const key = toolErrorBaseKey(toolName, args);
    this.errorHits.set(key, (this.errorHits.get(key) ?? 0) + 1);
  }

  private rememberBlock(key: string, toolName: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    const text = circuitLoopError(toolName);
    this.noteList.push(text);
    this.onFirstBlock?.(text);
  }
}
```

- [ ] **Step 7: Run tests**

Run: `bun test tests/coding-domain.test.ts tests/circuit-loop.test.ts`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/domain/coding-domain.ts tests/coding-domain.test.ts src/circuit/loop-gate.ts tests/circuit-loop.test.ts
git commit -m "$(cat <<'EOF'
feat(circuit): add LoopGate and exempt reads/tests

EOF
)"
```

---

### Task 2: Hook + Session wiring

**Files:**
- Create: `src/hooks/handlers/circuit.ts`
- Create: `tests/circuit-hook.test.ts`
- Modify: `src/hooks/types.ts`
- Modify: `src/hooks/index.ts`
- Modify: `src/session.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Write the failing hook test**

Follow `tests/redact-hook.test.ts` / `tests/validate-hook.test.ts` patterns. Assert:

1. After `createBuiltinHookRegistry`, a mutating `shell` `rm` call is **not** blocked on the first `runPreToolCall`.
2. Third identical `runPreToolCall` for that command returns `action: "block"` and `error` contains `Circuit breaker:`.
3. A missing `read_file` still hits validate **before** circuit (block error is the missing-path message, not circuit) — register with `pathExists: () => false`.
4. Circuit pre runs **before** write-path: third mutating `write_file` block must not leave a lock (follow validate-hook “does not hold a lock” style: after block, a `read_file` of that path is allowed).

Session mock must implement `observeCircuitPre` / `observeCircuitPost` **or** the test constructs a `LoopGate` and assigns those methods.

```ts
const gate = new LoopGate({ threshold: 3 });
const session = {
  cwd,
  isPlanMode: () => false,
  observeCircuitPre: (tool: string, args: Record<string, unknown>) => gate.observePre(tool, args),
  observeCircuitPost: (tool: string, args: Record<string, unknown>, isError: boolean) =>
    gate.observePost(tool, args, isError),
  circuitNotes: () => gate.notes(),
};
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/circuit-hook.test.ts`

Expected: FAIL — handler / methods missing

- [ ] **Step 3: Extend `HookSessionLike`**

In `src/hooks/types.ts` add:

```ts
  observeCircuitPre?(
    toolName: string,
    args: Record<string, unknown>,
  ): { action: "block"; error: string; isError: true } | void;
  observeCircuitPost?(toolName: string, args: Record<string, unknown>, isError: boolean): void;
  circuitNotes?(): string[];
```

- [ ] **Step 4: Implement the handler**

`src/hooks/handlers/circuit.ts`:

```ts
import type { PostToolCallHandler, PreToolCallHandler } from "../types.js";

export function createCircuitHandlers(): {
  pre: PreToolCallHandler;
  post: PostToolCallHandler;
} {
  return {
    pre: (ctx) => ctx.session.observeCircuitPre?.(ctx.toolName, ctx.args),
    post: (ctx) => {
      ctx.session.observeCircuitPost?.(ctx.toolName, ctx.args, ctx.isError);
    },
  };
}
```

- [ ] **Step 5: Register after risk, before write-path**

In `src/hooks/index.ts`:

```ts
  registry.onPreToolCall(createRiskPreToolCallHandler(cwd));
  const circuit = createCircuitHandlers();
  registry.onPreToolCall(circuit.pre);
  registry.onPreToolCall(createWritePathPreToolCallHandler(...));
  // ...
  registry.onPostToolCall(validate.post);
  registry.onPostToolCall(createRedactPostToolCallHandler());
  registry.onPostToolCall(circuit.post);
  registry.onPostToolCall(createWritePathPostToolCallHandler(writePath));
```

Update the comment to:
`pre = plan → validate → risk → circuit → write-path`
`post = … → enrich → redact → circuit → write-path release`

- [ ] **Step 6: Config + Session**

`src/types.ts`:

```ts
export interface CircuitConfig {
  loop_threshold: number;
  max_tokens: number;
  max_wall_ms: number;
}

// on PraanaConfig:
circuit?: CircuitConfig;
```

`src/config.ts` `DEFAULT_CONFIG`:

```ts
  circuit: {
    loop_threshold: 3,
    max_tokens: 0,
    max_wall_ms: 0,
  },
```

`src/session.ts`: import `LoopGate`. Add field `loopGate: LoopGate`. In the constructor (or `create` / `resume` after `stateGraph` exists):

```ts
this.loopGate = new LoopGate({
  threshold: this.config.circuit?.loop_threshold ?? 3,
  onFirstBlock: (text) => {
    this.stateGraph.create("constraint", { text });
    this.eventLog.append({
      kind: "system_note",
      actor: "kernel",
      payload: { type: "circuit_note", text },
    });
  },
});
```

Add methods used by hooks (so Session satisfies `HookSessionLike`):

```ts
observeCircuitPre(toolName: string, args: Record<string, unknown>) {
  return this.loopGate.observePre(toolName, args);
}
observeCircuitPost(toolName: string, args: Record<string, unknown>, isError: boolean) {
  this.loopGate.observePost(toolName, args, isError);
}
circuitNotes() {
  return this.loopGate.notes();
}
getStartedAt() {
  return this.startedAt;
}
```

On **resume**, after events are loaded, replay into a fresh gate **before** further turns. Add `LoopGate.replayToolEvents(events: Event[])` in Task 4 if you prefer to stub `// replay in Task 4` here — **do Task 4 in the same change if cheaper**, otherwise leave maps empty on resume until Task 4 (TTY new sessions still work). Prefer implementing replay in Task 4.

- [ ] **Step 7: Run hook tests**

Run: `bun test tests/circuit-hook.test.ts tests/hooks.test.ts tests/circuit-loop.test.ts`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/hooks/handlers/circuit.ts src/hooks/types.ts src/hooks/index.ts src/session.ts src/types.ts src/config.ts tests/circuit-hook.test.ts
git commit -m "$(cat <<'EOF'
feat(hooks): gate mutating tool loops after risk confirm

EOF
)"
```

---

### Task 3: Compile notes + turn acceptance

**Files:**
- Modify: `src/compile-classic.ts`
- Modify: `src/context-engine/engine-compiler.ts` (and the `compileEngineWithMetrics` call site in `src/turn.ts`)
- Modify: `src/turn.ts`
- Modify: `tests/turn.test.ts`
- Modify: `tests/circuit-loop.test.ts` (optional `renderCircuitNotes` case)

- [ ] **Step 1: Add `renderCircuitNotes` unit assertion** (in `tests/circuit-loop.test.ts`)

```ts
it("renders a circuit section", () => {
  expect(renderCircuitNotes(["Circuit breaker: shell …"])).toContain("## Circuit Breakers");
});
```

- [ ] **Step 2: Write the failing turn test**

Append to `tests/turn.test.ts` (same `piStream` + `createAllTools` mock pattern as `redacts tool_call args`):

```ts
it("blocks the third identical mutating shell call and injects a circuit note", async () => {
  const cmd = "rm -rf /tmp/praana-circuit-test";
  let executeCount = 0;
  (createAllTools as ReturnType<typeof mock>).mockReturnValue({
    shell: {
      description: "Execute a shell command",
      parameters: z.object({ command: z.string() }),
      execute: mock(async () => {
        executeCount++;
        return { ok: true, stdout: "ok" };
      }),
    },
  });

  // Stream three tool-use steps with the same command, then a final stop.
  // Follow the existing multi-step mockImplementation(calls === 1 / 2 / 3 / 4) pattern
  // from "accumulates provider output tokens across multi-step tool loops".

  const session = makeMockSession();
  await runTurn(session, "delete that dir");

  expect(executeCount).toBe(2);
  const results = session.eventLog.readLast(80).filter((e: Event) => e.kind === "tool_result");
  const last = results[results.length - 1] as any;
  expect(last.payload.result.ok).toBe(false);
  expect(String(last.payload.result.error)).toContain("Circuit breaker:");
  expect(session.circuitNotes()).toHaveLength(1);
});
```

`makeMockSession` must construct a real `LoopGate` (or call `Session` methods). If `makeMockSession` is a plain object, attach the same `observeCircuitPre` / `LoopGate` wiring as Task 2.

Also assert `read_file` / `bun test` are **not** blocked on the 5th call (second test, or same file).

- [ ] **Step 3: Run to verify fail**

Run: `bun test tests/turn.test.ts --test-name-pattern "blocks the third identical"`

Expected: FAIL — third call still executes

- [ ] **Step 4: Pass notes into both compilers**

`ClassicCompileInput` add `circuitNotes?: string[]`. After the system frame (or after skills), if notes exist, `sections.push(renderCircuitNotes(input.circuitNotes))`.

Engine: add `circuitNotes?: string[]` to the compile input; inject `renderCircuitNotes` immediately after agent hints (stable, short).

In `src/turn.ts` compile call sites, pass `circuitNotes: session.circuitNotes?.() ?? []`.

When `observeCircuitPre` returns a block, `session.scorecard` increment is Task 5 — skip here.

- [ ] **Step 5: Run tests**

Run: `bun test tests/turn.test.ts tests/circuit-loop.test.ts tests/circuit-hook.test.ts tests/compile-classic.test.ts`

Expected: PASS (add a compile-classic assertion if that file already tests resume notes)

- [ ] **Step 6: Commit**

```bash
git add src/compile-classic.ts src/context-engine/engine-compiler.ts src/turn.ts tests/turn.test.ts tests/circuit-loop.test.ts
git commit -m "$(cat <<'EOF'
feat(circuit): surface loop-breaker notes in compiled prompts

EOF
)"
```

---

### Task 4: Resume replay

**Files:**
- Modify: `src/circuit/loop-gate.ts`
- Modify: `src/session.ts`
- Modify: `tests/circuit-loop.test.ts`

- [ ] **Step 1: Write failing replay test**

```ts
it("replays tool_call / tool_result events", () => {
  const events = [
    { kind: "tool_call", payload: { tool: "shell", args: { command: "rm -rf /tmp/x" } } },
    { kind: "tool_result", payload: { tool: "shell", result: { ok: true } } },
    { kind: "tool_call", payload: { tool: "shell", args: { command: "rm -rf /tmp/x" } } },
    { kind: "tool_result", payload: { tool: "shell", result: { ok: true } } },
    { kind: "system_note", payload: { type: "circuit_note", text: "Circuit breaker: shell …" } },
  ];
  const gate = LoopGate.fromEvents(events as any, { threshold: 3 });
  expect(gate.observePre("shell", { command: "rm -rf /tmp/x" })?.action).toBe("block");
  expect(gate.notes()[0]).toContain("Circuit breaker:");
});
```

Use the real `Event` shape if `fromEvents` only reads `kind` + `payload`.

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/circuit-loop.test.ts --test-name-pattern "replays"`

Expected: FAIL — `fromEvents` missing

- [ ] **Step 3: Implement `LoopGate.fromEvents`**

Walk events in order:

- `tool_call` → `observePre` (ignore the block return; counts still increment)
- `tool_result` → `observePost(tool, args, result.ok === false)` — keep last `tool_call` args in a local variable keyed by `toolCallId` when present
- `system_note` with `payload.type === "circuit_note"` → push `payload.text` onto `noteList` / `noted` if not already there (do **not** call `onFirstBlock` during replay — state graph already replayed the constraint)

Call `fromEvents` from `Session.resume` after the event log is open, replacing the empty gate (keep `onFirstBlock` for **future** blocks).

- [ ] **Step 4: Run tests**

Run: `bun test tests/circuit-loop.test.ts tests/resume.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/circuit/loop-gate.ts src/session.ts tests/circuit-loop.test.ts
git commit -m "$(cat <<'EOF'
feat(circuit): rebuild LoopGate counts on session resume

EOF
)"
```

---

### Task 5: Headless budget wrap-up + scorecard

**Files:**
- Create: `src/circuit/budget.ts`
- Create: `tests/circuit-budget.test.ts`
- Modify: `src/turn.ts`
- Modify: `src/headless-run.ts` (only if a comment/docs string is needed — wrap-up lives in `runTurn`)
- Modify: `tests/headless-run.test.ts` and/or `tests/turn.test.ts`
- Modify: `src/context-engine/telemetry.ts`
- Modify: `src/context-engine/db.ts`

- [ ] **Step 1: Write failing budget unit tests**

```ts
import { describe, expect, it } from "bun:test";
import { checkCircuitBudget } from "../src/circuit/budget.js";

describe("checkCircuitBudget", () => {
  it("is off when caps are 0", () => {
    expect(checkCircuitBudget({ maxTokens: 0, maxWallMs: 0, tokens: 9e9, elapsedMs: 9e9 })).toBeNull();
  });
  it("returns tokens when over cap", () => {
    expect(checkCircuitBudget({ maxTokens: 100, maxWallMs: 0, tokens: 101, elapsedMs: 1 })).toBe("tokens");
  });
  it("returns time when over cap", () => {
    expect(checkCircuitBudget({ maxTokens: 0, maxWallMs: 50, tokens: 1, elapsedMs: 51 })).toBe("time");
  });
});
```

- [ ] **Step 2: Implement `src/circuit/budget.ts`**

```ts
export type CircuitBudgetReason = "tokens" | "time";

export function checkCircuitBudget(input: {
  maxTokens: number;
  maxWallMs: number;
  tokens: number;
  elapsedMs: number;
}): CircuitBudgetReason | null {
  if (input.maxTokens > 0 && input.tokens >= input.maxTokens) return "tokens";
  if (input.maxWallMs > 0 && input.elapsedMs >= input.maxWallMs) return "time";
  return null;
}

export function circuitWrapUpInstruction(reason: CircuitBudgetReason): string {
  return `Circuit budget exceeded (${reason}). Reply with a final summary. Do not call tools.`;
}
```

- [ ] **Step 3: Write a failing headless wrap-up turn test**

`makeMockSession({ headless: true })` with `config.circuit = { loop_threshold: 3, max_tokens: 1, max_wall_ms: 0 }`.

Mock the first `piStream` to return a tool call (`shell` `echo hi`) plus usage `{ input: 10, output: 10 }`. Second stream (wrap-up) returns text only.

Assert: `shell.execute` was **not** called; final text is the wrap-up reply; event log has no successful `echo hi` result.

If `makeMockSession` does not copy `headless` / `circuit`, add those fields.

- [ ] **Step 4: Run to verify fail**

Run: `bun test tests/circuit-budget.test.ts tests/turn.test.ts --test-name-pattern "wrap-up|checkCircuitBudget"`

Expected: FAIL — tools still execute

- [ ] **Step 5: Wire wrap-up in `runTurn`**

After a stream that requested tools, **before** Phase 1 execute:

```ts
if (session.headless) {
  const tokens = (providerUsage?.input ?? 0) + (providerUsage?.output ?? 0);
  const reason = checkCircuitBudget({
    maxTokens: session.config.circuit?.max_tokens ?? 0,
    maxWallMs: session.config.circuit?.max_wall_ms ?? 0,
    tokens,
    elapsedMs: Date.now() - session.getStartedAt(),
  });
  if (reason) {
    session.scorecard.trackCircuitBudgetWrapup?.();
    history.push({
      role: "user",
      content: circuitWrapUpInstruction(reason),
      timestamp: Date.now(),
    });
    // one more attemptStream(); ignore pendingToolCalls; keep text; break
  }
}
```

Only when `session.headless` is true. TTY ignores caps.

If the wrap-up stream still emits tools, do **not** execute them.

- [ ] **Step 6: Scorecard columns**

Add `circuitLoopBlocks` and `circuitBudgetWrapups` to `ScorecardCounters`, zero defaults, `inc` helpers `trackCircuitLoopBlock()` / `trackCircuitBudgetWrapup()`, INSERT list, `SCORECARD_RESUME_COLUMNS` in `src/context-engine/db.ts`, and one line in `formatScorecardLines`.

Call `trackCircuitLoopBlock()` from `Session.observeCircuitPre` when the result is a block.

- [ ] **Step 7: Run tests**

Run: `bun test tests/circuit-budget.test.ts tests/circuit-loop.test.ts tests/circuit-hook.test.ts tests/turn.test.ts tests/headless-run.test.ts tests/hooks.test.ts`

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/circuit/budget.ts src/turn.ts src/session.ts src/context-engine/telemetry.ts src/context-engine/db.ts tests/circuit-budget.test.ts tests/turn.test.ts
git commit -m "$(cat <<'EOF'
feat(circuit): wrap up headless runs on token or time budget

EOF
)"
```

---

### Task 6: Docs and #301 comment

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/concepts.md`

- [ ] **Step 1: Update docs**

`AGENTS.md` — after secret redaction / risk: **Circuit breakers (issue #301)**. Always-on loop gate; reads + tests exempt; `[circuit]` tunables; headless wrap-up; hook order includes circuit; `src/` tree `circuit/`.

`ARCHITECTURE.md` — tree line + concurrent-tool paragraph: circuit after risk, before write-path; wrap-up sentence under Headless.

`concepts.md` — one paragraph next to plan/risk/redact: mutating repeats/errors are hard-gated; reads/tests are not; headless can wrap up.

- [ ] **Step 2: Typecheck + focused tests**

Run: `bun typecheck && bun test tests/circuit-loop.test.ts tests/circuit-hook.test.ts tests/circuit-budget.test.ts tests/coding-domain.test.ts tests/turn.test.ts tests/hooks.test.ts tests/headless-run.test.ts`

Expected: typecheck clean, tests PASS

- [ ] **Step 3: Comment on #301**

```bash
gh issue comment 301 --body "$(cat <<'EOF'
Implemented on `feat/ad/issue-301-circuit-breakers`.

- Always-on LoopGate: 3rd identical mutating tool+args or 3rd attempt after 2 errors on the same base key is blocked; constraint + circuit notes in classic and engine compiles.
- Reads, read-equivalent shell, and test commands (`isTestCommand`, including bun test) are never gated.
- Headless `[circuit] max_tokens` / `max_wall_ms` (0 = off) trigger one no-tool wrap-up. No cheaper-model hop.
- Scorecard: circuitLoopBlocks, circuitBudgetWrapups.

Spec: `docs/superpowers/specs/2026-08-23-circuit-breakers-design.md`
EOF
)"
```

- [ ] **Step 4: Commit docs**

```bash
git add AGENTS.md docs/ARCHITECTURE.md docs/concepts.md
git commit -m "$(cat <<'EOF'
docs: document circuit-breaker loop gate and headless wrap-up

EOF
)"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Allow 2, block 3rd (args + errors) | Task 1 |
| Reads / tests / `bun test` exempt | Task 1 |
| Hook after risk, before write-path | Task 2 |
| Constraint + `circuitNotes` in both compilers | Task 2–3 |
| Resume from event log | Task 4 |
| Headless token/time wrap-up, no model switch | Task 5 |
| Scorecard counters | Task 5 |
| Docs + #301 comment | Task 6 |
| No disable hatch / no cheaper model | no task adds them |
