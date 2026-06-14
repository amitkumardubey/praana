import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { appHomePath } from "./app-identity.js";
import {
  PROVIDER_REGISTRY,
  LIVE_CATALOG_PROVIDER_IDS,
  VENDOR_PREFIX_ALIASES,
} from "./provider-registry.js";

export const PROVIDER_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const PROVIDER_CATALOG_FETCH_TIMEOUT_MS = 15_000;

const CACHE_VERSION = 1;
const CACHE_FILE = appHomePath("provider-catalog-cache.json");

/**
 * Live-catalog provider set — built from `LIVE_CATALOG_PROVIDER_IDS` at
 * module load time.  Base URLs, env keys, and headers are looked up from
 * the shared `PROVIDER_REGISTRY` on each fetch, so there is no
 * duplication of endpoint configuration.
 */
const LIVE_CATALOG_PROVIDERS = new Set(LIVE_CATALOG_PROVIDER_IDS);

interface ProviderCatalogSnapshot {
  fetchedAt: number;
  /** null context window means the model exists but the API did not report a window. */
  models: Record<string, number | null>;
  /** Maps bare model name (segment after last /) to full catalog id. */
  suffixIndex?: Record<string, string>;
}

interface InFlightFetch {
  promise: Promise<Record<string, number | null>>;
  controller: AbortController;
}

interface ProviderCatalogCacheFile {
  version: number;
  catalogs: Record<string, ProviderCatalogSnapshot>;
}

let diskCache: ProviderCatalogCacheFile | null = null;
const fetchPromises = new Map<string, InFlightFetch>();

function buildSuffixIndex(models: Record<string, number | null>): Record<string, string> {
  const index: Record<string, string> = {};
  for (const id of Object.keys(models)) {
    const slash = id.lastIndexOf("/");
    if (slash < 0) continue;
    const bare = id.slice(slash + 1);
    if (!(bare in index)) index[bare] = id;
  }
  return index;
}

function getSuffixIndex(snapshot: ProviderCatalogSnapshot): Record<string, string> {
  return snapshot.suffixIndex ?? buildSuffixIndex(snapshot.models);
}

function isValidWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1000;
}

function loadDiskCache(): ProviderCatalogCacheFile {
  if (diskCache) return diskCache;
  diskCache = { version: CACHE_VERSION, catalogs: {} };
  if (!existsSync(CACHE_FILE)) return diskCache;

  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as ProviderCatalogCacheFile;
    if (raw.version === CACHE_VERSION && raw.catalogs && typeof raw.catalogs === "object") {
      diskCache = raw;
    }
  } catch {
    diskCache = { version: CACHE_VERSION, catalogs: {} };
  }
  return diskCache;
}

function persistDiskCache(): void {
  const dir = dirname(CACHE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(loadDiskCache()), "utf-8");
}

export function providerSupportsLiveCatalog(provider: string): boolean {
  return LIVE_CATALOG_PROVIDERS.has(provider);
}

