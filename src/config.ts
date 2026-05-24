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
    recent_turns_token_budget: 30_000, // 30% of default token_budget
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

function loadJsonConfig(path: string): Record<string, unknown> {
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[config] Failed to parse JSON config ${path}:`, (err as Error).message);
    }
  }
  return {};
}

function loadTomlConfig(path: string): Record<string, unknown> {
  if (existsSync(path)) {
    try {
      return toml.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[config] Failed to parse TOML config ${path}:`, (err as Error).message);
    }
  }
  return {};
}

export function loadConfig(configPath?: string): AriaConfig {
  let userConfig: Record<string, unknown> = {};

  if (configPath) {
    // If explicit path provided, use it (try both .json and .toml)
    if (configPath.endsWith('.json')) {
      userConfig = loadJsonConfig(configPath);
    } else if (configPath.endsWith('.toml')) {
      userConfig = loadTomlConfig(configPath);
    } else {
      // Try both extensions
      userConfig = loadJsonConfig(configPath + '.json');
      if (Object.keys(userConfig).length === 0) {
        userConfig = loadTomlConfig(configPath + '.toml');
      }
    }
  } else {
    // Load and merge configs from all sources in order
    // Order: global JSON -> global TOML -> local JSON -> local TOML
    // Later sources override earlier ones
    
    // Global configs (lower priority)
    const globalJsonPath = expandHome("~/.aria/aria.config.json");
    const globalTomlPath = expandHome("~/.aria/config.toml");
    
    // Local configs (higher priority)
    const localJsonPath = "aria.config.json";
    const localTomlPath = "aria.config.toml";
    
    // Collect all configs to merge
    const configs = [
      { path: globalJsonPath, loader: loadJsonConfig },
      { path: globalTomlPath, loader: loadTomlConfig },
      { path: localJsonPath, loader: loadJsonConfig },
      { path: localTomlPath, loader: loadTomlConfig },
    ];
    
    // Merge all configs in order (later overrides earlier)
    for (const { path, loader } of configs) {
      const config = loader(path);
      if (Object.keys(config).length > 0) {
        userConfig = deepMerge(userConfig as any, config) as Record<string, unknown>;
      }
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, userConfig as any) as AriaConfig;
  
  // Environment variable overrides
  if (process.env.ARIA_MODEL) merged.llm.model = process.env.ARIA_MODEL;
  
  // Expand paths
  merged.session.log_dir = expandHome(merged.session.log_dir);
  if (merged.memory?.bodha_db_path) {
    merged.memory.bodha_db_path = expandHome(merged.memory.bodha_db_path);
  }
  
  return merged;
}
