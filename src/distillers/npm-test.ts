import type { Distiller, DistillerIntensity } from "../context-engine/distiller.js";
import type { ContentType } from "../context-engine/types.js";

export class TestDistiller implements Distiller {
  readonly name = "npm-test";
  readonly contentTypes: ContentType[] = ["test_output"];
  readonly mode = "sync" as const;

  distill(input: string, intensity: DistillerIntensity): string {
    const lines = input.split("\n");
    const failures: string[] = [];
    const summaries: string[] = [];
    let captureFailure = false;
    const failureLimit = intensity === "full" ? 80 : 140;
    const lineCap = 4096;

    for (const line of lines) {
      const trimmed = line.trim();
      const capped = line.length > lineCap ? line.slice(0, lineCap) : line;
      const isFailureStart =
        /^\s*(FAIL|✕|×)\s/.test(capped) ||
        /\bFAIL\b/.test(capped) ||
        /^AssertionError\b/.test(trimmed) ||
        /^(TypeError|ReferenceError|Error):/.test(trimmed);
      const isPassingSuite = /^\s*(PASS|✓)\s/.test(capped);
      const isSummary =
        /^(Test Files|Tests|Test Suites|Snapshots|Time):/.test(trimmed) ||
        /^Tests:\s+/.test(trimmed) ||
        /^\d+\s+(passed|failed)\b/i.test(trimmed);

      if (isSummary) {
        summaries.push(capped);
        if (/failed/i.test(capped)) captureFailure = true;
        continue;
      }

      if (isPassingSuite) {
        captureFailure = false;
        continue;
      }

      if (isFailureStart) {
        captureFailure = true;
      }

      if (captureFailure && failures.length < failureLimit) {
        failures.push(capped);
      }
    }

    const parts: string[] = [];
    if (failures.length > 0) {
      parts.push(`${failures.length} failure detail line(s):`, ...failures);
    }
    if (summaries.length > 0) {
      parts.push("Summary:", ...summaries.slice(-6));
    } else {
      parts.push(`Test output: ${lines.length} lines`);
    }
    const result = parts.join("\n");
    return result.length > input.length ? input : result;
  }
}
