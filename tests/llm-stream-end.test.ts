import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigWarnings, loadConfig } from "../src/config.js";
import { streamLlmResponse } from "../src/llm/stream.js";
import type { StreamEvent } from "../src/llm/types.js";
import { setStreamEndCheck } from "../src/llm/stream-end.js";
import { resetUserProvidersForTests } from "../src/provider-registry.js";
import { createTestLogger, getAppLogger, setAppLogger, type PraanaLogger } from "../src/logger.js";

const originalFetch = globalThis.fetch;
const LENIENT_LOG = "stream ended without a final event; accepted (lenient)";

let dir = "";
let lines: string[] = [];
let previousLogger: PraanaLogger | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousLogger) setAppLogger(previousLogger);
  previousLogger = undefined;
  setStreamEndCheck("auto");
  resetUserProvidersForTests();
  getConfigWarnings();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function writeConfig(toml: string): string {
  dir = mkdtempSync(join(tmpdir(), "praana-stream-end-"));
  const path = join(dir, "praana.config.toml");
  writeFileSync(path, toml, "utf-8");
  return path;
}

function installLogger(): void {
  lines = [];
  previousLogger = getAppLogger();
  setAppLogger(createTestLogger((line) => lines.push(line), { debug: true }));
}

async function collect(provider: string, body: string): Promise<StreamEvent[]> {
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const ev of streamLlmResponse({
    model: "m",
    provider,
    messages: [{ role: "user", content: "hi" }],
    apiKey: "test-key",
  })) {
    events.push(ev);
  }
  return events;
}

function assertPremature(events: StreamEvent[], signal: string): void {
  const errors = events.filter((ev) => ev.type === "error");
  expect(events.some((ev) => ev.type === "done")).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    type: "error",
    retryable: false,
  });
  expect((errors[0] as { error: Error }).error.message).toBe(
    `stream ended before the provider sent a final event (${signal})`,
  );
}

function assertLenientDone(events: StreamEvent[], provider: string, text: string): void {
  expect(events.filter((ev) => ev.type === "error")).toEqual([]);
  const deltas = events.filter((ev) => ev.type === "text_delta");
  expect(deltas.map((ev) => (ev.type === "text_delta" ? ev.delta : "")).join("")).toBe(text);
  const dones = events
    .filter((ev) => ev.type === "done")
    .map((ev) => JSON.parse(JSON.stringify(ev)));
  expect(dones).toEqual([
    { type: "done", reason: "stop", message: { role: "assistant", content: text } },
  ]);
  expect(lines.some((line) => line.includes(provider) && line.includes(LENIENT_LOG))).toBe(true);
}

const ANTHROPIC_PARTIAL =
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial"}}\n\n';
const OPENAI_PARTIAL =
  'data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":null}]}\n\n';

describe("llm.stream_end_check config", () => {
  it("defaults to auto when the key is omitted", () => {
    installLogger();
    getConfigWarnings();
    const cfg = loadConfig(writeConfig('[llm]\nmodel = "m"\n'));
    expect(getConfigWarnings().some((w) => w.includes("stream_end_check"))).toBe(false);
    expect(cfg.llm.stream_end_check).toBe("auto");
  });

  it("accepts auto, strict, and lenient", () => {
    for (const value of ["auto", "strict", "lenient"] as const) {
      getConfigWarnings();
      const cfg = loadConfig(writeConfig(`[llm]\nstream_end_check = "${value}"\n`));
      expect(getConfigWarnings().some((w) => w.includes("stream_end_check"))).toBe(false);
      expect(cfg.llm.stream_end_check).toBe(value);
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("warns and uses auto when the value is invalid", () => {
    installLogger();
    getConfigWarnings();
    const cfg = loadConfig(writeConfig('[llm]\nstream_end_check = "nope"\n'));
    const warnings = getConfigWarnings();
    expect(warnings.some((w) => w.includes('Invalid llm.stream_end_check'))).toBe(true);
    expect(cfg.llm.stream_end_check).toBe("auto");
  });
});

describe("stream end check plumbed through streamLlmResponse", () => {
  it("auto treats anthropic as strict", async () => {
    installLogger();
    getConfigWarnings();
    const cfg = loadConfig(writeConfig('[llm]\nmodel = "m"\n'));
    expect(cfg.llm.stream_end_check).toBe("auto");
    const events = await collect("anthropic", ANTHROPIC_PARTIAL);
    assertPremature(events, "message_stop");
    expect(lines.some((line) => line.includes(LENIENT_LOG))).toBe(false);
  });

  it("auto treats a user-declared provider as lenient", async () => {
    installLogger();
    getConfigWarnings();
    const cfg = loadConfig(
      writeConfig(
        [
          "[llm]",
          'stream_end_check = "auto"',
          "",
          "[providers.my-llama]",
          'api = "openai-completions"',
          'base_url = "http://127.0.0.1:9/v1"',
          "",
        ].join("\n"),
      ),
    );
    expect(cfg.llm.stream_end_check).toBe("auto");
    const events = await collect("my-llama", OPENAI_PARTIAL);
    assertLenientDone(events, "my-llama", "Partial");
  });

  it("strict still errors for a user-declared provider", async () => {
    installLogger();
    getConfigWarnings();
    const cfg = loadConfig(
      writeConfig(
        [
          "[llm]",
          'stream_end_check = "strict"',
          "",
          "[providers.my-llama]",
          'api = "openai-completions"',
          'base_url = "http://127.0.0.1:9/v1"',
          "",
        ].join("\n"),
      ),
    );
    expect(cfg.llm.stream_end_check).toBe("strict");
    const events = await collect("my-llama", OPENAI_PARTIAL);
    assertPremature(events, "finish_reason or [DONE]");
    expect(lines.some((line) => line.includes(LENIENT_LOG))).toBe(false);
  });

  it("lenient accepts an Anthropic close without message_stop", async () => {
    installLogger();
    getConfigWarnings();
    const cfg = loadConfig(writeConfig('[llm]\nstream_end_check = "lenient"\n'));
    expect(cfg.llm.stream_end_check).toBe("lenient");
    const events = await collect("anthropic", ANTHROPIC_PARTIAL);
    assertLenientDone(events, "anthropic", "Partial");
  });
});
