import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SLASH_COMMAND_METADATA } from "../src/slash-commands.js";

const AGENTS_PATH = resolve(import.meta.dir, "..", "AGENTS.md");
const AGENTS = await Bun.file(AGENTS_PATH).text();

const PATH_PREFIXES = [
  "src/",
  "docs/",
  "tests/",
  "scripts/",
  "crates/",
  "bin/",
  ".github/",
  "website/",
];

describe("AGENTS.md", () => {
  test("is <= 14500 characters (fits the system-prompt load cap)", () => {
    expect(AGENTS.length).toBeLessThanOrEqual(14_500);
  });

  test("contains no stale 'pi-ai' references", () => {
    expect(AGENTS).not.toContain("pi-ai");
  });

  test("lists every real slash command and no others", () => {
    // Canonical names, plus aliases (e.g. /quit for /exit) which the table may
    // legitimately mention.
    const realNames = new Set<string>();
    for (const c of SLASH_COMMAND_METADATA) {
      realNames.add(c.name);
      for (const alias of c.aliases ?? []) realNames.add(alias);
    }
    const canonicalNames = SLASH_COMMAND_METADATA.map((c) => c.name);
    expect(new Set(canonicalNames).size).toBe(canonicalNames.length);

    // Table section: between the "## Slash Commands" heading and the next "## ".
    const tableStart = AGENTS.indexOf("## Slash Commands");
    expect(tableStart).toBeGreaterThanOrEqual(0);
    const nextSection = AGENTS.indexOf("\n## ", tableStart + 5);
    expect(nextSection).toBeGreaterThan(tableStart);
    const table = AGENTS.slice(tableStart, nextSection);

    // Only scan table rows (lines starting with a `| ` cell), so API paths
    // like `/models` in prose do not count as commands.
    const tableNames = new Set<string>();
    for (const line of table.split("\n")) {
      if (!line.startsWith("| `")) continue;
      for (const alias of line.matchAll(/`\/([a-z]+)/g)) {
        tableNames.add(`/${alias[1]}`);
      }
    }

    for (const name of canonicalNames) {
      expect(tableNames.has(name), `AGENTS.md slash table missing ${name}`).toBe(true);
    }
    for (const name of tableNames) {
      expect(realNames.has(name), `AGENTS.md slash table has unknown command ${name}`).toBe(
        true,
      );
    }
  });

  test("keeps every backticked repo-relative path valid", () => {
    const missing: string[] = [];
    for (const m of AGENTS.matchAll(/`([^`]+)`/g)) {
      const p = m[1];
      if (!PATH_PREFIXES.some((prefix) => p.startsWith(prefix))) continue;
      if (p.includes("*") || p.includes("<")) continue; // glob / placeholder
      if (!existsSync(resolve(import.meta.dir, "..", p))) missing.push(p);
    }
    expect(missing).toEqual([]);
  });

  test("documents the AGENTS.md load order and 16000-char cap", () => {
    expect(AGENTS).toContain("loadAgentsContext()");
    expect(AGENTS).toContain("16,000");
  });

  test("keeps the public-repo and Git Conventions rules within the first 6000 chars", () => {
    const head = AGENTS.slice(0, 6_000);
    expect(head.toLowerCase()).toContain("public");
    expect(head).toContain("Git Conventions");
  });
});
