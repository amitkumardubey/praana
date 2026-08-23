/**
 * Affected-test selection and runner for post-edit verification (#299).
 */

import { basename } from "node:path";
import { resolveLspRoot } from "../lsp/workspace-roots.js";
import {
  ImportGraphCache,
  buildReverseImportGraph,
  type ListImportsFn,
  type ReverseImportGraph,
} from "./import-graph.js";
import { commandOnPath, spawnTimed } from "./spawn.js";
import type { TestFailure, TestsResult } from "./types.js";

const TEST_NAME = /\.(test|spec)\./i;
const FAIL_LINE = /^\(fail\)\s+(.+?)(?:\s+\[[^\]]+\])?\s*$/;
const FILE_HEADER = /^(\S.+):\s*$/;

export type RunTestsFn = (
  files: string[],
  timeoutMs: number,
) => Promise<TestsResult>;

export interface RunAffectedTestsOpts {
  listImports?: ListImportsFn | null;
  runTests?: RunTestsFn;
  graph?: ReverseImportGraph;
  graphCache?: ImportGraphCache;
  maxTestFiles?: number;
  timeoutMs?: number;
  bunAvailable?: boolean;
}

export function isTestFile(path: string): boolean {
  return TEST_NAME.test(basename(path));
}

export function selectAffectedTests(
  changedPath: string,
  graph: ReverseImportGraph,
): string[] {
  const selected = new Set<string>();
  if (isTestFile(changedPath)) selected.add(changedPath);

  const queue = [changedPath];
  const seen = new Set<string>([changedPath]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const importer of graph.importers.get(current) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
      if (isTestFile(importer)) selected.add(importer);
    }
  }
  return [...selected].sort();
}

export async function runAffectedTests(
  changedPath: string,
  sessionRoot: string,
  opts: RunAffectedTestsOpts = {},
): Promise<TestsResult> {
  return runAffectedTestsForPaths([changedPath], sessionRoot, opts);
}

export async function runAffectedTestsForPaths(
  changedPaths: string[],
  sessionRoot: string,
  opts: RunAffectedTestsOpts = {},
): Promise<TestsResult> {
  const selected = new Set<string>();
  let truncated = false;
  for (const changedPath of changedPaths) {
    const root = resolveLspRoot(changedPath, sessionRoot);
    const graph =
      opts.graph ??
      opts.graphCache?.get(root, {
        listImports: opts.listImports,
      }) ??
      buildReverseImportGraph(root, { listImports: opts.listImports });
    if (graph.truncated) truncated = true;
    for (const file of selectAffectedTests(changedPath, graph)) {
      selected.add(file);
    }
  }

  const extra: Pick<TestsResult, "graph_truncated"> = {};
  if (truncated) extra.graph_truncated = true;

  if (selected.size === 0) {
    return { ...extra, skipped: "none_affected" };
  }

  const files = [...selected].sort();
  const max = opts.maxTestFiles ?? 20;
  if (files.length > max) {
    return { ...extra, skipped: "too_many", files: files.slice(0, max) };
  }

  const bunOk = opts.bunAvailable ?? commandOnPath("bun");
  const run = opts.runTests ?? (bunOk ? defaultRunTests : undefined);
  if (!run) {
    return { ...extra, skipped: "no_runner", files };
  }

  try {
    const spawned = await run(files, opts.timeoutMs ?? 30_000);
    return {
      ...extra,
      ...spawned,
      files: spawned.files ?? files,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timed? ?out/i.test(msg)) {
      return { ...extra, skipped: "timeout", files };
    }
    return { ...extra, skipped: "spawn_error", files };
  }
}

export function parseBunTestOutput(text: string): TestsResult {
  let passed = 0;
  let failed = 0;
  let currentFile = "";
  const failures: TestFailure[] = [];
  const files: string[] = [];

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const header = line.match(FILE_HEADER);
    if (header && /\.(test|spec)\./i.test(header[1] ?? "")) {
      currentFile = header[1] ?? "";
      if (currentFile && !files.includes(currentFile)) files.push(currentFile);
      continue;
    }
    if (/^\(pass\)/.test(line)) {
      passed += 1;
      continue;
    }
    const fail = line.match(FAIL_LINE);
    if (fail) {
      failed += 1;
      let message = "";
      for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
        const next = lines[j] ?? "";
        if (/^\((pass|fail)\)/.test(next) || FILE_HEADER.test(next)) break;
        if (next.trim()) {
          message = next.trim();
          break;
        }
      }
      failures.push({
        name: fail[1]?.trim() ?? "fail",
        file: currentFile,
        message,
      });
    }
  }

  return { passed, failed, files, failures };
}

export async function defaultRunTests(
  files: string[],
  timeoutMs: number,
): Promise<TestsResult> {
  const spawned = await spawnTimed("bun", ["test", ...files], {
    timeoutMs,
  });
  const parsed = parseBunTestOutput(`${spawned.stdout}\n${spawned.stderr}`);
  if (
    parsed.failed === 0 &&
    spawned.code !== 0 &&
    spawned.code !== null
  ) {
    return {
      passed: parsed.passed,
      failed: 1,
      files,
      failures: [
        {
          name: "bun test",
          file: files[0] ?? "",
          message: "runner exited non-zero",
        },
      ],
    };
  }
  return {
    passed: parsed.passed,
    failed: parsed.failed,
    files,
    failures: parsed.failures,
  };
}
