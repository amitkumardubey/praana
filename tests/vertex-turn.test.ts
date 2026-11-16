import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { resetCredentialStoreForTests } from "../src/credentials.js";
import { getMissingKeyMessage } from "../src/llm.js";
import { getAppLogger, setAppLogger } from "../src/logger.js";
import { resetUserProvidersForTests, setUserProviders } from "../src/provider-registry.js";
import { resetNativeLoadCache, setNativeEnabled } from "../src/native/index.js";
import { Session } from "../src/session.js";
import { runTurn } from "../src/turn.js";
import { useCleanVertexEnv } from "./helpers/vertex-env.js";
import { googleSse, parallelCallParts, THOUGHT_SIGNATURE } from "./helpers/google-thought-signature.js";

useCleanVertexEnv();
const originalFetch = globalThis.fetch;
const originalRandom = Math.random;
let savedHome: string | undefined;
let logger: ReturnType<typeof getAppLogger>;
const sessions: Session[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const fake = (kind: string) => ["obviously", "fake", kind].join("-");
beforeEach(() => {
  logger = getAppLogger();
  savedHome = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = process.env.CLOUDSDK_CONFIG;
  resetCredentialStoreForTests();
  resetUserProvidersForTests();
  let ids = 0;
  Math.random = () => ++ids / 2 ** 32;
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.end("aborted");
  for (const server of servers.splice(0)) server.stop(true);
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
  if (savedHome === undefined) delete process.env.PRAANA_HOME;
  else process.env.PRAANA_HOME = savedHome;
  resetCredentialStoreForTests();
  resetUserProvidersForTests();
  resetNativeLoadCache();
  setNativeEnabled(true);
  setAppLogger(logger);
});

for (const engine of [false, true]) {
  test(`ADC-only Vertex session completes real parallel-tool turns, built-in and declared (engine=${engine})`, async () => {
    const root = process.env.CLOUDSDK_CONFIG!;
    const credentialFile = join(root, "application_default_credentials.json");
    writeFileSync(credentialFile, JSON.stringify({ type: "authorized_user", client_id: fake("client"), client_secret: fake("secret"), refresh_token: fake("refresh"), quota_project_id: "fake-quota-project" }));
    const credentialBytes = readFileSync(credentialFile, "utf8");
    const configPath = join(root, "test.config.toml");
    writeFileSync(configPath, '[llm]\nprovider = "vertex"\nmodel = "gemini-future-test"\n');
    const config = loadConfig(configPath);
    expect(config.llm.model).toBe("gemini-future-test");
    expect(config.providers).toBeUndefined();
    config.session.log_dir = join(root, "sessions");
    config.memory.enabled = false;
    config.context_engine!.enabled = engine;
    config.context_engine!.measurement_mode = false;
    config.context_engine!.llm_digest = false;
    config.native = { ...config.native!, enabled: false };
    config.skills.enabled = false;
    config.project_detection!.enabled = false;
    config.llm.context_window = 128000;
    process.env.VERTEX_REGION = "global";
    writeFileSync(join(root, "a.txt"), "file-a-contents\n");
    writeFileSync(join(root, "b.txt"), "file-b-contents\n");

    let mints = 0;
    const requests: any[] = [];
    const headers: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/token") {
        mints++;
        const grant = new URLSearchParams(await request.text());
        if (grant.get("grant_type") !== "refresh_token") return new Response("Wrong grant", { status: 400 });
        return Response.json({ access_token: fake("adc-access"), expires_in: 3600 });
      }
      const body = await request.json();
      requests.push(body);
      headers.push(request.headers.get("authorization")!);
      if (requests.length % 2 === 1) return googleSse(parallelCallParts());
      const parts = body.contents.filter((c: any) => c.role === "model").at(-1)?.parts;
      if (parts?.[0]?.thoughtSignature !== THOUGHT_SIGNATURE) return new Response("Signature missing", { status: 400 });
      return googleSse([{ text: "Both files read." }]);
    } });
    servers.push(server);
    const llmUrls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return originalFetch(new URL("/token", server.url), init);
      if (url.startsWith("https://aiplatform.googleapis.com/")) {
        llmUrls.push(url);
        return originalFetch(new URL("/generate", server.url), init);
      }
      throw new Error("Unexpected network request in Vertex turn test");
    }) as typeof fetch;
    const session = await Session.create(root, config, { suppressLoggerStderr: true });
    sessions.push(session);
    session.headless = true;
    expect(!!session.contextEngine).toBe(engine); // Actually exercise each compiler, not config alone.
    const errors: unknown[] = [];
    const turn = () => runTurn(session, "Read a.txt and b.txt", undefined, { sink: { onError: (error) => errors.push(error) } });
    expect((await turn()).trim()).toBe("Both files read.");
    expect(getMissingKeyMessage("vertex")).toBeNull();
    expect(mints).toBe(1);
    expect(headers).toEqual([`Bearer ${fake("adc-access")}`, `Bearer ${fake("adc-access")}`]);
    expect(llmUrls[0]).toContain("/projects/fake-quota-project/locations/global/publishers/google/models/gemini-future-test:streamGenerateContent?alt=sse");
    expect(requests[1].contents.at(-1).parts).toHaveLength(2);
    const toolResults = JSON.stringify(requests[1].contents.at(-1));
    expect(toolResults).toContain(engine ? "a.txt" : "file-a-contents");
    expect(toolResults).toContain(engine ? "b.txt" : "file-b-contents");
    if (engine) expect(toolResults).toContain("[artifact:");

    // Preserve the pre-existing user-declared route, including its ignored dummy base_url.
    process.env.GCP_ACCESS_TOKEN = fake("static-access");
    setUserProviders({ vertex: { api: "google-generative-ai", env_key: "GCP_ACCESS_TOKEN", base_url: "https://unused.example.invalid" } });
    expect((await turn()).trim()).toBe("Both files read.");
    expect(mints).toBe(1);
    expect(headers.slice(2)).toEqual([`Bearer ${fake("static-access")}`, `Bearer ${fake("static-access")}`]);
    expect(errors).toEqual([]);
    expect(readFileSync(credentialFile, "utf8")).toBe(credentialBytes);
  });
}
