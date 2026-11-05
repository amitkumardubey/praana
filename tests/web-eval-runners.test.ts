import { describe, expect, test } from "bun:test";
import { classifyError, estimateTokens } from "../scripts/web-eval/runners/base.js";
import { createLocalFetchRunner } from "../scripts/web-eval/runners/local-fetch.js";
import { createJinaRunner } from "../scripts/web-eval/runners/jina.js";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/web-eval/${name}`, import.meta.url)).text();

describe("web eval base taxonomy", () => {
  test("classifies status and provider hints without returning provider secrets", () => {
    expect(classifyError(401, "secret")).toBe("invalid_key");
    expect(classifyError(402, "")).toBe("credit_depleted");
    expect(classifyError(429, "")).toBe("rate_limited");
    expect(classifyError(503, "")).toBe("server_error");
    expect(classifyError(403, "bot challenge")).toBe("blocked");
    expect(classifyError(400, "API key is invalid")).toBe("invalid_key");
    expect(classifyError(400, "credits exhausted")).toBe("credit_depleted");
    expect(classifyError(400, "bad input")).toBe("other");
    expect(estimateTokens("123456")).toBe(1.5);
  });
});

describe("offline fetch adapters", () => {
  test("local baseline strips non-content and decodes HTML without executing JS", async () => {
    const html = await fixture("local.html");
    const runner = createLocalFetchRunner({ request: async (_url, init) => {
      expect(new Headers(init?.headers).get("user-agent")).toBe("praana-web-eval/0.1");
      return new Response(html, { headers: { "content-type": "text/html" } });
    } });
    const result = await runner.fetch!("https://example.org/docs", 1000);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('Use <code> A B "now".');
    expect(result.content).not.toMatch(/secretCode|hidden|comment|doctype/);
    expect(result.tokens).toBe(result.content.length / 4);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect((await runner.fetch!("https://example.org/docs", 7)).content.length).toBe(7);
  });
  test("bot-wall 200 is blocked, not successful retrieval", async () => {
    const wall = await fixture("wall.html");
    const result = await createLocalFetchRunner({ request: async () => new Response(wall) }).fetch!("https://example.org", 1000);
    expect(result).toMatchObject({ ok: false, blocked: true, error_kind: "blocked", status: 200 });
  });
  test("Jina Reader parses recorded text and uses only its fetch endpoint", async () => {
    const text = await fixture("jina.txt");
    const runner = createJinaRunner({ request: async url => {
      expect(String(url)).toBe("https://r.jina.ai/https://example.org/docs");
      return new Response(text);
    } });
    expect(runner.search).toBeUndefined();
    const result = await runner.fetch!("https://example.org/docs", 1000);
    expect(result).toMatchObject({ ok: true, content: text, tokens: text.length / 4 });
  });
  test("handles status failures, timeouts, invalid schemes, empty and unreadable bodies", async () => {
    const failed = createJinaRunner({ request: async () => new Response("secret credential", { status: 429 }) });
    const result = await failed.fetch!("https://example.org", 1000);
    expect(result).toMatchObject({ ok: false, error_kind: "rate_limited", status: 429 });
    expect(JSON.stringify(result)).not.toContain("secret");
    const timeout = createLocalFetchRunner({ request: async () => { throw new DOMException("secret", "TimeoutError"); } });
    expect(await timeout.fetch!("https://example.org", 1000)).toMatchObject({ ok: false, error_kind: "timeout" });
    expect(await timeout.fetch!("file:///etc/passwd", 1000)).toMatchObject({ ok: false, error_kind: "other" });
    const empty = createJinaRunner({ request: async () => new Response("") });
    expect((await empty.fetch!("https://example.org", 100)).ok).toBe(false);
    const binary = createLocalFetchRunner({ request: async () => new Response("binary", { headers: { "content-type": "image/png" } }) });
    expect((await binary.fetch!("https://example.org/image", 100)).ok).toBe(false);
  });
});
