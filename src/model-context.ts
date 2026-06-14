import { getModel, getProviders } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appHomePath } from "./app-identity.js";
import {
  findOpenRouterCatalogModelId,
  findProviderCatalogModelId,
  lookupProviderCatalogContextWindow,
  openRouterModelIdCandidates,
  providerModelIdCandidates,
  providerSupportsLiveCatalog,
  resetProviderCatalogCacheForTests,
  stripProviderRoutingPrefix,
} from "./provider-catalog.js";

export {
  findOpenRouterCatalogModelId,
  findProviderCatalogModelId,
  isInProviderCatalog,
  lookupProviderCatalogContextWindow,
  openRouterModelIdCandidates,
  providerModelIdCandidates,
  providerSupportsLiveCatalog,
  stripProviderRoutingPrefix,
} from "./provider-catalog.js";

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

const CACHE_VERSION = 1;
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
}

const memoryEntries = new Map<string, number>();
let diskCache: ModelContextCacheFile | null = null;

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
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as ModelContextCacheFile & {
      openRouterCatalog?: unknown;
    };
    if (raw.version === CACHE_VERSION && raw.entries && typeof raw.entries === "object") {
      // Drop the legacy openRouterCatalog field (moved to provider-catalog-cache.json).
      // It will be naturally excluded on next persistDiskCache since the new schema
      // only has version + entries.
      diskCache = { version: CACHE_VERSION, entries: raw.entries };
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

export function isInPiAiCatalog(provider: string, modelId: string): boolean {
  const piProvider = mapProviderToPiAi(provider);
  if (!piProvider) return false;
  return !!getModel(piProvider as never, modelId as never);
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

export async function isInOpenRouterCatalog(modelId: string): Promise<boolean> {
  const canonical = await findOpenRouterCatalogModelId(modelId);
  return canonical !== null;
}

/** Strip provider routing prefix before sending model id to the API. */
export function normalizeModelIdForProvider(provider: string, modelId: string): string {
  return stripProviderRoutingPrefix(provider, modelId);
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

async function lookupLiveProviderContextWindow(
  provider: string,
  modelId: string,
): Promise<number | null> {
  const cached = lookupProviderCatalogContextWindow(provider, modelId);
  if (cached !== null) return cached;

  if (!providerSupportsLiveCatalog(provider)) return null;

  try {
    const canonical = await findProviderCatalogModelId(provider, modelId);
    if (!canonical) return null;
    return lookupProviderCatalogContextWindow(provider, canonical);
  } catch {
    return null;
  }
}

/**
 * Synchronous best-effort resolution: override → cache → provider catalog cache → pi-ai → default.
 */
export function resolveContextWindowSync(
  provider: string,
  modelId: string,
  override?: number,
): number {
  const fromOverride = applyOverride(override);
  if (fromOverride !== null) return fromOverride;

  const normalizedId = normalizeModelIdForProvider(provider, modelId);

  const cached = readCachedContextWindow(provider, normalizedId);
  if (cached !== null) return cached;

  const fromProviderCatalog = lookupProviderCatalogContextWindow(provider, normalizedId);
  if (fromProviderCatalog !== null) return fromProviderCatalog;

  const fromPiAi = lookupPiAiContextWindow(provider, normalizedId);
  if (fromPiAi !== null) return fromPiAi;

  if (provider === "openrouter") {
    for (const alt of openRouterModelIdCandidates(normalizedId)) {
      if (alt === normalizedId) continue;
      const fromAltPiAi = lookupPiAiContextWindow("openrouter", alt);
      if (fromAltPiAi !== null) return fromAltPiAi;
    }
  }

  if (providerSupportsLiveCatalog(provider)) {
    for (const alt of providerModelIdCandidates(provider, normalizedId)) {
      const fromAltCatalog = lookupProviderCatalogContextWindow(provider, alt);
      if (fromAltCatalog !== null) return fromAltCatalog;
    }
  }

  // OpenRouter-style ids may live under the openrouter provider in pi-ai.
  if (provider !== "openrouter" && normalizedId.includes("/")) {
    const fromOpenRouterPiAi = lookupPiAiContextWindow("openrouter", normalizedId);
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

  const normalizedId = normalizeModelIdForProvider(provider, modelId);

  const cached = readCachedContextWindow(provider, normalizedId);
  if (cached !== null) return cached;

  const sources: Array<number | null> = [];
  for (const id of providerModelIdCandidates(provider, normalizedId)) {
    sources.push(lookupPiAiContextWindow(provider, id));
    if (provider !== "openrouter") {
      sources.push(lookupPiAiContextWindow("openrouter", id));
    }
  }
  sources.push(await lookupLiveProviderContextWindow(provider, normalizedId));

  for (const value of sources) {
    if (value !== null) {
      rememberContextWindow(provider, normalizedId, value);
      return value;
    }
  }

  // Cache the default fallback so repeated calls for unknown models
  // don't re-traverse all lookup paths every turn.
  const fallback = resolveContextWindowSync(provider, normalizedId, override);
  rememberContextWindow(provider, normalizedId, fallback);
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
  resetProviderCatalogCacheForTests();
  if (existsSync(CACHE_FILE)) {
    unlinkSync(CACHE_FILE);
  }
}
