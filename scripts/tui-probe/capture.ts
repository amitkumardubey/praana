import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { finished } from "./analyze";
import { join, resolve } from "node:path";

export interface Sample { timestamp: number; text: string }

export function parseSize(value: string) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match || !Number(match[1]) || !Number(match[2])) throw new Error("Invalid terminal size");
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function turnFinished(busy: boolean, screen: string) {
  const active = /(?:replying|thinking|working)…/i.test(screen);
  return { busy: busy || active, finished: busy && finished(screen) };
}

function tmux(socket: string, ...args: string[]) {
  const result = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error(`tmux ${args[0]}: ${result.stderr}`);
  return result.stdout;
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export const RESERVED_ENV_KEYS = new Set([
  "HOME",
  "PRAANA_HOME",
  "PATH",
  "TERM",
  "OPENAI_API_KEY",
  "PRAANA_NO_UPDATE_CHECK",
]);

export const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function cliArg(args: string[], name: string, fallback?: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const val = args[i + 1];
  if (!val || val.startsWith("--")) {
    throw new Error(`Missing value for flag ${name}`);
  }
  return val;
}

export function collectEnvArgs(args: string[], flag = "--env"): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const val = args[i + 1];
      if (!val || val.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      result.push(val);
    }
  }
  return result;
}

export function buildCaptureCommand(worktree: string, isolatedHome: string, home: string, env: string[] = []): string {
  const envPairs = [
    `HOME=${shellQuote(home)}`,
    "TERM=xterm-256color",
    `PATH=${shellQuote(process.env.PATH ?? "/usr/bin:/bin")}`,
    `PRAANA_HOME=${shellQuote(isolatedHome)}`,
    "PRAANA_NO_UPDATE_CHECK=1",
    "OPENAI_API_KEY=sk-mock",
    ...env.map((entry) => {
      const eq = entry.indexOf("=");
      if (eq <= 0) throw new Error(`Invalid env format, expected KEY=VAL: ${entry}`);
      const k = entry.slice(0, eq);
      const v = entry.slice(eq + 1);
      if (!ENV_KEY_REGEX.test(k)) {
        throw new Error(`Invalid env variable name: ${k}`);
      }
      if (RESERVED_ENV_KEYS.has(k)) {
        throw new Error(`Reserved env variable cannot be overridden: ${k}`);
      }
      return shellQuote(`${k}=${v}`);
    }),
  ];
  return `cd ${shellQuote(resolve(worktree))} && exec env -i ${envPairs.join(" ")} bun src/main.ts`;
}

export function buildCaptureHeader(label: string, size: string, commit: string, achievedHz: number, env: string[] = []): Record<string, unknown> {
  return {
    type: "header",
    label,
    size,
    commit,
    achievedHz,
    env: [...env],
  };
}

export async function capture(worktree: string, label: string, size = "110x40", timeout = 120, outputPath?: string, env: string[] = []) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout");
  const deadline = Date.now() + timeout * 1000;
  const git = spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 });
  if (git.status !== 0) throw new Error(`Cannot determine worktree commit: ${git.stderr}`);
  const commit = git.stdout.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("Invalid label");
  const { width, height } = parseSize(size);
  const home = process.env.HOME!;
  const scratch = join(home, ".cache/probe-scratch");
  const session = `probe-${process.pid}`;
  const socket = join(scratch, `${session}.sock`);
  const isolated = join(home, ".cache/tui-homes", session);
  mkdirSync(join(isolated, ".praana"), { recursive: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(isolated, ".praana/.embedder-consent"), "skip\n");
  writeFileSync(join(isolated, ".praana/config.toml"), '[llm]\nprovider = "openai"\nmodel = "mock-model"\nbase_url = "http://127.0.0.1:9779/v1"\n');
  let n = 1;
  while (await Bun.file(join(scratch, `${label}-${n}.jsonl`)).exists()) n++;
  const output = outputPath ?? join(scratch, `${label}-${n}.jsonl`);
  mkdirSync(resolve(output, ".."), { recursive: true });
  const command = buildCaptureCommand(worktree, isolated, home, env);
  let interrupted = "";
  const interrupt = (signal: string) => { interrupted = signal; spawnSync("tmux", ["-S", socket, "kill-session", "-t", session], { stdio: "ignore" }); };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    tmux(socket, "new-session", "-d", "-s", session, "-x", String(width), "-y", String(height), command);
    const readyAt = Date.now() + 9000;
    while (!interrupted && Date.now() < Math.min(readyAt, deadline)) {
      await Bun.sleep(Math.min(100, readyAt - Date.now(), deadline - Date.now()));
    }
    if (interrupted) throw new Error(`Capture interrupted by ${interrupted}`);
    if (Date.now() >= deadline) throw new Error(`Capture timed out after ${timeout}s`);
    tmux(socket, "send-keys", "-t", session, "-l", "Please provide the markdown fixture.");
    tmux(socket, "send-keys", "-t", session, "Enter");
    const start = performance.now();
    let busy = false;
    let count = 0;
    let firstTimestamp = 0;
    writeFileSync(output, "");
    while (Date.now() < deadline && !interrupted) {
      const text = tmux(socket, "capture-pane", "-p", "-e", "-t", session);
      const timestamp = performance.now() - start;
      if (!count) firstTimestamp = timestamp;
      appendFileSync(output, JSON.stringify({ timestamp, text }) + "\n");
      count++;
      const state = turnFinished(busy, text);
      busy = state.busy;
      if (state.finished) {
        const hz = count > 1 ? (count - 1) * 1000 / (timestamp - firstTimestamp) : 0;
        const header = buildCaptureHeader(label, size, commit, hz, env);
        writeFileSync(output, JSON.stringify(header) + "\n" + readFileSync(output, "utf8"));
        return { output, count, hz };
      }
      // Let signal handlers and an in-process mock service their events between samples.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(interrupted ? `Capture interrupted by ${interrupted}` : `Turn never finished within ${timeout}s; samples retained in ${output}`);
  } finally {
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    spawnSync("tmux", ["-S", socket, "kill-session", "-t", session], { stdio: "ignore" });
    rmSync(isolated, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string, fallback?: string) => cliArg(args, name, fallback);
  const worktree = arg("--worktree");
  if (!worktree) throw new Error("--worktree is required");
  const env = collectEnvArgs(args, "--env");
  console.log(await capture(worktree, arg("--label", "capture")!, arg("--size", "110x40")!, Number(arg("--timeout", "120")), undefined, env));
}
