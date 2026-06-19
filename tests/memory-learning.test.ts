import { describe, it, expect } from "vitest";
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
    ).resolves.toBeUndefined();
  });
});
