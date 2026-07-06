# /shell Slash Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/shell <command>` and `!<command>` direct shell execution to the TUI, reusing the existing `shell` tool sandbox and rendering output inline in the transcript.

**Architecture:** Extract the shell execution logic from `src/tools/system.ts` into a reusable `executeShellCommand` helper. Add a `/shell` case to `src/slash-commands.ts`. Detect the `!` prefix and route `/shell` output through the transcript sink in `src/ui/tui/run.ts`.

**Tech Stack:** TypeScript, Bun, `@earendil-works/pi-tui`, `node:child_process`.

---

## Task 1: Extract reusable `executeShellCommand` helper

**Files:**
- Modify: `src/tools/system.ts`

- [ ] **Step 1: Add the helper interface and function after `SystemToolContext`**

Insert the following code into `src/tools/system.ts` right after the `SystemToolContext` interface (before `createSystemTools`):

```ts
export interface ShellRunOptions {
  command: string;
  cwd: string;
  sandbox?: SandboxConfig;
  timeout?: number;
  abortSignal?: AbortSignal;
  onStdout?(chunk: Buffer): void;
  onStderr?(chunk: Buffer): void;
}

export interface ShellRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function executeShellCommand(
  opts: ShellRunOptions,
): Promise<ShellRunResult> {
  const { command, cwd, sandbox, timeout, abortSignal, onStdout, onStderr } = opts;

  if (abortSignal?.aborted) {
    return { ok: false, stdout: "", stderr: "Interrupted", exitCode: 130 };
  }

  // Sandbox validation
  if (sandbox?.enabled) {
    const dangerousPatterns = [
      /\bsudo\b/,
      /\brm\b.*-r.*\//,
      /\brm\b.*-f.*\//,
      /\bmkfs\b/,
      /\bdd\b.*if=/,
      /\bdd\b.*of=/,
      /\bshutdown\b/,
      /\breboot\b/,
      /\bhalt\b/,
      /\bpoweroff\b/,
      /\bfdisk\b/,
      /\bparted\b/,
      /\bwipefs\b/,
      /\bcryptsetup\b/,
      /\bchmod\b.*-R.*777.*\//,
      /\bchown\b.*-R.*\//,
      /\>\s*\/dev\/sd[a-z]/,
      /\:\(\)\{\s*:\|\&\s*\};/,
    ];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return {
          ok: false,
          stdout: "",
          stderr: "Blocked by sandbox: dangerous command detected",
          exitCode: 1,
        };
      }
    }
    if (sandbox.allowed_paths.length > 0) {
      const pathPattern = /(?:["']([^"']+)["']|\/[\w.\/-]+|\~\/[\w.\/-]+)/g;
      let match: RegExpExecArray | null;
      while ((match = pathPattern.exec(command)) !== null) {
        const rawPath = match[1] ?? match[2];
        if (!rawPath) continue;
        const expanded = rawPath.replace(/^~/, homedir());
        const normalized = normalize(expanded);
        let resolved: string;
        try {
          resolved = existsSync(normalized) ? realpathSync(normalized) : normalized;
        } catch {
          resolved = normalized;
        }
        const isAllowed = sandbox.allowed_paths.some((ap) => {
          const apExpanded = ap.replace(/^~/, homedir());
          const apNormalized = normalize(apExpanded);
          let apResolved: string;
          try {
            apResolved = existsSync(apNormalized) ? realpathSync(apNormalized) : apNormalized;
          } catch {
            apResolved = apNormalized;
          }
          return resolved === apResolved || resolved.startsWith(apResolved + "/");
        });
        if (!isAllowed) {
          return {
            ok: false,
            stdout: "",
            stderr: `Blocked by sandbox: path not in allowed list: ${rawPath}`,
            exitCode: 1,
          };
        }
      }
    }
  }

  const ms = timeout ?? 30000;
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      cwd,
      shell: "/bin/bash",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBuf = 10 * 1024 * 1024;

    const finish = (result: ShellRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000);
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000);
    }, ms);

    child.stdout?.on("data", (chunk: Buffer) => {
      onStdout?.(chunk);
      if (stdout.length < maxBuf) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      onStderr?.(chunk);
      if (stderr.length < maxBuf) stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (abortSignal?.aborted) {
        finish({
          ok: false,
          stdout: stdout.slice(0, maxBuf),
          stderr: stderr.slice(0, maxBuf) || "Interrupted",
          exitCode: 130,
        });
        return;
      }
      finish({
        ok: code === 0,
        stdout: stdout.slice(0, maxBuf),
        stderr: stderr.slice(0, maxBuf),
        exitCode: code ?? 1,
      });
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        stdout,
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}
```

- [ ] **Step 2: Replace the shell tool's inline execution body**

In `src/tools/system.ts`, replace the existing `shell` tool `execute` body (the part after sandbox validation) with a call to `executeShellCommand`:

