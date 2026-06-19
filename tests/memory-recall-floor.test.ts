import { describe, it, expect } from "vitest";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import { MemoryStore } from "../src/memory/index.js";

describe("recall min score floor for digest", () => {
  it("excludes low-score entries from digest markdown", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new DeterministicTestEmbedder(),
    });

    const ctx = {
      agent: "praana",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
      recall_min_score: 0.35,
    };

    await store.sessionStart(ctx);
    await store.remember("Strong preference: use Vitest", {
      kind: "preference",
      certainty: "high",
    });
    await store.remember("Weak vague note", { kind: "fact", certainty: "low" });
    await store.sessionEnd("clean");

    const staleLastSeen = Date.now() - 120 * 86_400_000;
    for (const entry of store.getAllEntries()) {
      if (entry.content.includes("Weak vague")) {
        store["db"]
          .prepare("UPDATE entries SET created_at = ?, confidence = 0.05 WHERE id = ?")
          .run(staleLastSeen, entry.id);
      }
    }

    const digest = await store.sessionStart(ctx);
    expect(digest.markdown).toContain("Strong preference");
    expect(digest.markdown).not.toContain("Weak vague note");
  });
});
