import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { fuzzyFilter } from "@earendil-works/pi-tui";
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

function formatCtx(window: number | null): string {
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
  const piProvider = mapProviderToPiAi(provider) ?? provider;
  if (!(getProviders() as string[]).includes(piProvider)) return [];

  const models = getModels(piProvider as never) ?? [];
  return models.map((m) => ({
    provider,
    modelId: m.id,
    label: m.id,
    contextWindow:
      typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow)
        ? m.contextWindow
        : null,
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

  if (providerSupportsLiveCatalog(provider)) {
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
