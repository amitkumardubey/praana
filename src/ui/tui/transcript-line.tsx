import React from "react";
import { Box, Text } from "ink";
import stripAnsi from "strip-ansi";
import type { TranscriptEntry } from "./reducer.js";
import { PALETTE } from "./palette.js";
import { RoleLabel } from "./role-label.js";
import { MarkdownRender } from "./markdown-render.js";

/** Produce a compact one-line summary of a tool result for display. */
function summarizeResultForDisplay(text: string): string {
  if (!text) return "(empty)";
  const lines = text.split("\n").length;
  const chars = text.length;
  const truncated = text.length > 200;
  const preview = text.slice(0, 200).split("\n")[0]!;
  const previewText = truncated ? preview.slice(0, 80) + "…" : preview.slice(0, 80);
  const size = lines > 1 ? `${lines} lines, ${chars} chars` : `${chars} chars`;
  return `${size} — ${previewText}`;
}

export interface TranscriptLineProps {
  entry: TranscriptEntry;
  markdownRendering?: boolean;
  syntaxHighlighting?: boolean;
  syntaxTheme?: string;
}

export const TranscriptLine = React.memo(function TranscriptLine({
  entry,
  markdownRendering = true,
  syntaxHighlighting = true,
  syntaxTheme = "solarized-dark",
}: TranscriptLineProps) {
  const plain = stripAnsi(entry.text);
  const isTool = entry.role === "tool";
  const isToolResult = entry.role === "tool_result";
  const isUser = entry.role === "user";
  const isThinking = entry.role === "thinking";
  const isGrouped = entry.group > 0 && !isUser && !isToolResult;
  const isAssistant = entry.role === "assistant" && !isThinking;
  const useMarkdown = markdownRendering && isAssistant && plain;

  return (
    <Box flexDirection="column" marginBottom={isTool ? 0 : isToolResult ? 0 : 1}>
      {/* Role label — only for non-tool entries */}
      {!isTool && !isToolResult && (
        <Box>
          {isGrouped ? (
            <Text color={PALETTE.gutter}>│ </Text>
          ) : (
            <Text>  </Text>
          )}
          <RoleLabel role={entry.role} />
        </Box>
      )}

      {/* Content — indented for tool calls, dimmed block for results */}
      <Box>
        {isTool ? (
          <Text>
            <Text color={PALETTE.gutter}>  ╰ </Text>
            <Text color={PALETTE.tool} dimColor wrap="wrap">{plain || " "}</Text>
          </Text>
        ) : isToolResult ? (
          <Text>
            <Text color={PALETTE.gutter}>  ╰ </Text>
            <Text color={PALETTE.muted} dimColor wrap="wrap">
              [result] {summarizeResultForDisplay(plain)}
            </Text>
          </Text>
        ) : useMarkdown ? (
          <Box paddingLeft={isGrouped ? 2 : 0}>
            <MarkdownRender
              text={plain}
              syntaxHighlighting={syntaxHighlighting}
              syntaxTheme={syntaxTheme}
            />
          </Box>
        ) : (
          <Box paddingLeft={isGrouped ? 2 : 0}>
            <Text wrap="wrap" color={isThinking ? PALETTE.muted : PALETTE.user} italic={isThinking ? true : false}>{plain || " "}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
});
