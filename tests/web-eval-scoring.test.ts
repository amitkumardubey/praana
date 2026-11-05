import { describe, expect, test } from "bun:test";
import { rate, scoreFetch, scoreSearch, latencyStats } from "../scripts/web-eval/scoring.js";
import { buildReport, renderMarkdown, reportJson } from "../scripts/web-eval/report.js";
import type { SearchOutcome, FetchOutcome } from "../scripts/web-eval/runners/base.js";
import type { FetchTask, SearchTask } from "../scripts/web-eval/tasks.js";

const task: SearchTask = { query: "fixture", authoritative_url: "https://example.org/docs", expected_domains: ["example.org"], answer_snippets: ["fixture option"], niche: "docs", verified_at: "2026-01-01" };
const search = (patch: Partial<SearchOutcome> = {}): SearchOutcome => ({ ok: true, results: [], latencyMs: 10, tokens: 20, ...patch });
const page = (tier: 1 | 2 | 3): FetchTask => ({ url: `https://example.org/${tier}`, probe: "Real documentation", tier, verified_at: "2026-01-01" });
const fetched = (patch: Partial<FetchOutcome> = {}): FetchOutcome => ({ ok: true, content: "Real documentation", latencyMs: 20, tokens: 10, ...patch });

describe("web eval confidence and distribution helpers", () => {
  test("Wilson intervals have valid edges, n=0 is unknown rather than zero", () => {
    expect(rate(0, 0)).toEqual({ hits: 0, n: 0, value: null, interval: null });
    expect(rate(0, 1).interval![0]).toBeCloseTo(0);
    expect(rate(0, 1).interval![1]).toBeCloseTo(0.79345, 4);
    expect(rate(1, 1).interval![0]).toBeCloseTo(0.20655, 4);
    expect(rate(5, 10).interval).toEqual([expect.closeTo(0.23659, 4), expect.closeTo(0.76341, 4)]);
  });
  test("median averages middle pair and p90 is nearest rank", () => {
    expect(latencyStats([1, 4, 2, 3])).toEqual({ n: 4, median: 2.5, p90: 4 });
    expect(latencyStats([])).toEqual({ n: 0, median: null, p90: null });
  });
});

describe("search scoring with hand-made inputs", () => {
  test("top-five recall is domain-boundary safe; snippet precision uses snippets only", () => {
    const rows = [
      { url: "https://docs.example.org/a", title: "docs", snippet: "A FIXTURE OPTION" },
      { url: "https://example.org.evil.com/a", title: "fixture option", snippet: "unrelated" },
      { url: "https://notexample.org/a", title: "fixture option", snippet: "unrelated" },
      { url: "bad-url", title: "", snippet: "unrelated" },
      { url: "https://other.org/a", title: "", snippet: "unrelated" },
      { url: "https://example.org/a", title: "", snippet: "fixture option" },
    ];
    const samples = [{ runner: "fake", task, outcome: search({ results: rows }) }, { runner: "fake", task, outcome: search({ results: rows.slice(1) }) }];
    // Second sample's fifth result is the old sixth: recall hit, precision 1/5.
    const score = scoreSearch(samples);
    expect(score.recallAt5).toMatchObject({ hits: 2, n: 2, value: 1 });
    expect(score.answerInSnippetPrecision).toMatchObject({ hits: 2, n: 10, value: 0.2 });
    const noHit = scoreSearch([{ runner: "fake", task, outcome: search({ results: rows.slice(1, 5) }) }]);
    expect(noHit.recallAt5.value).toBe(0);
    expect(noHit.answerInSnippetPrecision.value).toBe(0);
  });
  test("coverage, weak/empty honesty, failures and skipped denominators are explicit", () => {
    const samples = [
      search(), search({ results: [{ url: "https://other.org", title: "", snippet: "weak" }] }),
      search({ ok: false, error_kind: "rate_limited" }),
      search({ skipped: "no key", ok: false }),
    ].map(outcome => ({ runner: "fake", task, outcome }));
    const score = scoreSearch(samples);
    expect(score).toMatchObject({ n: 3, skipped: 1, coverage: { hits: 1, n: 3 }, weakEmptyHonesty: { hits: 2, n: 3 }, failureRate: { hits: 1, n: 3 }, rateLimitRate: { hits: 1, n: 3 } });
    expect(score.tokensPerQuery).toEqual({ n: 3, value: 20 });
    expect(score.latencyMs.n).toBe(3);
  });
});

describe("fetch scoring with independent probe oracle", () => {
  test("retrieval ignores success claims, weights tiers once and measures false positives", () => {
    const samples = [
      { runner: "fake", task: page(1), outcome: fetched() },
      { runner: "fake", task: page(2), outcome: fetched({ ok: false }) },
      { runner: "fake", task: page(3), outcome: fetched({ content: "Verify you are human", tokens: 20 }) },
      { runner: "fake", task: page(3), outcome: fetched({ ok: false, content: "", error_kind: "blocked" }) },
    ];
    const score = scoreFetch(samples);
    expect(score.retrieval).toMatchObject({ hits: 2, n: 4, value: 0.5 });
    expect(score.tiers[1].value).toBe(1);
    expect(score.tiers[2].value).toBe(1);
    expect(score.tiers[3].value).toBe(0);
    expect(score.weighted).toMatchObject({ n: 4, weightedN: 9, value: 3 / 9 });
    expect(score.honesty).toMatchObject({ tp: 1, fp: 1, tn: 1, fn: 1, falsePositiveRate: { hits: 1, n: 2, value: 0.5 }, botWallFalsePositiveRate: { hits: 1, n: 2, value: 0.5 } });
    expect(score.tokensPerSuccess).toEqual({ n: 2, value: 25 });
  });
  test("missing probes are not automatically called observed bot walls", () => {
    const score = scoreFetch([{ runner: "fake", task: page(1), outcome: fetched({ content: "wrong page" }) }]);
    expect(score.honesty.falsePositiveRate.value).toBe(1);
    expect(score.honesty.botWallFalsePositiveRate.value).toBeNull();
    expect(score.tokensPerSuccess.value).toBeNull();
  });
  test("bot walls mentioning the probe cannot pass retrieval", () => {
    const score = scoreFetch([{ runner: "fake", task: page(3), outcome: fetched({ content: "Verify you are human. Real documentation" }) }]);
    expect(score.retrieval.value).toBe(0);
  });
  test("empty/skipped samples remain unknown, credits never silently become zero", () => {
    const score = scoreFetch([{ runner: "fake", task: page(1), outcome: fetched({ ok: false, skipped: "no key" }) }]);
    expect(score.retrieval.value).toBeNull();
    expect(score.weighted.value).toBeNull();
    expect(score.credits).toMatchObject({ reportedN: 0, unknownN: 0, total: null });
    expect(scoreFetch([{ runner: "fake", task: page(1), outcome: fetched({ credits: 2 }) }]).credits.total).toBe(2);
  });
});

test("JSON and markdown reports preserve sample sizes, confidence and skipped runners without ranking", () => {
  const report = buildReport({ createdAt: "2026-01-01T00:00:00Z", search: [{ runner: "fake|runner", task, outcome: search() }], fetch: [], runners: [{ id: "no-key", skipped: "no key" }] });
  expect(JSON.parse(reportJson(report))).toEqual(report);
  const markdown = renderMarkdown(report);
  expect(markdown).toContain("Wilson 95%");
  expect(markdown).toContain("n=1");
  expect(markdown).toContain("fake\\|runner");
  expect(markdown).toContain("no key");
  expect(markdown).toContain("No ranking");
});
