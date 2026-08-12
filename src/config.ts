import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as toml from "toml";
import type { PraanaConfig, UserProviderConfig } from "./types.js";
import { getAppLogger, type ErrorCode } from "./logger.js";
import {
  APP_HOME_DIR,
  appHomePath,
  envFlag,
  envOverride,
  resolveDefaultMemoryDbPath,
  resolveDefaultSessionLogDir,
} from "./app-identity.js";
import { setUserProviders } from "./provider-registry.js";
import { parseReasoningEffort } from "./llm.js";
import { setBedrockConfigRegion } from "./bedrock/region.js";

function configWarn(
  message: string,
  opts?: { cause?: Error; code?: ErrorCode },
): void {
  _configWarnings.push(message);
  getAppLogger().child("config").warn(message, {
    cause: opts?.cause,
    code: opts?.code ?? "CONFIG_INVALID",
  });
}

/** Tracks which config files were loaded in the last loadConfig() call. */
let _loadedSources: string[] = [];

/** Warnings emitted during the last validateConfig() call. */
let _configWarnings: string[] = [];

export function getConfigWarnings(): string[] {
  const out = _configWarnings;
  _configWarnings = [];
  return out;
}

export function getLoadedConfigSources(): string[] {
  return _loadedSources;
}

const DEFAULT_CONFIG: PraanaConfig = {
  llm: {
    provider: "",   // empty → main.ts runs guided setup (env keys are not auto-selected)
    model: "",
    reasoning_effort: "medium",
  },
  memory: {
    enabled: true,
    summarizer: "",  // auto-detected from provider at load time
    db_path: `~/${APP_HOME_DIR}/memory.db`,
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
    auto_compact_at: 0.75,
    auto_compact_clear_at: 0.55,
    compact_chunk_fraction: 0.25,
    verbatim_only: false,
    compression_watermark: 0.75,
    compression_flush_fraction: 0.30,
  },
  tiers: {
    idle_soft_after_turns: 20,
    idle_hard_after_turns: 50,
  },
  session: {
    log_dir: `~/${APP_HOME_DIR}/sessions`,
    stale_task_turn_threshold: 5,
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
  tools: {
    block_repeat_reads: false,
  },
  native: {
    enabled: true,
    require: false,
  },
  skills: {
    enabled: true,
    max_token_budget_ratio: 0.2,
    max_loaded_skills: 3,
    stale_threshold_turns: 10,
    max_depth: 6,
  },
  ui: {
    markdown_rendering: true,
    syntax_highlighting: true,
    syntax_theme: "nord",
    ambient: "inline" as const,
    tool_icons: "unicode" as const,
    background_zones: false,
    show_cost: true,
    banner: true,
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
    scoring: {
      w_pin: 1.0,
      w_recency: 0.5,
      w_relevance: 0.3,
      w_semantic: 0.3,
      w_hydrate_boost: 0.2,
    },
    pressure: {
      compact_at: 0.7,
      emergency_at: 0.85,
    },
  },
  project_detection: {
    enabled: true,
  },
  turn: {
    max_steps: 25,
  },
};

function expandHome(p: string): string {
  return p.startsWith("~/") ? p.replace(/^~\//, `${homedir()}/`) : p;
}

/** Per-path array merge strategy for config layers (global → local). */
export type ArrayMergeStrategy = "replace" | "append" | "prepend";

/**
 * Dotted paths that append/prepend instead of replacing.
 * Default for all other arrays is `replace` (override wins).
 */
const ARRAY_MERGE_STRATEGIES: Record<string, ArrayMergeStrategy> = {
  "shell.allowed_paths": "append",
};

function dedupePreserveOrder(items: unknown[]): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Exported for unit tests of replace/append/prepend semantics. */
export function mergeArrays(
  base: unknown[],
  override: unknown[],
  strategy: ArrayMergeStrategy,
): unknown[] {
  if (strategy === "replace") return [...override];
  // Empty override under append/prepend = no additions (copy of base).
  if (override.length === 0) return [...base];
  if (strategy === "append") return dedupePreserveOrder([...base, ...override]);
  return dedupePreserveOrder([...override, ...base]);
}

/**
 * Deep-merge config layers. Plain objects recurse; arrays use per-path
 * strategies (`replace` default, `append` for allowlists like shell.allowed_paths).
 */
export function deepMerge<T>(
  base: T,
  override: Partial<T>,
  pathPrefix = "",
): T {
  const out = { ...base } as any;
  for (const [k, v] of Object.entries(override as any)) {
    const bv = (base as any)[k];
    const path = pathPrefix ? `${pathPrefix}.${k}` : k;
    if (Array.isArray(v) && Array.isArray(bv)) {
      const strategy = ARRAY_MERGE_STRATEGIES[path] ?? "replace";
      out[k] = mergeArrays(bv, v, strategy);
    } else if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      bv &&
      typeof bv === "object" &&
      !Array.isArray(bv)
    ) {
      out[k] = deepMerge(bv, v, path);
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
      configWarn(`Failed to parse JSON config ${path}`, { cause: err as Error });
    }
  }
  return {};
}

function loadTomlConfig(path: string): Record<string, unknown> {
  if (existsSync(path)) {
    try {
      return toml.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      configWarn(`Failed to parse TOML config ${path}`, { cause: err as Error });
    }
  }
  return {};
}

export function loadConfig(configPath?: string): PraanaConfig {
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
    // Order: global → local (later overrides earlier)
    const configs = [
      { path: appHomePath("praana.config.json"), loader: loadJsonConfig },
      { path: appHomePath("config.toml"), loader: loadTomlConfig },
      { path: "praana.config.json", loader: loadJsonConfig },
      { path: "praana.config.toml", loader: loadTomlConfig },
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

  const merged = deepMerge(DEFAULT_CONFIG, userConfig as any) as PraanaConfig;

  // Env keys are a credential fallback for an already-chosen provider, not a
  // provider chooser. Leave [llm].provider empty when unset so main.ts runs
  // the guided setup wizard.
  const userExplicitlySetSummarizer = !!(userConfig as any)?.memory?.summarizer;

  const modelOverride = envOverride("PRAANA_MODEL");
  if (modelOverride) merged.llm.model = modelOverride;

  const contextEngineFlag = envFlag("PRAANA_CONTEXT_ENGINE");
  if (contextEngineFlag !== undefined) {
    merged.context_engine.enabled = contextEngineFlag;
  }

  const measurementFlag = envFlag("PRAANA_MEASUREMENT_MODE");
  if (measurementFlag !== undefined) {
    merged.context_engine.measurement_mode = measurementFlag;
  }
  
  // Expand paths
  merged.session.log_dir = expandHome(merged.session.log_dir);
  if (merged.memory?.db_path) {
    merged.memory.db_path = expandHome(merged.memory.db_path);
  }
  if (merged.session.log_dir.endsWith(`/${APP_HOME_DIR}/sessions`)) {
    merged.session.log_dir = resolveDefaultSessionLogDir();
  }
  if (merged.memory?.db_path?.endsWith(`/${APP_HOME_DIR}/memory.db`)) {
    merged.memory.db_path = resolveDefaultMemoryDbPath();
  }

  const validated = validateConfig(merged, { userExplicitlySetSummarizer });
  // Inject user-declared providers into the module-level registry so
  // getProviderConfig / isProviderAvailable / provider-catalog see them.
  setUserProviders(validated.providers);
  return validated;
}

function validateConfig(config: PraanaConfig, opts?: { userExplicitlySetSummarizer?: boolean }): PraanaConfig {
  const out: PraanaConfig = deepMerge(config, {});

  // Validate provider name (but allow empty — indicates no key detected)
  if (out.llm.provider && !out.llm.provider.trim()) {
    out.llm.provider = "";
  }

  // Summarizer fallback: auto-select from provider if not explicitly set
  if (!opts?.userExplicitlySetSummarizer && (!out.memory.summarizer || !out.memory.summarizer.trim())) {
    if (out.llm.provider) {
      // Map provider names to summarizer-compatible names
      const summarizerMap: Record<string, string> = {
        openrouter: "openrouter",
        openai: "openai",
        anthropic: "openai",  // anthropic doesn't have a summarizer, use openai-compatible
        ollama: "ollama",
        deepseek: "openrouter",  // use openrouter for deepseek summarizer
        groq: "openrouter",
        google: "openrouter",
        mistral: "openrouter",
        xai: "openrouter",
        fireworks: "openrouter",
        together: "openrouter",
        opencode: "openai",
        umans: "openrouter",
      };
      out.memory.summarizer = summarizerMap[out.llm.provider] ?? "disabled";
    }
  }

  const validEmbedders = new Set([
    "auto",
    "ollama",
    "transformers",
    "transformers-nomic",
  ]);
  if (out.memory.embedder && !validEmbedders.has(out.memory.embedder)) {
    configWarn("Invalid memory.embedder, using default 'auto'");
    out.memory.embedder = DEFAULT_CONFIG.memory.embedder;
  }
  if (!out.memory.embedder) {
    out.memory.embedder = DEFAULT_CONFIG.memory.embedder;
  }

  const validSummarizers = new Set(["disabled", "ollama", "openrouter", "openai"]);
  const summarizer = out.memory.summarizer?.toLowerCase();
  if (summarizer && !validSummarizers.has(summarizer)) {
    configWarn(`Invalid memory.summarizer '${out.memory.summarizer}', using 'disabled'`);
    out.memory.summarizer = "disabled";
  }

  if (!Number.isFinite(out.compiler.token_budget) || out.compiler.token_budget <= 1000) {
    configWarn("Invalid compiler.token_budget, using default 100000");
    out.compiler.token_budget = DEFAULT_CONFIG.compiler.token_budget;
  }

  if (
    !Number.isFinite(out.compiler.recent_turns) ||
    out.compiler.recent_turns < 1 ||
    out.compiler.recent_turns > 100
  ) {
    configWarn("Invalid compiler.recent_turns, using default 10");
    out.compiler.recent_turns = DEFAULT_CONFIG.compiler.recent_turns;
  }

  if (
    out.compiler.recent_turns_token_budget !== undefined &&
    (!Number.isFinite(out.compiler.recent_turns_token_budget) ||
      out.compiler.recent_turns_token_budget < 0)
  ) {
    configWarn("Invalid compiler.recent_turns_token_budget, using default");
    out.compiler.recent_turns_token_budget =
      DEFAULT_CONFIG.compiler.recent_turns_token_budget;
  }

  // Auto-compaction config validation
  const compactAt =
    out.compiler.auto_compact_at ?? out.compiler.compression_watermark;
  if (
    compactAt !== undefined &&
    (!Number.isFinite(compactAt) || compactAt < 0.5 || compactAt > 1.0)
  ) {
    configWarn("Invalid compiler.auto_compact_at (must be 0.5–1.0), using default 0.75");
    out.compiler.auto_compact_at = DEFAULT_CONFIG.compiler.auto_compact_at;
  } else if (out.compiler.auto_compact_at === undefined && compactAt !== undefined) {
    out.compiler.auto_compact_at = compactAt;
  } else if (out.compiler.auto_compact_at === undefined) {
    out.compiler.auto_compact_at = DEFAULT_CONFIG.compiler.auto_compact_at;
  }

  if (
    out.compiler.auto_compact_clear_at !== undefined &&
    (!Number.isFinite(out.compiler.auto_compact_clear_at) ||
      out.compiler.auto_compact_clear_at < 0.1 ||
      out.compiler.auto_compact_clear_at >= (out.compiler.auto_compact_at ?? 0.75))
  ) {
    configWarn("Invalid compiler.auto_compact_clear_at, using default 0.55");
    out.compiler.auto_compact_clear_at = DEFAULT_CONFIG.compiler.auto_compact_clear_at;
  } else if (out.compiler.auto_compact_clear_at === undefined) {
    out.compiler.auto_compact_clear_at = DEFAULT_CONFIG.compiler.auto_compact_clear_at;
  }

  const chunkFraction =
    out.compiler.compact_chunk_fraction ?? out.compiler.compression_flush_fraction;
  if (
    chunkFraction !== undefined &&
    (!Number.isFinite(chunkFraction) || chunkFraction < 0.05 || chunkFraction > 0.5)
  ) {
    configWarn("Invalid compiler.compact_chunk_fraction (must be 0.05–0.5), using default 0.25");
    out.compiler.compact_chunk_fraction = DEFAULT_CONFIG.compiler.compact_chunk_fraction;
  } else if (out.compiler.compact_chunk_fraction === undefined && chunkFraction !== undefined) {
    out.compiler.compact_chunk_fraction = chunkFraction;
  } else if (out.compiler.compact_chunk_fraction === undefined) {
    out.compiler.compact_chunk_fraction = DEFAULT_CONFIG.compiler.compact_chunk_fraction;
  }

  if (typeof out.compiler.verbatim_only !== "boolean") {
    out.compiler.verbatim_only = DEFAULT_CONFIG.compiler.verbatim_only;
  }

  if (
    out.llm.context_window !== undefined &&
    (!Number.isFinite(out.llm.context_window) || out.llm.context_window <= 1000)
  ) {
    configWarn("Invalid llm.context_window, ignoring override");
    delete out.llm.context_window;
  }

  if (out.llm.region !== undefined) {
    if (typeof out.llm.region !== "string" || !out.llm.region.trim()) {
      configWarn("Invalid llm.region, ignoring");
      delete out.llm.region;
    } else {
      out.llm.region = out.llm.region.trim();
    }
  }
  setBedrockConfigRegion(out.llm.region);

  if (out.llm.reasoning_effort !== undefined) {
    const parsed = parseReasoningEffort(String(out.llm.reasoning_effort));
    if (!parsed) {
      configWarn(
        `Invalid llm.reasoning_effort "${out.llm.reasoning_effort}", using medium`,
      );
      out.llm.reasoning_effort = DEFAULT_CONFIG.llm.reasoning_effort;
    } else {
      out.llm.reasoning_effort = parsed;
    }
  } else {
    out.llm.reasoning_effort = DEFAULT_CONFIG.llm.reasoning_effort;
  }

  const hasFallbackProvider = !!out.llm.fallback_provider;
  const hasFallbackModel = !!out.llm.fallback_model;
  if (hasFallbackProvider !== hasFallbackModel) {
    configWarn(
      "llm.fallback_provider and llm.fallback_model must both be set for automatic fallback; ignoring fallback config",
    );
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
  if (!out.context_engine.scoring) {
    out.context_engine.scoring = { ...DEFAULT_CONFIG.context_engine.scoring };
  } else {
    const defaultScoring = {
      ...DEFAULT_CONFIG.context_engine.scoring,
      w_semantic: DEFAULT_CONFIG.context_engine.scoring.w_semantic ?? 0,
    };
    for (const key of ["w_pin", "w_recency", "w_relevance", "w_semantic"] as const) {
      if (!Number.isFinite(out.context_engine.scoring[key])) {
        out.context_engine.scoring[key] = defaultScoring[key];
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
      configWarn("shell.enabled must be boolean, defaulting to false");
      out.shell.enabled = false;
    }
    if (!Array.isArray(out.shell.allowed_paths)) {
      configWarn("shell.allowed_paths must be string array, defaulting to []");
      (out.shell as { allowed_paths: readonly string[] }).allowed_paths = [];
    }
  }

  // Tools config validation
  if (!out.tools) {
    out.tools = { block_repeat_reads: false };
  } else if (typeof out.tools.block_repeat_reads !== "boolean") {
    configWarn("tools.block_repeat_reads must be boolean, defaulting to false");
    out.tools = { ...out.tools, block_repeat_reads: false };
  }

  // search_code config validation
  if (out.search_code) {
    if (
      typeof out.search_code.rg_path !== "string" &&
      out.search_code.rg_path !== undefined
    ) {
      configWarn("search_code.rg_path must be a string, ignoring");
      out.search_code.rg_path = undefined;
    } else if (typeof out.search_code.rg_path === "string") {
      out.search_code.rg_path = expandHome(out.search_code.rg_path);
    }
  }

  // native config validation
  if (!out.native) {
    out.native = { enabled: true, require: false };
  } else {
    if (typeof out.native.enabled !== "boolean") {
      configWarn("native.enabled must be boolean, defaulting to true");
      out.native.enabled = true;
    }
    if (typeof out.native.require !== "boolean") {
      configWarn("native.require must be boolean, defaulting to false");
      out.native.require = false;
    }
  }

  // UI config validation
  if (out.ui) {
    if (typeof out.ui.markdown_rendering !== 'boolean') {
      out.ui.markdown_rendering = DEFAULT_CONFIG.ui.markdown_rendering;
    }
    if (typeof out.ui.syntax_highlighting !== 'boolean') {
      out.ui.syntax_highlighting = DEFAULT_CONFIG.ui.syntax_highlighting;
    }
    // Validate ui.syntax_theme. Named theme objects (e.g. "nord") are resolved
    // at render time; unknown names fall back to cli-highlight's default theme.
    if (typeof out.ui.syntax_theme !== 'string' || !out.ui.syntax_theme.trim()) {
      configWarn("Invalid ui.syntax_theme, using default 'nord'");
      out.ui.syntax_theme = DEFAULT_CONFIG.ui.syntax_theme;
    } else {
      try {
        // cli-highlight is direct CJS dependency, so we require it or dynamically load safely.
        // Since we are in ESM, we can either check synchronously from standard node pathing or do:
        import("cli-highlight").then(({ highlight }) => {
          try {
            highlight("const x = 1;", { theme: out.ui.syntax_theme });
          } catch {
            configWarn(`Theme '${out.ui.syntax_theme}' not found or invalid. Falling back to 'nord'`);
            out.ui.syntax_theme = DEFAULT_CONFIG.ui.syntax_theme;
          }
        }).catch(() => {});
      } catch {
        // If any error occurs, default back safely
        out.ui.syntax_theme = DEFAULT_CONFIG.ui.syntax_theme;
      }
    }
    if (out.ui.ambient !== "inline" && out.ui.ambient !== "quiet") {
      out.ui.ambient = DEFAULT_CONFIG.ui.ambient;
    }
    if (out.ui.tool_icons !== "unicode" && out.ui.tool_icons !== "ascii") {
      out.ui.tool_icons = DEFAULT_CONFIG.ui.tool_icons;
    }
    if (typeof out.ui.background_zones !== "boolean") {
      out.ui.background_zones = DEFAULT_CONFIG.ui.background_zones;
    }
    if (typeof out.ui.show_cost !== "boolean") {
      out.ui.show_cost = DEFAULT_CONFIG.ui.show_cost;
    }
    if (typeof out.ui.banner !== "boolean") {
      out.ui.banner = DEFAULT_CONFIG.ui.banner;
    }
  }

  // User-declared providers validation ([providers.<id>] sections)
  if (out.providers) {
    const validProviders: Record<string, UserProviderConfig> = {};
    for (const [id, pc] of Object.entries(out.providers)) {
      if (!pc || typeof pc !== "object") {
        configWarn(`providers.${id} must be a table, ignoring`);
        continue;
      }
      if (!pc.api || typeof pc.api !== "string") {
        configWarn(
          `providers.${id}.api is required (e.g. "openai-completions"), ignoring provider`,
        );
        continue;
      }
      if (!pc.base_url || typeof pc.base_url !== "string") {
        configWarn(`providers.${id}.base_url is required, ignoring provider`);
        continue;
      }
      validProviders[id] = pc;
    }
    out.providers =
      Object.keys(validProviders).length > 0 ? validProviders : undefined;
  }

  return out;
}
