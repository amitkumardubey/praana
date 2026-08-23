# Issue #300: Tool-Call Pre-Validation and Error Enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail-fast missing/typo paths and unread `edit_file` before the tool runs, and attach `suggestions` / `recent_writes` on failed path-bearing results, without rewriting args or adding tools.

**Architecture:** Pure helpers in `src/validate/`. A builtin `pre_tool_call` + `post_tool_call` pair in `src/hooks/handlers/validate.ts` registered **after plan-mode and before write-path acquire** (so a block cannot leak a lock). The registry forwards `suggestions` on block; `turn.ts` copies them onto `{ ok: false, error, suggestions }`. Always on. Inject `pathExists` / `listRepoFiles` / `commandOnPath` / `hasReadPath` in tests.

**Tech Stack:** TypeScript (strict, NodeNext), Bun test. Reuse `commandOnPath` from `src/verify/spawn.ts` for PATH checks. Session read index via `ScorecardTracker.hasReadPath`.

**Spec:** [`docs/superpowers/specs/2026-08-23-tool-prevalidation-design.md`](../specs/2026-08-23-tool-prevalidation-design.md)

**Branch:** `feat/ad/issue-300-tool-prevalidation` (already created; spec committed).

**Out of scope:** silent path rewrite, `batch_*` unread checks, pipeline-aware shell, `[validate]` config, new tools.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/validate/fuzzy-path.ts` | `levenshtein`, `suggestPaths(query, candidates, cap)` |
| **Create** `src/validate/shell-check.ts` | `SHELL_BUILTINS`, `firstToken`, `checkShellCommand` |
| **Create** `src/hooks/handlers/validate.ts` | Pre + post handlers |
| **Create** `tests/validate-fuzzy.test.ts` | Pure fuzzy tests |
| **Create** `tests/validate-shell.test.ts` | Pure shell-check tests |
| **Create** `tests/validate-hook.test.ts` | Pre-block + post-enrich with injected deps |
| **Modify** `src/hooks/types.ts` | `suggestions` on block; `hasReadPath` / `recentWritesForPath` / `listReadPaths` on session |
| **Modify** `src/hooks/registry.ts` | Forward `suggestions` on block |
| **Modify** `src/hooks/index.ts` | Register validate after plan, before write-path |
| **Modify** `src/turn.ts` | Copy `suggestions` onto blocked tool result |
| **Modify** `src/session.ts` | `hasReadPath`, `listReadPaths`, `recentWritesForPath` |
| **Modify** `tests/hooks.test.ts` | Inject `pathExists: () => true` for `read_file` cases that must reach write-path |
| **Modify** `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/concepts.md` | Document always-on validate hook |

---

## Design Notes (locked)

### Unread `edit_file` when the read index is inactive

`ScorecardTracker.hasReadPath` returns `false` when there is no scorecard DB (classic, no measurement mode). **Do not hard-block in that case.** Session implementation:

```ts
hasReadPath(absPath: string): boolean | null {
  if (!this.scorecard.isActive()) return null; // skip unread check
  return this.scorecard.hasReadPath(absPath);
}
```

Handler: if `hasReadPath` is `null` or the method is missing, skip the unread check. Only block when the file exists **and** `hasReadPath(abs) === false`.

### Fuzzy ranking (`suggestPaths`)

1. Basename equality (case-sensitive).
2. Path suffix match (`candidate.endsWith(query)` or `candidate.endsWith("/" + query)`).
3. Levenshtein on **basename** only; keep if distance ≤ `max(2, ceil(0.3 * basename.length))`.
4. Cap 5. Skip candidates containing `node_modules/` or outside `sessionRoot`.

### Shell first token

Split `command` on whitespace; take the first token. Strip a leading `env FOO=bar` prefix only if you already have it — **v1: first whitespace token only** (spec: no pipeline parsing). `echo hi` → `echo` (builtin). `bun test` → `bun` (PATH). `no-such-bin-xyz` → block.

### Post-enrich tools

`read_file`, `edit_file`, `write_file`, `search_code`, and any `lsp_*` whose args include `path: string`. Cap `suggestions` at 5. `recent_writes` from `session.recentWritesForPath` (event-log `tool_call` payloads with `path` / `files` / `edits`). Soft-fail: empty arrays omitted.

---

### Task 1: Fuzzy path helper

**Files:**
- Create: `tests/validate-fuzzy.test.ts`
- Create: `src/validate/fuzzy-path.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { suggestPaths } from "../src/validate/fuzzy-path.js";

