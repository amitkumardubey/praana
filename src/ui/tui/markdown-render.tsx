import React from "react";
import { Text, Box } from "ink";
import { marked, type Token, type Tokens } from "marked";
import { highlight as cliHighlight } from "cli-highlight";
import stripAnsi from "strip-ansi";
import ansiStyles from "ansi-styles";
import wrapAnsi from "wrap-ansi";
import { PALETTE } from "./palette.js";
import { getTerminalWidth } from "./terminal-width.js";

interface MarkdownRenderProps {
  text: string;
  syntaxHighlighting?: boolean;
  syntaxTheme?: string;
}

const HEADING_STYLES: Record<number, { bold: boolean; color: string; underline?: boolean }> = {
  1: { bold: true, color: PALETTE.assistant, underline: true },
  2: { bold: true, color: PALETTE.assistant },
  3: { bold: true, color: PALETTE.user },
  4: { bold: true, color: PALETTE.muted },
  5: { bold: true, color: PALETTE.muted },
  6: { bold: true, color: PALETTE.muted },
};

function InlineToken({ token }: { token: Token | string }): React.ReactNode {
  if (typeof token === "string") {
    return <Text>{token}</Text>;
  }

  switch (token.type) {
    case "text": {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) {
        return <InlineTokens tokens={t.tokens} />;
      }
      return <Text>{t.text}</Text>;
    }
    case "strong": {
      const t = token as Tokens.Strong;
      return (
        <Text bold>
          {t.tokens?.length ? <InlineTokens tokens={t.tokens} /> : t.text}
        </Text>
      );
    }
    case "em": {
      const t = token as Tokens.Em;
      return (
        <Text italic>
          {t.tokens?.length ? <InlineTokens tokens={t.tokens} /> : t.text}
        </Text>
      );
    }
    case "del": {
      const t = token as Tokens.Del;
      return (
        <Text strikethrough dimColor>
          {t.tokens?.length ? <InlineTokens tokens={t.tokens} /> : t.text}
        </Text>
      );
    }
    case "codespan":
      return (
        <Text color={PALETTE.tool} backgroundColor="#2d2d2d">
          {" "}{(token as Tokens.Codespan).text}{" "}
        </Text>
      );
    case "link": {
      const t = token as Tokens.Link;
      const label = t.text || t.href;
      const showHref = t.href && t.href !== t.text;
      return (
        <Text color={PALETTE.assistant} underline>
          {label}
          {showHref ? (
            <Text dimColor>{` (${t.href})`}</Text>
          ) : null}
        </Text>
      );
    }
    case "br":
      return <Text>{"\n"}</Text>;
    case "escape":
      return <Text>{(token as Tokens.Escape).text}</Text>;
    default:
      return <Text>{token.raw ?? ""}</Text>;
  }
}

function InlineTokens({ tokens }: { tokens: (Token | string)[] }): React.ReactNode {
  return (
    <>
      {tokens.map((token, i) => (
        <InlineToken key={i} token={token} />
      ))}
    </>
  );
}

/**
 * Flatten inline tokens into a single string with ANSI escape codes for styling.
 * This avoids Ink's multi-child Text wrapping issue by producing one contiguous string.
 */
export function renderInlineToAnsi(tokens: (Token | string)[]): string {
  let result = "";
  for (const token of tokens) {
    result += inlineToAnsi(token);
  }
  return result;
}

/**
 * Pre-wrap an ANSI-styled string at word boundaries and render line-by-line.
 *
 * This bypasses Ink's internal wrap-ansi call (which uses trim: false,
 * leaving orphan leading spaces on continuation lines). We wrap ourselves
 * with trim: true and render each line as a plain <Text> — no wrap prop needed.
 *
 * @param ansi  ANSI-styled string (from renderInlineToAnsi)
 * @param width Available width in columns (e.g. terminal width minus padding)
 */
function PreWrappedText({ ansi, width, color }: { ansi: string; width: number; color?: string }): React.ReactNode {
  const wrapped = wrapAnsi(ansi, width, { trim: true, hard: false });
  const lines = wrapped.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <Text key={i} color={color}>{line || " "}</Text>
      ))}
    </>
  );
}

