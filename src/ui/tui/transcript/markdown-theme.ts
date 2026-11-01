/* OpenTUI SyntaxStyle for markdown.
 *
 * The highlighter emits full scope names (`markup.heading.1`, `markup.strong`,
 * …). SyntaxStyle only falls back to the segment before the first dot, so
 * `markup.heading` does not style `markup.heading.1` — each level is registered
 * with the same style. `markup.raw.block` is background-only so a fenced
 * block's language tokens keep their own colours. SyntaxStyle has no
 * strikethrough bit; `markup.strikethrough` is dim and coloured instead.
 * `syntaxTheme` is accepted and unused (theme selection is separate).
 *
 * Styles are native resources, so we memoise one SyntaxStyle per syntaxTheme
 * string at module level instead of allocating a fresh one on every JSX prop
 * re-evaluation. Adjusting for OpenTUI 0.8 (where fromStyles takes an owner)
 * means keying this cache by owner too — see note in buildMarkdownSyntaxStyle. */
import { SyntaxStyle, type StyleDefinitionInput } from "@opentui/core";

const HEADING: StyleDefinitionInput = { bold: true, fg: "#7aa2f7" };
const LIST: StyleDefinitionInput = { fg: "#c4887a", dim: true };

/** One shared SyntaxStyle per syntaxTheme string, for the process lifetime. */
const syntaxStyleCache = new Map<string, SyntaxStyle>();

function buildStyles(): Record<string, StyleDefinitionInput> {
  const styles: Record<string, StyleDefinitionInput> = {
    "markup.heading": HEADING,
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: "#9ece6a", bg: "#262830" },
    "markup.raw.block": { bg: "#1e2030" },
    "markup.link": { fg: "#7dcfff", underline: true },
    "markup.link.label": { fg: "#7dcfff", underline: true },
    "markup.link.url": { fg: "#7a8294", dim: true },
    "markup.list": LIST,
    "markup.list.unchecked": LIST,
    "markup.list.checked": LIST,
    "markup.quote": { fg: "#a0a8b8", italic: true, dim: true },
    "markup.strikethrough": { fg: "#e06c75", dim: true },
    conceal: { fg: "#565f89", dim: true },
    // Base language scopes. Nested names (`keyword.import`, `function.call`)
    // fall back to the first segment, so fenced code stays multi-coloured.
    keyword: { fg: "#bb9af7" },
    string: { fg: "#9ece6a" },
    comment: { fg: "#565f89", italic: true, dim: true },
    type: { fg: "#2ac3de" },
    function: { fg: "#7aa2f7" },
    number: { fg: "#ff9e64" },
    constant: { fg: "#ff9e64" },
    variable: { fg: "#c0caf5" },
    operator: { fg: "#89ddff" },
    punctuation: { fg: "#737aa2" },
  };
  for (let level = 1; level <= 6; level++) {
    styles[`markup.heading.${level}`] = HEADING;
  }
  return styles;
}

/**
 * Memoised style builder: one SyntaxStyle per syntaxTheme string.
 *
 * OpenTUI 0.5.8's `SyntaxStyle.fromStyles(styles)` takes no owner, so a single
 * module-level cache is safe. On the chore/opentui-0.8 branch this call takes a
 * NativeResourceOwner and that branch already caches per renderer with a
 * releaseMarkdownSyntaxStyles(owner) helper — merging there means keying this
 * cache by the owner as well (or dropping it in favour of the per-renderer
 * cache) and releasing styles with the owner instead of keeping them forever.
 */
export function buildMarkdownSyntaxStyle(syntaxTheme: string): SyntaxStyle {
  const cached = syntaxStyleCache.get(syntaxTheme);
  if (cached) return cached;
  const style = SyntaxStyle.fromStyles(buildStyles());
  syntaxStyleCache.set(syntaxTheme, style);
  return style;
}
