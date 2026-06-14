import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";

export interface ShellOutputBlockProps {
  summary: string;
  body: string | null;
  isError?: boolean;
}

export function ShellOutputBlock({
  summary,
  body,
  isError = false,
}: ShellOutputBlockProps) {
  const color = isError ? PALETTE.error : PALETTE.muted;

  return (
    <Box flexDirection="column">
      <Box paddingLeft={3}>
        <Text wrap="wrap" color={color} dimColor={!isError}>
          ↳ {summary}
        </Text>
      </Box>
      {body ? (
        <Box paddingLeft={4} marginTop={1}>
          <Text wrap="wrap" color={color} dimColor={!isError}>
            {body}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