function inlineToAnsi(token: Token | string): string {
  if (typeof token === "string") {
    return token;
  }

  switch (token.type) {
    case "text": {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) {
        return renderInlineToAnsi(t.tokens);
      }
      return t.text;
    }
    case "strong": {
      const t = token as Tokens.Strong;
      const inner = t.tokens?.length ? renderInlineToAnsi(t.tokens) : t.text;
      return `${ansiStyles.bold.open}${inner}${ansiStyles.bold.close}`;
    }
    case "em": {
      const t = token as Tokens.Em;
      const inner = t.tokens?.length ? renderInlineToAnsi(t.tokens) : t.text;
      return `${ansiStyles.italic.open}${inner}${ansiStyles.italic.close}`;
    }
    case "del": {
      const t = token as Tokens.Del;
      const inner = t.tokens?.length ? renderInlineToAnsi(t.tokens) : t.text;
      return `${ansiStyles.strikethrough.open}${ansiStyles.dim.open}${inner}${ansiStyles.dim.close}${ansiStyles.strikethrough.close}`;
    }
    case "codespan":
      return `${ansiStyles.bgColor.ansi16m.hex("#2d2d2d")}${ansiStyles.color.ansi16m.hex(PALETTE.tool)}${" "}${(token as Tokens.Codespan).text}${" "}${ansiStyles.bgColor.close}${ansiStyles.color.close}`;
    case "link": {
      const t = token as Tokens.Link;
      const label = t.text || t.href;
      const showHref = t.href && t.href !== t.text;
      let link = `${ansiStyles.color.ansi16m.hex(PALETTE.assistant)}${ansiStyles.underline.open}${label}${ansiStyles.underline.close}`;
      if (showHref) {
        link += `${ansiStyles.dim.open} (${t.href})${ansiStyles.dim.close}`;
      }
      return link;
    }
    case "br":
      return "\n";
    case "escape":
      return (token as Tokens.Escape).text;
    default:
      return token.raw ?? "";
  }
}

