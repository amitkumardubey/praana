import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";

export function ToolResultLine({
  summary,
  body,
  isError = false,
}: {
  summary: string;
  body?: string | null;
  isError?: boolean;
}) {
  const color = isError ? PALETTE.error : PALETTE.muted;

  return (
    <Box flexDirection="column" paddingLeft={3}>
      <Text wrap="wrap" color={color} dimColor={!isError}>
        ↳ {summary}
      </Text>
      {body ? (
        <Text wrap="wrap" color={color} dimColor={!isError}>
          {body}
        </Text>
      ) : null}
    </Box>
  );
}
