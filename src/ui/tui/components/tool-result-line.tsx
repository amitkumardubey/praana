import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";

export function ToolResultLine({
  summary,
  isError = false,
}: {
  summary: string;
  isError?: boolean;
}) {
  return (
    <Box paddingLeft={3}>
      <Text wrap="wrap" color={isError ? PALETTE.error : PALETTE.muted} dimColor={!isError}>
        ↳ {summary}
      </Text>
    </Box>
  );
}
