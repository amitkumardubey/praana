import { describe, expect, it, spyOn, afterEach } from "bun:test";
import { verifyProviderKey, resolvePreferredModel } from "../src/setup/logic.js";

describe("verifyProviderKey", () => {
  afterEach(() => {
    // restore spies created in tests
  });

  it("rejects empty keys as unauthorized", async () => {
    const result = await verifyProviderKey("openrouter", "  ");
    expect(result.status).toBe("unauthorized");
    expect(result.message).toContain("required");
  });

  it("returns unauthorized on HTTP 401", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );
    try {
      const result = await verifyProviderKey("openrouter", "sk-bad");
      expect(result.status).toBe("unauthorized");
      expect(result.httpStatus).toBe(401);
      expect(result.message).toContain("Invalid API key");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns unauthorized on HTTP 403", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response("forbidden", { status: 403 }));
    try {
      const result = await verifyProviderKey("openai", "sk-bad");
      expect(result.status).toBe("unauthorized");
      expect(result.httpStatus).toBe(403);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns unreachable on network failure", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockRejectedValue(new Error("Connection refused"));
    try {
      const result = await verifyProviderKey("openrouter", "sk-test");
      expect(result.status).toBe("unreachable");
      expect(result.message).toContain("Connection refused");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns ok on 200", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    try {
      const result = await verifyProviderKey("openai", "sk-good");
      expect(result.status).toBe("ok");
      expect(result.message).toContain("verified");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("skips providers with no probeable base URL", async () => {
    const result = await verifyProviderKey("amazon-bedrock", "tok-test");
    expect(result.status).toBe("skipped");
  });
});

describe("resolvePreferredModel", () => {
  it("keeps the current model when re-logging into the active provider", () => {
    expect(
      resolvePreferredModel("openrouter", {
        currentProvider: "openrouter",
        currentModel: "openai/gpt-4.1",
        liveModels: [{ id: "other", contextWindow: null }],
      }),
    ).toBe("openai/gpt-4.1");
  });

  it("keeps config.toml model for that provider", () => {
    expect(
      resolvePreferredModel("anthropic", {
        currentProvider: "openrouter",
        currentModel: "openai/gpt-4.1",
        configProvider: "anthropic",
        configModel: "claude-sonnet-4-5",
      }),
    ).toBe("claude-sonnet-4-5");
  });

  it("falls back to the first live catalog model", () => {
    expect(
      resolvePreferredModel("openai", {
        liveModels: [
          { id: "gpt-4o", contextWindow: 128000 },
          { id: "gpt-4o-mini", contextWindow: 128000 },
        ],
      }),
    ).toBe("gpt-4o");
  });
});
