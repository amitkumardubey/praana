import type { OpenError, ToolCallRecord, TurnRecord } from "./types.js";
import { isTestCommand } from "../domain/coding-domain.js";

export function toolErrorKey(
  tool: string,
  args: Record<string, unknown>,
  message?: string,
): string {
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.path === "string"
        ? args.path
        : JSON.stringify(args);
  const base = `${tool}:${command}`;
  return message ? `${base}:${message}` : base;
}

function toolErrorBaseKey(tool: string, args: Record<string, unknown>): string {
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.path === "string"
        ? args.path
        : JSON.stringify(args);
  return `${tool}:${command}`;
}

export class ErrorTracker {
  private openErrors = new Map<string, OpenError>();
  private testFailed = false;

  constructor(initial?: { openErrors?: OpenError[]; testFailed?: boolean }) {
    for (const err of initial?.openErrors ?? []) {
      this.openErrors.set(err.key, err);
    }
    this.testFailed = initial?.testFailed ?? false;
  }

  getOpenErrors(): OpenError[] {
    return [...this.openErrors.values()];
  }

  isTestFailed(): boolean {
    return this.testFailed;
  }

  serialize(): { openErrors: OpenError[]; testFailed: boolean } {
    return {
      openErrors: this.getOpenErrors(),
      testFailed: this.testFailed,
    };
  }

  processTurn(
    turn: number,
    record: TurnRecord,
  ): { errorsNew: string[]; errorsFixed: string[] } {
    const errorsNew: string[] = [];
    const errorsFixed: string[] = [];
    const capturedMessages = new Set<string>();

    for (const tc of record.toolCalls) {
      const baseKey = toolErrorBaseKey(tc.tool, tc.args);
      const command = typeof tc.args.command === "string" ? tc.args.command : undefined;

      if (tc.isError) {
        const message = tc.resultText?.slice(0, 200) ?? "tool error";
        capturedMessages.add(message);
        if (!this.openErrors.has(baseKey)) {
          this.openErrors.set(baseKey, {
            key: baseKey,
            message,
            turn,
            tool: tc.tool,
            command,
          });
          errorsNew.push(message);
        } else {
          const existing = this.openErrors.get(baseKey)!;
          if (existing.message !== message) {
            existing.message = message;
            existing.turn = turn;
            errorsNew.push(message);
          }
        }
        if (command && isTestCommand(command)) {
          this.testFailed = true;
        }
        continue;
      }

      if (this.openErrors.has(baseKey)) {
        const prev = this.openErrors.get(baseKey)!;
        this.openErrors.delete(baseKey);
        errorsFixed.push(prev.command ?? prev.tool);
      }

      if (command && isTestCommand(command)) {
        this.testFailed = false;
      }
    }

    for (const err of record.errors) {
      if (capturedMessages.has(err)) continue;
      const key = `turn:${err}`;
      if (!this.openErrors.has(key)) {
        this.openErrors.set(key, {
          key,
          message: err,
          turn,
          tool: "turn",
          command: undefined,
        });
        errorsNew.push(err);
      }
    }

    return { errorsNew, errorsFixed };
  }
}
