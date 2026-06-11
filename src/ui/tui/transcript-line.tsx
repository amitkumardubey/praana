import React from "react";
import { Box, Text } from "ink";
import stripAnsi from "strip-ansi";
import type { TranscriptEntry } from "./reducer.js";
import { PALETTE } from "./palette.js";
import { RoleLabel } from "./role-label.js";

export function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  const plain = stripAnsi(entry.text);
  const isTool = entry.role === "tool";
  const isUser = entry.role === "user";
  const isThinking = entry.role === "thinking";
  const isGrouped = entry.group > 0 && !isUser;

  return (
    <Box flexDirection="column" marginBottom={isTool ? 0 : 1}>
      {/* Role label — only for non-tool entries */}
      {!isTool && (
        <Box>
          {isGrouped ? (
            <Text color={PALETTE.gutter}>│ </Text>
          ) : (
            <Text>  </Text>
          )}
          <RoleLabel role={entry.role} />
        </Box>
      )}

      {/* Content — indented for tool calls, grouped otherwise */}
      <Box>
        {isTool ? (
          <Text>
            <Text color={PALETTE.gutter}>  ╰ </Text>
            <Text color={PALETTE.tool} dimColor wrap="wrap">{plain || " "}</Text>
          </Text>
        ) : (
          <Box paddingLeft={isGrouped ? 2 : 0}>
            <Text wrap="wrap" color={isThinking ? PALETTE.muted : PALETTE.user} italic={isThinking ? true : false}>{plain || " "}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
