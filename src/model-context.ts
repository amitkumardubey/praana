import { getModel, getProviders } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { appHomePath } from "./app-identity.js";

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

const CACHE_VERSION = 1;
const OPENROUTER_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_FILE = appHomePath("model-context-cache.json");

/** PRAANA config provider → pi-ai MODELS registry key (when available). */
const PI_AI_PROVIDER_MAP: Record<string, string> = {
  openrouter: "openrouter",
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  deepseek: "deepseek",
  groq: "groq",
  xai: "xai",
  fireworks: "fireworks",
  together: "together",
  mistral: "mistral",
  "amazon-bedrock": "amazon-bedrock",
};

interface CacheEntry {
  contextWindow: number;
  fetchedAt: number;
}

interface ModelContextCacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
  openRouterCatalog?: {
    fetchedAt: number;
    models: Record<string, number>;
  };
}

const memoryEntries = new Map<string, number>();
let diskCache: ModelContextCacheFile | null = null;
let openRouterFetchPromise: Promise<Record<string, number>> | null = null;

function cacheKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

function isValidWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1000;
}

function applyOverride(override?: number): number | null {
  if (override !== undefined && isValidWindow(override)) return override;
  return null;
}

function loadDiskCache(): ModelContextCacheFile {
  if (diskCache) return diskCache;
  diskCache = { version: CACHE_VERSION, entries: {} };
  if (!existsSync(CACHE_FILE)) return diskCache;

  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as ModelContextCacheFile;
    if (raw.version === CACHE_VERSION && raw.entries && typeof raw.entries === "object") {
      diskCache = raw;
    }
  } catch {
    diskCache = { version: CACHE_VERSION, entries: {} };
  }
  return diskCache;
}

function persistDiskCache(): void {
  const dir = dirname(CACHE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(loadDiskCache(), null, 2), "utf-8");
}

function rememberContextWindow(provider: string, modelId: string, contextWindow: number): void {
  const key = cacheKey(provider, modelId);
  memoryEntries.set(key, contextWindow);
  const file = loadDiskCache();
  file.entries[key] = { contextWindow, fetchedAt: Date.now() };
  persistDiskCache();
}

export function mapProviderToPiAi(provider: string): string | null {
  const mapped = PI_AI_PROVIDER_MAP[provider];
  if (mapped) return mapped;
  const known = getProviders() as string[];
  return known.includes(provider) ? provider : null;
}

export function lookupPiAiContextWindow(
  provider: string,
  modelId: string,
): number | null {
  const piProvider = mapProviderToPiAi(provider);
  if (!piProvider) return null;
  const model = getModel(piProvider as never, modelId as never);
  return isValidWindow(model?.contextWindow) ? model.contextWindow : null;
}

function readCachedContextWindow(provider: string, modelId: string): number | null {
  const key = cacheKey(provider, modelId);
  const mem = memoryEntries.get(key);
  if (isValidWindow(mem)) return mem;

  const entry = loadDiskCache().entries[key];
  if (entry && isValidWindow(entry.contextWindow)) {
    memoryEntries.set(key, entry.contextWindow);
    return entry.contextWindow;
  }
  return null;
}

function readOpenRouterCatalogEntry(modelId: string): number | null {
  const catalog = loadDiskCache().openRouterCatalog;
  if (!catalog) return null;
  if (Date.now() - catalog.fetchedAt > OPENROUTER_CATALOG_TTL_MS) return null;
  const value = catalog.models[modelId];
  return isValidWindow(value) ? value : null;
}

async function fetchOpenRouterCatalog(): Promise<Record<string, number>> {
  const file = loadDiskCache();
  const existing = file.openRouterCatalog;
  if (
    existing &&
    Date.now() - existing.fetchedAt <= OPENROUTER_CATALOG_TTL_MS &&
    Object.keys(existing.models).length > 0
  ) {
    return existing.models;
  }

  if (openRouterFetchPromise) return openRouterFetchPromise;

  openRouterFetchPromise = (async () => {
    const headers: Record<string, string> = { Accept: "application/json" };
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch("https://openrouter.ai/api/v1/models", { headers });
    if (!response.ok) {
      throw new Error(`OpenRouter models API returned ${response.status}`);
    }

    const body = (await response.json()) as {
      data?: Array<{ id?: string; context_length?: number }>;
    };

    const models: Record<string, number> = {};
    for (const item of body.data ?? []) {
      if (item.id && isValidWindow(item.context_length)) {
        models[item.id] = item.context_length;
      }
    }

    file.openRouterCatalog = { fetchedAt: Date.now(), models };
    persistDiskCache();
    return models;
  })().finally(() => {
    openRouterFetchPromise = null;
  });

  return openRouterFetchPromise;
}

async function lookupOpenRouterContextWindow(modelId: string): Promise<number | null> {
  const cached = readOpenRouterCatalogEntry(modelId);
  if (cached !== null) return cached;

  try {
    const catalog = await fetchOpenRouterCatalog();
    const value = catalog[modelId];
    return isValidWindow(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous best-effort resolution: override → cache → pi-ai catalog → default.
 */
export function resolveContextWindowSync(
  provider: string,
  modelId: string,
  override?: number,
): number {
  const fromOverride = applyOverride(override);
  if (fromOverride !== null) return fromOverride;

  const cached = readCachedContextWindow(provider, modelId);
  if (cached !== null) return cached;

  const fromCatalog = readOpenRouterCatalogEntry(modelId);
  if (fromCatalog !== null) return fromCatalog;

  const fromPiAi = lookupPiAiContextWindow(provider, modelId);
  if (fromPiAi !== null) return fromPiAi;

  // OpenRouter-style ids may live under the openrouter provider in pi-ai.
  if (provider !== "openrouter" && modelId.includes("/")) {
    const fromOpenRouterPiAi = lookupPiAiContextWindow("openrouter", modelId);
    if (fromOpenRouterPiAi !== null) return fromOpenRouterPiAi;
  }

  return DEFAULT_MODEL_CONTEXT_WINDOW;
}

/**
 * Fetch and cache context window for a model. Never throws — falls back to sync resolution.
 */
export async function fetchAndCacheContextWindow(
  provider: string,
  modelId: string,
  override?: number,
): Promise<number> {
  const fromOverride = applyOverride(override);
  if (fromOverride !== null) return fromOverride;

  const cached = readCachedContextWindow(provider, modelId);
  if (cached !== null) return cached;

  const sources: Array<number | null> = [
    lookupPiAiContextWindow(provider, modelId),
    provider !== "openrouter" && modelId.includes("/")
      ? lookupPiAiContextWindow("openrouter", modelId)
      : null,
    await lookupOpenRouterContextWindow(modelId),
  ];

  for (const value of sources) {
    if (value !== null) {
      rememberContextWindow(provider, modelId, value);
      return value;
    }
  }

  const fallback = DEFAULT_MODEL_CONTEXT_WINDOW;
  rememberContextWindow(provider, modelId, fallback);
  return fallback;
}

/** @deprecated Use resolveContextWindowSync with provider, or session.getContextWindowTokens(). */
export function resolveContextWindow(modelId: string, override?: number): number {
  return resolveContextWindowSync("openrouter", modelId, override);
}

/** Test helper — reset in-memory/disk cache state. */
export function resetModelContextCacheForTests(): void {
  memoryEntries.clear();
  diskCache = null;
  openRouterFetchPromise = null;
  if (existsSync(CACHE_FILE)) {
    unlinkSync(CACHE_FILE);
  }
}
