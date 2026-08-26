import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  streamLlmResponse,
  resolveProviderAuth,
  getDriverForProvider,
  joinUrl,
  keysFromSharedFiles,
  OpenAICompatibleDriver,
  AzureDriver,
  GoogleDriver,
  type StreamRequest,
} from "../src/llm/index.js";
import { setApiKey, resetCredentialStoreForTests } from "../src/credentials.js";
import { summarizerModelForProvider } from "../src/memory/summarizer-factory.js";
import { resetBedrockConfigRegionForTests, setBedrockConfigRegion } from "../src/bedrock/region.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";
import { resetUserProvidersForTests } from "../src/provider-registry.js";

const SSE_TEXT = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n data: [DONE]\n\n';

describe("native LLM wiring", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    "PRAANA_HOME",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_OPENAI_DEPLOYMENT_NAME",
    "AZURE_OPENAI_API_VERSION",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GCP_ACCESS_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
    "POOLSIDE_API_KEY",
  ];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "praana-llm-wire-"));
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.PRAANA_HOME = home;
    setAppLogger(new PraanaLogger({ domain: "llm", writeLine: () => {} }));
    resetCredentialStoreForTests();
    resetUserProvidersForTests();
    resetBedrockConfigRegionForTests();
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    resetUserProvidersForTests();
    resetBedrockConfigRegionForTests();
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("joinUrl keeps query params after the path", () => {
    expect(
      joinUrl("https://x.openai.azure.com/openai/deployments/gpt-4o", "/chat/completions", {
        "api-version": "2024-02-15-preview",
      }),
    ).toBe(
      "https://x.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-15-preview",
    );
  });

  it("getDriverForProvider maps OAuth providers to the right protocol", () => {
    expect(getDriverForProvider("github-copilot").protocol).toBe("anthropic-messages");
    expect(getDriverForProvider("openai-codex").protocol).toBe("openai-responses");
    expect(getDriverForProvider("openrouter").protocol).toBe("openai-compatible");
  });

  it("GitHub Copilot uses the Anthropic driver with Bearer auth", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = headersToObject(init?.headers);
      return new Response(
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;

    try {
      for await (const _ of streamLlmResponse({
        provider: "github-copilot",
        model: "gpt-4.1",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "copilot-already-exchanged",
      })) {
        /* drain */
      }
      expect(capturedUrl).toBe("https://api.individual.githubcopilot.com/v1/messages");
      expect(capturedHeaders.authorization || capturedHeaders.Authorization).toBe(
        "Bearer copilot-already-exchanged",
      );
      expect(capturedHeaders["x-api-key"] || capturedHeaders["X-Api-Key"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("summarizer defaults use provider-native model ids", () => {
    expect(summarizerModelForProvider("openrouter")).toBe("anthropic/claude-3-5-haiku");
    expect(summarizerModelForProvider("google")).toBe("gemini-2.0-flash");
    expect(summarizerModelForProvider("groq")).toBe("llama-3.3-70b-versatile");
    expect(summarizerModelForProvider("deepseek")).toBe("deepseek-chat");
  });

  it("stored Bedrock API key resolves as bearerToken", () => {
    setApiKey("amazon-bedrock", "stored-tok");
    const auth = resolveProviderAuth("amazon-bedrock");
    expect(auth?.bearerToken).toBe("stored-tok");
    expect(auth?.apiKey).toBeUndefined();
  });

  it("AWS_PROFILE without env keys is treated as ambient Bedrock auth", () => {
    process.env.AWS_PROFILE = "dev";
    const auth = resolveProviderAuth("amazon-bedrock");
    expect(auth?.awsAmbient).toBe(true);
  });

  it("reads SigV4 keys from a shared credentials file", () => {
    const credPath = join(home, "credentials");
    writeFileSync(
      credPath,
      "[dev]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = secret-example\n",
    );
    process.env.AWS_SHARED_CREDENTIALS_FILE = credPath;
    const keys = keysFromSharedFiles("dev");
    expect(keys?.accessKeyId).toBe("AKIAEXAMPLE");
    expect(keys?.secretAccessKey).toBe("secret-example");
  });

  it("Bedrock signs with AWS_PROFILE credentials when no bearer token is set", async () => {
    const credPath = join(home, "credentials");
    writeFileSync(
      credPath,
      "[dev]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
    );
    process.env.AWS_SHARED_CREDENTIALS_FILE = credPath;
    process.env.AWS_PROFILE = "dev";
    process.env.AWS_REGION = "us-west-2";

    const originalFetch = globalThis.fetch;
    let capturedAuth = "";
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      const headers = headersToObject(init?.headers);
      capturedAuth = headers.authorization || headers.Authorization || "";
      return new Response(new Uint8Array(), { status: 200 });
    }) as typeof fetch;

    try {
      for await (const _ of streamLlmResponse({
        provider: "amazon-bedrock",
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "hi" }],
      })) {
        /* drain */
      }
      expect(capturedUrl).toContain("bedrock-runtime.us-west-2.amazonaws.com");
      expect(capturedAuth).toContain("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("streamLlmResponse sends OpenRouter requests to openrouter.ai", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers;
      return new Response(SSE_TEXT, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const events = [];
      for await (const ev of streamLlmResponse({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      })) {
        events.push(ev);
      }
      expect(capturedUrl).toContain("https://openrouter.ai/api/v1/chat/completions");
      const headers = headersToObject(capturedHeaders);
      expect(headers["http-referer"] || headers["HTTP-Referer"]).toBe(
        "https://github.com/amitkumardubey/praana",
      );
      expect(events.some((e) => e.type === "text_delta")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("streamLlmResponse sends Ollama requests to the local OpenAI-compatible host", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(SSE_TEXT, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      for await (const _ of streamLlmResponse({
        provider: "ollama",
        model: "llama3",
        messages: [{ role: "user", content: "hi" }],
      })) {
        /* drain */
      }
      expect(capturedUrl).toBe("http://127.0.0.1:11434/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("streamLlmResponse sends a stored Bedrock key as Bearer", async () => {
    setApiKey("amazon-bedrock", "stored-tok");
    setBedrockConfigRegion("eu-west-1");
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedAuth = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      const headers = headersToObject(init?.headers);
      capturedAuth = headers.authorization || headers.Authorization || "";
      return new Response(new Uint8Array(), { status: 200 });
    }) as typeof fetch;

    try {
      for await (const _ of streamLlmResponse({
        provider: "amazon-bedrock",
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "hi" }],
        region: "eu-west-1",
      })) {
        /* drain */
      }
      expect(capturedUrl).toContain("bedrock-runtime.eu-west-1.amazonaws.com");
      expect(capturedAuth).toBe("Bearer stored-tok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("AzureDriver puts api-version after /chat/completions", async () => {
    process.env.AZURE_OPENAI_RESOURCE_NAME = "myres";
    process.env.AZURE_OPENAI_API_VERSION = "2024-02-15-preview";
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return new Response(SSE_TEXT, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const driver = new AzureDriver();
      for await (const _ of driver.stream(
        {
          provider: "azure",
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        },
        { apiKey: "azure-key" },
      )) {
        /* drain */
      }
      expect(capturedUrl).toBe(
        "https://myres.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-15-preview",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("omits stream_options when compat.supportsUsageInStreaming is false", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(SSE_TEXT, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    try {
      const driver = new OpenAICompatibleDriver();
      const req: StreamRequest = {
        provider: "poolside",
        model: "poolside/laguna-s-2.1",
        messages: [{ role: "user", content: "hi" }],
        compat: { supportsUsageInStreaming: false },
      };
      for await (const _ of driver.stream(req, { apiKey: "pk-test" })) {
        /* drain */
      }
      const body = JSON.parse(capturedBody) as { stream_options?: unknown };
      expect(body.stream_options).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Google AI Studio is not hijacked by GOOGLE_APPLICATION_CREDENTIALS", async () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/tmp/does-not-exist.json";
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = headersToObject(init?.headers);
      return new Response("data: {\"candidates\":[]}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const driver = new GoogleDriver();
      for await (const _ of driver.stream(
        {
          provider: "google",
          model: "gemini-2.0-flash",
          messages: [{ role: "user", content: "hi" }],
        },
        { apiKey: "gemini-key" },
      )) {
        /* drain */
      }
      expect(capturedUrl).toContain("generativelanguage.googleapis.com");
      expect(capturedUrl).not.toContain("aiplatform.googleapis.com");
      expect(capturedHeaders["x-goog-api-key"] || capturedHeaders["X-Goog-Api-Key"]).toBe("gemini-key");
      expect(capturedHeaders.authorization || capturedHeaders.Authorization).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Vertex does not send a credentials file path as a Bearer token", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(home, "missing-sa.json");
    const originalFetch = globalThis.fetch;
    let capturedAuth = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = headersToObject(init?.headers);
      capturedAuth = headers.authorization || headers.Authorization || "";
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const driver = new GoogleDriver();
      const events = [];
      for await (const ev of driver.stream(
        {
          provider: "vertex",
          model: "gemini-2.0-flash",
          messages: [{ role: "user", content: "hi" }],
        },
        { apiKey: join(home, "missing-sa.json") },
      )) {
        events.push(ev);
      }
      expect(capturedAuth).toBe("");
      expect(events[0]?.type).toBe("error");
      expect(String((events[0] as { error?: Error }).error?.message)).not.toContain("Bearer");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
