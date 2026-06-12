import type { OpenError, ToolCallRecord, TurnRecord } from "./types.js";

export function toolErrorKey(tool: string, args: Record<string, unknown>): string {
  const command =
    typeof args.command === "string"
      ? args.command
      : typeof args.path === "string"
        ? args.path
        : JSON.stringify(args);
  return `${tool}:${command}`;
}

export function isTestCommand(command: string): boolean {
  return /\b(npm test|pnpm test|yarn test|vitest|pytest|cargo test|go test)\b/i.test(
    command,
  );
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

    for (const tc of record.toolCalls) {
      const key = toolErrorKey(tc.tool, tc.args);
      const command = typeof tc.args.command === "string" ? tc.args.command : undefined;

      if (tc.isError || record.errors.length > 0) {
        const message =
          record.errors.find((e) => e.length > 0) ??
          tc.resultText?.slice(0, 200) ??
          "tool error";
        if (tc.isError && !this.openErrors.has(key)) {
          this.openErrors.set(key, {
            key,
            message,
            turn,
            tool: tc.tool,
            command,
          });
          errorsNew.push(message);
        }
        if (command && isTestCommand(command)) {
          this.testFailed = true;
        }
        continue;
      }

      if (this.openErrors.has(key)) {
        const prev = this.openErrors.get(key)!;
        this.openErrors.delete(key);
        const label = prev.command ?? prev.tool;
        errorsFixed.push(label);
      }

      if (command && isTestCommand(command)) {
        this.testFailed = false;
      }
    }

    for (const err of record.errors) {
      if (!errorsNew.includes(err)) errorsNew.push(err);
    }

    return { errorsNew, errorsFixed };
  }
}
