import type { Distiller, DistillerIntensity } from "../context-engine/distiller.js";
import type { ContentType } from "../context-engine/types.js";

export class TestDistiller implements Distiller {
  readonly name = "npm-test";
  readonly contentTypes: ContentType[] = ["test_output"];
  readonly mode = "sync" as const;

  distill(input: string, intensity: DistillerIntensity): string {
    const lines = input.split("\n");
    const failures: string[] = [];
    const passes: string[] = [];
    let captureStack = false;

    for (const line of lines) {
      if (/^\s*(FAIL|✕|×)\s/.test(line) || /\bFAIL\b/.test(line)) {
        failures.push(line);
        captureStack = true;
        continue;
      }
      if (/^\s*(PASS|✓)\s/.test(line) || /Tests:\s+\d+ passed/.test(line)) {
        passes.push(line);
        captureStack = false;
        continue;
      }
      if (captureStack) {
        if (line.startsWith("    at ") || line.startsWith("\tat ")) {
          if (intensity === "lite" && failures.length > 6) continue;
          failures.push(line);
        } else if (/^(TypeError|ReferenceError|AssertionError|Error):/.test(line.trim())) {
          failures.push(line);
        } else if (line.trim() && !/^\s*(PASS|FAIL|✓|✕)/.test(line)) {
          failures.push(line);
          captureStack = false;
        }
      }
    }

    const summaryMatch = input.match(
      /Tests:\s+(.+)|(\d+)\s+passed|(\d+)\s+failed|Test Suites:.+/i,
    );
    const parts: string[] = [];
    if (failures.length > 0) {
      const limit = intensity === "full" ? 12 : 24;
      parts.push(`${failures.length} failure line(s):`, ...failures.slice(0, limit));
    }
    if (summaryMatch) {
      parts.push(summaryMatch[0]);
    } else if (passes.length > 0) {
      parts.push(passes[passes.length - 1]);
    } else {
      parts.push(`Test output: ${lines.length} lines`);
    }
    return parts.join("\n");
  }
}
