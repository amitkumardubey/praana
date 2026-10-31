/**
 * `praana --help` (printHelp) output stability guard.
 *
 * printHelp is the CLI help; the key lines below are guarded against drift.
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
    expect(out).toContain("Ctrl+C");
    // Esc Esc must not be advertised: EscInterruptListener is never constructed.
    expect(out).not.toContain("Esc Esc");
    expect(out).toContain("Status bar (above prompt)");
    expect(out).toContain("~/.praana/AGENTS.md");
  });
});
