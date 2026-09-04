// ============================================================
// PRAANA — Rust v2 Phase 0 legacy provider fixture evidence
//
// Captures deterministic, redacted evidence of what the current
// TypeScript OpenAI/OpenRouter drivers put on the wire, using a
// mocked globalThis.fetch. Never contacts a real provider.
// The committed fixtures are legacy TypeScript observations only;
// normative v2 behavior is owned by docs/RUST_V2_OPENAI_SPEC.md.
// ============================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  OpenAICompatibleDriver,
  OpenAIResponsesDriver,
  type ResolvedAuth,
  type StreamEvent,
  type StreamRequest,
} from "../src/llm/index.js";

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE_ROOT = "tests/fixtures/rust-v2/providers";

/** Exact Section 5 inventory for the provider fixture family. */
const EXPECTED_INVENTORY = [
  "README.md",
  "manifest.json",
  "legacy-ts/openai-chat/basic.request.json",
  "legacy-ts/openai-chat/multimodal-tools.request.json",
  "legacy-ts/openai-chat/parallel-tools.stream.sse",
  "legacy-ts/openai-chat/parallel-tools.events.jsonl",
  "legacy-ts/openai-responses/basic.request.json",
  "legacy-ts/openai-responses/tool-call.stream.sse",
  "legacy-ts/openai-responses/tool-call.events.jsonl",
  "legacy-ts/openrouter-chat/basic.request.json",
  "legacy-ts/openrouter-chat/basic.headers.json",
  "legacy-ts/openrouter-chat/reasoning.stream.sse",
  "legacy-ts/openrouter-chat/reasoning.events.jsonl",
  "v1/README.md",
];

/** Production oracle files named in Section 4.3 (repo-relative). */
const ORACLE_FILES = [
  "src/llm/auth.ts",
  "src/llm/drivers/base.ts",
  "src/llm/drivers/openai.ts",
  "src/llm/drivers/responses.ts",
  "src/llm/retry.ts",
  "src/llm/resolver.ts",
  "src/llm/sse.ts",
  "src/llm/stream.ts",
  "src/llm/tool-accumulator.ts",
  "src/llm/types.ts",
  "src/llm/url.ts",
  "src/llm/wire-config.ts",
  "src/provider-registry.ts",
];

const ORACLE_FILES_SORTED = [...ORACLE_FILES].sort();

const REDACTED = "[REDACTED]";
const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "api_key",
  "cookie",
  "set-cookie",
]);

function fixturePath(rel: string): string {
  return join(REPO_ROOT, FIXTURE_ROOT, rel);
}

function requireFixture(rel: string): string {
  const abs = fixturePath(rel);
  if (!existsSync(abs)) {
    throw new Error(`Missing fixture file: ${FIXTURE_ROOT}/${rel}`);
  }
  return readFileSync(abs, "utf8");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Lowercase header names and redact credential-bearing values. */
function sanitizedHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    out[lower] = SECRET_HEADER_NAMES.has(lower) ? REDACTED : value;
  }
  return out;
}

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

// URL -> fixed SSE response body. Any other URL is a harness violation.
// Packet §9.2 requires the committed .stream.sse fixture files to be the exact
// bytes fed to the legacy TypeScript driver.
const CANNED_RESPONSES: Record<string, string> = {
  "https://api.openai.com/v1/chat/completions": requireFixture(
    "legacy-ts/openai-chat/parallel-tools.stream.sse",
  ),
  "https://api.openai.com/v1/responses": requireFixture(
    "legacy-ts/openai-responses/tool-call.stream.sse",
  ),
  "https://openrouter.ai/api/v1/chat/completions": requireFixture(
    "legacy-ts/openrouter-chat/reasoning.stream.sse",
  ),
};

let fetchViolations: string[] = [];
let capturedRequests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

