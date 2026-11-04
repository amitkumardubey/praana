import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  providerSupportsLiveCatalog,
  resetProviderCatalogCacheForTests,
} from "../src/provider-catalog.js";
import { listModelsForProvider } from "../src/model-listing.js";
import { getCuratedModels } from "../src/llm/catalog.js";
import {
  resolveModelSpecifier,
  resolveModelSpecifierSync,
} from "../src/model-resolver.js";
import { resetCredentialStoreForTests } from "../src/credentials.js";

const CURRENT_ANTHROPIC_IDS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

describe("anthropic model listing", () => {
  let praanaHome: string;
  let prevHome: string | undefined;
  let fetchSpy: ReturnType<typeof spyOn>;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-anthropic-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    resetCredentialStoreForTests();
    resetProviderCatalogCacheForTests();
    calls.length = 0;
    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetProviderCatalogCacheForTests();
    resetCredentialStoreForTests();
    delete process.env.ANTHROPIC_API_KEY;
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  it("supports a live catalog for anthropic", () => {
    expect(providerSupportsLiveCatalog("anthropic")).toBe(true);
  });

  it("follows after_id/has_more pagination and authenticates like the native API", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-key";
    resetCredentialStoreForTests();

    fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const second = url.includes("after_id=");
      const body = second
        ? {
            data: [
              { id: "claude-3-5-sonnet-20241022", max_input_tokens: 180_000 },
              { id: "claude-3-opus-20240229", max_input_tokens: 200_000 },
            ],
            has_more: false,
            last_id: "claude-3-opus-20240229",
          }
        : {
            data: [{ id: "claude-opus-5-5", max_input_tokens: 500_000 }],
            has_more: true,
            last_id: "claude-opus-5-5",
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch);

    const entries = await listModelsForProvider("anthropic");

    // Two pages: the second one is requested with the first page's last_id.
    expect(calls.length).toBe(2);
    expect(calls[0].url).toStartWith("https://api.anthropic.com/v1/models?");
    expect(calls[0].url).toContain("limit=");
    expect(calls[1].url).toContain("after_id=claude-opus-5-5");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-fake-key");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].headers.Authorization).toBeUndefined();

    // Both pages are merged, with the live max_input_tokens as the window.
    const byId = new Map(entries.map((entry) => [entry.modelId, entry]));
    expect(byId.get("claude-opus-5-5")?.contextWindow).toBe(500_000);
    expect(byId.get("claude-3-opus-20240229")?.contextWindow).toBe(200_000);
    expect(byId.get("claude-3-5-sonnet-20241022")?.contextWindow).toBe(180_000);
    expect(entries.every((entry) => entry.available)).toBe(true);
  });

  it("keeps the curated list when the live fetch fails", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-key";
    resetCredentialStoreForTests();
    fetchSpy.mockRejectedValue(new Error("anthropic models API returned 500"));

    const entries = await listModelsForProvider("anthropic");
    const ids = entries.map((entry) => entry.modelId);
    for (const id of CURRENT_ANTHROPIC_IDS) expect(ids).toContain(id);
  });

  it("lists the current curated family without an API key and makes no network call", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    resetCredentialStoreForTests();

    const entries = await listModelsForProvider("anthropic");
    const ids = entries.map((entry) => entry.modelId);

    for (const id of CURRENT_ANTHROPIC_IDS) expect(ids).toContain(id);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Curated fallback entries carry the documented 200k placeholder.
    for (const entry of entries) expect(entry.contextWindow).toBe(200_000);
    expect(entries.every((entry) => !entry.available)).toBe(true);
  });

  it("names claude-sonnet-4-6 correctly", () => {
    const entry = getCuratedModels("anthropic").find(
      (model) => model.id === "claude-sonnet-4-6",
    );
    expect(entry?.name).toBe("Claude Sonnet 4.6");
  });

  it("resolves every current model id without a live call", async () => {
    for (const id of CURRENT_ANTHROPIC_IDS) {
      const sync = resolveModelSpecifierSync(id, "anthropic");
      expect(sync.known).toBe(true);
      expect(sync.provider).toBe("anthropic");
      expect(sync.modelId).toBe(id);

      const explicit = await resolveModelSpecifier(id, "openai", "anthropic");
      expect(explicit.known).toBe(true);
      expect(explicit.provider).toBe("anthropic");
      expect(explicit.modelId).toBe(id);
      expect(explicit.source).toBe("native-catalog");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
