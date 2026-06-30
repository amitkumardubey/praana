import { describe, it, expect } from "bun:test";
import {
  formatToolDisplay,
  formatTurnFooter,
  formatTurnStatsSuffix,
  formatTuiBootSummary,
  formatShellOutputForDisplay,
  needsTopMargin,
  summarizeResultForDisplay,
} from "../src/ui/tui/tool-display.js";

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

  it("handles empty output", () => {
    expect(summarizeResultForDisplay("")).toBe("(empty)");
  });

  it("summarizes shell json results", () => {
    const summary = summarizeResultForDisplay(
      JSON.stringify({ ok: true, stdout: "line1\nline2\n", exitCode: 0 })
    );
    expect(summary).toContain("exit 0");
    expect(summary).toContain("2 line");
    expect(summary).toContain("line1");
  });

  it("summarizes artifact references", () => {
    const summary = summarizeResultForDisplay(
      "[artifact: art_ffacffbb902b | shell | 13,250 tokens raw]"
    );
    expect(summary).toContain("artifact");
    expect(summary).toContain("13250");
  });
});

describe("formatShellOutputForDisplay", () => {
  it("parses shell json and builds body from stdout", () => {
    const display = formatShellOutputForDisplay(
      JSON.stringify({ ok: true, stdout: "line1\nline2\n", stderr: "", exitCode: 0 })
    );
    expect(display).not.toBeNull();
    expect(display!.summary).toContain("exit 0");
    expect(display!.body).toBe("line1\nline2");
    expect(display!.isError).toBe(false);
  });

  it("includes stderr with prefix", () => {
    const display = formatShellOutputForDisplay(
      JSON.stringify({ ok: true, stdout: "", stderr: "warn\n", exitCode: 0 })
    );
    expect(display!.body).toContain("[stderr] warn");
    expect(display!.isError).toBe(false);
  });

  it("truncates long output", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const display = formatShellOutputForDisplay(
      JSON.stringify({ ok: true, stdout: lines, stderr: "", exitCode: 0 })
    );
    expect(display!.body).toContain("line 1");
    expect(display!.body).toContain("+20 more lines");
  });

  it("shows both line and character truncation markers when both limits apply", () => {
    const longLine = "x".repeat(200);
    const lines = Array.from({ length: 50 }, () => longLine).join("\n");
    const display = formatShellOutputForDisplay(
      JSON.stringify({ ok: true, stdout: lines, stderr: "", exitCode: 0 })
    );
    expect(display!.body).toContain("+20 more lines");
    expect(display!.body).toContain("truncated");
  });

  it("returns null for non-shell json", () => {
    expect(formatShellOutputForDisplay(JSON.stringify({ ok: true, content: "x" }))).toBeNull();
  });

  it("strips ansi escape codes", () => {
    const display = formatShellOutputForDisplay(
      JSON.stringify({ ok: true, stdout: "\x1b[31mred\x1b[0m", stderr: "", exitCode: 0 })
    );
    expect(display!.body).toBe("red");
  });

  it("strips ansi from summary preview", () => {
    const summary = summarizeResultForDisplay(
      JSON.stringify({ ok: true, stdout: "\x1b[31mred\x1b[0m\n", stderr: "", exitCode: 0 })
    );
    expect(summary).toContain("red");
    expect(summary).not.toContain("\x1b");
  });

  it("summarizes stderr-only shell output", () => {
    const summary = summarizeResultForDisplay(
      JSON.stringify({ ok: true, stdout: "", stderr: "warn\n", exitCode: 0 })
    );
    expect(summary).toContain("exit 0");
    expect(summary).toContain("warn");
  });
});

describe("formatTurnStatsSuffix", () => {
  it("includes prompt, output, and recall/digest when present", () => {
    expect(
      formatTurnStatsSuffix({
        activeState: 1,
        totalState: 1,
        digestLen: 0,
        recallCalls: 0,
        recallHits: 0,
        autoHydrated: 0,
        promptTokens: 24_100,
        outputTokens: 211,
      })
    ).toBe("prompt ~24.1k · out ~211");
    expect(formatTurnStatsSuffix({
      activeState: 0,
      totalState: 0,
      digestLen: 120,
      recallCalls: 3,
      recallHits: 2,
      autoHydrated: 0,
      promptTokens: 0,
      outputTokens: 0,
    })).toBe("digest 120c · recall 2/3");
  });
});

describe("formatTurnFooter", () => {
  it("records model, duration, and turn stats on one line", () => {
    expect(formatTurnFooter("anthropic/claude-sonnet-4", 3200)).toBe(
      "▣ PRAANA · claude-sonnet-4 · 3.2s"
    );
    expect(
      formatTurnFooter("openrouter/big-pickle", 9200, {
        activeState: 1,
        totalState: 1,
        digestLen: 0,
        recallCalls: 0,
        recallHits: 0,
        autoHydrated: 0,
        promptTokens: 24_100,
        outputTokens: 211,
      })
    ).toBe("▣ PRAANA · big-pickle · 9.2s · prompt ~24.1k · out ~211");
  });
});

describe("formatTuiBootSummary", () => {
  it("builds a compact boot line", () => {
    expect(
      formatTuiBootSummary({
        sessionId: "01JABC123XYZ",
        contextTokens: 3186,
        engineEnabled: true,
        skillCount: 36,
        memoryEnabled: false,
        incognito: false,
      })
    ).toContain("session 01JABC123XYZ");
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
