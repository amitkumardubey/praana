import { describe, expect, test } from "bun:test";
import recordings from "./fixtures/web-eval/responses.json" with { type: "json" };
import { createTavilyRunner, createTavilyKeylessRunner } from "../scripts/web-eval/runners/tavily.js";
import { createBraveRunner } from "../scripts/web-eval/runners/brave.js";
import { createExaRunner } from "../scripts/web-eval/runners/exa.js";
import { createFirecrawlRunner } from "../scripts/web-eval/runners/firecrawl.js";
import { createExaMcpRunner } from "../scripts/web-eval/runners/exa-mcp.js";
import { createParallelMcpRunner } from "../scripts/web-eval/runners/parallel-mcp.js";
import { createFirecrawlMcpRunner } from "../scripts/web-eval/runners/firecrawl-mcp.js";
import type { RunnerDeps } from "../scripts/web-eval/runners/base.js";

const env = { TAVILY_API_KEY: "test-placeholder", BRAVE_API_KEY: "test-placeholder", EXA_API_KEY: "test-placeholder", FIRECRAWL_API_KEY: "fc-test-placeholder" };
const never = async (): Promise<Response> => { throw new Error("Network forbidden"); };

describe("offline API search adapters", () => {
  const cases = [
    [createTavilyRunner, recordings.tavily, "https://api.tavily.com/search"],
    [createBraveRunner, recordings.brave, "https://api.search.brave.com/res/v1/web/search"],
    [createExaRunner, recordings.exa, "https://api.exa.ai/search"],
    [createFirecrawlRunner, recordings.firecrawlSearch, "https://api.firecrawl.dev/v2/search"],
  ] as const;
  for (const [create, recording, endpoint] of cases) {
    test(`${endpoint} parses documented response and constrains requests`, async () => {
      const runner = create({ env, request: async (url, init) => {
        expect(url.startsWith(endpoint)).toBe(true);
        if (init?.body) {
          const body = JSON.parse(String(init.body));
          expect(body.query).toBe("fixture docs");
          expect(body.scrapeOptions).toBeUndefined();
          expect(body.include_raw_content).not.toBe(true);
          expect(body.include_answer).not.toBe(true);
        } else expect(new URL(url).searchParams.get("count")).toBe("5");
        return Response.json(recording);
      } });
      const result = await runner.search!("fixture docs", 5);
      expect(result.ok).toBe(true);
      expect(result.results[0]).toMatchObject({ url: "https://example.org/docs", title: "Fixture docs" });
      expect(result.results[0].snippet).toContain("Real documentation");
      expect(JSON.stringify(result)).not.toContain("test-placeholder");
    });
    test(`${endpoint} skips with no key without making requests`, async () => {
      const runner = create({ env: {}, request: never });
      expect(runner.skipped).toBe("no key");
      expect((await runner.search!("fixture", 5)).skipped).toBe("no key");
    });
    test(`${endpoint} rejects malformed success responses`, async () => {
      const runner = create({ env, request: async () => Response.json({ unexpected: true }) });
      expect(await runner.search!("fixture", 5)).toMatchObject({ ok: false, error_kind: "other" });
    });
  }
  test("Tavily explicit keyless mode does not read/send a key", async () => {
    const runner = createTavilyKeylessRunner({ env, request: async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-tavily-access-mode")).toBe("keyless");
      expect(headers.has("authorization")).toBe(false);
      return Response.json(recordings.tavily);
    } });
    expect((await runner.search!("fixture docs", 5)).ok).toBe(true);
  });
  test("Firecrawl separates scrape, records known credits, leaves unknown credits absent", async () => {
    const runner = createFirecrawlRunner({ env, request: async (url, init) => {
      if (url.endsWith("/search")) return Response.json(recordings.firecrawlSearch);
      expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
      expect(JSON.parse(String(init?.body))).toMatchObject({ url: "https://example.org/docs", formats: ["markdown"] });
      return Response.json(recordings.firecrawlScrape);
    } });
    expect((await runner.search!("fixture docs", 5)).credits).toBe(2);
    const result = await runner.fetch!("https://example.org/docs", 1000);
    expect(result).toMatchObject({ ok: true, content: recordings.firecrawlScrape.data.markdown });
    expect(result.credits).toBeUndefined();
  });
  test("Firecrawl rejects the wrong key prefix without a request", async () => {
    const runner = createFirecrawlRunner({ env: { FIRECRAWL_API_KEY: "wrong-prefix" }, request: never });
    expect(await runner.fetch!("https://example.org", 100)).toMatchObject({ ok: false, error_kind: "invalid_key" });
  });
});

