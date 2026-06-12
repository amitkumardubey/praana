import { describe, it, expect } from "vitest";
import {
  buildClassicSystemFrame,
  buildFullConversationHistory,
  compileClassicWithMetrics,
  excludeCurrentUserInputFromEvents,
} from "../src/compile-classic.js";
import type { Event } from "../src/types.js";

function makeEvent(
  kind: Event["kind"],
  payload: Record<string, unknown>,
  index: number,
): Event {
  return {
    event_id: `evt-${index}`,
    session_id: "sess-classic",
    timestamp: 1_000 + index,
    kind,
    actor: kind === "user_message" ? "user" : "agent",
    payload,
  };
}

describe("compile-classic", () => {
  it("builds a system frame without working-memory instructions", () => {
    const frame = buildClassicSystemFrame("/proj", "sess-1", [
      "shell(command) — Run a shell command",
    ]);

    expect(frame).toContain("ARIA");
    expect(frame).toContain("shell(command)");
    expect(frame).toContain("read_file on a SKILL.md");
    expect(frame).not.toContain("soft_unload");
    expect(frame).not.toContain("Active State");
  });

  it("includes project stack separately from agents project context", () => {
    const frame = buildClassicSystemFrame(
      "/proj",
      "sess-1",
      ["shell(command)"],
      "Follow AGENTS.md conventions.",
      "Project: aria\nLanguage: TypeScript",
    );

    expect(frame).toContain("## Project Context");
    expect(frame).toContain("Follow AGENTS.md conventions.");
    expect(frame).toContain("## Project Stack");
    expect(frame).toContain("Project: aria");
    const contextIdx = frame.indexOf("## Project Context");
    const stackIdx = frame.indexOf("## Project Stack");
    expect(stackIdx).toBeGreaterThan(contextIdx);
  });

  it("includes full verbatim tool results in conversation history", () => {
    const longResult = "x".repeat(2_000);
    const events = [
      makeEvent("user_message", { text: "run tests" }, 0),
      makeEvent("tool_call", { tool: "shell", args: { command: "npm test" } }, 1),
      makeEvent("tool_result", { tool: "shell", result: { ok: true, stdout: longResult } }, 2),
      makeEvent("agent_message", { text: "done" }, 3),
    ];

    const history = buildFullConversationHistory(events);
    expect(history).toContain(longResult);
    expect(history).not.toContain("truncated");
  });

  it("compiles classic prompt sections in order", () => {
    const events = [
      makeEvent("user_message", { text: "hello" }, 0),
      makeEvent("agent_message", { text: "hi there" }, 1),
    ];

    const { prompt, metrics } = compileClassicWithMetrics({
      cwd: "/proj",
      sessionId: "sess-1",
      toolSchemas: ["shell(command) — Run a shell command"],
      agentsContext: "Use TypeScript strict mode.",
      skillsCatalog: "## Available Skills\n\n- **git**: Git workflows (`/skills/git/SKILL.md`)",
      memoryDigest: "- Prefer small diffs",
      events,
      userInput: "next question",
    });

    const frameIdx = prompt.indexOf("# System");
    const skillsIdx = prompt.indexOf("## Available Skills");
    const memoryIdx = prompt.indexOf("# Cross-Session Memory");
    const historyIdx = prompt.indexOf("# Conversation History");
    const inputIdx = prompt.indexOf("## Current Input");

    expect(frameIdx).toBeGreaterThanOrEqual(0);
    expect(skillsIdx).toBeGreaterThan(frameIdx);
    expect(memoryIdx).toBeGreaterThan(skillsIdx);
    expect(historyIdx).toBeGreaterThan(memoryIdx);
    expect(inputIdx).toBeGreaterThan(historyIdx);
    expect(prompt).toContain("hi there");
    expect(metrics.recentTurnsTruncated).toBe(false);
    expect(metrics.activeStateTokens).toBe(0);
  });

  it("excludes context_action and system_note from conversation history", () => {
    const events = [
      makeEvent("user_message", { text: "hello" }, 0),
      makeEvent("context_action", { action: "setTier", id: "x" }, 1),
      makeEvent("system_note", { type: "memory_recall" }, 2),
      makeEvent("agent_message", { text: "hi" }, 3),
    ];

    const history = buildFullConversationHistory(events);
    expect(history).toContain("hello");
    expect(history).toContain("hi");
    expect(history).not.toContain("setTier");
    expect(history).not.toContain("memory_recall");
  });

  it("excludes duplicate current user input from history", () => {
    const events = [
      makeEvent("user_message", { text: "hello" }, 0),
      makeEvent("agent_message", { text: "hi there" }, 1),
      makeEvent("user_message", { text: "next question" }, 2),
    ];

    const { prompt } = compileClassicWithMetrics({
      cwd: "/proj",
      sessionId: "sess-1",
      toolSchemas: ["shell(command) — Run a shell command"],
      events,
      userInput: "next question",
    });

    const matches = prompt.match(/next question/g) ?? [];
    expect(matches.length).toBe(1);
    expect(prompt).toContain("## Current Input");
  });

  it("excludeCurrentUserInputFromEvents is a no-op when last message differs", () => {
    const events = [
      makeEvent("user_message", { text: "hello" }, 0),
      makeEvent("user_message", { text: "other" }, 1),
    ];
    expect(excludeCurrentUserInputFromEvents(events, "next question")).toHaveLength(2);
  });

  it("includes project stack in compiled classic prompt", () => {
    const { prompt } = compileClassicWithMetrics({
      cwd: "/proj",
      sessionId: "sess-1",
      toolSchemas: ["shell(command)"],
      projectContext: "Project: demo-app\nScripts: test, build",
      events: [],
      userInput: "hello",
    });

    expect(prompt).toContain("## Project Stack");
    expect(prompt).toContain("Project: demo-app");
  });

  it("compiles without optional skills catalog or memory digest", () => {
    const events = [makeEvent("user_message", { text: "ping" }, 0)];

    const { prompt, metrics } = compileClassicWithMetrics({
      cwd: "/proj",
      sessionId: "sess-1",
      toolSchemas: ["shell(command)"],
      events,
    });

    expect(prompt).toContain("# System");
    expect(prompt).toContain("# Conversation History");
    expect(prompt).not.toContain("# Cross-Session Memory");
    expect(prompt).not.toContain("## Available Skills");
    expect(metrics.skillsCatalogTokens).toBe(0);
    expect(metrics.crossSessionTokens).toBe(0);
  });
});
