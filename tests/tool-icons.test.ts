import { describe, it, expect } from "bun:test";
import {
  formatToolDisplay,
  formatTurnFooterDigest,
  formatTurnStatsSuffix,
  formatShellOutputForDisplay,
  formatEditDiffSummary,
  summarizeResultForDisplay,
  toolIcon,
} from "../src/ui/tui/tool-icons.js";
import { formatTuiBootSummary } from "../src/ui/tui/boot-summary.js";
import { formatTuiGlanceLine, formatTuiIdentityLine } from "../src/ui/tui/chrome/glance-format.js";
import type { StatusBarInput } from "../src/status-bar.js";

describe("toolIcon", () => {
  it("returns unicode glyphs for known tools", () => {
    expect(toolIcon("read_file", true)).toBe("◇");
    expect(toolIcon("search_code", true)).toBe("⌕");
    expect(toolIcon("edit_file", true)).toBe("✎");
    expect(toolIcon("write_file", true)).toBe("✚");
    expect(toolIcon("shell", true)).toBe("❯");
    expect(toolIcon("recall", true)).toBe("◆");
    expect(toolIcon("load_skill", true)).toBe("✦");
  });

  it("returns ascii fallbacks when useUnicode=false", () => {
    expect(toolIcon("read_file", false)).toBe("r·");
    expect(toolIcon("edit_file", false)).toBe("e·");
    expect(toolIcon("shell", false)).toBe("$");
  });

  it("falls back to generic glyph for unknown tools", () => {
    expect(toolIcon("custom_tool", true)).toBe("⚙");
    expect(toolIcon("custom_tool", false)).toBe("?·");
  });
});

describe("formatToolDisplay", () => {
  it("formats shell commands with unicode icon", () => {
    const info = formatToolDisplay("shell", { command: "ls -la" }, { useUnicode: true });
    expect(info.icon).toBe("❯");
    expect(info.label).toBe("ls -la");
    expect(info.pending).toBe("running…");
  });

  it("respects ascii icon mode", () => {
    const info = formatToolDisplay("shell", { command: "ls" }, { useUnicode: false });
    expect(info.icon).toBe("$");
  });

  it("formats edit_file with path", () => {
    const info = formatToolDisplay("edit_file", { path: "src/foo.ts" });
    expect(info.icon).toBe("✎");
    expect(info.label).toContain("edit");
    expect(info.label).toContain("foo.ts");
  });

  it("formats search_code", () => {
    const info = formatToolDisplay("search_code", { pattern: "foo" });
    expect(info.icon).toBe("⌕");
    expect(info.label).toContain('"foo"');
  });
});

describe("formatEditDiffSummary", () => {
  it("counts added and removed lines", () => {
    expect(
      formatEditDiffSummary({ oldText: "a\nb", newText: "a\nb\nc" }),
    ).toBe("+3 −2");
  });
});

describe("summarizeResultForDisplay", () => {
  it("summarizes multiline output", () => {
    const summary = summarizeResultForDisplay("line1\nline2\nline3");
    expect(summary).toContain("3 lines");
  });

  it("summarizes shell JSON with pass counts", () => {
    const result = JSON.stringify({
      stdout: "42 pass · 0 fail",
      stderr: "",
      exitCode: 0,
    });
    expect(summarizeResultForDisplay(result)).toContain("42 pass");
  });

  it("returns (empty) for blank input", () => {
    expect(summarizeResultForDisplay("")).toBe("(empty)");
  });
});

describe("formatShellOutputForDisplay", () => {
  it("returns null for non-shell JSON", () => {
    expect(formatShellOutputForDisplay('{"ok":true}')).toBeNull();
  });

  it("parses stdout + stderr", () => {
    const result = JSON.stringify({ stdout: "hello\nworld", stderr: "", exitCode: 0 });
    const display = formatShellOutputForDisplay(result);
    expect(display).not.toBeNull();
    expect(display!.body).toContain("hello");
    expect(display!.isError).toBe(false);
  });
});

