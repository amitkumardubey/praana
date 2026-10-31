/**
 * `praana --help` (printHelp) output stability guard.
 *
 * printHelp is the CLI help; the refactor that removed the unused
 * getHelpLines() must not change a single line of it.
 */
import { describe, expect, it } from "bun:test";
import { printHelp } from "../src/app-banner.js";

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
  it("prints usage, slash command table, keys, status hint, and the tip", () => {
    const out = capturePrintHelp();

    expect(out).toContain("Usage");
    expect(out).toContain("Slash Commands");
    expect(out).toContain("praana --help");
    expect(out).toContain("/shell");
    expect(out).toContain("!<command>");
    expect(out).toContain("Esc Esc");
    expect(out).toContain("Status bar (above prompt)");
    expect(out).toContain("~/.praana/AGENTS.md");
  });
});
