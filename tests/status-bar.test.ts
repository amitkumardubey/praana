import { describe, it, expect } from "bun:test";
import { StateGraph } from "../src/state-graph.js";
import {
  formatTokenCount,
  formatRepoLabel,
  formatMode,
  formatModelStatusLabel,
  getCurrentTaskTitle,
  formatStatusBarLines,
  buildStatusBarInput,
} from "../src/status-bar.js";
import type { Session } from "../src/session.js";

describe("status-bar", () => {
  it("formats token counts compactly", () => {
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(18400)).toBe("18.4k");
    expect(formatTokenCount(128000)).toBe("128k");
  });

  it("formats repo label for monorepo subdirs", () => {
    expect(formatRepoLabel("/home/proj", "/home/proj")).toBe("proj");
    expect(formatRepoLabel("/home/proj", "/home/proj/apps/api")).toBe("proj/api");
  });

  it("formats mode from debug and thinking flags", () => {
    expect(formatMode(false, true)).toBe("normal");
    expect(formatMode(true, true)).toBe("debug+think");
    expect(formatMode(false, false)).toBe("normal·think-off");
  });

  it("splits provider and model for status bar display", () => {
    expect(formatModelStatusLabel("openrouter/moonshotai/kimi-k2.7-code")).toEqual({
      provider: "openrouter",
      modelShort: "kimi-k2.7-code",
    });
    expect(formatModelStatusLabel("gpt-4o")).toEqual({
      provider: null,
      modelShort: "gpt-4o",
    });
  });

  it("picks doing task over todo", () => {
    const sg = new StateGraph();
    sg.create("task", { title: "backlog item", status: "todo" });
    sg.create("task", { title: "implement auth middleware", status: "doing" });
    expect(getCurrentTaskTitle(sg)).toBe("implement auth middleware");
  });

  it("falls back to first todo when none doing", () => {
    const sg = new StateGraph();
    sg.create("task", { title: "setup CI", status: "todo" });
    expect(getCurrentTaskTitle(sg)).toBe("setup CI");
  });

  it("renders memory tier line", () => {
    const lines = formatStatusBarLines({
      model: "openai/gpt-4o",
      repoPath: "/tmp/praana",
      cwd: "/tmp/praana",
      debug: false,
      thinking: true,
      memoryEnabled: true,
      incognito: false,
      contextUsedTokens: 18400,
      contextWindowTokens: 128000,
      branch: "feat/foo",
      memoryStats: { active: 8, soft: 23, hard: 91 },
      skills: ["git", "node"],
      loadedSkills: null,
      currentTask: "implement auth middleware",
      agentsContextLoaded: true,
    });
    expect(lines.length).toBe(5);
    expect(lines[1]).toContain("8 active");
    expect(lines[1]).toContain("23 soft");
    expect(lines[1]).toContain("91 hard");
    expect(lines[2]).toContain("18.4k");
    expect(lines[2]).toContain("128k");
    expect(lines[3]).toContain("2 skills");
    expect(lines[4]).toContain("implement auth middleware");
    expect(lines[0]).toContain("praana");
    expect(lines[0]).toContain("feat/foo");
  });

  it("buildStatusBarInput reads session metrics and memory", () => {
    const session = {
      cwd: "/tmp/praana",
      debug: true,
      memoryEnabled: false,
      agentsContext: null,
      getRepoRoot: () => "/tmp/praana",
      getGitBranch: () => "main",
      getMemoryStats: () => ({ active: 1, soft: 2, hard: 3, total: 6, byKind: {} }),
      getLastCompileMetrics: () => ({
        totalTokens: 9000,
        systemFrameTokens: 0,
        agentsContextTokens: 0,
        crossSessionTokens: 0,
        activeStateTokens: 0,
        peripheralStubsTokens: 0,
        recentTurnsTokens: 0,
        currentInputTokens: 0,
        activeObjectCount: 0,
        peripheralObjectCount: 0,
        recentTurnsTruncated: false,
        memoryTruncated: false,
        agentsContextTruncated: false,
        skillsTruncated: false,
      }),
      isIncognito: () => false,
      skills: [],
      stateGraph: new StateGraph(),
    } as unknown as Session;

    const input = buildStatusBarInput(session, {
      model: "anthropic/claude-sonnet",
      debug: true,
      thinking: false,
    });
    expect(input.contextUsedTokens).toBe(9000);
    expect(input.memoryEnabled).toBe(false);
    expect(input.memoryStats).toEqual({ active: 1, soft: 2, hard: 3 });
  });

  it("falls back to agents context token estimate before first compile", () => {
    const session = {
      cwd: "/tmp/praana",
      debug: false,
      memoryEnabled: false,
      agentsContext: "x".repeat(4000),
      getRepoRoot: () => "/tmp/praana",
      getGitBranch: () => null,
      getMemoryStats: () => ({ active: 0, soft: 0, hard: 0, total: 0, byKind: {} }),
      getLastCompileMetrics: () => null,
      isIncognito: () => false,
      skills: [],
      stateGraph: new StateGraph(),
    } as unknown as Session;

    const input = buildStatusBarInput(session, {
      model: "openrouter/big-pickle",
      debug: false,
      thinking: false,
      contextWindowTokens: 200_000,
    });
    expect(input.contextUsedTokens).toBe(1000);
  });
});
