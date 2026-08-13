/**
 * Apply LSP TextEdit arrays safely (0-based positions).
 */

import type { LspPosition, LspTextEdit } from "./types.js";

function offsetAt(content: string, pos: LspPosition): number | null {
  if (pos.line < 0 || pos.character < 0) return null;
  const lines = content.split("\n");
  if (pos.line >= lines.length) return null;
  const line = lines[pos.line]!;
  if (pos.character > line.length) return null;
  let offset = 0;
  for (let i = 0; i < pos.line; i++) {
    offset += lines[i]!.length + 1; // +1 for '\n'
  }
  return offset + pos.character;
}

function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Apply text edits in descending document order.
 * Rejects overlapping or out-of-bounds ranges.
 */
export function applyTextEdits(
  content: string,
  edits: LspTextEdit[],
): { ok: true; content: string } | { ok: false; error: string } {
  if (edits.length === 0) return { ok: true, content };

  const resolved: Array<{ start: number; end: number; newText: string }> = [];
  for (const edit of edits) {
    const start = offsetAt(content, edit.range.start);
    const end = offsetAt(content, edit.range.end);
    if (start === null || end === null || end < start) {
      return { ok: false, error: "TextEdit range out of bounds" };
    }
    resolved.push({ start, end, newText: edit.newText });
  }

  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (rangesOverlap(resolved[i]!, resolved[j]!)) {
        return { ok: false, error: "Overlapping TextEdits rejected" };
      }
    }
  }

  resolved.sort((a, b) => b.start - a.start);

  let out = content;
  for (const e of resolved) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  }
  return { ok: true, content: out };
}
