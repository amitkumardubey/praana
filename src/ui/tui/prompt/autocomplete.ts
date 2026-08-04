/**
 * Slash + path autocomplete suggestions for the Solid Prompt.
 */
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { SLASH_COMMAND_METADATA } from "../../../slash-commands.js";

export interface AutocompleteItem {
  label: string;
  value: string;
  description?: string;
}

export interface AutocompleteResult {
  items: AutocompleteItem[];
  /** Prefix being replaced (e.g. "/he" or "./src/fo"). */
  prefix: string;
  /** Start offset of prefix in the full buffer text. */
  start: number;
  /** End offset (usually caret). */
  end: number;
}

/** Extract the token at caret that might trigger autocomplete. */
export function tokenAtCaret(text: string, caret: number): { token: string; start: number; end: number } {
  const end = Math.max(0, Math.min(caret, text.length));
  let start = end;
  while (start > 0) {
    const ch = text[start - 1]!;
    if (/\s/.test(ch)) break;
    start -= 1;
  }
  return { token: text.slice(start, end), start, end };
}

function filterSlash(prefix: string): AutocompleteItem[] {
  const q = prefix.toLowerCase();
  const items: AutocompleteItem[] = [];
  for (const meta of SLASH_COMMAND_METADATA) {
    const names = [meta.name, ...(meta.aliases ?? [])];
    for (const name of names) {
      if (name.toLowerCase().startsWith(q) || (q === "/" && name.startsWith("/"))) {
        items.push({
          label: name,
          value: name,
          description: meta.description,
        });
      }
    }
  }
  // De-dupe by value
  const seen = new Set<string>();
  return items.filter((i) => {
    if (seen.has(i.value)) return false;
    seen.add(i.value);
    return true;
  }).slice(0, 12);
}

async function filterPaths(cwd: string, token: string): Promise<AutocompleteItem[]> {
  // Trigger on ./ ../ ~/ or path-like tokens with a slash, or bare ./ prefix
  const pathLike =
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("~/") ||
    token.startsWith("/") ||
    (token.includes("/") && !token.startsWith("/"));
  if (!pathLike && !token.startsWith(".")) return [];

  let expanded = token;
  if (token.startsWith("~/")) {
    const home = process.env.HOME ?? "";
    expanded = home + token.slice(1);
  } else if (!token.startsWith("/")) {
    expanded = resolve(cwd, token);
  }

  const wantsDir = token.endsWith("/") || token.endsWith(sep);
  const dir = wantsDir ? expanded : dirname(expanded);
  const base = wantsDir ? "" : basename(expanded);

  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const lower = base.toLowerCase();
  const matched = entries
    .filter((e) => (lower ? e.toLowerCase().startsWith(lower) : true))
    .sort()
    .slice(0, 12);

  return matched.map((name) => {
    const full = join(dir, name);
    // Keep the user's token style for the replacement prefix directory part
    const prefixDir = token.endsWith("/") || token.endsWith(sep)
      ? token
      : token.slice(0, token.length - base.length);
    return {
      label: name,
      value: prefixDir + name,
      description: full,
    };
  });
}

export async function getAutocomplete(
  text: string,
  caret: number,
  cwd: string,
): Promise<AutocompleteResult | null> {
  const { token, start, end } = tokenAtCaret(text, caret);
  if (!token) return null;

  if (token.startsWith("/")) {
    // Slash commands only when token is a command (no path after first slash segment for /foo/bar files at root — still ok)
    const items = filterSlash(token);
    if (items.length === 0) return null;
    return { items, prefix: token, start, end };
  }

  const items = await filterPaths(cwd, token);
  if (items.length === 0) return null;
  return { items, prefix: token, start, end };
}

/** Apply a completion by replacing [start, end) with item.value (+ trailing space for slash). */
export function applyAutocomplete(
  text: string,
  start: number,
  end: number,
  item: AutocompleteItem,
  opts?: { slashSpace?: boolean },
): { text: string; caret: number } {
  const slash = item.value.startsWith("/");
  const insert = slash && opts?.slashSpace !== false ? item.value + " " : item.value;
  const next = text.slice(0, start) + insert + text.slice(end);
  return { text: next, caret: start + insert.length };
}
