/**
 * Streaming transcript scroll bounce.
 *
 * The viewport must not reverse direction while an assistant markdown answer
 * only grows. Metrics come from every frame the test renderer presents
 * (see scripts/tui-bounce/harness.tsx), at 110x40 and 80x24, for word and
 * 8-character chunk deltas, with stream batching off and at 33ms.
 *
 * The assertion requires zero bounce and zero scroll reversals.
 */
import { describe, expect, it } from "bun:test";
import {
  BOUNCE_MATRIX,
  formatBounceReport,
  runBounceMatrix,
} from "../scripts/tui-bounce/harness.js";

describe("transcript streaming scroll", () => {
  it("does not bounce while a markdown answer streams", async () => {
    const reports = await runBounceMatrix(BOUNCE_MATRIX);
    const bad: string[] = [];
    for (const report of reports) {
      console.log(formatBounceReport(report));
      expect(report.finalText).toContain("The last line of the answer is this one.");
      const { width, height, batchMs, deltas } = report.scenario;
      if (report.bounce !== 0 || report.scrollReversals !== 0) {
        bad.push(
          `${width}x${height} batch ${batchMs} ${deltas} bounce ${report.bounce} scroll ${report.scrollReversals}`,
        );
      }
    }
    expect(bad).toEqual([]);
  }, { timeout: 180_000 });
});
