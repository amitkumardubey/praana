import { describe, it, expect } from "bun:test";
import chalk from "chalk";
import { StateGraph } from "../src/state-graph.js";
import {
  formatTokenCount,
  formatRepoLabel,
  formatMode,
  formatModelStatusLabel,
  getCurrentTaskTitle,
  formatStatusBarLines,
  formatStatusLine,
  buildStatusBarInput,
  formatSessionTokenBreakdown,
} from "../src/status-bar.js";
import type { Session } from "../src/session.js";

describe("status-bar", () => {
  it("formats token counts compactly", () => {
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(18400)).toBe("18.4k");
    expect(formatTokenCount(128000)).toBe("128k");
  });

  it("formats session token breakdown with separate in and out", () => {
    expect(formatSessionTokenBreakdown(12_000, 3_400)).toBe("in 12k · out 3.4k");
    expect(formatSessionTokenBreakdown(0, 200)).toBe("out 200");
    expect(formatSessionTokenBreakdown(500, 0)).toBe("in 500");
    expect(formatSessionTokenBreakdown(0, 0)).toBeNull();
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
      sessionInputTokens: 12_000,
      sessionOutputTokens: 3_400,
    });
    expect(lines.length).toBe(4);
    expect(lines[1]).toContain("8 active");
    expect(lines[1]).toContain("23 soft");
    expect(lines[1]).toContain("91 hard");
    expect(lines[2]).toContain("2 skills");
    expect(lines[3]).toContain("implement auth middleware");
    expect(lines[0]).toContain("gpt-4o");
    expect(lines[0]).toContain("feat/foo");
    expect(lines[0]).not.toContain("18.4k");
    expect(lines[0]).not.toContain("in 12k");
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
      getInputTokens: () => 500,
      getOutputTokens: () => 120,
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
    expect(input.sessionInputTokens).toBe(500);
    expect(input.sessionOutputTokens).toBe(120);
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
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
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

  it("formatStatusLine includes repo, model, ctx threshold, and separators", () => {
    const line = formatStatusLine({
      model: "openrouter/claude-opus-4.8",
      repoPath: "/home/user/proj",
      cwd: "/home/user/proj",
      branch: "main",
      debug: false,
      thinking: false,
      memoryEnabled: true,
      incognito: false,
      contextUsedTokens: 95_000,
      contextWindowTokens: 100_000,
      memoryStats: { active: 3, soft: 1, hard: 0 },
      skills: ["a", "b"],
      loadedSkills: null,
      currentTask: "ship tokens",
      agentsContextLoaded: false,
      sessionInputTokens: 12_000,
      sessionOutputTokens: 3_400,
    });

    expect(line).toContain("proj · main");
    expect(line).toContain("openrouter · claude-opus-4.8");
    expect(line).toContain("ctx 95k/100k 95%");
    expect(line).toContain("skills 2");
    expect(line).toContain("state 3A·1S");
    expect(line).toContain("task ship tokens");
    expect(line.split("·").length).toBeGreaterThan(4);
  });

  it("formatStatusLine colours ctx yellow above 70% and red above 90%", () => {
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
      const yellow = formatStatusLine({
        model: "gpt-4o",
        repoPath: "/tmp/praana",
        cwd: "/tmp/praana",
        branch: null,
        debug: false,
        thinking: false,
        memoryEnabled: true,
        incognito: false,
        contextUsedTokens: 80_000,
        contextWindowTokens: 100_000,
        memoryStats: { active: 0, soft: 0, hard: 0 },
        skills: [],
        loadedSkills: null,
        currentTask: null,
        agentsContextLoaded: false,
        sessionInputTokens: 0,
        sessionOutputTokens: 0,
      });
      const red = formatStatusLine({
        model: "gpt-4o",
        repoPath: "/tmp/praana",
        cwd: "/tmp/praana",
        branch: null,
        debug: false,
        thinking: false,
        memoryEnabled: true,
        incognito: false,
        contextUsedTokens: 95_000,
        contextWindowTokens: 100_000,
        memoryStats: { active: 0, soft: 0, hard: 0 },
        skills: [],
        loadedSkills: null,
        currentTask: null,
        agentsContextLoaded: false,
        sessionInputTokens: 0,
        sessionOutputTokens: 0,
      });

      expect(yellow).toContain("\x1b[33m");
      expect(red).toContain("\x1b[31m");
    } finally {
      chalk.level = prevLevel;
    }
  });
});
