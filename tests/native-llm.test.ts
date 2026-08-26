import { describe, expect, it } from "bun:test";
import {
  serializeToolResult,
  parseSseStream,
  ToolCallAccumulator,
  withPreEmissionRetry,
  isRetryableError,
  signAwsRequest,
  resolveContextWindowSync,
  resolveProviderAuth,
  resolveActiveModelAndProvider,
  OpenAICompatibleDriver,
  AnthropicDriver,
  GoogleDriver,
  type StreamRequest,
} from "../src/llm/index.js";

describe("Native LLM Engine", () => {
  describe("serializeToolResult", () => {
    it("preserves strings verbatim when within limit", () => {
      expect(serializeToolResult("hello world")).toBe("hello world");
    });

    it("serializes objects into formatted JSON", () => {
      const result = serializeToolResult({ ok: true, count: 42 });
      expect(JSON.parse(result)).toEqual({ ok: true, count: 42 });
    });

    it("safely handles circular references", () => {
      const obj: any = { name: "circular" };
      obj.self = obj;
      const result = serializeToolResult(obj);
      expect(result).toContain("[Circular]");
    });

    it("serializes Error instances", () => {
      const err = new Error("Something went wrong");
      const result = serializeToolResult(err, true);
      expect(result).toContain("Something went wrong");
    });

    it("truncates results exceeding 64,000 chars", () => {
      const huge = "a".repeat(70_000);
      const result = serializeToolResult(huge);
      expect(result.length).toBeLessThan(70_000);
      expect(result).toContain("[truncated");
    });
  });

  describe("SSE Parser (parseSseStream)", () => {
    it("parses split chunks and multiple data lines", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"text\": \"he"));
          controller.enqueue(new TextEncoder().encode("llo\"}\n\ndata: {\"text\": \" world\"}\n\n"));
          controller.close();
        },
      });

      const events: string[] = [];
      for await (const event of parseSseStream(stream)) {
        events.push(event.data);
      }

      expect(events).toEqual(['{"text": "hello"}', '{"text": " world"}']);
    });
  });

  describe("ToolCallAccumulator", () => {
    it("stitches split tool call arguments and safely parses JSON", () => {
      const acc = new ToolCallAccumulator();

      // Start tool call
      const c1 = acc.processChunk({
        index: 0,
        id: "call_123",
        name: "edit_file",
        argsDelta: '{"path": "',
      });
      expect(c1.started?.name).toBe("edit_file");

      // Delta
      const c2 = acc.processChunk({
        index: 0,
        argsDelta: 'src/index.ts"}',
      });
      expect(c2.delta?.argsDelta).toBe('src/index.ts"}');

      // Complete
      const c3 = acc.processChunk({
        index: 0,
        isComplete: true,
      });

      expect(c3.ended).toEqual({
        id: "call_123",
        name: "edit_file",
        args: { path: "src/index.ts" },
        rawArgs: '{"path": "src/index.ts"}',
      });
    });
  });

  describe("Pre-Emission Retry", () => {
    it("identifies retryable vs non-retryable errors", () => {
      expect(isRetryableError(null, 429)).toBe(true);
      expect(isRetryableError(null, 503)).toBe(true);
      expect(isRetryableError(null, 401)).toBe(false);
      expect(isRetryableError(null, 400)).toBe(false);
    });

    it("retries on initial 429 and succeeds on second attempt", async () => {
      let attempts = 0;
      const result = await withPreEmissionRetry(
        async () => {
          attempts++;
          if (attempts === 1) {
            const err: any = new Error("Rate limit");
            err.status = 429;
            throw err;
          }
          return "success";
        },
        { baseDelayMs: 10, maxRetries: 2 },
      );

      expect(result).toBe("success");
      expect(attempts).toBe(2);
    });

    it("fails immediately on non-retryable 401 error", async () => {
      let attempts = 0;
      expect(
        withPreEmissionRetry(
          async () => {
            attempts++;
            const err: any = new Error("Invalid API key");
            err.status = 401;
            throw err;
          },
          { baseDelayMs: 10, maxRetries: 3 },
        ),
      ).rejects.toThrow("Invalid API key");
      expect(attempts).toBe(1);
    });
  });

  describe("AWS SigV4 Signer", () => {
    it("generates correct AWS4-HMAC-SHA256 headers", () => {
      const headers = signAwsRequest({
        method: "POST",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-v2/converse-stream",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
        credentials: {
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          region: "us-east-1",
          service: "bedrock",
        },
      });

      expect(headers.Authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/");
      expect(headers["X-Amz-Date"]).toBeDefined();
    });
  });

  describe("Context Window Resolver", () => {
    it("resolves context limits accurately from model patterns", () => {
      expect(resolveContextWindowSync("claude-sonnet-4-6")).toBe(200_000);
      expect(resolveContextWindowSync("gpt-4o")).toBe(128_000);
      expect(resolveContextWindowSync("gemini-2.0-flash")).toBe(1_048_576);
      expect(resolveContextWindowSync("deepseek-chat")).toBe(64_000);
      expect(resolveContextWindowSync("unknown-custom-model")).toBe(128_000);
    });
  });

  describe("Driver Streaming with Mock Fetch", () => {
    it("OpenAICompatibleDriver streams text deltas and tool calls", async () => {
      const originalFetch = globalThis.fetch;
      const sseBody = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
        "data: [DONE]\n\n",
      ].join("");

      globalThis.fetch = async () =>
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });

      try {
        const driver = new OpenAICompatibleDriver();
        const req: StreamRequest = {
          model: "gpt-4o",
          provider: "openai",
          messages: [{ role: "user", content: "hi" }],
        };

        const events: any[] = [];
        for await (const ev of driver.stream(req, { apiKey: "test-key" })) {
          events.push(ev);
        }

        const textDelta = events.find((e) => e.type === "text_delta");
        const toolCallEnd = events.find((e) => e.type === "tool_call_end");
        const usage = events.find((e) => e.type === "usage");
        const done = events.find((e) => e.type === "done");

        expect(textDelta.delta).toBe("Hello");
        expect(toolCallEnd.toolCall.name).toBe("read_file");
        expect(toolCallEnd.toolCall.args).toEqual({ path: "a.txt" });
        expect(usage.usage.totalTokens).toBe(15);
        expect(done.reason).toBe("tool_use");
        expect(done.message.toolCalls?.length).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("AnthropicDriver streams thinking deltas and prompt caching usage", async () => {
      const originalFetch = globalThis.fetch;
      const sseBody = [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_read_input_tokens":20}}}\n\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig123"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer is 42."}}\n\n',
        'data: {"type":"content_block_stop","index":1}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n',
      ].join("");

      globalThis.fetch = async () =>
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });

      try {
        const driver = new AnthropicDriver();
        const req: StreamRequest = {
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          messages: [{ role: "user", content: "hi" }],
          reasoningEffort: "medium",
        };

        const events: any[] = [];
        for await (const ev of driver.stream(req, { apiKey: "test-key" })) {
          events.push(ev);
        }

        const thinking = events.find((e) => e.type === "thinking_delta");
        const text = events.find((e) => e.type === "text_delta");
        const usage = events.find((e) => e.type === "usage");
        const done = events.find((e) => e.type === "done");

        expect(thinking.delta).toBe("Let me think...");
        expect(text.delta).toBe("The answer is 42.");
        expect(usage.usage.cacheReadTokens).toBe(20);
        expect(done.message.thinking).toBe("Let me think...");
        expect(done.message.thinkingSignature).toBe("sig123");
        expect(done.message.content).toBe("The answer is 42.");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
