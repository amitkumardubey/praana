import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCanonicalRecords } from "../src/canonical-transcript.js";
import { loadConfig } from "../src/config.js";
import { Session } from "../src/session.js";
import { runTurn } from "../src/turn.js";
import { googleSse, parallelCallParts, THOUGHT_SIGNATURE } from "./helpers/google-thought-signature.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.GEMINI_API_KEY;
const sessions: Session[] = [];
const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalKey;
  mock.restore();
  for (const server of servers.splice(0)) server.stop(true);
  for (const session of sessions.splice(0)) {
    session.eventLog.close();
    session.contextEngine?.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const engine of [false, true]) {
  test(`runTurn completes parallel Google tools when the scripted server requires the signature (engine=${engine})`, async () => {
    const requests: any[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const body = await request.json();
        requests.push(body);
        if (requests.length === 1) return googleSse(parallelCallParts());
        const parts = body.contents.find((content: any) => content.role === "model")?.parts;
        if (parts?.[0]?.thoughtSignature !== THOUGHT_SIGNATURE) {
          return Response.json({ error: { message: "Function call is missing a thought_signature in functionCall parts" } }, { status: 400 });
        }
        return googleSse([{ text: "Both files read." }]);
      },
    });
    servers.push(server);
    // Refuse any non-scripted network request, including incidental model probes.
    globalThis.fetch = (async (input, init) => {
      if (!String(input).startsWith(String(server.url))) throw new Error(`Unexpected network request: ${input}`);
      return originalFetch(input, init);
    }) as typeof fetch;
    process.env.GEMINI_API_KEY = "fake-scripted-key";
    const root = mkdtempSync(join(tmpdir(), "google-turn-"));
    roots.push(root);
    writeFileSync(join(root, "a.txt"), "file-a-contents\n");
    writeFileSync(join(root, "b.txt"), "file-b-contents\n");
    const config = loadConfig();
    config.session.log_dir = join(root, "logs");
    config.memory.enabled = false;
    config.memory.summarizer = "disabled";
    config.context_engine!.enabled = engine;
    config.context_engine!.llm_digest = false;
    config.native = { ...config.native!, enabled: false };
    config.skills.enabled = false;
    config.project_detection!.enabled = false;
    config.llm = { provider: "google", model: "gemini-test", base_url: String(server.url), context_window: 128000 };
    const session = Session.createNew("s", root, config);
    sessions.push(session);
    session.headless = true;
    spyOn(session, "ensureModelContextWindow").mockResolvedValue(128000);
    const errors: unknown[] = [];
    const answer = await runTurn(session, "Read a.txt and b.txt", undefined, { sink: { onError: error => errors.push(error) } });
    expect(requests).toHaveLength(2);
    expect(requests[1].contents[1].parts[0]).toHaveProperty("thoughtSignature", THOUGHT_SIGNATURE);
    expect(requests[1].contents[1].parts[1]).not.toHaveProperty("thoughtSignature");
    const results = requests[1].contents[2].parts;
    expect(results).toHaveLength(2);
    expect(results[0].functionResponse.response.output).toContain("file-a-contents");
    expect(results[1].functionResponse.response.output).toContain("file-b-contents");
    expect(errors).toEqual([]);
    expect(answer.trim()).toBe("Both files read.");
    expect(readCanonicalRecords(session.eventLog)[1]).toMatchObject({ kind: "assistant", message: { toolCalls: [{ thoughtSignature: THOUGHT_SIGNATURE }, {}] } });
    const toolEvents = session.eventLog.readAll().filter(event => event.kind === "tool_call");
    expect(toolEvents).toHaveLength(2);
    expect(JSON.stringify(toolEvents)).not.toContain("thoughtSignature");
  });
}
