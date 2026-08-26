/**
 * Test runner orchestrator with adapter selection, sandbox validation, and execution.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type { SandboxConfig } from "../../types.js";
import { BunAdapter } from "./adapters/bun.js";
import { CargoAdapter } from "./adapters/cargo.js";
import { GenericAdapter } from "./adapters/generic.js";
import { GoAdapter } from "./adapters/go.js";
import { NpmAdapter } from "./adapters/npm.js";
import { PytestAdapter } from "./adapters/pytest.js";
import { spawnTestProcess } from "./spawn.js";
import type { RunTestsResult, TestRunnerAdapter } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export const KNOWN_ADAPTERS: TestRunnerAdapter[] = [
  new BunAdapter(),
  new NpmAdapter(),
  new GoAdapter(),
  new CargoAdapter(),
  new PytestAdapter(),
];

export function selectAdapter(
  cwd: string,
  hint?: string,
  command?: string,
): TestRunnerAdapter {
  if (hint) {
    const matched = KNOWN_ADAPTERS.find((a) => a.name === hint);
    if (matched) return matched;
  }

  if (command) {
    const firstToken = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (firstToken === "bun") return new BunAdapter();
    if (["npm", "pnpm", "yarn", "vitest", "jest"].includes(firstToken)) {
      return new NpmAdapter();
    }
    if (firstToken === "go") return new GoAdapter();
    if (firstToken === "cargo") return new CargoAdapter();
    if (["pytest", "py.test", "python", "python3"].includes(firstToken)) {
      return new PytestAdapter();
    }
  }

  for (const adapter of KNOWN_ADAPTERS) {
    if (adapter.detect(cwd)) {
      return adapter;
    }
  }

  return new GenericAdapter();
}

function sandboxBlockReason(
  path: string,
  sandbox: SandboxConfig | undefined,
): string | null {
  if (!sandbox?.enabled || sandbox.allowed_paths.length === 0) return null;

  const resolvePath = (p: string): string => {
    const expanded = p.replace(/^~/, homedir());
    const normalized = normalize(expanded);
    if (!existsSync(normalized)) return normalized;
    try {
      return realpathSync(normalized);
    } catch {
      return normalized;
    }
  };

  const resolved = resolvePath(path);
  const allowed = sandbox.allowed_paths.some((ap) => {
    const apResolved = resolvePath(ap);
    return resolved === apResolved || resolved.startsWith(apResolved + "/");
  });

  return allowed
    ? null
    : `Blocked by sandbox: path not in allowed list: ${path}`;
}

export async function executeTests(opts: {
  cwd: string;
  command?: string;
  files?: string[];
  timeout_ms?: number;
  runner?: string;
  sandbox?: SandboxConfig;
  getAbortSignal?: () => AbortSignal | undefined;
}): Promise<RunTestsResult> {
  const cwdBlocked = sandboxBlockReason(opts.cwd, opts.sandbox);
  if (cwdBlocked) {
    return { ok: false, error: cwdBlocked, code: "sandbox_blocked" };
  }

  if (opts.files?.length) {
    for (const f of opts.files) {
      const absPath = isAbsolute(f) ? normalize(f) : resolve(opts.cwd, f);
      const fileBlocked = sandboxBlockReason(absPath, opts.sandbox);
      if (fileBlocked) {
        return { ok: false, error: fileBlocked, code: "sandbox_blocked" };
      }
    }
  }

  const adapter = selectAdapter(opts.cwd, opts.runner, opts.command);
  const { command, args } = adapter.buildCommand({
    cwd: opts.cwd,
    files: opts.files,
    command: opts.command,
  });

  const fullCommandStr = [command, ...args].join(" ");
  const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const signal = opts.getAbortSignal?.();

  try {
    const spawned = await spawnTestProcess(command, args, {
      cwd: opts.cwd,
      timeoutMs,
      signal,
    });

    if (spawned.aborted) {
      return {
        ok: false,
        error: "Test execution was aborted",
        runner: adapter.name,
        command: fullCommandStr,
        code: "aborted",
      };
    }

    if (spawned.timedOut) {
      return {
        ok: false,
        error: `Test execution timed out after ${timeoutMs}ms`,
        runner: adapter.name,
        command: fullCommandStr,
        code: "timeout",
      };
    }

    const parsed = adapter.parseOutput(
      spawned.stdout,
      spawned.stderr,
      spawned.code,
    );

    const isOk =
      parsed.failed === 0 &&
      (spawned.code === 0 || spawned.code === null);

    return {
      ok: isOk,
      runner: adapter.name,
      command: fullCommandStr,
      passed: parsed.passed,
      failed: parsed.failed,
      skipped: parsed.skipped,
      duration_ms: spawned.duration_ms,
      files: parsed.files.length > 0 ? parsed.files : (opts.files ?? []),
      failures: parsed.failures,
      summary: parsed.summary ?? `${parsed.passed} passed, ${parsed.failed} failed`,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to spawn test command '${command}': ${msg}`,
      runner: adapter.name,
      command: fullCommandStr,
      code: "spawn_error",
    };
  }
}
