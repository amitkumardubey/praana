import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "./palette.js";

export interface LogoBannerProps {
  bootSummary?: string;
}

// Line-art "pn" monogram. Cream p (PALETTE.text), sage-green n
// (PALETTE.success) with a trailing fade-dot decay motif on the n.
const MONO_P = ["╭──╮", "│  │", "├──╯", "│   ", "●   "];
const MONO_N = ["◌──╮", "   │", "   │", "   ◉", "   ◦"];
const TAGLINE = "Adaptive Context · Cognitive Memory";
// Indent that centres the 9-col monogram over the 35-col tagline.
const MONO_INDENT = Math.max(0, Math.floor((TAGLINE.length - 9) / 2));

const TIPS = [
  "/help    — all slash commands",
  "/stats   — what I know and remember",
  "/model   — switch model or provider",
  "/recall  — search persistent memory",
  "Ctrl+T toggle thinking · Esc interrupt turn",
];

export function LogoBanner({ bootSummary }: LogoBannerProps) {
  return (
    <Box marginBottom={1}>
      <Box flexDirection="column" paddingX={2}>
        <Box flexDirection="column" marginLeft={MONO_INDENT}>
          {MONO_P.map((p, i) => (
            <Box key={i}>
              <Text color={PALETTE.text}>{p}</Text>
              <Text> </Text>
              <Text color={PALETTE.success}>{MONO_N[i]}</Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1} marginBottom={1}>
          <Text color={PALETTE.muted}>{TAGLINE}</Text>
        </Box>
        {bootSummary ? (
          <Box marginBottom={1}>
            <Text color={PALETTE.muted} dimColor>
              {bootSummary}
            </Text>
          </Box>
        ) : null}
        <Box marginBottom={1}>
          <Text color={PALETTE.assistant}>Quick tips:</Text>
        </Box>
        {TIPS.map((tip, i) => (
          <Box key={i}>
            <Box marginLeft={2} marginRight={1}>
              <Text color={PALETTE.faint}>*</Text>
            </Box>
            <Text>{tip}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
