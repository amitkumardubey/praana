import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";

const ICON_WIDTH = 2;

export interface InlineToolRowProps {
  icon: string;
  label: string;
  pending?: string;
  complete?: boolean;
  isError?: boolean;
  marginTop: boolean;
}

export function InlineToolRow({
  icon,
  label,
  pending,
  complete = true,
  isError = false,
  marginTop,
}: InlineToolRowProps) {
  const color = isError ? PALETTE.error : complete ? PALETTE.muted : PALETTE.tool;

  return (
    <Box flexDirection="column" marginTop={marginTop ? 1 : 0} paddingLeft={1}>
      {complete ? (
        <Box flexDirection="row">
          <Box width={ICON_WIDTH}>
            <Text color={isError ? PALETTE.error : PALETTE.tool}>{icon}</Text>
          </Box>
          <Text wrap="wrap" color={color} dimColor={!isError}>
            {label}
          </Text>
        </Box>
      ) : (
        <Text wrap="wrap" color={PALETTE.muted} dimColor>
          {"~ "}
          {pending ?? "Running…"}
        </Text>
      )}
    </Box>
  );
}
