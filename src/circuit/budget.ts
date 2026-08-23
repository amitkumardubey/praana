export type CircuitBudgetReason = "tokens" | "time";

export function checkCircuitBudget(input: {
  maxTokens: number;
  maxWallMs: number;
  tokens: number;
  elapsedMs: number;
}): CircuitBudgetReason | null {
  if (input.maxTokens > 0 && input.tokens >= input.maxTokens) return "tokens";
  if (input.maxWallMs > 0 && input.elapsedMs >= input.maxWallMs) return "time";
  return null;
}

export function circuitWrapUpInstruction(reason: CircuitBudgetReason): string {
  return `Circuit budget exceeded (${reason}). Reply with a final summary. Do not call tools.`;
}
