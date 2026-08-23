# Issue #303: Risk-Tiered Action Gating — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm destructive/outward tool calls with a deterministic classifier and inline TTY y/n; delete forced Plan-Before-Execute and intent auto-detection; keep `/plan on` as an opt-in mutation gate.

**Architecture:** Pure helpers in `src/risk/`. A builtin `pre_tool_call` handler in `src/hooks/handlers/risk.ts` registered **after validate and before write-path acquire**. Session implements `confirmRisk` (headless allowlist vs TTY readline) behind a confirm mutex. Always on. Never rewrite args. Tests inject `confirmRisk`.

**Tech Stack:** TypeScript (strict, NodeNext), Bun test, `node:readline` (same as `edit.confirm`).

**Spec:** [`docs/superpowers/specs/2026-08-23-risk-tiered-gating-design.md`](../specs/2026-08-23-risk-tiered-gating-design.md)

**Branch:** `feat/ad/issue-303-risk-tiered-gating`

**Out of scope:** session-level allow-once, TUI dialog, confirming `git_commit` / plain `git push` / `npm ci`, expanding plan-mode mutations, changing `edit.confirm`.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/risk/classes.ts` | `RiskClass` union, `RISK_CLASSES` set, confirm result type |
| **Create** `src/risk/classify.ts` | `classifyRisk(tool, args, cwd)` → hit or `null` |
| **Create** `src/risk/confirm-lock.ts` | `createConfirmLock()` serializes async confirms |
| **Create** `src/risk/prompt.ts` | `promptYesNo(question)` readline `[y/N]` |
| **Create** `src/hooks/handlers/risk.ts` | `createRiskPreToolCallHandler` |
| **Create** `tests/risk-classify.test.ts` | Classifier table |
| **Create** `tests/risk-confirm-lock.test.ts` | Mutex order |
| **Create** `tests/risk-hook.test.ts` | Pre-block / continue with injected `confirmRisk` |
| **Modify** `src/hooks/types.ts` | `confirmRisk?` on `HookSessionLike` |
| **Modify** `src/hooks/index.ts` | Register risk after validate, before write-path |
| **Modify** `src/types.ts` | `RiskConfig`; optional `risk` on `PraanaConfig` |
| **Modify** `src/config.ts` | Default `[risk]`, append-merge `risk.allow`, warn/drop unknown ids |
| **Modify** `src/session.ts` | `confirmRisk` (headless allowlist / TTY + lock) |
| **Modify** `src/plan-mode.ts` | Delete `detectPlanModeIntent` |
| **Modify** `src/turn.ts` | Stop auto-enter; drop `planBeforeExecute` compile flag |
| **Modify** `src/compiler.ts` | Delete Plan-Before-Execute block + `planBeforeExecute` |
| **Modify** `src/context-engine/engine-compiler.ts` | Stop passing `planBeforeExecute` |
| **Modify** `tests/plan-mode.test.ts`, `tests/compiler.test.ts`, `tests/config.test.ts`, `tests/hooks.test.ts` | Match new behavior |
| **Modify** `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/concepts.md` | Risk hook + `/plan on` only |

---

## Design Notes (locked)

### Classifier

`classifyRisk(toolName, args, cwd): { class: RiskClass; detail: string } | null`

- `detail` is the shell `command` string or the first resolved outside path.
- Path tools: `write_file` / `edit_file` use `args.path`. `batch_write` uses `args.files[].path`. `batch_edit` uses `args.edits[].path`. One outside path is enough.
- Outside cwd: `relative(cwd, abs) === ""` is inside; `rel.startsWith("..")` or `isAbsolute(rel)` is outside.
- Shell: split on whitespace. Skip leading tokens that are `sudo` or match `/^[A-Za-z_][A-Za-z0-9_]*=/`. Then classify remaining tokens. No pipeline / `&&` parsing.
- `package_install`: first remaining token in `{npm,pnpm,yarn,bun,pip,pip3}` **and** the **next** token is `install`, `add`, or `i`. `npm ci` and `npm run install` are free.
- Force-push flag: token is `-f`, `--force`, `--force-with-lease` / `--force-with-lease=…`, or a short cluster (`startsWith("-") && !startsWith("--") && slice(1).includes("f")`).
- `git clean`: same `f` / `--force` rule. `git clean -n` and `git clean -d` are free.

### Confirm result

```ts
type RiskConfirmResult =
  | { allowed: true }
  | { allowed: false; reason: "declined" | "headless" };
