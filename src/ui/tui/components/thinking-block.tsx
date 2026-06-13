import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";
import {
  formatThinkingDuration,
  reasoningSummary,
} from "../reasoning-summary.js";

export interface ThinkingBlockProps {
  text: string;
  live?: boolean;
  showBody: boolean;
  durationMs?: number;
  markdownRendering?: boolean;
  syntaxHighlighting?: boolean;
  syntaxTheme?: string;
}

function thinkingTextProps(extra?: { wrap?: "wrap" | "truncate" }) {
  return {
    color: PALETTE.thinking,
    dimColor: true,
    italic: true,
    ...extra,
  } as const;
}

function ThinkingBody({ bodyText }: { bodyText: string }) {
  return (
    <Text wrap="wrap" {...thinkingTextProps()}>
      {bodyText}
    </Text>
  );
}

export function ThinkingBlock({
  text,
  live = false,
  showBody,
  durationMs,
}: ThinkingBlockProps) {
  const plain = text.trim();
  const duration =
    durationMs !== undefined ? formatThinkingDuration(durationMs) : undefined;

  if (!showBody) {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1}>
        <Text {...thinkingTextProps({ wrap: "wrap" })}>
          {live ? "Thinking…" : duration ? `Thought · ${duration}` : "Thought"}
        </Text>
      </Box>
    );
  }

  if (!plain && live) {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1}>
        <Text {...thinkingTextProps({ wrap: "wrap" })}>Thinking…</Text>
      </Box>
    );
  }

  if (!plain) return null;

  const { title, body } = reasoningSummary(plain);
  const bodyText = body || plain;
  const hasBody = Boolean(bodyText.trim());

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1}>
      {title ? (
        <Text {...thinkingTextProps({ wrap: "wrap" })}>
          {live ? "Thinking" : "Thought"}: {title}
          {!live && duration ? ` · ${duration}` : live ? " …" : ""}
        </Text>
      ) : !live && duration ? (
        <Text {...thinkingTextProps({ wrap: "wrap" })}>Thought · {duration}</Text>
      ) : null}
      {hasBody ? (
        <Box paddingLeft={title ? 2 : 0} marginTop={title ? 1 : 0}>
          <ThinkingBody bodyText={bodyText} />
        </Box>
      ) : null}
    </Box>
  );
}
