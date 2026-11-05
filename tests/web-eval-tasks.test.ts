import { describe, expect, test } from "bun:test";
import { validateTasks, verifyTask } from "../scripts/web-eval/tasks.js";
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

describe("web eval task validation", () => {
  test("accepts well-formed search and fetch entries", () => {
    expect(validateTasks("search", [search])).toEqual([]);
    expect(validateTasks("fetch", [page])).toEqual([]);
  });
  test("rejects bad domains, empty probes, invalid dates and tiers", () => {
    expect(validateTasks("search", [{ ...search, expected_domains: ["https://example.org"], verified_at: "2026-02-30" }]).length).toBeGreaterThan(0);
    expect(validateTasks("fetch", [{ ...page, probe: "", tier: 4 }]).length).toBeGreaterThan(0);
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
