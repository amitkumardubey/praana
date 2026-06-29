/**
 * Block-level ANSI markdown renderer.
 * Processes one line at a time; no external dependencies except ./ansi and ./inline.
 */
import { ansi } from "./ansi.js";
import { applyInline } from "./inline.js";
import { highlightSync } from "./highlight.js";
import type { RendererOptions } from "./types.js";

// Nord-inspired colours for structural elements.
const HEADING1_HEX  = "#88C0D0"; // nord8  — frost blue
const HEADING2_HEX  = "#81A1C1"; // nord9  — steel blue
const HEADING3_HEX  = "#7B869B"; // nord3b-ish — muted

const BULLET_MARKERS = ["•", "◦", "‣"] as const;

function bulletFor(depth: number): string {
  return BULLET_MARKERS[Math.min(depth, 2)] ?? "•";
}

export function renderBlocks(text: string, opts: RendererOptions = {}): string {
  const hrWidth = opts.hrWidth ?? 40;
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // ── Fenced code block ───────────────────────────────────────────────────
    const fenceMatch = line.match(/^(`{3,}|~{3,})([\w.-]*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      const lang  = fenceMatch[2]!.trim().toLowerCase();
      i++;
      const body: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith(fence)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence

      const raw = body.join("\n");
      let rendered: string;
      if (opts.syntaxHighlight && lang) {
        rendered = highlightSync(raw, lang, opts.syntaxTheme);
      } else {
        rendered = ansi.dim(raw);
      }
      // Indent the entire block by two spaces for visual separation.
      for (const codeLine of rendered.split("\n")) {
        out.push(`  ${codeLine}`);
      }
      out.push("");
      continue;
    }

    // ── ATX headings ────────────────────────────────────────────────────────
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level   = headingMatch[1]!.length;
      const content = applyInline(headingMatch[2]!);
      if (level === 1) {
        out.push(ansi.fg(HEADING1_HEX, ansi.bold(ansi.underline(content))));
      } else if (level === 2) {
        out.push(ansi.fg(HEADING2_HEX, ansi.bold(content)));
      } else {
        out.push(ansi.fg(HEADING3_HEX, ansi.bold(content)));
      }
      out.push("");
      i++;
      continue;
    }

    // ── Setext headings (underlined with = or -) ────────────────────────────
    const nextLine = lines[i + 1] ?? "";
    if (/^=+\s*$/.test(nextLine)) {
      out.push(ansi.fg(HEADING1_HEX, ansi.bold(ansi.underline(applyInline(line)))));
      out.push("");
      i += 2;
      continue;
    }
    if (/^-+\s*$/.test(nextLine) && line.trim()) {
      out.push(ansi.fg(HEADING2_HEX, ansi.bold(applyInline(line))));
      out.push("");
      i += 2;
      continue;
    }

    // ── Horizontal rule ─────────────────────────────────────────────────────
    if (/^[ \t]*(\*\*\*+|---+|___+)\s*$/.test(line)) {
      out.push(ansi.dim("─".repeat(hrWidth)));
      i++;
      continue;
    }

    // ── Blockquote ──────────────────────────────────────────────────────────
    const bqMatch = line.match(/^>\s?(.*)/);
    if (bqMatch) {
      out.push(ansi.dim(`│ ${applyInline(bqMatch[1]!)}`));
      i++;
      continue;
    }

    // ── Unordered list item (handles 2-space and 4-space indentation) ───────
    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.*)/);
    if (ulMatch) {
      const spaces = ulMatch[1]!.length;
      // 4-space LLM style or 2-space standard — normalise to nesting depth
      const depth  = spaces >= 4 ? Math.floor(spaces / 4) : Math.floor(spaces / 2);
      const indent = "  ".repeat(depth);
      out.push(`${indent}${bulletFor(depth)} ${applyInline(ulMatch[2]!)}`);
      i++;
      continue;
    }

    // ── Ordered list item ───────────────────────────────────────────────────
    const olMatch = line.match(/^(\s*)(\d+[.)]) +(.*)/);
    if (olMatch) {
      const spaces = olMatch[1]!.length;
      const depth  = spaces >= 4 ? Math.floor(spaces / 4) : Math.floor(spaces / 2);
      const indent = "  ".repeat(depth);
      out.push(`${indent}${ansi.dim(olMatch[2]!)} ${applyInline(olMatch[3]!)}`);
      i++;
      continue;
    }

    // ── GFM table ───────────────────────────────────────────────────────────
    // Detect: current line has pipes, next line is an alignment row (---)
    if (line.includes("|")) {
      const sepLine = lines[i + 1] ?? "";
      if (/^\|?[\s:|-]+\|/.test(sepLine)) {
        const tableLines: string[] = [line];
        i += 2; // skip header + separator
        while (i < lines.length && lines[i]!.includes("|")) {
          tableLines.push(lines[i]!);
          i++;
        }
        out.push(renderTable(tableLines));
        out.push("");
        continue;
      }
    }

    // ── Blank line ──────────────────────────────────────────────────────────
    if (line.trim() === "") {
      out.push("");
      i++;
      continue;
    }

    // ── Paragraph ───────────────────────────────────────────────────────────
    out.push(applyInline(line));
    i++;
  }

  return out.join("\n");
}

function splitRow(row: string): string[] {
  return row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function renderTable(rows: string[]): string {
  if (rows.length === 0) return "";
  const header = splitRow(rows[0]!);
  const body   = rows.slice(1).map(splitRow);

  const colCount = header.length;
  // Widths computed from PLAIN text only — applyInline injects ANSI bytes
  // that inflate .length and break column alignment if measured after styling.
  const widths = Array.from({ length: colCount }, (_, ci) => {
    const all = [header[ci] ?? "", ...body.map((r) => r[ci] ?? "")];
    return Math.max(...all.map((c) => c.length), 1);
  });

  // Render a cell: apply inline styling first, then pad with plain spaces
  // to reach the target width (spaces outside ANSI codes, no alignment drift).
  const styledCell = (raw: string, w: number, isHeader: boolean): string => {
    const content = applyInline(raw);
    const padding = " ".repeat(Math.max(0, w - raw.length));
    return isHeader ? ansi.bold(content) + padding : content + padding;
  };

  const divider = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const renderRow = (cells: string[], isHeader: boolean) =>
    "│" + cells.map((c, ci) => ` ${styledCell(c, widths[ci]!, isHeader)} `).join("│") + "│";

  return [
    renderRow(header, true),
    ansi.dim("├" + divider + "┤"),
    ...body.map((row) => renderRow(
      Array.from({ length: colCount }, (_, ci) => row[ci] ?? ""),
      false,
    )),
  ].join("\n");
}
