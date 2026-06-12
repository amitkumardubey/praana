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

    for (const line of lines) {
      const trimmed = line.trim();
      const isFailureStart =
        /^\s*(FAIL|✕|×)\s/.test(line) ||
        /\bFAIL\b/.test(line) ||
        /^AssertionError\b/.test(trimmed) ||
        /^(TypeError|ReferenceError|Error):/.test(trimmed);
      const isPassingSuite = /^\s*(PASS|✓)\s/.test(line);
      const isSummary =
        /^(Test Files|Tests|Test Suites|Snapshots|Time):/.test(trimmed) ||
        /^Tests:\s+/.test(trimmed) ||
        /^\d+\s+(passed|failed)\b/i.test(trimmed);

      if (isSummary) {
        summaries.push(line);
        if (/failed/i.test(line)) captureFailure = true;
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
        failures.push(line);
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
    return parts.join("\n");
  }
}
