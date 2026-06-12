import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as toml from "toml";
import type { AriaConfig } from "./types.js";

/** Tracks which config files were loaded in the last loadConfig() call. */
let _loadedSources: string[] = [];

export function getLoadedConfigSources(): string[] {
  return _loadedSources;
}

const DEFAULT_CONFIG: AriaConfig = {
  llm: {
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash:free",
  },
  memory: {
    enabled: true,
    summarizer: "openrouter",
    db_path: "~/.aria/memory.db",
    embedder: "auto",
    ollama_url: "http://localhost:11434",
    ollama_model: "nomic-embed-text",
  },
  compiler: {
    token_budget: 100_000,
    recent_turns: 10,
    recent_turns_token_budget: 30_000,
    recall_min_score: 0.35,
    memories_budget_ratio: 0.2,
    agents_budget_ratio: 0.3,
    reserved_output_tokens: 0,
    compression_watermark: 0.75,
    compression_flush_fraction: 0.30,
  },
  tiers: {
    idle_soft_after_turns: 20,
    idle_hard_after_turns: 50,
  },
  session: {
    log_dir: "~/.aria/sessions",
  },
  consolidation: {
    enabled: true,
    promotion_threshold: 3,
    run_delay_seconds: 30,
  },
  shell: {
    enabled: false,
    allowed_paths: [],
  },
  edit: {
    confirm: false,
  },
  skills: {
    enabled: true,
    max_token_budget_ratio: 0.2,
    active_skill_idle_turns: 5,
    warm_skill_eviction_turns: 20,
    max_depth: 6,
  },
  ui: {
    mode: "tui",
    screen: "preserve",
  },
  context_engine: {
    enabled: true,
    measurement_mode: false,
    artifact_inline_threshold: 400,
    artifact_ttl_turns: 50,
    distiller: {
      default_intensity: "full",
    },
    llm_digest: false,
    activity_log_max_entries: 15,
    checkpoint_enabled: true,
    scoring_enabled: true,
    scoring: {
      w_pin: 1.0,
      w_recency: 0.5,
      w_relevance: 0.3,
    },
    pressure: {
      compact_at: 0.7,
      emergency_at: 0.85,
    },
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
  _loadedSources = []; // reset on each call

  if (configPath) {
    // If explicit path provided, use it (try both .json and .toml)
    if (configPath.endsWith('.json')) {
      userConfig = loadJsonConfig(configPath);
      if (Object.keys(userConfig).length > 0) _loadedSources.push(configPath);
    } else if (configPath.endsWith('.toml')) {
      userConfig = loadTomlConfig(configPath);
      if (Object.keys(userConfig).length > 0) _loadedSources.push(configPath);
    } else {
      // Try both extensions
      const jsonPath = configPath + '.json';
      userConfig = loadJsonConfig(jsonPath);
      if (Object.keys(userConfig).length > 0) {
        _loadedSources.push(jsonPath);
      } else {
        const tomlPath = configPath + '.toml';
        userConfig = loadTomlConfig(tomlPath);
        if (Object.keys(userConfig).length > 0) _loadedSources.push(tomlPath);
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
        _loadedSources.push(path);
      }
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, userConfig as any) as AriaConfig;

  // Backward compat: skills_budget_ratio → agents_budget_ratio
  const compiler = (userConfig as { compiler?: { skills_budget_ratio?: number; agents_budget_ratio?: number } }).compiler;
  if (compiler?.skills_budget_ratio !== undefined && compiler.agents_budget_ratio === undefined) {
    merged.compiler.agents_budget_ratio = compiler.skills_budget_ratio;
  }

  // Backward compat: map old [bodha] config to [memory]
  if ((userConfig as any).bodha && !(userConfig as any).memory) {
    merged.memory = { ...merged.memory, ...(userConfig as any).bodha };
  }

  // Environment variable overrides
  if (process.env.ARIA_MODEL) merged.llm.model = process.env.ARIA_MODEL;
  if (process.env.ARIA_CONTEXT_ENGINE !== undefined) {
    merged.context_engine.enabled =
      process.env.ARIA_CONTEXT_ENGINE === "true" ||
      process.env.ARIA_CONTEXT_ENGINE === "1";
  }
  if (process.env.ARIA_MEASUREMENT_MODE !== undefined) {
    merged.context_engine.measurement_mode =
      process.env.ARIA_MEASUREMENT_MODE === "true" ||
      process.env.ARIA_MEASUREMENT_MODE === "1";
  }
  
  // Expand paths
  merged.session.log_dir = expandHome(merged.session.log_dir);
  if (merged.memory?.db_path) {
    merged.memory.db_path = expandHome(merged.memory.db_path);
  }

  return validateConfig(merged);
}

function validateConfig(config: AriaConfig): AriaConfig {
  const out: AriaConfig = deepMerge(config, {});

  if (!out.llm.model || !out.llm.model.trim()) {
    console.warn("[config] Invalid llm.model, using default deepseek/deepseek-v4-flash:free");
    out.llm.model = DEFAULT_CONFIG.llm.model;
  }

  const validEmbedders = new Set(["auto", "ollama", "transformers", "llama-cpp", "hash"]);
  if (out.memory.embedder && !validEmbedders.has(out.memory.embedder)) {
    console.warn("[config] Invalid memory.embedder, using default 'auto'");
    out.memory.embedder = DEFAULT_CONFIG.memory.embedder;
  }
  if (!out.memory.embedder) {
    out.memory.embedder = DEFAULT_CONFIG.memory.embedder;
  }

  const validSummarizers = new Set(["disabled", "ollama", "openrouter", "openai"]);
  const summarizer = out.memory.summarizer?.toLowerCase();
  if (summarizer && !validSummarizers.has(summarizer)) {
    console.warn(
      `[config] Invalid memory.summarizer '${out.memory.summarizer}', using 'disabled'`,
    );
    out.memory.summarizer = "disabled";
  }

  if (!Number.isFinite(out.compiler.token_budget) || out.compiler.token_budget <= 1000) {
    console.warn("[config] Invalid compiler.token_budget, using default 100000");
    out.compiler.token_budget = DEFAULT_CONFIG.compiler.token_budget;
  }

  if (
    !Number.isFinite(out.compiler.recent_turns) ||
    out.compiler.recent_turns < 1 ||
    out.compiler.recent_turns > 100
  ) {
    console.warn("[config] Invalid compiler.recent_turns, using default 10");
    out.compiler.recent_turns = DEFAULT_CONFIG.compiler.recent_turns;
  }

  if (
    out.compiler.recent_turns_token_budget !== undefined &&
    (!Number.isFinite(out.compiler.recent_turns_token_budget) ||
      out.compiler.recent_turns_token_budget < 0)
  ) {
    console.warn("[config] Invalid compiler.recent_turns_token_budget, using default");
    out.compiler.recent_turns_token_budget =
      DEFAULT_CONFIG.compiler.recent_turns_token_budget;
  }

  // Compression config validation
  if (
    out.compiler.compression_watermark !== undefined &&
    (!Number.isFinite(out.compiler.compression_watermark) ||
      out.compiler.compression_watermark < 0.5 ||
      out.compiler.compression_watermark > 1.0)
  ) {
    console.warn("[config] Invalid compiler.compression_watermark (must be 0.5–1.0), using default 0.75");
    out.compiler.compression_watermark = DEFAULT_CONFIG.compiler.compression_watermark;
  }
  if (
    out.compiler.compression_flush_fraction !== undefined &&
    (!Number.isFinite(out.compiler.compression_flush_fraction) ||
      out.compiler.compression_flush_fraction < 0.05 ||
      out.compiler.compression_flush_fraction > 0.5)
  ) {
    console.warn("[config] Invalid compiler.compression_flush_fraction (must be 0.05–0.5), using default 0.30");
    out.compiler.compression_flush_fraction = DEFAULT_CONFIG.compiler.compression_flush_fraction;
  }

  if (!out.context_engine) {
    out.context_engine = { ...DEFAULT_CONFIG.context_engine };
  }
  if (typeof out.context_engine.enabled !== "boolean") {
    out.context_engine.enabled = DEFAULT_CONFIG.context_engine.enabled;
  }
  if (typeof out.context_engine.measurement_mode !== "boolean") {
    out.context_engine.measurement_mode = DEFAULT_CONFIG.context_engine.measurement_mode;
  }
  if (
    !Number.isFinite(out.context_engine.artifact_inline_threshold) ||
    out.context_engine.artifact_inline_threshold < 0
  ) {
    out.context_engine.artifact_inline_threshold =
      DEFAULT_CONFIG.context_engine.artifact_inline_threshold;
  }
  if (
    !Number.isFinite(out.context_engine.artifact_ttl_turns) ||
    out.context_engine.artifact_ttl_turns < 1
  ) {
    out.context_engine.artifact_ttl_turns = DEFAULT_CONFIG.context_engine.artifact_ttl_turns;
  }
  if (!out.context_engine.distiller) {
    out.context_engine.distiller = { ...DEFAULT_CONFIG.context_engine.distiller };
  }
  const intensity = out.context_engine.distiller.default_intensity;
  if (intensity !== "lite" && intensity !== "full") {
    out.context_engine.distiller.default_intensity =
      DEFAULT_CONFIG.context_engine.distiller.default_intensity;
  }
  if (typeof out.context_engine.llm_digest !== "boolean") {
    out.context_engine.llm_digest = DEFAULT_CONFIG.context_engine.llm_digest;
  }
  if (
    !Number.isFinite(out.context_engine.activity_log_max_entries) ||
    out.context_engine.activity_log_max_entries < 1
  ) {
    out.context_engine.activity_log_max_entries =
      DEFAULT_CONFIG.context_engine.activity_log_max_entries;
  }
  if (typeof out.context_engine.checkpoint_enabled !== "boolean") {
    out.context_engine.checkpoint_enabled =
      DEFAULT_CONFIG.context_engine.checkpoint_enabled;
  }
  if (typeof out.context_engine.scoring_enabled !== "boolean") {
    out.context_engine.scoring_enabled =
      DEFAULT_CONFIG.context_engine.scoring_enabled;
  }
  if (!out.context_engine.scoring) {
    out.context_engine.scoring = { ...DEFAULT_CONFIG.context_engine.scoring };
  } else {
    for (const key of ["w_pin", "w_recency", "w_relevance"] as const) {
      if (!Number.isFinite(out.context_engine.scoring[key])) {
        out.context_engine.scoring[key] = DEFAULT_CONFIG.context_engine.scoring[key];
      }
    }
  }
  if (!out.context_engine.pressure) {
    out.context_engine.pressure = { ...DEFAULT_CONFIG.context_engine.pressure };
  } else {
    if (!Number.isFinite(out.context_engine.pressure.compact_at)) {
      out.context_engine.pressure.compact_at =
        DEFAULT_CONFIG.context_engine.pressure.compact_at;
    }
    if (!Number.isFinite(out.context_engine.pressure.emergency_at)) {
      out.context_engine.pressure.emergency_at =
        DEFAULT_CONFIG.context_engine.pressure.emergency_at;
    }
  }

  // Shell sandbox config validation
  if (out.shell) {
    if (typeof out.shell.enabled !== 'boolean') {
      console.warn("[config] shell.enabled must be boolean, defaulting to false");
      out.shell.enabled = false;
    }
    if (!Array.isArray(out.shell.allowed_paths)) {
      console.warn("[config] shell.allowed_paths must be string array, defaulting to []");
      (out.shell as { allowed_paths: readonly string[] }).allowed_paths = [];
    }
  }

  return out;
}
