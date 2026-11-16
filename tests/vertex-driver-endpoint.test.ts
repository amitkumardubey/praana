import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import type { ResolvedAuth, StreamEvent } from "../src/llm/types.js";
import { googleSse } from "./helpers/google-thought-signature.js";
import { useCleanVertexEnv } from "./helpers/vertex-env.js";

useCleanVertexEnv();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const fakeToken = ["fake", "vertex", "access"].join("-");

async function run(provider = "vertex", auth: ResolvedAuth = { bearerToken: fakeToken }) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return googleSse([{ text: "ok" }]);
  }) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const event of new GoogleDriver().stream({ provider, model: "gemini-test", messages: [] }, auth)) events.push(event);
  return { events, calls };
}

function refusal(events: StreamEvent[]) {
  const error = events.find((e) => e.type === "error");
  expect(error).toBeDefined();
  if (!error || error.type !== "error") throw new Error("Expected error event");
  expect(error.status).toBeUndefined();
  expect(error.retryable).toBe(false);
  return error.error.message;
}

test("global host is unprefixed; regional hosts and AI Studio remain unchanged", async () => {
  process.env.VERTEX_PROJECT_ID = "example.com:fake-project";
  let result = await run();
  expect(result.calls[0].url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/example.com:fake-project/locations/us-central1/publishers/google/models/gemini-test:streamGenerateContent?alt=sse");
  process.env.VERTEX_REGION = "europe-west4";
  expect((await run()).calls[0].url).toContain("https://europe-west4-aiplatform.googleapis.com/");
  process.env.VERTEX_REGION = "global";
  const studio = await run("google", { apiKey: fakeToken });
  expect(studio.calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
  expect(studio.calls[0].headers.get("x-goog-api-key")).toBe(fakeToken);
  expect(studio.calls[0].headers.has("authorization")).toBe(false);
  result = await run();
  expect(result.events.some((e) => e.type === "done")).toBe(true);
  expect(result.calls[0].headers.get("authorization")).toBe(`Bearer ${fakeToken}`);
  expect(result.calls[0].url).toBe("https://aiplatform.googleapis.com/v1/projects/example.com:fake-project/locations/global/publishers/google/models/gemini-test:streamGenerateContent?alt=sse");
});

test("location uses GOOGLE_CLOUD_LOCATION below VERTEX_REGION", async () => {
  process.env.VERTEX_PROJECT_ID = "fake-project";
  process.env.GOOGLE_CLOUD_LOCATION = "europe-west4";
  expect((await run()).calls[0].url).toContain("/locations/europe-west4/");
  process.env.VERTEX_REGION = "global";
  expect((await run()).calls[0].url).toContain("/locations/global/");
});

test("project env precedence is VERTEX_PROJECT_ID > GOOGLE_CLOUD_PROJECT > GCP_PROJECT", async () => {
  process.env.GCP_PROJECT = "fake-gcp";
  expect((await run()).calls[0].url).toContain("/projects/fake-gcp/");
  process.env.GOOGLE_CLOUD_PROJECT = "fake-google";
  expect((await run()).calls[0].url).toContain("/projects/fake-google/");
  process.env.VERTEX_PROJECT_ID = "fake-vertex";
  expect((await run()).calls[0].url).toContain("/projects/fake-vertex/");
});

test.each(["VERTEX_REGION", "GOOGLE_CLOUD_LOCATION"])("trims padded %s", async (key) => {
  process.env.VERTEX_PROJECT_ID = "fake-project";
  process.env[key] = "  global\n";
  const { calls } = await run();
  expect(calls[0]?.url).toContain("/locations/global/");
});

test.each(["VERTEX_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT"])("trims padded %s", async (key) => {
  process.env[key] = "  fake-project\n";
  const { calls } = await run();
  expect(calls[0]?.url).toContain("/projects/fake-project/");
});

test("missing project refuses before auth or fetch and never claims an HTTP 401", async () => {
  const { events, calls } = await run("vertex", {});
  expect(refusal(events)).toBe("Vertex AI project is not set: set VERTEX_PROJECT_ID or GOOGLE_CLOUD_PROJECT");
  expect(calls).toHaveLength(0);
});

test.each(["service_account", "authorized_user"])("project falls back to the correct field in %s files", async (type) => {
  const file = join(process.env.CLOUDSDK_CONFIG!, "fake-project.json");
  writeFileSync(file, JSON.stringify({ type, project_id: "fake-service", quota_project_id: "fake-quota" }));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
  // An env access token still wins for auth, but its ADC file may supply the project.
  process.env.GCP_ACCESS_TOKEN = fakeToken;
  const expected = type === "service_account" ? "fake-service" : "fake-quota";
  expect((await run()).calls[0].url).toContain(`/projects/${expected}/`);
  process.env.GCP_PROJECT = "fake-env";
  expect((await run()).calls[0].url).toContain("/projects/fake-env/");
});

test("project discovery uses env file, stored path, then well-known ADC", async () => {
  const dir = process.env.CLOUDSDK_CONFIG!;
  const envFile = join(dir, "env.json");
  const storedFile = join(dir, "stored.json");
  const ambientFile = join(dir, "application_default_credentials.json");
  for (const [file, project] of [[envFile, "fake-env"], [storedFile, "fake-stored"], [ambientFile, "fake-ambient"]]) {
    writeFileSync(file, JSON.stringify({ type: "service_account", project_id: project }));
  }
  process.env.GCP_ACCESS_TOKEN = fakeToken;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = envFile;
  expect((await run("vertex", { apiKey: storedFile })).calls[0].url).toContain("/projects/fake-env/");
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  expect((await run("vertex", { apiKey: storedFile })).calls[0].url).toContain("/projects/fake-stored/");
  expect((await run()).calls[0].url).toContain("/projects/fake-ambient/");
});

test.each([null, 17, {}, ["fake-project"]].map((project) => [project]))("non-string credential project %p is not interpolated", async (project_id) => {
  const file = join(process.env.CLOUDSDK_CONFIG!, "invalid-project.json");
  writeFileSync(file, JSON.stringify({ type: "service_account", project_id, quota_project_id: "wrong-field" }));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
  const { events, calls } = await run();
  expect(refusal(events)).toContain("Vertex AI project is not set");
  expect(calls).toHaveLength(0);
});
