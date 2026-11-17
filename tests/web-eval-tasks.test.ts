import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBotWallTask, validateTasks, verifyTask, type FetchTask } from "../scripts/web-eval/tasks.js";
import { fetchPage } from "../scripts/web-eval/verify.js";

const search = {
  query: "typescript satisfies operator",
  authoritative_url: "https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html",
  expected_domains: ["typescriptlang.org"],
  answer_snippets: ["satisfies"],
  niche: "docs",
  verified_at: "2026-01-01",
};
const page = { url: "https://example.org/doc", probe: "Real documentation", tier: 1, verified_at: "2026-01-01" };
const wall = { url: "https://example.org/wall", probe: "Just a moment...", tier: 3, observed_status: 403, verified_at: "2026-01-01" };

const root = join(import.meta.dir, "..");
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));
const committedSearch = readJson("scripts/web-eval/tasks/search.json") as typeof search[];
const committedFetch = readJson("scripts/web-eval/tasks/fetch.json") as (typeof page | typeof wall)[];
const jsonSchema = readJson("scripts/web-eval/tasks/schema.json") as {
  anyOf: { items: { properties: Record<string, unknown>; required: string[] } }[];
};

describe("web eval task validation", () => {
  test("accepts well-formed search and fetch entries", () => {
    expect(validateTasks("search", [search])).toEqual([]);
    expect(validateTasks("fetch", [page])).toEqual([]);
    expect(validateTasks("fetch", [wall])).toEqual([]);
  });
  test("rejects bad domains, empty probes, invalid dates and tiers", () => {
    expect(validateTasks("search", [{ ...search, expected_domains: ["https://example.org"], verified_at: "2026-02-30" }]).length).toBeGreaterThan(0);
    expect(validateTasks("fetch", [{ ...page, probe: "", tier: 4 }]).length).toBeGreaterThan(0);
  });
  test("requires observed_status on bot-wall probes and only there", () => {
    const { observed_status: _omitted, ...wallWithoutStatus } = wall;
    expect(validateTasks("fetch", [wallWithoutStatus])).not.toEqual([]);
    expect(validateTasks("fetch", [{ ...page, observed_status: 200 }])).not.toEqual([]);
    expect(isBotWallTask(wall as FetchTask)).toBe(true);
    expect(isBotWallTask(page as FetchTask)).toBe(false);
  });
  test("rejects a non-array task set", () => {
    expect(validateTasks("search", {})).not.toEqual([]);
  });
});

describe("polite verification fetch", () => {
  test("paces redirects and backs off on rate limits", async () => {
    const delays: number[] = [];
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 302, headers: { location: "/next" } });
      if (calls === 2) return new Response(null, { status: 429 });
      return new Response("ok");
    };
    const response = await fetchPage("https://example.org/", fetcher, async ms => { delays.push(ms); });
    expect(await response.text()).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });
});

describe("task verification", () => {
  test("requires every expected substring in the page", () => {
    expect(verifyTask(search, "The satisfies operator is useful")).toEqual([]);
    expect(verifyTask({ ...search, answer_snippets: ["satisfies", "missing"] }, "satisfies")).toEqual(["missing"]);
  });
  test("checks fetch probes case insensitively", () => {
    expect(verifyTask(page, "REAL DOCUMENTATION")).toEqual([]);
    expect(verifyTask(page, "Access denied")).toEqual(["Real documentation"]);
  });
});

describe("committed search task set", () => {
  test("is schema valid and has the required size", () => {
    expect(validateTasks("search", committedSearch)).toEqual([]);
    expect(committedSearch.length).toBe(60);
  });
  test("splits into the required niches", () => {
    const counts = committedSearch.reduce<Record<string, number>>((acc, task) => {
      acc[task.niche] = (acc[task.niche] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ docs: 30, error: 15, release: 10, "version-change": 5 });
  });
  test("has unique queries, HTTP(S) pages and 1-3 snippets each", () => {
    expect(new Set(committedSearch.map(task => task.query)).size).toBe(committedSearch.length);
    for (const task of committedSearch) {
      expect(new URL(task.authoritative_url).protocol).toBe("https:");
      expect(task.answer_snippets.length).toBeGreaterThanOrEqual(1);
      expect(task.answer_snippets.length).toBeLessThanOrEqual(3);
      expect(task.expected_domains.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("committed fetch task set", () => {
  test("is schema valid and has the required size", () => {
    expect(validateTasks("fetch", committedFetch)).toEqual([]);
    expect(committedFetch.length).toBe(30);
    expect(new Set(committedFetch.map(task => task.url)).size).toBe(30);
  });
  test("has 24 normal pages and 6 bot-wall honesty probes", () => {
    const tiers = committedFetch.reduce<Record<number, number>>((acc, task) => {
      acc[task.tier] = (acc[task.tier] ?? 0) + 1;
      return acc;
    }, {});
    expect(tiers).toEqual({ 1: 16, 2: 8, 3: 6 });
    const normal = committedFetch.filter(task => task.tier !== 3);
    expect(normal.length).toBe(24);
    for (const task of normal) expect("observed_status" in task).toBe(false);
    for (const task of committedFetch.filter(task => task.tier === 3)) {
      expect("observed_status" in task).toBe(true);
      const status = (task as typeof wall).observed_status;
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(task.probe.length).toBeGreaterThan(3);
    }
  });
});

describe("json schema mirrors the executable validator", () => {
  test("declares both task shapes with closed objects", () => {
    expect(jsonSchema.anyOf.length).toBe(2);
    for (const branch of jsonSchema.anyOf) {
      expect(branch.items.properties).toBeDefined();
      expect(branch.items.required.length).toBeGreaterThan(0);
    }
    const [searchBranch, fetchBranch] = jsonSchema.anyOf;
    expect(Object.keys(searchBranch.items.properties).sort()).toEqual(
      [...new Set(committedSearch.flatMap(task => Object.keys(task)))].sort(),
    );
    expect(Object.keys(fetchBranch.items.properties).sort()).toEqual(
      [...new Set(committedFetch.flatMap(task => Object.keys(task)))].sort(),
    );
  });
});
