/**
 * Process spawner for test execution with timeout and abort support.
 */

import { spawn } from "node:child_process";

/** Max chars captured per stream before truncation (512 KB). */
export const MAX_CAPTURE_CHARS = 512 * 1024;

export interface SpawnTestResult {
  stdout: string;
  stderr: string;
  code: number | null;
  duration_ms: number;
  timedOut?: boolean;
  aborted?: boolean;
  truncatedStdout?: boolean;
  truncatedStderr?: boolean;
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
    let truncatedStdout = false;
    let truncatedStderr = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const appendCapped = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (target === "stdout") {
        if (stdout.length >= MAX_CAPTURE_CHARS) return;
        stdout += chunk.toString("utf-8");
        if (stdout.length > MAX_CAPTURE_CHARS) {
          stdout = stdout.slice(0, MAX_CAPTURE_CHARS);
          truncatedStdout = true;
        }
      } else {
        if (stderr.length >= MAX_CAPTURE_CHARS) return;
        stderr += chunk.toString("utf-8");
        if (stderr.length > MAX_CAPTURE_CHARS) {
          stderr = stderr.slice(0, MAX_CAPTURE_CHARS);
          truncatedStderr = true;
        }
      }
    };

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
        truncatedStdout: truncatedStdout ? true : undefined,
        truncatedStderr: truncatedStderr ? true : undefined,
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
      appendCapped("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendCapped("stderr", chunk);
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