beforeAll(() => {
  fetchViolations = [];
  capturedRequests = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const canned = CANNED_RESPONSES[url];
    if (canned === undefined) {
      fetchViolations.push(url);
      throw new Error(`Fixture harness blocked non-fixture fetch target: ${url}`);
    }
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = typeof init?.body === "string" ? init.body : "";
    capturedRequests.push({
      method: String(init?.method ?? "GET"),
      url,
      headers: rawHeaders,
      body: rawBody === "" ? null : JSON.parse(rawBody),
    });
    return new Response(canned, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function lastCapturedRequest(): CapturedRequest {
  const captured = capturedRequests.at(-1);
  if (!captured) throw new Error("Fixture harness observed no captured request");
  return captured;
}

function requestEvidence(captured: CapturedRequest): Record<string, unknown> {
  return {
    method: captured.method,
    url: captured.url,
    headers: sanitizedHeaders(captured.headers),
    body: captured.body,
  };
}

async function collectDriverEvents(
  driver: OpenAICompatibleDriver | OpenAIResponsesDriver,
  req: StreamRequest,
  auth: ResolvedAuth,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of driver.stream(req, auth)) {
    events.push(ev);
  }
  return events;
}

/** Driver events are legacy evidence, not a v2 contract. Errors become plain records. */
function normalizeEvent(ev: StreamEvent): Record<string, unknown> {
  if (ev.type === "error") {
    const out: Record<string, unknown> = {
      type: "error",
      message: ev.error.message,
      retryable: ev.retryable,
    };
    if (ev.status !== undefined) out.status = ev.status;
    return out;
  }
  return ev as unknown as Record<string, unknown>;
}

function readCommittedLines(rel: string): string[] {
  const raw = requireFixture(rel);
  if (raw.includes("\r")) {
    throw new Error(`Fixture ${rel} must not contain CR`);
  }
  if (!raw.endsWith("\n")) {
    throw new Error(`Fixture ${rel} must end with a trailing LF`);
  }
  return raw.slice(0, -1).split("\n");
}

function readCommittedJson(rel: string): unknown {
  const raw = requireFixture(rel);
  if (raw.includes("\r")) {
    throw new Error(`Fixture ${rel} must not contain CR`);
  }
  if (!raw.endsWith("\n")) {
    throw new Error(`Fixture ${rel} must end with one trailing LF`);
  }
  return JSON.parse(raw);
}

function compareEventsJsonl(rel: string, events: StreamEvent[]): void {
  const committed = readCommittedLines(rel);
  const expected = events.map((ev) => JSON.stringify(normalizeEvent(ev)));
  expect(committed.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(JSON.parse(committed[i])).toEqual(JSON.parse(expected[i]));
  }
}

/** Recursively list files below the fixture root (repo-relative POSIX keys). */
function listFixtureFiles(): string[] {
  const rootAbs = join(REPO_ROOT, FIXTURE_ROOT);
  if (!existsSync(rootAbs)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        out.push(relative(rootAbs, abs).split("\\").join("/"));
      }
    }
  };
  walk(rootAbs);
  return out.sort();
}

// ── Fixed scenario inputs ────────────────────────────────────

const OPENAI_AUTH: ResolvedAuth = { apiKey: "sk-fixture-openai-not-a-real-key" };
const OPENROUTER_AUTH: ResolvedAuth = { apiKey: "sk-fixture-openrouter-not-a-real-key" };
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/amitkumardubey/praana",
  "X-Title": "PRAANA",
};

