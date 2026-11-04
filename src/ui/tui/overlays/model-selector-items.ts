/**
 * Pure helpers for the model selector: ordering, filtering, scroll window,
 * and navigation that skips unavailable rows. No Solid/OpenTUI imports —
 * unit-testable.
 */
import { formatCtx, type ModelListEntry } from "../../../model-listing.js";

/** Current model pinned to top; otherwise group providers and preserve catalog order. */
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
    return byProvider;
  });
}

/** Provider substring hits retain list order; model-only hits use fuzzy ranking. */
export function filterModelItems(
  entries: ModelListEntry[],
  query: string,
): ModelListEntry[] {
  const tokens = query.trim().toLowerCase().split(/[\s/]+/).filter(Boolean);
  if (!tokens.length) return entries;

  // Same subsequence scoring as fuzzyFilter, applied independently to each token.
  const scoreToken = (text: string, token: string): number | null => {
    let qi = 0;
    let score = 0;
    let lastMatch = -1;
    for (let i = 0; i < text.length && qi < token.length; i++) {
      if (text[i] === token[qi]) {
        score += lastMatch === i - 1 ? 2 : 1;
        lastMatch = i;
        qi++;
      }
    }
    return qi === token.length ? score : null;
  };

  const providerHits: ModelListEntry[] = [];
  const modelHits: { item: ModelListEntry; score: number }[] = [];
  for (const item of entries) {
    const provider = item.provider.toLowerCase();
    const modelId = item.modelId.toLowerCase();
    const label = item.label.toLowerCase();
    let providerHit = false;
    let score = 0;
    let matches = true;
    for (const token of tokens) {
      if (provider.includes(token)) {
        providerHit = true;
        continue;
      }
      const idScore = scoreToken(modelId, token);
      const labelScore = scoreToken(label, token);
      if (idScore === null && labelScore === null) {
        matches = false;
        break;
      }
      score += Math.max(idScore ?? 0, labelScore ?? 0);
    }
    if (matches) {
      if (providerHit) providerHits.push(item);
      else modelHits.push({ item, score });
    }
  }
  modelHits.sort((a, b) => b.score - a.score);
  return [...providerHits, ...modelHits.map(({ item }) => item)];
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
