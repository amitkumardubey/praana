/**
 * Large-paste collapse: show a chip in the editor, expand full text on submit.
 * Thresholds align with OpenCode defaults (≥3 lines or length > 150).
 */
export const PASTE_COLLAPSE_MIN_LINES = 3;
export const PASTE_COLLAPSE_MIN_CHARS = 150;

const CHIP_RE = /\[Pasted ~(\d+) lines #([a-z0-9]+)\]/g;

export function normalizePasteText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function shouldCollapsePaste(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const lines = (normalized.match(/\n/g)?.length ?? 0) + 1;
  return lines >= PASTE_COLLAPSE_MIN_LINES || normalized.length > PASTE_COLLAPSE_MIN_CHARS;
}

export function makePasteId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function formatPasteChip(lineCount: number, id: string): string {
  return `[Pasted ~${lineCount} lines #${id}]`;
}

export function countLines(text: string): number {
  if (!text) return 0;
  return (text.match(/\n/g)?.length ?? 0) + 1;
}

/** Expand paste chips using the store; unknown chips are left as-is. */
export function expandPasteChips(text: string, store: Map<string, string>): string {
  return text.replace(CHIP_RE, (match, _lines, id: string) => {
    const body = store.get(id);
    return body ?? match;
  });
}

/** Drop store entries whose chips are no longer present in the buffer. */
export function prunePasteStore(text: string, store: Map<string, string>): void {
  const live = new Set<string>();
  for (const m of text.matchAll(CHIP_RE)) {
    live.add(m[2]!);
  }
  for (const id of store.keys()) {
    if (!live.has(id)) store.delete(id);
  }
}