describe("suggestPaths", () => {
  const root = "/proj";
  const candidates = [
    "/proj/src/hooks/index.ts",
    "/proj/src/hooks/types.ts",
    "/proj/src/session.ts",
    "/proj/node_modules/foo/index.ts",
  ];

  it("ranks basename equality first", () => {
    expect(suggestPaths("types.ts", candidates, 5, root)[0]).toBe(
      "/proj/src/hooks/types.ts",
    );
  });

  it("matches a relative suffix", () => {
    expect(suggestPaths("hooks/index.ts", candidates, 5, root)).toContain(
      "/proj/src/hooks/index.ts",
    );
  });

  it("suggests a close basename typo", () => {
    expect(suggestPaths("sesion.ts", candidates, 5, root)).toContain(
      "/proj/src/session.ts",
    );
  });

  it("skips node_modules and caps at 5", () => {
    const many = Array.from({ length: 8 }, (_, i) => `/proj/a${i}.ts`);
    const out = suggestPaths("a0.ts", [...many, "/proj/node_modules/x.ts"], 5, root);
    expect(out).toHaveLength(5);
    expect(out.every((p) => !p.includes("node_modules"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/validate-fuzzy.test.ts
```

Expected: FAIL (`Cannot find module '../src/validate/fuzzy-path.js'`).

- [ ] **Step 3: Write minimal implementation**

`src/validate/fuzzy-path.ts`: export `levenshtein(a, b): number` (standard DP) and `suggestPaths(query, candidates, cap, sessionRoot): string[]`. Resolve `query` as a path fragment (not required to be absolute). Filter `node_modules/` and `!pathInRoot(candidate, sessionRoot)` (import `pathInRoot` from `src/lsp/workspace-roots.ts`). Sort: basename-equal, then suffix, then distance ascending. Dedupe, slice to `cap`.

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/validate-fuzzy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validate/fuzzy-path.ts tests/validate-fuzzy.test.ts
git commit -m "$(cat <<'EOF'
feat(validate): add fuzzy path suggestions for missing-file typos

EOF
)"
```

---

### Task 2: Shell command check helper

**Files:**
- Create: `tests/validate-shell.test.ts`
- Create: `src/validate/shell-check.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { checkShellCommand, firstToken } from "../src/validate/shell-check.js";

describe("firstToken", () => {
  it("takes the first whitespace token", () => {
    expect(firstToken("echo hi")).toBe("echo");
    expect(firstToken("  bun test")).toBe("bun");
  });
});

describe("checkShellCommand", () => {
  it("allows builtins without PATH", () => {
    expect(checkShellCommand("echo hi", { commandOnPath: () => false })).toBeNull();
  });

  it("allows a token on PATH", () => {
    expect(
      checkShellCommand("bun test", { commandOnPath: (n) => n === "bun" }),
    ).toBeNull();
  });

  it("blocks an unknown first token", () => {
    const err = checkShellCommand("no-such-bin-xyz -v", {
      commandOnPath: () => false,
    });
    expect(err).toContain("no-such-bin-xyz");
  });

  it("blocks a missing cwd", () => {
    const err = checkShellCommand("echo hi", {
      cwd: "/no/such/cwd",
      pathExists: () => false,
      commandOnPath: () => true,
    });
    expect(err).toContain("cwd");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/validate-shell.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

`src/validate/shell-check.ts`:

- Export `SHELL_BUILTINS` as a `Set<string>` with the closed list from the spec.
- `firstToken(command: string): string | null` — trim, split on `/\s+/`, return `[0]` or null if empty.
- `checkShellCommand(command, opts): string | null` — if `opts.cwd` is a non-empty string and `!(opts.pathExists ?? existsSync)(opts.cwd)`, return `"shell cwd does not exist: …"`. Then first token: if builtin, null; if `commandOnPath(token)`, null; else `"command not found on PATH: ${token}"`.

Copy the builtin list verbatim from the spec (do not invent extras).

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/validate-shell.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validate/shell-check.ts tests/validate-shell.test.ts
git commit -m "$(cat <<'EOF'
feat(validate): check shell cwd and first-token PATH

EOF
)"
```

---

### Task 3: Hook types + registry forward `suggestions`

**Files:**
- Modify: `src/hooks/types.ts`
- Modify: `src/hooks/registry.ts`
- Modify: `tests/hooks.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/hooks.test.ts` inside `describe("HookRegistry"`):

```ts
  it("forwards suggestions on a pre_tool_call block", async () => {
    const registry = new HookRegistry();
    registry.onPreToolCall(() => ({
      action: "block" as const,
      error: "missing",
      isError: true,
      suggestions: ["src/a.ts"],
    }));
    const result = await registry.runPreToolCall({
      toolName: "read_file",
      args: { path: "b.ts" },
      session: fakeSession(),
    });
    expect(result).toEqual({
      action: "block",
      error: "missing",
      isError: true,
      suggestions: ["src/a.ts"],
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/hooks.test.ts --test-name-pattern "forwards suggestions"
```

Expected: FAIL (result has no `suggestions`).

- [ ] **Step 3: Extend types and registry**

In `src/hooks/types.ts`:

```ts
export interface HookSessionLike {
  cwd: string;
  isPlanMode(): boolean;
  getLogger?(): unknown;
  hasReadPath?(absPath: string): boolean | null;
  listReadPaths?(): string[];
  recentWritesForPath?(absPath: string): Array<{ path: string; turn?: number }>;
}

export type PreToolCallHandlerResult =
  | void
  | { action?: "continue"; args?: Record<string, unknown> }
  | {
      action: "block";
      error: string;
      isError?: boolean;
      suggestions?: string[];
    };

export type PreToolCallDispatchResult =
  | { action: "continue"; args: Record<string, unknown> }
  | {
      action: "block";
      error: string;
      isError: boolean;
      suggestions?: string[];
    };
```

In `src/hooks/registry.ts` `runPreToolCall` block return:

```ts
        if (result && result.action === "block") {
          return {
            action: "block",
            error: result.error,
            isError: result.isError ?? true,
            ...(result.suggestions?.length
              ? { suggestions: result.suggestions }
              : {}),
          };
        }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/hooks.test.ts
```

Expected: PASS (existing exact-equality tests still omit `suggestions`).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/types.ts src/hooks/registry.ts tests/hooks.test.ts
git commit -m "$(cat <<'EOF'
feat(hooks): forward suggestions on pre_tool_call blocks

EOF
)"
```

---

### Task 4: Validate pre-hook (read / edit / shell)

**Files:**
- Create: `tests/validate-hook.test.ts`
- Create: `src/hooks/handlers/validate.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "bun:test";
import { createValidateHandlers } from "../src/hooks/handlers/validate.js";
import type { HookSessionLike } from "../src/hooks/types.js";

function session(cwd: string, extra?: Partial<HookSessionLike>): HookSessionLike {
  return { cwd, isPlanMode: () => false, ...extra };
}

describe("validate pre_tool_call", () => {
  it("blocks missing read_file with suggestions", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => false,
      listRepoFiles: () => ["/proj/src/session.ts"],
    });
    const out = await pre({
      toolName: "read_file",
      args: { path: "sesion.ts" },
      session: session("/proj"),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.suggestions).toContain("/proj/src/session.ts");
      expect(out.isError).toBe(true);
    }
  });

  it("blocks unread existing edit_file", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => true,
      listRepoFiles: () => [],
    });
    const out = await pre({
      toolName: "edit_file",
      args: { path: "a.ts" },
      session: session("/proj", { hasReadPath: () => false }),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.error).toMatch(/read the file first/i);
    }
  });

  it("allows edit_file after a session read", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => true,
    });
    const out = await pre({
      toolName: "edit_file",
      args: { path: "a.ts" },
      session: session("/proj", { hasReadPath: () => true }),
    });
    expect(out).toBeUndefined();
  });

  it("skips unread check when hasReadPath is null", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => true,
    });
    const out = await pre({
      toolName: "edit_file",
      args: { path: "a.ts" },
      session: session("/proj", { hasReadPath: () => null }),
    });
    expect(out).toBeUndefined();
  });

  it("does not throw when listRepoFiles throws", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => false,
      listRepoFiles: () => {
        throw new Error("git failed");
      },
    });
    const out = await pre({
      toolName: "read_file",
      args: { path: "missing.ts" },
      session: session("/proj"),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.suggestions).toBeUndefined();
    }
  });

  it("blocks shell with an unknown first token", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      commandOnPath: () => false,
    });
    const out = await pre({
      toolName: "shell",
      args: { command: "no-such-bin-xyz" },
      session: session("/proj"),
    });
    expect(out?.action).toBe("block");
  });

  it("allows shell echo", async () => {
    const { pre } = createValidateHandlers({
      cwd: "/proj",
      commandOnPath: () => false,
    });
    const out = await pre({
      toolName: "shell",
      args: { command: "echo hi" },
      session: session("/proj"),
    });
    expect(out).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/validate-hook.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement `createValidateHandlers`**

`src/hooks/handlers/validate.ts` (pre half + stub post that returns void for now):

```ts
export interface ValidateHookOptions {
  cwd: string;
  pathExists?: (absPath: string) => boolean;
  listRepoFiles?: () => string[];
  commandOnPath?: (name: string) => boolean;
}

export function createValidateHandlers(opts: ValidateHookOptions): {
  pre: PreToolCallHandler;
  post: PostToolCallHandler;
}
```

Resolve paths with `isAbsolute ? path : resolve(cwd, path)`.
Missing `read_file` / missing `edit_file`: block with `suggestPaths(args.path, files, 5, cwd)` where `files = [...listRepoFiles(), ...session.listReadPaths?.() ?? []]` inside try/catch.
Unread `edit_file`: `pathExists` true and `session.hasReadPath?.(abs) === false` → block `"Read the file first before edit_file: ${rel}"`.
`shell`: `checkShellCommand(String(args.command ?? ""), { cwd: typeof args.cwd === "string" ? resolve cwd : undefined, pathExists, commandOnPath })`.
Default `pathExists` = `existsSync`. Default `commandOnPath` = import from `src/verify/spawn.ts`. Default `listRepoFiles` = `git ls-files -z` via `spawnSync("git", ["ls-files", "-z"], { cwd })` split on `\0`; catch → `[]`.

Do **not** validate `write_file` / `batch_*` in pre.

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/validate-hook.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/validate.ts tests/validate-hook.test.ts
git commit -m "$(cat <<'EOF'
feat(validate): block missing reads, unread edits, and unknown shell bins

EOF
)"
```

---

### Task 5: Post-enrich failed path tools

**Files:**
- Modify: `src/hooks/handlers/validate.ts`
- Modify: `tests/validate-hook.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/validate-hook.test.ts`:

```ts
describe("validate post_tool_call", () => {
  it("attaches suggestions and recent_writes on a failed write_file", async () => {
    const { post } = createValidateHandlers({
      cwd: "/proj",
      pathExists: () => false,
      listRepoFiles: () => ["/proj/src/a.ts"],
    });
    const patch = await post({
      toolName: "write_file",
      args: { path: "b.ts" },
      result: { ok: false, error: "sandbox" },
      isError: true,
      session: session("/proj", {
        recentWritesForPath: () => [{ path: "/proj/src/a.ts", turn: 2 }],
      }),
    });
    const result = patch?.result as {
      ok: boolean;
      suggestions?: string[];
      recent_writes?: Array<{ path: string }>;
    };
    expect(result.ok).toBe(false);
    expect(result.suggestions?.length).toBeGreaterThan(0);
    expect(result.recent_writes?.[0]?.path).toBe("/proj/src/a.ts");
  });

  it("does not enrich a successful result", async () => {
    const { post } = createValidateHandlers({ cwd: "/proj" });
    const patch = await post({
      toolName: "write_file",
      args: { path: "a.ts" },
      result: { ok: true },
      isError: false,
      session: session("/proj"),
    });
    expect(patch).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/validate-hook.test.ts --test-name-pattern "attaches suggestions"
```

Expected: FAIL (`patch` undefined or no `suggestions`).

- [ ] **Step 3: Implement post handler**

If `!isError` or `result` is not an object or `ok !== false`, return. Collect `path` from args (`path` string, or first `files[]`/`edits[]` path). If no path, return. Build `suggestions` via the same try/catch fuzzy helper. `recent_writes` from `session.recentWritesForPath?.(abs)`. Patch `{ ...result, suggestions?, recent_writes? }` only if at least one field is non-empty. Never set `isError` or `ok`.

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/validate-hook.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/validate.ts tests/validate-hook.test.ts
git commit -m "$(cat <<'EOF'
feat(validate): enrich failed path-tool results with suggestions

EOF
)"
```

---

### Task 6: Wire registry, turn.ts, session

**Files:**
- Modify: `src/hooks/index.ts`
- Modify: `src/turn.ts` (block result around line 984–986)
- Modify: `src/session.ts`
- Modify: `tests/hooks.test.ts`
- Modify: `tests/validate-hook.test.ts` (optional: builtin order test)

- [ ] **Step 1: Write the failing tests**

1. In `tests/hooks.test.ts`, for every `createBuiltinHookRegistry` / `registerBuiltinHooks` call that uses `read_file` on a missing path (`allows read-only tools in plan mode`, `blocks read_file while a write lock is held`), pass:

```ts
{ validate: { pathExists: () => true } }
```

(Extend `BuiltinHookOptions` in the same task.) Until validate is registered, this is a no-op; after registration, it keeps those tests asserting write-path / plan-mode — not missing-path.

2. Append a registry-order test to `tests/validate-hook.test.ts`:

```ts
  it("validate runs before write-path so a missing read does not hold a lock", async () => {
    const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { createBuiltinHookRegistry } = await import("../src/hooks/index.js");
    const dir = join(tmpdir(), `praana-val-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const registry = createBuiltinHookRegistry(dir);
      const sess = session(dir);
      const blocked = await registry.runPreToolCall({
        toolName: "read_file",
        args: { path: "missing.ts" },
        session: sess,
      });
      expect(blocked.action).toBe("block");
      writeFileSync(join(dir, "missing.ts"), "x\n");
      const again = await registry.runPreToolCall({
        toolName: "write_file",
        args: { path: "missing.ts", content: "y" },
        session: sess,
      });
      expect(again.action).toBe("continue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

3. Add `tests/validate-turn-block.test.ts` **or** extend an existing turn test only if cheap. Prefer a focused unit: after wiring, `runPreToolCall` block with suggestions is enough; then change `turn.ts` so a block copies suggestions. If there is no existing turn test that asserts `{ ok: false, error }` from plan-mode, skip a full turn test and rely on a tiny exported helper:

```ts
// src/hooks/block-result.ts
export function toolResultFromPreBlock(
  pre: Extract<PreToolCallDispatchResult, { action: "block" }>,
): { ok: false; error: string; suggestions?: string[] } {
  return {
    ok: false,
    error: pre.error,
    ...(pre.suggestions?.length ? { suggestions: pre.suggestions } : {}),
  };
}
```

Use that helper in `turn.ts` and test it in `tests/validate-hook.test.ts`:

```ts
it("toolResultFromPreBlock copies suggestions", () => {
  expect(
    toolResultFromPreBlock({
      action: "block",
      error: "missing",
      isError: true,
      suggestions: ["a.ts"],
    }),
  ).toEqual({ ok: false, error: "missing", suggestions: ["a.ts"] });
});
```

Write this test first (it will fail until the helper exists).

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/validate-hook.test.ts tests/hooks.test.ts
```

Expected: FAIL on new assertions (helper missing / validate not registered).

- [ ] **Step 3: Wire**

`src/hooks/index.ts`:

- Add `validate?: ValidateHookOptions` (minus `cwd` — use registry `cwd`) to `BuiltinHookOptions`.
- After `createPlanModePreToolCallHandler()`, register:

```ts
  const validate = createValidateHandlers({
    cwd,
    pathExists: opts?.validate?.pathExists,
    listRepoFiles: opts?.validate?.listRepoFiles,
    commandOnPath: opts?.validate?.commandOnPath,
  });
  registry.onPreToolCall(validate.pre);
  // post: after verify, before write-path release
```

Register `validate.post` after `createVerifyPostToolCallHandler` and **before** `createWritePathPostToolCallHandler`.

Update the comment to: `pre = plan → validate → write-path → lsp snapshot`; `post = lsp → verify → enrich → write-path release`.

`src/hooks/block-result.ts` + `turn.ts` replace the inline `{ ok: false, error: pre.error }` with `toolResultFromPreBlock(pre)`.

`src/session.ts` on the class:

```ts
  hasReadPath(absPath: string): boolean | null {
    if (!this.scorecard.isActive()) return null;
    return this.scorecard.hasReadPath(absPath);
  }

  listReadPaths(): string[] {
    return this.scorecard.listReadPaths?.() ?? [];
  }

  recentWritesForPath(absPath: string): Array<{ path: string; turn?: number }> {
    const out: Array<{ path: string; turn?: number }> = [];
    try {
      for (const ev of this.eventLog.readAll()) {
        if (ev.kind !== "tool_call") continue;
        const tool = ev.payload.tool ?? ev.payload.toolName;
        if (tool !== "write_file" && tool !== "edit_file" && tool !== "batch_write" && tool !== "batch_edit") continue;
        const args = ev.payload.args as Record<string, unknown> | undefined;
        if (!args) continue;
        const paths: string[] = [];
        if (typeof args.path === "string") paths.push(args.path);
        if (Array.isArray(args.files)) {
          for (const f of args.files) {
            if (f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string") {
              paths.push((f as { path: string }).path);
            }
          }
        }
        if (Array.isArray(args.edits)) {
          for (const e of args.edits) {
            if (e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string") {
              paths.push((e as { path: string }).path);
            }
          }
        }
        for (const p of paths) {
          const resolved = isAbsolute(p) ? p : resolve(this.cwd, p);
          if (resolved === absPath) out.push({ path: resolved });
        }
      }
    } catch {
      return [];
    }
    return out.slice(-5);
  }
```

If `ScorecardTracker` has no `listReadPaths`, add a small method that returns `[]` when inactive, or skip session `listReadPaths` and only use `git ls-files` + injected reads in tests. **Do not** invent a digest→path reverse map if digests are one-way — then `listReadPaths` on Session returns `[]` and fuzzy uses git + explicit test injection only. That is acceptable and YAGNI.

- [ ] **Step 4: Run tests**

```bash
bun typecheck
bun test tests/validate-*.test.ts tests/hooks.test.ts
```

Expected: typecheck clean; all those tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/index.ts src/hooks/block-result.ts src/turn.ts src/session.ts tests/hooks.test.ts tests/validate-hook.test.ts
git commit -m "$(cat <<'EOF'
feat(validate): register pre/post hooks and copy suggestions onto blocks

EOF
)"
```

---

### Task 7: Docs and #300 comment

**Files:**
- Modify: `AGENTS.md` (hooks / turn-flow: mention always-on validate)
- Modify: `docs/ARCHITECTURE.md` (hooks line + concurrent tool section)
- Modify: `docs/concepts.md` (file mutation / shell row)
- Modify: spec status line to `Implemented on feat/ad/issue-300-tool-prevalidation`

- [ ] **Step 1: Update docs**

AGENTS.md — after the hooks bullet, add a short **Tool pre-validation (issue #300)** paragraph: always-on; missing `read_file` / unread `edit_file` / unknown `shell` first token block with `suggestions`; failed path tools may get `recent_writes`; never rewrites args.

ARCHITECTURE.md — hook order string; `src/validate/` in the tree.

concepts.md — one sentence on fail-fast path suggestions.

- [ ] **Step 2: Comment on GitHub**

```bash
gh issue comment 300 --body "$(cat <<'EOF'
## Implementation

Spec: \`docs/superpowers/specs/2026-08-23-tool-prevalidation-design.md\` (branch \`feat/ad/issue-300-tool-prevalidation\`).

Always-on \`pre_tool_call\` / \`post_tool_call\`: missing \`read_file\` and unread \`edit_file\` block with fuzzy \`suggestions\`; \`shell\` checks cwd + first-token PATH. Failed path tools get \`suggestions\` + \`recent_writes\`. Args are never rewritten. Validate runs after plan-mode and before write-path acquire.

EOF
)"
```

- [ ] **Step 3: Full verify**

```bash
bun typecheck && bun test tests/validate-*.test.ts tests/hooks.test.ts
```

Expected: PASS. Full `bun test` may still show the known 8 env-key failures.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/ARCHITECTURE.md docs/concepts.md docs/superpowers/specs/2026-08-23-tool-prevalidation-design.md
git commit -m "$(cat <<'EOF'
docs: document always-on tool pre-validation (#300)

EOF
)"
```

---

## Spec coverage

| Spec item | Task |
|---|---|
| Always on, no config, no new tools, no arg rewrite | 4–6 |
| Pre-block `{ ok, error, suggestions }`, `isError: true` | 3, 6 |
| Post-enrich never flips `ok` | 5 |
| Hook order plan → validate → write-path | 6 |
| `read_file` missing + fuzzy cap 5 | 1, 4 |
| `edit_file` unread hard-block; missing fuzzy | 4 |
| Skip unread when read index inactive | 4, 6 |
| `write_file` / `batch_*` not in pre | 4 |
| `shell` cwd + first token + closed builtins | 2, 4 |
| Soft-fail `git ls-files` throw | 4 |
| `HookSessionLike` methods, no Session import in handler | 3, 4, 6 |
| Docs + #300 comment | 7 |