```

Hook errors:

- `headless` → `Blocked in headless (<class>). Add it to [risk].allow to permit.`
- `declined` or missing `confirmRisk` → `User declined <class>: <detail>` for TTY decline; missing callback uses the headless error (fail closed).

### Hook order (pre)

plan → validate → **risk** → write-path acquire → LSP snapshot

### `/plan on`

Unchanged mutation set. `rm` is **not** a plan-mode mutation, so it reaches risk confirm while armed.

---

### Task 1: Classifier

**Files:**
- Create: `tests/risk-classify.test.ts`
- Create: `src/risk/classes.ts`
- Create: `src/risk/classify.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { classifyRisk } from "../src/risk/classify.js";

const cwd = "/proj";

describe("classifyRisk", () => {
  it("classifies rm including sudo and env prefixes", () => {
    expect(classifyRisk("shell", { command: "rm -rf /tmp/x" }, cwd)?.class).toBe("rm");
    expect(classifyRisk("shell", { command: "sudo rm -rf /tmp/x" }, cwd)?.class).toBe("rm");
    expect(classifyRisk("shell", { command: "FOO=1 rm foo" }, cwd)?.class).toBe("rm");
  });

  it("classifies git reset, force-push, and clean -f", () => {
    expect(classifyRisk("shell", { command: "git reset --hard HEAD" }, cwd)?.class).toBe(
      "git_reset",
    );
    expect(classifyRisk("shell", { command: "git push --force" }, cwd)?.class).toBe(
      "git_force_push",
    );
    expect(classifyRisk("shell", { command: "git push --force-with-lease" }, cwd)?.class).toBe(
      "git_force_push",
    );
    expect(classifyRisk("shell", { command: "git push -uf origin main" }, cwd)?.class).toBe(
      "git_force_push",
    );
    expect(classifyRisk("shell", { command: "git clean -fdx" }, cwd)?.class).toBe("git_clean");
  });

  it("leaves plain git push and git clean -n free", () => {
    expect(classifyRisk("shell", { command: "git push origin main" }, cwd)).toBeNull();
    expect(classifyRisk("shell", { command: "git clean -n" }, cwd)).toBeNull();
  });

  it("classifies gh close/merge and package install", () => {
    expect(classifyRisk("shell", { command: "gh issue close 1" }, cwd)?.class).toBe(
      "gh_issue_close",
    );
    expect(classifyRisk("shell", { command: "gh pr merge 2" }, cwd)?.class).toBe("gh_pr_merge");
    expect(classifyRisk("shell", { command: "npm install lodash" }, cwd)?.class).toBe(
      "package_install",
    );
    expect(classifyRisk("shell", { command: "pnpm add foo" }, cwd)?.class).toBe(
      "package_install",
    );
    expect(classifyRisk("shell", { command: "bun i bar" }, cwd)?.class).toBe("package_install");
  });

  it("leaves npm ci and npm run install free", () => {
    expect(classifyRisk("shell", { command: "npm ci" }, cwd)).toBeNull();
    expect(classifyRisk("shell", { command: "npm run install" }, cwd)).toBeNull();
  });

  it("flags write_file / batch path outside cwd", () => {
    expect(classifyRisk("write_file", { path: "../x.ts" }, cwd)?.class).toBe(
      "write_outside_cwd",
    );
    expect(
      classifyRisk("batch_write", { files: [{ path: "src/a.ts" }, { path: "/etc/passwd" }] }, cwd)
        ?.class,
    ).toBe("write_outside_cwd");
    expect(classifyRisk("write_file", { path: "src/a.ts" }, cwd)).toBeNull();
    expect(classifyRisk("edit_file", { path: "./src/a.ts" }, cwd)).toBeNull();
  });

  it("returns null for unknown tools and empty shell", () => {
    expect(classifyRisk("read_file", { path: "../x" }, cwd)).toBeNull();
    expect(classifyRisk("shell", { command: "" }, cwd)).toBeNull();
    expect(classifyRisk("git_commit", { message: "x" }, cwd)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/risk-classify.test.ts`

Expected: FAIL — `Cannot find module '../src/risk/classify.js'`

- [ ] **Step 3: Write minimal implementation**

`src/risk/classes.ts`:

```ts
export const RISK_CLASSES = [
  "rm",
  "git_reset",
  "git_force_push",
  "git_clean",
  "gh_issue_close",
  "gh_pr_merge",
  "package_install",
  "write_outside_cwd",
] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

export const RISK_CLASS_SET = new Set<string>(RISK_CLASSES);

export type RiskConfirmResult =
  | { allowed: true }
  | { allowed: false; reason: "declined" | "headless" };

export interface RiskHit {
  class: RiskClass;
  detail: string;
}

export function isRiskClass(id: string): id is RiskClass {
  return RISK_CLASS_SET.has(id);
}
```

`src/risk/classify.ts`:

```ts
import { isAbsolute, relative, resolve } from "node:path";
import type { RiskClass, RiskHit } from "./classes.js";

const PKG = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3"]);
const PKG_SUB = new Set(["install", "add", "i"]);

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export function isOutsideCwd(cwd: string, relPath: string): boolean {
  const abs = resolvePath(cwd, relPath);
  const rel = relative(cwd, abs);
  if (rel === "") return false;
  return rel.startsWith("..") || isAbsolute(rel);
}

function collectWritePaths(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === "write_file" || toolName === "edit_file") {
    return typeof args.path === "string" ? [args.path] : [];
  }
  if (toolName === "batch_write" && Array.isArray(args.files)) {
    return args.files
      .map((f) => (f && typeof f === "object" && "path" in f ? (f as { path: unknown }).path : null))
      .filter((p): p is string => typeof p === "string");
  }
  if (toolName === "batch_edit" && Array.isArray(args.edits)) {
    return args.edits
      .map((e) => (e && typeof e === "object" && "path" in e ? (e as { path: unknown }).path : null))
      .filter((p): p is string => typeof p === "string");
  }
  return [];
}

export function shellArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

export function stripShellPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function isShortForceCluster(tok: string): boolean {
  return tok.startsWith("-") && !tok.startsWith("--") && tok.length > 1 && tok.slice(1).includes("f");
}

function hasForceFlag(tokens: string[]): boolean {
  return tokens.some(
    (t) =>
      t === "-f" ||
      t === "--force" ||
      t === "--force-with-lease" ||
      t.startsWith("--force-with-lease=") ||
      isShortForceCluster(t),
  );
}

function classifyShell(command: string): RiskHit | null {
  const tokens = stripShellPrefixes(shellArgv(command));
  if (tokens.length === 0) return null;
  const [cmd, sub, third] = tokens;
  if (cmd === "rm") return { class: "rm", detail: command };
  if (cmd === "git" && sub === "reset") return { class: "git_reset", detail: command };
  if (cmd === "git" && sub === "push" && hasForceFlag(tokens.slice(2))) {
    return { class: "git_force_push", detail: command };
  }
  if (cmd === "git" && sub === "clean" && hasForceFlag(tokens.slice(2))) {
    return { class: "git_clean", detail: command };
  }
  if (cmd === "gh" && sub === "issue" && third === "close") {
    return { class: "gh_issue_close", detail: command };
  }
  if (cmd === "gh" && sub === "pr" && third === "merge") {
    return { class: "gh_pr_merge", detail: command };
  }
  if (PKG.has(cmd) && sub !== undefined && PKG_SUB.has(sub)) {
    return { class: "package_install", detail: command };
  }
  return null;
}

export function isRiskClass(id: string): id is RiskClass {
  return RISK_CLASS_SET.has(id);
}
```

Do **not** also export `isRiskClass` from `classify.ts`.

- [ ] **Step 4: Run test to verify it passes**

Wait I need to fix this - I accidentally left classifyRisk in the replacement. Let me read that section of the file.
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): RiskHit | null {
  if (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "batch_write" ||
    toolName === "batch_edit"
  ) {
    for (const p of collectWritePaths(toolName, args)) {
      if (isOutsideCwd(cwd, p)) {
        return { class: "write_outside_cwd", detail: resolvePath(cwd, p) };
      }
    }
    return null;
  }
  if (toolName === "shell" && typeof args.command === "string") {
    return classifyShell(args.command);
  }
  return null;
}
```

Do not export `isRiskClass` from `classify.ts` — it lives in `classes.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/risk-classify.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/risk/classes.ts src/risk/classify.ts tests/risk-classify.test.ts \
  docs/superpowers/specs/2026-08-23-risk-tiered-gating-design.md \
  docs/superpowers/plans/2026-08-23-issue-303-risk-tiered-gating.md
git commit -m "$(cat <<'EOF'
feat(risk): add deterministic action classifier for #303

EOF
)"
```

---

### Task 2: Confirm lock

**Files:**
- Create: `tests/risk-confirm-lock.test.ts`
- Create: `src/risk/confirm-lock.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { createConfirmLock } from "../src/risk/confirm-lock.js";

describe("createConfirmLock", () => {
  it("runs overlapping calls in start order", async () => {
    const lock = createConfirmLock();
    const order: number[] = [];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const a = lock(async () => {
      await wait(30);
      order.push(1);
      return 1;
    });
    const b = lock(async () => {
      order.push(2);
      return 2;
    });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(order).toEqual([1, 2]);
  });

  it("releases the lock when the first call rejects", async () => {
    const lock = createConfirmLock();
    const first = lock(async () => {
      throw new Error("boom");
    });
    const second = lock(async () => "ok");
    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/risk-confirm-lock.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
export function createConfirmLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return function withConfirmLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/risk-confirm-lock.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/risk/confirm-lock.ts tests/risk-confirm-lock.test.ts
git commit -m "$(cat <<'EOF'
feat(risk): serialize concurrent confirm prompts

EOF
)"
```

---

### Task 3: Risk pre-hook

**Files:**
- Create: `tests/risk-hook.test.ts`
- Create: `src/hooks/handlers/risk.ts`
- Modify: `src/hooks/types.ts` — add `confirmRisk?` to `HookSessionLike`

- [ ] **Step 1: Extend `HookSessionLike` and write the failing hook test**

In `src/hooks/types.ts`, add the import and method:

```ts
import type { RiskClass, RiskConfirmResult } from "../risk/classes.js";

export interface HookSessionLike {
  cwd: string;
  isPlanMode(): boolean;
  getLogger?(): unknown;
  hasReadPath?(absPath: string): boolean | null;
  listReadPaths?(): string[];
  recentWritesForPath?(absPath: string): Array<{ path: string; turn?: number }>;
  confirmRisk?(classId: RiskClass, prompt: string): Promise<RiskConfirmResult>;
}
```

Keep the existing JSDoc on the other optional methods.

`tests/risk-hook.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createRiskPreToolCallHandler } from "../src/hooks/handlers/risk.js";
import type { HookSessionLike } from "../src/hooks/types.js";
import type { RiskConfirmResult } from "../src/risk/classes.js";

function session(
  cwd: string,
  confirmRisk?: HookSessionLike["confirmRisk"],
  plan = false,
): HookSessionLike {
  return { cwd, isPlanMode: () => plan, confirmRisk };
}

describe("risk pre_tool_call", () => {
  it("continues when confirmRisk allows", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "shell",
      args: { command: "rm -rf tmp" },
      session: session("/proj", async () => ({ allowed: true })),
    });
    expect(out).toBeUndefined();
  });

  it("blocks TTY decline with class and command", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "shell",
      args: { command: "rm -rf tmp" },
      session: session("/proj", async () => ({ allowed: false, reason: "declined" })),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.error).toBe("User declined rm: rm -rf tmp");
      expect(out.isError).toBe(true);
    }
  });

  it("blocks headless deny with allowlist hint", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "shell",
      args: { command: "npm install x" },
      session: session("/proj", async () => ({ allowed: false, reason: "headless" })),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.error).toContain("Blocked in headless (package_install)");
      expect(out.error).toContain("[risk].allow");
    }
  });

  it("fail-closes when confirmRisk is missing", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "shell",
      args: { command: "rm foo" },
      session: session("/proj"),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.error).toContain("Blocked in headless (rm)");
    }
  });

  it("treats confirmRisk throw as decline", async () => {
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "shell",
      args: { command: "rm foo" },
      session: session("/proj", async () => {
        throw new Error("stdin closed");
      }),
    });
    expect(out?.action).toBe("block");
    if (out && out.action === "block") {
      expect(out.error).toBe("User declined rm: rm foo");
    }
  });

  it("skips free tools without calling confirmRisk", async () => {
    let called = 0;
    const pre = createRiskPreToolCallHandler("/proj");
    const out = await pre({
      toolName: "write_file",
      args: { path: "src/a.ts" },
      session: session("/proj", async () => {
        called++;
        return { allowed: true };
      }),
    });
    expect(out).toBeUndefined();
    expect(called).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/risk-hook.test.ts`

Expected: FAIL — handler module not found (types change alone must still typecheck)

- [ ] **Step 3: Write the handler**

```ts
import { classifyRisk } from "../../risk/classify.js";
import type { PreToolCallHandler } from "../types.js";

export function createRiskPreToolCallHandler(cwd: string): PreToolCallHandler {
  return async (ctx) => {
    const hit = classifyRisk(ctx.toolName, ctx.args, cwd);
    if (!hit) return;
    const prompt = `${hit.class}: ${hit.detail}`;
    let result: { allowed: true } | { allowed: false; reason: "declined" | "headless" };
    if (!ctx.session.confirmRisk) {
      result = { allowed: false, reason: "headless" };
    } else {
      try {
        result = await ctx.session.confirmRisk(hit.class, prompt);
      } catch {
        result = { allowed: false, reason: "declined" };
      }
    }
    if (result.allowed) return;
    const error =
      result.reason === "headless"
        ? `Blocked in headless (${hit.class}). Add it to [risk].allow to permit.`
        : `User declined ${hit.class}: ${hit.detail}`;
    return { action: "block", error, isError: true };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/risk-hook.test.ts tests/risk-classify.test.ts tests/hooks.test.ts`

Expected: PASS. If `hooks.test.ts` typecheck complains about `HookSessionLike`, it should still assign — `confirmRisk` is optional.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/types.ts src/hooks/handlers/risk.ts tests/risk-hook.test.ts
git commit -m "$(cat <<'EOF'
feat(hooks): add risk-tier pre_tool_call confirm handler

EOF
)"
```

---

### Task 4: Config `[risk]`

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write the failing config tests** (add to `tests/config.test.ts` next to the `shell.allowed_paths` cases)

```ts
it("appends and dedupes risk.allow (global + local)", () => {
  const global = { risk: { allow: ["rm", "package_install"] } };
  const local = { risk: { allow: ["git_reset", "rm"] } };
  const merged = deepMerge(global, local);
  expect(merged.risk.allow).toEqual(["rm", "package_install", "git_reset"]);
});

it("keeps base risk.allow when override is empty", () => {
  const base = { risk: { allow: ["rm"] } };
  const merged = deepMerge(base, { risk: { allow: [] as string[] } });
  expect(merged.risk.allow).toEqual(["rm"]);
});
```

Add this next to the existing TOML merge test in `describe("loadConfig multi-source array merge")`:

```ts
  it("filters unknown risk.allow ids and appends known ones", () => {
    writeFileSync(
      join(praanaHome, APP_HOME_DIR, "config.toml"),
      '[risk]\nallow = ["package_install", "not_a_class"]\n',
      "utf-8",
    );
    writeFileSync(
      join(projectDir, "praana.config.toml"),
      '[risk]\nallow = ["rm", "package_install"]\n',
      "utf-8",
    );

    const config = loadConfig();
    expect(config.risk?.allow).toEqual(["package_install", "rm"]);
    expect(getConfigWarnings().some((w) => w.includes("not_a_class"))).toBe(true);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `bun test tests/config.test.ts`

Expected: FAIL — `risk` missing / not append-merged / unknown ids not filtered

- [ ] **Step 3: Implement config**

In `src/types.ts`, next to `EditConfig`:

```ts
export interface RiskConfig {
  /** Headless-only class ids permitted without a prompt. Default: []. */
  allow: readonly string[];
}
```

On `PraanaConfig`:

```ts
  edit: EditConfig;
  /** Optional; defaults to { allow: [] } when omitted. */
  risk?: RiskConfig;
```

In `src/config.ts` `DEFAULT_CONFIG`:

```ts
  edit: {
    confirm: false,
  },
  risk: {
    allow: [],
  },
```

Add to `ARRAY_MERGE_STRATEGIES`:

```ts
  "shell.allowed_paths": "append",
  "risk.allow": "append",
```

In `validateConfig`, after the shell block (import `RISK_CLASS_SET` from `./risk/classes.js`):

```ts
  if (!out.risk || !Array.isArray(out.risk.allow)) {
    if (out.risk && !Array.isArray(out.risk.allow)) {
      configWarn("risk.allow must be string array, defaulting to []");
    }
    out.risk = { allow: [] };
  } else {
    const kept: string[] = [];
    for (const id of out.risk.allow) {
      if (typeof id !== "string" || !RISK_CLASS_SET.has(id)) {
        configWarn(`unknown risk.allow id ${JSON.stringify(id)}, ignoring`);
        continue;
      }
      kept.push(id);
    }
    out.risk = { allow: kept };
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/config.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "$(cat <<'EOF'
feat(config): add [risk].allow append-merge allowlist

EOF
)"
```

---

### Task 5: Wire registry + Session.confirmRisk

**Files:**
- Create: `src/risk/prompt.ts`
- Modify: `src/hooks/index.ts`
- Modify: `src/session.ts`
- Modify: `tests/hooks.test.ts` (only if a `read_file` / write-path case now hits risk — they should not)
- Modify: `tests/risk-hook.test.ts` — add a registry-order test

- [ ] **Step 1: Write the failing registry-order test** (append to `tests/risk-hook.test.ts`)

```ts
import { createBuiltinHookRegistry } from "../src/hooks/index.js";

describe("risk hook registration", () => {
  it("runs after plan-mode so write_file is blocked by plan first", async () => {
    let confirmCalls = 0;
    const registry = createBuiltinHookRegistry("/proj", {
      validate: { pathExists: () => true },
    });
    const out = await registry.runPreToolCall({
      toolName: "write_file",
      args: { path: "src/a.ts" },
      session: {
        cwd: "/proj",
        isPlanMode: () => true,
        confirmRisk: async () => {
          confirmCalls++;
          return { allowed: true };
        },
      },
    });
    expect(out.action).toBe("block");
    expect(confirmCalls).toBe(0);
  });

  it("reaches risk confirm for rm while plan mode is on", async () => {
    let confirmCalls = 0;
    const registry = createBuiltinHookRegistry("/proj");
    const out = await registry.runPreToolCall({
      toolName: "shell",
      args: { command: "rm -rf tmp" },
      session: {
        cwd: "/proj",
        isPlanMode: () => true,
        confirmRisk: async () => {
          confirmCalls++;
          return { allowed: false, reason: "declined" };
        },
      },
    });
    expect(out.action).toBe("block");
    expect(confirmCalls).toBe(1);
    if (out.action === "block") {
      expect(out.error).toContain("User declined rm");
    }
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/risk-hook.test.ts`

Expected: FAIL on the new cases — `rm` is not confirmed because risk is not registered; `write_file` in plan mode already blocks (that case may already pass via plan-mode). The `rm` case is the one that must fail.

- [ ] **Step 3: Implement prompt helper, register hook, Session.confirmRisk**

`src/risk/prompt.ts`:

```ts
import { createInterface } from "node:readline";
import { writeUiStderr } from "../ui.js";

export async function promptYesNo(question: string): Promise<boolean> {
  writeUiStderr(question);
  const answer = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Apply? [y/N] ", (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
    rl.on("close", () => {
      /* question callback also closes */
    });
    rl.on("error", reject);
  });
  return answer === "y" || answer === "yes";
}
```

Do **not** attach a `close` listener that rejects after a normal answer — `rl.question` + `rl.close()` is enough. If `question` throws, Session treats it as decline.

`src/hooks/index.ts`:

```ts
import { createRiskPreToolCallHandler } from "./handlers/risk.js";
```

After `registry.onPreToolCall(validate.pre);` and **before** write-path:

```ts
  registry.onPreToolCall(createRiskPreToolCallHandler(cwd));
```

Update the file comment to:

`pre = plan → validate → risk → write-path acquire → lsp snapshot`

`src/session.ts` — import `createConfirmLock`, `promptYesNo`, `RISK_CLASS_SET`, types. Add a private field next to other instance fields:

```ts
  private readonly confirmLock = createConfirmLock();
```

Add a public method (near `isPlanMode`):

```ts
  async confirmRisk(
    classId: import("./risk/classes.js").RiskClass,
    prompt: string,
  ): Promise<import("./risk/classes.js").RiskConfirmResult> {
    const allow = this.config.risk?.allow ?? [];
    if (this.headless) {
      return allow.includes(classId)
        ? { allowed: true }
        : { allowed: false, reason: "headless" };
    }
    return this.confirmLock(async () => {
      try {
        const yes = await promptYesNo(`${prompt}`);
        return yes ? { allowed: true } : { allowed: false, reason: "declined" };
      } catch {
        return { allowed: false, reason: "declined" };
      }
    });
  }
```

Use a real import at the top of `session.ts` instead of inline `import()`:

```ts
import { createConfirmLock } from "./risk/confirm-lock.js";
import { promptYesNo } from "./risk/prompt.js";
import type { RiskClass, RiskConfirmResult } from "./risk/classes.js";
```

`allow.includes(classId)` is enough — `validateConfig` already dropped unknown ids. Do not re-check `RISK_CLASS_SET` unless you skip `validateConfig` in tests.

- [ ] **Step 4: Run tests**

Run: `bun test tests/risk-hook.test.ts tests/hooks.test.ts tests/validate-hook.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/risk/prompt.ts src/hooks/index.ts src/session.ts tests/risk-hook.test.ts
git commit -m "$(cat <<'EOF'
feat(risk): wire confirm hook and session TTY/headless confirm

EOF
)"
```

---

### Task 6: Remove forced planning

**Files:**
- Modify: `src/plan-mode.ts` — delete `detectPlanModeIntent`
- Modify: `src/turn.ts` — drop auto-enter + `planBeforeExecute`
- Modify: `src/compiler.ts` — delete rule + `planBeforeExecute` field/arg
- Modify: `src/context-engine/engine-compiler.ts` — stop passing the flag
- Modify: `tests/plan-mode.test.ts` — delete the `detectPlanModeIntent` describe
- Modify: `tests/compiler.test.ts` — replace the three Plan-Before-Execute tests
- Modify: `tests/headless-run.test.ts` — update the comment only (headless still sets `session.headless`)

- [ ] **Step 1: Write the failing compiler assertion**

Replace the three tests in `tests/compiler.test.ts` (`should include plan-before-execute…`, `omits plan-before-execute when planBeforeExecute is false (headless)`, `compile omits plan-before-execute when planBeforeExecute is false`) with:

```ts
  it('does not inject a Plan-Before-Execute rule', () => {
    const prompt = compile({
      stateGraph: {
        list: () => [],
        getActive: () => [],
        getPeripheral: () => [],
      } as any,
      memoryDigest: null,
      recentEvents: [],
      toolSchemas: [],
      cwd: '/test',
      sessionId: 'test-1',
      tokenBudget: 4000,
    });

    expect(prompt).not.toContain('## Plan-Before-Execute Rule');
    expect(prompt).not.toContain('first response must be a plan only');
    expect(prompt).toContain('## Memory Management');
  });
```

Delete the `detectPlanModeIntent` import and entire `describe("detectPlanModeIntent", …)` block from `tests/plan-mode.test.ts`. Keep approval + mutating-tool tests.

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/compiler.test.ts tests/plan-mode.test.ts`

Expected: compiler test FAIL (rule still present). plan-mode test FAIL on missing export if you delete the describe before deleting the function — delete tests first so the run fails on the compiler assertion, or delete both in Step 3.

- [ ] **Step 3: Implement removals**

`src/plan-mode.ts`: delete `detectPlanModeIntent` (the function and its JSDoc). Leave `detectPlanApproval`.

`src/turn.ts`:

```ts
import {
  detectPlanApproval,
} from "./plan-mode.js";
```

Replace the plan-mode gating block with:

```ts
  // Leaving plan mode requires an explicit approval word or /plan execute.
  if (session.isPlanMode() && detectPlanApproval(userInput)) {
    session.exitPlanMode();
  }
```

Remove `planBeforeExecute: !session.headless` from the compile input object (~line 504).

`src/compiler.ts`:

- Remove `import { PLAN_MODE_BLOCKED_TOOLS } from "./plan-mode.js";`
- Remove `planBeforeExecute?: boolean` from `CompileInput` (and its JSDoc)
- Remove the last `planBeforeExecute` argument from every `buildSystemFrame(...)` call
- Change `buildSystemFrame` signature to drop the last parameter
- Delete the `if (planBeforeExecute !== false) { … Plan-Before-Execute … }` block

`src/context-engine/engine-compiler.ts`: remove `input.planBeforeExecute` from the `buildSystemFrame` call (it becomes 7 args).

`tests/headless-run.test.ts`: change the comment from “compile gates Plan-Before-Execute” to “marks the session headless so risk confirm fail-closes without a TTY”.

Grep the repo for `planBeforeExecute` and `detectPlanModeIntent` — both must be gone from `src/` and `tests/`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/compiler.test.ts tests/plan-mode.test.ts tests/headless-run.test.ts tests/risk-hook.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plan-mode.ts src/turn.ts src/compiler.ts \
  src/context-engine/engine-compiler.ts tests/compiler.test.ts \
  tests/plan-mode.test.ts tests/headless-run.test.ts
git commit -m "$(cat <<'EOF'
feat(plan): drop forced Plan-Before-Execute and intent auto-detect

EOF
)"
```

---

### Task 7: Docs and #303 comment

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/concepts.md`

- [ ] **Step 1: Update docs**

`AGENTS.md` — Architecture blurb for `plan-mode.ts` (the one-line tree): keep as plan-mode helpers; add `risk/` to the `src/` tree after `hooks/`:

```
  risk/          — #303 classify + confirm lock (pre_tool_call after validate)
```

Replace the **Tool pre-validation** hook-order sentence with: validate then **risk confirm** then write-path.

Replace the **Plan mode** subsection so it says:

- `/plan on` is **user-armed only** (no auto-detect, no Plan-Before-Execute system-frame rule)
- Approval words still leave an armed plan
- Headless: no auto-enter (already true); destructive classes need `[risk].allow`
- Always-on risk confirm: `rm` / `git reset` / force-push / `git clean -f` / `gh issue close` / `gh pr merge` / package install / writes outside cwd
- Hook order: plan → validate → risk → write-path

Turn-flow bullets: `pre_tool_call hooks (plan-mode + validate + risk + write-path)`

`docs/ARCHITECTURE.md`:

- Hooks line: include risk
- Plan mode section: same facts as AGENTS.md; delete “auto-detects plan intent” and `planBeforeExecute: false`
- Concurrent tool execution: mention risk confirm (serialized TTY via confirm lock)

`docs/concepts.md` **Plan Mode**: armed only via `/plan on`; no system-frame Plan-Before-Execute; risk-tier confirm is a separate always-on hook. Headless fail-closes confirm-tier unless `[risk].allow`.

- [ ] **Step 2: Typecheck + focused tests**

Run: `bun typecheck && bun test tests/risk-classify.test.ts tests/risk-confirm-lock.test.ts tests/risk-hook.test.ts tests/config.test.ts tests/compiler.test.ts tests/plan-mode.test.ts tests/hooks.test.ts tests/validate-hook.test.ts`

Expected: typecheck clean, tests PASS

- [ ] **Step 3: Comment on #303**

```bash
gh issue comment 303 --body "$(cat <<'EOF'
Implemented on `feat/ad/issue-303-risk-tiered-gating`.

- Always-on `pre_tool_call` risk confirm after validate, before write-path.
- Classes: `rm`, `git_reset`, `git_force_push`, `git_clean`, `gh_issue_close`, `gh_pr_merge`, `package_install`, `write_outside_cwd`.
- TTY: inline `[y/N]`. Headless: deny unless `[risk].allow` (append-merge).
- Deleted Plan-Before-Execute system-frame rule and `detectPlanModeIntent`. `/plan on` + approval words unchanged.

Spec: `docs/superpowers/specs/2026-08-23-risk-tiered-gating-design.md`
EOF
)"
```

- [ ] **Step 4: Commit docs**

```bash
git add AGENTS.md docs/ARCHITECTURE.md docs/concepts.md
git commit -m "$(cat <<'EOF'
docs: document risk-tiered gating and opt-in /plan on

EOF
)"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Classifier + class ids | Task 1 |
| TTY y/n, headless allowlist, mutex | Tasks 2, 3, 5 |
| Hook order before write-path | Tasks 3, 5 |
| `[risk].allow` append-merge + unknown warn | Task 4 |
| Delete Plan-Before-Execute + auto-detect; keep `/plan on` | Task 6 |
| Docs + #303 comment | Task 7 |
| `npm ci` free; first-subcommand install | Task 1 tests |
| `edit.confirm` unchanged | no task touches it |