describe("formatTurnFooterDigest", () => {
  it("includes edits and ctx delta", () => {
    const line = formatTurnFooterDigest({
      durationMs: 9400,
      ambient: "inline",
      editCount: 2,
      writeCount: 0,
      ctxBeforePct: 38,
      ctxAfterPct: 43,
      stats: {
        promptTokens: 1000,
        outputTokens: 200,
        digestLen: 0,
        recallCalls: 2,
        recallHits: 2,
        autoHydrated: 0,
        activeState: 0,
        totalState: 0,
      },
    });
    expect(line).toContain("2 edits");
    expect(line).toContain("38%→43%");
    expect(line).toContain("9.4s");
  });

  it("folds recall into footer in quiet mode", () => {
    const line = formatTurnFooterDigest({
      durationMs: 500,
      ambient: "quiet",
      editCount: 0,
      writeCount: 0,
      ctxBeforePct: 0,
      ctxAfterPct: 10,
      stats: {
        promptTokens: 0,
        outputTokens: 0,
        digestLen: 0,
        recallCalls: 2,
        recallHits: 2,
        autoHydrated: 0,
        activeState: 0,
        totalState: 0,
      },
    });
    expect(line).toContain("recall 2");
  });
});

describe("formatTurnStatsSuffix", () => {
  it("includes prompt tokens", () => {
    const s = formatTurnStatsSuffix({
      promptTokens: 1200,
      outputTokens: 0,
      digestLen: 0,
      recallCalls: 0,
      recallHits: 0,
      autoHydrated: 0,
      activeState: 0,
      totalState: 0,
    });
    expect(s).toContain("1.2k");
  });
});

describe("formatTuiGlanceLine", () => {
  const base: StatusBarInput = {
    model: "openrouter/claude-opus-4.8",
    repoPath: "/home/user/proj",
    cwd: "/home/user/proj",
    branch: "main",
    debug: false,
    thinking: false,
    memoryEnabled: true,
    incognito: false,
    contextUsedTokens: 43_000,
    contextWindowTokens: 100_000,
    memoryStats: { active: 3, soft: 1, hard: 0 },
    skills: ["a"],
    loadedSkills: ["a"],
    currentTask: null,
    agentsContextLoaded: false,
  };

  it("shows ctx percent and state tiers", () => {
    const line = formatTuiGlanceLine(base, { showCost: false });
    expect(line).toContain("ctx");
    expect(line).toContain("43%");
    expect(line).toContain("3A");
    expect(line).toContain("mem on");
  });
});

describe("formatTuiIdentityLine", () => {
  it("includes brand and model", () => {
    const line = formatTuiIdentityLine({
      model: "openrouter/claude-opus-4.8",
      repoPath: "/x",
      cwd: "/x/praana",
      branch: "main",
      debug: false,
      thinking: false,
      memoryEnabled: true,
      incognito: false,
      contextUsedTokens: 0,
      contextWindowTokens: 128000,
      memoryStats: { active: 0, soft: 0, hard: 0 },
      skills: [],
      loadedSkills: null,
      currentTask: null,
      agentsContextLoaded: false,
    });
    expect(line).toContain("praana");
    expect(line).toContain("openrouter");
    expect(line).toContain("main");
  });
});

describe("formatTuiBootSummary", () => {
  it("includes model and skills on fresh session", () => {
    const lines = formatTuiBootSummary({
      session: {
        getGitBranch: () => "main",
        getRepoRoot: () => "/proj",
        digest: "line1\nline2",
        isIncognito: () => false,
        memoryEnabled: true,
        isContextEngineEnabled: () => true,
        skills: [{ name: "a" }, { name: "b" }],
        getPersistentMemoryEntryCount: () => 12,
      } as never,
      model: "openrouter/claude-opus-4.8",
      cwd: "/proj",
      isResume: false,
    });
    expect(lines.some((l) => l.startsWith("model"))).toBe(true);
    expect(lines.some((l) => l.includes("2 available"))).toBe(true);
    expect(lines.some((l) => l.includes("engine on"))).toBe(true);
  });

  it("shows resume variant", () => {
    const lines = formatTuiBootSummary({
      session: {
        getTurnCount: () => 14,
        getMemoryStats: () => ({ active: 3, soft: 1, hard: 0, total: 4, byKind: {} }),
      } as never,
      model: "m",
      cwd: "/",
      isResume: true,
    });
    expect(lines[0]).toContain("resumed");
    expect(lines[0]).toContain("14 turns");
    expect(lines[0]).toContain("3A");
  });
});
