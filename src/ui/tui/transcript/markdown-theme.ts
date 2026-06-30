import type { MarkdownTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { highlight as cliHighlight } from "cli-highlight";
import { TUI_STYLE, resolveSyntaxTheme } from "../theme.js";

export function buildMarkdownTheme(syntaxTheme: string): MarkdownTheme {
  const highlightFn = (code: string, lang?: string): string[] => {
    try {
      const syntaxObj = resolveSyntaxTheme(syntaxTheme);
      const highlighted = cliHighlight(code, {
        language: lang ?? "text",
        theme: typeof syntaxObj === "object" ? syntaxObj : undefined,
        ignoreIllegals: true,
      });
      return highlighted.split("\n");
    } catch {
      return code.split("\n");
    }
  };

  return {
    heading: TUI_STYLE.heading,
    link: TUI_STYLE.info,
    linkUrl: TUI_STYLE.faint,
    code: (s) => chalk.inverse(s),
    codeBlock: TUI_STYLE.text,
    codeBlockBorder: TUI_STYLE.faint,
    quote: (s) => chalk.italic(TUI_STYLE.muted(s)),
    quoteBorder: TUI_STYLE.faint,
    hr: TUI_STYLE.faint,
    listBullet: TUI_STYLE.faint,
    bold: (s) => chalk.bold(s),
    italic: (s) => chalk.italic(s),
    strikethrough: (s) => chalk.strikethrough(s),
    underline: (s) => chalk.underline(s),
    highlightCode: highlightFn,
  };
}
