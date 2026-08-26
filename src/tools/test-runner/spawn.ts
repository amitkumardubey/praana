/**
 * Process spawner for test execution with timeout and abort support.
 */

import { spawn } from "node:child_process";

export interface SpawnTestResult {
  stdout: string;
  stderr: string;
  code: number | null;
  duration_ms: number;
  timedOut?: boolean;
  aborted?: boolean;
}

export function spawnTestProcess(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<SpawnTestResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let timedOut = false;
    let aborted = false;

    if (opts.signal?.aborted) {
      return reject(new Error("aborted"));
    }

    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (abortHandler && opts.signal) {
        opts.signal.removeEventListener("abort", abortHandler);
      }
      resolve({
        stdout,
        stderr,
        code,
        duration_ms: Math.round(performance.now() - start),
        timedOut: timedOut ? true : undefined,
        aborted: aborted ? true : undefined,
      });
    };

    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid == null) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Process group may already be gone.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Already dead
      }
    };

    const abortHandler = () => {
      aborted = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => {
        killTree("SIGKILL");
      }, 500);
      killTimer.unref();
      finish(null);
    };

    if (opts.signal) {
      opts.signal.addEventListener("abort", abortHandler, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => {
        killTree("SIGKILL");
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
        } catch {
          // ignore
        }
      }, 1000);
      killTimer.unref();
      finish(null);
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (abortHandler && opts.signal) {
        opts.signal.removeEventListener("abort", abortHandler);
      }
      reject(err);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}
