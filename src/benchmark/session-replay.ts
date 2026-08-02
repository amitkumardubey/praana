import type { Event } from "../types.js";
import type { ToolCallRecord } from "../context-engine/types.js";

export interface ReplayTurn {
  turnNumber: number;
  userMessage: string;
  assistantMessage: string;
  toolCalls: ToolCallRecord[];
  filesRead: string[];
  filesWritten: string[];
  errors: string[];
}

/**
 * Replay a list of events into turn snapshots.
 * Each user_message starts a new turn; tool calls and results are grouped within.
 */
export function replaySession(events: Event[]): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  let currentTurn: ReplayTurn | null = null;

  for (const event of events) {
    switch (event.kind) {
      case "user_message": {
        if (currentTurn) {
          turns.push(currentTurn);
        }
        currentTurn = {
          turnNumber: turns.length + 1,
          userMessage: (event.payload.text as string) ?? "",
          assistantMessage: "",
          toolCalls: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
        };
        break;
      }
      case "agent_message": {
        if (currentTurn) {
          currentTurn.assistantMessage = (event.payload.text as string) ?? "";
        }
        break;
      }
      case "tool_call": {
        if (currentTurn) {
          const args = (event.payload.args as Record<string, unknown>) ?? {};
          currentTurn.toolCalls.push({
            tool: (event.payload.tool as string) ?? "unknown",
            args,
            isError: false,
          });
          // Track file operations from tool_call args
          const tool = (event.payload.tool as string) ?? "";
          if (tool === "read_file" && typeof args.path === "string") {
            currentTurn.filesRead.push(args.path);
          }
          if (tool === "write_file" && typeof args.path === "string") {
            currentTurn.filesWritten.push(args.path);
          }
        }
        break;
      }
      case "tool_result": {
        if (currentTurn) {
          const lastTool = currentTurn.toolCalls[currentTurn.toolCalls.length - 1];
          if (lastTool) {
            lastTool.resultText = typeof event.payload.result === "string"
              ? event.payload.result
              : JSON.stringify(event.payload.result);
          }
        }
        break;
      }
    }
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
}
