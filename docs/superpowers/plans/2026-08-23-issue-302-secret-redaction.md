# Issue #302: Secret Redaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redact known key prefixes, PEM blocks, and high-entropy `KEY=value` assignments in tool results (prompt + `events.jsonl`) and in a **copy** of tool-call args (log + TUI + recorder), without changing what tools execute.

**Architecture:** Pure `redactSecrets` in `src/redact/secrets.ts`. A builtin `post_tool_call` handler after validate enrich and before write-path release. `turn.ts` Phase 1 logs/TUI/`recordToolCall` use a redacted args copy; `execute` still gets original args. Always on. Never flip `ok`.

**Tech Stack:** TypeScript (strict, NodeNext), Bun test.

**Spec:** [`docs/superpowers/specs/2026-08-23-secret-redaction-design.md`](../specs/2026-08-23-secret-redaction-design.md)

**Branch:** `feat/ad/issue-302-secret-redaction`

**Out of scope:** user/agent chat, `[redact]` config, Slack/Stripe/JWT, memory DB, rewriting disk files, mutating execute args.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/redact/secrets.ts` | `redactSecrets(value)` walk + detectors |
| **Create** `src/hooks/handlers/redact.ts` | `createRedactPostToolCallHandler` |
| **Create** `tests/redact-secrets.test.ts` | Detector + walk + fixture false-positive |
| **Create** `tests/redact-hook.test.ts` | Post-hook + registry order vs enrich |
| **Modify** `src/hooks/index.ts` | Register redact after `validate.post`, before write-path release |
| **Modify** `src/turn.ts` | Redact args copy at `tool_call` log, `onToolCall`, `recordToolCall` |
| **Modify** `tests/turn.test.ts` | One case: logged args redacted, execute sees raw |
| **Modify** `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/concepts.md` | Hook order + always-on redact |

---

## Design Notes (locked)

### Detector order and regexes

Apply **in this order** with `String.replace` (global). Anthropic before OpenAI.

```ts
const DETECTORS: Array<{ kind: string; re: RegExp; replace?: (m: string) => string }> = [
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai-key", re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
];
```

Placeholder: `[REDACTED:${kind}]`.

`key-assignment` is **not** a single replace-all: scan with

```ts
/\b([A-Za-z_]*(?:API_KEY|PASSWORD|PASSWD|SECRET|TOKEN|KEY))\s*[=:]\s*(\S{20,})/gi
```

Skip the value if it is:

- hex-only length 40 or 64 (`/^[0-9a-f]+$/i`)
- Crockford ULID length 26 (`/^[0-9A-HJKMNP-TV-Z]{26}$/`)

Otherwise replace the **value** only (keep `KEY=`).

Min lengths above are why `sk-test-123` / `sk-ant-oat-access` in `tests/credentials.test.ts` must **not** match.

### Walk

```ts
const MAX_DEPTH = 8;
```

- `string` → run detectors
- `Array` → map recurse
- plain object → copy keys recurse (do not walk class instances beyond `Object`)
- other → return as-is
- wrap the public function in `try/catch` → return original

Do **not** mutate the input object graph; return a new object/array when descending so execute args stay intact if someone passes the same reference later.

### Hook order (post)

lsp → verify → enrich → **redact** → write-path release

---

### Task 1: `redactSecrets` helper

**Files:**
- Create: `tests/redact-secrets.test.ts`
- Create: `src/redact/secrets.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { redactSecrets } from "../src/redact/secrets.js";

