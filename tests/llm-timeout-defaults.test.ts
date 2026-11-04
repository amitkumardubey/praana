import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigWarnings, loadConfig } from "../src/config.js";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { resolveLlmStreamTimeouts } from "../src/llm/stream-guard.js";
import { streamLlmResponse } from "../src/llm/stream.js";
import { resetUserProvidersForTests, upsertUserProvider } from "../src/provider-registry.js";
import { createTestLogger, getAppLogger, setAppLogger, type PraanaLogger } from "../src/logger.js";

const originalFetch = globalThis.fetch;
let dir = "";
let previousLogger: PraanaLogger | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetUserProvidersForTests();
  if (previousLogger) setAppLogger(previousLogger);
  previousLogger = undefined;
  getConfigWarnings();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("resolveLlmStreamTimeouts", () => {
  it("uses 60s connect and 300s idle for first-party hosted providers", () => {
    for (const provider of ["anthropic", "openai", "google", "vertex", "amazon-bedrock"]) {
      expect(resolveLlmStreamTimeouts({ provider })).toEqual({
        connectTimeoutMs: 60_000,
        idleTimeoutMs: 300_000,
      });
    }
  });

  it("uses 300s connect and 300s idle for local and other registry providers", () => {
    for (const provider of ["ollama", "openrouter", "lm-studio", "vllm", "groq", "azure"]) {
      expect(resolveLlmStreamTimeouts({ provider })).toEqual({
        connectTimeoutMs: 300_000,
        idleTimeoutMs: 300_000,
      });
    }
  });

  it("uses the long connect budget for a user-declared endpoint, even with a hosted id", () => {
    upsertUserProvider("openai", {
      api: "openai-completions",
      base_url: "http://127.0.0.1:9/v1",
    });
    expect(resolveLlmStreamTimeouts({ provider: "openai" }).connectTimeoutMs).toBe(300_000);
    expect(resolveLlmStreamTimeouts({ provider: "my-llama" }).connectTimeoutMs).toBe(300_000);
  });

  it("uses the long connect budget when a hosted id points at another host", () => {
    expect(
      resolveLlmStreamTimeouts({ provider: "openai", baseUrl: "http://localhost:11434/v1" }),
    ).toEqual({ connectTimeoutMs: 300_000, idleTimeoutMs: 300_000 });
    expect(resolveLlmStreamTimeouts({ provider: "openai" }).connectTimeoutMs).toBe(60_000);
    expect(
      resolveLlmStreamTimeouts({
        provider: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        connectTimeoutMs: 12_000,
      }).connectTimeoutMs,
    ).toBe(12_000);
  });

  it("lets an explicit value, including 0, override the provider default", () => {
    expect(
      resolveLlmStreamTimeouts({
        provider: "ollama",
        connectTimeoutMs: 60_000,
        idleTimeoutMs: 0,
      }),
    ).toEqual({ connectTimeoutMs: 60_000, idleTimeoutMs: 0 });
    expect(
      resolveLlmStreamTimeouts({ provider: "anthropic", connectTimeoutMs: 0, idleTimeoutMs: 12_000 }),
    ).toEqual({ connectTimeoutMs: 0, idleTimeoutMs: 12_000 });
  });
});

describe("config validation does not retune live streams", () => {
  it("leaves another stream on provider defaults after validating a throwaway config", async () => {
    const before = resolveLlmStreamTimeouts({ provider: "anthropic" });
    dir = mkdtempSync(join(tmpdir(), "praana-llm-timeout-isolate-"));
    const path = join(dir, "praana.config.toml");
    writeFileSync(
      path,
      [
        "[llm]",
        "connect_timeout_ms = 1",
        "stream_idle_timeout_ms = 1",
        'stream_end_check = "lenient"',
        "",
      ].join("\n"),
      "utf-8",
    );
    previousLogger = getAppLogger();
    setAppLogger(createTestLogger(() => {}));
    const cfg = loadConfig(path);
    expect(cfg.llm.connect_timeout_ms).toBe(1);
    expect(cfg.llm.stream_idle_timeout_ms).toBe(1);
    expect(cfg.llm.stream_end_check).toBe("lenient");
    expect(resolveLlmStreamTimeouts({ provider: "anthropic" })).toEqual(before);

    globalThis.fetch = (async () =>
      new Response(
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial"}}\n\n',
        { status: 200 },
      )) as typeof fetch;
    const events = [];
    for await (const ev of streamLlmResponse({
      model: "m",
      provider: "anthropic",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "test-key",
    })) {
      events.push(ev);
    }
    const error = events.find((ev) => ev.type === "error");
    expect(error && error.type === "error" ? error.error.message : "").toContain("message_stop");
    expect(events.some((ev) => ev.type === "done")).toBe(false);

    const driverEvents = [];
    for await (const ev of new AnthropicDriver().stream(
      {
        model: "m",
        provider: "anthropic",
        messages: [{ role: "user", content: "hi" }],
      },
      { apiKey: "test-key" },
    )) {
      driverEvents.push(ev);
    }
    const driverError = driverEvents.find((ev) => ev.type === "error");
    expect(driverError && driverError.type === "error" ? driverError.error.message : "").toContain(
      "message_stop",
    );
  });
});
