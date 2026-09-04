// Clean TypeScript fixture: parses without diagnostics.
import { helper } from "./helper.js";

export function cleanFunction(input: number): number {
  return input + helper();
}

export class CleanWidget {
  private value: number = 0;

  increment(step: number): number {
    this.value += step;
    return this.value;
  }
}
