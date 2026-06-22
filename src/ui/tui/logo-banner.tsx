import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "./palette.js";
import { APP_VERSION } from "../../app-banner.js";

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
          <Text>  </Text>
          <Text color={PALETTE.faint}>{APP_VERSION}</Text>
        </Box>
        {bootSummary ? (
          <Box marginBottom={1}>
            <Text color={PALETTE.muted} dimColor>
              {bootSummary}
            </Text>
          </Box>
        ) : null}
        <Text color={PALETTE.text}>
          Terminal coding agent with adaptive context and persistent memory.
        </Text>
        <Text color={PALETTE.text}>
          I remember decisions across sessions and auto-compress stale context.
        </Text>
        <Box marginBottom={1} marginTop={2}>
          <Text color={PALETTE.assistant}>Quick tips:</Text>
        </Box>
        <Box>
          <Box marginLeft={2} marginRight={1}>
            <Text>*</Text>
          </Box>
          <Text>Say what you want — I'll read code, run shell commands, make edits</Text>
        </Box>
        <Box>
          <Box marginLeft={2} marginRight={1}>
            <Text>*</Text>
          </Box>
          <Text>/help   — all slash commands</Text>
        </Box>
        <Box>
          <Box marginLeft={2} marginRight={1}>
            <Text>*</Text>
          </Box>
          <Text>/stats  — what I know and remember</Text>
        </Box>
        <Box>
          <Box marginLeft={2} marginRight={1}>
            <Text>*</Text>
          </Box>
          <Text>/model  — switch model or provider mid-session</Text>
        </Box>
        <Box>
          <Box marginLeft={2} marginRight={1}>
            <Text>*</Text>
          </Box>
          <Text>/recall — search my persistent memory</Text>
        </Box>
        <Box>
          <Box marginLeft={2} marginRight={1}>
            <Text>*</Text>
          </Box>
          <Text>Ctrl+T — toggle thinking visibility</Text>
        </Box>
        <Box>
          <Box marginLeft={2} marginRight={1}>
            <Text>*</Text>
          </Box>
          <Text>/thinking on|off — show or hide reasoning text</Text>
        </Box>
        <Box>
          <Box marginLeft={2} marginRight={1}>
            <Text>*</Text>
          </Box>
          <Text>Esc — interrupt a running turn</Text>
        </Box>
      </Box>
    </Box>
  );
}
