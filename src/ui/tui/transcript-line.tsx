import React from "react";
import { Box, Text } from "ink";
import stripAnsi from "strip-ansi";
import type { TranscriptEntry } from "./reducer.js";
import { PALETTE } from "./palette.js";
import { RoleLabel } from "./role-label.js";

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

export const TranscriptLine = React.memo(function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  const plain = stripAnsi(entry.text);
  const isTool = entry.role === "tool";
  const isToolResult = entry.role === "tool_result";
  const isUser = entry.role === "user";
  const isThinking = entry.role === "thinking";
  const isGrouped = entry.group > 0 && !isUser && !isToolResult;

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
        ) : (
          <Box paddingLeft={isGrouped ? 2 : 0}>
            <Text wrap="wrap" color={isThinking ? PALETTE.muted : PALETTE.user} italic={isThinking ? true : false}>{plain || " "}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
});
