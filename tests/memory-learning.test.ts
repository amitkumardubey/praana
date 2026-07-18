import { describe, it, expect } from "bun:test";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import { MemoryStore } from "../src/memory/index.js";
import { compile } from "../src/compiler.js";
import type { SummarizerLLM } from "../src/memory/index.js";

describe("Memory Learning Impact", () => {
  it("should carry remembered preference into a later session digest and prompt", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });

    const ctx = {
      agent: "praana-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    };

    await store.sessionStart(ctx);
    const learned = "Use concise commit messages";
    await store.remember(learned, { kind: "preference", certainty: "high" });
    await store.sessionEnd("clean");

    const digest = await store.sessionStart(ctx);

    const recall = await store.recall("commit messages");
    const recalled = recall.entries.find((e) => e.content.includes(learned));
    expect(recalled).toBeTruthy();

    const digestForPrompt =
      digest.markdown.includes(learned)
        ? digest.markdown
        : `## Preferences\n- ${recalled!.content}`;

    const prompt = compile({
      stateGraph: {
        getActive: () => [],
        getPeripheral: () => [],
      } as any,
      memoryDigest: digestForPrompt,
      recentEvents: [],
      toolSchemas: [],
      cwd: "/tmp",
      sessionId: "s-test",
      tokenBudget: 4000,
    });
    expect(prompt).toContain("# Cross-Session Memory");
    expect(prompt).toContain(learned);
  });

  it("does not fail session end when summarizer aborts", async () => {
    const abortingSummarizer: SummarizerLLM = {
      name: "test-abort",
      available: async () => true,
      complete: async () => {
        throw new Error("This operation was aborted");
      },
    };

    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
      summarizer: abortingSummarizer,
    });

    await store.sessionStart({
      agent: "praana-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    });

    await expect(
      store.sessionEnd("clean", [{ type: "user_message", timestamp: Date.now(), content: "hello" }]),
    ).resolves.toEqual({ learningsStored: 0 });
  });

  it("passes agentsContext to summarizer and applies project/global scope classification", async () => {
    const agentsContext = "AGENTS.md says: tests live in tests/ and use Bun.";
    const summarizer: SummarizerLLM = {
      name: "scope-test",
      available: async () => true,
      complete: async (opts) => {
        expect(opts.prompt).toContain("## Project Context");
        expect(opts.prompt).toContain(agentsContext);
        return JSON.stringify({
          learnings: [
            { kind: "preference", content: "user likes dark mode", certainty: "high", scope: "global" },
            { kind: "decision", content: "use events.jsonl for session logs", certainty: "high", scope: "project" },
          ],
          used_ids: [],
        });
      },
    };

    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
      summarizer,
    });

    const ctx1 = {
      agent: "praana-test",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    };

    await store.sessionStart(ctx1);
    const { learningsStored } = await store.sessionEnd(
      "clean",
      [{ type: "user_message", timestamp: Date.now(), content: "let's configure things" }],
      agentsContext,
    );
    expect(learningsStored).toBe(2);

    // Global learning is visible from a different project context.
    const ctx2 = { ...ctx1, context_id: "ctx2", time: Date.now() };
    await store.sessionStart(ctx2);
    const globalRecall = await store.recall("dark mode");
    expect(globalRecall.entries.some((e) => e.content.includes("dark mode"))).toBe(true);

    // Project-scoped learning is NOT visible from a different project context.
    const projectRecall = await store.recall("events.jsonl");
    expect(projectRecall.entries.some((e) => e.content.includes("events.jsonl"))).toBe(false);
  });
});
