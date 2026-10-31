/**
 * In-app /help is plain text built from the palette command table.
 * The previous handler returned CLI usage (chalk bold + `praana setup` lines).
 */
import { describe, expect, it, mock } from "bun:test";
import { executeSlashCommand, SLASH_COMMAND_METADATA } from "../src/slash-commands.js";
import type { Session } from "../src/session.js";

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
});
