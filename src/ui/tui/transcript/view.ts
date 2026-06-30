/**
 * TranscriptView — pi-tui Component that renders the full TranscriptStore.
 *
 * Each entry kind renders to styled ANSI string lines. A thin left-edge accent
 * bar colours each role (design §9). Markdown entries use pi-tui Markdown;
 * plain text uses pi-tui Text-level rendering (wrap + padding).
 */
import { Markdown, type MarkdownTheme, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { PALETTE, resolveSyntaxTheme } from "../theme.js";
import { highlight as cliHighlight } from "cli-highlight";
import type { TranscriptStore } from "./store.js";
import type {
  TranscriptEntry,
  ToolEntry,
} from "./model.js";

export interface TranscriptViewOpts {
  markdownRendering: boolean;
  syntaxTheme: string;
  backgroundZones: boolean;
  toolIcons: "unicode" | "ascii";
}

// ─── Accent bar colours per role ──────────────────────────────────────────

const ACCENT: Record<TranscriptEntry["role"], string> = {
  user: PALETTE.user,
  assistant: PALETTE.assistant,
  thinking: PALETTE.thinking,
  tool: PALETTE.tool,
  recall: PALETTE.memory,
  system: PALETTE.muted,
  turn_footer: PALETTE.faint,
};

/** One full-width bar character per accent row. */
function accentBar(role: TranscriptEntry["role"], width: number): string {
  const col = chalk.hex(ACCENT[role]);
  // Left-edge: 1-char bar + 1 space separator
  return col("▌") + " ";
}

// ─── Markdown theme ────────────────────────────────────────────────────────

function buildMarkdownTheme(syntaxTheme: string): MarkdownTheme {
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

// ─── TranscriptView ────────────────────────────────────────────────────────

export class TranscriptView implements Component {
  private readonly store: TranscriptStore;
  private readonly opts: TranscriptViewOpts;
  private readonly markdownTheme: MarkdownTheme;

  constructor(
    store: TranscriptStore,
    _tui: unknown, // reserved for future use (bg detection)
    opts: TranscriptViewOpts,
  ) {
    this.store = store;
    this.opts = opts;
    this.markdownTheme = buildMarkdownTheme(opts.syntaxTheme);
  }

  invalidate(): void {
    // No internal cache; re-renders fully on each call.
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const { entries } = this.store;
    const contentWidth = Math.max(10, width - 3); // 2 for accent bar + space
    const indent = "  "; // continuation indent — matches bar+space width

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const prevRole = i > 0 ? entries[i - 1]!.role : undefined;

      if (this.needsGap(entry.role, prevRole)) {
        lines.push("");
      }

      const bar = accentBar(entry.role, width);
      const entryLines = this.renderEntry(entry, contentWidth);
      for (let j = 0; j < entryLines.length; j++) {
        // Accent bar on first line only; plain indent for continuations.
        lines.push((j === 0 ? bar : indent) + entryLines[j]);
      }
    }

    return lines;
  }

  private needsGap(role: TranscriptEntry["role"], prev: TranscriptEntry["role"] | undefined): boolean {
    if (role === "user") return prev !== undefined;
    if (!prev) return false;
    if (role === prev) return false;
    if (role === "turn_footer") return false;
    if (role === "thinking" && prev !== "thinking") return true;
    if (role === "tool" && prev !== "tool") return true;
    if (role === "assistant" && (prev === "tool" || prev === "thinking" || prev === "user")) return true;
    return false;
  }

  private renderEntry(entry: TranscriptEntry, width: number): string[] {
    switch (entry.role) {
      case "user":
        return this.renderWrapped(
          chalk.bold.hex(PALETTE.user)("You  ") + entry.text,
          width,
        );

      case "assistant": {
        if (this.opts.markdownRendering) {
          const md = new Markdown(entry.text, 0, 0, this.markdownTheme, {
            color: chalk.hex(PALETTE.text),
          });
          return md.render(width);
        }
        return this.renderWrapped(chalk.hex(PALETTE.text)(entry.text), width);
      }

      case "thinking":
        return this.renderWrapped(
          chalk.dim.italic.hex(PALETTE.thinking)("▾ thinking  " + entry.text),
          width,
        );

      case "tool":
        return this.renderTool(entry, width);

      case "recall":
        return [
          chalk.hex(PALETTE.memory)(`◆ recall ${entry.count}`) +
            chalk.hex(PALETTE.faint)(` "${entry.preview}"`),
        ];

      case "system":
        return this.renderWrapped(chalk.hex(PALETTE.system)(entry.text), width);

      case "turn_footer":
        return [chalk.dim(entry.text)];
    }
  }

  private renderTool(entry: ToolEntry, width: number): string[] {
    const icon = chalk.hex(PALETTE.tool)(entry.toolIcon);
    const label = chalk.hex(PALETTE.tool).bold(entry.toolLabel);

    if (entry.resultSummary === undefined) {
      // Pending
      return [`${icon}  ${label}  ${chalk.dim(entry.toolPending)}`];
    }

    const errorStyle = entry.isError ? chalk.hex(PALETTE.error) : chalk.hex(PALETTE.success);
    const summary = errorStyle(entry.resultSummary);
    const header = `${icon}  ${label}  ${summary}`;
    const resultLines: string[] = [header];

    if (entry.resultBody) {
      const bodyLines = entry.resultBody.split("\n");
      const limited = bodyLines.slice(0, 20);
      for (const l of limited) {
        resultLines.push(chalk.dim("  " + l));
      }
      if (bodyLines.length > 20) {
        resultLines.push(chalk.hex(PALETTE.faint)(`  … +${bodyLines.length - 20} more lines`));
      }
    }

    return resultLines;
  }

  private renderWrapped(text: string, width: number): string[] {
    if (!text) return [];
    return wrapTextWithAnsi(text, width);
  }
}
