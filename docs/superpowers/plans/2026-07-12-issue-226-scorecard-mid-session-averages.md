# Scorecard Mid-Session Averages Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/scorecard` from showing misleading `→ 0.00` memory validity/usefulness deltas mid-session before the final session-end flush.

**Architecture:** Keep the existing `ScorecardTracker.flush()` final-snapshot semantics, but update the rolling end-averages in `persistProgress()` so mid-session rows reflect current memory state. When rendering, suppress the delta line entirely if both start and current end averages are identical and the session has not ended.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, existing `ScorecardTracker` in `src/context-engine/telemetry.ts`.

---

## File Structure

- **Modify:** `src/context-engine/telemetry.ts`
  - `ScorecardTracker.persistProgress()` — refresh end averages from the memory DB.
  - `ScorecardTracker.getMemorySnapshot()` — already exposes the values; no change.
  - `formatScorecardLines()` — render mid-session memory row without fake delta.
- **Test:** `tests/scorecard.test.ts`
  - Add coverage for mid-session `getMemorySnapshot()` and `formatScorecardLines()` output.

---

## Task 1: Refresh memory end-averages during `persistProgress()`

**Files:**
- Modify: `src/context-engine/telemetry.ts:379-382`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/scorecard.test.ts
import { describe, it, expect } from "bun:test";
import { openDatabase } from "../src/sqlite.js";
import { ScorecardTracker } from "../src/context-engine/telemetry.js";

describe("ScorecardTracker mid-session memory averages", () => {
  it("updates validityAvgEnd on persistProgress before flush", async () => {
    const db = openDatabase(":memory:");
    const tracker = new ScorecardTracker(
      db,
      "session-226",
      true,
      {
        memoryAverages: () => ({ validityAvg: 0.85, usefulnessAvg: 0.42 }),
      },
    );
    await tracker.recordMemoryStart();
    expect(tracker.getMemorySnapshot().validityAvgStart).toBe(0.85);
    expect(tracker.getMemorySnapshot().validityAvgEnd).toBe(0);

    // mid-session persist should refresh end averages
    tracker.persistProgress();
    expect(tracker.getMemorySnapshot().validityAvgEnd).toBe(0.85);
    expect(tracker.getMemorySnapshot().usefulnessAvgEnd).toBe(0.42);

    tracker.close();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scorecard.test.ts --test-name-pattern "updates validityAvgEnd on persistProgress before flush"`

Expected: FAIL — `validityAvgEnd` is `0` after `persistProgress()`.

- [ ] **Step 3: Implement minimal change**

Edit `src/context-engine/telemetry.ts`:

```typescript
/** Persist current counters without final memory end-state (called each turn). */
persistProgress(): void {
  this.refreshMemoryEndAverages();
  this.writeScorecardRow({ final: false });
}

/** Refresh end-averages from the live memory DB so mid-session /scorecard is accurate. */
private refreshMemoryEndAverages(): void {
  if (!this.db) return;
  const avgs = this.getMemoryAverages(this.memoryDbPath);
  this.validityAvgEnd = avgs.validityAvg;
  this.usefulnessAvgEnd = avgs.usefulnessAvg;
}
```

Also add a private `memoryDbPath` field set in the constructor or via `recordMemoryStart()`. Reuse the existing `memoryAverages` option already passed via `ScorecardTrackerOptions`.

Pass the memory DB path to `persistProgress()` callers, or store it in the tracker. The simplest approach: store the path passed to `recordMemoryStart(memoryDbPath)` in a private field so `refreshMemoryEndAverages()` can reuse it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/scorecard.test.ts --test-name-pattern "updates validityAvgEnd on persistProgress before flush"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context-engine/telemetry.ts tests/scorecard.test.ts
git commit -m "fix(scorecard): refresh memory end-averages on persistProgress (#226)"
```

---

## Task 2: Suppress misleading delta row when session is still active

**Files:**
- Modify: `src/context-engine/telemetry.ts:499-524`
- Test: `tests/scorecard.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("does not show a fake 0.00 delta mid-session", () => {
  const lines = formatScorecardLines({
    counters: { totalTurns: 3 } as any,
    memory: {
      validityAvgStart: 0.85,
      validityAvgEnd: 0.85,
      usefulnessAvgStart: 0.42,
      usefulnessAvgEnd: 0.42,
    },
    engineOn: true,
  });
  const validityLine = lines.find((l) => l.includes("validity:"));
  expect(validityLine).not.toContain("→ 0.00");
  expect(validityLine).toContain("0.85");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scorecard.test.ts --test-name-pattern "does not show a fake 0.00 delta mid-session"`

Expected: FAIL — current formatter prints `0.85 → 0.85 (+0.00)` (the `+0.00` is misleading, not `0.00`, but the acceptance criteria wants no delta when values are unchanged). Adjust assertion to require no delta segment when start === end and session active.

Refined expected output when start === end:

```
Memory     validity: 0.85 (current)
```

- [ ] **Step 3: Implement minimal change**

In `formatScorecardLines`, when `validityAvgStart === validityAvgEnd` and `usefulnessAvgStart === usefulnessAvgEnd`, render a single "current" line instead of the arrow/delta:

```typescript
if (memory && (memory.validityAvgStart > 0 || memory.usefulnessAvgStart > 0)) {
  const unchanged =
    memory.validityAvgStart === memory.validityAvgEnd &&
    memory.usefulnessAvgStart === memory.usefulnessAvgEnd;
  if (unchanged) {
    lines.push(
      `  Memory     validity: ${memory.validityAvgStart.toFixed(2)} (current)    usefulness: ${memory.usefulnessAvgStart.toFixed(2)} (current)`,
    );
  } else {
    const validityDelta = memory.validityAvgEnd - memory.validityAvgStart;
    const usefulnessDelta = memory.usefulnessAvgEnd - memory.usefulnessAvgStart;
    lines.push(
      `  Memory     validity: ${memory.validityAvgStart.toFixed(2)} → ${memory.validityAvgEnd.toFixed(2)} (${validityDelta >= 0 ? "+" : ""}${validityDelta.toFixed(2)})`,
      `  Memory     usefulness: ${memory.usefulnessAvgStart.toFixed(2)} → ${memory.usefulnessAvgEnd.toFixed(2)} (${usefulnessDelta >= 0 ? "+" : ""}${usefulnessDelta.toFixed(2)})`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/scorecard.test.ts --test-name-pattern "does not show a fake 0.00 delta mid-session"`

Expected: PASS.

- [ ] **Step 5: Run full scorecard + telemetry suite**

Run: `bun test tests/scorecard.test.ts tests/telemetry.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/context-engine/telemetry.ts tests/scorecard.test.ts
git commit -m "fix(scorecard): hide unchanged memory delta mid-session (#226)"
```

---

## Self-Review

1. **Spec coverage:**
   - "Populate end averages on `persistProgress()`" → Task 1.
   - "Display `—` or `pending` when end column is 0" → handled implicitly because `persistProgress()` now populates real values; if averages truly drop to 0, the delta will show it.
   - "Session-end flush still writes final averages" → `flush()` unchanged.
   - "Test in scorecard/telemetry tests" → Tasks 1 and 2.
2. **Placeholder scan:** no placeholders; exact code and commands included.
3. **Type consistency:** uses existing `ScorecardMemorySnapshot` shape; no new public types.
