/**
 * Pure chrome formatters (Solid bars consume these strings).
 */
import { describe, it, expect } from "bun:test";
import {
  formatTuiGlanceLine,
  formatTuiIdentityLine,
} from "../src/ui/tui/chrome/glance-format.js";
import type { StatusBarInput } from "../src/status-bar.js";

function baseStatus(overrides: Partial<StatusBarInput> = {}): StatusBarInput {
  return {
    model: "openrouter/kimi-k2.7-code",
    repoPath: "/home/user/project",
    cwd: "/home/user/project",
    branch: "main",
    debug: false,
    thinking: false,
    memoryEnabled: true,
    incognito: false,
    planMode: false,
    contextUsedTokens: 2500,
    contextWindowTokens: 5000,
    memoryStats: { active: 1, soft: 2, hard: 0 },
    skills: ["test"],
    loadedSkills: [],
    currentTask: null,
    sessionInputTokens: 100,
    sessionOutputTokens: 50,
    ...overrides,
  };
}

describe("formatTuiIdentityLine", () => {
  it("includes brand, model provider, and path", () => {
    const line = formatTuiIdentityLine(baseStatus());
    expect(line).toContain("praana");
    expect(line).toContain("openrouter");
    expect(line).toContain("project");
  });
});

describe("formatTuiGlanceLine", () => {
  it("includes context and memory status", () => {
    const line = formatTuiGlanceLine(baseStatus(), { showCost: false });
    expect(line).toContain("ctx");
    expect(line).toContain("mem on");
  });

  it("surfaces debug and plan mode flags", () => {
    const line = formatTuiGlanceLine(
      baseStatus({ debug: true, planMode: true }),
      { showCost: false },
    );
    expect(line).toContain("debug");
    expect(line).toContain("plan");
  });
});
