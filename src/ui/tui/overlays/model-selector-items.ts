/**
 * Pure helpers for the model selector: ordering, filtering, scroll window,
 * and navigation that skips unavailable rows. No Solid/OpenTUI imports —
 * unit-testable.
 */
import { formatCtx, fuzzyFilter, type ModelListEntry } from "../../../model-listing.js";

/** Current model pinned to top; otherwise provider, then model id. */
export function orderModels(
  entries: ModelListEntry[],
  currentProvider: string,
  currentModelId: string,
): ModelListEntry[] {
  return [...entries].sort((a, b) => {
    const aCurrent = a.provider === currentProvider && a.modelId === currentModelId;
    const bCurrent = b.provider === currentProvider && b.modelId === currentModelId;
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    const byProvider = a.provider.localeCompare(b.provider);
    if (byProvider !== 0) return byProvider;
    return a.modelId.localeCompare(b.modelId);
  });
}

/** Bare query preserves order; else fuzzy over provider + model id. */
export function filterModelItems(
  entries: ModelListEntry[],
  query: string,
): ModelListEntry[] {
  const q = query.trim();
  if (!q) return entries;
  return fuzzyFilter(entries, q, (m) => `${m.provider} ${m.modelId} ${m.provider}/${m.modelId}`);
}

/** First visible index for a scroll window (palette scroll math). */
export function scrollStartOf(
  selectedIndex: number,
  total: number,
  visible: number,
): number {
  return Math.min(
    Math.max(0, selectedIndex - visible + 1),
    Math.max(0, total - visible),
  );
}

/** The selection the picker should open on. */
export function initialSelectionIndex(
  list: ModelListEntry[],
  currentProvider: string,
  currentModelId: string,
): number {
  const idx = list.findIndex(
    (m) => m.provider === currentProvider && m.modelId === currentModelId,
  );
  if (idx >= 0) return idx;
  const first = list.findIndex((m) => m.available);
  return first === -1 ? 0 : first;
}

/** Move selection in `direction` (1 down, -1 up), skipping unavailable rows. */
export function moveSelection(
  list: ModelListEntry[],
  from: number,
  direction: 1 | -1,
): number {
  let i = from + direction;
  while (i >= 0 && i < list.length) {
    if (list[i].available) return i;
    i += direction;
  }
  if (list[from]?.available) return from;
  const first = list.findIndex((m) => m.available);
  return first === -1 ? 0 : first;
}

/** Single-line list-row text: `modelId [provider] ctx`. */
export function formatModelRow(m: ModelListEntry): string {
  const ctx = formatCtx(m.contextWindow);
  return `${m.modelId} [${m.provider}]${ctx ? ` ${ctx}` : ""}`;
}