describe("rust-v2 provider legacy fixtures", () => {
  it("provider fixture inventory is complete", () => {
    const present = new Set(listFixtureFiles());
    const missing = EXPECTED_INVENTORY.filter((rel) => !present.has(rel));
    const extra = [...present].filter((rel) => !EXPECTED_INVENTORY.includes(rel));
    expect(missing, `Missing provider fixtures: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `Unexpected extra provider fixture files: ${extra.join(", ")}`).toEqual([]);
  });

  it("provider manifest is complete, sorted, and hash-bound", () => {
    const manifest = JSON.parse(requireFixture("manifest.json")) as {
      fixture_schema_version: number;
      fixture_kind: string;
      oracle_sha256_by_file: Record<string, string>;
      fixture_sha256_by_file: Record<string, string>;
    };

    expect(manifest.fixture_schema_version).toBe(1);
    expect(manifest.fixture_kind).toBe("provider-phase-0");

    const oracleKeys = Object.keys(manifest.oracle_sha256_by_file);
    expect(oracleKeys).toEqual(ORACLE_FILES_SORTED);
    for (const rel of ORACLE_FILES_SORTED) {
      const bytes = readFileSync(join(REPO_ROOT, rel));
      expect(manifest.oracle_sha256_by_file[rel], `oracle hash mismatch: ${rel}`).toBe(
        sha256Hex(bytes),
      );
    }

    const fixtureKeys = Object.keys(manifest.fixture_sha256_by_file);
    const diskFiles = listFixtureFiles().filter((rel) => rel !== "manifest.json");
    expect(fixtureKeys).toEqual(diskFiles);
    for (const rel of fixtureKeys) {
      const bytes = readFileSync(join(REPO_ROOT, FIXTURE_ROOT, rel));
      expect(manifest.fixture_sha256_by_file[rel], `fixture hash mismatch: ${rel}`).toBe(
        sha256Hex(bytes),
      );
    }
  });

  it("legacy openai chat basic text request matches committed evidence", async () => {
    const driver = new OpenAICompatibleDriver();
    const req: StreamRequest = {
      model: "praana-fixture-model",
      provider: "openai",
      systemPrompt: "You are a deterministic fixture agent.",
      messages: [{ role: "user", content: "Reply with the single word: ready." }],
    };
    await collectDriverEvents(driver, req, OPENAI_AUTH);
    const captured = lastCapturedRequest();
    const committed = readCommittedJson("legacy-ts/openai-chat/basic.request.json");
    expect(committed).toEqual(requestEvidence(captured));
  });

  it("legacy openai chat system multimodal two-tools request matches committed evidence", async () => {
    const driver = new OpenAICompatibleDriver();
    const req: StreamRequest = {
      model: "praana-fixture-model",
      provider: "openai",
      systemPrompt: "You are a deterministic fixture agent.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image and decide whether to read the file." },
            { type: "image", mimeType: "image/png", data: "Zml4dHVyZS1pbWFnZS1ieXRlcw==" },
          ],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file from the workspace.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        {
          name: "grep",
          description: "Search file contents.",
          parameters: {
            type: "object",
            properties: { pattern: { type: "string" } },
            required: ["pattern"],
          },
        },
      ],
    };
    await collectDriverEvents(driver, req, OPENAI_AUTH);
    const captured = lastCapturedRequest();
    const committed = readCommittedJson("legacy-ts/openai-chat/multimodal-tools.request.json");
    expect(committed).toEqual(requestEvidence(captured));
  });

  it("legacy openai chat parallel tool call stream produces committed events", async () => {
    const driver = new OpenAICompatibleDriver();
    const req: StreamRequest = {
      model: "praana-fixture-model",
      provider: "openai",
      systemPrompt: "You are a deterministic fixture agent.",
      messages: [
        { role: "user", content: "Read src/main.ts and grep for fixture-anchor in parallel." },
      ],
    };
    const events = await collectDriverEvents(driver, req, OPENAI_AUTH);
    compareEventsJsonl("legacy-ts/openai-chat/parallel-tools.events.jsonl", events);
  });

  it("legacy openai responses basic request matches committed evidence", async () => {
    const driver = new OpenAIResponsesDriver();
    const req: StreamRequest = {
      model: "praana-fixture-model",
      provider: "openai-responses",
      systemPrompt: "You are a deterministic fixture agent.",
      messages: [{ role: "user", content: "Reply with the single word: ready." }],
    };
    await collectDriverEvents(driver, req, OPENAI_AUTH);
    const captured = lastCapturedRequest();
    const committed = readCommittedJson("legacy-ts/openai-responses/basic.request.json");
    expect(committed).toEqual(requestEvidence(captured));
  });

  it("legacy openai responses fragmented function call produces committed events", async () => {
    const driver = new OpenAIResponsesDriver();
    const req: StreamRequest = {
      model: "praana-fixture-model",
      provider: "openai-responses",
      systemPrompt: "You are a deterministic fixture agent.",
      messages: [{ role: "user", content: "Read src/main.ts." }],
      tools: [
        {
          name: "read_file",
          description: "Read a file from the workspace.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    };
    const events = await collectDriverEvents(driver, req, OPENAI_AUTH);
    compareEventsJsonl("legacy-ts/openai-responses/tool-call.events.jsonl", events);
  });

  it("legacy openrouter request url and headers match committed evidence", async () => {
    const driver = new OpenAICompatibleDriver();
    const req: StreamRequest = {
      model: "praana/openrouter-fixture-model",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      headers: OPENROUTER_HEADERS,
      systemPrompt: "You are a deterministic fixture agent.",
      messages: [{ role: "user", content: "Reply with the single word: ready." }],
    };
    await collectDriverEvents(driver, req, OPENROUTER_AUTH);
    const captured = lastCapturedRequest();
    const committedRequest = readCommittedJson("legacy-ts/openrouter-chat/basic.request.json");
    const committedHeaders = readCommittedJson("legacy-ts/openrouter-chat/basic.headers.json");
    expect(committedRequest).toEqual(requestEvidence(captured));
    expect(committedHeaders).toEqual(sanitizedHeaders(captured.headers));
  });

  it("legacy openrouter reasoning and cache usage produces committed events", async () => {
    const driver = new OpenAICompatibleDriver();
    const req: StreamRequest = {
      model: "praana/openrouter-fixture-model",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      headers: OPENROUTER_HEADERS,
      systemPrompt: "You are a deterministic fixture agent.",
      messages: [{ role: "user", content: "Think briefly, then reply: Fixture ready." }],
    };
    const events = await collectDriverEvents(driver, req, OPENROUTER_AUTH);
    compareEventsJsonl("legacy-ts/openrouter-chat/reasoning.events.jsonl", events);
  });

  it("provider fixtures contain no credentials or machine-specific values", () => {
    for (const rel of listFixtureFiles()) {
      const raw = readFileSync(fixturePath(rel), "latin1");
      const isSse = rel.endsWith(".sse");
      if (!isSse && raw.includes("\r")) {
        throw new Error(`${rel}: contains CR outside an SSE case`);
      }
      if (raw.includes("-----BEGIN")) {
        throw new Error(`${rel}: contains a PEM delimiter`);
      }
      if (/sk-[A-Za-z0-9]{16,}/.test(raw) && !raw.includes("sk-fixture-")) {
        throw new Error(`${rel}: contains a credential-like sk- value`);
      }
      if (/Bearer\s+[A-Za-z0-9]/.test(raw)) {
        throw new Error(`${rel}: contains an unredacted Bearer credential`);
      }
      if (/[A-Za-z]:\\/.test(raw)) {
        throw new Error(`${rel}: contains a Windows absolute path`);
      }
      if (raw.includes("/home/") || raw.includes("/Users/") || raw.includes("/tmp/")) {
        throw new Error(`${rel}: contains a machine-specific absolute path`);
      }
      if (raw.includes("encrypted_content")) {
        throw new Error(`${rel}: contains encrypted reasoning content`);
      }
      if (rel.endsWith(".json") || rel.endsWith(".jsonl")) {
        if (/\bNaN\b/.test(raw) || /\bInfinity\b/.test(raw)) {
          throw new Error(`${rel}: contains a non-finite number`);
        }
      }
    }
  });

  it("no real network target was contacted", () => {
    expect(fetchViolations).toEqual([]);
  });
});
