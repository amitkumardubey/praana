import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";
import { getTerminalWidth } from "../terminal-width.js";

/** Full-width horizontal rule between turns. */
export function GutterRule({ marginTop }: { marginTop?: boolean }) {
  const width = Math.max(20, getTerminalWidth() - 2);
  return (
    <Box marginTop={marginTop ? 1 : 0}>
      <Text color={PALETTE.gutter}>{"─".repeat(width)}</Text>
    </Box>
  );
}
