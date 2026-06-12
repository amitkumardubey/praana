import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";

export function ToastLine({ message }: { message: string }) {
  if (!message) return null;
  return (
    <Box paddingLeft={1}>
      <Text color={PALETTE.tool} dimColor>
        {message}
      </Text>
    </Box>
  );
}