```ts
execute: async ({ command, timeout }) => {
  const signal = getAbortSignal?.();
  if (signal?.aborted) {
    return { ok: false, stdout: "", stderr: "Interrupted", exitCode: 130 };
  }

  return executeShellCommand({
    command,
    cwd,
    sandbox,
    timeout,
    abortSignal: signal,
    onStdout: shellLiveStream !== false
      ? (chunk) => process.stdout.write(chunk)
      : undefined,
    onStderr: shellLiveStream !== false
      ? (chunk) => process.stderr.write(chunk)
      : undefined,
  });
},
```

- [ ] **Step 3: Verify the shell tool still compiles and streams**

Run:

```bash
bun typecheck
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/tools/system.ts
git commit -m "refactor(tools): extract executeShellCommand helper from shell tool"
```

---

## Task 2: Add `/shell` slash command

**Files:**
- Modify: `src/slash-commands.ts`

- [ ] **Step 1: Add the new display type and import the helper**

Change the `SlashCommandDisplay` type definition from:

```ts
export type SlashCommandDisplay = "transcript" | "toast";
```

to:

```ts
export type SlashCommandDisplay = "transcript" | "toast" | "inline_transcript";
```

Add this import near the top of `src/slash-commands.ts`:

```ts
import { executeShellCommand } from "./tools/system.js";
```

- [ ] **Step 2: Add the `/shell` case to the switch**

Insert this case before the `default` case in `executeSlashCommand`:

```ts
case "/shell": {
  const command = parts.slice(1).join(" ");
  if (!command) {
    lines.push("Usage: /shell <command>");
    return result("none", "toast", "error");
  }

  const runResult = await executeShellCommand({
    command,
    cwd: session.cwd,
    sandbox: session.config.shell,
    timeout: 30000,
  });

  lines.push(`$ ${command}`);
  if (runResult.stdout) lines.push(...runResult.stdout.split("\n"));
  if (runResult.stderr) lines.push(...runResult.stderr.split("\n"));
  if (!runResult.ok && !runResult.stdout && !runResult.stderr) {
    lines.push(runResult.stderr || `Command failed with exit code ${runResult.exitCode}`);
  } else if (runResult.exitCode !== 0) {
    lines.push(`exit code: ${runResult.exitCode}`);
  }

  return result("none", "inline_transcript", runResult.ok ? undefined : "error");
}
```

- [ ] **Step 3: Verify compilation**

Run:

```bash
bun typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/slash-commands.ts
git commit -m "feat(slash): add /shell command using shared shell runner"
```

---

## Task 3: Render `/shell` output inline in the TUI and support `!` prefix

**Files:**
- Modify: `src/ui/tui/run.ts`

- [ ] **Step 1: Add `/shell` to the autocomplete list**

Add `{ name: "/shell", description: "Run a shell command directly", argumentHint: "<command>" }` to the `SLASH_COMMANDS` array in `src/ui/tui/run.ts`.

- [ ] **Step 2: Detect and rewrite the `!` prefix**

In `editor.inner.onSubmit`, before the existing `if (input.startsWith("/"))` block, add:

```ts
if (input.startsWith("!")) {
  const command = input.slice(1).trim();
  if (!command) {
    toast.show("Usage: !<command>", "error");
    return;
  }
  input = `/shell ${command}`;
}
```

- [ ] **Step 3: Render `inline_transcript` results through the sink**

Replace the existing slash-command result handling block:

```ts
if (input.startsWith("/")) {
  const result = await controller.executeSlashCommand(input);

  if (result.display === "toast" && result.toastTone) {
    toast.show(
      result.lines.join(" "),
      result.toastTone === "error"
        ? "error"
        : result.toastTone === "success"
          ? "success"
          : "info",
    );
  } else if (result.lines.length > 0) {
    sink.onSlashCommandResult?.(result.lines);
  }
  ...
}
```

with:

```ts
if (input.startsWith("/")) {
  const result = await controller.executeSlashCommand(input);

  if (result.display === "inline_transcript") {
    sink.nextGroup();
    sink.appendUser(input);
    if (result.lines.length > 0) {
      sink.onSystemLines(result.lines);
    }
  } else if (result.display === "toast" && result.toastTone) {
    toast.show(
      result.lines.join(" "),
      result.toastTone === "error"
        ? "error"
        : result.toastTone === "success"
          ? "success"
          : "info",
    );
  } else if (result.lines.length > 0) {
    sink.onSlashCommandResult?.(result.lines);
  }

  if (result.action === "exit") {
    await doShutdown();
    return;
  }
  if (result.action === "clear_transcript") {
    projection.apply({ type: "transcript_cleared" });
    transcript.renderEntries([]);
  }
  if (result.action === "refresh_status") {
    refreshChrome();
  }
  tui.requestRender();
  return;
}
```

- [ ] **Step 4: Verify compilation**

Run:

```bash
bun typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/run.ts
git commit -m "feat(tui): render /shell inline and support ! prefix"
```

