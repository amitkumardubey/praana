import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as toml from "toml";
import type { AriaConfig } from "./types.js";

const DEFAULT_CONFIG: AriaConfig = {
  llm: {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
  },
  bodha: {
    enabled: true,
    summarizer: "disabled",
  },
  compiler: {
    token_budget: 100_000,
    recent_turns: 10,
  },
  tiers: {
    idle_soft_after_turns: 20,
    idle_hard_after_turns: 50,
  },
  session: {
    log_dir: "~/.aria/sessions",
  },
};

function expandHome(p: string): string {
  return p.startsWith("~/") ? p.replace(/^~\//, `${homedir()}/`) : p;
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  const out = { ...base } as any;
  for (const [k, v] of Object.entries(override as any)) {
    const bv = (base as any)[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      bv &&
      typeof bv === "object" &&
      !Array.isArray(bv)
    ) {
      out[k] = deepMerge(bv, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadConfig(configPath?: string): AriaConfig {
  const path = configPath ?? expandHome("~/.aria/config.toml");
  let user: Record<string, unknown> = {};
  if (existsSync(path)) {
    user = toml.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  }
  const merged = deepMerge(DEFAULT_CONFIG, user as any) as AriaConfig;
  // Environment variable overrides
  if (process.env.ARIA_MODEL) merged.llm.model = process.env.ARIA_MODEL;
  // Expand paths
  (merged as any).session.log_dir = expandHome(merged.session.log_dir);
  return merged;
}