describe("redactSecrets", () => {
  it("redacts AWS, GitHub, GitLab, OpenAI, Anthropic", () => {
    expect(redactSecrets("id=AKIAIOSFODNN7EXAMPLE")).toBe(
      "id=[REDACTED:aws-access-key]",
    );
    expect(redactSecrets("t=ghp_" + "a".repeat(36))).toContain("[REDACTED:github-token]");
    expect(redactSecrets("t=glpat-" + "b".repeat(20))).toContain("[REDACTED:gitlab-token]");
    expect(redactSecrets("k=sk-" + "c".repeat(40))).toContain("[REDACTED:openai-key]");
    expect(redactSecrets("k=sk-ant-" + "d".repeat(40))).toContain("[REDACTED:anthropic-key]");
  });

  it("treats sk-ant- as anthropic not openai", () => {
    const out = String(redactSecrets("sk-ant-" + "e".repeat(40)));
    expect(out).toContain("anthropic-key");
    expect(out).not.toContain("openai-key");
  });

  it("redacts a PEM block as one placeholder", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(pem)).toBe("[REDACTED:private-key]");
  });

  it("redacts KEY= mixed-charset values and skips SHA/ULID", () => {
    expect(redactSecrets("API_KEY=abc123XYZ-" + "f".repeat(16))).toContain(
      "[REDACTED:key-assignment]",
    );
    expect(redactSecrets("KEY=" + "a".repeat(40))).toBe("KEY=" + "a".repeat(40));
    expect(redactSecrets("TOKEN=01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(
      "TOKEN=01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
  });

  it("walks nested objects and does not flip ok", () => {
    const out = redactSecrets({
      ok: true,
      stdout: "AKIAIOSFODNN7EXAMPLE",
    }) as { ok: boolean; stdout: string };
    expect(out.ok).toBe(true);
    expect(out.stdout).toBe("[REDACTED:aws-access-key]");
  });

  it("does not walk deeper than 8", () => {
    let nested: unknown = "AKIAIOSFODNN7EXAMPLE";
    for (let i = 0; i < 9; i++) nested = { n: nested };
    const out = redactSecrets(nested) as { n: { n: unknown } };
    let cur: unknown = out;
    for (let i = 0; i < 8; i++) cur = (cur as { n: unknown }).n;
    expect(cur).toEqual({ n: "AKIAIOSFODNN7EXAMPLE" });
  });

  it("does not redact short dummy keys in credentials fixtures", () => {
    const text = readFileSync("tests/credentials.test.ts", "utf-8");
    const out = String(redactSecrets(text));
    expect(out).not.toContain("[REDACTED:");
    expect(out).toContain("sk-test-123");
    expect(out).toContain("sk-ant-oat-access");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/redact-secrets.test.ts`

Expected: FAIL — module not found

- [ ] **Step 3: Write `src/redact/secrets.ts`**

Implement `redactSecrets` using the regexes and walk rules in Design Notes. Export only `redactSecrets`. Catch all errors and return the original value.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/redact-secrets.test.ts`

Expected: PASS. If the credentials fixture test fails, tighten min lengths — do **not** weaken the fixture file.

- [ ] **Step 5: Commit**

```bash
git add src/redact/secrets.ts tests/redact-secrets.test.ts \
  docs/superpowers/specs/2026-08-23-secret-redaction-design.md \
  docs/superpowers/plans/2026-08-23-issue-302-secret-redaction.md
git commit -m "$(cat <<'EOF'
feat(redact): add secret detectors and object walker for #302

EOF
)"
```

---

### Task 2: Redact post-hook

**Files:**
- Create: `tests/redact-hook.test.ts`
- Create: `src/hooks/handlers/redact.ts`
- Modify: `src/hooks/index.ts`

- [ ] **Step 1: Write the failing hook test**

```ts
import { describe, expect, it } from "bun:test";
import { createBuiltinHookRegistry } from "../src/hooks/index.js";
import { createRedactPostToolCallHandler } from "../src/hooks/handlers/redact.js";
import type { HookSessionLike } from "../src/hooks/types.js";

function session(cwd = "/proj"): HookSessionLike {
  return { cwd, isPlanMode: () => false };
}

describe("redact post_tool_call", () => {
  it("redacts strings on the result and keeps ok", async () => {
    const post = createRedactPostToolCallHandler();
    const patch = await post({
      toolName: "shell",
      args: {},
      result: { ok: true, stdout: "AKIAIOSFODNN7EXAMPLE" },
      isError: false,
      session: session(),
    });
    expect(patch?.result).toEqual({
      ok: true,
      stdout: "[REDACTED:aws-access-key]",
    });
    expect(patch?.isError).toBeUndefined();
  });

  it("runs after enrich so suggestions are scanned", async () => {
    const registry = createBuiltinHookRegistry("/proj", {
      validate: { pathExists: () => false, listRepoFiles: () => [] },
    });
    const out = await registry.runPostToolCall({
      toolName: "write_file",
      args: { path: "a.ts" },
      result: {
        ok: false,
        error: "denied AKIAIOSFODNN7EXAMPLE",
        suggestions: ["AKIAIOSFODNN7EXAMPLE"],
      },
      isError: true,
      session: session(),
    });
    expect(out.isError).toBe(true);
    const r = out.result as { ok: boolean; error: string; suggestions?: string[] };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[REDACTED:aws-access-key]");
    expect(r.suggestions?.[0]).toBe("[REDACTED:aws-access-key]");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/redact-hook.test.ts`

Expected: FAIL — handler module not found (or second case still shows the raw key if only the handler exists but is not registered)

- [ ] **Step 3: Implement handler and register**

`src/hooks/handlers/redact.ts`:

```ts
import { redactSecrets } from "../../redact/secrets.js";
import type { PostToolCallHandler } from "../types.js";

export function createRedactPostToolCallHandler(): PostToolCallHandler {
  return (ctx) => {
    try {
      return { result: redactSecrets(ctx.result) };
    } catch {
      return;
    }
  };
}
```

In `src/hooks/index.ts`: import the factory; `registry.onPostToolCall(createRedactPostToolCallHandler())` **after** `validate.post` and **before** write-path release. Update the file comment to `post = lsp → verify → enrich → redact → write-path release`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/redact-hook.test.ts tests/redact-secrets.test.ts tests/hooks.test.ts tests/validate-hook.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/handlers/redact.ts src/hooks/index.ts tests/redact-hook.test.ts
git commit -m "$(cat <<'EOF'
feat(hooks): redact secrets on post_tool_call results

EOF
)"
```

---

### Task 3: Redact logged tool-call args

**Files:**
- Modify: `src/turn.ts`
- Modify: `tests/turn.test.ts`

- [ ] **Step 1: Write the failing turn test** (append near other `runTurn` tool-call tests)

Use `makeMockSession` as in that file. Mock `createAllTools` so `shell.execute` records the received `command`. Stream one `shell` tool call whose `command` is `echo AKIAIOSFODNN7EXAMPLE`. After `runTurn`:

```ts
expect(executedCommand).toBe("echo AKIAIOSFODNN7EXAMPLE");
const calls = session.eventLog.readLast(50).filter((e: Event) => e.kind === "tool_call");
expect((calls[0] as any).payload.args.command).toBe("echo [REDACTED:aws-access-key]");
```

Follow the existing `runTurn` + `piStream` mock pattern in `tests/turn.test.ts` (`processes tool calls and returns results`). Inject `onToolCall` on the sink if the test sink supports it and assert the same redacted command.

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/turn.test.ts --test-name-pattern "redacts tool_call args"`

Expected: FAIL — logged command still contains `AKIA`

- [ ] **Step 3: Change `src/turn.ts`**

At top: `import { redactSecrets } from "./redact/secrets.js";`

Phase 1 loop (~line 927):

```ts
    for (const tc of pendingToolCalls) {
      const loggedArgs = redactSecrets(tc.args ?? {}) as Record<string, unknown>;
      session.eventLog.append({
        kind: "tool_call",
        actor: "tool",
        payload: { toolCallId: tc.toolCallId, tool: tc.toolName, args: loggedArgs },
      });
      s.onToolCall?.(tc.toolCallId, tc.toolName, loggedArgs);
      if (tc.toolName !== "load_skill") hadNonLoadSkillTool = true;
    }
```

`recordToolCall` (~line 1136): pass `args: redactSecrets(tc.args ?? {}) as Record<string, unknown>` (or reuse a per-call `loggedArgs` if you thread it through the execute map — do **not** overwrite `tc.args`).

`execute(pre.args)` stays on the unredacted pre-hook args.

- [ ] **Step 4: Run tests**

Run: `bun test tests/turn.test.ts tests/redact-hook.test.ts tests/redact-secrets.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/turn.ts tests/turn.test.ts
git commit -m "$(cat <<'EOF'
feat(redact): log and display redacted tool-call args

EOF
)"
```

---

### Task 4: Docs and #302 comment

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/concepts.md`

- [ ] **Step 1: Update docs**

`AGENTS.md`:

- After the risk-gating subsection, add **Secret redaction (issue #302)**: always-on `post_tool_call` + logged args copy; kinds listed; execute args unchanged; no config.
- Hook-order sentences: `post = lsp → verify → enrich → redact → write-path`.
- `src/` tree: `redact/ — #302 secret detectors (post_tool_call + logged tool_call args)`.

`docs/ARCHITECTURE.md`:

- `hooks/` / new `redact/` line in the tree.
- Concurrent tool execution: mention result + logged-args redaction.

`docs/concepts.md`: one sentence under Security or Plan Mode’s neighbor — tool results and logged tool-call args are redacted before `events.jsonl` / prompt; chat text is not.

- [ ] **Step 2: Typecheck + focused tests**

Run: `bun typecheck && bun test tests/redact-secrets.test.ts tests/redact-hook.test.ts tests/turn.test.ts tests/hooks.test.ts tests/validate-hook.test.ts`

Expected: typecheck clean, tests PASS

- [ ] **Step 3: Comment on #302**

```bash
gh issue comment 302 --body "$(cat <<'EOF'
Implemented on `feat/ad/issue-302-secret-redaction`.

- Always-on `redactSecrets` + `post_tool_call` after enrich.
- Logged/TUI/recorder tool-call args are a redacted copy; execute uses original args.
- Detectors: aws-access-key, github-token, gitlab-token, openai-key, anthropic-key, private-key, key-assignment (SHA/ULID excluded).

Spec: `docs/superpowers/specs/2026-08-23-secret-redaction-design.md`
EOF
)"
```

- [ ] **Step 4: Commit docs**

```bash
git add AGENTS.md docs/ARCHITECTURE.md docs/concepts.md
git commit -m "$(cat <<'EOF'
docs: document always-on secret redaction for tool results and logged args

EOF
)"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Detectors + walk + soft-fail | Task 1 |
| `post_tool_call` after enrich | Task 2 |
| Args copy at log / TUI / recorder; execute raw | Task 3 |
| Docs + #302 comment | Task 4 |
| No config; no chat redaction | no task adds them |
