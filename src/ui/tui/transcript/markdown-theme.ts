/* Build an OpenTUI SyntaxStyle for markdown rendering (design §4).
 * Replaces pi-tui's per-element MarkdownTheme callbacks. The scope names
 * below are best-effort; verify against OpenTUI's getRegisteredNames() at
 * implementation time and adjust if needed. */
import { SyntaxStyle } from "@opentui/core";

export function buildMarkdownSyntaxStyle(syntaxTheme: string): SyntaxStyle {
  void syntaxTheme;
  return SyntaxStyle.fromStyles({
    heading: { bold: true },
    paragraph: {},
    link: { fg: "#00AFFF" },
    "link.url": { dim: true },
    code: { bg: "#333333" },
    "code.block": {},
    quote: { italic: true, dim: true },
    "quote.border": { dim: true },
    hr: { dim: true },
    "list.bullet": { dim: true },
    strong: { bold: true },
    em: { italic: true },
    text: {},
  });
}
