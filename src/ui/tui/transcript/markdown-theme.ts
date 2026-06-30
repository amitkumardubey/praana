import type { MarkdownTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { highlight as cliHighlight } from "cli-highlight";
import { PALETTE, resolveSyntaxTheme } from "../theme.js";

export function buildMarkdownTheme(syntaxTheme: string): MarkdownTheme {
  const c = PALETTE;
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
    heading: (s) => chalk.bold.hex(c.assistant)(s),
    link: (s) => chalk.hex(c.info)(s),
    linkUrl: (s) => chalk.hex(c.faint)(s),
    code: (s) => chalk.hex(c.text).bgHex(c.codeSpanBg)(s),
    codeBlock: (s) => chalk.hex(c.text)(s),
    codeBlockBorder: (s) => chalk.hex(c.faint)(s),
    quote: (s) => chalk.italic.hex(c.muted)(s),
    quoteBorder: (s) => chalk.hex(c.faint)(s),
    hr: (s) => chalk.hex(c.faint)(s),
    listBullet: (s) => chalk.hex(c.faint)(s),
    bold: (s) => chalk.bold(s),
    italic: (s) => chalk.italic(s),
    strikethrough: (s) => chalk.strikethrough(s),
    underline: (s) => chalk.underline(s),
    highlightCode: highlightFn,
  };
}
