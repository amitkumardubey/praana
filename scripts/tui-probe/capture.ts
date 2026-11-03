import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export function parseSize(value: string) {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match || !Number(match[1]) || !Number(match[2])) throw new Error("Invalid terminal size");
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function turnFinished(busy: boolean, screen: string) {
  const active = /(?:replying|thinking|working)…/i.test(screen);
  return { busy: busy || active, finished: busy && !active };
}

function tmux(socket: string, ...args: string[]) {
  const result = spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tmux ${args[0]}: ${result.stderr}`);
  return result.stdout;
}

export async function capture(worktree: string, label: string, size = "110x40", timeout = 120) {
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
  const output = join(scratch, `${label}-${n}.jsonl`);
  const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const command = `cd ${shellQuote(resolve(worktree))} && exec env -i HOME=${shellQuote(home)} TERM=xterm-256color PATH=${shellQuote(process.env.PATH ?? "/usr/bin:/bin")} PRAANA_HOME=${shellQuote(isolated)} PRAANA_NO_UPDATE_CHECK=1 OPENAI_API_KEY=sk-mock bun src/main.ts`;
  try {
    tmux(socket, "new-session", "-d", "-s", session, "-x", String(width), "-y", String(height), command);
    await Bun.sleep(9000);
    tmux(socket, "send-keys", "-t", session, "-l", "Please provide the markdown fixture.");
    tmux(socket, "send-keys", "-t", session, "Enter");
    const start = performance.now();
    let busy = false;
    let count = 0;
    writeFileSync(output, "");
    while ((performance.now() - start) / 1000 < timeout) {
      const text = tmux(socket, "capture-pane", "-p", "-e", "-t", session);
      const timestamp = performance.now() - start;
      appendFileSync(output, JSON.stringify({ timestamp, text }) + "\n");
      count++;
      const state = turnFinished(busy, text);
      busy = state.busy;
      if (state.finished) return { output, count, hz: count * 1000 / timestamp };
    }
    throw new Error(`Timed out after ${timeout}s; samples retained in ${output}`);
  } finally {
    spawnSync("tmux", ["-S", socket, "kill-session", "-t", session], { stdio: "ignore" });
    rmSync(isolated, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = (name: string, fallback?: string) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
  const worktree = arg("--worktree");
  if (!worktree) throw new Error("--worktree is required");
  console.log(await capture(worktree, arg("--label", "capture"), arg("--size", "110x40"), Number(arg("--timeout", "120"))));
}
