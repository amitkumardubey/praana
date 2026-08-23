/**
 * Timed process spawn for post-edit verification (#299).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface SpawnTimedResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function commandOnPath(name: string): boolean {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return true;
  }
  return typeof Bun !== "undefined" && name === "bun";
}

export function spawnTimed(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
): Promise<SpawnTimedResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: SpawnTimedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
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
        // already dead
      }
    };

    const timer = setTimeout(() => {
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
      fail(new Error(`timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      fail(err instanceof Error ? err : new Error(String(err)));
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code });
    });
  });
}
