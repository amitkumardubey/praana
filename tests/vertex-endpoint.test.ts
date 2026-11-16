import { afterEach, expect, test } from "bun:test";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import type { StreamEvent } from "../src/llm/types.js";
import { googleSse } from "./helpers/google-thought-signature.js";
import { useCleanVertexEnv } from "./helpers/vertex-env.js";

useCleanVertexEnv();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const cases = [
  ...["Global", "us/central1", "us-central1.evil.example", "us_central1", "us central1", "global?x=1", "%67lobal", " global-test"].map((value) => ["location", value]),
  ...[".", "..", "%2e%2e", "%2E%2E", "a/b", "a\\b", "a?b", "a#b", "a b", "a%20b", "a "].map((value) => ["project", value]),
  ...["projects/p/locations/l/endpoints/1", "publishers/google/models/gemini-x", "models/gemini-x", "gemini-x?alt=json", "gemini-x:generateContent", "gemini-x#frag", "%2e%2e", "..", ".", "gemini x", "", "123456"].map((value) => ["model", value]),
];

test.each(cases)("Vertex refuses unsafe %s %p before any request", async (kind, value) => {
  process.env.VERTEX_PROJECT_ID = kind === "project" ? value : "fake-project";
  process.env.VERTEX_REGION = kind === "location" ? value : "global";
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return googleSse([{ text: "ok" }]); }) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const event of new GoogleDriver().stream({ provider: "vertex", model: kind === "model" ? value : "gemini-test", messages: [] }, { bearerToken: ["fake", "access"].join("-") })) events.push(event);
  expect(requests).toBe(0);
  const error = events.find((e) => e.type === "error");
  expect(error).toBeDefined();
  if (error?.type === "error") {
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(false);
    expect(error.error.message).toMatch(/Vertex AI (location|project|model)|VERTEX_REGION/);
    if (value.length > 3) expect(error.error.message).not.toContain(value);
  }
});
