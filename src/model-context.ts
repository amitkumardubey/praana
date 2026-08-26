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
import { getModelCatalogEntry } from "./llm/catalog.js";
import { resolveContextWindowSync as resolveNativeContextWindow } from "./llm/context-window.js";

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
  return provider;
}

export function isInPiAiCatalog(provider: string, modelId: string): boolean {
  return !!getModelCatalogEntry(provider, modelId);
}

export function lookupPiAiContextWindow(
  provider: string,
  modelId: string,
): number | null {
  const model = getModelCatalogEntry(provider, modelId);
  if (model?.contextWindow) return model.contextWindow;
  return resolveNativeContextWindow(modelId, provider);
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
 * Synchronous best-effort resolution: override → cache → provider catalog cache → native heuristics → default.
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

  const fromCatalog = lookupPiAiContextWindow(provider, normalizedId);
  if (fromCatalog !== null) return fromCatalog;

  return resolveNativeContextWindow(normalizedId, provider);
}

/**
 * Full resolution with async live-catalog lookup and cache persistence.
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

  const fromLive = await lookupLiveProviderContextWindow(provider, normalizedId);
  if (fromLive !== null) {
    rememberContextWindow(provider, normalizedId, fromLive);
    return fromLive;
  }

  const fromCatalog = lookupPiAiContextWindow(provider, normalizedId);
  if (fromCatalog !== null) {
    rememberContextWindow(provider, normalizedId, fromCatalog);
    return fromCatalog;
  }

  const resolved = resolveNativeContextWindow(normalizedId, provider);
  rememberContextWindow(provider, normalizedId, resolved);
  return resolved;
}

export function resetContextWindowCacheForTests(): void {
  memoryEntries.clear();
  diskCache = null;
  resetProviderCatalogCacheForTests();
  try {
    if (existsSync(CACHE_FILE)) unlinkSync(CACHE_FILE);
  } catch {
    // best-effort unlink in tests
  }
}

export { resetContextWindowCacheForTests as resetModelContextCacheForTests };
