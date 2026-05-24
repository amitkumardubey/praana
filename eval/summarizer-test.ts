#!/usr/bin/env node
/**
 * ARIA Summarizer Test
 */

import { MemoryStore, HashEmbedder, OpenAISummarizer } from "../src/memory/index.js";

type SessionEvent = import("../src/memory/index.js").SessionEvent;

function createTranscript(): SessionEvent[] {
  return [
    { type: "user_message", timestamp: Date.now(), content: "Fix the auth middleware — users are getting 401s" },
    { type: "agent_message", timestamp: Date.now() + 1000, content: "I'll check the auth middleware. Let me read the file first." },
    { type: "tool_use", timestamp: Date.now() + 2000, tool_name: "read_file", args: { path: "src/middleware/auth.ts" } },
    { type: "tool_result", timestamp: Date.now() + 3000, tool_name: "read_file", result: "export function auth(req) { if (!req.headers.authorization) return 401; verify(req.headers.authorization); }" },
    { type: "agent_message", timestamp: Date.now() + 4000, content: "Found it — we're calling verify() synchronously but it returns a Promise. Need to await it." },
    { type: "tool_use", timestamp: Date.now() + 5000, tool_name: "edit_file", args: { path: "src/middleware/auth.ts", oldText: "verify(req.headers.authorization);", newText: "await verify(req.headers.authorization);" } },
    { type: "user_message", timestamp: Date.now() + 6000, content: "Also, set up Vitest for testing" },
    { type: "agent_message", timestamp: Date.now() + 7000, content: "I'll install Vitest and create a basic config." },
    { type: "tool_use", timestamp: Date.now() + 8000, tool_name: "shell", args: { command: "npm install -D vitest" } },
    { type: "agent_message", timestamp: Date.now() + 9000, content: "Done. Vitest is now the test runner for this project." },
  ];
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log("SKIP: Set OPENROUTER_API_KEY to run this test.");
    process.exit(0);
  }

  const model = process.env.BODHA_SUMMARIZER_MODEL ?? "google/gemini-2.5-flash";
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ARIA Summarizer Test");
  console.log(`  Model: ${model}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const summarizer = new OpenAISummarizer({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    model,
  });

  const store = new MemoryStore({
    dbPath: ":memory:",
    embedder: new HashEmbedder(),
    summarizer,
  });

  const ctx = { agent: "aria", user_id: "u1", time: Date.now(), context_id: "ctx-summ", context_label: "test" };
  await store.sessionStart(ctx);

  const start = Date.now();
  await store.sessionEnd("clean", createTranscript());
  const elapsed = Date.now() - start;

  const entries = store.getAllEntries();
  console.log(`Pipeline completed in ${elapsed}ms`);
  console.log(`  Learnings extracted: ${entries.length}\n`);

  for (const e of entries) {
    console.log(`  [${e.kind}] ${e.content}`);
  }

  const hasAsyncMistake = entries.some((e) =>
    e.kind === "mistake" && (e.content.includes("await") || e.content.includes("async"))
  );
  const hasVitest = entries.some((e) => e.content.includes("Vitest"));

  console.log(`\nHas async mistake: ${hasAsyncMistake ? "✅" : "❌"}`);
  console.log(`Has Vitest pref:   ${hasVitest ? "✅" : "❌"}`);
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
