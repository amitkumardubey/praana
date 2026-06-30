import { describe, it, expect } from "bun:test";
import {
  formatToolDisplay,
  formatTurnStatsSuffix,
  formatShellOutputForDisplay,
  needsTopMargin,
  summarizeResultForDisplay,
  toolIcon,
} from "../src/ui/tui/tool-icons.js";
import { formatTuiBootSummary } from "../src/ui/tui/boot-summary.js";

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
  it("formats shell commands", () => {
    expect(formatToolDisplay("shell", { command: "ls -la" })).toEqual({
      icon: "$",
      label: "ls -la",
      pending: "Running command…",
    });
  });

  it("shortens long shell commands", () => {
    const info = formatToolDisplay("shell", {
      command: "cd /very/long/path && cat src/ui/tui/app.tsx",
    });
    expect(info.label.length).toBeLessThanOrEqual(56);
    expect(info.label).toContain("cat");
  });

  it("formats retrieve_artifact", () => {
    const info = formatToolDisplay("retrieve_artifact", { id: "art_abc123" });
    expect(info.icon).toBe("◆");
    expect(info.label).toContain("art_abc123");
  });

  it("formats read_file with path", () => {
    const info = formatToolDisplay("read_file", { path: "/tmp/foo.txt" });
    expect(info.icon).toBe("→");
    expect(info.label).toContain("Read");
    expect(info.label).toContain("foo.txt");
  });

  it("formats search_code as grep", () => {
    const info = formatToolDisplay("search_code", { pattern: "foo", path: "src" });
    expect(info.icon).toBe("✱");
    expect(info.label).toContain('Grep "foo"');
    expect(info.label).toContain("src");
  });

  it("falls back for unknown tools", () => {
    const info = formatToolDisplay("custom_tool", { x: 1 });
    expect(info.icon).toBe("⚙");
    expect(info.label).toContain("custom_tool");
  });
});

describe("summarizeResultForDisplay", () => {
  it("summarizes multiline output", () => {
    const summary = summarizeResultForDisplay("line1\nline2\nline3");
    expect(summary).toContain("3 lines");
    expect(summary).toContain("line1");
  });

  it("summarizes shell JSON output", () => {
    const result = JSON.stringify({ stdout: "output", stderr: "", exitCode: 0 });
    const summary = summarizeResultForDisplay(result);
    expect(summary).toContain("exit 0");
    expect(summary).toContain("line");
  });

  it("returns (empty) for blank input", () => {
    expect(summarizeResultForDisplay("")).toBe("(empty)");
  });

  it("formats artifact references", () => {
    const text = "[artifact: art_abc123def456] 1500 tokens";
    const summary = summarizeResultForDisplay(text);
    expect(summary).toContain("artifact");
    expect(summary).toContain("1500");
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

  it("marks exit code 1 as error", () => {
    const result = JSON.stringify({ stdout: "", stderr: "failed", exitCode: 1 });
    const display = formatShellOutputForDisplay(result);
    expect(display!.isError).toBe(true);
    expect(display!.body).toContain("[stderr] failed");
  });
});

describe("formatTurnStatsSuffix", () => {
  it("returns empty string when no stats", () => {
    expect(formatTurnStatsSuffix()).toBe("");
    expect(formatTurnStatsSuffix(undefined)).toBe("");
  });

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

  it("includes recall stats", () => {
    const s = formatTurnStatsSuffix({
      promptTokens: 0,
      outputTokens: 0,
      digestLen: 0,
      recallCalls: 2,
      recallHits: 1,
      autoHydrated: 0,
      activeState: 0,
      totalState: 0,
    });
    expect(s).toContain("recall 1/2");
  });
});

describe("needsTopMargin", () => {
  it("adds margin before user and first tool after text", () => {
    expect(needsTopMargin("user", undefined)).toBe(true);
    expect(needsTopMargin("tool", "assistant")).toBe(true);
    expect(needsTopMargin("tool", "tool")).toBe(false);
  });

  it("adds margin before assistant after tools or thinking", () => {
    expect(needsTopMargin("assistant", "tool")).toBe(true);
    expect(needsTopMargin("assistant", "thinking")).toBe(true);
    expect(needsTopMargin("assistant", "assistant")).toBe(false);
  });

  it("adds margin before thinking after non-thinking blocks", () => {
    expect(needsTopMargin("thinking", "tool")).toBe(true);
    expect(needsTopMargin("thinking", "thinking")).toBe(false);
  });
});

describe("formatTuiBootSummary", () => {
  it("includes session id", () => {
    const s = formatTuiBootSummary({
      sessionId: "sess-123",
      engineEnabled: false,
      skillCount: 0,
      memoryEnabled: true,
      incognito: false,
    });
    expect(s).toContain("sess-123");
  });

  it("shows engine on when enabled", () => {
    expect(
      formatTuiBootSummary({
        sessionId: "01JABC123XYZ",
        contextTokens: 3186,
        engineEnabled: true,
        skillCount: 36,
        memoryEnabled: false,
        incognito: false,
      })
    ).toContain("engine on");
  });

  it("shows incognito flag", () => {
    const s = formatTuiBootSummary({
      sessionId: "s",
      engineEnabled: false,
      skillCount: 0,
      memoryEnabled: true,
      incognito: true,
    });
    expect(s).toContain("incognito");
  });
});
