import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as toml from "toml";
import type { PraanaConfig } from "./types.js";
import { getAppLogger } from "./logger.js";
import {
  APP_HOME_DIR,
  envFlag,
  envOverride,
  resolveDefaultMemoryDbPath,
  resolveDefaultSessionLogDir,
} from "./app-identity.js";
import { detectProviderFromEnvironment, DEFAULT_MODELS } from "./llm.js";

function configWarn(message: string, cause?: Error): void {
  getAppLogger().child("config").warn(message, {
    code: "CONFIG_INVALID",
    ...(cause ? { cause } : {}),
  });
}

/** Tracks which config files were loaded in the last loadConfig() call. */
let _loadedSources: string[] = [];

export function getLoadedConfigSources(): string[] {
  return _loadedSources;
}

const DEFAULT_CONFIG: PraanaConfig = {
  llm: {
    provider: "",   // auto-detected from environment at load time
    model: "",      // derived from detected provider
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
    markdown_rendering: true,
    syntax_highlighting: true,
    syntax_theme: "nord",
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
      configWarn(`Failed to parse JSON config ${path}`, err as Error);
    }
  }
  return {};
}

function loadTomlConfig(path: string): Record<string, unknown> {
  if (existsSync(path)) {
    try {
      return toml.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      configWarn(`Failed to parse TOML config ${path}`, err as Error);
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
      { path: expandHome(`~/${APP_HOME_DIR}/praana.config.json`), loader: loadJsonConfig },
      { path: expandHome(`~/${APP_HOME_DIR}/config.toml`), loader: loadTomlConfig },
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

  // ── Provider auto-detection (precedence: config > env > none) ──
  const userExplicitlySetProvider = !!merged.llm.provider;
  const userExplicitlySetModel = !!merged.llm.model;
  const userExplicitlySetSummarizer = !!(userConfig as any)?.memory?.summarizer;

  if (!userExplicitlySetProvider) {
    const detected = detectProviderFromEnvironment();
    if (detected) {
      merged.llm.provider = detected.provider;
      if (!userExplicitlySetModel) {
        merged.llm.model = detected.model;
      }
    }
    // If nothing detected, leave provider empty — main.ts will handle the no-key flow.
  }

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

  return validateConfig(merged, { userExplicitlySetSummarizer });
}

function validateConfig(config: PraanaConfig, opts?: { userExplicitlySetSummarizer?: boolean }): PraanaConfig {
  const out: PraanaConfig = deepMerge(config, {});

  // Validate provider name (but allow empty — indicates no key detected)
  if (out.llm.provider && !out.llm.provider.trim()) {
    out.llm.provider = "";
  }

  // Model fallback: if provider is set but model is empty, use provider-specific default
  if (!out.llm.model || !out.llm.model.trim()) {
    if (out.llm.provider) {
      out.llm.model = DEFAULT_MODELS[out.llm.provider] ?? "deepseek/deepseek-v4-flash:free";
    }
    // If both empty, leave empty — main.ts will handle the no-key flow
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
      configWarn("shell.enabled must be boolean, defaulting to false");
      out.shell.enabled = false;
    }
    if (!Array.isArray(out.shell.allowed_paths)) {
      configWarn("shell.allowed_paths must be string array, defaulting to []");
      (out.shell as { allowed_paths: readonly string[] }).allowed_paths = [];
    }
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
  }

  return out;
}
