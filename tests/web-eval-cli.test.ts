import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, loadTasks, runEvaluation, main } from "../scripts/web-eval/run.js";
import { createPoliteTransport } from "../scripts/web-eval/polite.js";
import { createLocalFetchRunner } from "../scripts/web-eval/runners/local-fetch.js";
import { createExaMcpRunner } from "../scripts/web-eval/runners/exa-mcp.js";
import { createTavilyRunner } from "../scripts/web-eval/runners/tavily.js";
import { readResponse, searchOutcome, type RunnerDeps, type Runner } from "../scripts/web-eval/runners/base.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/web-eval", import.meta.url));
function clock() {
  let time = 0;
  const delays: number[] = [];
  return { now: () => time, delays, sleep: async (ms: number) => { delays.push(ms); time += ms; } };
}
const fake = (deps: RunnerDeps): Runner => ({
  id: "fake", backend: "fake", keyless: false,
  search: (query, n) => searchOutcome(deps, async () => {
    const { text } = await readResponse(deps, "https://fixture.invalid/search");
    return { results: [{ url: "https://example.org/docs", title: query, snippet: text }] };
  }, n),
});
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("polite transport with fake time and no network", () => {
  test("serializes one backend and spaces HTTP starts at least one second", async () => {
    const c = clock(), starts: number[] = [];
    let active = 0, maxActive = 0;
    const transport = createPoliteTransport({ ...c, maxRequests: 3, request: async () => {
      starts.push(c.now()); active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve(); active--;
      return new Response("ok");
    } });
    const request = transport.forBackend("same", false);
    await Promise.all([request("https://example.org"), request("https://example.org"), request("https://example.org")]);
    expect(starts).toEqual([0, 1000, 2000]);
    expect(maxActive).toBe(1);
    expect(transport.used).toBe(3);
  });
  test("also spaces requests when switching backends", async () => {
    const c = clock(), starts: number[] = [];
    const t = createPoliteTransport({ ...c, maxRequests: 2, request: async () => { starts.push(c.now()); return new Response("ok"); } });
    await t.forBackend("first", true)("https://example.org");
    await t.forBackend("second", true)("https://example.org");
    expect(starts).toEqual([0, 1000]);
  });
  test("keyed 429/5xx use bounded exponential backoff and honor Retry-After", async () => {
    const c = clock(), starts: number[] = [];
    let calls = 0;
    const t = createPoliteTransport({ ...c, maxRequests: 10, request: async () => {
      starts.push(c.now()); calls++;
      return new Response("", { status: calls === 1 ? 429 : calls === 2 ? 503 : 200, headers: calls === 1 ? { "retry-after": "3" } : {} });
    } });
    expect((await t.forBackend("keyed", false)("https://example.org")).status).toBe(200);
    expect(starts).toEqual([0, 3000, 7000]);
    expect(t.attempts.map(a => a.status)).toEqual([429, 503, 200]);
  });
  test("keyless failures are never retried and stop later keyless traffic on that backend", async () => {
    for (const status of [429, 503]) {
      let calls = 0;
      const t = createPoliteTransport({ ...clock(), maxRequests: 100, request: async () => { calls++; return new Response("", { status }); } });
      const request = t.forBackend("keyless", true);
      expect((await request("https://example.org")).status).toBe(status);
      await expect(request("https://example.org")).rejects.toThrow("backend stopped");
      expect(calls).toBe(1);
    }
  });
  test("budgets include retries and redirects, never leak credentials across origins", async () => {
    const t = createPoliteTransport({ ...clock(), maxRequests: 2, request: async () => new Response("", { status: 503 }) });
    await expect(t.forBackend("keyed", false)("https://example.org")).rejects.toThrow("request budget exhausted");
    expect(t.used).toBe(2);
    const starts: number[] = [], c = clock();
    const redirect = createPoliteTransport({ ...c, maxRequests: 2, request: async () => {
      starts.push(c.now());
      return starts.length === 1 ? new Response(null, { status: 302, headers: { location: "/docs" } }) : new Response("ok");
    } });
    expect((await redirect.forBackend("local", true)("https://example.org")).status).toBe(200);
    expect(starts).toEqual([0, 1000]);
    expect(redirect.attempts.every(attempt => !attempt.error_kind)).toBe(true);
    const unsafe = createPoliteTransport({ ...clock(), maxRequests: 2, request: async () => new Response(null, { status: 302, headers: { location: "https://other.org" } }) });
    await expect(unsafe.forBackend("keyed", false)("https://example.org", { headers: { Authorization: "Bearer placeholder" } })).rejects.toThrow();
    expect(unsafe.used).toBe(1);
  });
  test("timeouts and 401 are not retried", async () => {
    let calls = 0;
    const t = createPoliteTransport({ ...clock(), maxRequests: 10, request: async () => { calls++; throw new DOMException("private", "TimeoutError"); } });
    await expect(t.forBackend("backend", false)("https://example.org")).rejects.toThrow();
    expect(calls).toBe(1);
    const auth = createPoliteTransport({ ...clock(), maxRequests: 10, request: async () => new Response("", { status: 401 }) });
    expect((await auth.forBackend("backend", false)("https://example.org")).status).toBe(401);
    expect(auth.used).toBe(1);
  });
});

