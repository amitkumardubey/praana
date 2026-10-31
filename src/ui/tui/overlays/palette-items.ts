/**
 * Pure logic for the slash command palette: item building, fuzzy filtering,
 * and the smart-run rule. No Solid/OpenTUI imports — unit-testable.
 */
import { fuzzyFilter } from "../../../model-listing.js";
import type { SlashCommandMeta } from "../../../slash-commands.js";

export interface PaletteItem {
  name: string;
  description: string;
  argumentHint?: string;
  aliases: string[];
  category: string;
  /** Copied from slash-command metadata. Session-ending / state-wiping commands. */
  destructive?: true;
}

function isDestructive(item: PaletteItem): boolean {
  return item.destructive === true;
}

/** Stable partition: non-destructive commands first, destructive ones last.
 *  A list with nothing to protect is returned untouched. */
export function orderPaletteItems(items: PaletteItem[]): PaletteItem[] {
  const safe: PaletteItem[] = [];
  const destructive: PaletteItem[] = [];
  for (const item of items) {
    (isDestructive(item) ? destructive : safe).push(item);
  }
  if (safe.length === 0) return items;
  return [...safe, ...destructive];
}

/** One palette item per canonical command; aliases are folded into the item. */
export function buildPaletteItems(
  metadata: readonly SlashCommandMeta[],
): PaletteItem[] {
  return orderPaletteItems(
    metadata.map((m) => ({
      name: m.name,
      description: m.description,
      argumentHint: m.argumentHint,
      aliases: m.aliases ?? [],
      category: m.category,
      ...(m.destructive ? { destructive: m.destructive } : {}),
    })),
  );
}

/** Bare query preserves curated metadata order; otherwise fuzzy over name + aliases.
 *  Name-prefix matches rank first (metadata order), then subsequence matches. */
export function filterPaletteItems(
  items: PaletteItem[],
  query: string,
): PaletteItem[] {
  const q = query.trim();
  if (!q) return items;
  const ql = q.toLowerCase();
  const prefix = items.filter((i) =>
    i.name.slice(1).toLowerCase().startsWith(ql),
  );
  const fuzzy = fuzzyFilter(items, q, (i) => `${i.name} ${i.aliases.join(" ")}`);
  const out: PaletteItem[] = [...prefix];
  for (const item of fuzzy) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** Smart-run rule: only commands with a required `<...>` argument insert into the prompt. */
export function commandNeedsArgument(item: PaletteItem): boolean {
  return item.argumentHint?.startsWith("<") ?? false;
}