---

## Task 4: Update help text

**Files:**
- Modify: `src/app-banner.ts`

- [ ] **Step 1: Add `/shell` and `!` to the slash commands help block**

Insert these lines into the `getHelpLines()` array in `src/app-banner.ts`, after `/sessions`:

```ts
"  /shell <command>         Run a shell command directly",
"  !<command>               Shortcut for /shell <command>",
```

- [ ] **Step 2: Commit**

```bash
git add src/app-banner.ts
git commit -m "docs(help): document /shell and ! commands"
```

---

## Task 5: Unit tests for `/shell`

**Files:**
- Modify: `tests/slash-commands.test.ts`

- [ ] **Step 1: Mock the shell runner module**

Add this import at the top of `tests/slash-commands.test.ts`:

```ts
import * as systemToolsActual from "../src/tools/system.js";
```

Then add these mocks after the `mrReal` snapshot and before the existing `mock.module` for model-resolver:

```ts
const stReal = { ...systemToolsActual };
const mockExecuteShellCommand = mock<typeof systemToolsActual.executeShellCommand>();

mock.module("../src/tools/system.js", () => ({
  ...stReal,
  executeShellCommand: mockExecuteShellCommand,
}));
```

- [ ] **Step 2: Reset the mock in `beforeEach`**

Add `mockExecuteShellCommand.mockReset();` to the `beforeEach` block.

- [ ] **Step 3: Write tests**

Add a new `describe("/shell", () => { ... })` block at the end of the file:

```ts
describe("/shell", () => {
  function mockSession() {
    return {
      cwd: "/tmp",
      config: {
        shell: { enabled: false, allowed_paths: [] },
      },
    } as unknown as Session;
  }

  it("returns usage error when no command is given", async () => {
    const session = mockSession();
    const result = await executeSlashCommand("/shell", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(result.display).toBe("toast");
    expect(result.toastTone).toBe("error");
    expect(result.lines[0]).toBe("Usage: /shell <command>");
    expect(mockExecuteShellCommand).not.toHaveBeenCalled();
  });

  it("runs the command and returns output as inline transcript", async () => {
    mockExecuteShellCommand.mockResolvedValue({
      ok: true,
      stdout: "hello\nworld",
      stderr: "",
      exitCode: 0,
    });
    const session = mockSession();
    const result = await executeSlashCommand("/shell echo hello", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(mockExecuteShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: "echo hello", cwd: "/tmp" }),
    );
    expect(result.display).toBe("inline_transcript");
    expect(result.lines).toContain("$ echo hello");
    expect(result.lines).toContain("hello");
  });

  it("flags error tone on non-zero exit", async () => {
    mockExecuteShellCommand.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "nope",
      exitCode: 1,
    });
    const session = mockSession();
    const result = await executeSlashCommand("/shell false", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(result.display).toBe("inline_transcript");
    expect(result.toastTone).toBe("error");
    expect(result.lines[result.lines.length - 1]).toBe("exit code: 1");
  });
});
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/slash-commands.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/slash-commands.test.ts
git commit -m "test(slash): add /shell command tests"
```

---

## Task 6: TUI routing test for `!` prefix

**Files:**
- Modify: `tests/tui-run.test.ts`

- [ ] **Step 1: Add a test that `!` is rewritten to `/shell`**

Add this test inside the existing `describe("runTui", ...)` block:

```ts
it("rewrites !<command> to /shell and renders inline", async () => {
  fakeController.executeSlashCommand.mockImplementation(async (input: string) => ({
    action: "none" as const,
    lines: ["$ git status", "nothing to commit"],
    display: "inline_transcript" as const,
  }));

  const runPromise = runTui(fakeController as never, fakeInfo);
  await Promise.resolve();
  expect(latestEditor).not.toBeNull();

  latestEditor!.onSubmit!("!git status");

  await Promise.resolve();
  await Promise.resolve();

  expect(fakeController.executeSlashCommand).toHaveBeenCalledWith("/shell git status");
  runPromise.catch(() => {});
});
```

- [ ] **Step 2: Run tests**

```bash
bun test tests/tui-run.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/tui-run.test.ts
git commit -m "test(tui): verify ! prefix routes to /shell"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run full typecheck**

```bash
bun typecheck
```

Expected: no errors.

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 3: Final review**

Check:
- `/shell echo hello` prints inline in the TUI transcript.
- `!pwd` runs `/shell pwd`.
- Sandbox still blocks dangerous commands when enabled.
- `/help` shows the new commands.

---

## Self-review checklist

- **Spec coverage:** Every requirement from `docs/superpowers/specs/2026-07-06-issue-118-shell-slash-command-design.md` maps to a task above.
- **Placeholder scan:** No TBD/TODO; all code blocks are complete.
- **Type consistency:** `executeShellCommand` signature, `SlashCommandDisplay`, and `inline_transcript` handling match across tasks.
