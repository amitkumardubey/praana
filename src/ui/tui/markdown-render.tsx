import React from "react";
import { Text, Box } from "ink";
import { marked, type Token, type Tokens } from "marked";
import { highlight as cliHighlight } from "cli-highlight";
import stripAnsi from "strip-ansi";
import { PALETTE } from "./palette.js";

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
    case "text":
      return <Text>{(token as Tokens.Text).raw}</Text>;
    case "strong":
      return <Text bold>{(token as Tokens.Strong).text}</Text>;
    case "em":
      return <Text italic>{(token as Tokens.Em).text}</Text>;
    case "codespan":
      return (
        <Text color={PALETTE.tool} backgroundColor="#2d2d2d">
          {" "}{(token as Tokens.Codespan).text}{" "}
        </Text>
      );
    case "link":
      return (
        <Text color={PALETTE.assistant} underline>
          {(token as Tokens.Link).text}
        </Text>
      );
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

export function extractCellText(cell: { text: string; tokens: (Token | string)[] }): string {
  return typeof cell.text === "string"
    ? cell.text
    : cell.tokens.map((tk) => (typeof tk === "string" ? tk : tk.raw ?? "")).join("");
}

export function computeColWidths(headerTexts: string[], bodyTexts: string[][]): number[] {
  const colCount = headerTexts.length;
  return Array.from({ length: colCount }, (_, ci) => {
    const headerLen = stripAnsi(headerTexts[ci] ?? "").length;
    const maxBodyLen = bodyTexts.reduce((max, row) => Math.max(max, stripAnsi(row[ci] ?? "").length), 0);
    return Math.min(Math.max(headerLen, maxBodyLen, 4), 40);
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
      return (
        <Box marginBottom={1}>
          <Text wrap="wrap">
            <InlineTokens tokens={t.tokens} />
          </Text>
        </Box>
      );
    }

    case "code": {
      const t = token as Tokens.Code;
      return renderCodeBlock(t, syntaxHighlighting, syntaxTheme);
    }

    case "list": {
      const t = token as Tokens.List;
      return (
        <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
          {t.items.map((item, i) => {
            const bullet = t.ordered ? `${i + 1}. ` : "• ";
            return (
              <Box key={i} flexDirection="row">
                <Text color={PALETTE.gutter}>{bullet}</Text>
                <Text wrap="wrap">
                  <InlineTokens tokens={item.tokens} />
                </Text>
              </Box>
            );
          })}
        </Box>
      );
    }

    case "table": {
      const t = token as Tokens.Table;
      const headerTexts = t.header.map(extractCellText);
      const bodyTexts = t.rows.map((row) => row.map(extractCellText));
      const colCount = headerTexts.length;
      const colWidths = computeColWidths(headerTexts, bodyTexts);
      const pad = (text: string, width: number) => {
        const plain = stripAnsi(text);
        if (plain.length > width) {
          return plain.slice(0, width - 1) + "…";
        }
        return text + " ".repeat(width - plain.length);
      };
      const headerCells = headerTexts.map((h, i) => pad(h, colWidths[i]));
      const separator = colWidths.map((w) => "─".repeat(w));

      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={PALETTE.assistant} bold>│ {headerCells.join(" │ ")}</Text>
          <Text color={PALETTE.gutter}>├─{separator.join("─┼─")}─┤</Text>
          {bodyTexts.map((row, i) => (
            <Text key={i}>│ {row.map((c, ci) => pad(c, colWidths[ci])).join(" │ ")}</Text>
          ))}
        </Box>
      );
    }

    case "blockquote": {
      const t = token as Tokens.Blockquote;
      return (
        <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
          <Text color={PALETTE.gutter}>
            {t.tokens.map((tk, i) => {
              if (tk.type === "paragraph") {
                const p = tk as Tokens.Paragraph;
                return p.tokens.map((itk, j) => (
                  <Text key={`${i}-${j}`} italic color={PALETTE.muted}>
                    {typeof itk === "string" ? itk : itk.raw ?? ""}
                  </Text>
                ));
              }
              return <Text key={i}>{typeof tk === "string" ? tk : tk.raw ?? ""}</Text>;
            })}
          </Text>
        </Box>
      );
    }

    case "hr":
      return (
        <Box marginBottom={1}>
          <Text color={PALETTE.gutter}>{"─".repeat(60)}</Text>
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
