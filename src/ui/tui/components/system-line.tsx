import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";

export function SystemLine({ text, marginTop }: { text: string; marginTop: boolean }) {
  return (
    <Box marginTop={marginTop ? 1 : 0} paddingLeft={1}>
      <Text wrap="wrap" color={PALETTE.system} dimColor>
        {text}
      </Text>
    </Box>
  );
}
