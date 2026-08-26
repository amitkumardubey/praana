import {
  listKnownProviders,
  isProviderAvailable,
  getMissingKeyMessage,
} from "./llm.js";
import { mapProviderToPiAi } from "./model-context.js";
import {
  listProviderCatalogModels,
  providerSupportsLiveCatalog,
} from "./provider-catalog.js";
import { getCuratedModels } from "./llm/catalog.js";

export interface ModelListEntry {
  provider: string;
  modelId: string;
  label: string;
  contextWindow: number | null;
  available: boolean;
  disabledReason?: string;
}

export interface ModelAutocompleteItem {
  /** Inserted after `/model ` — space-separated so slash parsing switches provider. */
  value: string;
  label: string;
  description?: string;
}

function providerAvailability(provider: string): {
  available: boolean;
  disabledReason?: string;
} {
  const available = isProviderAvailable(provider);
  if (available) return { available: true };
  return {
    available: false,
    disabledReason: getMissingKeyMessage(provider) ?? `Provider "${provider}" is not configured`,
  };
}

export function formatCtx(window: number | null): string {
  if (window == null) return "";
  if (window >= 1_000_000) return `${(window / 1_000_000).toFixed(1)}M ctx`;
  if (window >= 1000) return `${Math.round(window / 1000)}k ctx`;
  return `${window} ctx`;
}

function collectPiAiModels(
  provider: string,
  available: boolean,
  disabledReason?: string,
): ModelListEntry[] {
  const models = getCuratedModels(provider);
  return models.map((m) => ({
    provider,
    modelId: m.id,
    label: m.name || m.id,
    contextWindow: m.contextWindow || null,
    available,
    ...(disabledReason ? { disabledReason } : {}),
  }));
}

export interface ListModelsForProviderOptions {
  /** When set, skip env-key re-check (caller already gated availability). */
  available?: boolean;
  disabledReason?: string;
}

