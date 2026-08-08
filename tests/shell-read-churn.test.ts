import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemTools } from "../src/tools/system.js";
import { ScorecardTracker } from "../src/context-engine/telemetry.js";
import { openContextEngineDb } from "../src/context-engine/db.js";

describe("shell read churn instrumentation", () => {
  let testDir: string;
  let dbPath: string;
  let scorecard: ScorecardTracker;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "praana-shell-churn-"));
    dbPath = join(testDir, "context.db");
    const db = openContextEngineDb(dbPath);
    scorecard = new ScorecardTracker(db, "sess-shell-churn", true);
  });

  afterEach(() => {
    try {
      scorecard.close();
    } catch {
      // ignore
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeTools() {
    return createSystemTools({
      cwd: testDir,
      skills: [],
      skillRuntime: null,
      skillScorecard: scorecard,
      getCurrentTurn: () => 1,
    });
  }

  it("counts shell cat of a path without changing stdout", async () => {
    writeFileSync(join(testDir, "a.ts"), "export const x = 1;\n");

    const tools = makeTools();
    const r1 = await tools.shell.execute({ command: "cat a.ts" });
    expect(r1.ok).toBe(true);
    expect(r1.stdout).toContain("export const x");
    expect(r1.warning).toBeUndefined();
    expect(scorecard.getCounters().duplicateFileAccess).toBe(0);

    await tools.shell.execute({ command: "cat a.ts" });
    expect(scorecard.getCounters().duplicateFileAccess).toBe(1);

    const r3 = await tools.shell.execute({ command: "cat a.ts" });
    expect(scorecard.getCounters().churnInterventions).toBe(1);
    expect(r3.warning).toMatch(/Churn:/);
    // stdout still intact
    expect(r3.stdout).toContain("export const x");
  });

  it("does not instrument non-read commands", async () => {
    const tools = makeTools();
    await tools.shell.execute({ command: "echo hello" });
    expect(scorecard.getCounters().duplicateFileAccess).toBe(0);
    expect(scorecard.getCounters().churnInterventions).toBe(0);
  });

  it("does not fire a second intervention on further access", async () => {
    writeFileSync(join(testDir, "b.ts"), "export const y = 2;\n");
    const tools = makeTools();
    await tools.shell.execute({ command: "cat b.ts" });
    await tools.shell.execute({ command: "cat b.ts" });
    const r3 = await tools.shell.execute({ command: "cat b.ts" });
    expect(r3.warning).toMatch(/Churn:/);
    expect(scorecard.getCounters().churnInterventions).toBe(1);

    const r4 = await tools.shell.execute({ command: "cat b.ts" });
    expect(r4.warning).toBeUndefined();
    expect(scorecard.getCounters().churnInterventions).toBe(1);
  });
});
