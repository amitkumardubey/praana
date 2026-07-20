/**
 * Headless usage report for Harbor / CI: tokens (+ optional $ estimate).
 * Written to PRAANA_USAGE_PATH when set, else ~/.praana/last-run-usage.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envOverride, APP_HOME_DIR } from "./app-identity.js";
import type { Session } from "./session.js";

export type HeadlessUsageReport = {
  schema_version: 1;
  session_id: string;
  provider: string;
  model: string;
  /** Preferred / effective effort (config or /reasoning). */
  reasoning_effort: string;
  /**
   * Wire value last passed to pi-ai `stream()` as `reasoningEffort`.
   * `null` when the active model does not use chain-of-thought, or no turn ran.
   */
  reasoning_effort_wire: string | null;
  n_input_tokens: number;
  n_output_tokens: number;
  n_cache_tokens: number;
  /** Estimated USD from a static price table; null when unknown. */
  cost_usd: number | null;
};

/** USD per 1M tokens. Rough OpenRouter list prices for Harbor reporting. */
type PricePerMillion = { input: number; output: number; cache?: number };

const MODEL_PRICES_PER_MILLION: Record<string, PricePerMillion> = {
  "anthropic/claude-sonnet-4": { input: 3, output: 15, cache: 0.3 },
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15, cache: 0.3 },
  "anthropic/claude-sonnet-5": { input: 3, output: 15, cache: 0.3 },
  "anthropic/claude-opus-4": { input: 15, output: 75, cache: 1.5 },
  "anthropic/claude-opus-4.1": { input: 15, output: 75, cache: 1.5 },
  "anthropic/claude-opus-4.5": { input: 15, output: 75, cache: 1.5 },
  "openai/gpt-4.1": { input: 2, output: 8 },
  "openai/gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "google/gemini-2.5-pro": { input: 1.25, output: 10 },
  "google/gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "z-ai/glm-5.2": { input: 0.6, output: 2.2 },
  // Umans pay-per-token (service-account). umans-coder currently routes to kimi.
  "umans-coder": { input: 0.95, output: 4.0, cache: 0.19 },
  "umans-kimi-k2.7": { input: 0.95, output: 4.0, cache: 0.19 },
  "umans-glm-5.2": { input: 1.4, output: 4.4, cache: 0.26 },
  "umans-flash": { input: 0.15, output: 1.0, cache: 0.05 },
};

export function lookupModelPrice(model: string): PricePerMillion | null {
  const exact = MODEL_PRICES_PER_MILLION[model];
  if (exact) return exact;
  // Harbor / OpenRouter sometimes prefixes; try suffix match on longest key.
  let best: PricePerMillion | null = null;
  let bestLen = -1;
  for (const [key, price] of Object.entries(MODEL_PRICES_PER_MILLION)) {
    if (model === key || model.endsWith(`/${key}`) || model.endsWith(key)) {
      if (key.length > bestLen) {
        best = price;
        bestLen = key.length;
      }
    }
  }
  return best;
}

export function estimateCostUsd(
  model: string,
  nInput: number,
  nOutput: number,
  nCache = 0,
): number | null {
  const price = lookupModelPrice(model);
  if (!price) return null;
  const cacheRate = price.cache ?? price.input;
  const usd =
    (nInput / 1_000_000) * price.input +
    (nOutput / 1_000_000) * price.output +
    (nCache / 1_000_000) * cacheRate;
  return Math.round(usd * 1e6) / 1e6;
}

export function resolveUsageReportPath(explicit?: string | null): string {
  const fromEnv = explicit?.trim() || envOverride("PRAANA_USAGE_PATH");
  if (fromEnv) return fromEnv;
  return join(homedir(), APP_HOME_DIR, "last-run-usage.json");
}

export function buildHeadlessUsageReport(
  session: Pick<
    Session,
    | "id"
    | "config"
    | "getInputTokens"
    | "getOutputTokens"
    | "getEffectiveReasoningEffort"
    | "getLastReasoningEffortUsed"
  >,
): HeadlessUsageReport {
  const provider = session.config.llm.provider ?? "";
  const model = session.config.llm.model ?? "";
  const n_input_tokens = session.getInputTokens();
  const n_output_tokens = session.getOutputTokens();
  const n_cache_tokens = 0; // not yet separated in ProviderUsage
  return {
    schema_version: 1,
    session_id: session.id,
    provider,
    model,
    reasoning_effort: session.getEffectiveReasoningEffort(),
    reasoning_effort_wire: session.getLastReasoningEffortUsed(),
    n_input_tokens,
    n_output_tokens,
    n_cache_tokens,
    cost_usd: estimateCostUsd(model, n_input_tokens, n_output_tokens, n_cache_tokens),
  };
}

export function writeHeadlessUsageReport(
  session: Pick<
    Session,
    | "id"
    | "config"
    | "getInputTokens"
    | "getOutputTokens"
    | "getEffectiveReasoningEffort"
    | "getLastReasoningEffortUsed"
  >,
  path?: string | null,
): HeadlessUsageReport {
  const report = buildHeadlessUsageReport(session);
  const outPath = resolveUsageReportPath(path);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
