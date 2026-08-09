import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemTools } from "../src/tools/system.js";
import { ScorecardTracker } from "../src/context-engine/telemetry.js";
import { openContextEngineDb } from "../src/context-engine/db.js";
import { Database } from "bun:sqlite";

describe("read-churn acceptance fixture (#294)", () => {
  let testDir: string;
  let dbPath: string;
  let db: Database;
  let scorecard: ScorecardTracker;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "praana-churn-fix-"));
    dbPath = join(testDir, "context.db");
    db = openContextEngineDb(dbPath);
    scorecard = new ScorecardTracker(db, "fixture", true);
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
      onScorecardFileRead: (p, m, c) => scorecard.trackReadPath(p, m, c),
      hasReadPath: (p) => scorecard.hasReadPath(p),
      getReadPathMtime: (p) => scorecard.getReadPathMtime(p),
      clearReadPath: (p) => scorecard.clearReadPath(p),
    });
  }

  it("emits exactly one recovery hint by the 3rd cross-channel access of the same file", async () => {
    writeFileSync(join(testDir, "run.tsx"), "export function run() {}\n".repeat(20));
    const tools = makeTools();

    // 1. shell cat (channel: shell) — no hint.
    const a = await tools.shell.execute({ command: "cat run.tsx" });
    expect(a.warning).toBeUndefined();

    // 2. shell cat again — duplicate, no intervention yet (threshold 3).
    const b = await tools.shell.execute({ command: "cat run.tsx" });
    expect(b.warning).toBeUndefined();
    expect(scorecard.getCounters().duplicateFileAccess).toBeGreaterThanOrEqual(1);

    // 3. third access — intervention fires exactly once.
    const c = await tools.shell.execute({ command: "cat run.tsx" });
    expect(c.warning).toMatch(/Churn:/);
    expect(scorecard.getCounters().churnInterventions).toBe(1);

    // 4. further access — no second intervention.
    const d = await tools.shell.execute({ command: "cat run.tsx" });
    expect(d.warning).toBeUndefined();
    expect(scorecard.getCounters().churnInterventions).toBe(1);

    // Well under the 81-call blowup from the evidence session.
    expect(scorecard.getCounters().churnInterventions).toBeLessThan(2);
  });

  it("alternating shell + read_file of the same path counts toward one intervention", async () => {
    writeFileSync(join(testDir, "alt.ts"), "export const alt = 1;\n".repeat(20));
    const tools = makeTools();

    await tools.shell.execute({ command: "cat alt.ts" });
    const r2 = await tools.read_file.execute({ path: "alt.ts" });
    expect(r2.ok).toBe(true);
    // Second access (read_file) — duplicate, but threshold not yet hit.
    expect(scorecard.getCounters().churnInterventions).toBe(0);

    // Third access via shell — intervention fires.
    const r3 = await tools.shell.execute({ command: "cat alt.ts" });
    expect(r3.warning).toMatch(/Churn:/);
    expect(scorecard.getCounters().churnInterventions).toBe(1);

    // Channel list in the hint includes both.
    expect(r3.warning).toContain("read_file");
    expect(r3.warning).toContain("shell");
  });
});
