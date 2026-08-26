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
}

/** One palette item per canonical command; aliases are folded into the item. */
export function buildPaletteItems(
  metadata: readonly SlashCommandMeta[],
): PaletteItem[] {
  return metadata.map((m) => ({
    name: m.name,
    description: m.description,
    argumentHint: m.argumentHint,
    aliases: m.aliases ?? [],
    category: m.category,
  }));
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
