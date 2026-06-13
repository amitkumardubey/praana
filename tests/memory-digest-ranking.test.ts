import { describe, it, expect } from "vitest";
import { MemoryStore, HashEmbedder } from "../src/memory/index.js";
import { digestScore } from "../src/memory/confidence.js";
import type { MemoryEntry } from "../src/memory/types.js";

describe("per-kind digest ranking weights", () => {
  it("ranks constraints above mistakes at equal confidence", () => {
    const now = Date.now();
    const constraint: MemoryEntry = {
      id: "c1",
      kind: "constraint",
      content: "Never commit secrets",
      confidence: 0.6,
      pinned: false,
      layer: 1,
      confirmation_count: 0,
      created_at: now,
      last_seen_at: now,
      session_id: "s1",
      scopes: [],
    };
    const mistake: MemoryEntry = {
      ...constraint,
      id: "m1",
      kind: "mistake",
      content: "Forgot await once",
    };

    expect(digestScore(constraint, now)).toBeGreaterThan(digestScore(mistake, now));
  });

  it("includes higher-weight kinds earlier in digest markdown", async () => {
    const store = new MemoryStore({
      dbPath: ":memory:",
      embedder: new HashEmbedder(),
    });

    const ctx = {
      agent: "praana",
      user_id: "u1",
      time: Date.now(),
      context_id: "ctx1",
      context_label: "test",
    };

    await store.sessionStart(ctx);
    await store.remember("Recent mistake to avoid", { kind: "mistake", certainty: "high" });
    await store.remember("Never force-push main", { kind: "constraint", certainty: "high" });
    await store.sessionEnd("clean");

    const digest = await store.sessionStart(ctx);
    const constraintPos = digest.markdown.indexOf("Never force-push main");
    const mistakePos = digest.markdown.indexOf("Recent mistake to avoid");
    expect(constraintPos).toBeGreaterThanOrEqual(0);
    expect(mistakePos).toBeGreaterThanOrEqual(0);
    expect(constraintPos).toBeLessThan(mistakePos);
  });
});
