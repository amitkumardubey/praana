import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";
import { GutterRule } from "./gutter-rule.js";

export function TurnFooter({ text, marginTop }: { text: string; marginTop?: boolean }) {
  return (
    <Box flexDirection="column" marginTop={marginTop ? 1 : 0} paddingTop={1}>
      <GutterRule />
      <Box paddingLeft={1} marginTop={0}>
        <Text color={PALETTE.muted} dimColor>
          {text}
        </Text>
      </Box>
    </Box>
  );
}