describe("offline evaluation CLI", () => {
  test("parses requested flags, rejects unknown/missing/unsafe numeric values", () => {
    expect(parseArgs(["--only", "fake", "--dry-run", "--max-requests", "0", "--tasks", fixtureDir, "--out", "/tmp/out"])).toMatchObject({ only: "fake", dryRun: true, maxRequests: 0, tasksDir: fixtureDir, outDir: "/tmp/out" });
    for (const args of [["--oops"], ["--only"], ["--max-requests", "-1"], ["--max-requests", "1.5"], ["--max-requests", "Infinity"], ["--max-requests", "9007199254740992"], ["--only", "fake", "--only", "fake"]]) expect(() => parseArgs(args)).toThrow();
  });
  test("task loading validates tiny fixtures and rejects malformed files offline", async () => {
    const tasks = await loadTasks(fixtureDir);
    expect(tasks.search.length).toBe(1);
    expect(tasks.fetch.length).toBe(3);
    const dir = await mkdtemp(join(tmpdir(), "webeval-invalid-")); dirs.push(dir);
    await Bun.write(join(dir, "search.json"), "{}");
    await Bun.write(join(dir, "fetch.json"), "[]");
    await expect(loadTasks(dir)).rejects.toThrow("Invalid search tasks");
  });
  test("fake fetch outcomes distinguish challenge, honest block and real content", async () => {
    const tasks = await loadTasks(fixtureDir);
    tasks.fetch = tasks.fetch.filter(task => task.tier === 3);
    const outcomes = [
      { ok: true, content: "Just a moment...", latencyMs: 1, tokens: 4 },
      { ok: false, content: "Just a moment...", error_kind: "blocked" as const, latencyMs: 1, tokens: 4 },
      { ok: true, content: "Actual page content", latencyMs: 1, tokens: 4 },
    ];
    const runner = (): Runner => ({ id: "fake-fetch", backend: "fake-fetch", keyless: false, fetch: async () => outcomes.shift()! });
    const scores = [];
    for (let i = 0; i < 3; i++) {
      const report = await runEvaluation(tasks, { dryRun: false, maxRequests: 10 }, { ...clock(), env: {}, factories: [runner], request: async () => { throw new Error("Network forbidden"); } });
      scores.push(report.scores[0].fetch);
    }
    expect(scores.map(s => [s.retrieval.hits, s.honesty.tp, s.honesty.fp, s.honesty.tn, s.honesty.botWallFalsePositiveRate.n])).toEqual([
      [0, 0, 1, 0, 1], [0, 0, 0, 1, 1], [1, 1, 0, 0, 0],
    ]);
  });
  test("dry-run plans without calls, only filter works, missing keys skip", async () => {
    const tasks = await loadTasks(fixtureDir);
    let calls = 0;
    const deps = { ...clock(), env: {}, factories: [fake, createLocalFetchRunner, createTavilyRunner], request: async () => { calls++; throw new Error("Network forbidden"); } };
    const report = await runEvaluation(tasks, { only: "fake", dryRun: true, maxRequests: 10 }, deps);
    expect(calls).toBe(0);
    expect(report.plan).toEqual([{ runner: "fake", searchTasks: 1, fetchTasks: 0, skipped: null }]);
    expect(report.requests?.used).toBe(0);
    const skipped = await runEvaluation(tasks, { only: "tavily", dryRun: false, maxRequests: 10 }, deps);
    expect(skipped.scores[0].skipped).toBe("no key");
    expect(skipped.search[0].outcome.skipped).toBe("no key");
    expect(calls).toBe(0);
    await expect(runEvaluation(tasks, { only: "unknown", dryRun: true, maxRequests: 10 }, deps)).rejects.toThrow("Unknown runner");
  });
  test("global budget spans backends and counts MCP initialize/notification/tool requests", async () => {
    const tasks = await loadTasks(fixtureDir);
    let calls = 0;
    const report = await runEvaluation(tasks, { dryRun: false, maxRequests: 2 }, { ...clock(), env: {}, factories: [fake, createExaMcpRunner], request: async (_url, init) => {
      calls++;
      if (calls === 1) return new Response("fixture option");
      const body = JSON.parse(String(init?.body));
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
    } });
    expect(calls).toBe(2);
    expect(report.requests?.used).toBe(2);
    expect(report.search[0].outcome.ok).toBe(true);
    expect(report.search[1].outcome.skipped).toBe("request budget exhausted");
  });
  test("in-band MCP rate limits stop later keyless tool calls even with HTTP 200", async () => {
    const tasks = await loadTasks(fixtureDir);
    tasks.search.push({ ...tasks.search[0], query: "second fixture query" });
    const report = await runEvaluation(tasks, { dryRun: false, maxRequests: 10 }, { ...clock(), env: {}, factories: [createExaMcpRunner], request: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "Rate limit exceeded" }] } });
    } });
    expect(report.requests?.used).toBe(3);
    expect(report.search[0].outcome.error_kind).toBe("rate_limited");
    expect(report.search[1].outcome.skipped).toBe("backend stopped after rate_limited");
  });
  test("real orchestration uses fake runner and redacts env secrets echoed by a backend", async () => {
    const report = await runEvaluation(await loadTasks(fixtureDir), { dryRun: false, maxRequests: 10 }, { ...clock(), factories: [fake], env: { TAVILY_API_KEY: "test-only-secret" }, request: async () => new Response("fixture option test-only-secret") });
    expect(report.scores[0].search.recallAt5.value).toBe(1);
    expect(JSON.stringify(report)).not.toContain("test-only-secret");
    expect(report.taskDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  test("main writes JSON and markdown and prints the per-IP notice, entirely offline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webeval-out-")); dirs.push(dir);
    const logs: string[] = [];
    await main(["--tasks", fixtureDir, "--out", dir, "--only", "fake", "--dry-run"], { ...clock(), factories: [fake], env: {}, request: async () => { throw new Error("Network forbidden"); }, log: text => logs.push(text) });
    const files = await readdir(dir);
    expect(files.filter(f => f.endsWith(".json")).length).toBe(1);
    expect(files.filter(f => f.endsWith(".md")).length).toBe(1);
    expect(logs.join("\n")).toContain("rate limited per IP");
    expect(JSON.parse(await Bun.file(join(dir, files.find(f => f.endsWith(".json"))!)).text()).dryRun).toBe(true);
  });
});
