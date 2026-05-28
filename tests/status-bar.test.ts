import { describe, it, expect } from "vitest";
import { StateGraph } from "../src/state-graph.js";
import {
  formatTokenCount,
  formatRepoLabel,
  formatMode,
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
      repoPath: "/tmp/aria",
      cwd: "/tmp/aria",
      debug: false,
      thinking: true,
      memoryEnabled: true,
      contextUsedTokens: 18400,
      contextWindowTokens: 128000,
      memoryStats: { active: 8, soft: 23, hard: 91 },
      skills: ["git", "node"],
      currentTask: "implement auth middleware",
      agentsContextLoaded: true,
    });
    expect(lines.length).toBe(5);
    expect(lines[1]).toContain("8 active");
    expect(lines[1]).toContain("23 soft");
    expect(lines[1]).toContain("91 hard");
    expect(lines[2]).toContain("18.4k");
    expect(lines[2]).toContain("128k");
    expect(lines[3]).toContain("git");
    expect(lines[4]).toContain("implement auth middleware");
  });

  it("buildStatusBarInput reads session metrics and memory", () => {
    const session = {
      cwd: "/tmp/aria",
      debug: true,
      memoryEnabled: false,
      agentsContext: null,
      getRepoRoot: () => "/tmp/aria",
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
      }),
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
});
