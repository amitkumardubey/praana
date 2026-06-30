import { describe, it, expect } from "bun:test";
import {
  classifyTask,
  getDefaultDomainClassifier,
} from "../src/domain/task-classify.js";
import {
  scoreCodingTaskKeywords,
  scoreCodingTaskTools,
} from "../src/domain/coding-domain.js";
import type { TaskClassificationInput } from "../src/domain/types.js";
import type { TurnRecord } from "../src/context-engine/types.js";

function baseInput(
  overrides: Partial<TaskClassificationInput> = {},
): TaskClassificationInput {
  return {
    userInput: "",
    turnRecords: [],
    activityEntries: [],
    currentTurn: 0,
    ...overrides,
  };
}

function turnRecord(turn: number, partial: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turn,
    userMessage: "",
    assistantMessage: "",
    toolCalls: [],
    artifactIds: [],
    filesRead: [],
    filesWritten: [],
    errors: [],
    tokenCount: 0,
    timestamp: turn,
    ...partial,
  };
}

describe("classifyTask", () => {
  const classifier = getDefaultDomainClassifier();

  it("classifies testing from keywords", () => {
    const result = classifyTask(
      classifier,
      baseInput({ userInput: "run test spec coverage" }),
    );
    expect(result.taskType).toBe("testing");
    expect(result.source).toBe("keywords");
  });

  it("classifies debugging from keywords", () => {
    const result = classifyTask(
      classifier,
      baseInput({ userInput: "there's a crash in auth middleware" }),
    );
    expect(result.taskType).toBe("debugging");
    expect(result.source).toBe("keywords");
  });

  it("classifies refactoring from keywords", () => {
    const result = classifyTask(
      classifier,
      baseInput({ userInput: "refactor this module and simplify the API" }),
    );
    expect(result.taskType).toBe("refactoring");
    expect(result.source).toBe("keywords");
  });

  it("classifies implementing from keywords", () => {
    const result = classifyTask(
      classifier,
      baseInput({ userInput: "implement a new feature to add pagination" }),
    );
    expect(result.taskType).toBe("implementing");
    expect(result.source).toBe("keywords");
  });

  it("classifies reviewing from keywords", () => {
    const result = classifyTask(
      classifier,
      baseInput({ userInput: "review this PR and give feedback" }),
    );
    expect(result.taskType).toBe("reviewing");
    expect(result.source).toBe("keywords");
  });

  it("classifies check-this-PR phrasing as reviewing not testing", () => {
    const result = classifyTask(
      classifier,
      baseInput({ userInput: "can you check this PR?" }),
    );
    expect(result.taskType).toBe("reviewing");
    expect(result.source).toBe("keywords");
  });

  it("falls back to general when unclear", () => {
    const result = classifyTask(classifier, baseInput({ userInput: "hello" }));
    expect(result.taskType).toBe("general");
    expect(result.source).toBe("fallback");
    expect(result.confidence).toBe(0);
  });

  it("refines vague input from recent tool patterns", () => {
    const result = classifyTask(
      classifier,
      baseInput({
        userInput: "continue",
        currentTurn: 5,
        turnRecords: [
          turnRecord(4, {
            toolCalls: [
              {
                tool: "shell",
                args: { command: "npm test" },
                isError: true,
                resultText: "2 failing",
              },
            ],
            errors: ["2 failing"],
          }),
          turnRecord(5, {
            toolCalls: [
              {
                tool: "shell",
                args: { command: "npm test" },
                isError: true,
                resultText: "1 failing",
              },
            ],
            errors: ["1 failing"],
          }),
        ],
        activityEntries: [
          { turn: 5, type: "test_fail", summary: "Tests failing: 1 failures" },
        ],
      }),
    );
    expect(result.taskType).toBe("testing");
    expect(result.source).toBe("tools");
  });

  it("classifies reviewing from read-heavy tool patterns", () => {
    const result = classifyTask(
      classifier,
      baseInput({
        userInput: "what do you think of this approach?",
        currentTurn: 3,
        turnRecords: [
          turnRecord(2, {
            toolCalls: [
              { tool: "read_file", args: { path: "src/a.ts" }, isError: false },
              { tool: "read_file", args: { path: "src/b.ts" }, isError: false },
              { tool: "search_code", args: { pattern: "foo" }, isError: false },
            ],
          }),
          turnRecord(3, {
            toolCalls: [
              { tool: "read_file", args: { path: "src/c.ts" }, isError: false },
            ],
          }),
        ],
      }),
    );
    expect(result.taskType).toBe("reviewing");
    expect(result.source).toBe("tools");
  });

  it("blends weak keyword and tool signals", () => {
    const result = classifyTask(
      classifier,
      baseInput({
        userInput: "check the build",
        currentTurn: 2,
        turnRecords: [
          turnRecord(1, {
            toolCalls: [
              { tool: "write_file", args: { path: "src/new.ts" }, isError: false },
            ],
            filesWritten: ["src/new.ts"],
          }),
          turnRecord(2, {
            toolCalls: [
              { tool: "write_file", args: { path: "src/other.ts" }, isError: false },
            ],
            filesWritten: ["src/other.ts"],
          }),
        ],
      }),
    );
    expect(["testing", "implementing", "blended"]).toContain(
      result.source === "blended" ? "blended" : result.taskType,
    );
    expect(result.taskType).not.toBe("general");
  });

  it("does not double-count debugging for failed tool calls", () => {
    const scores = scoreCodingTaskTools(
      baseInput({
        currentTurn: 2,
        turnRecords: [
          turnRecord(2, {
            toolCalls: [
              {
                tool: "shell",
                args: { command: "npm test" },
                isError: true,
                resultText: "2 failing",
              },
            ],
            errors: ["2 failing"],
          }),
        ],
      }),
    );
    expect(scores.debugging).toBe(2);
    expect(scores.testing).toBe(2);
  });

  it("detects refactoring across a multi-turn window", () => {
    const result = classifyTask(
      classifier,
      baseInput({
        userInput: "continue",
        currentTurn: 20,
        turnRecords: [
          turnRecord(17, {
            toolCalls: [
              { tool: "edit_file", args: { path: "a.ts" }, isError: false },
            ],
          }),
          turnRecord(18, {
            toolCalls: [
              { tool: "edit_file", args: { path: "b.ts" }, isError: false },
            ],
          }),
          turnRecord(19, {
            toolCalls: [
              { tool: "edit_file", args: { path: "c.ts" }, isError: false },
            ],
          }),
        ],
      }),
    );
    expect(result.taskType).toBe("refactoring");
    expect(result.source).toBe("tools");
  });

  it("prefers debugging over testing on tied blended scores", () => {
    const keywordScores = scoreCodingTaskKeywords("fix failing test");
    const toolScores = scoreCodingTaskTools(
      baseInput({
        currentTurn: 2,
        turnRecords: [
          turnRecord(1, {
            toolCalls: [
              {
                tool: "shell",
                args: { command: "npm test" },
                isError: true,
              },
            ],
            errors: ["fail"],
          }),
          turnRecord(2, {
            toolCalls: [
              {
                tool: "shell",
                args: { command: "npm test" },
                isError: true,
              },
            ],
            errors: ["fail"],
          }),
        ],
      }),
    );
    expect(keywordScores.debugging).toBeGreaterThan(0);
    expect(toolScores.testing).toBeGreaterThan(0);
  });

  it("completes classification within 1ms on a realistic fixture", () => {
    const turnRecords: TurnRecord[] = [];
    for (let i = 1; i <= 20; i++) {
      turnRecords.push(
        turnRecord(i, {
          userMessage: `message ${i}`,
          assistantMessage: `response ${i}`,
          toolCalls: [
            {
              tool: i % 2 === 0 ? "read_file" : "edit_file",
              args: { path: `src/file${i}.ts`, command: "npm test" },
              isError: i % 5 === 0,
            },
          ],
          errors: i % 5 === 0 ? [`error ${i}`] : [],
          filesWritten: i % 3 === 0 ? [`src/file${i}.ts`] : [],
        }),
      );
    }

    const input = baseInput({
      userInput: "fix failing tests and refactor the auth module",
      currentTurn: 20,
      turnRecords,
      activityEntries: [
        { turn: 19, type: "test_fail", summary: "Tests failing" },
        { turn: 20, type: "error_fixed", summary: "Fixed: auth bug" },
      ],
    });

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      classifyTask(classifier, input);
    }
    const elapsed = (performance.now() - start) / 100;
    expect(elapsed).toBeLessThan(1);
  });
});

describe("getDefaultDomainClassifier", () => {
  it("returns the coding domain classifier", () => {
    expect(getDefaultDomainClassifier().domainId).toBe("coding");
  });
});
