import { describe, it, expect, mock } from "bun:test";
import {
  extractLearnings,
  MAX_LEARNING_CONTENT_CHARS,
  normalizeLearningContent,
  summarizeTurns,
} from "../src/memory/summarizer.js";
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

describe("normalizeLearningContent", () => {
  it("collapses whitespace and strips leading bullets", () => {
    expect(normalizeLearningContent("  -  uses\nbun\tfor tests  ")).toBe("uses bun for tests");
    expect(normalizeLearningContent("* prefer dark mode")).toBe("prefer dark mode");
    expect(normalizeLearningContent("1. write tests first")).toBe("write tests first");
    expect(normalizeLearningContent("2) keep in-process rate limits")).toBe(
      "keep in-process rate limits",
    );
  });

  it("keeps only the first sentence from a paragraph", () => {
    const paragraph =
      "Session log is events.jsonl, not current.log. " +
      "After discussing logging we also covered symlink races and resume prefixes.";
    expect(normalizeLearningContent(paragraph)).toBe(
      "Session log is events.jsonl, not current.log.",
    );
  });

  it("truncates long single sentences at a word boundary", () => {
    const long =
      "chose a very long architectural approach involving many nested systems and " +
      "additional constraints that make this learning exceed the hard character limit easily";
    const normalized = normalizeLearningContent(long);
    expect(normalized).not.toBeNull();
    expect(normalized!.length).toBeLessThanOrEqual(MAX_LEARNING_CONTENT_CHARS);
    expect(normalized).not.toMatch(/\s$/);
  });

  it("returns null for empty or whitespace-only content", () => {
    expect(normalizeLearningContent("")).toBeNull();
    expect(normalizeLearningContent("   \n\t  ")).toBeNull();
    expect(normalizeLearningContent("-   ")).toBeNull();
  });
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

  it("normalizes verbose paragraphs into key points", async () => {
    const llm = createMockLLM(JSON.stringify({
      learnings: [
        {
          kind: "fact",
          content:
            "- Session log is events.jsonl, not current.log.\n\n" +
            "We also talked about symlink races and how resume prefixes work in practice.",
          certainty: "high",
          scope: "project",
        },
      ],
      used_ids: [],
    }));

    const result = await extractLearnings(llm, [userMessage("where is the session log?")]);

    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].content).toBe("Session log is events.jsonl, not current.log.");
    expect(result.learnings[0].content.length).toBeLessThanOrEqual(MAX_LEARNING_CONTENT_CHARS);
  });

  it("drops learnings whose content is empty after normalization", async () => {
    const llm = createMockLLM(JSON.stringify({
      learnings: [
        { kind: "fact", content: "   ", certainty: "high" },
        { kind: "preference", content: "-  ", certainty: "medium" },
        { kind: "decision", content: "use bun", certainty: "high" },
      ],
      used_ids: [],
    }));

    const result = await extractLearnings(llm, [userMessage("hello")]);

    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].content).toBe("use bun");
  });

  it("asks the LLM for scannable key points within the char limit", async () => {
    const llm = createMockLLM('{"learnings": []}');
    await extractLearnings(llm, [userMessage("hello")]);

    const call = (llm.complete as ReturnType<typeof mock>).mock.calls[0] as [{ system: string }];
    expect(call[0].system).toContain("scannable key point");
    expect(call[0].system).toContain(`max ${MAX_LEARNING_CONTENT_CHARS} chars`);
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

describe("summarizeTurns", () => {
  it("normalizes compressed turn facts into key points", async () => {
    const llm = createMockLLM(JSON.stringify([
      {
        kind: "fact",
        content: "* Migrated session log path to events.jsonl. Also discussed unrelated resume quirks.",
        certainty: "high",
      },
      { kind: "decision", content: "   ", certainty: "medium" },
    ]));

    const facts = await summarizeTurns(llm, [userMessage("compress me")]);

    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Migrated session log path to events.jsonl.");
    expect(facts[0].content.length).toBeLessThanOrEqual(MAX_LEARNING_CONTENT_CHARS);
  });
});