/** Strip `provider/` routing prefix from a model id before API or catalog lookup. */
export function stripProviderRoutingPrefix(provider: string, modelId: string): string {
  const prefix = `${provider}/`;
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

/** Alternate ids to try when resolving a model against a provider catalog. */
export function providerModelIdCandidates(provider: string, modelId: string): string[] {
  const normalized = stripProviderRoutingPrefix(provider, modelId);
  const candidates = new Set<string>([normalized]);
  if (normalized !== modelId) candidates.add(modelId);

  // Apply configurable vendor prefix aliases (e.g. openrouter: kimi-* → moonshotai/*)
  const aliases = VENDOR_PREFIX_ALIASES[provider];
  if (aliases && !normalized.includes("/")) {
    for (const { pattern, vendor } of aliases) {
      if (pattern.test(normalized)) {
        candidates.add(`${vendor}/${normalized}`);
      }
    }
  }

  return [...candidates];
}

function findInCatalogMap(
  catalog: Record<string, number | null>,
  provider: string,
  modelId: string,
  suffixIndex?: Record<string, string>,
): string | null {
  for (const id of providerModelIdCandidates(provider, modelId)) {
    if (id in catalog) return id;
  }

  const normalized = stripProviderRoutingPrefix(provider, modelId);
  if (!normalized.includes("/")) {
    if (suffixIndex && normalized in suffixIndex) {
      return suffixIndex[normalized];
    }
    // O(n) fallback: suffixIndex miss, scan for suffix match.
    // This is rare since suffixIndex is rebuilt on every cache load.
    const suffix = `/${normalized}`;
    for (const id of Object.keys(catalog)) {
      if (id.endsWith(suffix)) return id;
    }
  }

  return null;
}

function readCachedCatalogEntry(
  provider: string,
  modelId: string,
): { id: string; contextWindow: number | null } | null {
  const snapshot = loadDiskCache().catalogs[provider];
  if (!snapshot) return null;
  if (Date.now() - snapshot.fetchedAt > PROVIDER_CATALOG_TTL_MS) return null;

  const id = findInCatalogMap(snapshot.models, provider, modelId, getSuffixIndex(snapshot));
  if (!id) return null;
  return { id, contextWindow: snapshot.models[id] ?? null };
}

function lookupCachedContextWindow(provider: string, modelId: string): number | null {
  const entry = readCachedCatalogEntry(provider, modelId);
  if (!entry) return null;
  return isValidWindow(entry.contextWindow) ? entry.contextWindow : null;
}

export function lookupProviderCatalogContextWindow(
  provider: string,
  modelId: string,
): number | null {
  return lookupCachedContextWindow(provider, modelId);
}

export async function findProviderCatalogModelId(
  provider: string,
  modelId: string,
): Promise<string | null> {
  if (!providerSupportsLiveCatalog(provider)) return null;

  const cached = readCachedCatalogEntry(provider, modelId);
  if (cached) return cached.id;

  try {
    let catalog = await fetchProviderCatalog(provider);
    let found = findInCatalogMap(catalog, provider, modelId, buildSuffixIndex(catalog));
    if (found) return found;

    invalidateProviderCatalog(provider);
    catalog = await fetchProviderCatalogFresh(provider);
    return findInCatalogMap(catalog, provider, modelId, buildSuffixIndex(catalog));
  } catch {
    return null;
  }
}

export async function isInProviderCatalog(
  provider: string,
  modelId: string,
): Promise<boolean> {
  const canonical = await findProviderCatalogModelId(provider, modelId);
  return canonical !== null;
}

async function fetchProviderCatalog(
  provider: string,
): Promise<Record<string, number | null>> {
  const file = loadDiskCache();
  const existing = file.catalogs[provider];
  if (
    existing &&
    Date.now() - existing.fetchedAt <= PROVIDER_CATALOG_TTL_MS &&
    Object.keys(existing.models).length > 0
  ) {
    return existing.models;
  }

  return fetchProviderCatalogFresh(provider);
}

function invalidateProviderCatalog(provider: string): void {
  const inFlight = fetchPromises.get(provider);
  if (inFlight) {
    inFlight.controller.abort();
    fetchPromises.delete(provider);
  }

  const file = loadDiskCache();
  delete file.catalogs[provider];
  persistDiskCache();
}

async function fetchProviderCatalogFresh(
  provider: string,
): Promise<Record<string, number | null>> {
  const inFlight = fetchPromises.get(provider);
  if (inFlight) return inFlight.promise;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(
      new Error(
        `Provider catalog fetch timed out after ${PROVIDER_CATALOG_FETCH_TIMEOUT_MS}ms`,
      ),
    );
  }, PROVIDER_CATALOG_FETCH_TIMEOUT_MS);

  // Use a slot object so the async IIFE's finally block can compare
  // promise references without TypeScript's "assigned before use" check.
  const slot: { promise: Promise<Record<string, number | null>> } = {
    promise: undefined as unknown as Promise<Record<string, number | null>>,
  };
  slot.promise = (async () => {
    try {
      // Look up base URL, env key, and headers from the shared registry.
      const registryEntry = PROVIDER_REGISTRY[provider];
      if (!registryEntry) throw new Error(`Provider "${provider}" has no registry entry`);

      const headers: Record<string, string> = {
        Accept: "application/json",
        ...registryEntry.headers,
      };
      const apiKey = registryEntry.envKey ? process.env[registryEntry.envKey] : null;
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const url = `${registryEntry.baseUrl.replace(/\/$/, "")}/models`;
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`${provider} models API returned ${response.status}`);
      }

      // The AbortSignal only cancels the HTTP request, not response.json().
      // Race response.json() against the abort signal to handle hangs during body parsing.
      const body = await Promise.race([
        response.json() as Promise<{
          data?: Array<{ id?: string; context_length?: number; context_window?: number }>;
        }>,
        new Promise<never>((_, reject) => {
          const onAbort = () => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(controller.signal.reason ?? new Error("Provider catalog fetch aborted"));
          };
          if (controller.signal.aborted) {
            reject(controller.signal.reason ?? new Error("Provider catalog fetch aborted"));
          } else {
            controller.signal.addEventListener("abort", onAbort);
          }
        }),
      ]);

      // Guard: if the fetch was aborted during response.json(), do not
      // persist stale data.
      if (controller.signal.aborted) {
        throw new Error("Provider catalog fetch aborted");
      }

      const models: Record<string, number | null> = {};
      for (const item of body.data ?? []) {
        if (!item.id) continue;
        const contextWindow = item.context_length ?? item.context_window;
        models[item.id] = isValidWindow(contextWindow) ? contextWindow : null;
      }

      const file = loadDiskCache();
      file.catalogs[provider] = {
        fetchedAt: Date.now(),
        models,
        suffixIndex: buildSuffixIndex(models),
      };
      persistDiskCache();
      return models;
    } finally {
      clearTimeout(timeoutId);
      // Only clear if this promise is still the current one for this provider,
      // preventing a race where a new fetch was started (e.g. after invalidation)
      // while this one was still settling.
      const current = fetchPromises.get(provider);
      if (current?.promise === slot.promise) fetchPromises.delete(provider);
    }
  })();

  fetchPromises.set(provider, { promise: slot.promise, controller });
  return slot.promise;
}

/** @deprecated Use providerModelIdCandidates("openrouter", modelId). */
export function openRouterModelIdCandidates(modelId: string): string[] {
  return providerModelIdCandidates("openrouter", modelId);
}

/** @deprecated Use findProviderCatalogModelId("openrouter", modelId). */
export async function findOpenRouterCatalogModelId(modelId: string): Promise<string | null> {
  return findProviderCatalogModelId("openrouter", modelId);
}

/** Test helper — reset in-memory/disk cache state. */
export function resetProviderCatalogCacheForTests(): void {
  for (const inFlight of fetchPromises.values()) {
    inFlight.controller.abort();
  }
  diskCache = null;
  fetchPromises.clear();
  if (existsSync(CACHE_FILE)) {
    unlinkSync(CACHE_FILE);
  }
}
