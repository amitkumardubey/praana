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
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: SpawnTimedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 500).unref();
      reject(new Error(`timed out after ${opts.timeoutMs}ms`));
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
      reject(err);
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code });
    });
  });
}