function MarkdownList({
  token,
  depth = 0,
}: {
  token: Tokens.List;
  depth?: number;
}): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      marginBottom={depth === 0 ? 1 : 0}
      paddingLeft={depth > 0 ? 2 : 2}
    >
      {token.items.map((item, i) => {
        const bullet = token.ordered ? `${i + 1}. ` : "• ";
        const multiline = item.tokens.some(
          (t) => t.type === "list" || (t.type === "paragraph" && t.raw.includes("\n"))
        );
        return (
          <Box
            key={i}
            flexDirection="row"
            alignItems={multiline ? "flex-start" : undefined}
          >
            <Text color={PALETTE.faint}>{bullet}</Text>
            <Box flexDirection="column" flexGrow={1}>
              <ListItemTokens tokens={item.tokens} depth={depth} />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function ListItemTokens({
  tokens,
  depth = 0,
}: {
  tokens: Token[];
  depth?: number;
}): React.ReactNode {
  // List indent: transcript paddingLeft(1) + list paddingLeft(2) + bullet(2)
  const wrapWidth = Math.max(20, getTerminalWidth() - 5 - (depth > 0 ? 2 : 0));
  return (
    <>
      {tokens.map((token, i) => {
        if (token.type === "space") {
          return <Text key={i}>{"\n"}</Text>;
        }
        if (token.type === "paragraph") {
          const p = token as Tokens.Paragraph;
          const ansi = renderInlineToAnsi(p.tokens);
          return <PreWrappedText key={i} ansi={ansi} width={wrapWidth} />;
        }
        // "text" tokens inside list items can contain nested inline tokens
        // (strong, codespan, etc.) — flatten to ANSI to avoid wrapping breaks
        if (token.type === "text") {
          const t = token as Tokens.Text;
          if (t.tokens && t.tokens.length > 0) {
            const ansi = renderInlineToAnsi(t.tokens);
            return <PreWrappedText key={i} ansi={ansi} width={wrapWidth} />;
          }
          return <PreWrappedText key={i} ansi={t.text ?? ""} width={wrapWidth} />;
        }
        if (token.type === "list") {
          return (
            <MarkdownList key={i} token={token as Tokens.List} depth={depth + 1} />
          );
        }
        return <InlineToken key={i} token={token} />;
      })}
    </>
  );
}

/** Flatten inline tokens to plain text (used in tests). */
export function plainTextFromInlineTokens(tokens: (Token | string)[]): string {
  return tokens
    .map((token) => {
      if (typeof token === "string") return token;
      switch (token.type) {
        case "text": {
          const t = token as Tokens.Text;
          if (t.tokens?.length) return plainTextFromInlineTokens(t.tokens);
          return t.text ?? t.raw ?? "";
        }
        case "strong":
          return (token as Tokens.Strong).text;
        case "em":
          return (token as Tokens.Em).text;
        case "del": {
          const t = token as Tokens.Del;
          if (t.tokens?.length) return plainTextFromInlineTokens(t.tokens);
          return t.text ?? "";
        }
        case "codespan":
          return (token as Tokens.Codespan).text;
        case "link":
          return (token as Tokens.Link).text;
        case "br":
          return "\n";
        case "escape":
          return (token as Tokens.Escape).text;
        default:
          return token.raw ?? "";
      }
    })
    .join("");
}

export function extractCellText(cell: { text: string; tokens: (Token | string)[] }): string {
  if (cell.tokens && cell.tokens.length > 0) {
    return plainTextFromInlineTokens(cell.tokens);
  }
  return cell.text ?? "";
}

type TableCellData = { text: string; tokens: (Token | string)[] };

function truncatePlain(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? "…" : `${text.slice(0, width - 1)}…`;
}

function TableCellContent({
  cell,
  width,
  bold,
}: {
  cell: TableCellData;
  width: number;
  bold?: boolean;
}) {
  const plain = extractCellText(cell);
  const truncated = plain.length > width;

  if (truncated) {
    return (
      <Text bold={bold} wrap="truncate">
        {truncatePlain(plain, width)}
      </Text>
    );
  }

  const pad = " ".repeat(Math.max(0, width - plain.length));
  return (
    <Text bold={bold}>
      <InlineTokens tokens={cell.tokens} />
      {pad}
    </Text>
  );
}

function TableRow({
  cells,
  colWidths,
  header,
}: {
  cells: TableCellData[];
  colWidths: number[];
  header?: boolean;
}) {
  return (
    <Box flexDirection="row">
      <Text color={header ? PALETTE.assistant : undefined} bold={header}>
        │
      </Text>
      {cells.map((cell, i) => (
        <Box key={i} flexDirection="row">
          <Text> </Text>
          <TableCellContent cell={cell} width={colWidths[i]!} bold={header} />
          <Text> </Text>
          <Text color={PALETTE.gutter}>│</Text>
        </Box>
      ))}
    </Box>
  );
}

export function computeColWidths(
  headerTexts: string[],
  bodyTexts: string[][],
  terminalWidth = getTerminalWidth()
): number[] {
  const colCount = headerTexts.length;
  const gutter = 2 + colCount * 3;
  const perColMax = Math.max(
    8,
    Math.min(48, Math.floor((terminalWidth - gutter) / Math.max(colCount, 1)))
  );
  return Array.from({ length: colCount }, (_, ci) => {
    const headerLen = stripAnsi(headerTexts[ci] ?? "").length;
    const maxBodyLen = bodyTexts.reduce(
      (max, row) => Math.max(max, stripAnsi(row[ci] ?? "").length),
      0
    );
    return Math.min(Math.max(headerLen, maxBodyLen, 4), perColMax);
  });
}

function renderCodeBlock(token: Tokens.Code, syntaxHighlighting: boolean, syntaxTheme: string): React.ReactNode {
  const code = token.text.replace(/\n$/, "");
  let highlighted: string;
  if (syntaxHighlighting && token.lang) {
    try {
      highlighted = cliHighlight(code, { language: token.lang, theme: syntaxTheme, ignoreIllegals: true });
    } catch {
      highlighted = code;
    }
  } else {
    highlighted = code;
  }
  const lines = highlighted.split("\n");
  return (
    <Box flexDirection="column" marginBottom={1}>
      {token.lang && (
        <Text color={PALETTE.muted} dimColor>
          {"  "}{token.lang}
        </Text>
      )}
      <Box flexDirection="column" backgroundColor="#1e1e1e" paddingX={1}>
        {lines.map((line, i) => (
          <Text key={i}>{line || " "}</Text>
        ))}
      </Box>
    </Box>
  );
}

function MarkdownBlock({ token, syntaxHighlighting, syntaxTheme }: { token: Token; syntaxHighlighting: boolean; syntaxTheme: string }): React.ReactNode {
  switch (token.type) {
    case "heading": {
      const t = token as Tokens.Heading;
      const style = HEADING_STYLES[t.depth] ?? HEADING_STYLES[3];
      return (
        <Box marginBottom={1}>
          <Text bold={style.bold} color={style.color} underline={style.underline}>
            <InlineTokens tokens={t.tokens} />
          </Text>
        </Box>
      );
    }

    case "paragraph": {
      const t = token as Tokens.Paragraph;
      const ansi = renderInlineToAnsi(t.tokens);
      // transcript paddingLeft(1)
      const wrapWidth = Math.max(20, getTerminalWidth() - 1);
      return (
        <Box marginBottom={1}>
          <PreWrappedText ansi={ansi} width={wrapWidth} />
        </Box>
      );
    }

    case "code": {
      const t = token as Tokens.Code;
      return renderCodeBlock(t, syntaxHighlighting, syntaxTheme);
    }

    case "list":
      return <MarkdownList token={token as Tokens.List} />;

    case "table": {
      const t = token as Tokens.Table;
      const headerTexts = t.header.map(extractCellText);
      const bodyTexts = t.rows.map((row) => row.map(extractCellText));
      const colWidths = computeColWidths(headerTexts, bodyTexts);
      const separator = colWidths.map((w) => "─".repeat(w));

      return (
        <Box flexDirection="column" marginBottom={1}>
          <TableRow cells={t.header} colWidths={colWidths} header />
          <Text color={PALETTE.gutter}>├─{separator.join("─┼─")}─┤</Text>
          {t.rows.map((row, i) => (
            <TableRow key={i} cells={row} colWidths={colWidths} />
          ))}
        </Box>
      );
    }

    case "blockquote": {
      const t = token as Tokens.Blockquote;
      // transcript paddingLeft(1) + blockquote paddingLeft(2)
      const wrapWidth = Math.max(20, getTerminalWidth() - 3);
      return (
        <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
          {t.tokens.map((tk, i) => {
            if (tk.type === "paragraph") {
              const p = tk as Tokens.Paragraph;
              const ansi = `${ansiStyles.italic.open}${renderInlineToAnsi(p.tokens)}${ansiStyles.italic.close}`;
              return <PreWrappedText key={i} ansi={ansi} width={wrapWidth} color={PALETTE.muted} />;
            }
            return (
              <Text key={i} color={PALETTE.muted}>
                {typeof tk === "string" ? tk : tk.raw ?? ""}
              </Text>
            );
          })}
        </Box>
      );
    }

    case "hr":
      return (
        <Box marginBottom={1}>
          <Text color={PALETTE.faint}>
            {"─".repeat(Math.max(20, getTerminalWidth() - 4))}
          </Text>
        </Box>
      );

    case "html":
      return <Text>{token.raw}</Text>;

    case "space":
      return null;

    default:
      return <Text>{token.raw ?? ""}</Text>;
  }
}

export const MarkdownRender = React.memo(function MarkdownRender({
  text,
  syntaxHighlighting = true,
  syntaxTheme = "solarized-dark",
}: MarkdownRenderProps) {
  if (!text) return <Text> </Text>;

  const tokens = marked.lexer(text);

  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => (
        <MarkdownBlock
          key={i}
          token={token}
          syntaxHighlighting={syntaxHighlighting}
          syntaxTheme={syntaxTheme}
        />
      ))}
    </Box>
  );
});
