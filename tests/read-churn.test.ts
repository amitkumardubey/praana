import { describe, it, expect, afterEach } from "bun:test";
import {
  ARTIFACT_RETRIEVE_RETRY_THRESHOLD,
  CHURN_PATH_THRESHOLD,
  buildArtifactRetrievalKey,
  buildPathChurnHint,
  buildRetrieveChurnHint,
} from "../src/tools/read-churn.js";
import { openContextEngineDb } from "../src/context-engine/db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ScorecardTracker } from "../src/context-engine/telemetry.js";

describe("read-churn helpers", () => {
  it("builds stable retrieval keys", () => {
    const a = buildArtifactRetrievalKey("art_1", {
      grep: "foo",
      lineStart: 1,
      lineEnd: 10,
    });
    const b = buildArtifactRetrievalKey("art_1", {
      lineEnd: 10,
      lineStart: 1,
      grep: "foo",
    });
    const c = buildArtifactRetrievalKey("art_1", { grep: "bar" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("formats recovery hints", () => {
    const hint = buildPathChurnHint("src/a.ts", 4, ["read_file", "shell"]);
    expect(hint).toContain("src/a.ts");
    expect(hint).toContain("4");
    expect(hint).toContain("read_file");
    expect(hint).toContain("shell");
    expect(buildRetrieveChurnHint("art_abc", 3)).toContain("art_abc");
  });

  it("exports thresholds used by tracker", () => {
    expect(CHURN_PATH_THRESHOLD).toBe(3);
    expect(ARTIFACT_RETRIEVE_RETRY_THRESHOLD).toBe(2);
  });
});

describe("ScorecardTracker file-access churn", () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const p of cleanup) {
      try {
        rmSync(p, { force: true });
      } catch {
        // ignore
      }
    }
    cleanup.length = 0;
  });

  function createDb(): Database {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "praana-read-churn-")),
      "context.db",
    );
    cleanup.push(dbPath);
    return openContextEngineDb(dbPath);
  }

  it("counts duplicateFileAccess and fires one intervention at threshold", () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "s1", true);

    const r1 = tracker.trackFileAccess("/tmp/a.ts", "read_file");
    expect(r1).toEqual({ count: 1, isDuplicate: false, shouldIntervene: false });

    const r2 = tracker.trackFileAccess("/tmp/a.ts", "shell");
    expect(r2.isDuplicate).toBe(true);
    expect(r2.count).toBe(2);
    expect(r2.shouldIntervene).toBe(false);
    expect(tracker.getCounters().duplicateFileAccess).toBe(1);

    const r3 = tracker.trackFileAccess("/tmp/a.ts", "shell");
    expect(r3.count).toBe(3);
    expect(r3.shouldIntervene).toBe(true); // hits CHURN_PATH_THRESHOLD
    expect(tracker.getCounters().churnInterventions).toBe(1);

    const r4 = tracker.trackFileAccess("/tmp/a.ts", "read_file");
    expect(r4.shouldIntervene).toBe(false); // already intervened
    expect(tracker.getCounters().churnInterventions).toBe(1);
  });

  it("trackArtifactRetrieve flags retries on identical key only", () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "s1", true);
    const opts = { lineStart: 1, lineEnd: 20 };

    const a = tracker.trackArtifactRetrieve("art_1", opts);
    expect(a).toEqual({ count: 1, isRetry: false });

    const b = tracker.trackArtifactRetrieve("art_1", opts);
    expect(b.isRetry).toBe(true);
    expect(b.count).toBe(2);
    expect(tracker.getCounters().artifactRetrievalRetries).toBe(1);

    const c = tracker.trackArtifactRetrieve("art_1", {
      lineStart: 21,
      lineEnd: 40,
    });
    expect(c.isRetry).toBe(false); // different key
    expect(tracker.getCounters().artifactRetrievalRetries).toBe(1);
  });

  it("persists and restores new churn counters", () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "s1", true);
    tracker.trackFileAccess("/tmp/a.ts", "shell");
    tracker.trackFileAccess("/tmp/a.ts", "shell");
    tracker.trackFileAccess("/tmp/a.ts", "shell"); // intervention
    tracker.trackArtifactRetrieve("art_1", {});
    tracker.trackArtifactRetrieve("art_1", {});
    tracker.persistProgress();

    const resumed = new ScorecardTracker(db, "s1", true);
    expect(resumed.restoreFromDb()).toBe(true);
    const c = resumed.getCounters();
    expect(c.duplicateFileAccess).toBe(2);
    expect(c.churnInterventions).toBe(1);
    expect(c.artifactRetrievalRetries).toBe(1);
    // Per-path state is session-local — not restored (like mtimes).
  });
});
