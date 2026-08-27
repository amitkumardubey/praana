/**
 * Pure helpers for palette-styled pickers (login / setup / logout).
 * Same scroll math as the /model selector.
 */
import { fuzzyFilter } from "../../../model-listing.js";
import { scrollStartOf } from "./model-selector-items.js";

export interface PaletteListOption {
  value: string;
  name: string;
  description?: string;
  aliases?: string[];
}

export function toPaletteOptions(
  items: readonly {
    label: string;
    value: string;
    description?: string;
    aliases?: string[];
  }[],
): PaletteListOption[] {
  return items.map((item) => ({
    name: item.label,
    description: item.description ?? "",
    value: item.value,
    aliases: item.aliases,
  }));
}

function pickerSearchText(option: PaletteListOption): string {
  return `${option.name} ${option.value} ${(option.aliases ?? []).join(" ")}`;
}

/** Name, id, hyphenated id segment, or alias prefix (case-insensitive). */
export function isPickerPrefixMatch(option: PaletteListOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const name = option.name.toLowerCase();
  const value = option.value.toLowerCase();
  if (name.startsWith(q) || value.startsWith(q)) return true;
  if (value.split(/[-_./]/).some((part) => part.startsWith(q))) return true;
  if (name.split(/[\s/_-]+/).some((part) => part.startsWith(q))) return true;
  return (option.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(q));
}

export function filterPickerOptions(
  options: readonly PaletteListOption[],
  query: string,
): PaletteListOption[] {
  const q = query.trim();
  if (!q) return [...options];
  const prefix = options.filter((option) => isPickerPrefixMatch(option, q));
  const fuzzy = fuzzyFilter([...options], q, pickerSearchText);
  const out: PaletteListOption[] = [...prefix];
  for (const item of fuzzy) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export { scrollStartOf };
