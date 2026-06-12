import type { ToolCallRecord, TurnRecord } from "./types.js";

export function extractToolError(result: unknown, isError: boolean): string | null {
  if (isError) {
    if (result && typeof result === "object" && "error" in result) {
      return String((result as { error?: unknown }).error ?? "tool error");
    }
    return "tool error";
  }
  if (result && typeof result === "object" && "ok" in result) {
    if ((result as { ok?: unknown }).ok === false) {
      return String((result as { error?: unknown }).error ?? "tool failed");
    }
  }
  return null;
}

export function extractFilePathsFromTool(
  tool: string,
  args: Record<string, unknown>,
): { read?: string; written?: string } {
  const path = typeof args.path === "string" ? args.path : undefined;
  if (!path) return {};

  if (tool === "read_file" || tool === "read_and_summarize") {
    return { read: path };
  }
  if (tool === "write_file" || tool === "edit_file") {
    return { written: path };
  }
  return {};
}

export function buildTurnSearchText(record: TurnRecord): string {
  const parts = [
    record.userMessage,
    record.assistantMessage,
    ...record.errors,
    ...record.filesRead,
    ...record.filesWritten,
    ...record.artifactIds,
    ...record.toolCalls.map(
      (tc) => `${tc.tool} ${JSON.stringify(tc.args)}`,
    ),
  ];
  return parts.filter(Boolean).join("\n");
}

export class TurnRecorder {
  private readonly toolCalls: ToolCallRecord[] = [];
  private readonly artifactIds = new Set<string>();
  private readonly filesRead = new Set<string>();
  private readonly filesWritten = new Set<string>();
  private readonly errors: string[] = [];

  constructor(readonly userMessage: string) {}

  recordToolCall(input: {
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
    isError: boolean;
    artifactId?: string;
  }): void {
    this.toolCalls.push({
      tool: input.tool,
      args: input.args,
      resultArtifactId: input.artifactId,
      isError: input.isError,
      resultText: truncateResultText(input.result),
    });

    if (input.artifactId) this.artifactIds.add(input.artifactId);

    const paths = extractFilePathsFromTool(input.tool, input.args);
    if (paths.read) this.filesRead.add(paths.read);
    if (paths.written) this.filesWritten.add(paths.written);

    const err = extractToolError(input.result, input.isError);
    if (err) this.errors.push(err);
  }

  toRecord(assistantMessage: string, turn: number, tokenCount: number): TurnRecord {
    return {
      turn,
      userMessage: this.userMessage,
      assistantMessage,
      toolCalls: [...this.toolCalls],
      artifactIds: [...this.artifactIds],
      filesRead: [...this.filesRead],
      filesWritten: [...this.filesWritten],
      errors: [...this.errors],
      tokenCount,
      timestamp: Date.now(),
    };
  }
}

function truncateResultText(result: unknown, maxLen = 400): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}