describe("offline hosted MCP adapters", () => {
  function mcpDeps(recording: unknown, assertCall: (body: any) => void, sse = false): RunnerDeps {
    let initialized = false;
    return { env: {}, request: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toContain("text/event-stream");
      if (body.method === "initialize") {
        initialized = true;
        expect(body.params).toMatchObject({ protocolVersion: "2025-03-26", clientInfo: { name: "praana-web-eval", version: "0.1" } });
        return Response.json(recordings.initialize, { headers: { "mcp-session-id": "fixture-session" } });
      }
      expect(initialized).toBe(true);
      expect(headers.get("mcp-session-id")).toBe("fixture-session");
      expect(headers.get("mcp-protocol-version")).toBe("2025-03-26");
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      expect(body.method).toBe("tools/call");
      assertCall(body);
      const reply = { ...(recording as object), id: body.id };
      return sse ? new Response(`event: message\ndata: ${JSON.stringify(reply)}\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(reply);
    } };
  }
  test("Exa initializes once, accepts JSON and SSE, parses official text format", async () => {
    for (const sse of [false, true]) {
      const runner = createExaMcpRunner(mcpDeps(recordings.exaMcp, body => {
        expect(body.params).toEqual({ name: "web_search_exa", arguments: { query: "fixture docs", numResults: 5 } });
      }, sse));
      for (let i = 0; i < 2; i++) {
        expect(await runner.search!("fixture docs", 5)).toMatchObject({ ok: true, results: [{ url: "https://example.org/docs", title: "Fixture docs", snippet: "Real documentation" }] });
      }
    }
  });
  test("Firecrawl hosted keyless search/scrape use separate tools without scraped search content", async () => {
    const recording = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(recordings.firecrawlSearch) }] } };
    const runner = createFirecrawlMcpRunner(mcpDeps(recording, body => {
      expect(body.params).toMatchObject({ name: "firecrawl_search", arguments: { query: "fixture docs", limit: 5 } });
      expect(body.params.arguments.scrapeOptions).toBeUndefined();
    }));
    expect(await runner.search!("fixture docs", 5)).toMatchObject({ ok: true, credits: 2 });
    const scrape = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(recordings.firecrawlScrape.data) }] } };
    const fetcher = createFirecrawlMcpRunner(mcpDeps(scrape, body => {
      expect(body.params).toEqual({ name: "firecrawl_scrape", arguments: { url: "https://example.org/docs", formats: ["markdown"], onlyMainContent: true } });
    }));
    expect((await fetcher.fetch!("https://example.org/docs", 1000)).ok).toBe(true);
  });
  test("MCP errors do not become content or expose error bodies", async () => {
    const runner = createExaMcpRunner(mcpDeps({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "rate limit: secret" }] } }, () => {}));
    const result = await runner.search!("fixture", 5);
    expect(result).toMatchObject({ ok: false, error_kind: "rate_limited", results: [] });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  test("Parallel reports unverified output format rather than guessing or contacting an endpoint", async () => {
    const runner = createParallelMcpRunner({ env: {}, request: never });
    expect(await runner.search!("fixture", 5)).toMatchObject({ ok: false, skipped: "endpoint not verified" });
  });
});
