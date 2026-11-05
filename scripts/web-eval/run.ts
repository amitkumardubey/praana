import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fetchTaskSchema, searchTaskSchema, type FetchTask, type SearchTask } from "./tasks.js";
import { failure, skippedFetch, skippedSearch, type Outcome, type Runner, type RunnerDeps } from "./runners/base.js";
import { KEY_ENV_NAMES, runnerFactories, type RunnerFactory } from "./runners/index.js";
import { createPoliteTransport, type PoliteOptions } from "./polite.js";
import { buildReport, renderMarkdown, reportJson } from "./report.js";
import type { FetchSample, SearchSample } from "./scoring.js";

class CliError extends Error {}
export interface RunOptions { only?: string; dryRun: boolean; maxRequests: number }
export interface CliOptions extends RunOptions { tasksDir: string; outDir: string; help?: boolean }
export interface TaskSets { search: SearchTask[]; fetch: FetchTask[] }
export interface EvalDeps extends Omit<PoliteOptions, "maxRequests"> {
  env?: RunnerDeps["env"];
  factories?: RunnerFactory[];
  log?: (message: string) => void;
}
export const KEYLESS_NOTICE = "Keyless endpoints are rate limited per IP. No keyless retries; HTTP or in-band rate/server errors stop the backend for this run. Review Terms check before live use.";
const USAGE = "bun scripts/web-eval/run.ts [--only <runner>] [--dry-run] [--max-requests N] [--tasks <dir>] [--out <dir>]";

export function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = { dryRun: false, maxRequests: 100, tasksDir: fileURLToPath(new URL("./tasks", import.meta.url)), outDir: fileURLToPath(new URL("./results", import.meta.url)) };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--only", "--dry-run", "--max-requests", "--tasks", "--out", "--help"].includes(flag)) throw new CliError("Unknown option; use --help");
    if (seen.has(flag)) throw new CliError("Duplicate option");
    seen.add(flag);
    if (flag === "--help") { result.help = true; continue; }
    if (flag === "--dry-run") { result.dryRun = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new CliError("Missing option value");
    if (flag === "--only") result.only = value;
    else if (flag === "--tasks") result.tasksDir = resolve(value);
    else if (flag === "--out") result.outDir = resolve(value);
    else {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError("Request budget must be a non-negative safe integer");
      result.maxRequests = Number(value);
    }
  }
  return result;
}

export async function loadTasks(dir: string): Promise<TaskSets> {
  let search: unknown, fetch: unknown;
  try {
    search = JSON.parse(await readFile(join(dir, "search.json"), "utf8"));
    fetch = JSON.parse(await readFile(join(dir, "fetch.json"), "utf8"));
  } catch { throw new CliError("Cannot load task files; expected JSON search.json and fetch.json"); }
  const searches = z.array(searchTaskSchema).safeParse(search);
  if (!searches.success) throw new CliError("Invalid search tasks (see tasks/schema.json)");
  const fetches = z.array(fetchTaskSchema).safeParse(fetch);
  if (!fetches.success) throw new CliError("Invalid fetch tasks (see tasks/schema.json)");
  return { search: searches.data, fetch: fetches.data };
}

/** Final defence against a backend echoing credentials inside successful content. */
function redact<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") {
    let text: string = value;
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text as T;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)])) as T;
  return value;
}

export async function runEvaluation(tasks: TaskSets, options: RunOptions, deps: EvalDeps = {}) {
  const transport = createPoliteTransport({ ...deps, maxRequests: options.maxRequests });
  const env = deps.env ?? process.env;
  const all = (deps.factories ?? runnerFactories).map(factory => {
    let runner!: Runner;
    runner = factory({ env, now: deps.now, request: (url, init) => transport.forBackend(runner.backend, runner.keyless)(url, init) });
    return runner;
  });
  if (options.only && !all.some(r => r.id === options.only)) throw new CliError("Unknown runner; see README runner list");
  const runners = options.only ? all.filter(r => r.id === options.only) : all;
  const plan = runners.map(r => ({ runner: r.id, searchTasks: r.search ? tasks.search.length : 0, fetchTasks: r.fetch ? tasks.fetch.length : 0, skipped: r.skipped ?? null }));
  const search: SearchSample[] = [], fetch: FetchSample[] = [];
  const keylessStopped = new Map<string, string>();
  const skipReason = (runner: Runner) => runner.skipped
    ?? (runner.keyless ? keylessStopped.get(runner.backend) : undefined)
    ?? (transport.used >= options.maxRequests ? "request budget exhausted" : undefined);
  function observe(runner: Runner, outcome: Outcome) {
    // MCP often transports tool errors inside a successful HTTP 200 response.
    if (runner.keyless && (outcome.error_kind === "rate_limited" || outcome.error_kind === "server_error")) {
      keylessStopped.set(runner.backend, `backend stopped after ${outcome.error_kind}`);
    }
  }
  // Global sequential execution is stronger than per-backend concurrency=1. In
  // particular, no second tool call starts while a response body is still read.
  if (!options.dryRun) for (const runner of runners) {
    if (runner.search) for (const task of tasks.search) {
      let outcome;
      const reason = skipReason(runner);
      try { outcome = reason ? skippedSearch(reason) : await runner.search(task.query, 5); }
      catch (error) { outcome = { ...failure(error, 0), results: [] }; }
      observe(runner, outcome);
      search.push({ runner: runner.id, task, outcome });
    }
    if (runner.fetch) for (const task of tasks.fetch) {
      let outcome;
      const reason = skipReason(runner);
      try { outcome = reason ? skippedFetch(reason) : await runner.fetch(task.url, 20_000); }
      catch (error) { outcome = { ...failure(error, 0), content: "" }; }
      observe(runner, outcome);
      fetch.push({ runner: runner.id, task, outcome });
    }
  }
  const report = buildReport({ createdAt: new Date().toISOString(), dryRun: options.dryRun,
    requests: { budget: options.maxRequests, used: transport.used, attempts: transport.attempts },
    taskDigest: createHash("sha256").update(JSON.stringify(tasks)).digest("hex"),
    runners: runners.map(r => ({ id: r.id, ...(r.skipped ? { skipped: r.skipped } : {}) })),
    plan, search, fetch,
  });
  const secrets = KEY_ENV_NAMES.flatMap(name => {
    const value = env[name];
    return value ? [value, value.trim(), encodeURIComponent(value)].filter(Boolean) : [];
  }).sort((a, b) => b.length - a.length);
  return redact(report, secrets);
}

export async function main(args: string[], deps: EvalDeps = {}): Promise<void> {
  const options = parseArgs(args);
  const log = deps.log ?? console.log;
  if (options.help) { log(USAGE); return; }
  log(KEYLESS_NOTICE);
  const report = await runEvaluation(await loadTasks(options.tasksDir), options, deps);
  await mkdir(options.outDir, { recursive: true });
  const stem = `${report.createdAt.replace(/[:.]/g, "-")}-${report.dryRun ? "dry-run-" : ""}${randomUUID().slice(0, 8)}`;
  await writeFile(join(options.outDir, `${stem}.json`), reportJson(report), { flag: "wx" });
  await writeFile(join(options.outDir, `${stem}.md`), renderMarkdown(report), { flag: "wx" });
  // Do not print user-controlled paths or arguments, which can contain secrets.
  log(`${report.dryRun ? "Dry run" : "Evaluation"}: ${report.requests!.used}/${options.maxRequests} HTTP requests; JSON and markdown reports written to --out directory.`);
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof CliError ? error.message : "Web evaluation failed (details suppressed to protect credentials)");
    process.exitCode = 1;
  }
}
