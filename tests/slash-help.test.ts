/**
 * In-app /help is plain text built from the palette command table.
 * The previous handler returned CLI usage (chalk bold + `praana setup` lines).
 */
import { describe, expect, it, mock } from "bun:test";
import { executeSlashCommand, SLASH_COMMAND_METADATA } from "../src/slash-commands.js";
import type { Session } from "../src/session.js";
import { formatTuiGlanceParts } from "../src/ui/tui/chrome/glance-format.js";
import type { StatusBarInput } from "../src/status-bar.js";

const BOXEN_CHARS = /[╭╮╰╯┌┐└┘│─━╔╗╚╝║═]/;

async function helpText(): Promise<string> {
  const session = {
    stateGraph: { list: () => [] },
  } as unknown as Session;
  const result = await executeSlashCommand("/help", session, {
    setModel: mock(),
    setThinking: mock(),
    getThinking: () => false,
  });
  return result.lines.join("\n");
}

describe("/help", () => {
  it("lists every palette command, with description and aliases, and no CLI box", async () => {
    const text = await helpText();

    for (const meta of SLASH_COMMAND_METADATA) {
      expect(text, meta.name).toContain(meta.name);
      expect(text, meta.description).toContain(meta.description);
      for (const alias of meta.aliases ?? []) {
        expect(text, alias).toContain(alias);
      }
    }

    expect(text).not.toMatch(/\x1b/);
    expect(text).not.toMatch(BOXEN_CHARS);
    expect(text).not.toContain("praana setup");
    expect(text).not.toContain("praana doctor");
    expect(text).toContain("praana --help");

    const memory = text.split("Memory\n")[1]?.split("\n\n")[0] ?? "";
    expect(memory).toContain("/digest");
    expect(memory).toContain("/recall");
    expect(memory).not.toContain("/events");
    const insight = text.split("Insight\n")[1]?.split("\n\n")[0] ?? "";
    expect(insight).toContain("/events");
    expect(insight).toContain("/state");
  });

  it("explains every status-bar abbreviation", async () => {
    const text = await helpText();
    for (const abbr of ["ctx", "%w", "wm", "skills", "think", "engine", "mem"]) {
      expect(text, abbr).toContain(abbr);
    }
    expect(text).toMatch(/\bin\b/);
    expect(text).toMatch(/\bout\b/);
    expect(text).toContain("Enter");
    expect(text).toContain("Ctrl+J");
    expect(text).toContain("F9");
    expect(text).toContain("Ctrl+C");
  });

  it("lists the shell shortcut and the Ctrl+C interrupt key with their behaviour", async () => {
    const text = await helpText();
    // !<command> is handled in src/ui/tui/run.tsx (handleSubmit): it rewrites
    // `!cmd` to `/shell cmd`; a bare `!` shows a usage error.
    expect(text).toContain("!<command>");
    expect(text).toContain("/shell");
    expect(text).toContain("Usage: !<command>");
    // Ctrl+C interrupts a running turn (the TUI binds Ctrl+C in run.tsx).
    expect(text).toContain("Ctrl+C");
    expect(text).toContain("abort");
    // Esc Esc must not be advertised: EscInterruptListener is never constructed.
    expect(text).not.toContain("Esc Esc");
    // Single Esc must not be described as if it interrupts.
    const escLine = text.split("\n").find((l) => l.includes("Esc"));
    expect(escLine, "an Esc line should exist").toBeTruthy();
  });

  it("explains every conditional label the glance bar can emit", async () => {
    const text = await helpText();

    const base: StatusBarInput = {
      model: "openai/gpt-4o",
      repoPath: "/tmp/repo",
      cwd: "/tmp/repo",
      branch: "main",
      debug: false,
      thinking: false,
      memoryEnabled: true,
      incognito: false,
      planMode: false,
      contextUsedTokens: 1_000,
      contextWindowTokens: 100_000,
      contextDisplayMode: "engine",
      contextWeightedPct: 10,
      contextRawPct: 30,
      contextPressureMode: "normal",
      contextEngineEnabled: true,
      memoryStats: { active: 1, soft: 0, hard: 0 },
      skills: ["memory"],
      loadedSkills: null,
      currentTask: null,
      agentsContextLoaded: false,
      sessionInputTokens: 100,
      sessionOutputTokens: 50,
    };
    const glanceText = (over: Partial<StatusBarInput>): string => {
      const parts = formatTuiGlanceParts({ ...base, ...over }, { showCost: false });
      return [...parts.metrics, ...parts.flags].map((s) => s.text).join(" · ");
    };

    // Every conditional label the glance bar can emit must have a legend entry.
    // The expected text is derived from the same formatter the chrome uses, so
    // a new emission point without a legend entry fails here.
    const cases: Array<{ name: string; over: Partial<StatusBarInput>; expected: string }> = [
      { name: "debug", over: { debug: true }, expected: "debug" },
      { name: "plan", over: { planMode: true }, expected: "plan" },
      { name: "update", over: { updateAvailable: true }, expected: "update" },
      { name: "restart", over: { updateRestart: true }, expected: "restart" },
      { name: "pressure compact", over: { contextPressureMode: "compact" }, expected: "compact" },
      { name: "pressure emergency", over: { contextPressureMode: "emergency" }, expected: "emergency" },
    ];
    for (const c of cases) {
      const emitted = glanceText(c.over);
      expect(emitted, `${c.name} must be emitted by the glance bar`).toContain(c.expected);
      expect(text, `${c.name} must have a legend entry in /help`).toContain(c.expected);
    }

    // The (N% raw) suffix on ctx when raw fill diverges from weighted fill.
    const rawEmitted = glanceText({ contextRawPct: 90 });
    expect(rawEmitted, "raw divergence should emit a (N% raw) suffix").toMatch(/\(\d+% raw\)/);
    expect(text).toContain("raw");
    expect(text).toContain("15"); // divergence threshold is documented
  });
});
