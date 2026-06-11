import React from "react";
import { Box, Newline, Spacer, Text } from "ink";
import { PALETTE } from "./palette.js";

export function LogoBanner() {
  const version = "v0.3.0";
  const title = "▲ ARIA " + version;
  const W = 72;
  return (
    <Box marginBottom={1}>
        <Box flexDirection="column" paddingX={2}>
          <Box marginBottom={1}>
            <Text color={PALETTE.assistant}>{title}</Text>
          </Box>
          <Text color={PALETTE.text}>Terminal coding agent with adaptive context and persistent memory.</Text>
          <Text color={PALETTE.text}>I remember decisions across sessions and auto-compress stale context.</Text>
          <Box marginBottom={1} marginTop={2}>
            <Text color={PALETTE.assistant}>Quick tips:</Text>
          </Box>
          <Box><Box marginLeft={2} marginRight={1}><Text>*</Text></Box><Text>Say what you want — I'll read code, run shell commands, make edits</Text></Box>
          <Box><Box marginLeft={2} marginRight={1}><Text>*</Text></Box><Text>/help   — all slash commands</Text></Box>
          <Box><Box marginLeft={2} marginRight={1}><Text>*</Text></Box><Text>/stats  — what I know and remember</Text></Box>
          <Box><Box marginLeft={2} marginRight={1}><Text>*</Text></Box><Text>/recall — search my persistent memory</Text></Box>
          <Box><Box marginLeft={2} marginRight={1}><Text>*</Text></Box><Text>Esc Esc — interrupt me</Text></Box>
        </Box>
    </Box>
  );
}