/** Models for one provider: pi-ai catalog merged with live `/models` when available. */
export async function listModelsForProvider(
  provider: string,
  opts?: ListModelsForProviderOptions,
): Promise<ModelListEntry[]> {
  const { available, disabledReason } =
    opts?.available !== undefined
      ? {
          available: opts.available,
          disabledReason: opts.disabledReason,
        }
      : providerAvailability(provider);

  const byId = new Map<string, ModelListEntry>();

  for (const entry of collectPiAiModels(provider, available, disabledReason)) {
    byId.set(entry.modelId, entry);
  }

  // Skip live catalog for unavailable providers — avoids slow AWS/network
  // probes when listing with --all, and pi-ai static catalog is enough.
  if (available && providerSupportsLiveCatalog(provider)) {
    try {
      const catalog = await listProviderCatalogModels(provider);
      for (const { id, contextWindow } of catalog) {
        const existing = byId.get(id);
        if (existing) {
          if (existing.contextWindow == null && contextWindow != null) {
            existing.contextWindow = contextWindow;
          }
          continue;
        }
        byId.set(id, {
          provider,
          modelId: id,
          label: id,
          contextWindow,
          available,
          ...(disabledReason ? { disabledReason } : {}),
        });
      }
    } catch (err) {
      // Keep any pi-ai models we already have; only fail hard when empty.
      if (byId.size === 0) throw err;
    }
  }

  return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * Flat list across available providers for the `/model` selector.
 * Loads fresh each open (no session-long cache).
 * Throws when every available provider fails to yield models.
 */
export async function listAllAvailableModels(): Promise<ModelListEntry[]> {
  const providers = listKnownProviders().filter((p) => isProviderAvailable(p));
  const out: ModelListEntry[] = [];
  const errors: string[] = [];

  for (const provider of providers) {
    try {
      out.push(
        ...(await listModelsForProvider(provider, { available: true })),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${provider}: ${message}`);
    }
  }

  if (out.length === 0 && errors.length > 0) {
    throw new Error(`Failed to load models:\n${errors.join("\n")}`);
  }

  return out;
}

/**
 * Resolve a provider filter against known providers (case-insensitive).
 * Throws when the filter does not match any known provider.
 */
export function resolveCliProviderFilter(filter: string): string {
  const known = listKnownProviders();
  const needle = filter.trim().toLowerCase();
  const match = known.find((p) => p.toLowerCase() === needle);
  if (!match) {
    throw new Error(
      `Unknown provider "${filter}". Known providers: ${known.join(", ")}`,
    );
  }
  return match;
}

/**
 * Flat list for the `praana models` CLI.
 * Default: only providers with a usable API key / config.
 * Pass `includeUnavailable: true` (`--all`) to include every known provider.
 * An explicit provider filter always includes that provider even if unavailable.
 * Throws when a filter is unknown, or when every selected provider fails.
 */
export async function listModelsForCli(
  filterProvider?: string,
  opts?: { includeUnavailable?: boolean },
): Promise<ModelListEntry[]> {
  const includeUnavailable = opts?.includeUnavailable === true;

  let providers: string[];
  if (filterProvider) {
    providers = [resolveCliProviderFilter(filterProvider)];
  } else if (includeUnavailable) {
    providers = listKnownProviders();
  } else {
    providers = listKnownProviders().filter((p) => isProviderAvailable(p));
  }

  if (providers.length === 0) {
    throw new Error(
      "No configured providers found. Set an API key, or pass --all to list every known provider.",
    );
  }

  const out: ModelListEntry[] = [];
  const errors: string[] = [];

  for (const provider of providers) {
    try {
      out.push(...(await listModelsForProvider(provider)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${provider}: ${message}`);
      const { disabledReason } = providerAvailability(provider);
      out.push({
        provider,
        modelId: "",
        label: "",
        contextWindow: null,
        available: false,
        disabledReason: disabledReason ?? message,
      });
    }
  }

  const hasRealModels = out.some((e) => e.modelId !== "");
  if (!hasRealModels && errors.length > 0) {
    throw new Error(`Failed to load models:\n${errors.join("\n")}`);
  }

  return out;
}

export interface FormatModelsCliOptions {
  defaultProvider?: string;
  defaultModel?: string;
}

/**
 * Format model entries as a readable grouped listing for stdout.
 */
export function formatModelsCliOutput(
  entries: ModelListEntry[],
  opts?: FormatModelsCliOptions,
): string {
  const byProvider = new Map<string, ModelListEntry[]>();
  for (const entry of entries) {
    const list = byProvider.get(entry.provider) ?? [];
    list.push(entry);
    byProvider.set(entry.provider, list);
  }

  const providers = [...byProvider.keys()].sort((a, b) => a.localeCompare(b));
  if (providers.length === 0) {
    return "No models found.";
  }

  const lines: string[] = [];
  for (const provider of providers) {
    const models = byProvider.get(provider)!;
    const sample = models[0];
    const available = models.some((m) => m.available);
    const reason =
      sample?.disabledReason ??
      models.find((m) => m.disabledReason)?.disabledReason;
    if (available) {
      lines.push(provider);
    } else {
      lines.push(`${provider} (unavailable: ${reason ?? "not configured"})`);
    }

    const modelRows = models
      .filter((m) => m.modelId !== "")
      .sort((a, b) => a.modelId.localeCompare(b.modelId));

    if (modelRows.length === 0) {
      lines.push("  (no models in catalog)");
    } else {
      for (const m of modelRows) {
        const isDefault =
          opts?.defaultProvider === m.provider &&
          opts?.defaultModel === m.modelId;
        const mark = isDefault ? " *" : "";
        lines.push(`  ${m.modelId}${mark}`);
      }
    }
    lines.push("");
  }

  // Trim trailing blank line for cleaner stdout.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function toAutocompleteItem(entry: ModelListEntry): ModelAutocompleteItem {
  const label = `${entry.provider}/${entry.modelId}`;
  const ctx = formatCtx(entry.contextWindow);
  return {
    value: `${entry.provider} ${entry.modelId}`,
    label,
    ...(ctx ? { description: ctx } : {}),
  };
}

export function buildModelAutocompleteItems(
  models: ModelListEntry[],
): ModelAutocompleteItem[] {
  return models.map(toAutocompleteItem);
}

const MAX_AUTOCOMPLETE_RESULTS = 50;

interface FuzzyMatch<T> {
  item: T;
  score: number;
}

/** Simple subsequence fuzzy filter: `query` characters must appear in order in `text`. */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): T[] {
  if (!query) return items;
  const q = query.toLowerCase();
  const results: FuzzyMatch<T>[] = [];
  for (const item of items) {
    const text = getText(item).toLowerCase();
    let qi = 0;
    let score = 0;
    let lastMatch = -1;
    for (let ti = 0; ti < text.length && qi < q.length; ti++) {
      if (text[ti] === q[qi]) {
        score += lastMatch === ti - 1 ? 2 : 1;
        lastMatch = ti;
        qi++;
      }
    }
    if (qi === q.length) results.push({ item, score });
  }
  return results.sort((a, b) => b.score - a.score).map((m) => m.item);
}

/** Fuzzy-filter autocomplete items by provider and/or model id. */
export function filterModelAutocompleteItems(
  catalog: ModelAutocompleteItem[],
  argumentPrefix: string,
): ModelAutocompleteItem[] {
  const query = argumentPrefix.trim();
  if (!query) return catalog.slice(0, MAX_AUTOCOMPLETE_RESULTS);

  const filtered = fuzzyFilter(
    catalog,
    query,
    (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
  );
  return filtered.slice(0, MAX_AUTOCOMPLETE_RESULTS);
}
