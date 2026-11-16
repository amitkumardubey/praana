import { afterEach, expect, test } from "bun:test";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { ProviderHttpError } from "../src/llm/stream-guard.js";
import type { StreamEvent } from "../src/llm/types.js";
import { useCleanVertexEnv } from "./helpers/vertex-env.js";

useCleanVertexEnv();
const originalFetch = globalThis.fetch;
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => { globalThis.fetch = originalFetch; server?.stop(true); server = undefined; });

test("real Vertex HTTP 404 retains Google's message plus one location hint, scoped to Vertex 404 only", async () => {
  const message = "Scripted Google message: model not found for this location";
  let status = 400;
  let requests = 0;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    return Response.json({ error: { message } }, { status });
  } });
  // The only socket this injected fetch can reach is the scripted loopback server.
  globalThis.fetch = (async (_input, init) => originalFetch(server!.url, init)) as typeof fetch;
  process.env.VERTEX_PROJECT_ID = "fake-project";
  process.env.VERTEX_REGION = "global";
  const fakeToken = ["obviously", "fake", "access"].join("-");
  const run = async (provider: string) => {
    const events: StreamEvent[] = [];
    for await (const event of new GoogleDriver().stream({ provider, model: "gemini-test", messages: [] }, { bearerToken: fakeToken })) events.push(event);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event.type !== "error") throw new Error("Expected HTTP error event");
    expect(event.status).toBe(status);
    expect(event.retryable).toBe(false);
    expect(event.error).toBeInstanceOf(ProviderHttpError);
    expect(event.error.message).toContain(message);
    expect(event.error.message).not.toContain(fakeToken);
    return event.error.message;
  };
  expect(await run("vertex")).not.toContain("VERTEX_REGION");
  status = 404;
  expect(await run("google")).not.toContain("VERTEX_REGION");
  const vertex404 = await run("vertex");
  expect(vertex404).toContain("model or location is not available to this project");
  expect(vertex404.match(/VERTEX_REGION/g)).toHaveLength(1);
  expect(vertex404).toContain("global");
  expect(vertex404).toContain("Gemini 3 and later models need global, us or eu");
  expect(requests).toBe(3);
});
