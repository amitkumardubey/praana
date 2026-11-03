/**
 * `praana --help` (printHelp) output stability guard.
 *
 * printHelp is the CLI help; the key lines below are guarded against drift.
 */
import { describe, expect, it } from "bun:test";
import { printHelp, SLASH_COMMANDS_HELP_BLOCK } from "../src/app-banner.js";
import { SLASH_COMMAND_METADATA } from "../src/slash-commands.js";

function capturePrintHelp(): string {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    printHelp();
  } finally {
    console.log = orig;
  }
  return logs.join("\n");
}

describe("printHelp", () => {
  it("lists every command in SLASH_COMMAND_METADATA", () => {
    const block = SLASH_COMMANDS_HELP_BLOCK.join("\n");
    for (const meta of SLASH_COMMAND_METADATA) {
      expect(block).toContain(meta.name);
    }
  });

  it("mentions /quit as an alias of /exit", () => {
    const block = SLASH_COMMANDS_HELP_BLOCK.join("\n");
    const exitLine = block.split("\n").find((line) => line.includes("/exit"));
    expect(exitLine).toBeDefined();
    expect(exitLine).toContain("/quit");
  });

  it("prints usage, slash command table, keys, status hint, and the tip", () => {
    const out = capturePrintHelp();

    expect(out).toContain("Usage");
    expect(out).toContain("Slash Commands");
    expect(out).toContain("praana --help");
    expect(out).toContain("/shell");
    expect(out).toContain("!<command>");
    expect(out).toContain("Ctrl+C");
    // Esc Esc must not be advertised: EscInterruptListener is never constructed.
    expect(out).not.toContain("Esc Esc");
    expect(out).toContain("Status bar (above prompt)");
    expect(out).toContain("~/.praana/AGENTS.md");
  });
});
