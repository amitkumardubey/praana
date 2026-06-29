/**
 * Inline span processor using a two-pass tokenizer.
 *
 * Pass 1 (tokenize): scan left-to-right and extract opaque spans — code
 * backticks and markdown links — BEFORE any pattern matching runs. This
 * prevents `*` / `_` / `~~` inside backticks or link URLs from being
 * treated as emphasis delimiters.
 *
 * Pass 2 (emphasise): apply bold/italic/strikethrough only to plain-text
 * fragments between the opaque tokens.
 *
 * Design notes for package extraction:
 *  - `_` / `__` emphasis intentionally omitted. LLMs use `*`-style overwhelm-
 *    ingly, and underscore emphasis produces unbearable false positives on
 *    snake_case identifiers, __dunder__ methods, and math expressions.
 *  - `*` emphasis requires a non-space character immediately inside both
 *    delimiters, so `*args`, `**kwargs`, and `2 * 3 * 4` are never matched.
 *  - No external dependencies.
 */
import { ansi } from "./ansi.js";

// Nord13 warm yellow for inline code.
const INLINE_CODE_HEX = "#EBCB8B";

// ── Token types ──────────────────────────────────────────────────────────────

type CodeToken = { kind: "code"; content: string };
type LinkToken = { kind: "link"; label: string };
type TextToken = { kind: "text"; raw: string };
type InlineToken = CodeToken | LinkToken | TextToken;

// ── Pass 1: tokenizer ────────────────────────────────────────────────────────

function tokenize(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  let textStart = 0;

  const flushText = (end: number): void => {
    if (end > textStart) {
      tokens.push({ kind: "text", raw: text.slice(textStart, end) });
    }
  };

  while (i < text.length) {
    const ch = text[i]!;

    // ── Backtick code span ─────────────────────────────────────────────────
    if (ch === "`") {
      // Determine fence length (supports `` ` ``, ``` `` ```, etc.)
      let j = i + 1;
      while (j < text.length && text[j] === "`") j++;
      const fence = "`".repeat(j - i);

      // Find the matching close fence on the same line
      const closeIdx = text.indexOf(fence, j);
      if (closeIdx !== -1 && !text.slice(j, closeIdx).includes("\n")) {
        flushText(i);
        // CommonMark: strip one leading/trailing space if content is
        // non-empty and starts/ends with a space but isn't all spaces.
        let content = text.slice(j, closeIdx);
        if (content.length > 2 && content[0] === " " && content[content.length - 1] === " " && content.trim()) {
          content = content.slice(1, -1);
        }
        tokens.push({ kind: "code", content });
        i = closeIdx + fence.length;
        textStart = i;
        continue;
      }
    }

    // ── Markdown link [label](url) ─────────────────────────────────────────
    if (ch === "[") {
      const labelEnd = text.indexOf("]", i + 1);
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const urlEnd = text.indexOf(")", labelEnd + 2);
        if (urlEnd !== -1) {
          flushText(i);
          tokens.push({ kind: "link", label: text.slice(i + 1, labelEnd) });
          i = urlEnd + 1;
          textStart = i;
          continue;
        }
      }
    }

    i++;
  }

  flushText(text.length);
  return tokens;
}

// ── Pass 2: emphasis on plain text ───────────────────────────────────────────

/**
 * Apply `*`-style emphasis to a plain-text fragment.
 * Requires a non-space character immediately inside both delimiters so
 * that `*args`, `**kwargs`, and `2 * 3 * 4` never match.
 */
function emphasise(raw: string): string {
  return raw
    // Bold + italic (must precede the single-level patterns)
    .replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, (_, t: string) => ansi.bold(ansi.italic(t)))
    // Bold
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, (_, t: string) => ansi.bold(t))
    // Italic — additionally guard that neither delimiter is adjacent to
    // another `*` (prevents partial matches on `**bold**` remnants)
    .replace(/(?<!\*)\*(?=\S)(.+?)(?<=\S)(?<!\*)\*(?!\*)/g, (_, t: string) => ansi.italic(t))
    // Strikethrough
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_, t: string) => ansi.strikethrough(t));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Process inline markdown spans in a single line of text.
 * Safe for programming content: code spans are opaque, `_`/`__` are never
 * treated as emphasis delimiters.
 */
export function applyInline(text: string): string {
  return tokenize(text)
    .map((tok): string => {
      switch (tok.kind) {
        case "code": return ansi.fg(INLINE_CODE_HEX, tok.content);
        case "link": return ansi.underline(tok.label);
        case "text": return emphasise(tok.raw);
      }
    })
    .join("");
}
