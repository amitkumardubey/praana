import { upsertUserProvider, removeUserProvider } from "../../src/provider-registry.js";
import type { PraanaConfig } from "../../src/types.js";

export type ScriptedCall = { name: string; args: Record<string, unknown> };
/** Local wire server: the real turn loop, registry, hooks and compilers remain intact. */
export function scriptedMemoryModel(config: PraanaConfig, script: ScriptedCall[][] = []) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push(await request.json());
      const calls = script[requests.length - 1] ?? [];
      const delta = calls.length
        ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `call-${requests.length}-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
        : { role: "assistant", content: "Done." };
      const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      return new Response(chunk({ id: "memory-script", choices: [{ index: 0, delta, finish_reason: null }] }) + chunk({ id: "memory-script", choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  const id = "file-memory-test";
  upsertUserProvider(id, { api: "openai-completions", base_url: `http://127.0.0.1:${server.port}/v1`, models: [{ id: "scripted", context_window: 128000 }] });
  config.llm = { provider: id, model: "scripted", context_window: 128000 };
  return { requests, close() { server.stop(true); removeUserProvider(id); } };
}
