import { describe, it, expect, mock } from "bun:test";
import { extractLearnings } from "../src/memory/summarizer.js";
import type { SessionEvent, SummarizerLLM } from "../src/memory/types.js";

function createMockLLM(response: string): SummarizerLLM {
  return {
    name: "test-llm",
    available: mock().mockResolvedValue(true),
    complete: mock().mockResolvedValue(response),
  };
}

const userMessage = (content: string): SessionEvent => ({
  type: "user_message",
  timestamp: Date.now(),
  content,
});

describe("extractLearnings", () => {
  it("returns empty result when there are no events", async () => {
    const llm = createMockLLM('{"learnings": []}');
    const result = await extractLearnings(llm, []);
    expect(result.learnings).toEqual([]);
    expect(result.usedIds.size).toBe(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("extracts learnings with project and global scope", async () => {
    const llm = createMockLLM(JSON.stringify({
      learnings: [
        { kind: "preference", content: "user prefers dark mode", certainty: "high", scope: "global" },
        { kind: "decision", content: "use bun instead of npm", certainty: "medium", scope: "project" },
      ],
      used_ids: [],
    }));

    const result = await extractLearnings(llm, [userMessage("let's set up the project")]);

    expect(result.learnings).toHaveLength(2);
    expect(result.learnings[0]).toMatchObject({
      kind: "preference",
      content: "user prefers dark mode",
      certainty: "high",
      scope: "global",
    });
    expect(result.learnings[1]).toMatchObject({
      kind: "decision",
      content: "use bun instead of npm",
      certainty: "medium",
      scope: "project",
    });
  });

  it("ignores invalid scope values", async () => {
    const llm = createMockLLM(JSON.stringify({
      learnings: [
        { kind: "fact", content: "tests are good", certainty: "high", scope: "unknown" },
        { kind: "pattern", content: "write tests first", certainty: "medium" },
      ],
      used_ids: [],
    }));

    const result = await extractLearnings(llm, [userMessage("test")]);

    expect(result.learnings[0].scope).toBeUndefined();
    expect(result.learnings[1].scope).toBeUndefined();
  });

  it("passes projectContext to the LLM prompt", async () => {
    const llm = createMockLLM('{"learnings": []}');
    const projectContext = "Project uses Bun and TypeScript. Tests live in tests/.";

    await extractLearnings(llm, [userMessage("hello")], undefined, { projectContext });

    expect(llm.complete).toHaveBeenCalled();
    const call = (llm.complete as ReturnType<typeof mock>).mock.calls[0] as [{ prompt: string }];
    expect(call[0].prompt).toContain("## Project Context");
    expect(call[0].prompt).toContain(projectContext);
    expect(call[0].prompt).toContain("## Session transcript");
  });

  it("trims long projectContext to stay within budget", async () => {
    const llm = createMockLLM('{"learnings": []}');
    const projectContext = "a".repeat(5000);

    await extractLearnings(llm, [userMessage("hello")], undefined, { projectContext });

    const call = (llm.complete as ReturnType<typeof mock>).mock.calls[0] as [{ prompt: string }];
    const prompt = call[0].prompt;
    const contextSection = prompt.split("## Session transcript")[0];
    expect(contextSection.length).toBeLessThan(2500);
    expect(contextSection).toContain("...");
  });

  it("supports old top-level array format for back-compat", async () => {
    const llm = createMockLLM(JSON.stringify([
      { kind: "fact", content: "session logs are events.jsonl", certainty: "high" },
    ]));

    const result = await extractLearnings(llm, [userMessage("hello")]);

    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0]).toMatchObject({
      kind: "fact",
      content: "session logs are events.jsonl",
      certainty: "high",
    });
  });

  it("returns used_ids filtered to surfaced entries", async () => {
    const llm = createMockLLM(JSON.stringify({
      learnings: [],
      used_ids: ["id-1", "id-2", "id-unknown"],
    }));

    const surfaced = [
      { id: "id-1", content: "preference A" },
      { id: "id-2", content: "fact B" },
    ];

    const result = await extractLearnings(llm, [userMessage("use preference A and fact B")], surfaced);

    expect([...result.usedIds]).toEqual(["id-1", "id-2"]);
  });

  it("returns empty result when summarizer is unavailable", async () => {
    const llm: SummarizerLLM = {
      name: "unavailable-llm",
      available: mock().mockResolvedValue(false),
      complete: mock(),
    };

    const result = await extractLearnings(llm, [userMessage("hello")]);

    expect(result.learnings).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("returns empty result on malformed JSON", async () => {
    const llm = createMockLLM("not valid json {");

    const result = await extractLearnings(llm, [userMessage("hello")]);

    expect(result.learnings).toEqual([]);
    expect(result.usedIds.size).toBe(0);
  });
});
