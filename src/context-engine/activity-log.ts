import type {
  ActivityEntry,
  ActivityEntryType,
  ToolCallRecord,
  TurnDigest,
  TurnRecord,
} from "./types.js";
import { isTestCommand } from "./error-tracker.js";

const TEST_FAIL_RE = /(\d+)\s+failing|FAIL|failed/i;

export function deriveActivityEntries(
  turn: number,
  digest: TurnDigest,
  record: TurnRecord,
  testWasFailing: boolean,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const tc of record.toolCalls) {
    entries.push(...activityFromToolCall(turn, tc, testWasFailing));
  }

  for (const decision of digest.decisions) {
    const summary =
      typeof decision === "string" ? decision : decision.summary;
    entries.push({
      turn,
      type: "decision_made",
      summary: `Decided: ${summary}`,
    });
  }

  for (const fixed of digest.errorsFixed) {
    entries.push({
      turn,
      type: "error_fixed",
      summary: `Fixed: ${fixed}`,
    });
  }

  return entries;
}

function activityFromToolCall(
  turn: number,
  tc: ToolCallRecord,
  testWasFailing: boolean,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  const command = typeof tc.args.command === "string" ? tc.args.command : undefined;
  const path = typeof tc.args.path === "string" ? tc.args.path : undefined;

  if (tc.tool === "shell" && command) {
    if (/git\s+commit\b/.test(command) && !tc.isError) {
      entries.push({
        turn,
        type: "commit",
        summary: `Committed: ${extractCommitMessage(tc.resultText)}`,
        artifactRef: tc.resultArtifactId,
      });
    }

    if (isTestCommand(command)) {
      if (tc.isError) {
        entries.push({
          turn,
          type: "test_fail",
          summary: `Tests failing: ${extractFailureCount(tc.resultText)}`,
          artifactRef: tc.resultArtifactId,
        });
      } else if (testWasFailing) {
        entries.push({
          turn,
          type: "test_pass",
          summary: `Tests passing: ${command.split(/\s+/).slice(0, 2).join(" ")}`,
          artifactRef: tc.resultArtifactId,
        });
      }
    }
  }

  if ((tc.tool === "write_file" || tc.tool === "edit_file") && !tc.isError && path) {
    entries.push({
      turn,
      type: "file_written",
      summary: `Wrote: ${path}`,
      artifactRef: tc.resultArtifactId,
    });
  }

  return entries;
}

function extractCommitMessage(resultText?: string): string {
  if (!resultText) return "changes";
  try {
    const parsed = JSON.parse(resultText) as { stdout?: string; output?: string };
    const stdout = parsed.stdout ?? parsed.output ?? resultText;
    const firstLine = stdout.split("\n").map((l) => l.trim()).find(Boolean);
    return firstLine?.slice(0, 120) ?? "changes";
  } catch {
    const firstLine = resultText.split("\n").map((l) => l.trim()).find(Boolean);
    return firstLine?.slice(0, 120) ?? "changes";
  }
}

function extractFailureCount(resultText?: string): string {
  if (!resultText) return "unknown count";
  const match = resultText.match(TEST_FAIL_RE);
  if (match?.[1]) return `${match[1]} failures`;
  if (/fail/i.test(resultText)) return "failures detected";
  return "failures detected";
}

export class ActivityLog {
  private entries: ActivityEntry[] = [];

  constructor(
    private readonly maxEntries: number,
    initial: ActivityEntry[] = [],
  ) {
    this.entries = initial.slice(-maxEntries);
  }

  append(entries: ActivityEntry[]): void {
    if (entries.length === 0) return;
    this.entries.push(...entries);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  list(): ActivityEntry[] {
    return [...this.entries];
  }
}
