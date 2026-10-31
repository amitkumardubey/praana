/* OpenTUI SyntaxStyle for markdown.
 *
 * The highlighter emits full scope names (`markup.heading.1`, `markup.strong`,
 * …). SyntaxStyle only falls back to the segment before the first dot, so
 * `markup.heading` does not style `markup.heading.1` — each level is registered
 * with the same style. `markup.raw.block` is background-only so a fenced
 * block's language tokens keep their own colours. SyntaxStyle has no
 * strikethrough bit; `markup.strikethrough` is dim and coloured instead.
 * `syntaxTheme` is accepted and unused (theme selection is separate). */
import { SyntaxStyle, type StyleDefinitionInput } from "@opentui/core";

const HEADING: StyleDefinitionInput = { bold: true, fg: "#7aa2f7" };
const LIST: StyleDefinitionInput = { fg: "#c4887a", dim: true };

export function buildMarkdownSyntaxStyle(syntaxTheme: string): SyntaxStyle {
  void syntaxTheme;
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
  return SyntaxStyle.fromStyles(styles);
}
